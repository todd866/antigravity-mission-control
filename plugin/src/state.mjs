import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, closeSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { attachBriefings } from './briefing.mjs';
import { getAutoWakeSet, getLocalRelays } from './relay.mjs';

const HOME = homedir();
const AGY_DIR = join(HOME, '.gemini', 'antigravity');
const DB_PATH = join(AGY_DIR, 'conversation_summaries.db');
const ANNOTATIONS_DIR = join(AGY_DIR, 'annotations');
const BRAIN_DIR = join(AGY_DIR, 'brain');
const PROJECTS_DIR = join(HOME, '.gemini', 'config', 'projects');
const STATE_DIR = join(HOME, '.local', 'state', 'agy-monitor');
const STATE_PATH = join(STATE_DIR, 'state.json');
const LAST_ACTION_PATH = join(STATE_DIR, 'last-action.json');
const AGENTS_NOW_BIN = join(HOME, '.local', 'bin', 'agents-now');

const TAIL_BYTES = 131_072;
const STALL_MS = 5 * 60 * 1000;
const ERROR_SETTLE_MS = 15 * 1000;
const FLEET_TTL_MS = 10 * 1000;

const STATE_PRIORITY = {
  attention: 0,
  working: 1,
  bg: 2,
  unread: 3,
  idle: 4,
};

const fleetCache = {
  updatedAt: 0,
  inFlight: false,
  items: [],
};

/** Parse SQLite ISO/space-separated UTC timestamps cleanly into epoch ms. */
function parseIsoMs(raw) {
  if (!raw || typeof raw !== 'string') return 0;
  const normalized = raw.trim().replace(' ', 'T');
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : 0;
}

/** Unwrap double-JSON-encoded string values such as update_focus args. */
function unwrapString(val) {
  let cur = typeof val === 'string' ? val.trim() : '';
  for (let i = 0; i < 2; i += 1) {
    if (cur.length >= 2 && cur.startsWith('"') && cur.endsWith('"')) {
      try {
        const parsed = JSON.parse(cur);
        if (typeof parsed === 'string') {
          cur = parsed.trim();
          continue;
        }
      } catch {
        break;
      }
    }
    break;
  }
  return cur.replace(/\s+/g, ' ').trim();
}

/** Read project id -> display name mapping from ~/.gemini/config/projects. */
function loadProjectNames() {
  const map = {
    'outside-of-project': 'Standalone',
    'default-cli-project': 'CLI',
  };
  if (!existsSync(PROJECTS_DIR)) return map;
  for (const name of readdirSync(PROJECTS_DIR)) {
    if (!name.endsWith('.json')) continue;
    try {
      const data = JSON.parse(readFileSync(join(PROJECTS_DIR, name), 'utf8'));
      if (data?.id) {
        map[data.id] = data.name || data.id;
      }
    } catch {
      // Skip malformed project config.
    }
  }
  return map;
}

/** Parse ~/.gemini/antigravity/annotations/<id>.pbtxt safely. */
function readAnnotation(conversationId) {
  const filePath = join(ANNOTATIONS_DIR, `${conversationId}.pbtxt`);
  if (!existsSync(filePath)) {
    return { archived: false, pinned: false, title: '', lastUserViewMs: 0, planExecute: false };
  }
  let text = '';
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return { archived: false, pinned: false, title: '', lastUserViewMs: 0, planExecute: false };
  }
  const archived = /\barchived\s*:\s*true\b/.test(text);
  const pinned = /\bpinned\s*:\s*true\b/.test(text);
  const planExecute = /\bplan_execute\s*:\s*true\b/.test(text);
  let title = '';
  const titleMatch = text.match(/\btitle\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (titleMatch) {
    try {
      title = JSON.parse(`"${titleMatch[1]}"`);
    } catch {
      title = titleMatch[1];
    }
  }
  let lastUserViewMs = 0;
  const viewMatch = text.match(/last_user_view_time\s*:\s*\{[^}]*seconds\s*:\s*(\d+)(?:[^}]*nanos\s*:\s*(\d+))?/);
  if (viewMatch) {
    const secs = Number(viewMatch[1]) || 0;
    const nanos = Number(viewMatch[2]) || 0;
    lastUserViewMs = secs * 1000 + Math.floor(nanos / 1e6);
  }
  return { archived, pinned, title, lastUserViewMs, planExecute };
}

