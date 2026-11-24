import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const HOME = homedir();
const STATE_DIR = join(HOME, '.local', 'state', 'agy-monitor');
const CACHE_PATH = join(STATE_DIR, 'briefings.json');
const PROMPT_CWD = join(STATE_DIR, 'prompt-cwd');
const AGY_BIN = join(HOME, '.local', 'bin', 'agy');
const BRIEF_MODEL = 'gemini-3.8-flash-low';

const BATCH_LIMIT = 6;
const BATCH_CONCURRENCY = 2;
const FAILURE_COOLDOWN_MS = 90 * 1000;
const AUTO_MAX_IDLE_AGE_MS = 14 * 24 * 60 * 60 * 1000;

let memoryCache = { mtimeMs: -1, entries: {} };
let batchInFlight = false;
const singleInFlight = new Map();
const cooldownUntil = new Map();

function ensureDirs() {
  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(PROMPT_CWD, { recursive: true });
}

function loadCache() {
  if (!existsSync(CACHE_PATH)) {
    memoryCache = { mtimeMs: 0, entries: {} };
    return memoryCache.entries;
  }
  try {
    const st = statSync(CACHE_PATH);
    if (st.mtimeMs === memoryCache.mtimeMs) {
      return memoryCache.entries;
    }
    const parsed = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
    const entries = parsed && typeof parsed.entries === 'object' && parsed.entries ? parsed.entries : {};
    memoryCache = { mtimeMs: st.mtimeMs, entries };
    return entries;
  } catch {
    return memoryCache.entries || {};
  }
}

