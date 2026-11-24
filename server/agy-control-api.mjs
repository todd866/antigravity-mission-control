import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { getBoardSnapshot, getConversationDigest, getThreadDetail, mutateBoardState } from '../plugin/src/state.mjs';
import { refreshSingleBriefing, scheduleBriefingRefresh } from '../plugin/src/briefing.mjs';
import {
  checkAccessibility,
  focusThread,
  sendMessageToThread,
  startNewThread,
  stopThread,
} from '../plugin/src/control.mjs';
import {
  findPeerByName,
  getFederatedBoard,
  getFederatedDetail,
  loadPeerConfig,
  proxyPeerRequest,
  resolveConversationByTitleOrId,
  resolveOwnerPeer,
  resolveRelayOwner,
} from '../plugin/src/federation.mjs';
import {
  approveLocalRelay,
  dismissLocalRelay,
  getLocalRelays,
  setAutoWake,
  submitLocalRelay,
  toggleAutoWake,
} from '../plugin/src/relay.mjs';
import {
  clearCommanderChat,
  dismissCommanderAction,
  executeCommanderAction,
  getCommanderState,
  getExecutiveDigest,
  sendCommanderMessage,
  updateCommanderSettings,
} from '../plugin/src/commander.mjs';
import { askCodexHelper, getProviderCapacity } from '../plugin/src/providers.mjs';

const HOME = homedir();
const PORT = Number(process.env.AGY_CONTROL_PORT || 8696);
const HOST = process.env.AGY_CONTROL_BIND || '127.0.0.1';
const STATE_DIR = join(HOME, '.local', 'state', 'agy-control');
const TOKEN_PATH = join(STATE_DIR, 'token');
const AUDIT_LOG_PATH = join(STATE_DIR, 'actions.jsonl');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_ACTIONS = new Set(['move', 'pin', 'hide', 'unhide_all', 'set_sort', 'reset_order']);
const VALID_DIRECTIONS = new Set(['up', 'down', 'top', 'bottom']);
const VALID_SORTS = new Set(['fixed', 'project', 'state']);

mkdirSync(STATE_DIR, { recursive: true });

function loadExpectedToken() {
  if (!existsSync(TOKEN_PATH)) {
    throw new Error(`Missing token file at ${TOKEN_PATH}`);
  }
  const tok = readFileSync(TOKEN_PATH, 'utf8').trim();
  if (tok.length < 16) {
    throw new Error(`Token at ${TOKEN_PATH} is shorter than 16 characters`);
  }
  return tok;
}

const EXPECTED_TOKEN = loadExpectedToken();