/** Read the last `tailBytes` of a file without loading multi-megabyte transcripts. */
function readTailLines(filePath, tailBytes = TAIL_BYTES) {
  if (!existsSync(filePath)) return [];
  let fd;
  try {
    const size = statSync(filePath).size;
    if (size <= 0) return [];
    const start = Math.max(0, size - tailBytes);
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    fd = openSync(filePath, 'r');
    const bytesRead = readSync(fd, buf, 0, len, start);
    const chunk = buf.subarray(0, bytesRead).toString('utf8');
    const lines = chunk.split('\n');
    if (start > 0 && lines.length > 0) lines.shift();
    return lines.filter((l) => l.trim().length > 0);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close failure.
      }
    }
  }
}

function parseStepsArg(raw) {
  if (!raw) return null;
  let list = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(list)) return null;
  const items = list
    .filter((item) => item && typeof item.title === 'string')
    .map((item) => ({
      title: item.title.trim(),
      status: String(item.status || 'pending'),
    }));
  if (items.length === 0) return null;
  const done = items.filter((i) => i.status === 'done').length;
  const current = items.find((i) => i.status === 'in_progress');
  return {
    items,
    done,
    total: items.length,
    currentTitle: current ? current.title : '',
  };
}

function cleanUserText(raw) {
  let s = String(raw || '').trim();
  const reqMatch = s.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  if (reqMatch) s = reqMatch[1];
  s = s.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '');
  s = s.replace(/<\/?(?:USER_REQUEST|SYSTEM_MESSAGE|ADDITIONAL_METADATA)>/g, '');
  return s.replace(/\s+/g, ' ').trim();
}

/** Convert raw markdown text into clean single-line plain text without links or markup noise. */
function stripMarkdownPreview(raw, maxLen = 180) {
  const cleanedLines = [];
  for (const line of String(raw || '').split('\n')) {
    const t = line.trim();
    if (!t || /^[-=*_]{3,}$/.test(t)) continue;
    const stripped = t
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/file:\/\/\/\S+/g, '')
      .replace(/^#+\s*/, '')
      .replace(/^>\s*/, '')
      .replace(/^[-*]\s+/, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    if (stripped) cleanedLines.push(stripped);
    if (cleanedLines.join(' ').length >= maxLen) break;
  }
  const joined = cleanedLines.join(' ').replace(/\s+/g, ' ').replace(/(?:\.\.\.|…)+$/g, '').trim();
  if (joined.length <= maxLen) return joined;
  const cut = joined.slice(0, maxLen).trimEnd();
  const space = cut.lastIndexOf(' ');
  return (space > Math.floor(maxLen * 0.55) ? cut.slice(0, space) : cut).trimEnd();
}

/** Clean multi-paragraph planner replies for compact LLM briefing digests without local paths. */
function cleanPlainDigestText(raw, maxLen = 1000) {
  const s = String(raw || '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/file:\/\/\/\S+/g, '')
    .replace(/\/Users\/[^\s),.;:]+/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/(?:\.\.\.|…)+$/g, '')
    .trim();
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen).trimEnd();
  const space = cut.lastIndexOf(' ');
  return (space > Math.floor(maxLen * 0.65) ? cut.slice(0, space) : cut).trimEnd();
}

function formatStepsSummary(steps) {
  if (!steps || !Array.isArray(steps.items) || steps.items.length === 0) return '';
  const tailTitles = steps.items.map((s) => `${s.status}: ${s.title}`).slice(0, 8).join('; ');
  return `${steps.done}/${steps.total} done (${tailTitles})`;
}