function saveCache(entries) {
  ensureDirs();
  const payload = { version: 2, updatedAt: Date.now(), entries };
  const tmp = `${CACHE_PATH}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  renameSync(tmp, CACHE_PATH);
  try {
    const st = statSync(CACHE_PATH);
    memoryCache = { mtimeMs: st.mtimeMs, entries };
  } catch {
    memoryCache = { mtimeMs: Date.now(), entries };
  }
}

function updateCacheEntry(conversationId, entry) {
  const entries = { ...loadCache(), [conversationId]: entry };
  saveCache(entries);
  return entry;
}

const BRIEF_JSON_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    headline: { type: 'string' },
    brief: { type: 'string' },
    currentWork: { type: 'string' },
    priorCompleted: { type: 'string' },
    needsUser: { type: 'string' },
    phase: {
      type: 'string',
      enum: ['plan', 'build', 'test', 'debug', 'review', 'deploy', 'research', 'wait', 'done'],
    },
    health: {
      type: 'string',
      enum: ['nominal', 'caution', 'blocked', 'ready'],
    },
    bullets: {
      type: 'array',
      items: { type: 'string' },
    },
    nextActions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          prompt: { type: 'string' },
        },
        required: ['label', 'prompt'],
      },
    },
  },
  required: ['headline', 'brief', 'currentWork', 'priorCompleted', 'needsUser', 'phase', 'health', 'bullets', 'nextActions'],
});

const VALID_PHASES = new Set(['plan', 'build', 'test', 'debug', 'review', 'deploy', 'research', 'wait', 'done']);
const VALID_HEALTH = new Set(['nominal', 'caution', 'blocked', 'ready']);

function inferPhase(raw, state) {
  const val = String(raw || '').trim().toLowerCase();
  if (VALID_PHASES.has(val)) return val;
  if (state === 'attention') return 'wait';
  if (state === 'working') return 'build';
  if (state === 'bg') return 'test';
  return 'done';
}

function inferHealth(raw, state) {
  const val = String(raw || '').trim().toLowerCase();
  if (VALID_HEALTH.has(val)) return val;
  if (state === 'attention') return 'blocked';
  if (state === 'working' || state === 'bg') return 'nominal';
  return 'ready';
}

/** Trim at a word boundary without appending "..." or "…". */
function trimCleanBoundary(text, maxLen) {
  const clean = text.replace(/\u2026/g, '').replace(/\.{3,}/g, '').trimEnd();
  if (clean.length <= maxLen) return clean;
  const cut = clean.slice(0, maxLen).trimEnd();
  const space = cut.lastIndexOf(' ');
  return (space > Math.floor(maxLen * 0.55) ? cut.slice(0, space) : cut).trimEnd();
}

/** Clean accidental markdown links, local paths, ellipsis, or placeholder "None" strings. */
function cleanPlainText(raw, maxLen = 220) {
  if (typeof raw !== 'string') return '';
  const text = raw
    .replace(/\u2026/g, '')
    .replace(/\.{3,}/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/file:\/\/\/\S+/g, '')
    .replace(/\/Users\/[^\s),.;:]+/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^(none|n\/a|null|nothing)$/i.test(text)) return '';
  return trimCleanBoundary(text, maxLen);
}

function cleanBullets(rawList) {
  if (!Array.isArray(rawList)) return [];
  const out = [];
  for (const item of rawList) {
    const clean = cleanPlainText(typeof item === 'string' ? item : String(item || ''), 84);
    if (!clean) continue;
    out.push(clean);
    if (out.length >= 3) break;
  }
  return out;
}

function cleanNextActions(rawList, state) {
  if (state === 'working' || !Array.isArray(rawList)) {
    return [];
  }
  const out = [];
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const label = cleanPlainText(item.label, 36);
    const prompt = cleanPlainText(item.prompt, 240);
    if (!label || !prompt) continue;
    out.push({ label, prompt });
    if (out.length >= 2) break;
  }
  return out;
}

/** Compute cache fingerprint sensitive to prompts, state transitions, step progress, and schema version. */
export function computeBriefingFingerprint(item) {
  const stateKey = item.state === 'unread' || item.state === 'idle' ? 'done' : String(item.state || 'idle');
  const stepCount = Number(item.stepCount || 0);
  const stepKey = stateKey === 'done' ? stepCount : Math.floor(stepCount / 6);
  const waitFlag = item.waitingReason ? item.waitingReason.slice(0, 60) : '';
  return `v4:${Number(item.lastUserInputMs || 0)}:${stateKey}:${stepKey}:${waitFlag}`;
}

/** Attach cached AI briefings synchronously without mutating disk or spawning processes. */
export function attachBriefings(items) {
  const entries = loadCache();
  return items.map((item) => {
    const entry = entries[item.id];
    const fp = computeBriefingFingerprint(item);
    if (!entry || typeof entry !== 'object') {
      return { ...item, briefing: null, briefingStale: true };
    }
    return {
      ...item,
      briefing: {
        headline: cleanPlainText(entry.headline, 56),
        brief: cleanPlainText(entry.brief, 220),
        currentWork: cleanPlainText(entry.currentWork, 180),
        priorCompleted: cleanPlainText(entry.priorCompleted, 180),
        needsUser: cleanPlainText(entry.needsUser, 140),
        phase: inferPhase(entry.phase, item.state),
        health: inferHealth(entry.health, item.state),
        bullets: cleanBullets(entry.bullets),
        nextActions: cleanNextActions(entry.nextActions, item.state),
        updatedAt: Number(entry.updatedAt || 0),
        model: String(entry.model || BRIEF_MODEL),
      },
      briefingStale: entry.fingerprint !== fp,
    };
  });
}

function stateLabel(state) {
  switch (state) {
    case 'attention':
      return 'Waiting (needs user input or review)';
    case 'working':
      return 'Working (currently executing)';
    case 'bg':
      return 'Background (running background task or subagents)';
    case 'unread':
      return 'Unread (finished, user has not viewed yet)';
    default:
      return 'Idle';
  }
}

function buildBriefingPrompt(digest) {
  const payload = {
    title: digest.title,
    project: digest.projectName,
    state: stateLabel(digest.state),
    waitingReason: digest.waitingReason || '',
    latestUserPrompt: digest.lastUserPrompt || '',
    currentTurn: {
      focusSetThisTurn: digest.currentTurn?.focus || '',
      checklistThisTurn: digest.currentTurn?.stepsSummary || '',
      recentStepsThisTurn: digest.currentTurn?.recentActivity || [],
      latestReplyThisTurn: digest.currentTurn?.latestReply || '',
    },
    previousTurn: {
      userPrompt: digest.priorTurn?.userPrompt || '',
      priorFocus: digest.priorTurn?.focus || '',
      priorChecklist: digest.priorTurn?.stepsSummary || '',
      priorReplySnippet: digest.priorTurn?.replySnippet || '',
    },
    activeSubagents: digest.activeSubagents || [],
  };

  return [
    'CRITICAL: DO NOT CALL ANY TOOLS. Never read files, run commands, search, or invoke MCP tools. Return ONE raw JSON object only:',
    '{"headline":"","brief":"","currentWork":"","priorCompleted":"","needsUser":"","phase":"build","health":"nominal","bullets":[""],"nextActions":[{"label":"","prompt":""}]}',
    'Rules: Plain English only. NEVER emit "..." or "…" anywhere. No file paths, URLs, markdown, or UUIDs.',
    '- headline: 2-5 ultra-crisp signal words (max 42 chars, zero full sentences).',
    '- brief: 1 crisp sentence (max 150 chars).',
    '- bullets: 1-3 ultra-short signal phrases (<= 8 words each).',
    '- phase: plan | build | test | debug | review | deploy | research | wait | done.',
    '- health: nominal | caution | blocked | ready.',
    '- If Working: nextActions must be [] and currentWork describes active work while priorCompleted holds prior finished work.',
    '- If not Working: ALWAYS return 1-2 crisp nextActions in natural first-person user voice (label: 2-3 words, prompt: 1-2 direct sentences). Empty string "" for unused text fields.',
    `Thread JSON: ${JSON.stringify(payload)}`,
  ].join('\n');
}

function extractJsonObject(raw) {
  const cleaned = String(raw || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Model response did not contain a JSON object');
  }
  const obj = JSON.parse(cleaned.slice(start, end + 1));
  if (obj && typeof obj === 'object' && !('headline' in obj)) {
    if (obj.structured_output && typeof obj.structured_output === 'object') {
      return obj.structured_output;
    }
    const inner = obj.response ?? obj.result?.response;
    if (typeof inner === 'string') {
      return extractJsonObject(inner);
    }
    if (inner && typeof inner === 'object') {
      return inner;
    }
  }
  return obj;
}

function runAgyPrompt(prompt, timeoutMs = 35000) {
  ensureDirs();
  return new Promise((resolve, reject) => {
    const cliBin = process.env.AGY_CLI_BIN || (existsSync(AGY_BIN) ? AGY_BIN : 'agy');
    const pathParts = [dirname(process.execPath), join(HOME, '.local', 'bin'), '/opt/homebrew/bin', process.env.PATH || '/usr/local/bin:/usr/bin:/bin'];
    const child = spawn(
      cliBin,
      [
        '-p', prompt,
        '--model', BRIEF_MODEL,
        ...(/-(?:low|medium|high|xhigh|max)$/.test(BRIEF_MODEL) ? [] : ['--effort', 'low']),
        '--disable-slash-commands',
        '--json-schema', BRIEF_JSON_SCHEMA,
        '--print-timeout', '30s',
        '--output-format', 'stream-json',
      ],
      {
        cwd: PROMPT_CWD,
        env: {
          ...process.env,
          PATH: pathParts.filter(Boolean).join(':'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdoutAll = '';
    let lineBuf = '';
    const errChunks = [];
    let totalBytes = 0;
    let settled = false;

    const finishSuccess = (text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      setTimeout(() => {
        try { child.kill('SIGTERM'); } catch {}
      }, 1500).unref();
      resolve(text);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
      }, 1500).unref();
      reject(new Error(`agy prompt timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      const str = chunk.toString('utf8');
      totalBytes += chunk.length;
      if (totalBytes <= 1024 * 1024) stdoutAll += str;
      lineBuf += str;
      let nlIdx;
      while ((nlIdx = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, nlIdx).trim();
        lineBuf = lineBuf.slice(nlIdx + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          if (ev?.event === 'result') {
            const resp = ev.result?.structured_output ?? ev.result?.response;
            if (resp !== undefined) {
              finishSuccess(typeof resp === 'string' ? resp : JSON.stringify(resp));
              return;
            }
          }
        } catch {
          // Ignore non-JSON partial lines.
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      if (errChunks.length < 32) errChunks.push(chunk);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stderr = Buffer.concat(errChunks).toString('utf8').trim();
      if (code !== 0) {
        reject(new Error(stderr || `agy exited with code ${code}`));
        return;
      }
      resolve(stdoutAll);
    });
  });
}

