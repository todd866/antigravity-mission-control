import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { getBoardSnapshot, getThreadDetail, orderCombinedConversations } from './state.mjs';
import { getMacAccessibilityOk } from './control.mjs';
import { getRelayById } from './relay.mjs';

const HOME = homedir();
const DEFAULT_PEERS_PATH = join(HOME, '.config', 'agy-control', 'peers.json');
const DEFAULT_TOKEN_PATH = join(HOME, '.local', 'state', 'agy-control', 'token');
const PROJECTS_DIR = join(HOME, '.gemini', 'config', 'projects');
const REMOTE_CONTROL_URL = 'https://antigravity.google.com';

function expandHome(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (trimmed === '~') return HOME;
  if (trimmed.startsWith('~/')) return join(HOME, trimmed.slice(2));
  return trimmed;
}

function defaultSelfName() {
  return (process.env.AGY_CONTROL_HOST || hostname().replace(/\.local$/, '') || 'local').trim();
}

export function loadPeerConfig() {
  const cfgPath = expandHome(process.env.AGY_CONTROL_PEERS_FILE || '') || DEFAULT_PEERS_PATH;
  const fallback = { selfName: defaultSelfName(), peers: [] };
  if (!existsSync(cfgPath)) return fallback;
  try {
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf8'));
    const selfName = (typeof parsed?.selfName === 'string' && parsed.selfName.trim())
      ? parsed.selfName.trim()
      : fallback.selfName;
    const peers = Array.isArray(parsed?.peers)
      ? parsed.peers
          .filter((p) => p && typeof p.name === 'string' && typeof p.url === 'string' && p.name.trim() && p.url.trim())
          .map((p) => ({
            name: p.name.trim(),
            url: p.url.trim().replace(/\/+$/, ''),
            token: typeof p.token === 'string' ? p.token.trim() : '',
            tokenFile: expandHome(p.tokenFile || '') || DEFAULT_TOKEN_PATH,
          }))
          .filter((p) => p.name !== selfName)
      : [];
    return { selfName, peers };
  } catch {
    return fallback;
  }
}

export function findPeerByName(name) {
  if (!name) return null;
  const { peers } = loadPeerConfig();
  return peers.find((p) => p.name === name) || null;
}

function readPeerToken(peer) {
  if (peer?.token) return peer.token;
  const path = peer?.tokenFile || DEFAULT_TOKEN_PATH;
  if (!existsSync(path)) return '';
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

export function listLocalProjects(selfName = loadPeerConfig().selfName) {
  const list = [];
  if (!existsSync(PROJECTS_DIR)) return list;
  for (const fn of readdirSync(PROJECTS_DIR)) {
    if (!fn.endsWith('.json')) continue;
    try {
      const p = JSON.parse(readFileSync(join(PROJECTS_DIR, fn), 'utf8'));
      if (!p?.id || p.id === 'default-cli-project' || p.sidecar) continue;
      list.push({ id: p.id, name: p.name || p.id, host: selfName });
    } catch {
      // Skip invalid project config.
    }
  }
  list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
}

export async function proxyPeerRequest(peer, pathWithQuery, { method = 'POST', body = undefined, timeoutMs = 15000 } = {}) {
  if (!peer?.url) {
    return { status: 404, body: { ok: false, error: 'Unknown peer host' } };
  }
  const token = readPeerToken(peer);
  if (!token) {
    return { status: 500, body: { ok: false, error: `Missing auth token for peer ${peer.name}` } };
  }
  const sep = pathWithQuery.includes('?') ? '&' : '?';
  const targetUrl = `${peer.url}${pathWithQuery}${sep}localOnly=1`;
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
  };
  let payload;
  if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
    headers['Content-Type'] = 'application/json';
    payload = typeof body === 'string' ? body : JSON.stringify(body);
  }
  try {
    const resp = await fetch(targetUrl, {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await resp.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { ok: resp.ok, error: text || `HTTP ${resp.status}` };
    }
    return { status: resp.status, body: parsed };
  } catch (err) {
    return {
      status: 502,
      body: { ok: false, error: `Peer ${peer.name} unreachable (${err?.message || 'timeout'})` },
    };
  }
}