function summarizeToolCallForDigest(tc) {
  const name = tc?.name || '';
  const args = tc?.args || tc?.arguments || {};
  if (!name) return '';
  if (name === 'update_focus' && args?.focus) {
    return `Updated focus: ${unwrapString(args.focus).slice(0, 90)}`;
  }
  if (name === 'update_steps' && args?.steps) {
    const parsed = parseStepsArg(args.steps);
    if (parsed) return `Updated checklist (${parsed.done}/${parsed.total} done)`;
  }
  if (name === 'run_command' && typeof args?.toolSummary === 'string' && args.toolSummary.trim()) {
    return `Ran: ${args.toolSummary.trim().slice(0, 80)}`;
  }
  if (name === 'run_command' && typeof args?.CommandLine === 'string') {
    const cmd = args.CommandLine.replace(/\/Users\/[^\s]+/g, '').trim().slice(0, 70);
    return `Ran command: ${cmd}`;
  }
  const verbMap = {
    read_file: 'Inspected',
    edit_file: 'Edited',
    write_file: 'Wrote',
    manage_task: 'Checked background task',
    manage_subagents: 'Checked subagents',
    invoke_subagent: 'Started subagent',
    send_message: 'Messaged subagent',
    enter_plan_mode: 'Entered plan review',
    exit_plan_mode: 'Updated plan',
    search_web: 'Searched web',
  };
  const verb = verbMap[name] || name.replace(/_/g, ' ');
  const filePath = args?.Path || args?.path || args?.AbsolutePath || args?.TargetFile;
  if (typeof filePath === 'string' && filePath.trim()) {
    return `${verb}: ${basename(filePath.trim())}`;
  }
  if (name === 'ask_question') return 'Asked user a question';
  return verb;
}

function summarizeStep(entry) {
  const type = entry.type || '';
  const status = entry.status || '';
  const createdAt = entry.created_at || '';
  const tools = (entry.tool_calls || []).map((t) => t?.name).filter(Boolean);
  const rawContent = typeof entry.content === 'string' ? entry.content.trim() : '';

  if (type === 'USER_INPUT') {
    return { kind: 'user', status, createdAt, text: cleanUserText(rawContent).slice(0, 240) };
  }
  if (type === 'PLANNER_RESPONSE') {
    const preview = stripMarkdownPreview(rawContent, 220);
    const detail = tools.length > 0 ? `Tools: ${tools.join(', ')}` : preview;
    return { kind: 'agent', status, createdAt, text: detail || 'Thinking' };
  }
  if (status === 'ERROR') {
    const errText = stripMarkdownPreview(typeof entry.error === 'string' ? entry.error : rawContent, 240);
    return { kind: 'error', status, createdAt, text: errText };
  }
  if (status === 'RUNNING') {
    return { kind: 'bg', status, createdAt, text: stripMarkdownPreview(rawContent, 200) || 'Running task' };
  }
  return null;
}