async function generateAndStoreBriefing(conversationId, getDigestFn, timeoutMs = 35000) {
  const digest = getDigestFn(conversationId);
  if (!digest) return null;

  const fp = computeBriefingFingerprint(digest);
  const prompt = buildBriefingPrompt(digest);
  const rawOut = await runAgyPrompt(prompt, timeoutMs);
  const parsed = extractJsonObject(rawOut);
  const rawNext = Array.isArray(parsed.nextActions)
    ? parsed.nextActions
    : Array.isArray(parsed.suggestions)
      ? parsed.suggestions
      : [];

  const entry = {
    fingerprint: fp,
    headline: cleanPlainText(parsed.headline, 56) || cleanPlainText(digest.title, 56),
    brief: cleanPlainText(parsed.brief, 220),
    currentWork: cleanPlainText(parsed.currentWork, 180),
    priorCompleted: cleanPlainText(parsed.priorCompleted, 180),
    needsUser: cleanPlainText(parsed.needsUser || digest.waitingReason, 140),
    phase: inferPhase(parsed.phase, digest.state),
    health: inferHealth(parsed.health, digest.state),
    bullets: cleanBullets(parsed.bullets),
    nextActions: cleanNextActions(rawNext, digest.state),
    updatedAt: Date.now(),
    model: BRIEF_MODEL,
  };
  return updateCacheEntry(conversationId, entry);
}