async function fetchPeerBoard(peer, { includeHidden = false } = {}) {
  const res = await proxyPeerRequest(peer, `/v1/board?includeHidden=${includeHidden ? 1 : 0}`, {
    method: 'GET',
    timeoutMs: 5000,
  });
  if (res.status < 200 || res.status >= 300 || !Array.isArray(res.body?.conversations)) {
    return {
      hostInfo: {
        name: peer.name,
        isSelf: false,
        online: false,
        macAccessibility: false,
        conversationCount: 0,
        error: res.body?.error || `HTTP ${res.status}`,
      },
      conversations: [],
      projects: [],
      fleet: [],
      relays: [],
    };
  }
  const conversations = res.body.conversations.map((c) => ({ ...c, host: peer.name }));
  const projects = Array.isArray(res.body.projects)
    ? res.body.projects.map((p) => ({ ...p, host: p.host || peer.name }))
    : [];
  const fleet = Array.isArray(res.body.fleet) ? res.body.fleet : [];
  const relays = Array.isArray(res.body.relays)
    ? res.body.relays.map((r) => ({ ...r, targetHost: r.targetHost || peer.name }))
    : [];
  return {
    hostInfo: {
      name: peer.name,
      isSelf: false,
      online: true,
      macAccessibility: Boolean(res.body.macAccessibility ?? true),
      conversationCount: conversations.length,
    },
    conversations,
    projects,
    fleet,
    relays,
  };
}

function mergeRelays(localRelays, peerResults, selfName) {
  const seen = new Set();
  const merged = [];
  for (const r of localRelays || []) {
    if (!r?.id || seen.has(r.id)) continue;
    seen.add(r.id);
    merged.push({ ...r, targetHost: r.targetHost || selfName });
  }
  for (const pr of peerResults || []) {
    for (const r of pr.relays || []) {
      if (!r?.id || seen.has(r.id)) continue;
      seen.add(r.id);
      merged.push(r);
    }
  }
  merged.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  return merged.slice(0, 60);
}

export async function getFederatedBoard({
  includeDetailId = null,
  includeFleet = true,
  includeHidden = false,
  localOnly = false,
} = {}) {
  const cfg = loadPeerConfig();
  const selfName = cfg.selfName;
  const localSnap = getBoardSnapshot({ includeDetailId, includeFleet, includeHidden });
  const localConvs = localSnap.conversations.map((c) => ({ ...c, host: selfName }));
  const localProjects = listLocalProjects(selfName);
  const selfHostInfo = {
    name: selfName,
    isSelf: true,
    online: true,
    macAccessibility: getMacAccessibilityOk(),
    conversationCount: localConvs.length,
  };

  if (localOnly || cfg.peers.length === 0) {
    const localRelays = mergeRelays(localSnap.relays || [], [], selfName);
    const localCounts = {
      ...localSnap.counts,
      pendingRelays: localRelays.filter((r) => r.status === 'pending').length,
    };
    return {
      ...localSnap,
      counts: localCounts,
      conversations: localConvs,
      projects: localProjects,
      relays: localRelays,
      hosts: [selfHostInfo],
      host: selfName,
      macAccessibility: getMacAccessibilityOk(),
      remoteControlUrl: REMOTE_CONTROL_URL,
    };
  }

  const peerResults = await Promise.all(
    cfg.peers.map((peer) => fetchPeerBoard(peer, { includeHidden })),
  );

  const seenIds = new Set();
  const combined = [];
  for (const c of localConvs) {
    seenIds.add(c.id);
    combined.push(c);
  }
  for (const pr of peerResults) {
    for (const c of pr.conversations) {
      if (!seenIds.has(c.id)) {
        seenIds.add(c.id);
        combined.push(c);
      }
    }
  }

  const unified = orderCombinedConversations(combined, includeHidden);
  const mergedRelays = mergeRelays(localSnap.relays || [], peerResults, selfName);
  unified.counts.pendingRelays = mergedRelays.filter((r) => r.status === 'pending').length;

  const mergedProjects = [...localProjects];
  for (const pr of peerResults) {
    mergedProjects.push(...pr.projects);
  }
  mergedProjects.sort((a, b) => (a.name || '').localeCompare(b.name || '') || (a.host || '').localeCompare(b.host || ''));

  const seenFleet = new Set();
  const mergedFleet = [];
  if (includeFleet) {
    for (const f of [...localSnap.fleet, ...peerResults.flatMap((r) => r.fleet)]) {
      const key = `${f.mac}::${f.agent}::${f.project}::${f.runtime}`;
      if (!seenFleet.has(key)) {
        seenFleet.add(key);
        mergedFleet.push(f);
      }
    }
  }

  return {
    generatedAt: Date.now(),
    sortMode: unified.sortMode,
    counts: unified.counts,
    conversations: unified.conversations,
    fleet: mergedFleet,
    relays: mergedRelays,
    projects: mergedProjects,
    hosts: [selfHostInfo, ...peerResults.map((r) => r.hostInfo)],
    host: selfName,
    macAccessibility: getMacAccessibilityOk(),
    remoteControlUrl: REMOTE_CONTROL_URL,
    ...(localSnap.lastAction ? { lastAction: localSnap.lastAction } : {}),
  };
}