/** Parse transcript tail for focus, checklist steps, waiting state, turn boundaries, and replies. */
function parseTranscriptTail(conversationId, includeDetail, needDigest = false) {
  const tp = join(BRAIN_DIR, conversationId, '.system_generated', 'logs', 'transcript.jsonl');
  const lines = readTailLines(tp, needDigest ? 262_144 : TAIL_BYTES);
  let focus = '';
  let steps = null;
  let lastReply = '';
  let lastReplyFull = '';
  let lastPrompt = '';
  let model = '';
  let lastStep = null;
  let pendingAsk = '';
  let runningBgCount = 0;
  let turnIndex = 0;
  let focusTurn = -1;
  let focusAtMs = 0;
  let stepsTurn = -1;
  let stepsAtMs = 0;

  let currentTurnReply = '';
  let currentTurnActivity = [];
  let prevTurnUserPrompt = '';
  let prevTurnFocus = '';
  let prevTurnSteps = null;
  let prevTurnReply = '';

  const events = [];

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    lastStep = entry;
    const type = entry.type || '';
    const status = entry.status || '';
    const stepMs = parseIsoMs(entry.created_at);
    if (entry.model) model = String(entry.model);

    if (type === 'USER_INPUT') {
      if (lastPrompt) prevTurnUserPrompt = lastPrompt;
      if (focus) prevTurnFocus = focus;
      if (steps) prevTurnSteps = steps;
      if (currentTurnReply) {
        prevTurnReply = currentTurnReply;
      } else if (lastReplyFull) {
        prevTurnReply = cleanPlainDigestText(lastReplyFull, 900);
      }

      turnIndex += 1;
      pendingAsk = '';
      runningBgCount = 0;
      currentTurnActivity = [];
      currentTurnReply = '';

      const cleaned = cleanUserText(entry.content);
      if (cleaned) lastPrompt = cleaned.slice(0, 320);
    } else if (type === 'PLANNER_RESPONSE') {
      const content = typeof entry.content === 'string' ? entry.content.trim() : '';
      if (content) {
        lastReplyFull = content.slice(0, 8000);
        lastReply = stripMarkdownPreview(content, 180);
        if (needDigest) {
          currentTurnReply = cleanPlainDigestText(content, 1200);
        }
      }
      const calls = entry.tool_calls || [];
      let askedUser = false;
      for (const tc of calls) {
        const name = tc?.name || '';
        const args = tc?.args || tc?.arguments || {};
        if (name === 'update_focus' && args?.focus) {
          const clean = unwrapString(args.focus);
          if (clean) {
            focus = clean;
            focusTurn = turnIndex;
            focusAtMs = stepMs;
          }
        } else if (name === 'update_steps' && args?.steps) {
          const parsed = parseStepsArg(args.steps);
          if (parsed) {
            steps = parsed;
            stepsTurn = turnIndex;
            stepsAtMs = stepMs;
          }
        } else if (name === 'ask_question') {
          askedUser = true;
          const qs = args?.questions;
          if (Array.isArray(qs) && qs[0]?.question) {
            pendingAsk = `Question: ${String(qs[0].question).slice(0, 120)}`;
          } else {
            pendingAsk = 'Needs answer';
          }
        }
        if (needDigest) {
          const summary = summarizeToolCallForDigest(tc);
          if (summary) {
            currentTurnActivity.push(summary);
            if (currentTurnActivity.length > 14) currentTurnActivity.shift();
          }
        }
      }
      if (!askedUser) {
        pendingAsk = '';
      }
      runningBgCount = 0;
    } else if (type === 'GENERIC' && status === 'RUNNING') {
      runningBgCount += 1;
    } else if (type === 'GENERIC' && status === 'DONE') {
      if (!pendingAsk && runningBgCount > 0) {
        runningBgCount = Math.max(0, runningBgCount - 1);
      }
    }

    if (includeDetail) {
      const ev = summarizeStep(entry);
      if (ev) events.push(ev);
    }
  }

  let waitingReason = '';
  if (pendingAsk && lastStep && (lastStep.status === 'RUNNING' || lastStep.type === 'PLANNER_RESPONSE')) {
    waitingReason = pendingAsk;
  } else if (lastStep && lastStep.status === 'ERROR') {
    const errMs = parseIsoMs(lastStep.created_at);
    if (!errMs || Date.now() - errMs > ERROR_SETTLE_MS) {
      waitingReason = 'Last step errored';
    }
  }

  const focusIsCurrentTurn = Boolean(focus) && (turnIndex === 0 || focusTurn === turnIndex);
  const stepsIsCurrentTurn = Boolean(steps) && (turnIndex === 0 || stepsTurn === turnIndex);

  return {
    focus,
    steps,
    focusAtMs,
    stepsAtMs,
    focusIsCurrentTurn,
    stepsIsCurrentTurn,
    lastPrompt,
    lastReply: lastReply || lastPrompt,
    lastReplyFull: includeDetail ? (lastReplyFull || lastPrompt) : '',
    recentEvents: includeDetail ? events.slice(-8).reverse() : [],
    waitingReason,
    runningBgCount,
    model,
    digest: needDigest
      ? {
          currentTurnReply,
          currentTurnActivity,
          prevTurnUserPrompt,
          prevTurnFocus,
          prevTurnStepsSummary: formatStepsSummary(prevTurnSteps),
          prevTurnReply,
        }
      : null,
  };
}

/** Run read-only SQLite query against live WAL database (never immutable=1). */
function querySqlite(sql) {
  if (!existsSync(DB_PATH)) return [];
  try {
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    try {
      return db.prepare(sql).all();
    } finally {
      db.close();
    }
  } catch {
    try {
      const out = execFileSync('/usr/bin/sqlite3', ['-readonly', '-json', DB_PATH, sql], {
        encoding: 'utf8',
        timeout: 4000,
      });
      return out.trim() ? JSON.parse(out) : [];
    } catch {
      return [];
    }
  }
}

function loadBoardState() {
  const defaults = { version: 1, sortMode: 'fixed', order: [], pinned: [], hidden: [] };
  if (!existsSync(STATE_PATH)) return defaults;
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    return {
      version: 1,
      sortMode: ['fixed', 'project', 'state'].includes(parsed?.sortMode) ? parsed.sortMode : 'fixed',
      order: Array.isArray(parsed?.order) ? parsed.order.filter((x) => typeof x === 'string') : [],
      pinned: Array.isArray(parsed?.pinned) ? parsed.pinned.filter((x) => typeof x === 'string') : [],
      hidden: Array.isArray(parsed?.hidden) ? parsed.hidden.filter((x) => typeof x === 'string') : [],
    };
  } catch {
    return defaults;
  }
}