/** Synchronously force-refresh one thread briefing (deduped if already in flight). */
export async function refreshSingleBriefing(conversationId, getDigestFn) {
  if (!conversationId || typeof getDigestFn !== 'function') return null;
  if (singleInFlight.has(conversationId)) {
    return singleInFlight.get(conversationId);
  }
  const promise = (async () => {
    try {
      const entry = await generateAndStoreBriefing(conversationId, getDigestFn, 35000);
      cooldownUntil.delete(conversationId);
      return entry;
    } catch (err) {
      cooldownUntil.set(conversationId, Date.now() + FAILURE_COOLDOWN_MS);
      throw err;
    } finally {
      singleInFlight.delete(conversationId);
    }
  })();
  singleInFlight.set(conversationId, promise);
  return promise;
}

const REFRESH_PRIORITY = {
  attention: 0,
  unread: 1,
  idle: 2,
  bg: 3,
  working: 4,
};

function selectStaleCandidates(conversations, limit, includeAllIdle = false) {
  const now = Date.now();
  return conversations
    .filter((item) => {
      if (!item?.id || !item.briefingStale) return false;
      const cool = cooldownUntil.get(item.id) || 0;
      if (cool > now) return false;
      if (!includeAllIdle && item.state === 'idle' && !item.pinned && Number(item.ageMs || 0) > AUTO_MAX_IDLE_AGE_MS) {
        return false;
      }
      return true;
    })
    .sort((a, b) => {
      const pa = REFRESH_PRIORITY[a.state] ?? 9;
      const pb = REFRESH_PRIORITY[b.state] ?? 9;
      if (pa !== pb) return pa - pb;
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
      return (a.ageMs || 0) - (b.ageMs || 0);
    })
    .slice(0, limit);
}

/** Schedule a non-blocking background batch refresh for stale briefings. */
export function scheduleBriefingRefresh(conversations, getDigestFn) {
  if (batchInFlight || typeof getDigestFn !== 'function' || !Array.isArray(conversations)) return;
  const targets = selectStaleCandidates(conversations, BATCH_LIMIT, false);
  if (targets.length === 0) return;

  batchInFlight = true;
  (async () => {
    try {
      let idx = 0;
      const workers = Array.from({ length: Math.min(BATCH_CONCURRENCY, targets.length) }, async () => {
        while (idx < targets.length) {
          const item = targets[idx];
          idx += 1;
          try {
            await refreshSingleBriefing(item.id, getDigestFn);
          } catch {
            // Cooldown already set inside refreshSingleBriefing.
          }
        }
      });
      await Promise.all(workers);
    } finally {
      batchInFlight = false;
    }
  })();
}

/** Pre-warm briefings explicitly for up to `limit` conversations (returns summary stats). */
export async function prewarmBriefings(conversations, getDigestFn, { limit = 14, includeAllIdle = true } = {}) {
  const targets = selectStaleCandidates(conversations, limit, includeAllIdle);
  const results = [];
  let idx = 0;
  const workers = Array.from({ length: Math.min(BATCH_CONCURRENCY, Math.max(1, targets.length)) }, async () => {
    while (idx < targets.length) {
      const item = targets[idx];
      idx += 1;
      try {
        const entry = await refreshSingleBriefing(item.id, getDigestFn);
        results.push({
          id: item.id,
          title: item.title,
          state: item.state,
          ok: true,
          headline: entry?.headline || '',
          nextCount: Array.isArray(entry?.nextActions) ? entry.nextActions.length : 0,
        });
      } catch (err) {
        results.push({
          id: item.id,
          title: item.title,
          state: item.state,
          ok: false,
          error: err?.message || String(err),
        });
      }
    }
  });
  await Promise.all(workers);
  return { attempted: targets.length, results };
}
