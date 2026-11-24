import { execFile, execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { focusThread, sendMessageToThread, startNewThread, stopThread } from './control.mjs';
import {
  findPeerByName,
  getFederatedBoard,
  getFederatedDetail,
  loadPeerConfig,
  proxyPeerRequest,
  resolveConversationByTitleOrId,
  resolveOwnerPeer,
  resolveRelayOwner,
} from './federation.mjs';
import { approveLocalRelay, dismissLocalRelay, setAutoWake, submitLocalRelay, toggleAutoWake } from './relay.mjs';
import { getThreadDetail } from './state.mjs';
import { askCodexHelper, getProviderCapacity } from './providers.mjs';

const execFileAsync = promisify(execFile);

const HOME = homedir();
const STATE_DIR = join(HOME, '.local', 'state', 'agy-monitor');
const COMMANDER_PATH = join(STATE_DIR, 'commander.json');
const PROMPT_CWD = join(STATE_DIR, 'prompt-cwd');
const FLEET_BRIDGE_PATH = join(HOME, '.config', 'agy-control', 'fleet.json');
const AGY_BIN = join(HOME, '.local', 'bin', 'agy');

const MAX_MESSAGES = 40;
const DIGEST_TTL_MS = 5 * 60 * 1000;

export const HIGH_RISK_ACTIONS = new Set([
  'fleet_job_kickstart',
  'fleet_provider_pause',
  'fleet_morning_refresh',
  'stop_agent',
]);

export const MEDIUM_RISK_ACTIONS = new Set([
  'send_to_agent',
  'start_new_agent',
  'approve_relay',
  'toggle_auto_wake',
  'fleet_mail',
]);

export const LOW_RISK_ACTIONS = new Set([
  'relay_to_agent',
  'dismiss_relay',
  'fleet_mail_ack',
  'fleet_snooze',
  'ask_codex',
]);

export const VALID_ACTION_KINDS = new Set([
  ...HIGH_RISK_ACTIONS,
  ...MEDIUM_RISK_ACTIONS,
  ...LOW_RISK_ACTIONS,
]);

let cachedKeychainToken = { service: '', token: '' };

function ensureDirs() {
  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(PROMPT_CWD, { recursive: true });
}

function expandHome(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (trimmed === '~') return HOME;
  if (trimmed.startsWith('~/')) return join(HOME, trimmed.slice(2));
  return trimmed;
}

function stripEllipsis(raw) {
  return String(raw || '')
    .replace(/\u2026/g, '')
    .replace(/\.{3,}/g, '')
    .trim();
}

function trimCleanBoundary(raw, maxLen = 4000) {
  const clean = stripEllipsis(raw)
    .replace(/\/Users\/[^\s),.;:]+/g, '')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (clean.length <= maxLen) return clean;
  const cut = clean.slice(0, maxLen).trimEnd();
  const space = cut.lastIndexOf(' ');
  return (space > Math.floor(maxLen * 0.6) ? cut.slice(0, space) : cut).trimEnd();
}

export function normalizeActionRisk(kind) {
  const k = String(kind || '').trim();
  if (HIGH_RISK_ACTIONS.has(k)) return 'high';
  if (MEDIUM_RISK_ACTIONS.has(k)) return 'medium';
  if (LOW_RISK_ACTIONS.has(k)) return 'low';
  return null;
}

export function chooseCommanderModel(text, routingMode = 'auto', { hasDrilldown = false } = {}) {
  const clean = String(text || '').trim();
  const mode = routingMode === 'fast' || routingMode === 'deep' ? routingMode : 'auto';
  if (mode === 'fast') {
    return {
      model: 'gemini-3.8-flash-high',
      tier: 'Flash',
      effort: 'medium',
      routingReason: 'Fast mode selected',
    };
  }
  if (mode === 'deep') {
    return {
      model: 'gemini-4-carbon-high',
      tier: 'Carbon',
      effort: 'high',
      routingReason: 'Deep mode selected',
    };
  }
  if (
    clean.length > 80 &&
    /\b(architect|architecture|strategy|tradeoff|trade-off|redesign|migration|across all projects|root cause)\b/i.test(clean)
  ) {
    return {
      model: 'gemini-4-neon-high',
      tier: 'Neon',
      effort: 'high',
      routingReason: 'Complex multi-project strategy',
    };
  }
  if (
    hasDrilldown ||
    clean.length > 200 ||
    /\b(why|debug|diagnos\w*|compare|plan|prioriti[sz]e|audit|investigat\w*|explain|what happened|summarize everything)\b/i.test(
      clean,
    )
  ) {
    return {
      model: 'gemini-4-carbon-high',
      tier: 'Carbon',
      effort: 'high',
      routingReason: hasDrilldown ? 'Deep synthesis after live drill-down' : 'Reasoning or synthesis request',
    };
  }
  return {
    model: 'gemini-3.8-flash-high',
    tier: 'Flash',
    effort: 'medium',
    routingReason: 'Quick status or dispatch',
  };
}

function defaultState() {
  return {
    version: 1,
    preferences: {
      routingMode: 'auto',
      directDispatch: false,
    },
    digest: null,
    messages: [],
  };
}

export function loadCommanderState() {
  const base = defaultState();
  if (!existsSync(COMMANDER_PATH)) return base;
  try {
    const parsed = JSON.parse(readFileSync(COMMANDER_PATH, 'utf8'));
    const rawRouting = parsed?.preferences?.routingMode;
    const routingMode = rawRouting === 'fast' || rawRouting === 'deep' ? rawRouting : 'auto';
    const directDispatch = Boolean(parsed?.preferences?.directDispatch);
    const messages = Array.isArray(parsed?.messages) ? parsed.messages.slice(-MAX_MESSAGES) : [];
    const digest = parsed?.digest && typeof parsed.digest === 'object' ? parsed.digest : null;
    return {
      version: 1,
      preferences: { routingMode, directDispatch },
      digest,
      messages,
    };
  } catch {
    return base;
  }
}