function saveBoardState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${STATE_PATH}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(tmp, STATE_PATH);
}

/** Synchronize persistent slot order with conversations while preserving offline/peer slot memory. */
function syncOrderWithItems(boardState, items) {
  const hasStateFile = existsSync(STATE_PATH);
  let changed = false;

  if (!hasStateFile || boardState.order.length === 0) {
    const seeded = [...items].sort((a, b) => (b.lastUserInputMs || b.lastModifiedMs) - (a.lastUserInputMs || a.lastModifiedMs));
    boardState.order = seeded.map((i) => i.id);
    boardState.pinned = seeded.filter((i) => i.annPinned).map((i) => i.id);
    boardState.hidden = [];
    saveBoardState(boardState);
    return boardState;
  }

  let nextOrder = [...boardState.order];
  const existingSet = new Set(nextOrder);
  const newcomers = items
    .filter((i) => !existingSet.has(i.id))
    .sort((a, b) => (b.lastUserInputMs || b.lastModifiedMs) - (a.lastUserInputMs || a.lastModifiedMs));
  if (newcomers.length > 0) {
    for (const item of newcomers) nextOrder.push(item.id);
    changed = true;
  }
  if (nextOrder.length > 400) {
    const byId = new Set(items.map((i) => i.id));
    nextOrder = nextOrder.filter((id) => byId.has(id)).concat(nextOrder.filter((id) => !byId.has(id))).slice(0, 400);
    changed = true;
  }

  boardState.order = nextOrder;
  if (changed) saveBoardState(boardState);
  return boardState;
}

function classifyConversation(row, ann, transcript, activeSubs) {
  const rawStatus = String(row.status || '');
  const nfi = Number(row.not_fully_idle) === 1;
  const lastModifiedMs = parseIsoMs(row.last_modified_time);
  const lastUserInputMs = parseIsoMs(row.last_user_input_time);

  let waitingReason = transcript.waitingReason;
  if (!waitingReason && rawStatus.includes('WAITING')) {
    waitingReason = 'Waiting for approval';
  }

  const unread = ann.lastUserViewMs > 0
    ? lastModifiedMs > ann.lastUserViewMs + 2000
    : Number(row.step_count || 0) > 1;

  let state = 'idle';
  if (waitingReason) {
    state = 'attention';
  } else if (rawStatus === 'CASCADE_RUN_STATUS_RUNNING') {
    state = 'working';
  } else if (nfi || activeSubs.length > 0 || transcript.runningBgCount > 0) {
    state = 'bg';
  } else if (unread) {
    state = 'unread';
  }

  const ageMs = lastModifiedMs > 0 ? Math.max(0, Date.now() - lastModifiedMs) : 0;
  const stalled = state === 'working' && ageMs > STALL_MS;

  return {
    state,
    waitingReason,
    unread,
    stalled,
    ageMs,
    lastModifiedMs,
    lastUserInputMs,
  };
}

