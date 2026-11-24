import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { getBoardSnapshot, getConversationDigest, getThreadDetail, mutateBoardState } from './src/state.mjs';
import { refreshSingleBriefing, scheduleBriefingRefresh } from './src/briefing.mjs';
import { focusThread, sendMessageToThread, startNewThread, stopThread } from './src/control.mjs';
import {
  findPeerByName,
  getFederatedBoard,
  getFederatedDetail,
  loadPeerConfig,
  proxyPeerRequest,
  resolveConversationByTitleOrId,
  resolveOwnerPeer,
  resolveRelayOwner,
} from './src/federation.mjs';
import {
  approveLocalRelay,
  dismissLocalRelay,
  setAutoWake,
  submitLocalRelay,
  toggleAutoWake,
} from './src/relay.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_URI = 'ui://mission-control/app.html';
const APP_HTML_PATH = join(__dirname, 'dist', 'app.html');

function readAppHtml() {
  if (!existsSync(APP_HTML_PATH)) {
    throw new Error(`Missing built UI bundle at ${APP_HTML_PATH}`);
  }
  return readFileSync(APP_HTML_PATH, 'utf8');
}

function scheduleLocalBriefings(conversations, selfName) {
  if (!Array.isArray(conversations)) return;
  const localOnly = conversations.filter((c) => !c.host || c.host === selfName);
  if (localOnly.length > 0) {
    scheduleBriefingRefresh(localOnly, getConversationDigest);
  }
}

function formatSummaryText(snap) {
  const { counts, conversations } = snap;
  const hostTag = (snap.hosts?.length || 0) > 1 ? ` · ${snap.hosts.map((h) => h.name).join('+')}` : '';
  const header = `Mission Control (${snap.sortMode}${hostTag}): ${counts.total} open — ${counts.attention} waiting, ${counts.working} working, ${counts.bg} background, ${counts.unread} unread, ${counts.idle} idle`;
  const lines = conversations.slice(0, 24).map((c) => {
    const step = c.steps ? ` [${c.steps.done}/${c.steps.total}]` : '';
    const macTag = (snap.hosts?.length || 0) > 1 && c.host ? `[${c.host}] ` : '';
    const detail = c.waitingReason || c.briefing?.headline || (c.focusIsCurrentTurn ? c.focus : '') || c.lastReply || '';
    return `#${c.slot} ${macTag}[${c.state.toUpperCase()}] ${c.title} (${c.projectName})${step}${detail ? ` — ${detail}` : ''}`;
  });
  return [header, ...lines].join('\n');
}

const server = new McpServer({
  name: 'mission-control',
  version: '1.2.0',
});

registerAppResource(
  server,
  'Mission Control UI',
  APP_URI,
  {
    description: 'Fixed-order instrument cockpit for Antigravity conversations across Macs and fleet CLI agents.',
    mimeType: RESOURCE_MIME_TYPE,
    _meta: {
      ui: {
        prefersBorder: false,
      },
    },
  },
  async () => ({
    contents: [
      {
        uri: APP_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: readAppHtml(),
        _meta: {
          ui: {
            prefersBorder: false,
          },
        },
      },
    ],
  }),
);

registerAppTool(
  server,
  'open_mission_control',
  {
    title: 'Mission Control',
    description: 'Open the fixed-order Mission Control cockpit showing live Antigravity conversations across connected Macs, AI briefings, next-step suggestions, checklists, and fleet CLI agents.',
    inputSchema: {
      filter: z.enum(['all', 'attention', 'working', 'bg', 'unread', 'idle']).optional(),
      selectedId: z.string().optional(),
    },
    _meta: {
      ui: { resourceUri: APP_URI },
      'com.google.antigravity/ui': {
        entrypoints: [
          { type: 'global', title: 'Mission Control' },
          { type: 'aux_pane', title: 'Mission Control' },
        ],
      },
    },
  },
  async (args = {}) => {
    const snap = await getFederatedBoard({
      includeDetailId: args?.selectedId || null,
      includeFleet: true,
      includeHidden: false,
    });
    scheduleLocalBriefings(snap.conversations, snap.host);
    const structured = {
      ...snap,
      initialFilter: args?.filter || 'all',
      selectedId: args?.selectedId || null,
    };
    return {
      content: [{ type: 'text', text: formatSummaryText(snap) }],
      structuredContent: structured,
    };
  },
);