export async function resolveOwnerPeer(conversationId, explicitHost = null) {
  const cfg = loadPeerConfig();
  if (explicitHost) {
    if (explicitHost === cfg.selfName) {
      const detail = getThreadDetail(conversationId);
      return detail ? { isSelf: true, peer: null, host: cfg.selfName, detail: { ...detail, host: cfg.selfName } } : null;
    }
    const peer = cfg.peers.find((p) => p.name === explicitHost);
    if (peer) {
      return { isSelf: false, peer, host: peer.name, detail: null };
    }
  }

  const localDetail = getThreadDetail(conversationId);
  if (localDetail) {
    return { isSelf: true, peer: null, host: cfg.selfName, detail: { ...localDetail, host: cfg.selfName } };
  }

  if (cfg.peers.length === 0) return null;
  const checks = await Promise.all(
    cfg.peers.map(async (peer) => {
      const res = await proxyPeerRequest(peer, `/v1/threads/${encodeURIComponent(conversationId)}`, {
        method: 'GET',
        timeoutMs: 2500,
      });
      if (res.status >= 200 && res.status < 300 && res.body?.detail) {
        return { isSelf: false, peer, host: peer.name, detail: { ...res.body.detail, host: peer.name } };
      }
      return null;
    }),
  );
  return checks.find(Boolean) || null;
}

export async function getFederatedDetail(conversationId, explicitHost = null) {
  const owner = await resolveOwnerPeer(conversationId, explicitHost);
  if (!owner) return null;
  if (owner.detail) return owner.detail;
  const res = await proxyPeerRequest(owner.peer, `/v1/threads/${encodeURIComponent(conversationId)}`, {
    method: 'GET',
    timeoutMs: 3500,
  });
  if (res.status >= 200 && res.status < 300 && res.body?.detail) {
    return { ...res.body.detail, host: owner.host };
  }
  return null;
}

export async function resolveConversationByTitleOrId({ targetConversationId = '', targetTitle = '', host = null } = {}) {
  const rawId = String(targetConversationId || '').trim();
  const rawTitle = String(targetTitle || '').trim();
  const explicitHost = host ? String(host).trim() : null;
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (uuidRe.test(rawId)) {
    const owner = await resolveOwnerPeer(rawId, explicitHost);
    if (owner) return { ok: true, status: 200, owner };
    return { ok: false, status: 404, error: `Conversation ${rawId} not found` };
  }

  const query = (rawTitle || rawId).trim();
  if (!query) {
    return { ok: false, status: 400, error: 'Provide targetConversationId or targetTitle' };
  }

  const snap = await getFederatedBoard({ includeFleet: false, includeHidden: true });
  const pool = explicitHost
    ? snap.conversations.filter((c) => c.host === explicitHost)
    : snap.conversations;
  const needle = query.toLowerCase();

  let matches = pool.filter(
    (c) => c.id.toLowerCase() === needle || c.shortId.toLowerCase() === needle || c.id.toLowerCase().startsWith(needle),
  );
  if (matches.length === 0) {
    matches = pool.filter((c) => String(c.title || '').trim().toLowerCase() === needle);
  }
  if (matches.length === 0) {
    matches = pool.filter((c) => String(c.title || '').toLowerCase().includes(needle));
  }

  if (matches.length === 0) {
    return { ok: false, status: 404, error: `No conversation matching "${query}"` };
  }
  if (matches.length > 1) {
    const names = matches.slice(0, 5).map((m) => `${m.title} [${m.host || snap.host}:${m.shortId}]`).join(', ');
    return {
      ok: false,
      status: 409,
      error: `Multiple conversations match "${query}": ${names}`,
      matches: matches.slice(0, 8).map((m) => ({ id: m.id, title: m.title, host: m.host || snap.host })),
    };
  }

  const target = matches[0];
  const owner = await resolveOwnerPeer(target.id, target.host || explicitHost);
  if (!owner) {
    return { ok: false, status: 404, error: `Conversation ${target.id} not found` };
  }
  return { ok: true, status: 200, owner: { ...owner, target } };
}

export async function resolveRelayOwner(relayId, explicitHost = null) {
  const cfg = loadPeerConfig();
  if (explicitHost) {
    if (explicitHost === cfg.selfName) {
      const local = getRelayById(relayId);
      return local ? { isSelf: true, peer: null, host: cfg.selfName, relay: local } : null;
    }
    const peer = cfg.peers.find((p) => p.name === explicitHost);
    if (peer) return { isSelf: false, peer, host: peer.name, relay: null };
  }

  const local = getRelayById(relayId);
  if (local) {
    return { isSelf: true, peer: null, host: cfg.selfName, relay: local };
  }

  if (cfg.peers.length === 0) return null;
  const checks = await Promise.all(
    cfg.peers.map(async (peer) => {
      const res = await proxyPeerRequest(peer, '/v1/relay?localOnly=1', { method: 'GET', timeoutMs: 2500 });
      const found = Array.isArray(res.body?.relays) ? res.body.relays.find((r) => r.id === relayId) : null;
      return found ? { isSelf: false, peer, host: peer.name, relay: { ...found, targetHost: found.targetHost || peer.name } } : null;
    }),
  );
  return checks.find(Boolean) || null;
}