function collectRawConversations(detailId = null) {
  const projects = loadProjectNames();
  const topRows = querySqlite(`
    SELECT conversation_id, title, preview, step_count, status, not_fully_idle,
           project_id, last_modified_time, last_user_input_time
    FROM conversation_summaries
    WHERE nesting_depth = 0 AND (source = '' OR source IS NULL) AND killed = 0
    ORDER BY last_modified_time DESC
  `);

  const subRows = querySqlite(`
    SELECT conversation_id, parent_conversation_id, title, status, not_fully_idle, last_modified_time
    FROM conversation_summaries
    WHERE nesting_depth > 0 AND (status = 'CASCADE_RUN_STATUS_RUNNING' OR not_fully_idle = 1) AND killed = 0
  `);

  const subsByParent = new Map();
  for (const sub of subRows) {
    const pid = sub.parent_conversation_id;
    if (!pid) continue;
    if (!subsByParent.has(pid)) subsByParent.set(pid, []);
    subsByParent.get(pid).push({
      id: sub.conversation_id,
      title: sub.title || sub.conversation_id.slice(0, 8),
      status: String(sub.status || '').replace('CASCADE_RUN_STATUS_', '').toLowerCase(),
      lastModifiedMs: parseIsoMs(sub.last_modified_time),
    });
  }

  const autoWakeSet = getAutoWakeSet();
  const items = [];
  for (const row of topRows) {
    const id = row.conversation_id;
    const ann = readAnnotation(id);
    if (ann.archived) continue;

    const activeSubs = subsByParent.get(id) || [];
    const wantDetail = detailId === id;
    const transcript = parseTranscriptTail(id, wantDetail, false);
    const statusInfo = classifyConversation(row, ann, transcript, activeSubs);
    const title = (ann.title || row.title || row.preview || id.slice(0, 8)).replace(/\s+/g, ' ').trim();
    const projectId = row.project_id || 'outside-of-project';
    const focusIsCurrentTurn = transcript.focusIsCurrentTurn
      && (!statusInfo.lastUserInputMs || !transcript.focusAtMs || transcript.focusAtMs + 2000 >= statusInfo.lastUserInputMs);
    const stepsIsCurrentTurn = transcript.stepsIsCurrentTurn
      && (!statusInfo.lastUserInputMs || !transcript.stepsAtMs || transcript.stepsAtMs + 2000 >= statusInfo.lastUserInputMs);

    items.push({
      id,
      shortId: id.slice(0, 8),
      title,
      projectId,
      projectName: projects[projectId] || projectId,
      stepCount: Number(row.step_count || 0),
      state: statusInfo.state,
      waitingReason: statusInfo.waitingReason,
      unread: statusInfo.unread,
      stalled: statusInfo.stalled,
      ageMs: statusInfo.ageMs,
      lastModifiedMs: statusInfo.lastModifiedMs,
      lastUserInputMs: statusInfo.lastUserInputMs,
      annPinned: ann.pinned,
      autoWake: autoWakeSet.has(id),
      focus: transcript.focus,
      focusIsCurrentTurn,
      steps: transcript.steps,
      stepsIsCurrentTurn,
      lastPrompt: transcript.lastPrompt,
      lastReply: transcript.lastReply,
      lastReplyFull: transcript.lastReplyFull,
      recentEvents: transcript.recentEvents,
      runningBgCount: transcript.runningBgCount,
      subagentCount: activeSubs.length,
      subagents: activeSubs,
      model: transcript.model,
    });
  }
  return items;
}

function parseAgentsNowOutput(stdout) {
  const rows = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 7) continue;
    const [mac, agent, mode, runtime, cpu, state, ...cwdParts] = parts;
    rows.push({
      mac,
      agent,
      mode,
      runtime,
      cpu,
      state,
      project: cwdParts.join(' '),
    });
  }
  return rows;
}

/** Kick off a background refresh of local CLI agents without blocking callers. */
function maybeRefreshFleetInBackground() {
  if (!existsSync(AGENTS_NOW_BIN)) return;
  const now = Date.now();
  if (fleetCache.inFlight || now - fleetCache.updatedAt < FLEET_TTL_MS) return;
  fleetCache.inFlight = true;
  execFile(AGENTS_NOW_BIN, [], { encoding: 'utf8', timeout: 2500 }, (err, stdout) => {
    fleetCache.inFlight = false;
    fleetCache.updatedAt = Date.now();
    if (!err && typeof stdout === 'string') {
      fleetCache.items = parseAgentsNowOutput(stdout);
    }
  });
}

function applyOrdering(items, boardState, includeHidden) {
  const pinnedSet = new Set(boardState.pinned);
  const hiddenSet = new Set(boardState.hidden);
  const orderIndex = new Map(boardState.order.map((id, idx) => [id, idx]));

  const annotated = items.map((item) => ({
    ...item,
    pinned: pinnedSet.has(item.id),
    hidden: hiddenSet.has(item.id),
    slotOrder: orderIndex.get(item.id) ?? Number.MAX_SAFE_INTEGER,
  }));

  const visible = includeHidden ? annotated : annotated.filter((item) => !item.hidden);
  const sortMode = boardState.sortMode;

  visible.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (sortMode === 'project') {
      const cmp = a.projectName.localeCompare(b.projectName);
      if (cmp !== 0) return cmp;
    } else if (sortMode === 'state') {
      const pa = STATE_PRIORITY[a.state] ?? 9;
      const pb = STATE_PRIORITY[b.state] ?? 9;
      if (pa !== pb) return pa - pb;
    }
    return a.slotOrder - b.slotOrder;
  });

  return visible.map((item, idx) => ({ ...item, slot: idx + 1 }));
}