server.registerTool(
  'poll_board',
  {
    title: 'Poll Mission Control Board',
    description: 'App-only refresh returning current fixed-order Antigravity conversation telemetry across Macs.',
    inputSchema: {
      selectedId: z.string().nullable().optional(),
      includeFleet: z.boolean().optional(),
    },
    _meta: {
      ui: { visibility: ['app'] },
    },
  },
  async (args = {}) => {
    const snap = await getFederatedBoard({
      includeDetailId: args?.selectedId || null,
      includeFleet: args?.includeFleet !== false,
      includeHidden: false,
    });
    scheduleLocalBriefings(snap.conversations, snap.host);
    return {
      content: [{ type: 'text', text: `${snap.counts.total} conversations` }],
      structuredContent: snap,
    };
  },
);

server.registerTool(
  'get_thread_detail',
  {
    title: 'Get Conversation Detail',
    description: 'App-only inspection of one conversation briefing, checklist, active subagents, reply, and recent events.',
    inputSchema: {
      conversationId: z.string(),
      host: z.string().optional(),
    },
    _meta: {
      ui: { visibility: ['app'] },
    },
  },
  async ({ conversationId, host }) => {
    const detail = await getFederatedDetail(conversationId, host);
    const { selfName } = loadPeerConfig();
    if (detail?.briefingStale && (!detail.host || detail.host === selfName)) {
      scheduleBriefingRefresh([detail], getConversationDigest);
    }
    return {
      content: [{ type: 'text', text: detail ? detail.title : 'Not found' }],
      structuredContent: { detail },
    };
  },
);

server.registerTool(
  'refresh_briefing',
  {
    title: 'Refresh Conversation Briefing',
    description: 'App-only synthesis of an updated plain-English project briefing and next steps for one conversation.',
    inputSchema: {
      conversationId: z.string(),
      host: z.string().optional(),
    },
    _meta: {
      ui: { visibility: ['app'] },
    },
  },
  async ({ conversationId, host }) => {
    const owner = await resolveOwnerPeer(conversationId, host);
    let detail = null;
    if (owner && !owner.isSelf && owner.peer) {
      const res = await proxyPeerRequest(owner.peer, `/v1/threads/${encodeURIComponent(conversationId)}/brief`, {
        method: 'POST',
        body: {},
        timeoutMs: 42000,
      });
      detail = res.body?.detail ? { ...res.body.detail, host: owner.host } : await getFederatedDetail(conversationId, owner.host);
    } else {
      try {
        await refreshSingleBriefing(conversationId, getConversationDigest);
      } catch {
        // Return current thread detail even if synthesis fails cleanly.
      }
      const localDetail = getThreadDetail(conversationId);
      const { selfName } = loadPeerConfig();
      detail = localDetail ? { ...localDetail, host: selfName } : null;
    }
    return {
      content: [{ type: 'text', text: detail?.briefing?.headline || detail?.title || 'Refreshed' }],
      structuredContent: { detail },
    };
  },
);

server.registerTool(
  'update_board_order',
  {
    title: 'Update Mission Control Order',
    description: 'App-only state mutation to reorder slots, pin/unpin, hide/unhide, or switch sort mode.',
    inputSchema: {
      action: z.enum(['move', 'pin', 'hide', 'unhide_all', 'set_sort', 'reset_order']),
      conversationId: z.string().optional(),
      direction: z.enum(['up', 'down', 'top', 'bottom']).optional(),
      toIndex: z.number().int().nonnegative().optional(),
      value: z.string().optional(),
    },
    _meta: {
      ui: { visibility: ['app'] },
    },
  },
  async (args) => {
    const needFullList =
      args.action === 'reset_order'
      || (args.action === 'move' && (args.direction === 'up' || args.direction === 'down' || typeof args.toIndex === 'number'));
    let items = null;
    if (needFullList) {
      const pre = await getFederatedBoard({ includeFleet: false, includeHidden: false });
      items = pre.conversations;
    }
    mutateBoardState({ ...args, items });
    const snap = await getFederatedBoard({
      includeDetailId: args.conversationId || null,
      includeFleet: true,
      includeHidden: false,
    });
    return {
      content: [{ type: 'text', text: `Updated board (${args.action})` }],
      structuredContent: snap,
    };
  },
);