function verifyBearer(req) {
  const auth = req.headers.authorization || '';
  const xTok = req.headers['x-agy-token'] || '';
  let supplied = '';
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    supplied = auth.slice(7).trim();
  } else if (typeof xTok === 'string') {
    supplied = xTok.trim();
  }
  if (!supplied) return false;
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(EXPECTED_TOKEN, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function audit(action, meta = {}) {
  try {
    const entry = { ts: new Date().toISOString(), action, ...meta };
    appendFileSync(AUDIT_LOG_PATH, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch {
    // Keep server operational even if audit write fails.
  }
}

function scheduleLocalBriefings(conversations, selfName) {
  if (!Array.isArray(conversations)) return;
  const localOnly = conversations.filter((c) => !c.host || c.host === selfName);
  if (localOnly.length > 0) {
    scheduleBriefingRefresh(localOnly, getConversationDigest);
  }
}

function readJsonBody(req, maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const payload = `${JSON.stringify(obj)}\n`;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  const localOnly = url.searchParams.get('localOnly') === '1';
  const queryHost = url.searchParams.get('host')?.trim() || null;

  if (req.method === 'GET' && url.pathname === '/healthz') {
    const { selfName } = loadPeerConfig();
    return sendJson(res, 200, { ok: true, service: 'agy-control-api', host: selfName });
  }

  if (!verifyBearer(req)) {
    return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
  }

  try {
    if (req.method === 'GET' && url.pathname === '/v1/board') {
      const includeHidden = url.searchParams.get('includeHidden') === '1';
      const [payload, providers] = await Promise.all([
        getFederatedBoard({ includeFleet: true, includeHidden, localOnly }),
        getProviderCapacity().catch(() => null),
      ]);
      scheduleLocalBriefings(payload.conversations, payload.host);
      return sendJson(res, 200, providers ? { ...payload, providers } : payload);
    }

    if (req.method === 'GET' && url.pathname === '/v1/providers') {
      const force = url.searchParams.get('refresh') === '1';
      const providers = await getProviderCapacity({ force });
      return sendJson(res, 200, { ok: true, providers });
    }

    if (req.method === 'POST' && url.pathname === '/v1/codex/ask') {
      const body = await readJsonBody(req, 32768);
      const out = await askCodexHelper({
        prompt: typeof body.prompt === 'string' ? body.prompt : '',
        model: typeof body.model === 'string' ? body.model : 'astra',
        effort: typeof body.effort === 'string' ? body.effort : 'medium',
        cwd: typeof body.cwd === 'string' ? body.cwd : '',
        files: Array.isArray(body.files) ? body.files : [],
        timeoutSec: body.timeoutSec,
      });
      audit('codex_ask', { ok: out.ok, model: out.model || '', effort: out.effort || '' });
      return sendJson(res, out.status || (out.ok ? 200 : 500), out);
    }

    const detailMatch = url.pathname.match(/^\/v1\/threads\/([^/]+)$/);
    if (req.method === 'GET' && detailMatch) {
      const id = decodeURIComponent(detailMatch[1]);
      if (!UUID_RE.test(id)) return sendJson(res, 400, { ok: false, error: 'Invalid conversation id' });
      if (localOnly) {
        const local = getThreadDetail(id);
        if (!local) return sendJson(res, 404, { ok: false, error: 'Conversation not found' });
        const { selfName } = loadPeerConfig();
        if (local.briefingStale) scheduleBriefingRefresh([local], getConversationDigest);
        return sendJson(res, 200, { detail: { ...local, host: selfName } });
      }
      const detail = await getFederatedDetail(id, queryHost);
      if (!detail) return sendJson(res, 404, { ok: false, error: 'Conversation not found' });
      const { selfName } = loadPeerConfig();
      if (detail.briefingStale && (!detail.host || detail.host === selfName)) {
        scheduleBriefingRefresh([detail], getConversationDigest);
      }
      return sendJson(res, 200, { detail });
    }

    const briefMatch = url.pathname.match(/^\/v1\/threads\/([^/]+)\/brief$/);
    if (req.method === 'POST' && briefMatch) {
      const id = decodeURIComponent(briefMatch[1]);
      if (!UUID_RE.test(id)) return sendJson(res, 400, { ok: false, error: 'Invalid conversation id' });
      const body = await readJsonBody(req);
      const explicitHost = queryHost || (typeof body.host === 'string' ? body.host.trim() : '') || null;
      const { selfName } = loadPeerConfig();
      if (!localOnly) {
        const owner = await resolveOwnerPeer(id, explicitHost);
        if (!owner) return sendJson(res, 404, { ok: false, error: 'Conversation not found' });
        if (!owner.isSelf && owner.peer) {
          const out = await proxyPeerRequest(owner.peer, `/v1/threads/${encodeURIComponent(id)}/brief`, {
            method: 'POST',
            body: {},
            timeoutMs: 42000,
          });
          if (out.status >= 200 && out.status < 300 && out.body?.detail) {
            out.body.detail.host = owner.host;
          }
          return sendJson(res, out.status, out.body);
        }
      }
      try {
        await refreshSingleBriefing(id, getConversationDigest);
      } catch (err) {
        return sendJson(res, 502, { ok: false, error: err?.message || 'Briefing synthesis failed' });
      }
      const detail = getThreadDetail(id);
      if (!detail) return sendJson(res, 404, { ok: false, error: 'Conversation not found' });
      audit('brief', { id, title: detail.title });
      return sendJson(res, 200, { detail: { ...detail, host: selfName } });
    }

    if (req.method === 'POST' && url.pathname === '/v1/order') {
      const body = await readJsonBody(req);
      const action = typeof body.action === 'string' ? body.action : '';
      if (!VALID_ACTIONS.has(action)) {
        return sendJson(res, 400, { ok: false, error: 'Unsupported order action' });
      }
      if (body.conversationId && !UUID_RE.test(String(body.conversationId))) {
        return sendJson(res, 400, { ok: false, error: 'Invalid conversation id' });
      }
      if (body.direction && !VALID_DIRECTIONS.has(String(body.direction))) {
        return sendJson(res, 400, { ok: false, error: 'Invalid direction' });
      }
      if (body.value && action === 'set_sort' && !VALID_SORTS.has(String(body.value))) {
        return sendJson(res, 400, { ok: false, error: 'Invalid sort mode' });
      }
      const needFullList =
        !localOnly
        && (action === 'reset_order'
          || (action === 'move' && (body.direction === 'up' || body.direction === 'down' || typeof body.toIndex === 'number')));
      let items = null;
      if (needFullList) {
        const pre = await getFederatedBoard({ includeFleet: false, includeHidden: false });
        items = pre.conversations;
      }
      mutateBoardState({
        action,
        conversationId: body.conversationId,
        direction: body.direction,
        toIndex: typeof body.toIndex === 'number' ? body.toIndex : undefined,
        value: body.value,
        items,
      });
      audit('order', { action, id: body.conversationId || '' });
      const payload = await getFederatedBoard({ includeFleet: true, includeHidden: false, localOnly });
      return sendJson(res, 200, payload);
    }

    const focusMatch = url.pathname.match(/^\/v1\/threads\/([^/]+)\/focus$/);
    if (req.method === 'POST' && focusMatch) {
      const id = decodeURIComponent(focusMatch[1]);
      if (!UUID_RE.test(id)) return sendJson(res, 400, { ok: false, error: 'Invalid conversation id' });
      const body = await readJsonBody(req);
      const explicitHost = queryHost || (typeof body.host === 'string' ? body.host.trim() : '') || null;
      if (!localOnly) {
        const owner = await resolveOwnerPeer(id, explicitHost);
        if (!owner) return sendJson(res, 404, { ok: false, error: 'Conversation not found' });
        if (!owner.isSelf && owner.peer) {
          const out = await proxyPeerRequest(owner.peer, `/v1/threads/${encodeURIComponent(id)}/focus`, {
            method: 'POST',
            body: {},
            timeoutMs: 25000,
          });
          return sendJson(res, out.status, out.body);
        }
      }
      const detail = getThreadDetail(id);
      const out = await focusThread(detail);
      if (out.status === 200) audit('focus', { id, title: detail.title });
      return sendJson(res, out.status, out.body);
    }

    const stopMatch = url.pathname.match(/^\/v1\/threads\/([^/]+)\/stop$/);
    if (req.method === 'POST' && stopMatch) {
      const id = decodeURIComponent(stopMatch[1]);
      if (!UUID_RE.test(id)) return sendJson(res, 400, { ok: false, error: 'Invalid conversation id' });
      const body = await readJsonBody(req);
      const explicitHost = queryHost || (typeof body.host === 'string' ? body.host.trim() : '') || null;
      if (!localOnly) {
        const owner = await resolveOwnerPeer(id, explicitHost);
        if (!owner) return sendJson(res, 404, { ok: false, error: 'Conversation not found' });
        if (!owner.isSelf && owner.peer) {
          const out = await proxyPeerRequest(owner.peer, `/v1/threads/${encodeURIComponent(id)}/stop`, {
            method: 'POST',
            body: {},
            timeoutMs: 25000,
          });
          return sendJson(res, out.status, out.body);
        }
      }
      const detail = getThreadDetail(id);
      const out = await stopThread(detail);
      if (out.status === 200) audit('stop', { id, title: detail.title });
      return sendJson(res, out.status, out.body);
    }

    const msgMatch = url.pathname.match(/^\/v1\/threads\/([^/]+)\/message$/);
    if (req.method === 'POST' && msgMatch) {
      const id = decodeURIComponent(msgMatch[1]);
      if (!UUID_RE.test(id)) return sendJson(res, 400, { ok: false, error: 'Invalid conversation id' });
      const body = await readJsonBody(req);
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text || text.length > 8000) {
        return sendJson(res, 400, { ok: false, error: 'Message text must be 1..8000 characters' });
      }
      const explicitHost = queryHost || (typeof body.host === 'string' ? body.host.trim() : '') || null;
      if (!localOnly) {
        const owner = await resolveOwnerPeer(id, explicitHost);
        if (!owner) return sendJson(res, 404, { ok: false, error: 'Conversation not found' });
        if (!owner.isSelf && owner.peer) {
          const out = await proxyPeerRequest(owner.peer, `/v1/threads/${encodeURIComponent(id)}/message`, {
            method: 'POST',
            body: { text },
            timeoutMs: 25000,
          });
          return sendJson(res, out.status, out.body);
        }
      }
      const detail = getThreadDetail(id);
      const out = await sendMessageToThread(detail, text);
      if (out.status === 200) audit('message', { id, title: detail.title, chars: text.length });
      return sendJson(res, out.status, out.body);
    }

    if (req.method === 'POST' && url.pathname === '/v1/threads/new') {
      const body = await readJsonBody(req);
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      const projectName = typeof body.projectName === 'string' ? body.projectName.trim() : '';
      const targetHost = (queryHost || (typeof body.host === 'string' ? body.host.trim() : '') || '').trim();
      if (!text || text.length > 8000) {
        return sendJson(res, 400, { ok: false, error: 'Prompt text must be 1..8000 characters' });
      }
      if (projectName.length > 120) {
        return sendJson(res, 400, { ok: false, error: 'Project name too long' });
      }
      const { selfName } = loadPeerConfig();
      if (!localOnly && targetHost && targetHost !== selfName) {
        const peer = findPeerByName(targetHost);
        if (!peer) {
          return sendJson(res, 404, { ok: false, error: `Unknown Mac host "${targetHost}"` });
        }
        const out = await proxyPeerRequest(peer, '/v1/threads/new', {
          method: 'POST',
          body: { projectName, text },
          timeoutMs: 25000,
        });
        return sendJson(res, out.status, out.body);
      }
      const out = await startNewThread(projectName, text);
      if (out.status === 200) audit('new_thread', { project: projectName || '', chars: text.length });
      return sendJson(res, out.status, out.body);
    }

    if (req.method === 'GET' && url.pathname === '/v1/relay') {
      const { selfName } = loadPeerConfig();
      const targetConv = url.searchParams.get('conversationId')?.trim() || '';
      const relayIdFilter = url.searchParams.get('relayId')?.trim() || '';
      let relays = localOnly
        ? getLocalRelays(40).map((r) => ({ ...r, targetHost: r.targetHost || selfName }))
        : ((await getFederatedBoard({ includeFleet: false, includeHidden: false })).relays || []);
      if (relayIdFilter) {
        relays = relays.filter((r) => r.id === relayIdFilter);
      } else if (targetConv) {
        relays = relays.filter((r) => r.targetConversationId === targetConv);
      }
      return sendJson(res, 200, { ok: true, relays });
    }

    if (req.method === 'POST' && url.pathname === '/v1/relay') {
      const body = await readJsonBody(req);
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      const targetConversationId = typeof body.targetConversationId === 'string' ? body.targetConversationId.trim() : '';
      const targetTitle = typeof body.targetTitle === 'string' ? body.targetTitle.trim() : '';
      const explicitHost = queryHost || (typeof body.host === 'string' ? body.host.trim() : '') || null;
      const fromConversationId = typeof body.fromConversationId === 'string' ? body.fromConversationId.trim() : '';
      const fromLabel = typeof body.fromLabel === 'string' ? body.fromLabel.trim() : '';
      const hop = Number.isFinite(Number(body.hop)) ? Number(body.hop) : 1;

      if (!message || message.length > 2000) {
        return sendJson(res, 400, { ok: false, error: 'Relay message must be 1..2000 characters' });
      }

      if (localOnly) {
        if (!UUID_RE.test(targetConversationId)) {
          return sendJson(res, 400, { ok: false, error: 'Invalid targetConversationId' });
        }
        const { selfName } = loadPeerConfig();
        const detail = getThreadDetail(targetConversationId);
        const out = await submitLocalRelay({
          detail: detail ? { ...detail, host: selfName } : null,
          targetHost: selfName,
          fromConversationId,
          fromLabel,
          message,
          hop,
          sendFn: sendMessageToThread,
        });
        if (out.status < 300) {
          audit('relay_submit', {
            id: out.body?.relay?.id || '',
            targetId: targetConversationId,
            delivery: out.body?.delivery || '',
          });
        }
        return sendJson(res, out.status, out.body);
      }

      const resolved = await resolveConversationByTitleOrId({
        targetConversationId,
        targetTitle,
        host: explicitHost,
      });
      if (!resolved.ok) {
        return sendJson(res, resolved.status, {
          ok: false,
          error: resolved.error,
          ...(resolved.matches ? { matches: resolved.matches } : {}),
        });
      }

      const { owner } = resolved;
      const resolvedId = owner.detail?.id || owner.target?.id || targetConversationId;
      if (!owner.isSelf && owner.peer) {
        const out = await proxyPeerRequest(owner.peer, '/v1/relay', {
          method: 'POST',
          body: {
            targetConversationId: resolvedId,
            message,
            fromConversationId,
            fromLabel,
            hop,
          },
          timeoutMs: 25000,
        });
        if (out.body?.relay && !out.body.relay.targetHost) {
          out.body.relay.targetHost = owner.host;
        }
        return sendJson(res, out.status, out.body);
      }

      const { selfName } = loadPeerConfig();
      const detail = owner.detail || getThreadDetail(resolvedId);
      const out = await submitLocalRelay({
        detail: detail ? { ...detail, host: selfName } : null,
        targetHost: selfName,
        fromConversationId,
        fromLabel,
        message,
        hop,
        sendFn: sendMessageToThread,
      });
      if (out.status < 300) {
        audit('relay_submit', {
          id: out.body?.relay?.id || '',
          targetId: resolvedId,
          delivery: out.body?.delivery || '',
        });
      }
      return sendJson(res, out.status, out.body);
    }

    const relayApproveMatch = url.pathname.match(/^\/v1\/relay\/([^/]+)\/approve$/);
    if (req.method === 'POST' && relayApproveMatch) {
      const id = decodeURIComponent(relayApproveMatch[1]);
      if (!UUID_RE.test(id)) return sendJson(res, 400, { ok: false, error: 'Invalid relay id' });
      const body = await readJsonBody(req);
      const editedText = typeof body.text === 'string' ? body.text.trim() : '';
      const explicitHost = queryHost || (typeof body.host === 'string' ? body.host.trim() : '') || null;

      if (!localOnly) {
        const owner = await resolveRelayOwner(id, explicitHost);
        if (!owner) return sendJson(res, 404, { ok: false, error: 'Relay not found' });
        if (!owner.isSelf && owner.peer) {
          const out = await proxyPeerRequest(owner.peer, `/v1/relay/${encodeURIComponent(id)}/approve`, {
            method: 'POST',
            body: editedText ? { text: editedText } : {},
            timeoutMs: 25000,
          });
          return sendJson(res, out.status, out.body);
        }
      }

      const out = await approveLocalRelay(id, {
        editedMessage: editedText,
        getDetailFn: getThreadDetail,
        sendFn: sendMessageToThread,
      });
      if (out.status === 200) audit('relay_approve', { id });
      return sendJson(res, out.status, out.body);
    }

    const relayDismissMatch = url.pathname.match(/^\/v1\/relay\/([^/]+)\/dismiss$/);
    if (req.method === 'POST' && relayDismissMatch) {
      const id = decodeURIComponent(relayDismissMatch[1]);
      if (!UUID_RE.test(id)) return sendJson(res, 400, { ok: false, error: 'Invalid relay id' });
      const body = await readJsonBody(req);
      const explicitHost = queryHost || (typeof body.host === 'string' ? body.host.trim() : '') || null;

      if (!localOnly) {
        const owner = await resolveRelayOwner(id, explicitHost);
        if (!owner) return sendJson(res, 404, { ok: false, error: 'Relay not found' });
        if (!owner.isSelf && owner.peer) {
          const out = await proxyPeerRequest(owner.peer, `/v1/relay/${encodeURIComponent(id)}/dismiss`, {
            method: 'POST',
            body: {},
            timeoutMs: 10000,
          });
          return sendJson(res, out.status, out.body);
        }
      }

      const out = dismissLocalRelay(id);
      if (out.status === 200) audit('relay_dismiss', { id });
      return sendJson(res, out.status, out.body);
    }

    const autoWakeMatch = url.pathname.match(/^\/v1\/threads\/([^/]+)\/auto-wake$/);
    if (req.method === 'POST' && autoWakeMatch) {
      const id = decodeURIComponent(autoWakeMatch[1]);
      if (!UUID_RE.test(id)) return sendJson(res, 400, { ok: false, error: 'Invalid conversation id' });
      const body = await readJsonBody(req);
      const explicitHost = queryHost || (typeof body.host === 'string' ? body.host.trim() : '') || null;
      const hasExplicitBool = typeof body.enabled === 'boolean';

      if (!localOnly) {
        const owner = await resolveOwnerPeer(id, explicitHost);
        if (!owner) return sendJson(res, 404, { ok: false, error: 'Conversation not found' });
        if (!owner.isSelf && owner.peer) {
          const out = await proxyPeerRequest(owner.peer, `/v1/threads/${encodeURIComponent(id)}/auto-wake`, {
            method: 'POST',
            body: hasExplicitBool ? { enabled: body.enabled } : {},
            timeoutMs: 10000,
          });
          return sendJson(res, out.status, out.body);
        }
      }

      const detail = getThreadDetail(id);
      if (!detail) return sendJson(res, 404, { ok: false, error: 'Conversation not found' });
      const autoWake = hasExplicitBool ? setAutoWake(id, body.enabled) : toggleAutoWake(id);
      audit('auto_wake', { id, autoWake });
      return sendJson(res, 200, {
        ok: true,
        conversationId: id,
        autoWake,
        message: `${autoWake ? 'Enabled' : 'Disabled'} auto-wake for ${detail.title}`,
      });
    }

    if (req.method === 'GET' && url.pathname === '/v1/ai/state') {
      return sendJson(res, 200, { ok: true, state: getCommanderState() });
    }

    if (req.method === 'GET' && url.pathname === '/v1/ai/digest') {
      const force = url.searchParams.get('refresh') === '1';
      const out = await getExecutiveDigest({ force });
      return sendJson(res, out.status, out.body);
    }

    if (req.method === 'POST' && url.pathname === '/v1/ai/chat') {
      const body = await readJsonBody(req);
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      const routingMode = typeof body.routingMode === 'string' ? body.routingMode : undefined;
      const directDispatch = typeof body.directDispatch === 'boolean' ? body.directDispatch : undefined;
      const out = await sendCommanderMessage({ text, routingMode, directDispatch });
      if (out.status === 200) {
        audit('ai_chat', {
          chars: text.length,
          tier: out.body?.assistantMessage?.modelTier || '',
          actions: (out.body?.assistantMessage?.actions || []).length,
        });
      }
      return sendJson(res, out.status, out.body);
    }

    const aiExecMatch = url.pathname.match(/^\/v1\/ai\/actions\/([^/]+)\/execute$/);
    if (req.method === 'POST' && aiExecMatch) {
      const id = decodeURIComponent(aiExecMatch[1]);
      if (!UUID_RE.test(id)) return sendJson(res, 400, { ok: false, error: 'Invalid action id' });
      const body = await readJsonBody(req);
      const editedText = typeof body.editedText === 'string' ? body.editedText : '';
      const out = await executeCommanderAction(id, { editedText });
      audit('ai_action_execute', { id, ok: out.status === 200 });
      return sendJson(res, out.status, out.body);
    }

    const aiDismissMatch = url.pathname.match(/^\/v1\/ai\/actions\/([^/]+)\/dismiss$/);
    if (req.method === 'POST' && aiDismissMatch) {
      const id = decodeURIComponent(aiDismissMatch[1]);
      if (!UUID_RE.test(id)) return sendJson(res, 400, { ok: false, error: 'Invalid action id' });
      const out = dismissCommanderAction(id);
      if (out.status === 200) audit('ai_action_dismiss', { id });
      return sendJson(res, out.status, out.body);
    }

    if (req.method === 'POST' && url.pathname === '/v1/ai/settings') {
      const body = await readJsonBody(req);
      const routingMode = typeof body.routingMode === 'string' ? body.routingMode : undefined;
      const directDispatch = typeof body.directDispatch === 'boolean' ? body.directDispatch : undefined;
      const state = updateCommanderSettings({ routingMode, directDispatch });
      return sendJson(res, 200, { ok: true, state });
    }

    if (req.method === 'POST' && url.pathname === '/v1/ai/clear') {
      const state = clearCommanderChat();
      audit('ai_clear', {});
      return sendJson(res, 200, { ok: true, state });
    }

    return sendJson(res, 404, { ok: false, error: 'Not found' });
  } catch (err) {
    return sendJson(res, err?.httpStatus || 500, { ok: false, error: err?.message || 'Internal error' });
  }
});

function refreshBriefingsTick() {
  checkAccessibility().catch(() => {});
  try {
    const snap = getBoardSnapshot({ includeFleet: false, includeHidden: false });
    scheduleBriefingRefresh(snap.conversations, getConversationDigest);
  } catch {
    // Ignore transient snapshot errors on background tick.
  }
}

server.listen(PORT, HOST, () => {
  console.log(`agy-control-api listening on http://${HOST}:${PORT}`);
  checkAccessibility().catch(() => {});
  setTimeout(refreshBriefingsTick, 1500).unref();
  setInterval(refreshBriefingsTick, 25000).unref();
});