export function saveCommanderState(state) {
  ensureDirs();
  const rawRouting = state?.preferences?.routingMode;
  const routingMode = rawRouting === 'fast' || rawRouting === 'deep' ? rawRouting : 'auto';
  const normalized = {
    version: 1,
    preferences: {
      routingMode,
      directDispatch: Boolean(state?.preferences?.directDispatch),
    },
    digest: state?.digest && typeof state.digest === 'object' ? state.digest : null,
    messages: Array.isArray(state?.messages) ? state.messages.slice(-MAX_MESSAGES) : [],
  };
  const tmp = `${COMMANDER_PATH}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  renameSync(tmp, COMMANDER_PATH);
  return normalized;
}

export function getCommanderState() {
  return loadCommanderState();
}

export function updateCommanderSettings({ routingMode, directDispatch } = {}) {
  const state = loadCommanderState();
  if (routingMode === 'auto' || routingMode === 'fast' || routingMode === 'deep') {
    state.preferences.routingMode = routingMode;
  }
  if (typeof directDispatch === 'boolean') {
    state.preferences.directDispatch = directDispatch;
  }
  return saveCommanderState(state);
}

export function clearCommanderChat() {
  const state = loadCommanderState();
  state.messages = [];
  return saveCommanderState(state);
}

export function loadFleetBridgeConfig() {
  let fileCfg = {};
  const cfgPath = expandHome(process.env.AGY_FLEET_CONFIG || '') || FLEET_BRIDGE_PATH;
  if (existsSync(cfgPath)) {
    try {
      const parsed = JSON.parse(readFileSync(cfgPath, 'utf8'));
      if (parsed && typeof parsed === 'object') fileCfg = parsed;
    } catch {
      fileCfg = {};
    }
  }
  const url = String(process.env.FLEET_API_URL || fileCfg.url || '').trim().replace(/\/+$/, '');
  const tokenFile = expandHome(process.env.FLEET_API_TOKEN_FILE || fileCfg.tokenFile || '');
  const keychainService = String(
    process.env.FLEET_API_KEYCHAIN_SERVICE || fileCfg.keychainService || '',
  ).trim();
  return { url, tokenFile, keychainService };
}

function readFleetToken(cfg) {
  if (cfg.tokenFile && existsSync(cfg.tokenFile)) {
    try {
      const tok = readFileSync(cfg.tokenFile, 'utf8').trim();
      if (tok) return tok;
    } catch {
      // Fall through to keychain lookup.
    }
  }
  if (!cfg.keychainService) return '';
  if (cachedKeychainToken.service === cfg.keychainService && cachedKeychainToken.token) {
    return cachedKeychainToken.token;
  }
  try {
    const out = execFileSync(
      '/usr/bin/security',
      ['find-generic-password', '-s', cfg.keychainService, '-w'],
      { encoding: 'utf8', timeout: 2500 },
    ).trim();
    if (out) {
      cachedKeychainToken = { service: cfg.keychainService, token: out };
    }
    return out;
  } catch {
    return '';
  }
}

async function callFleetApi(pathWithQuery, { method = 'GET', body = undefined, timeoutMs = 4000 } = {}) {
  const cfg = loadFleetBridgeConfig();
  if (!cfg.url) return { ok: false, status: 503, error: 'Fleet API bridge not configured' };
  const token = readFleetToken(cfg);
  if (!token) return { ok: false, status: 401, error: 'Missing Fleet API bearer token' };

  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
  };
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  try {
    const resp = await fetch(`${cfg.url}${pathWithQuery}`, {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await resp.text();
    let parsed = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { error: trimCleanBoundary(text, 200) };
    }
    return { ok: resp.ok, status: resp.status, body: parsed };
  } catch (err) {
    return { ok: false, status: 504, error: err?.message || 'Fleet API request failed' };
  }
}

async function fetchFleetFallback() {
  const summaryPath = join(HOME, '.local', 'state', 'fleet', 'morning', 'summary.json');
  const aiUsagePath = join(HOME, '.local', 'state', 'fleet', 'ai-usage', 'summary.json');
  const pausedPath = join(HOME, '.config', 'agentkit', 'paused-providers');

  let counts = { pass: 0, warn: 0, fail: 0, other: 0 };
  let hosts = [];
  let failingOrWarningRows = [];
  let aiPools = [];
  let pausedProviders = [];
  let unreadMailTotal = 0;
  let recentMail = [];
  let heavySlotSummary = '';

  if (existsSync(summaryPath)) {
    try {
      const m = JSON.parse(readFileSync(summaryPath, 'utf8'));
      const rawCounts = m?.counts || {};
      counts = {
        pass: Number(rawCounts.pass || 0),
        warn: Number(rawCounts.warn || 0),
        fail: Number(rawCounts.fail || 0),
        other: Number(rawCounts.other || 0),
      };
      hosts = Array.isArray(m?.hosts)
        ? m.hosts.map((h) => ({
            id: h.id || h.name || '',
            status: h.status || '',
            load: h.load ?? null,
            tempC: h.tempC ?? h.temp ?? null,
            freeGb: h.freeGb ?? null,
          }))
        : [];
      const rows = Array.isArray(m?.rows) ? m.rows : [];
      failingOrWarningRows = rows
        .filter((r) => {
          const st = String(r?.status || '').toLowerCase();
          return st === 'fail' || st === 'warn' || st === 'error';
        })
        .slice(0, 25)
        .map((r) => ({
          key: r.key || '',
          host: r.host || '',
          area: r.area || '',
          status: r.status || '',
          summary: trimCleanBoundary(r.summary || r.detail || r.title || '', 180),
        }));
    } catch {
      // Non-fatal fallback read.
    }
  }

  if (existsSync(aiUsagePath)) {
    try {
      const u = JSON.parse(readFileSync(aiUsagePath, 'utf8'));
      const providers = Array.isArray(u?.providers) ? u.providers : [];
      aiPools = providers.slice(0, 12).map((p) => ({
        name: p.name || p.provider || '',
        remainingPct: p.remainingPct ?? p.remaining ?? null,
        resetsAt: p.resetsAt || '',
      }));
    } catch {
      // Non-fatal fallback read.
    }
  }

  if (existsSync(pausedPath)) {
    try {
      pausedProviders = readFileSync(pausedPath, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
    } catch {
      pausedProviders = [];
    }
  }

  const [slotRes, mailRes] = await Promise.all([
    execFileAsync(join(HOME, '.local', 'bin', 'heavy-slot'), ['status'], { encoding: 'utf8', timeout: 2000 }).catch(
      () => null,
    ),
    execFileAsync(join(HOME, '.local', 'bin', 'agent-mail'), ['unread', '--provider', 'gemini'], {
      encoding: 'utf8',
      timeout: 2000,
    }).catch(() => null),
  ]);

  if (slotRes?.stdout) {
    heavySlotSummary = slotRes.stdout.trim().split('\n').slice(0, 10).join(' | ');
  }
  if (mailRes?.stdout) {
    const lines = mailRes.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('- '));
    unreadMailTotal = lines.length;
    recentMail = lines.slice(0, 6).map((l) => trimCleanBoundary(l.slice(2), 180));
  }

  const hasLocalArtifacts =
    existsSync(summaryPath)
    || existsSync(aiUsagePath)
    || existsSync(pausedPath)
    || Boolean(slotRes?.stdout)
    || Boolean(mailRes?.stdout);

  const providers = await getProviderCapacity();

  return {
    source: hasLocalArtifacts ? 'local-fallback' : 'none',
    counts,
    hosts,
    failingOrWarningRows,
    pausedProviders: providers.paused.length ? providers.paused : pausedProviders,
    aiPools: providers.pools.length
      ? providers.pools.slice(0, 12).map((p) => ({
          engine: p.engine,
          name: p.pool,
          remainingPct: p.remainingPct,
          resetsAt: p.resetAt,
          paused: p.paused,
          recentlyReset: p.recentlyReset,
        }))
      : aiPools,
    unreadMailTotal,
    recentMail,
    heavySlotSummary,
    _providers: providers,
  };
}

export async function fetchFleetData() {
  const [ovRes, moRes, mlRes] = await Promise.all([
    callFleetApi('/v1/overview', { timeoutMs: 4000 }),
    callFleetApi('/v1/morning', { timeoutMs: 4000 }),
    callFleetApi('/v1/mail', { timeoutMs: 4000 }),
  ]);

  if (!ovRes.ok) {
    return fetchFleetFallback();
  }

  const ov = ovRes.body || {};
  const mo = moRes.ok ? moRes.body || {} : {};
  const ml = mlRes.ok ? mlRes.body || {} : {};
  const rows = Array.isArray(mo.rows) ? mo.rows : Array.isArray(ov.security?.rows) ? ov.security.rows : [];
  const providers = await getProviderCapacity({ fleetCapacity: ov.capacity || null });

  return {
    source: 'fleet-api',
    counts: ov.counts || { pass: 0, warn: 0, fail: 0, other: 0 },
    hosts: Array.isArray(ov.hosts)
      ? ov.hosts.map((h) => ({
          id: h.id || '',
          status: h.status || '',
          load: h.load1m ?? h.load ?? null,
          tempC: h.thermalC ?? h.tempC ?? null,
          freeGb: h.diskFreeGb ?? h.freeGb ?? null,
        }))
      : [],
    failingOrWarningRows: rows
      .filter((r) => {
        const st = String(r?.status || '').toLowerCase();
        return st === 'fail' || st === 'warn' || st === 'error';
      })
      .slice(0, 25)
      .map((r) => ({
        key: r.key || '',
        host: r.host || '',
        area: r.area || '',
        status: r.status || '',
        summary: trimCleanBoundary(r.summary || r.title || r.key || '', 180),
      })),
    pausedProviders: providers.paused.length
      ? providers.paused
      : Array.isArray(ov.capacity?.paused)
        ? ov.capacity.paused
        : [],
    aiPools: providers.pools.length
      ? providers.pools.slice(0, 12).map((p) => ({
          engine: p.engine,
          name: p.pool,
          remainingPct: p.remainingPct,
          resetsAt: p.resetAt,
          paused: p.paused,
          recentlyReset: p.recentlyReset,
        }))
      : Array.isArray(ov.capacity?.pools)
        ? ov.capacity.pools.slice(0, 12).map((p) => ({
            engine: p.engine || '',
            name: p.pool || p.label || p.name || '',
            remainingPct: p.remaining_pct ?? p.remainingPct ?? null,
            resetsAt: p.reset_at ?? p.resetAt ?? '',
            paused: Boolean(p.paused),
            recentlyReset: false,
          }))
        : [],
    unreadMailTotal: Number(ml.unreadTotal ?? ov.unreadMail ?? 0),
    recentMail: Array.isArray(ml.messages)
      ? ml.messages.slice(0, 6).map((m) => ({
          id: m.id || '',
          from: m.from || '',
          to: m.to || '',
          read: Boolean(m.read),
          text: trimCleanBoundary(m.text || m.body || '', 160),
        }))
      : [],
    heavySlotSummary: '',
    _providers: providers,
  };
}

export async function gatherUnifiedContext() {
  const [board, fleetRaw] = await Promise.all([
    getFederatedBoard({ includeFleet: true, includeHidden: false }),
    fetchFleetData(),
  ]);
  const { _providers, aiPools: _redundantPools, ...fleet } = fleetRaw || {};
  const providersRaw = _providers || (await getProviderCapacity());
  const providers = providersRaw
    ? {
        source: providersRaw.source,
        paused: providersRaw.paused,
        resetAlerts: providersRaw.resetAlerts,
        codex: providersRaw.codex
          ? {
              available: providersRaw.codex.available,
              remainingPct: providersRaw.codex.remainingPct,
              resetAt: providersRaw.codex.resetAt,
              recentlyReset: providersRaw.codex.recentlyReset,
              defaultModels: providersRaw.codex.defaultModels,
            }
          : null,
        pools: (providersRaw.pools || []).slice(0, 12).map((p) => ({
          engine: p.engine,
          pool: p.pool,
          remainingPct: p.remainingPct,
          resetAt: p.resetAt,
          paused: p.paused,
          recentlyReset: p.recentlyReset,
        })),
      }
    : null;

  const conversations = (board.conversations || []).map((c) => ({
    id: c.id,
    shortId: c.shortId,
    title: c.title,
    projectName: c.projectName,
    host: c.host || board.host,
    state: c.state,
    waitingReason: c.waitingReason || '',
    autoWake: Boolean(c.autoWake),
    ageMinutes: Math.round(Number(c.ageMs || 0) / 60000),
    stepsDone: c.steps?.done || 0,
    stepsTotal: c.steps?.total || 0,
    headline: c.briefing?.headline || '',
    brief: trimCleanBoundary(c.briefing?.brief || '', 260),
    needsUser: c.briefing?.needsUser || '',
    nextActionLabels: (c.briefing?.nextActions || []).map((n) => n.label),
  }));

  const relays = (board.relays || []).slice(0, 20).map((r) => ({
    id: r.id,
    fromLabel: r.fromLabel,
    targetConversationId: r.targetConversationId,
    targetTitle: r.targetTitle,
    targetHost: r.targetHost,
    status: r.status,
    reason: r.reason || '',
    message: trimCleanBoundary(r.message || '', 220),
  }));

  return {
    generatedAt: Date.now(),
    selfHost: board.host,
    hosts: board.hosts || [],
    boardCounts: board.counts || {},
    projects: (board.projects || []).map((p) => ({ name: p.name, host: p.host || board.host })),
    conversations,
    relays,
    cliAgents: (board.fleet || []).slice(0, 12),
    fleet,
    providers,
  };
}

const COMMANDER_CHAT_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    reply: { type: 'string' },
    inspectRequests: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['thread', 'job_log'] },
          conversationId: { type: 'string' },
          host: { type: 'string' },
          label: { type: 'string' },
        },
        required: ['kind'],
      },
    },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: [
              'send_to_agent',
              'relay_to_agent',
              'start_new_agent',
              'stop_agent',
              'approve_relay',
              'dismiss_relay',
              'toggle_auto_wake',
              'fleet_mail',
              'fleet_mail_ack',
              'fleet_job_kickstart',
              'fleet_snooze',
              'fleet_provider_pause',
              'fleet_morning_refresh',
              'ask_codex',
            ],
          },
          label: { type: 'string' },
          summary: { type: 'string' },
          explicitlyRequested: { type: 'boolean' },
          risk: { type: 'string', enum: ['low', 'medium', 'high'] },
          params: {
            type: 'object',
            properties: {
              conversationId: { type: 'string' },
              title: { type: 'string' },
              host: { type: 'string' },
              text: { type: 'string' },
              message: { type: 'string' },
              fromLabel: { type: 'string' },
              projectName: { type: 'string' },
              enabled: { type: 'boolean' },
              relayId: { type: 'string' },
              to: { type: 'string' },
              idsJson: { type: 'string' },
              key: { type: 'string' },
              hours: { type: 'number' },
              note: { type: 'string' },
              provider: { type: 'string' },
              paused: { type: 'boolean' },
              label: { type: 'string' },
              prompt: { type: 'string' },
              model: { type: 'string' },
              effort: { type: 'string' },
              cwd: { type: 'string' },
            },
          },
        },
        required: ['kind', 'label', 'summary', 'explicitlyRequested', 'risk', 'params'],
      },
    },
    followUps: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['reply', 'inspectRequests', 'actions', 'followUps'],
});

const DIGEST_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['nominal', 'attention', 'critical'] },
    headline: { type: 'string' },
    items: {
      type: 'array',
      items: { type: 'string' },
    },
    starterPrompts: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['status', 'headline', 'items', 'starterPrompts'],
});

function extractJsonObject(raw) {
  const cleaned = String(raw || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Commander model response did not contain JSON');
  }
  const obj = JSON.parse(cleaned.slice(start, end + 1));
  if (obj && typeof obj === 'object' && obj.structured_output && typeof obj.structured_output === 'object') {
    return obj.structured_output;
  }
  if (obj && typeof obj === 'object' && typeof obj.response === 'string' && !('reply' in obj) && !('headline' in obj)) {
    return extractJsonObject(obj.response);
  }
  return obj;
}

export function runCommanderAgy(prompt, { model, effort = 'medium', schema, timeoutSec = 40 } = {}) {
  ensureDirs();
  const timeoutMs = timeoutSec * 1000 + 8000;
  return new Promise((resolve, reject) => {
    const cliBin = process.env.AGY_CLI_BIN || (existsSync(AGY_BIN) ? AGY_BIN : 'agy');
    const pathParts = [
      dirname(process.execPath),
      join(HOME, '.local', 'bin'),
      '/opt/homebrew/bin',
      process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    ];
    const args = [
      '-p', prompt,
      '--model', model,
      ...(effort && !/(?:-low|-medium|-high|-xhigh)$/.test(model) ? ['--effort', effort] : []),
      '--disable-slash-commands',
      '--json-schema', schema,
      '--print-timeout', `${timeoutSec}s`,
      '--output-format', 'stream-json',
    ];
    const child = spawn(
      cliBin,
      args,
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
    let settled = false;

    const finishSuccess = (raw) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      setTimeout(() => {
        try { child.kill('SIGTERM'); } catch {}
      }, 1500).unref();
      try {
        resolve(extractJsonObject(raw));
      } catch (err) {
        reject(err);
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
      }, 1500).unref();
      reject(new Error(`Commander model ${model} timed out after ${timeoutSec}s`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      const str = chunk.toString('utf8');
      if (stdoutAll.length < 1024 * 1024) stdoutAll += str;
      lineBuf += str;
      let nlIdx;
      while ((nlIdx = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, nlIdx).trim();
        lineBuf = lineBuf.slice(nlIdx + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          if (ev?.event === 'result') {
            if (ev.result?.status === 'ERROR' || ev.result?.error) {
              settled = true;
              clearTimeout(timer);
              setTimeout(() => {
                try { child.kill('SIGTERM'); } catch {}
              }, 1500).unref();
              reject(new Error(ev.result?.error || 'Commander model returned an error'));
              return;
            }
            const resp = ev.result?.structured_output ?? ev.result?.response;
            if (resp !== undefined) {
              finishSuccess(typeof resp === 'string' ? resp : JSON.stringify(resp));
              return;
            }
          }
        } catch {
          // Ignore partial NDJSON lines.
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
      if (stdoutAll.trim()) {
        try {
          resolve(extractJsonObject(stdoutAll));
          return;
        } catch {
          // Fall through to error.
        }
      }
      const errText = Buffer.concat(errChunks).toString('utf8').trim();
      reject(new Error(errText || `Commander CLI exited with code ${code}`));
    });
  });
}

async function runInspectRequests(requests) {
  const cleanReqs = Array.isArray(requests) ? requests.slice(0, 3) : [];
  const results = [];
  for (const req of cleanReqs) {
    if (!req || typeof req !== 'object') continue;
    if (req.kind === 'thread' && req.conversationId) {
      const detail = await getFederatedDetail(String(req.conversationId), req.host ? String(req.host) : null).catch(
        () => null,
      );
      if (detail) {
        results.push({
          kind: 'thread',
          conversationId: detail.id,
          host: detail.host || req.host || '',
          title: detail.title,
          state: detail.state,
          waitingReason: detail.waitingReason || '',
          steps: (detail.steps?.items || []).slice(0, 10),
          recentEvents: (detail.events || []).slice(-8).map((e) => ({
            kind: e.kind,
            status: e.status,
            text: trimCleanBoundary(e.text || '', 260),
          })),
          latestReply: trimCleanBoundary(detail.briefing?.brief || detail.lastReply || '', 500),
        });
      }
    } else if (req.kind === 'job_log' && req.host && req.label) {
      const q = new URLSearchParams({
        host: String(req.host),
        label: String(req.label),
        lines: '40',
      });
      const logRes = await callFleetApi(`/v1/job-log?${q.toString()}`, { timeoutMs: 4500 });
      if (logRes.ok && logRes.body) {
        results.push({
          kind: 'job_log',
          host: String(req.host),
          label: String(req.label),
          log: trimCleanBoundary(JSON.stringify(logRes.body), 1200),
        });
      }
    }
  }
  return results;
}

function buildChatPrompt({ history, context, userText, inspectedEvidence = [], allowInspect = true }) {
  const recentHistory = (history || []).slice(-8).map((m) => ({
    role: m.role,
    text: trimCleanBoundary(m.text || '', 420),
    actions: (m.actions || []).map((a) => `${a.kind}:${a.status}:${a.label}`),
  }));

  const hasFleet = Boolean(context.fleet && context.fleet.source && context.fleet.source !== 'none');
  const codexInfo = context.providers?.codex;
  const actionGuideLines = [
    'Actions catalog:',
    '- send_to_agent: params { conversationId or title, host?, text } (wakes/prompts an Antigravity tab directly)',
    '- relay_to_agent: params { conversationId or title, host?, message, fromLabel? } (queues/auto-wakes via Agent Relay)',
    '- start_new_agent: params { projectName?, host?, text }',
    '- stop_agent: params { conversationId or title, host? }',
    '- approve_relay: params { relayId, host?, message? }',
    '- dismiss_relay: params { relayId, host? }',
    '- toggle_auto_wake: params { conversationId or title, host?, enabled }',
  ];
  if (codexInfo?.available) {
    const solSlug = codexInfo.defaultModels?.sol || 'gpt-6.2-sol';
    const astraSlug = codexInfo.defaultModels?.astra || 'gpt-6.2-astra';
    actionGuideLines.push(
      `- ask_codex: params { prompt, model? ("astra" -> ${astraSlug} | "sol" -> ${solSlug}), effort? ("low"|"medium"|"high"), cwd? } (read-only specialist help using Codex pool; ${codexInfo.remainingPct ?? '?'}% remaining)`,
    );
  }
  if (hasFleet) {
    actionGuideLines.push(
      '- fleet_mail: params { to (e.g. "mac-primary:project" or "mac-secondary"), text }',
      '- fleet_mail_ack: params { idsJson? }',
      '- fleet_job_kickstart: params { host, label }',
      '- fleet_snooze: params { key, hours, note? }',
      '- fleet_provider_pause: params { provider, paused }',
      '- fleet_morning_refresh: params {}',
    );
  }
  const actionGuide = actionGuideLines.join('\n');

  const rules = [
    'CRITICAL: DO NOT CALL ANY TOOLS. Never read files, run commands, or invoke MCP tools. Return ONE raw JSON object matching the schema.',
    'Style: ultra-concise instrument prose (max 2-3 tight bullets or 2 short sentences). Let action cards carry action details rather than repeating them. NEVER emit "..." or "…" anywhere in reply, labels, summaries, or followUps.',
    allowInspect
      ? hasFleet
        ? 'If answering accurately needs full recent events from 1-3 threads or a Fleet job log, populate inspectRequests (max 3) and leave reply brief, otherwise keep inspectRequests as [].'
        : 'If answering accurately needs full recent events from 1-3 threads, populate inspectRequests (max 3) and leave reply brief, otherwise keep inspectRequests as [].'
      : 'Detailed inspection evidence is attached below. Set inspectRequests to [] and give the full answer now.',
    'Set explicitlyRequested=true ONLY when the user explicitly asked to run/send/toggle/approve that specific action in their message; set explicitlyRequested=false for proactive suggestions.',
    'Keep actions concise (max 6), followUps crisp (2-3 items, <= 4 words each).',
    actionGuide,
  ].join('\n');

  return [
    rules,
    `Conversation history JSON: ${JSON.stringify(recentHistory)}`,
    `Unified ${hasFleet ? 'Fleet & Agents' : 'Mission Control'} context JSON: ${JSON.stringify(context)}`,
    inspectedEvidence.length ? `Inspected evidence JSON: ${JSON.stringify(inspectedEvidence)}` : '',
    `Owner message: ${userText}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function sanitizeAction(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = String(raw.kind || '').trim();
  const risk = normalizeActionRisk(kind);
  if (!risk) return null;
  const rawParams = raw.params && typeof raw.params === 'object' ? raw.params : {};
  const params = {};
  for (const [k, v] of Object.entries(rawParams)) {
    if (typeof v === 'string') {
      const clean = v.trim();
      if (clean) params[k] = clean;
    } else if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) {
      params[k] = v;
    }
  }
  return {
    id: randomUUID(),
    kind,
    label: trimCleanBoundary(raw.label || kind, 48) || kind,
    summary: trimCleanBoundary(raw.summary || raw.label || kind, 240),
    explicitlyRequested: Boolean(raw.explicitlyRequested),
    risk,
    params,
    status: 'pending',
    resultMessage: '',
    executedAt: 0,
  };
}

