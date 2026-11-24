import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const HOME = homedir();
const CACHE_TTL_MS = 30 * 1000;
const RESET_WINDOW_MS = 12 * 60 * 60 * 1000;
const STALE_AGE_MS = 3 * 60 * 60 * 1000;
const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const MODEL_SLUG_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/i;

let cachedCapacity = { at: 0, value: null };

function expandHome(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (trimmed === '~') return HOME;
  if (trimmed.startsWith('~/')) return join(HOME, trimmed.slice(2));
  return trimmed;
}

function isExecutable(filePath) {
  if (!filePath) return false;
  try {
    accessSync(filePath, constants.X_OK);
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function parseSemverTuple(str) {
  return String(str || '')
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .filter((n) => Number.isFinite(n));
}

function compareSemverDesc(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return bv - av;
  }
  return 0;
}

function compareSemverAsc(a, b) {
  return compareSemverDesc(b, a);
}

function defaultStateDir() {
  return expandHome(process.env.AGY_CONTROL_STATE_DIR || '') || join(HOME, '.local', 'state', 'agy-control');
}

function defaultCapacityStatePath() {
  return expandHome(process.env.AGY_CAPACITY_STATE_PATH || '') || join(defaultStateDir(), 'capacity-state.json');
}

function readJsonSafe(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(path, data) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    renameSync(tmp, path);
  } catch {
    // Non-fatal cache write failure.
  }
}

export function discoverCodexModels(cachePath = expandHome(process.env.AGY_CODEX_MODELS_CACHE || '') || join(HOME, '.codex', 'models_cache.json')) {
  const fallbackSol = 'gpt-6.2-sol';
  const fallbackAstra = 'gpt-6.2-astra';
  const floorTuple = [6, 2];

  const doc = readJsonSafe(cachePath);
  const rawModels = Array.isArray(doc?.models) ? doc.models : Array.isArray(doc) ? doc : [];

  const solMatches = [];
  const astraMatches = [];
  const pat = /^gpt-(\d+(?:\.\d+)*)-(sol|astra)$/i;

  for (const entry of rawModels) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.visibility === 'hide') continue;
    const slug = String(entry.slug || entry.id || '').trim();
    const m = pat.exec(slug);
    if (!m) continue;
    const tuple = parseSemverTuple(m[1]);
    const family = m[2].toLowerCase();
    if (family === 'sol') solMatches.push({ slug, tuple });
    else if (family === 'astra') astraMatches.push({ slug, tuple });
  }

  solMatches.sort((a, b) => compareSemverDesc(a.tuple, b.tuple));
  astraMatches.sort((a, b) => compareSemverDesc(a.tuple, b.tuple));

  const topSol = solMatches[0] && compareSemverAsc(solMatches[0].tuple, floorTuple) >= 0 ? solMatches[0].slug : fallbackSol;
  const topAstra = astraMatches[0] && compareSemverAsc(astraMatches[0].tuple, floorTuple) >= 0 ? astraMatches[0].slug : fallbackAstra;

  const available = Array.from(
    new Set([
      topAstra,
      topSol,
      ...astraMatches.map((m) => m.slug),
      ...solMatches.map((m) => m.slug),
      fallbackAstra,
      fallbackSol,
    ]),
  );

  return {
    sol: topSol,
    astra: topAstra,
    available,
  };
}

export function findCodexBinary() {
  const candidates = [];
  const envBin = expandHome(process.env.AGY_CODEX_BIN || '');
  if (envBin) candidates.push(envBin);

  const pathDirs = String(process.env.PATH || '').split(':').filter(Boolean);
  for (const dir of pathDirs) {
    candidates.push(join(dir, 'codex'));
  }

  const nvmDir = join(HOME, '.nvm', 'versions', 'node');
  if (existsSync(nvmDir)) {
    try {
      const versions = readdirSync(nvmDir).sort().reverse();
      for (const ver of versions) {
        candidates.push(join(nvmDir, ver, 'bin', 'codex'));
      }
    } catch {
      // Ignore unreadable nvm directory.
    }
  }

  candidates.push(
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
  );

  for (const cand of candidates) {
    if (isExecutable(cand)) return cand;
  }
  return '';
}

