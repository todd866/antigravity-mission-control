import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const STATE_DIR = join(HOME, '.local', 'state', 'agy-monitor');
const RELAY_PATH = join(STATE_DIR, 'relay.json');

export const MAX_MESSAGE_CHARS = 2000;
export const MAX_AUTO_HOPS = 2;
export const AUTO_COOLDOWN_MS = 90 * 1000;
export const AUTO_MAX_PER_HOUR = 4;
export const IDLE_THRESHOLD_SEC = 10;

const MAX_HISTORY = 60;
const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function pruneRelays(list) {
  const cutoff = Date.now() - PRUNE_AFTER_MS;
  return (Array.isArray(list) ? list : [])
    .filter((item) => {
      if (!item || typeof item !== 'object' || !item.id || !item.targetConversationId) return false;
      if (item.status !== 'pending' && Number(item.resolvedAt || item.createdAt || 0) < cutoff) {
        return false;
      }
      return true;
    })
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
    .slice(0, MAX_HISTORY);
}

export function loadRelayState() {
  const defaults = { version: 1, autoWakeIds: [], relays: [] };
  if (!existsSync(RELAY_PATH)) return defaults;
  try {
    const parsed = JSON.parse(readFileSync(RELAY_PATH, 'utf8'));
    const autoWakeIds = Array.isArray(parsed?.autoWakeIds)
      ? [...new Set(parsed.autoWakeIds.filter((x) => typeof x === 'string' && x.trim()))]
      : [];
    return {
      version: 1,
      autoWakeIds,
      relays: pruneRelays(parsed?.relays),
    };
  } catch {
    return defaults;
  }
}