export async function executeActionInternal(action, { editedText = '' } = {}) {
  if (!action || !VALID_ACTION_KINDS.has(action.kind)) {
    return { status: 400, body: { ok: false, error: 'Unsupported action kind' } };
  }
  const params = { ...(action.params || {}) };
  const cleanEdit = typeof editedText === 'string' ? editedText.trim() : '';
  if (cleanEdit) {
    if (action.kind === 'send_to_agent' || action.kind === 'start_new_agent' || action.kind === 'fleet_mail') {
      params.text = cleanEdit;
    } else if (action.kind === 'relay_to_agent' || action.kind === 'approve_relay') {
      params.message = cleanEdit;
    } else if (action.kind === 'fleet_snooze') {
      params.note = cleanEdit;
    }
  }

  switch (action.kind) {
    case 'send_to_agent': {
      const text = String(params.text || params.message || '').trim();
      if (!text) return { status: 400, body: { ok: false, error: 'Prompt text is empty' } };
      const resolved = await resolveConversationByTitleOrId({
        targetConversationId: params.conversationId || '',
        targetTitle: params.title || '',
        host: params.host || null,
      });
      if (!resolved.ok) return { status: resolved.status || 404, body: { ok: false, error: resolved.error } };
      const { owner } = resolved;
      const cid = owner.detail?.id || owner.target?.id || params.conversationId;
      if (!owner.isSelf && owner.peer) {
        return proxyPeerRequest(owner.peer, `/v1/threads/${encodeURIComponent(cid)}/message`, {
          method: 'POST',
          body: { text },
          timeoutMs: 25000,
        });
      }
      const detail = owner.detail || getThreadDetail(cid);
      return sendMessageToThread(detail, text);
    }

    case 'relay_to_agent': {
      const msg = String(params.message || params.text || '').trim();
      if (!msg) return { status: 400, body: { ok: false, error: 'Relay message is empty' } };
      const resolved = await resolveConversationByTitleOrId({
        targetConversationId: params.conversationId || '',
        targetTitle: params.title || '',
        host: params.host || null,
      });
      if (!resolved.ok) return { status: resolved.status || 404, body: { ok: false, error: resolved.error } };
      const { owner } = resolved;
      const cid = owner.detail?.id || owner.target?.id || params.conversationId;
      const fromLabel = String(params.fromLabel || 'AI Commander').trim();
      if (!owner.isSelf && owner.peer) {
        return proxyPeerRequest(owner.peer, '/v1/relay', {
          method: 'POST',
          body: { targetConversationId: cid, message: msg, fromLabel, hop: 1 },
          timeoutMs: 25000,
        });
      }
      const detail = owner.detail || getThreadDetail(cid);
      const { selfName } = loadPeerConfig();
      const out = await submitLocalRelay({
        detail: detail ? { ...detail, host: selfName } : null,
        targetHost: selfName,
        fromLabel,
        message: msg,
        hop: 1,
        sendFn: sendMessageToThread,
      });
      if (out.status < 300 && out.body?.relay) {
        const r = out.body.relay;
        out.body.message = `Relay ${out.body.delivery} to ${r.targetTitle}: ${r.reason}`;
      }
      return out;
    }

    case 'start_new_agent': {
      const text = String(params.text || params.message || '').trim();
      if (!text) return { status: 400, body: { ok: false, error: 'Prompt text is empty' } };
      const targetHost = String(params.host || '').trim();
      const projectName = String(params.projectName || '').trim();
      const { selfName } = loadPeerConfig();
      if (targetHost && targetHost !== selfName) {
        const peer = findPeerByName(targetHost);
        if (!peer) return { status: 404, body: { ok: false, error: `Unknown Mac host ${targetHost}` } };
        return proxyPeerRequest(peer, '/v1/threads/new', {
          method: 'POST',
          body: { projectName, text },
          timeoutMs: 25000,
        });
      }
      return startNewThread(projectName, text);
    }

    case 'stop_agent': {
      const resolved = await resolveConversationByTitleOrId({
        targetConversationId: params.conversationId || '',
        targetTitle: params.title || '',
        host: params.host || null,
      });
      if (!resolved.ok) return { status: resolved.status || 404, body: { ok: false, error: resolved.error } };
      const { owner } = resolved;
      const cid = owner.detail?.id || owner.target?.id || params.conversationId;
      if (!owner.isSelf && owner.peer) {
        return proxyPeerRequest(owner.peer, `/v1/threads/${encodeURIComponent(cid)}/stop`, {
          method: 'POST',
          body: {},
          timeoutMs: 25000,
        });
      }
      return stopThread(owner.detail || getThreadDetail(cid));
    }

    case 'approve_relay': {
      const relayId = String(params.relayId || '').trim();
      if (!relayId) return { status: 400, body: { ok: false, error: 'Missing relayId' } };
      const owner = await resolveRelayOwner(relayId, params.host || null);
      if (!owner) return { status: 404, body: { ok: false, error: 'Relay not found' } };
      const editedMessage = String(params.message || params.text || '').trim();
      if (!owner.isSelf && owner.peer) {
        return proxyPeerRequest(owner.peer, `/v1/relay/${encodeURIComponent(relayId)}/approve`, {
          method: 'POST',
          body: editedMessage ? { text: editedMessage } : {},
          timeoutMs: 25000,
        });
      }
      return approveLocalRelay(relayId, {
        editedMessage,
        getDetailFn: getThreadDetail,
        sendFn: sendMessageToThread,
      });
    }

    case 'dismiss_relay': {
      const relayId = String(params.relayId || '').trim();
      if (!relayId) return { status: 400, body: { ok: false, error: 'Missing relayId' } };
      const owner = await resolveRelayOwner(relayId, params.host || null);
      if (!owner) return { status: 404, body: { ok: false, error: 'Relay not found' } };
      if (!owner.isSelf && owner.peer) {
        return proxyPeerRequest(owner.peer, `/v1/relay/${encodeURIComponent(relayId)}/dismiss`, {
          method: 'POST',
          body: {},
          timeoutMs: 10000,
        });
      }
      return dismissLocalRelay(relayId);
    }

    case 'toggle_auto_wake': {
      const resolved = await resolveConversationByTitleOrId({
        targetConversationId: params.conversationId || '',
        targetTitle: params.title || '',
        host: params.host || null,
      });
      if (!resolved.ok) return { status: resolved.status || 404, body: { ok: false, error: resolved.error } };
      const { owner } = resolved;
      const cid = owner.detail?.id || owner.target?.id || params.conversationId;
      const hasBool = typeof params.enabled === 'boolean';
      if (!owner.isSelf && owner.peer) {
        return proxyPeerRequest(owner.peer, `/v1/threads/${encodeURIComponent(cid)}/auto-wake`, {
          method: 'POST',
          body: hasBool ? { enabled: params.enabled } : {},
          timeoutMs: 10000,
        });
      }
      const autoWake = hasBool ? setAutoWake(cid, params.enabled) : toggleAutoWake(cid);
      const detail = owner.detail || getThreadDetail(cid);
      return {
        status: 200,
        body: {
          ok: true,
          autoWake,
          message: `${autoWake ? 'Enabled' : 'Disabled'} auto-wake for ${detail?.title || cid}`,
        },
      };
    }

    case 'fleet_mail': {
      const to = String(params.to || '').trim();
      const text = String(params.text || params.message || '').trim();
      if (!to || !text) return { status: 400, body: { ok: false, error: 'Fleet mail requires to and text' } };
      const apiRes = await callFleetApi('/v1/actions/mail', { method: 'POST', body: { to, text }, timeoutMs: 12000 });
      if (apiRes.ok) {
        return { status: 200, body: { ok: true, message: apiRes.body?.detail || `Sent agent mail to ${to}` } };
      }
      try {
        await execFileAsync(join(HOME, '.local', 'bin', 'agent-mail'), ['send', to, text], {
          encoding: 'utf8',
          timeout: 8000,
        });
        return { status: 200, body: { ok: true, message: `Sent local agent mail to ${to}` } };
      } catch (err) {
        return { status: apiRes.status || 502, body: { ok: false, error: apiRes.body?.error || err?.message || 'Agent mail failed' } };
      }
    }

    case 'fleet_mail_ack': {
      let body = { all: true };
      if (params.idsJson) {
        try {
          const parsed = JSON.parse(String(params.idsJson));
          if (Array.isArray(parsed) && parsed.length > 0) body = { ids: parsed.map(String) };
        } catch {}
      }
      const apiRes = await callFleetApi('/v1/actions/mail-ack', { method: 'POST', body, timeoutMs: 12000 });
      return {
        status: apiRes.ok ? 200 : (apiRes.status || 502),
        body: apiRes.ok ? { ok: true, message: apiRes.body?.detail || 'Acknowledged mail' } : { ok: false, error: apiRes.body?.error || apiRes.error || 'Mail ack failed' },
      };
    }

    case 'fleet_job_kickstart': {
      const host = String(params.host || '').trim().toLowerCase();
      const label = String(params.label || '').trim();
      const apiRes = await callFleetApi('/v1/actions/job-kickstart', {
        method: 'POST',
        body: { host, label },
        timeoutMs: 15000,
      });
      return {
        status: apiRes.ok ? 200 : (apiRes.status || 502),
        body: apiRes.ok ? { ok: true, message: apiRes.body?.detail || `Kickstarted ${label} on ${host}` } : { ok: false, error: apiRes.body?.error || apiRes.error || 'Job kickstart failed' },
      };
    }

    case 'fleet_snooze': {
      const key = String(params.key || '').trim();
      const hours = Number(params.hours || 24);
      const note = String(params.note || '').trim();
      const body = { key, hours, ...(note ? { note } : {}) };
      const apiRes = await callFleetApi('/v1/actions/snooze', { method: 'POST', body, timeoutMs: 12000 });
      return {
        status: apiRes.ok ? 200 : (apiRes.status || 502),
        body: apiRes.ok ? { ok: true, message: apiRes.body?.detail || `Snoozed ${key} for ${hours}h` } : { ok: false, error: apiRes.body?.error || apiRes.error || 'Snooze failed' },
      };
    }

    case 'fleet_provider_pause': {
      const provider = String(params.provider || '').trim().toLowerCase();
      const paused = Boolean(params.paused);
      const apiRes = await callFleetApi('/v1/actions/provider-pause', {
        method: 'POST',
        body: { provider, paused },
        timeoutMs: 12000,
      });
      return {
        status: apiRes.ok ? 200 : (apiRes.status || 502),
        body: apiRes.ok ? { ok: true, message: apiRes.body?.detail || `${paused ? 'Paused' : 'Resumed'} ${provider}` } : { ok: false, error: apiRes.body?.error || apiRes.error || 'Provider update failed' },
      };
    }

    case 'fleet_morning_refresh': {
      const apiRes = await callFleetApi('/v1/actions/morning-refresh', { method: 'POST', body: {}, timeoutMs: 15000 });
      return {
        status: apiRes.ok ? 200 : (apiRes.status || 502),
        body: apiRes.ok ? { ok: true, message: apiRes.body?.detail || 'Started morning audit refresh' } : { ok: false, error: apiRes.body?.error || apiRes.error || 'Morning refresh failed' },
      };
    }

    case 'ask_codex': {
      const prompt = String(params.prompt || params.text || params.message || '').trim();
      if (!prompt) return { status: 400, body: { ok: false, error: 'Codex prompt is empty' } };
      const out = await askCodexHelper({
        prompt,
        model: params.model ? String(params.model) : 'astra',
        effort: params.effort ? String(params.effort) : 'medium',
        cwd: params.cwd ? String(params.cwd) : '',
        timeoutSec: 240,
      });
      return {
        status: out.status || (out.ok ? 200 : 500),
        body: out.ok
          ? { ok: true, message: trimCleanBoundary(`${out.model}: ${out.reply}`, 1200), codex: out }
          : { ok: false, error: out.error || 'Codex request failed' },
      };
    }

    default:
      return { status: 400, body: { ok: false, error: 'Unsupported action kind' } };
  }
}