/** Apply unified persistent fixed order and counts across a combined multi-Mac item list. */
export function orderCombinedConversations(items, includeHidden = false) {
  const boardState = syncOrderWithItems(loadBoardState(), items);
  const ordered = applyOrdering(items, boardState, includeHidden);

  const counts = { total: ordered.length, attention: 0, working: 0, bg: 0, unread: 0, idle: 0, hidden: 0 };
  const hiddenSet = new Set(boardState.hidden);
  for (const item of items) {
    if (hiddenSet.has(item.id)) {
      counts.hidden += 1;
      continue;
    }
    counts[item.state] = (counts[item.state] || 0) + 1;
  }

  return {
    sortMode: boardState.sortMode,
    counts,
    conversations: ordered,
  };
}

function readRecentLastAction(maxAgeMs = 12000) {
  if (!existsSync(LAST_ACTION_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(LAST_ACTION_PATH, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.at) return null;
    if (Date.now() - Number(parsed.at) > maxAgeMs) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Return the full structured board snapshot for Antigravity UI and agy-status CLI. */
export function getBoardSnapshot({ includeDetailId = null, includeFleet = true, includeHidden = false } = {}) {
  if (includeFleet) maybeRefreshFleetInBackground();
  const rawItems = collectRawConversations(includeDetailId);
  const withBriefings = attachBriefings(rawItems);
  const unified = orderCombinedConversations(withBriefings, includeHidden);
  const relays = getLocalRelays(40);
  unified.counts.pendingRelays = relays.filter((r) => r.status === 'pending').length;
  const lastAction = readRecentLastAction();

  return {
    generatedAt: Date.now(),
    sortMode: unified.sortMode,
    counts: unified.counts,
    conversations: unified.conversations,
    fleet: includeFleet ? fleetCache.items : [],
    relays,
    ...(lastAction ? { lastAction } : {}),
  };
}

/** Return detailed telemetry for one conversation including full checklist and recent events. */
export function getThreadDetail(conversationId) {
  if (!conversationId) return null;
  const snap = getBoardSnapshot({ includeDetailId: conversationId, includeFleet: false, includeHidden: true });
  return snap.conversations.find((c) => c.id === conversationId) || null;
}

/** Return compact turn-aware digest for synthesizing plain-English AI briefings. */
export function getConversationDigest(conversationId) {
  if (!conversationId) return null;
  const projects = loadProjectNames();
  const safeId = String(conversationId).replace(/[^a-zA-Z0-9-]/g, '');
  if (!safeId) return null;
  const rows = querySqlite(`
    SELECT conversation_id, title, preview, step_count, status, not_fully_idle,
           project_id, last_modified_time, last_user_input_time
    FROM conversation_summaries
    WHERE conversation_id = '${safeId}' AND killed = 0
    LIMIT 1
  `);
  const row = rows[0];
  if (!row) return null;

  const subRows = querySqlite(`
    SELECT title, status
    FROM conversation_summaries
    WHERE parent_conversation_id = '${safeId}'
      AND nesting_depth > 0
      AND (status = 'CASCADE_RUN_STATUS_RUNNING' OR not_fully_idle = 1)
      AND killed = 0
  `);
  const activeSubs = subRows.map((sub) => ({
    title: sub.title || 'Subagent',
    status: String(sub.status || '').replace('CASCADE_RUN_STATUS_', '').toLowerCase(),
  }));

  const ann = readAnnotation(safeId);
  const transcript = parseTranscriptTail(safeId, false, true);
  const statusInfo = classifyConversation(row, ann, transcript, activeSubs);
  const title = (ann.title || row.title || row.preview || safeId.slice(0, 8)).replace(/\s+/g, ' ').trim();
  const projectId = row.project_id || 'outside-of-project';
  const focusIsCurrentTurn = transcript.focusIsCurrentTurn
    && (!statusInfo.lastUserInputMs || !transcript.focusAtMs || transcript.focusAtMs + 2000 >= statusInfo.lastUserInputMs);
  const stepsIsCurrentTurn = transcript.stepsIsCurrentTurn
    && (!statusInfo.lastUserInputMs || !transcript.stepsAtMs || transcript.stepsAtMs + 2000 >= statusInfo.lastUserInputMs);

  return {
    id: safeId,
    title,
    projectName: projects[projectId] || projectId,
    state: statusInfo.state,
    autoWake: isAutoWakeEnabled(safeId),
    stepCount: Number(row.step_count || 0),
    lastUserInputMs: statusInfo.lastUserInputMs,
    waitingReason: statusInfo.waitingReason,
    model: transcript.model,
    lastUserPrompt: transcript.lastPrompt || cleanUserText(row.preview || ''),
    currentTurn: {
      focus: focusIsCurrentTurn ? transcript.focus : '',
      stepsSummary: stepsIsCurrentTurn ? formatStepsSummary(transcript.steps) : '',
      recentActivity: transcript.digest?.currentTurnActivity || [],
      latestReply: transcript.digest?.currentTurnReply || '',
    },
    priorTurn: {
      userPrompt: transcript.digest?.prevTurnUserPrompt || '',
      focus: transcript.digest?.prevTurnFocus || (!focusIsCurrentTurn ? transcript.focus : ''),
      stepsSummary: transcript.digest?.prevTurnStepsSummary || (!stepsIsCurrentTurn ? formatStepsSummary(transcript.steps) : ''),
      replySnippet: transcript.digest?.prevTurnReply || '',
    },
    activeSubagents: activeSubs.map((s) => `${s.title} (${s.status})`),
  };
}

/** Mutate persistent fixed order, pins, hidden set, or sort mode, and return updated snapshot. */
export function mutateBoardState({ action, conversationId, direction, toIndex, value, items = null } = {}) {
  const sourceItems = Array.isArray(items) ? items : collectRawConversations(null);
  const boardState = syncOrderWithItems(loadBoardState(), sourceItems);
  const pinnedSet = new Set(boardState.pinned);

  if (action === 'set_sort' && ['fixed', 'project', 'state'].includes(value)) {
    boardState.sortMode = value;
  } else if (action === 'pin' && conversationId) {
    if (pinnedSet.has(conversationId)) {
      boardState.pinned = boardState.pinned.filter((id) => id !== conversationId);
    } else {
      boardState.pinned = [...boardState.pinned, conversationId];
    }
  } else if (action === 'hide' && conversationId) {
    if (!boardState.hidden.includes(conversationId)) {
      boardState.hidden = [...boardState.hidden, conversationId];
    }
  } else if (action === 'unhide_all') {
    boardState.hidden = [];
  } else if (action === 'reset_order') {
    const sorted = [...sourceItems].sort((a, b) => (b.lastUserInputMs || b.lastModifiedMs) - (a.lastUserInputMs || a.lastModifiedMs));
    boardState.order = sorted.map((i) => i.id);
  } else if (action === 'move' && conversationId) {
    if (direction === 'bottom') {
      boardState.pinned = boardState.pinned.filter((id) => id !== conversationId);
      boardState.order = [...boardState.order.filter((id) => id !== conversationId), conversationId];
    } else if (direction === 'top') {
      boardState.order = [conversationId, ...boardState.order.filter((id) => id !== conversationId)];
    } else {
      const visibleIds = applyOrdering(sourceItems, { ...boardState, sortMode: 'fixed' }, false).map((i) => i.id);
      const sameGroup = visibleIds.filter((id) => pinnedSet.has(id) === pinnedSet.has(conversationId));
      const idxInGroup = sameGroup.indexOf(conversationId);
      if (idxInGroup !== -1) {
        let targetId = null;
        if (direction === 'up' && idxInGroup > 0) targetId = sameGroup[idxInGroup - 1];
        else if (direction === 'down' && idxInGroup < sameGroup.length - 1) targetId = sameGroup[idxInGroup + 1];

        if (typeof toIndex === 'number' && toIndex >= 0 && toIndex < sameGroup.length) {
          targetId = sameGroup[toIndex];
        }
        if (targetId && targetId !== conversationId) {
          const order = [...boardState.order];
          const fromIdx = order.indexOf(conversationId);
          const toOrderIdx = order.indexOf(targetId);
          if (fromIdx !== -1 && toOrderIdx !== -1) {
            order.splice(fromIdx, 1);
            order.splice(toOrderIdx, 0, conversationId);
            boardState.order = order;
          }
        }
      }
    }
  }

  saveBoardState(boardState);
  return getBoardSnapshot({ includeDetailId: conversationId || null, includeFleet: true, includeHidden: false });
}