server.registerTool(
  'focus_conversation',
  {
    title: 'Focus Antigravity Conversation',
    description: 'App-only headless navigation to focus a conversation in the Antigravity sidebar on its Mac.',
    inputSchema: {
      conversationId: z.string().optional(),
      title: z.string().optional(),
      host: z.string().optional(),
    },
    _meta: {
      ui: { visibility: ['app'] },
    },
  },
  async (args = {}) => {
    const cid = args?.conversationId || '';
    const owner = cid ? await resolveOwnerPeer(cid, args?.host) : null;
    if (owner && !owner.isSelf && owner.peer) {
      const res = await proxyPeerRequest(owner.peer, `/v1/threads/${encodeURIComponent(cid)}/focus`, {
        method: 'POST',
        body: {},
        timeoutMs: 25000,
      });
      return {
        content: [{ type: 'text', text: res.body?.ok ? res.body.message : (res.body?.error || 'Open failed') }],
        structuredContent: res.body,
      };
    }
    const detail = owner?.detail || (args?.title ? { id: cid, title: String(args.title).trim() } : null);
    const out = await focusThread(detail);
    return {
      content: [{ type: 'text', text: out.body.ok ? out.body.message : (out.body.error || 'Open failed') }],
      structuredContent: out.body,
    };
  },
);

server.registerTool(
  'send_message',
  {
    title: 'Send Prompt to Conversation',
    description: 'App-only headless action to select an Antigravity conversation and submit a follow-up prompt.',
    inputSchema: {
      conversationId: z.string(),
      text: z.string().min(1).max(8000),
      host: z.string().optional(),
    },
    _meta: {
      ui: { visibility: ['app'] },
    },
  },
  async ({ conversationId, text, host }) => {
    const cleanText = text.trim();
    const owner = await resolveOwnerPeer(conversationId, host);
    if (!owner) {
      const body = { ok: false, error: 'Conversation not found' };
      return { content: [{ type: 'text', text: body.error }], structuredContent: body };
    }
    if (!owner.isSelf && owner.peer) {
      const res = await proxyPeerRequest(owner.peer, `/v1/threads/${encodeURIComponent(conversationId)}/message`, {
        method: 'POST',
        body: { text: cleanText },
        timeoutMs: 25000,
      });
      return {
        content: [{ type: 'text', text: res.body?.ok ? res.body.message : (res.body?.error || 'Send failed') }],
        structuredContent: res.body,
      };
    }
    const detail = owner.detail || getThreadDetail(conversationId);
    const out = await sendMessageToThread(detail, cleanText);
    return {
      content: [{ type: 'text', text: out.body.ok ? out.body.message : (out.body.error || 'Send failed') }],
      structuredContent: out.body,
    };
  },
);

server.registerTool(
  'stop_conversation',
  {
    title: 'Stop Running Conversation',
    description: 'App-only headless action to click Stop execution on a running Antigravity conversation.',
    inputSchema: {
      conversationId: z.string(),
      host: z.string().optional(),
    },
    _meta: {
      ui: { visibility: ['app'] },
    },
  },
  async ({ conversationId, host }) => {
    const owner = await resolveOwnerPeer(conversationId, host);
    if (!owner) {
      const body = { ok: false, error: 'Conversation not found' };
      return { content: [{ type: 'text', text: body.error }], structuredContent: body };
    }
    if (!owner.isSelf && owner.peer) {
      const res = await proxyPeerRequest(owner.peer, `/v1/threads/${encodeURIComponent(conversationId)}/stop`, {
        method: 'POST',
        body: {},
        timeoutMs: 25000,
      });
      return {
        content: [{ type: 'text', text: res.body?.ok ? res.body.message : (res.body?.error || 'Stop failed') }],
        structuredContent: res.body,
      };
    }
    const detail = owner.detail || getThreadDetail(conversationId);
    const out = await stopThread(detail);
    return {
      content: [{ type: 'text', text: out.body.ok ? out.body.message : (out.body.error || 'Stop failed') }],
      structuredContent: out.body,
    };
  },
);