export async function sendCommanderMessage({
  text,
  routingMode,
  directDispatch,
  askFn = runCommanderAgy,
  executeFn = executeActionInternal,
} = {}) {
  const cleanText = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!cleanText || cleanText.length > 4000) {
    return { status: 400, body: { ok: false, error: 'Message must be 1..4000 characters' } };
  }

  const state = loadCommanderState();
  const effectiveRouting = routingMode === 'fast' || routingMode === 'deep' || routingMode === 'auto'
    ? routingMode
    : state.preferences.routingMode;
  const effectiveDirect = typeof directDispatch === 'boolean' ? directDispatch : state.preferences.directDispatch;

  const userMsg = {
    id: randomUUID(),
    role: 'user',
    text: trimCleanBoundary(cleanText, 4000),
    createdAt: Date.now(),
    model: '',
    modelTier: '',
    routingReason: '',
    inspectedCount: 0,
    actions: [],
    followUps: [],
  };

  const context = await gatherUnifiedContext();
  let route = chooseCommanderModel(cleanText, effectiveRouting, { hasDrilldown: false });
  const timeout1 = route.tier === 'Flash' ? 60 : 85;

  const prompt1 = buildChatPrompt({
    history: state.messages,
    context,
    userText: cleanText,
    allowInspect: true,
  });

  let parsed = await askFn(prompt1, {
    model: route.model,
    effort: route.effort,
    schema: COMMANDER_CHAT_SCHEMA,
    timeoutSec: timeout1,
  });

  let inspectedCount = 0;
  const rawReqs = Array.isArray(parsed?.inspectRequests) ? parsed.inspectRequests.slice(0, 3) : [];
  if (rawReqs.length > 0) {
    const evidence = await runInspectRequests(rawReqs);
    inspectedCount = evidence.length;
    if (evidence.length > 0) {
      route = chooseCommanderModel(cleanText, effectiveRouting, { hasDrilldown: true });
      const timeout2 = route.tier === 'Flash' ? 45 : 70;
      const prompt2 = buildChatPrompt({
        history: state.messages,
        context,
        userText: cleanText,
        inspectedEvidence: evidence,
        allowInspect: false,
      });
      parsed = await askFn(prompt2, {
        model: route.model,
        effort: route.effort,
        schema: COMMANDER_CHAT_SCHEMA,
        timeoutSec: timeout2,
      });
    }
  }

  const rawActions = Array.isArray(parsed?.actions) ? parsed.actions.slice(0, 6) : [];
  const actions = [];
  for (const rawAct of rawActions) {
    const normalized = sanitizeAction(rawAct);
    if (!normalized) continue;
    if (effectiveDirect && normalized.explicitlyRequested && normalized.risk !== 'high') {
      const res = await executeFn(normalized, {});
      if (res?.status >= 200 && res?.status < 300 && res?.body?.ok) {
        normalized.status = 'executed';
        normalized.resultMessage = trimCleanBoundary(res.body.message || 'Executed', 220);
      } else {
        normalized.status = 'failed';
        normalized.resultMessage = trimCleanBoundary(res?.body?.error || 'Execution failed', 220);
      }
      normalized.executedAt = Date.now();
    }
    actions.push(normalized);
  }

  const followUps = (Array.isArray(parsed?.followUps) ? parsed.followUps : [])
    .slice(0, 3)
    .map((f) => trimCleanBoundary(String(f || ''), 64))
    .filter(Boolean);

  const aiMsg = {
    id: randomUUID(),
    role: 'assistant',
    text: trimCleanBoundary(parsed?.reply || 'No response returned.', 3500),
    createdAt: Date.now(),
    model: route.model,
    modelTier: route.tier,
    routingReason: route.routingReason,
    inspectedCount,
    actions,
    followUps,
  };

  state.messages = [...state.messages, userMsg, aiMsg].slice(-MAX_MESSAGES);
  const saved = saveCommanderState(state);

  return {
    status: 200,
    body: {
      ok: true,
      userMessage: userMsg,
      assistantMessage: aiMsg,
      state: saved,
    },
  };
}

