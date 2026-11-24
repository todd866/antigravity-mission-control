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
  resolveOwnerPeer,
} from './src/federation.mjs';

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

const transport = new StdioServerTransport();
await server.connect(transport);