server.registerTool(
  'new_conversation',
  {
    title: 'Start New Conversation',
    description: 'App-only headless action to start a new Antigravity conversation in a project on the target Mac.',
    inputSchema: {
      host: z.string().optional(),
      projectName: z.string().optional(),
      text: z.string().min(1).max(8000),
    },
    _meta: {
      ui: { visibility: ['app'] },
    },
  },
  async ({ host, projectName, text }) => {
    const cleanText = text.trim();
    const cleanProject = typeof projectName === 'string' ? projectName.trim() : '';
    const { selfName } = loadPeerConfig();
    if (host && host !== selfName) {
      const peer = findPeerByName(host);
      if (!peer) {
        const body = { ok: false, error: `Unknown Mac host "${host}"` };
        return { content: [{ type: 'text', text: body.error }], structuredContent: body };
      }
      const res = await proxyPeerRequest(peer, '/v1/threads/new', {
        method: 'POST',
        body: { projectName: cleanProject, text: cleanText },
        timeoutMs: 25000,
      });
      return {
        content: [{ type: 'text', text: res.body?.ok ? res.body.message : (res.body?.error || 'Start failed') }],
        structuredContent: res.body,
      };
    }
    const out = await startNewThread(cleanProject, cleanText);
    return {
      content: [{ type: 'text', text: out.body.ok ? out.body.message : (out.body.error || 'Start failed') }],
      structuredContent: out.body,
    };
  },
);

server.registerTool(
  'list_conversations',
  {
    title: 'List Antigravity Conversations',
    description: 'Read-only list of open Antigravity conversations across connected Macs with ID, host, state, headline, and autoWake flag.',
    inputSchema: {
      filter: z.enum(['all', 'attention', 'working', 'bg', 'unread', 'idle']).optional(),
      host: z.string().optional(),
      limit: z.number().int().min(1).max(60).optional(),
    },
  },
  async ({ filter = 'all', host, limit = 30 } = {}) => {
    const snap = await getFederatedBoard({ includeFleet: false, includeHidden: false });
    let list = snap.conversations || [];
    if (host) list = list.filter((c) => c.host === host);
    if (filter !== 'all') list = list.filter((c) => c.state === filter);
    const slice = list.slice(0, limit).map((c) => ({
      id: c.id,
      slot: c.slot,
      host: c.host || snap.host,
      title: c.title,
      projectName: c.projectName,
      state: c.state,
      autoWake: Boolean(c.autoWake),
      headline: c.waitingReason || c.briefing?.headline || (c.focusIsCurrentTurn ? c.focus : '') || c.lastReply || '',
      ageMs: c.ageMs,
    }));
    const text = slice
      .map((c) => `#${c.slot} [${c.host}] ${c.state}${c.autoWake ? ' auto-wake' : ''} · ${c.title} (${c.id.slice(0, 8)})${c.headline ? ` — ${c.headline}` : ''}`)
      .join('\n') || 'No matching conversations.';
    return {
      content: [{ type: 'text', text }],
      structuredContent: { host: snap.host, counts: snap.counts, conversations: slice },
    };
  },
);