export async function executeCommanderAction(actionId, { editedText = '', executeFn = executeActionInternal } = {}) {
  const cleanId = String(actionId || '').trim();
  if (!cleanId) return { status: 400, body: { ok: false, error: 'Missing actionId' } };

  const state = loadCommanderState();
  let targetAction = null;
  for (const msg of state.messages) {
    if (!Array.isArray(msg.actions)) continue;
    const found = msg.actions.find((a) => a.id === cleanId);
    if (found) {
      targetAction = found;
      break;
    }
  }
  if (!targetAction) {
    return { status: 404, body: { ok: false, error: 'Commander action not found' } };
  }
  if (targetAction.status === 'executed') {
    return { status: 409, body: { ok: false, error: 'Action was already executed', action: targetAction } };
  }

  if (typeof editedText === 'string' && editedText.trim()) {
    const cleanEdit = editedText.trim();
    if (targetAction.kind === 'send_to_agent' || targetAction.kind === 'start_new_agent' || targetAction.kind === 'fleet_mail') {
      targetAction.params.text = cleanEdit;
    } else if (targetAction.kind === 'relay_to_agent' || targetAction.kind === 'approve_relay') {
      targetAction.params.message = cleanEdit;
    } else if (targetAction.kind === 'fleet_snooze') {
      targetAction.params.note = cleanEdit;
    }
  }

  const res = await executeFn(targetAction, { editedText });
  if (res?.status >= 200 && res?.status < 300 && res?.body?.ok) {
    targetAction.status = 'executed';
    const maxLen = targetAction.kind === 'ask_codex' ? 1200 : 220;
    targetAction.resultMessage = trimCleanBoundary(res.body.message || 'Executed cleanly', maxLen);
    targetAction.executedAt = Date.now();
    const saved = saveCommanderState(state);
    return { status: 200, body: { ok: true, message: targetAction.resultMessage, action: targetAction, state: saved } };
  }

  targetAction.status = 'failed';
  targetAction.resultMessage = trimCleanBoundary(res?.body?.error || 'Action execution failed', 220);
  targetAction.executedAt = Date.now();
  const saved = saveCommanderState(state);
  return {
    status: res?.status || 502,
    body: { ok: false, error: targetAction.resultMessage, action: targetAction, state: saved },
  };
}