export function saveRelayState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  const normalized = {
    version: 1,
    autoWakeIds: [...new Set((state?.autoWakeIds || []).filter((x) => typeof x === 'string' && x.trim()))],
    relays: pruneRelays(state?.relays),
  };
  const tmp = `${RELAY_PATH}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  renameSync(tmp, RELAY_PATH);
  return normalized;
}

export function getAutoWakeSet() {
  return new Set(loadRelayState().autoWakeIds);
}

export function isAutoWakeEnabled(conversationId) {
  if (!conversationId) return false;
  return getAutoWakeSet().has(conversationId);
}

export function setAutoWake(conversationId, enabled) {
  const state = loadRelayState();
  const next = new Set(state.autoWakeIds);
  if (enabled) next.add(conversationId);
  else next.delete(conversationId);
  state.autoWakeIds = [...next];
  saveRelayState(state);
  return next.has(conversationId);
}

export function toggleAutoWake(conversationId) {
  return setAutoWake(conversationId, !isAutoWakeEnabled(conversationId));
}

export function getLocalRelays(limit = 40) {
  return loadRelayState().relays.slice(0, Math.max(1, limit));
}

export function getRelayById(relayId) {
  if (!relayId) return null;
  return loadRelayState().relays.find((r) => r.id === relayId) || null;
}

export function formatRelayPrompt(item) {
  const sender = String(item?.fromLabel || 'Agent').trim() || 'Agent';
  const hop = Math.max(1, Number(item?.hop) || 1);
  const hopTag = hop > 1 ? ` · hop ${hop}/${MAX_AUTO_HOPS}` : '';
  const body = String(item?.message || '').replace(/\r?\n+/g, ' ').replace(/\s+/g, ' ').trim();
  return `[Agent Relay from ${sender}${hopTag}]: ${body}`;
}

/** Require at least IDLE_THRESHOLD_SEC (10s) of macOS HID idle time before auto-waking a tab. */
export function isMacSafeForAutoWake() {
  try {
    const ioregOut = execFileSync('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-r', '-d', '1'], {
      encoding: 'utf8',
      timeout: 1500,
    });
    const match = ioregOut.match(/"HIDIdleTime"\s*=\s*(\d+)/);
    if (!match) return false;
    const idleSec = Number(match[1]) / 1e9;
    return Number.isFinite(idleSec) && idleSec >= IDLE_THRESHOLD_SEC;
  } catch {
    // Fail closed so we never interrupt the owner if idle inspection errors.
    return false;
  }
}

function evaluateAutoWakePolicy({ detail, state, hop, targetConversationId, isIdleFn = isMacSafeForAutoWake }) {
  if (!state.autoWakeIds.includes(targetConversationId)) {
    return { allowed: false, reason: 'Approval required (auto-wake off)' };
  }
  if (detail.state === 'working') {
    return { allowed: false, reason: 'Target tab is currently working' };
  }
  if (hop >= MAX_AUTO_HOPS) {
    return { allowed: false, reason: 'Hop limit reached; approval required' };
  }
  const now = Date.now();
  const autoSentHistory = state.relays.filter(
    (r) =>
      r.targetConversationId === targetConversationId &&
      r.status === 'sent' &&
      r.autoDelivered === true,
  );
  const newestAutoAt = autoSentHistory.reduce((acc, r) => Math.max(acc, Number(r.resolvedAt || r.createdAt || 0)), 0);
  if (newestAutoAt > 0 && now - newestAutoAt < AUTO_COOLDOWN_MS) {
    return { allowed: false, reason: 'Rate limit reached (90s cooldown); approval required' };
  }
  const lastHourCount = autoSentHistory.filter(
    (r) => now - Number(r.resolvedAt || r.createdAt || 0) < HOUR_MS,
  ).length;
  if (lastHourCount >= AUTO_MAX_PER_HOUR) {
    return { allowed: false, reason: 'Rate limit reached (4/hour cap); approval required' };
  }
  if (!isIdleFn()) {
    return { allowed: false, reason: 'Owner active on Mac; queued for approval' };
  }
  return { allowed: true, reason: 'Auto-woke idle tab' };
}

export async function submitLocalRelay({
  detail,
  targetHost = '',
  fromConversationId = '',
  fromLabel = '',
  message = '',
  hop = 1,
  sendFn,
  isIdleFn = isMacSafeForAutoWake,
} = {}) {
  if (!detail?.id) {
    return { status: 404, body: { ok: false, error: 'Target conversation not found' } };
  }
  const cleanMsg = String(message || '').replace(/\r?\n+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleanMsg || cleanMsg.length > MAX_MESSAGE_CHARS) {
    return { status: 400, body: { ok: false, error: `Relay message must be 1..${MAX_MESSAGE_CHARS} characters` } };
  }
  const cleanFromId = String(fromConversationId || '').trim();
  if (cleanFromId && cleanFromId === detail.id) {
    return { status: 400, body: { ok: false, error: 'Cannot relay a message to the same conversation' } };
  }

  const parsedHop = Math.max(1, Math.min(10, Math.floor(Number(hop) || 1)));
  const cleanFromLabel = String(fromLabel || '').trim() || (cleanFromId ? `Tab ${cleanFromId.slice(0, 8)}` : 'External Agent');
  const state = loadRelayState();
  const policy = evaluateAutoWakePolicy({
    detail,
    state,
    hop: parsedHop,
    targetConversationId: detail.id,
    isIdleFn,
  });

  const item = {
    id: randomUUID(),
    fromConversationId: cleanFromId,
    fromLabel: cleanFromLabel.slice(0, 80),
    targetConversationId: detail.id,
    targetTitle: detail.title || detail.shortId || detail.id.slice(0, 8),
    targetHost: targetHost || detail.host || '',
    message: cleanMsg,
    hop: parsedHop,
    status: 'pending',
    autoDelivered: false,
    reason: policy.reason,
    createdAt: Date.now(),
    resolvedAt: 0,
    error: '',
  };

  if (policy.allowed && typeof sendFn === 'function') {
    const prompt = formatRelayPrompt(item);
    const res = await sendFn(detail, prompt);
    if (res?.status === 200 && res?.body?.ok) {
      item.status = 'sent';
      item.autoDelivered = true;
      item.resolvedAt = Date.now();
      saveRelayState({ ...state, relays: [item, ...state.relays] });
      return { status: 200, body: { ok: true, delivery: 'sent', relay: item } };
    }
    item.reason = res?.body?.error || 'Auto-wake send failed; queued for approval';
    item.error = res?.body?.error || '';
  }

  saveRelayState({ ...state, relays: [item, ...state.relays] });
  return { status: 202, body: { ok: true, delivery: 'queued', relay: item } };
}

export async function approveLocalRelay(relayId, { editedMessage = '', getDetailFn, sendFn } = {}) {
  const state = loadRelayState();
  const idx = state.relays.findIndex((r) => r.id === relayId);
  if (idx === -1) {
    return { status: 404, body: { ok: false, error: 'Relay not found' } };
  }
  const current = { ...state.relays[idx] };
  if (current.status !== 'pending') {
    return {
      status: 409,
      body: { ok: false, error: `Relay is already ${current.status}`, relay: current },
    };
  }
  if (typeof editedMessage === 'string' && editedMessage.trim()) {
    current.message = editedMessage.replace(/\r?\n+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE_CHARS);
  }

  const detail = typeof getDetailFn === 'function' ? getDetailFn(current.targetConversationId) : null;
  if (!detail) {
    current.error = 'Target conversation no longer exists';
    state.relays[idx] = current;
    saveRelayState(state);
    return { status: 404, body: { ok: false, error: current.error, relay: current } };
  }

  const prompt = formatRelayPrompt(current);
  const res = typeof sendFn === 'function'
    ? await sendFn(detail, prompt)
    : { status: 500, body: { ok: false, error: 'Send function unavailable' } };

  if (res?.status === 200 && res?.body?.ok) {
    current.status = 'sent';
    current.reason = 'Approved and sent';
    current.error = '';
    current.resolvedAt = Date.now();
    state.relays[idx] = current;
    saveRelayState(state);
    return { status: 200, body: { ok: true, message: `Sent relay to ${detail.title}`, relay: current } };
  }

  current.error = res?.body?.error || 'Could not deliver relay';
  state.relays[idx] = current;
  saveRelayState(state);
  return {
    status: res?.status || 502,
    body: { ...(res?.body || {}), ok: false, error: current.error, relay: current },
  };
}

export function dismissLocalRelay(relayId) {
  const state = loadRelayState();
  const idx = state.relays.findIndex((r) => r.id === relayId);
  if (idx === -1) {
    return { status: 404, body: { ok: false, error: 'Relay not found' } };
  }
  const current = { ...state.relays[idx] };
  current.status = 'dismissed';
  current.reason = 'Dismissed by user';
  current.resolvedAt = Date.now();
  state.relays[idx] = current;
  saveRelayState(state);
  return { status: 200, body: { ok: true, message: 'Dismissed relay', relay: current } };
}