server.registerTool(
  'relay_to_conversation',
  {
    title: 'Relay Message to Another Conversation',
    description: 'Safely send or queue a message for another Antigravity conversation (across M5/M2). Auto-wakes only when the target tab opted into Auto-wake, is not working, passes cooldown/hop/idle checks, and otherwise queues cleanly for Mission Control approval.',
    inputSchema: {
      targetConversationId: z.string().optional(),
      targetTitle: z.string().optional(),
      host: z.string().optional(),
      message: z.string().min(1).max(2000),
      fromLabel: z.string().max(80).optional(),
      hop: z.number().int().min(1).max(10).optional(),
    },
  },
  async ({ targetConversationId, targetTitle, host, message, fromLabel, hop = 1 }) => {
    const cleanMsg = String(message || '').trim();
    const fromConversationId = String(process.env.ANTIGRAVITY_CONVERSATION_ID || '').trim();
    const { selfName } = loadPeerConfig();
    const resolvedFromTitle = fromLabel?.trim() || (fromConversationId ? getThreadDetail(fromConversationId)?.title : '') || '';
    const senderTag = resolvedFromTitle ? `${resolvedFromTitle} (${selfName})` : `Antigravity Agent (${selfName})`;

    const resolved = await resolveConversationByTitleOrId({ targetConversationId, targetTitle, host });
    if (!resolved.ok) {
      const body = { ok: false, error: resolved.error, ...(resolved.matches ? { matches: resolved.matches } : {}) };
      return { content: [{ type: 'text', text: body.error }], structuredContent: body };
    }

    const { owner } = resolved;
    const resolvedId = owner.detail?.id || owner.target?.id || targetConversationId || '';
    if (!owner.isSelf && owner.peer) {
      const res = await proxyPeerRequest(owner.peer, '/v1/relay', {
        method: 'POST',
        body: {
          targetConversationId: resolvedId,
          message: cleanMsg,
          fromConversationId,
          fromLabel: senderTag,
          hop,
        },
        timeoutMs: 25000,
      });
      if (res.body?.relay && !res.body.relay.targetHost) {
        res.body.relay.targetHost = owner.host;
      }
      const relay = res.body?.relay;
      const summary = res.body?.ok
        ? `Relay ${res.body.delivery} (${relay?.id?.slice(0, 8) || ''}) to ${relay?.targetTitle || resolvedId} [${owner.host}]: ${relay?.reason || ''}`
        : (res.body?.error || 'Relay failed');
      return { content: [{ type: 'text', text: summary }], structuredContent: res.body };
    }

    const detail = owner.detail || getThreadDetail(resolvedId);
    const out = await submitLocalRelay({
      detail: detail ? { ...detail, host: selfName } : null,
      targetHost: selfName,
      fromConversationId,
      fromLabel: senderTag,
      message: cleanMsg,
      hop,
      sendFn: sendMessageToThread,
    });
    const relay = out.body?.relay;
    const summary = out.body?.ok
      ? `Relay ${out.body.delivery} (${relay?.id?.slice(0, 8) || ''}) to ${relay?.targetTitle || resolvedId} [${selfName}]: ${relay?.reason || ''}`
      : (out.body?.error || 'Relay failed');
    return { content: [{ type: 'text', text: summary }], structuredContent: out.body };
  },
);

server.registerTool(
  'check_relay_status',
  {
    title: 'Check Agent Relay Status',
    description: 'Inspect delivery status (pending, sent, dismissed) for agent relay messages across Macs.',
    inputSchema: {
      relayId: z.string().optional(),
      targetConversationId: z.string().optional(),
      limit: z.number().int().min(1).max(40).optional(),
    },
  },
  async ({ relayId, targetConversationId, limit = 15 } = {}) => {
    const snap = await getFederatedBoard({ includeFleet: false, includeHidden: false });
    let relays = snap.relays || [];
    if (relayId) relays = relays.filter((r) => r.id === relayId);
    else if (targetConversationId) relays = relays.filter((r) => r.targetConversationId === targetConversationId);
    relays = relays.slice(0, limit);
    const text = relays
      .map((r) => `[${r.status.toUpperCase()}] ${r.id.slice(0, 8)} ${r.fromLabel} -> ${r.targetTitle} (${r.targetHost}): ${r.reason}`)
      .join('\n') || 'No matching relays.';
    return { content: [{ type: 'text', text }], structuredContent: { ok: true, relays } };
  },
);