export function dismissCommanderAction(actionId) {
  const cleanId = String(actionId || '').trim();
  const state = loadCommanderState();
  let foundAction = null;
  for (const msg of state.messages) {
    if (!Array.isArray(msg.actions)) continue;
    const found = msg.actions.find((a) => a.id === cleanId);
    if (found) {
      foundAction = found;
      break;
    }
  }
  if (!foundAction) {
    return { status: 404, body: { ok: false, error: 'Commander action not found' } };
  }
  foundAction.status = 'dismissed';
  foundAction.resultMessage = 'Skipped by user';
  foundAction.executedAt = Date.now();
  const saved = saveCommanderState(state);
  return { status: 200, body: { ok: true, message: 'Skipped action', action: foundAction, state: saved } };
}

function normalizeDigestStatus(raw, fallback = 'nominal') {
  const s = String(raw || '').trim().toLowerCase();
  return s === 'nominal' || s === 'attention' || s === 'critical' ? s : fallback;
}

function buildDeterministicDigest(context) {
  const counts = context.boardCounts || {};
  const hasFleet = Boolean(context.fleet && context.fleet.source && context.fleet.source !== 'none');
  const fleetCounts = context.fleet?.counts || {};
  const attention = (context.conversations || []).filter((c) => c.state === 'attention');
  const pendingRelays = (context.relays || []).filter((r) => r.status === 'pending');
  const resetAlerts = Array.isArray(context.providers?.resetAlerts) ? context.providers.resetAlerts : [];
  const codexInfo = context.providers?.codex;
  const items = [];
  if (attention.length > 0) {
    items.push(
      `${attention.length} ${attention.length === 1 ? 'agent waiting' : 'agents waiting'}: ${attention
        .slice(0, 2)
        .map((c) => trimCleanBoundary(c.title, 32))
        .join(', ')}`,
    );
  }
  if (pendingRelays.length > 0) {
    items.push(`${pendingRelays.length} agent ${pendingRelays.length === 1 ? 'relay awaits' : 'relays await'} review`);
  }
  if (resetAlerts.length > 0) {
    const codexReset = resetAlerts.find((r) => r.engine === 'codex');
    if (codexReset && codexInfo?.available) {
      const pct = codexReset.remainingPct !== null ? `${Math.round(codexReset.remainingPct)}%` : '100%';
      const sol = codexInfo.defaultModels?.sol || 'gpt-6.2-sol';
      const astra = codexInfo.defaultModels?.astra || 'gpt-6.2-astra';
      items.push(`Codex reset ${pct}: ${sol} / ${astra} ready`);
    } else {
      items.push(
        `Pool reset: ${resetAlerts
          .slice(0, 2)
          .map((r) => `${r.engine} ${r.remainingPct ?? 100}%`)
          .join(', ')}`,
      );
    }
  }
  if (hasFleet && (Number(fleetCounts.fail || 0) > 0 || Number(fleetCounts.warn || 0) > 0)) {
    items.push(`Fleet: ${fleetCounts.fail || 0} failing, ${fleetCounts.warn || 0} warnings`);
  }
  if (hasFleet && Number(context.fleet?.unreadMailTotal || 0) > 0) {
    items.push(`${context.fleet.unreadMailTotal} unread mail alerts`);
  }
  if (items.length === 0) {
    items.push(
      hasFleet
        ? `${counts.working || 0} working, ${fleetCounts.pass || 0} Fleet checks passing`
        : `${counts.working || 0} active threads, ${counts.idle || 0} idle`,
    );
  }
  const status =
    Number(fleetCounts.fail || 0) > 0 || attention.length > 1
      ? 'critical'
      : attention.length > 0 || pendingRelays.length > 0 || Number(fleetCounts.warn || 0) > 0
        ? 'attention'
        : 'nominal';
  return {
    status,
    headline: status === 'nominal' ? 'All systems nominal' : 'Items need attention',
    items: items.slice(0, 3),
    starterPrompts: hasFleet
      ? ['Triage waiting', 'Active agents', 'System health']
      : ['Triage waiting', 'Active agents', 'Pending relays'],
    generatedAt: Date.now(),
  };
}