export function readPausedProviders(pausedPath = expandHome(process.env.AGENTKIT_PAUSED_PROVIDERS || '') || join(HOME, '.config', 'agentkit', 'paused-providers')) {
  if (!existsSync(pausedPath)) return [];
  try {
    const out = [];
    const seen = new Set();
    for (const line of readFileSync(pausedPath, 'utf8').split('\n')) {
      const clean = line.split('#', 1)[0].trim().toLowerCase();
      if (clean && !seen.has(clean)) {
        seen.add(clean);
        out.push(clean);
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function readUnavailableMarks(nowMs = Date.now(), aiPickDir = join(HOME, '.local', 'state', 'ai-pick')) {
  const marks = {};
  if (!existsSync(aiPickDir)) return marks;
  try {
    for (const name of readdirSync(aiPickDir)) {
      const m = /^unavailable-([\w.-]+)\.json$/.exec(name);
      if (!m) continue;
      const doc = readJsonSafe(join(aiPickDir, name));
      if (doc && typeof doc.until === 'number' && doc.until * 1000 > nowMs) {
        marks[m[1].toLowerCase()] = String(doc.reason || 'marked unavailable');
      }
    }
  } catch {
    // Non-fatal state read failure.
  }
  return marks;
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseTimestampMs(iso) {
  if (!iso) return null;
  const ms = Date.parse(String(iso));
  return Number.isFinite(ms) ? ms : null;
}

function mergePoolListFromServicesDoc(doc, bucketMap) {
  if (!doc || typeof doc !== 'object') return;
  const services = doc.services;
  if (!services || typeof services !== 'object') return;

  for (const [rawEngine, svc] of Object.entries(services)) {
    if (!svc || typeof svc !== 'object') continue;
    const engine = String(rawEngine).trim().toLowerCase();
    const unavail = svc.unavailable ? String(svc.unavailable) : '';
    const pools = Array.isArray(svc.pools) ? svc.pools : [];
    for (const p of pools) {
      if (!p || typeof p !== 'object') continue;
      const poolName = String(p.pool || '').trim() || engine;
      const est = p.estimate && typeof p.estimate === 'object' ? p.estimate : {};
      const asOf = p.asOf || '';
      const asOfMs = parseTimestampMs(asOf) || parseTimestampMs(doc.generatedAt) || 0;
      const key = `${engine}:${poolName}`;
      const existing = bucketMap.get(key);
      if (existing && existing.asOfMs > asOfMs) continue;

      bucketMap.set(key, {
        engine,
        pool: poolName,
        remainingPct: toFiniteNumber(p.remainingPct ?? p.remaining_pct),
        resetAt: String(p.resetAt || p.reset_at || ''),
        jobsLeft: toFiniteNumber(p.jobsLeft ?? p.jobs_left ?? est.jobsLeft),
        tokensLeft: toFiniteNumber(p.tokensLeft ?? p.tokens_left ?? est.tokensLeft),
        freshness: String(p.freshness || (p.stale === false ? 'fresh' : 'unknown')).toLowerCase(),
        paused: Boolean(p.paused),
        unavailableReason: unavail,
        asOf: String(asOf || doc.generatedAt || ''),
        asOfMs,
      });
    }
  }
}

function mergePoolListFromFleetCapacity(fleetCapacity, bucketMap) {
  if (!fleetCapacity || typeof fleetCapacity !== 'object') return;
  const pools = Array.isArray(fleetCapacity.pools) ? fleetCapacity.pools : [];
  for (const p of pools) {
    if (!p || typeof p !== 'object') continue;
    const rawEngine = String(p.engine || '').trim().toLowerCase();
    const rawName = String(p.pool || p.label || p.name || '').trim();
    const engine = rawEngine || (rawName.includes(':') ? rawName.split(':', 1)[0].trim().toLowerCase() : rawName.toLowerCase());
    if (!engine) continue;
    const poolName = rawName || engine;
    const key = `${engine}:${poolName}`;
    const asOf = String(p.asOf || fleetCapacity.generated_at || fleetCapacity.generatedAt || '');
    const asOfMs = parseTimestampMs(asOf) || 0;
    const existing = bucketMap.get(key);
    if (existing && existing.asOfMs > asOfMs) continue;

    bucketMap.set(key, {
      engine,
      pool: poolName,
      remainingPct: toFiniteNumber(p.remaining_pct ?? p.remainingPct),
      resetAt: String(p.reset_at ?? p.resetAt ?? ''),
      jobsLeft: toFiniteNumber(p.jobs_left ?? p.jobsLeft),
      tokensLeft: toFiniteNumber(p.tokens_left ?? p.tokensLeft),
      freshness: String(p.freshness || (p.stale === true ? 'stale' : p.stale === false ? 'fresh' : 'unknown')).toLowerCase(),
      paused: Boolean(p.paused),
      unavailableReason: p.unavailable ? String(p.unavailable) : '',
      asOf,
      asOfMs,
    });
  }
}

export function buildProviderSummary({
  aiCapacityDoc = null,
  sharedDoc = null,
  fleetCapacity = null,
  pausedProviders = [],
  unavailableMarks = {},
  previousState = null,
  codexInstalled = false,
  codexModels = null,
  nowMs = Date.now(),
} = {}) {
  const pausedSet = new Set(pausedProviders.map((p) => String(p).trim().toLowerCase()).filter(Boolean));
  if (Array.isArray(fleetCapacity?.paused)) {
    for (const p of fleetCapacity.paused) {
      const clean = String(p || '').trim().toLowerCase();
      if (clean) pausedSet.add(clean);
    }
  }

  const bucketMap = new Map();
  mergePoolListFromServicesDoc(sharedDoc, bucketMap);
  mergePoolListFromServicesDoc(aiCapacityDoc, bucketMap);
  mergePoolListFromFleetCapacity(fleetCapacity, bucketMap);

  const isShortWindowPool = (poolName) => {
    const clean = String(poolName || '').trim().toLowerCase();
    return clean === '5h' || clean.endsWith('-5h');
  };
  const exhaustedEngines = new Set();
  for (const item of bucketMap.values()) {
    const paused = Boolean(item.paused || pausedSet.has(item.engine));
    if (!paused && !isShortWindowPool(item.pool) && item.remainingPct !== null && item.remainingPct <= 2) {
      exhaustedEngines.add(item.engine);
    }
  }

  const prevPools = previousState && typeof previousState.pools === 'object' ? previousState.pools : {};
  const nextPoolsState = {};
  const pools = [];
  const resetAlerts = [];

  for (const item of bucketMap.values()) {
    const paused = Boolean(item.paused || pausedSet.has(item.engine));
    const markReason = unavailableMarks[item.engine] || '';
    const unavailableReason = item.unavailableReason || markReason || (paused ? 'paused' : '');
    const isFresh =
      item.freshness === 'fresh'
      || (item.asOfMs > 0 && nowMs - item.asOfMs <= STALE_AGE_MS && item.freshness !== 'stale');

    const key = `${item.engine}:${item.pool}`;
    const prev = prevPools[key] && typeof prevPools[key] === 'object' ? prevPools[key] : null;
    const pct = item.remainingPct;
    const prevPct = toFiniteNumber(prev?.remainingPct);
    const shortPool = isShortWindowPool(item.pool);
    const engineExhausted = exhaustedEngines.has(item.engine);

    let resetDetectedAt = toFiniteNumber(prev?.resetDetectedAt) || 0;
    let triggerReset = false;

    if (!paused && !unavailableReason && pct !== null && !shortPool && !engineExhausted) {
      const resetAdvanced = Boolean(prev?.resetAt && item.resetAt && item.resetAt !== prev.resetAt && pct >= 85);
      const jumpedUp = prevPct !== null && pct - prevPct >= 25 && pct >= 85;
      const unblockedFull = Boolean(prev && (prev.paused || prev.unavailableReason) && pct >= 80);
      const firstFullObservation = !prev && isFresh && pct >= 95;
      if (resetAdvanced || jumpedUp || unblockedFull || firstFullObservation) {
        triggerReset = true;
        resetDetectedAt = nowMs;
      }
    } else if (paused || unavailableReason || shortPool || engineExhausted) {
      resetDetectedAt = 0;
    }

    const withinWindow = resetDetectedAt > 0 && nowMs - resetDetectedAt <= RESET_WINDOW_MS;
    const recentlyReset = Boolean(
      !paused
      && !unavailableReason
      && !shortPool
      && !engineExhausted
      && (triggerReset || (withinWindow && (pct === null || pct >= 80))),
    );

    nextPoolsState[key] = {
      remainingPct: pct,
      resetAt: item.resetAt,
      paused,
      unavailableReason,
      resetDetectedAt: recentlyReset ? resetDetectedAt : 0,
      updatedAt: nowMs,
    };

    const normalized = {
      engine: item.engine,
      pool: item.pool,
      remainingPct: pct,
      resetAt: item.resetAt,
      jobsLeft: item.jobsLeft,
      tokensLeft: item.tokensLeft,
      freshness: isFresh ? 'fresh' : item.freshness || 'unknown',
      paused,
      available: !paused && !unavailableReason && (pct === null || pct > 2),
      recentlyReset,
      unavailableReason,
    };
    pools.push(normalized);

    if (recentlyReset) {
      resetAlerts.push({
        engine: item.engine,
        pool: item.pool,
        remainingPct: pct,
        resetAt: item.resetAt,
        detectedAt: resetDetectedAt || nowMs,
      });
    }
  }

  const models = codexModels || discoverCodexModels();
  const codexPaused = pausedSet.has('codex');
  const codexMark = unavailableMarks.codex || '';
  const codexPools = pools.filter((p) => p.engine === 'codex');
  const primaryCodexPool = codexPools.find((p) => p.pool === 'codex:primary') || codexPools[0] || null;
  const codexPct = primaryCodexPool ? primaryCodexPool.remainingPct : null;
  const codexUnavailableReason =
    primaryCodexPool?.unavailableReason || codexMark || (codexPaused ? 'paused' : codexInstalled ? '' : 'codex CLI not found');
  const codexAvailable = Boolean(
    codexInstalled
    && !codexPaused
    && !codexUnavailableReason
    && (codexPct === null || codexPct > 2),
  );

  const source = aiCapacityDoc
    ? 'ai-capacity'
    : fleetCapacity
      ? 'fleet-api'
      : sharedDoc
        ? 'shared-json'
        : 'none';

  return {
    summary: {
      available: source !== 'none' || codexInstalled || pausedSet.size > 0,
      generatedAt: nowMs,
      source,
      paused: Array.from(pausedSet).sort(),
      pools,
      resetAlerts,
      codex: {
        installed: codexInstalled,
        available: codexAvailable,
        paused: codexPaused,
        remainingPct: codexPct,
        resetAt: primaryCodexPool?.resetAt || '',
        freshness: primaryCodexPool?.freshness || 'unknown',
        recentlyReset: Boolean(primaryCodexPool?.recentlyReset),
        models: models.available,
        defaultModels: {
          sol: models.sol,
          astra: models.astra,
        },
        unavailableReason: codexAvailable ? '' : codexUnavailableReason,
      },
    },
    nextState: {
      version: 1,
      updatedAt: nowMs,
      pools: nextPoolsState,
    },
  };
}

export async function getProviderCapacity({ force = false, fleetCapacity = null } = {}) {
  const nowMs = Date.now();
  if (!force && !fleetCapacity && cachedCapacity.value && nowMs - cachedCapacity.at < CACHE_TTL_MS) {
    return cachedCapacity.value;
  }

  let aiCapacityDoc = null;
  const aiCapacityBin = join(HOME, '.local', 'bin', 'ai-capacity');
  if (isExecutable(aiCapacityBin)) {
    try {
      const { stdout } = await execFileAsync(aiCapacityBin, ['--json'], { encoding: 'utf8', timeout: 3000 });
      aiCapacityDoc = JSON.parse(stdout);
    } catch {
      aiCapacityDoc = null;
    }
  }

  const sharedPath = join(HOME, '.local', 'state', 'ai-capacity', 'shared.json');
  const sharedDoc = readJsonSafe(sharedPath);
  const pausedProviders = readPausedProviders();
  const unavailableMarks = readUnavailableMarks(nowMs);
  const statePath = defaultCapacityStatePath();
  const previousState = readJsonSafe(statePath);
  const codexInstalled = Boolean(findCodexBinary());
  const codexModels = discoverCodexModels();

  const { summary, nextState } = buildProviderSummary({
    aiCapacityDoc,
    sharedDoc,
    fleetCapacity,
    pausedProviders,
    unavailableMarks,
    previousState,
    codexInstalled,
    codexModels,
    nowMs,
  });

  writeJsonAtomic(statePath, nextState);
  if (!fleetCapacity) {
    cachedCapacity = { at: nowMs, value: summary };
  }
  return summary;
}

export function resolveRequestedCodexModel(rawModel, defaults = { sol: 'gpt-6.2-sol', astra: 'gpt-6.2-astra' }) {
  const req = String(rawModel || 'astra').trim();
  const low = req.toLowerCase();
  if (!low || low === 'astra') return defaults.astra || 'gpt-6.2-astra';
  if (low === 'sol') return defaults.sol || 'gpt-6.2-sol';
  if (!MODEL_SLUG_RE.test(req)) {
    throw new Error(`Invalid Codex model slug "${req}"`);
  }
  return req;
}

export async function askCodexHelper({
  prompt,
  model = 'astra',
  effort = 'medium',
  cwd = '',
  files = [],
  timeoutSec = 240,
} = {}) {
  const cleanPrompt = String(prompt || '').trim();
  if (!cleanPrompt || cleanPrompt.length > 16000) {
    return { status: 400, ok: false, error: 'Prompt must be 1..16000 characters' };
  }

  const cleanEffort = String(effort || 'medium').trim().toLowerCase();
  if (!VALID_EFFORTS.has(cleanEffort)) {
    return { status: 400, ok: false, error: `Invalid effort "${effort}" (expected low|medium|high|xhigh|max)` };
  }

  const cap = await getProviderCapacity({ force: true });
  if (!cap.codex.installed) {
    return { status: 503, ok: false, error: 'Codex CLI is not installed on this Mac' };
  }
  if (cap.codex.paused) {
    return { status: 403, ok: false, error: 'Codex provider is paused in agentkit configuration' };
  }
  if (cap.codex.unavailableReason) {
    return { status: 503, ok: false, error: `Codex is unavailable: ${cap.codex.unavailableReason}` };
  }
  if (cap.codex.remainingPct !== null && cap.codex.remainingPct <= 2) {
    return { status: 429, ok: false, error: `Codex pool headroom too low (${cap.codex.remainingPct}% remaining)` };
  }

  let resolvedModel;
  try {
    resolvedModel = resolveRequestedCodexModel(model, cap.codex.defaultModels);
  } catch (err) {
    return { status: 400, ok: false, error: err?.message || 'Invalid Codex model' };
  }

  let resolvedCwd = join(HOME, '.local', 'state', 'agy-monitor', 'prompt-cwd');
  if (typeof cwd === 'string' && cwd.trim()) {
    const candidate = resolve(expandHome(cwd));
    if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
      return { status: 400, ok: false, error: `Working directory does not exist: ${cwd}` };
    }
    resolvedCwd = candidate;
  } else {
    mkdirSync(resolvedCwd, { recursive: true });
  }

  const codexBin = findCodexBinary();
  if (!codexBin) {
    return { status: 503, ok: false, error: 'Codex CLI binary not found' };
  }

  const safeFiles = Array.isArray(files)
    ? files.map((f) => String(f || '').trim()).filter(Boolean).slice(0, 20)
    : [];
  const scopeText = safeFiles.length ? `\nFocus paths:\n${safeFiles.map((f) => `- ${f}`).join('\n')}` : '';
  const guardText =
    'You are invoked read-only via Mission Control as a specialist helper. Do not modify or delete files, and do not execute state-changing commands. Separate observed facts from inferences, cite exact paths/symbols when applicable, and respond directly.';
  const fullPrompt = `${guardText}${scopeText}\n\n${cleanPrompt}`;

  const boundedTimeoutSec = Math.max(15, Math.min(600, Math.round(Number(timeoutSec) || 240)));
  const tmpOut = join(tmpdir(), `mc-codex-${process.pid}-${randomUUID()}.txt`);
  const startedAt = Date.now();

  const cleanupTmp = () => {
    try {
      if (existsSync(tmpOut)) unlinkSync(tmpOut);
    } catch {
      // Ignore cleanup errors.
    }
  };

  return new Promise((resolvePromise) => {
    const args = [
      'exec',
      '-s', 'read-only',
      '--ephemeral',
      '--ignore-rules',
      '--skip-git-repo-check',
      '-C', resolvedCwd,
      '-m', resolvedModel,
      '-c', `model_reasoning_effort=${cleanEffort}`,
      '-o', tmpOut,
      '--', fullPrompt,
    ];

    const child = spawn(codexBin, args, {
      cwd: resolvedCwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const outChunks = [];
    const errChunks = [];
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupTmp();
      resolvePromise(result);
    };

    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
      }, 1500).unref();
      finish({
        status: 504,
        ok: false,
        model: resolvedModel,
        effort: cleanEffort,
        error: `Codex helper timed out after ${boundedTimeoutSec}s`,
        durationMs: Date.now() - startedAt,
        remainingPct: cap.codex.remainingPct,
      });
    }, boundedTimeoutSec * 1000);

    child.stdout.on('data', (chunk) => {
      if (outChunks.length < 64) outChunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (errChunks.length < 64) errChunks.push(chunk);
    });

    child.on('error', (err) => {
      finish({
        status: 500,
        ok: false,
        model: resolvedModel,
        effort: cleanEffort,
        error: err?.message || 'Failed to spawn codex CLI',
        durationMs: Date.now() - startedAt,
        remainingPct: cap.codex.remainingPct,
      });
    });

    child.on('close', (code) => {
      const stdoutText = Buffer.concat(outChunks).toString('utf8').trim();
      const stderrText = Buffer.concat(errChunks).toString('utf8').trim();
      let reply = '';
      if (existsSync(tmpOut)) {
        try {
          reply = readFileSync(tmpOut, 'utf8').trim();
        } catch {
          reply = '';
        }
      }
      const combined = `${reply}\n${stdoutText}\n${stderrText}`;
      if (/hit your usage limit|rate.?limit|quota exceeded|insufficient_quota/i.test(combined)) {
        finish({
          status: 429,
          ok: false,
          model: resolvedModel,
          effort: cleanEffort,
          error: 'Codex usage or rate limit reached',
          durationMs: Date.now() - startedAt,
          remainingPct: cap.codex.remainingPct,
        });
        return;
      }
      if (code !== 0 && !reply) {
        const tailErr = stderrText.split('\n').slice(-6).join(' ').trim() || `Codex exited with code ${code}`;
        finish({
          status: 502,
          ok: false,
          model: resolvedModel,
          effort: cleanEffort,
          error: tailErr,
          durationMs: Date.now() - startedAt,
          remainingPct: cap.codex.remainingPct,
        });
        return;
      }
      if (!reply) {
        finish({
          status: 502,
          ok: false,
          model: resolvedModel,
          effort: cleanEffort,
          error: 'Codex returned an empty response',
          durationMs: Date.now() - startedAt,
          remainingPct: cap.codex.remainingPct,
        });
        return;
      }
      finish({
        status: 200,
        ok: true,
        model: resolvedModel,
        effort: cleanEffort,
        reply,
        durationMs: Date.now() - startedAt,
        remainingPct: cap.codex.remainingPct,
      });
    });
  });
}

export function resetProviderCapacityCache() {
  cachedCapacity = { at: 0, value: null };
}