server.registerTool(
  'approve_relay',
  {
    title: 'Approve Pending Relay',
    description: 'App-only human action to deliver a queued agent relay message (with optional text edits).',
    inputSchema: {
      relayId: z.string(),
      host: z.string().optional(),
      text: z.string().max(2000).optional(),
    },
    _meta: { ui: { visibility: ['app'] } },
  },
  async ({ relayId, host, text }) => {
    const owner = await resolveRelayOwner(relayId, host);
    if (!owner) {
      const body = { ok: false, error: 'Relay not found' };
      return { content: [{ type: 'text', text: body.error }], structuredContent: body };
    }
    if (!owner.isSelf && owner.peer) {
      const res = await proxyPeerRequest(owner.peer, `/v1/relay/${encodeURIComponent(relayId)}/approve`, {
        method: 'POST',
        body: text?.trim() ? { text: text.trim() } : {},
        timeoutMs: 25000,
      });
      return {
        content: [{ type: 'text', text: res.body?.ok ? (res.body.message || 'Relay approved') : (res.body?.error || 'Approve failed') }],
        structuredContent: res.body,
      };
    }
    const out = await approveLocalRelay(relayId, {
      editedMessage: text || '',
      getDetailFn: getThreadDetail,
      sendFn: sendMessageToThread,
    });
    return {
      content: [{ type: 'text', text: out.body.ok ? out.body.message : (out.body.error || 'Approve failed') }],
      structuredContent: out.body,
    };
  },
);

server.registerTool(
  'dismiss_relay',
  {
    title: 'Dismiss Pending Relay',
    description: 'App-only human action to dismiss a queued agent relay message.',
    inputSchema: {
      relayId: z.string(),
      host: z.string().optional(),
    },
    _meta: { ui: { visibility: ['app'] } },
  },
  async ({ relayId, host }) => {
    const owner = await resolveRelayOwner(relayId, host);
    if (!owner) {
      const body = { ok: false, error: 'Relay not found' };
      return { content: [{ type: 'text', text: body.error }], structuredContent: body };
    }
    if (!owner.isSelf && owner.peer) {
      const res = await proxyPeerRequest(owner.peer, `/v1/relay/${encodeURIComponent(relayId)}/dismiss`, {
        method: 'POST',
        body: {},
        timeoutMs: 10000,
      });
      return {
        content: [{ type: 'text', text: res.body?.ok ? (res.body.message || 'Dismissed relay') : (res.body?.error || 'Dismiss failed') }],
        structuredContent: res.body,
      };
    }
    const out = dismissLocalRelay(relayId);
    return {
      content: [{ type: 'text', text: out.body.ok ? out.body.message : (out.body.error || 'Dismiss failed') }],
      structuredContent: out.body,
    };
  },
);

server.registerTool(
  'toggle_auto_wake',
  {
    title: 'Toggle Auto-Wake on Conversation',
    description: 'App-only human action to opt a conversation tab in or out of guarded agent Auto-wake.',
    inputSchema: {
      conversationId: z.string(),
      host: z.string().optional(),
      enabled: z.boolean().optional(),
    },
    _meta: { ui: { visibility: ['app'] } },
  },
  async ({ conversationId, host, enabled }) => {
    const owner = await resolveOwnerPeer(conversationId, host);
    if (!owner) {
      const body = { ok: false, error: 'Conversation not found' };
      return { content: [{ type: 'text', text: body.error }], structuredContent: body };
    }
    if (!owner.isSelf && owner.peer) {
      const res = await proxyPeerRequest(owner.peer, `/v1/threads/${encodeURIComponent(conversationId)}/auto-wake`, {
        method: 'POST',
        body: typeof enabled === 'boolean' ? { enabled } : {},
        timeoutMs: 10000,
      });
      return {
        content: [{ type: 'text', text: res.body?.ok ? (res.body.message || 'Updated auto-wake') : (res.body?.error || 'Toggle failed') }],
        structuredContent: res.body,
      };
    }
    const detail = owner.detail || getThreadDetail(conversationId);
    const autoWake = typeof enabled === 'boolean' ? setAutoWake(conversationId, enabled) : toggleAutoWake(conversationId);
    const msg = `${autoWake ? 'Enabled' : 'Disabled'} auto-wake for ${detail?.title || conversationId}`;
    return {
      content: [{ type: 'text', text: msg }],
      structuredContent: { ok: true, conversationId, autoWake, message: msg },
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