export async function getExecutiveDigest({ force = false, askFn = runCommanderAgy } = {}) {
  const state = loadCommanderState();
  if (!force && state.digest?.generatedAt && Date.now() - state.digest.generatedAt < DIGEST_TTL_MS) {
    return { status: 200, body: { ok: true, digest: state.digest, state } };
  }
  const context = await gatherUnifiedContext();
  const hasFleet = Boolean(context.fleet && context.fleet.source && context.fleet.source !== 'none');
  const defaultStarters = hasFleet
    ? ['Triage waiting', 'Active agents', 'System health']
    : ['Triage waiting', 'Active agents', 'Pending relays'];
  const prompt = [
    'CRITICAL: DO NOT CALL ANY TOOLS. Return ONE JSON object: status ("nominal"|"attention"|"critical"), headline (3-6 crisp words), items (max 3 tight signal bullets, <= 10 words each), starterPrompts (3 crisp 2-4 word chips). Plain English only, NEVER use "..." or "…".',
    `Unified ${hasFleet ? 'Fleet & Agents' : 'Mission Control'} context JSON: ${JSON.stringify(context)}`,
  ].join('\n\n');

  let digest;
  const fallback = buildDeterministicDigest(context);
  try {
    const raw = await askFn(prompt, {
      model: 'gemini-3.8-flash-low',
      effort: '',
      schema: DIGEST_SCHEMA,
      timeoutSec: 30,
    });
    const items = (Array.isArray(raw?.items) ? raw.items : [])
      .slice(0, 3)
      .map((i) => trimCleanBoundary(String(i || ''), 110))
      .filter(Boolean);
    const starterPrompts = (Array.isArray(raw?.starterPrompts) ? raw.starterPrompts : [])
      .slice(0, 3)
      .map((s) => trimCleanBoundary(String(s || ''), 32))
      .filter(Boolean);
    digest = {
      status: normalizeDigestStatus(raw?.status, fallback.status),
      headline: trimCleanBoundary(raw?.headline || fallback.headline, 56),
      items: items.length ? items : fallback.items,
      starterPrompts: starterPrompts.length ? starterPrompts : defaultStarters,
      generatedAt: Date.now(),
    };
  } catch {
    digest = fallback;
  }

  state.digest = digest;
  const saved = saveCommanderState(state);
  return { status: 200, body: { ok: true, digest, state: saved } };
}

export { COMMANDER_PATH, gatherUnifiedContext as buildCommanderContext };
