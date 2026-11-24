import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps';

type ThreadState = 'attention' | 'working' | 'bg' | 'unread' | 'idle';
type FilterMode = 'all' | ThreadState;
type SortMode = 'fixed' | 'project' | 'state';

interface StepItem {
  title: string;
  status: string;
}

interface StepsInfo {
  items: StepItem[];
  done: number;
  total: number;
  currentTitle: string;
}

interface SubagentInfo {
  id: string;
  title: string;
  status: string;
  lastModifiedMs: number;
}

interface EventInfo {
  kind: string;
  status: string;
  createdAt: string;
  text: string;
}

interface NextAction {
  label: string;
  prompt: string;
}

interface BriefingInfo {
  headline: string;
  brief: string;
  currentWork: string;
  priorCompleted: string;
  needsUser: string;
  nextActions: NextAction[];
  updatedAt: number;
  model: string;
}

interface HostInfo {
  name: string;
  isSelf?: boolean;
  online: boolean;
  macAccessibility?: boolean;
  conversationCount?: number;
  error?: string;
}

interface ProjectInfo {
  id: string;
  name: string;
  host?: string;
}

interface ConversationItem {
  id: string;
  shortId: string;
  title: string;
  host?: string;
  projectId: string;
  projectName: string;
  stepCount: number;
  state: ThreadState;
  waitingReason: string;
  unread: boolean;
  stalled: boolean;
  ageMs: number;
  lastModifiedMs: number;
  lastUserInputMs: number;
  focus: string;
  focusIsCurrentTurn?: boolean;
  steps: StepsInfo | null;
  stepsIsCurrentTurn?: boolean;
  lastPrompt?: string;
  lastReply: string;
  lastReplyFull: string;
  briefing?: BriefingInfo | null;
  briefingStale?: boolean;
  recentEvents: EventInfo[];
  runningBgCount: number;
  subagentCount: number;
  subagents: SubagentInfo[];
  model: string;
  pinned: boolean;
  hidden: boolean;
  slot: number;
}

interface FleetItem {
  mac: string;
  agent: string;
  mode: string;
  runtime: string;
  cpu: string;
  state: string;
  project: string;
}

interface LastActionInfo {
  ok: boolean;
  conversationId?: string;
  title?: string;
  message?: string;
  error?: string;
  at: number;
}

interface BoardSnapshot {
  generatedAt: number;
  sortMode: SortMode;
  counts: {
    total: number;
    attention: number;
    working: number;
    bg: number;
    unread: number;
    idle: number;
    hidden: number;
  };
  conversations: ConversationItem[];
  fleet: FleetItem[];
  hosts?: HostInfo[];
  projects?: ProjectInfo[];
  host?: string;
  lastAction?: LastActionInfo | null;
  initialFilter?: FilterMode;
  selectedId?: string | null;
}

const STATE_LABEL: Record<ThreadState, string> = {
  attention: 'Waiting',
  working: 'Working',
  bg: 'Background',
  unread: 'Unread',
  idle: 'Idle',
};

const STATE_ICON: Record<ThreadState, string> = {
  attention:
    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2.2 14.2 13.2H1.8L8 2.2Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="8" cy="10.7" r="0.9" fill="currentColor"/><line x1="8" y1="6.2" x2="8" y2="8.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  working:
    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" class="mc-spin" aria-hidden="true"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-opacity="0.22" stroke-width="1.8"/><path d="M8 2.5A5.5 5.5 0 0 1 13.5 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  bg:
    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 2"/><circle cx="8" cy="8" r="2.2" fill="currentColor"/></svg>',
  unread:
    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2.5 13.5 8 8 13.5 2.5 8 8 2.5Z" fill="currentColor"/></svg>',
  idle:
    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="4.5" stroke="currentColor" stroke-width="1.4"/></svg>',
};

const ICON_PIN =
  '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5.5 2.5h5l-.6 4.2 2.1 2.1v1.2H8.7v3.5l-.7.8-.7-.8V10H4V8.8l2.1-2.1-.6-4.2Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" fill="currentColor" fill-opacity="var(--pin-fill, 0)"/></svg>';
const ICON_BOTTOM =
  '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2.5v7.5M4.8 7.2 8 10.4l3.2-3.2M3.5 13h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_CLOSE =
  '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const ICON_OPEN =
  '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3.5h6.5V10M12.2 3.8 4.5 11.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return ch;
    }
  });
}

function fmtAge(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

function fmtClock(epochMs: number): string {
  const d = new Date(epochMs || Date.now());
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function stepGlyph(status: string): string {
  if (status === 'done') return '✓';
  if (status === 'in_progress') return '▸';
  if (status === 'failed') return '×';
  if (status === 'skipped') return '–';
  return '·';
}

const ui = {
  snapshot: null as BoardSnapshot | null,
  filter: 'all' as FilterMode,
  hostFilter: 'all' as string,
  view: 'threads' as 'threads' | 'fleet',
  selectedId: null as string | null,
  detail: null as ConversationItem | null,
  refreshingBriefId: null as string | null,
  sendingId: null as string | null,
  showNewForm: false,
  newHost: '' as string,
  newProject: '' as string,
  newPrompt: '' as string,
  creatingNew: false,
  drafts: {} as Record<string, string>,
  openDisclosures: {} as Record<string, Record<string, boolean>>,
  toast: '',
  toastTimer: 0 as number | ReturnType<typeof setTimeout>,
  lastActionSeenAt: 0,
  sendStatus: null as { conversationId: string; kind: 'sending' | 'sent' | 'error'; text: string } | null,
  pendingPollTimers: [] as Array<ReturnType<typeof setTimeout>>,
  pollInFlight: false,
  hasToolResult: false,
  lastRenderKey: '',
};

const app = new App({ name: 'Mission Control', version: '1.2.0' }, {});

function applyHostCtx(ctx?: McpUiHostContext) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
}

function showToast(msg: string) {
  ui.toast = msg;
  if (ui.toastTimer) clearTimeout(ui.toastTimer);
  render();
  ui.toastTimer = setTimeout(() => {
    ui.toast = '';
    render();
  }, 3200);
}

function getHostForThread(conversationId: string): string | undefined {
  if (ui.detail?.id === conversationId && ui.detail.host) return ui.detail.host;
  return ui.snapshot?.conversations.find((c) => c.id === conversationId)?.host;
}

function visibleThreads(): ConversationItem[] {
  let list = ui.snapshot?.conversations ?? [];
  if (ui.hostFilter !== 'all') {
    list = list.filter((c) => c.host === ui.hostFilter);
  }
  if (ui.filter !== 'all') {
    list = list.filter((c) => c.state === ui.filter);
  }
  return list;
}

function applySnapshot(snap: BoardSnapshot | undefined, fromInitialTool = false) {
  if (!snap || !Array.isArray(snap.conversations)) return;
  ui.snapshot = snap;
  if (!ui.newHost && snap.hosts && snap.hosts.length > 0) {
    const firstOn = snap.hosts.find((h) => h.online)?.name || snap.hosts[0].name;
    ui.newHost = firstOn;
  }
  if (fromInitialTool) {
    if (snap.initialFilter) ui.filter = snap.initialFilter;
    if (snap.selectedId) ui.selectedId = snap.selectedId;
  }
  if (snap.lastAction && snap.lastAction.at > ui.lastActionSeenAt) {
    ui.lastActionSeenAt = snap.lastAction.at;
    const act = snap.lastAction;
    const msg = act.ok ? (act.message || 'Sent prompt') : (act.error || 'Could not send prompt');
    if (act.conversationId) {
      ui.sendStatus = {
        conversationId: act.conversationId,
        kind: act.ok ? 'sent' : 'error',
        text: act.ok ? 'Sent — agent is responding...' : msg,
      };
    }
    ui.toast = msg;
    if (ui.toastTimer) clearTimeout(ui.toastTimer);
    ui.toastTimer = setTimeout(() => {
      ui.toast = '';
      render();
    }, 3200);
  }
  if (ui.sendStatus?.kind === 'sent') {
    const activeMatch = snap.conversations.find((c) => c.id === ui.sendStatus?.conversationId);
    if (activeMatch?.state === 'working') {
      ui.sendStatus = null;
    }
  }
  if (ui.selectedId) {
    const match = snap.conversations.find((c) => c.id === ui.selectedId);
    if (!match) {
      ui.selectedId = null;
      ui.detail = null;
    } else if (match.lastReplyFull || (match.recentEvents && match.recentEvents.length > 0)) {
      ui.detail = match;
    } else if (!ui.detail || ui.detail.id !== match.id) {
      ui.detail = match;
    } else {
      ui.detail = {
        ...match,
        lastReplyFull: ui.detail.lastReplyFull,
        recentEvents: ui.detail.recentEvents,
      };
    }
  }
  render();
}

async function pollBoard() {
  if (ui.pollInFlight) return;
  ui.pollInFlight = true;
  try {
    const res = await app.callServerTool({
      name: 'poll_board',
      arguments: {
        selectedId: ui.selectedId,
        includeFleet: true,
      },
    });
    const sc = res?.structuredContent as BoardSnapshot | undefined;
    if (sc) applySnapshot(sc);
  } catch {
    // Keep last good snapshot on transient poll errors.
  } finally {
    ui.pollInFlight = false;
  }
}

async function loadThreadDetail(conversationId: string) {
  ui.selectedId = conversationId;
  const fromList = ui.snapshot?.conversations.find((c) => c.id === conversationId) || null;
  if (fromList) ui.detail = fromList;
  render();

  try {
    const host = getHostForThread(conversationId);
    const res = await app.callServerTool({
      name: 'get_thread_detail',
      arguments: host ? { conversationId, host } : { conversationId },
    });
    const sc = res?.structuredContent as { detail?: ConversationItem | null } | undefined;
    if (sc?.detail && ui.selectedId === conversationId) {
      ui.detail = sc.detail;
      render();
    }
  } catch {
    // Fallback list data already visible.
  }
}

async function refreshBriefing(conversationId: string) {
  if (ui.refreshingBriefId) return;
  ui.refreshingBriefId = conversationId;
  render();
  try {
    const host = getHostForThread(conversationId);
    const res = await app.callServerTool({
      name: 'refresh_briefing',
      arguments: host ? { conversationId, host } : { conversationId },
    });
    const sc = res?.structuredContent as { detail?: ConversationItem | null } | undefined;
    if (sc?.detail) {
      if (ui.selectedId === conversationId) ui.detail = sc.detail;
      if (ui.snapshot) {
        ui.snapshot = {
          ...ui.snapshot,
          conversations: ui.snapshot.conversations.map((c) => (c.id === conversationId ? { ...c, briefing: sc.detail?.briefing, briefingStale: sc.detail?.briefingStale } : c)),
        };
      }
      showToast('Updated briefing');
    }
  } catch {
    showToast('Briefing refresh failed');
  } finally {
    ui.refreshingBriefId = null;
    render();
  }
}

async function mutateOrder(params: Record<string, unknown>) {
  try {
    const res = await app.callServerTool({
      name: 'update_board_order',
      arguments: params,
    });
    const sc = res?.structuredContent as BoardSnapshot | undefined;
    if (sc) applySnapshot(sc);
  } catch {
    showToast('Order update failed');
  }
}

async function focusConversation(item: ConversationItem) {
  showToast(`Opening ${item.title}`);
  try {
    const res = await app.callServerTool({
      name: 'focus_conversation',
      arguments: item.host
        ? { conversationId: item.id, title: item.title, host: item.host }
        : { conversationId: item.id, title: item.title },
    });
    const sc = res?.structuredContent as { ok?: boolean; title?: string; error?: string; fallbackHint?: string } | undefined;
    if (sc?.ok) {
      showToast(`Switched to ${sc.title || item.title}`);
    } else {
      showToast(sc?.fallbackHint || sc?.error || `Press Cmd+K: ${item.title}`);
    }
  } catch {
    showToast(`Press Cmd+K: ${item.title}`);
  }
}

function scheduleRapidRefresh(conversationId?: string) {
  for (const t of ui.pendingPollTimers) clearTimeout(t);
  ui.pendingPollTimers = [];
  for (const delay of [500, 1600, 3500]) {
    const timer = setTimeout(() => {
      void pollBoard();
      if (conversationId && ui.selectedId === conversationId) {
        void loadThreadDetail(conversationId);
      }
    }, delay);
    ui.pendingPollTimers.push(timer);
  }
}

async function sendPromptToThread(conversationId: string, text: string, clearDraft = false) {
  const clean = text.trim();
  if (!clean || ui.sendingId) return;
  ui.sendingId = conversationId;
  ui.sendStatus = { conversationId, kind: 'sending', text: 'Sending prompt to Antigravity...' };
  render();
  try {
    const host = getHostForThread(conversationId);
    const res = await app.callServerTool({
      name: 'send_message',
      arguments: host ? { conversationId, text: clean, host } : { conversationId, text: clean },
    });
    const sc = res?.structuredContent as { ok?: boolean; message?: string; error?: string } | undefined;
    ui.lastActionSeenAt = Math.max(ui.lastActionSeenAt, Date.now());
    if (sc?.ok) {
      if (clearDraft) ui.drafts[conversationId] = '';
      ui.sendStatus = { conversationId, kind: 'sent', text: 'Sent — agent is responding...' };
      showToast(sc.message || 'Sent prompt');
      scheduleRapidRefresh(conversationId);
      setTimeout(() => {
        if (ui.sendStatus?.conversationId === conversationId && ui.sendStatus.kind === 'sent') {
          ui.sendStatus = null;
          render();
        }
      }, 6500);
    } else {
      const errMsg = sc?.error || 'Could not send prompt';
      ui.sendStatus = { conversationId, kind: 'error', text: errMsg };
      showToast(errMsg);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Could not send prompt';
    ui.sendStatus = { conversationId, kind: 'error', text: errMsg };
    showToast('Could not send prompt');
  } finally {
    ui.sendingId = null;
    render();
  }
}

async function stopRunningConversation(conversationId: string) {
  try {
    const host = getHostForThread(conversationId);
    const res = await app.callServerTool({
      name: 'stop_conversation',
      arguments: host ? { conversationId, host } : { conversationId },
    });
    const sc = res?.structuredContent as { ok?: boolean; message?: string; error?: string } | undefined;
    showToast(sc?.ok ? (sc.message || 'Stopped') : (sc?.error || 'Could not stop'));
    if (sc?.ok) void pollBoard();
  } catch {
    showToast('Could not stop run');
  }
}

async function createNewConversation() {
  const cleanText = ui.newPrompt.trim();
  if (!cleanText || ui.creatingNew) return;
  ui.creatingNew = true;
  render();
  try {
    const args: Record<string, string> = { text: cleanText };
    if (ui.newHost) args.host = ui.newHost;
    if (ui.newProject) args.projectName = ui.newProject;
    const res = await app.callServerTool({
      name: 'new_conversation',
      arguments: args,
    });
    const sc = res?.structuredContent as { ok?: boolean; message?: string; error?: string } | undefined;
    if (sc?.ok) {
      ui.newPrompt = '';
      ui.showNewForm = false;
      showToast(sc.message || 'Started conversation');
      void pollBoard();
    } else {
      showToast(sc?.error || 'Could not start conversation');
    }
  } catch {
    showToast('Could not start conversation');
  } finally {
    ui.creatingNew = false;
    render();
  }
}

function renderTopBar(snap: BoardSnapshot): string {
  const c = snap.counts;
  const filters: Array<{ key: FilterMode; label: string; count: number; icon: string }> = [
    { key: 'all', label: 'All', count: c.total, icon: '' },
    { key: 'attention', label: 'Waiting', count: c.attention, icon: STATE_ICON.attention },
    { key: 'working', label: 'Working', count: c.working, icon: STATE_ICON.working },
    { key: 'bg', label: 'Background', count: c.bg, icon: STATE_ICON.bg },
    { key: 'unread', label: 'Unread', count: c.unread, icon: STATE_ICON.unread },
    { key: 'idle', label: 'Idle', count: c.idle, icon: STATE_ICON.idle },
  ];

  const filterHtml = filters
    .map((f) => {
      const active = ui.view === 'threads' && ui.filter === f.key;
      const cls = f.key === 'all' ? '' : f.count === 0 ? 'is-zero' : `st-${f.key}`;
      const labelSpan = f.key === 'all' ? '<span>All</span>' : `<span class="mc-filter-label">${f.label}</span>`;
      return `<button type="button" class="mc-filter-btn ${cls}" data-action="filter" data-filter="${f.key}" data-focus-key="filter:${f.key}" aria-pressed="${active}" aria-label="${f.label} (${f.count})" title="${f.label}">
        ${f.icon ? `<span class="mc-filter-icon">${f.icon}</span>` : ''}
        ${labelSpan}
        <span class="num">${f.count}</span>
      </button>`;
    })
    .join('');

  const hosts = snap.hosts || [];
  const hostSegHtml =
    hosts.length > 1
      ? `<div class="mc-seg mc-host-seg" role="group" aria-label="Mac filter">
          <button type="button" class="mc-seg-btn" data-action="host-filter" data-host="all" aria-pressed="${ui.hostFilter === 'all'}">All</button>
          ${hosts
            .map(
              (h) =>
                `<button type="button" class="mc-seg-btn" data-action="host-filter" data-host="${esc(h.name)}" aria-pressed="${ui.hostFilter === h.name}" title="${h.online ? 'Connected' : esc(h.error || 'Offline')}"><span class="mc-host-dot ${h.online ? 'is-on' : 'is-off'}"></span>${esc(h.name)}</button>`,
            )
            .join('')}
        </div>`
      : '';

  const sorts: Array<{ key: SortMode; label: string }> = [
    { key: 'fixed', label: 'Fixed' },
    { key: 'project', label: 'Project' },
    { key: 'state', label: 'State' },
  ];
  const sortHtml = sorts
    .map(
      (s) =>
        `<button type="button" class="mc-seg-btn" data-action="sort" data-sort="${s.key}" data-focus-key="sort:${s.key}" aria-pressed="${snap.sortMode === s.key}">${s.label}</button>`,
    )
    .join('');

  const fleetCount = snap.fleet?.length || 0;
  const fleetBtn =
    fleetCount > 0 || ui.view === 'fleet'
      ? `<button type="button" class="mc-btn" data-action="toggle-fleet" data-focus-key="fleet" aria-pressed="${ui.view === 'fleet'}">Fleet <span class="num">${fleetCount}</span></button>`
      : '';

  const hiddenBtn =
    c.hidden > 0
      ? `<button type="button" class="mc-btn" data-action="unhide-all" data-focus-key="unhide" title="Restore hidden conversations">Show <span class="num">${c.hidden}</span></button>`
      : '';

  const toastHtml = ui.toast ? `<span class="mc-toast" title="${esc(ui.toast)}">${esc(ui.toast)}</span>` : '';

  return `<header class="mc-bar">
    <div class="mc-bar-group">${filterHtml}${hostSegHtml}</div>
    <div class="mc-bar-right">
      ${toastHtml}
      <button type="button" class="mc-btn" data-action="toggle-new" data-focus-key="new-btn" aria-pressed="${ui.showNewForm}">+ New</button>
      ${fleetBtn}
      ${hiddenBtn}
      <div class="mc-seg mc-bar-sort" role="group" aria-label="Sort order">${sortHtml}</div>
      <span id="mc-clock" class="mc-clock num">${fmtClock(snap.generatedAt)}</span>
    </div>
  </header>`;
}

function renderNewBar(snap: BoardSnapshot): string {
  if (!ui.showNewForm) return '';
  const hosts = snap.hosts || [];
  const chosenHost = ui.newHost || snap.host || hosts[0]?.name || '';
  const projects = (snap.projects || []).filter((p) => !chosenHost || !p.host || p.host === chosenHost);

  const hostSelect =
    hosts.length > 1
      ? `<select class="mc-select" data-new-field="host" aria-label="Target Mac">
          ${hosts.map((h) => `<option value="${esc(h.name)}"${h.name === chosenHost ? ' selected' : ''}>${esc(h.name)}${h.online ? '' : ' (offline)'}</option>`).join('')}
        </select>`
      : '';

  const projectSelect = `<select class="mc-select" data-new-field="project" aria-label="Project">
    <option value="">Default project</option>
    ${projects.map((p) => `<option value="${esc(p.name)}"${p.name === ui.newProject ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
  </select>`;

  return `<div class="mc-new-bar" role="region" aria-label="Start new conversation">
    ${hostSelect}
    ${projectSelect}
    <input type="text" class="mc-new-input" data-new-field="prompt" value="${esc(ui.newPrompt)}" placeholder="Start a new Antigravity conversation...">
    <button type="button" class="mc-btn mc-btn-primary" data-action="create-new" ${ui.creatingNew ? 'disabled' : ''}>${ui.creatingNew ? 'Starting...' : 'Start'}</button>
    <button type="button" class="mc-btn" data-action="toggle-new">Cancel</button>
  </div>`;
}

function renderThreadRow(item: ConversationItem, sortMode: SortMode, index: number, list: ConversationItem[]): string {
  const isFixed = sortMode === 'fixed';
  const nextSameGroup = index < list.length - 1 && list[index + 1].pinned === item.pinned;
  const canSendBottom = isFixed && (item.pinned || nextSameGroup);

  const focusText =
    item.waitingReason
    || item.briefing?.headline
    || (item.focusIsCurrentTurn ? item.focus : '')
    || item.lastReply
    || '—';
  const focusCls = item.waitingReason ? 'mc-focus-cell is-attention' : 'mc-focus-cell';

  const next0 =
    item.state !== 'working'
      ? item.briefing?.nextActions?.[0]
      : undefined;
  const nextPillHtml = next0
    ? `<button type="button" class="mc-next-pill" data-action="run-next" data-id="${esc(item.id)}" data-idx="0" data-focus-key="next:${esc(item.id)}" title="Send now: ${esc(next0.prompt)}">▶ ${esc(next0.label)}</button>`
    : '';

  let stepsHtml = '<span class="mc-step-ratio num">—</span>';
  if (item.steps && item.steps.total > 0) {
    const pct = Math.round((item.steps.done / item.steps.total) * 100);
    const fillCls = item.steps.done === item.steps.total ? 'mc-bar-fill is-done' : 'mc-bar-fill';
    stepsHtml = `<div class="mc-bar-track" aria-hidden="true"><div class="${fillCls}" style="width:${pct}%"></div></div>
      <span class="mc-step-ratio num">${item.steps.done}/${item.steps.total}</span>`;
  }

  const subTag =
    item.subagentCount > 0
      ? ` · ${item.subagentCount} ${item.subagentCount === 1 ? 'subagent' : 'subagents'}`
      : '';
  const showHostBadge = (ui.snapshot?.hosts?.length || 0) > 1 && Boolean(item.host);
  const hostBadgeHtml = showHostBadge ? `<span class="mc-host-badge">${esc(item.host)}</span>` : '';
  const stepTitle = item.steps?.currentTitle ? `${item.steps.done}/${item.steps.total}: ${item.steps.currentTitle}` : '';
  const selected = ui.selectedId === item.id;

  return `<div class="mc-row${selected ? ' is-selected' : ''}" role="row" tabindex="0" data-action="select" data-id="${esc(item.id)}" data-focus-key="row:${esc(item.id)}">
    <div class="mc-slot-cell">
      <span class="mc-slot-num num">${item.slot}</span>
      <button type="button" class="mc-icon-btn" data-action="pin" data-id="${esc(item.id)}" data-focus-key="pin:${esc(item.id)}" aria-pressed="${item.pinned}" style="--pin-fill:${item.pinned ? '1' : '0'}" aria-label="${item.pinned ? 'Unpin' : 'Pin'}" title="${item.pinned ? 'Unpin' : 'Pin to top'}">${ICON_PIN}</button>
      <button type="button" class="mc-icon-btn" data-action="move-bottom" data-id="${esc(item.id)}" data-focus-key="bot:${esc(item.id)}" ${!canSendBottom ? 'disabled' : ''} aria-label="Send ${esc(item.title)} to bottom" title="${isFixed ? 'Send to bottom' : 'Switch to Fixed sort to reorder'}">${ICON_BOTTOM}</button>
    </div>
    <div class="mc-state-cell st-${item.state}" title="${esc(item.waitingReason || STATE_LABEL[item.state])}">
      ${STATE_ICON[item.state]}
      <span class="mc-state-label">${STATE_LABEL[item.state]}</span>
    </div>
    <div class="mc-title-cell">
      <span class="mc-title" title="${esc(item.title)}">${esc(item.title)}</span>
      <span class="mc-project" title="${esc(item.projectName + subTag)}">${esc(item.projectName)}${esc(subTag)}</span>
      ${hostBadgeHtml}
    </div>
    <div class="${focusCls}" title="${esc(focusText)}">
      <span class="mc-focus-text">${esc(focusText)}</span>
      ${nextPillHtml}
    </div>
    <div class="mc-steps-cell" title="${esc(stepTitle)}">${stepsHtml}</div>
    <div class="mc-age-cell num${item.stalled ? ' is-stalled' : ''}" title="${item.stalled ? 'Working without update over 5m' : ''}">${fmtAge(item.ageMs)}</div>
    <div class="mc-actions-cell">
      <button type="button" class="mc-btn mc-open-btn" data-action="open" data-id="${esc(item.id)}" data-focus-key="open:${esc(item.id)}" aria-label="Open ${esc(item.title)}" title="Switch Antigravity to this conversation">${ICON_OPEN}<span class="mc-open-label">Open</span></button>
      <button type="button" class="mc-icon-btn mc-hide-btn" data-action="hide" data-id="${esc(item.id)}" data-focus-key="hide:${esc(item.id)}" aria-label="Hide ${esc(item.title)}" title="Hide from board">${ICON_CLOSE}</button>
    </div>
  </div>`;
}

function renderFleetPane(fleet: FleetItem[]): string {
  if (!fleet.length) {
    return '<div class="mc-empty">No local CLI agents running.</div>';
  }
  return fleet
    .map(
      (f) => `<div class="mc-fleet-row">
      <span>${esc(f.mac)}</span>
      <span>${esc(f.agent)}</span>
      <span>${esc(f.mode)}</span>
      <span class="num">${esc(f.runtime)}</span>
      <span class="num">${esc(f.cpu)}</span>
      <span class="mc-title" title="${esc(f.project)}">${esc(f.state)} · ${esc(f.project)}</span>
    </div>`,
    )
    .join('');
}

function formatInlineMarkdown(escaped: string): string {
  return escaped.replace(/`([^`]+)`|\*\*([^*]+)\*\*|\*([^*\n]+)\*/g, (_m, code, bold, italic) => {
    if (code !== undefined) return `<code class="mc-md-code">${code}</code>`;
    if (bold !== undefined) return `<strong>${bold}</strong>`;
    if (italic !== undefined) return `<em>${italic}</em>`;
    return _m;
  });
}

function renderCleanMarkdown(raw: string): string {
  const sanitized = String(raw || '')
    .replace(/\[([^\]]+)\]\((file:\/\/[^)]+|\/[^)]+)\)/g, (_m, label) => `\`${label}\``)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_m, label) => label)
    .replace(/file:\/\/\/\S+/g, '')
    .replace(/\/Users\/[^\s),.;:]+/g, '')
    .replace(/\r/g, '');

  const lines = sanitized.split('\n');
  const out: string[] = [];
  let inCode = false;
  let codeLines: string[] = [];
  let listItems: string[] = [];
  let paraLines: string[] = [];

  const flushPara = () => {
    if (paraLines.length === 0) return;
    const text = paraLines.map((l) => formatInlineMarkdown(esc(l))).join(' ');
    out.push(`<p class="mc-md-p">${text}</p>`);
    paraLines = [];
  };

  const flushList = () => {
    if (listItems.length === 0) return;
    out.push(`<ul class="mc-md-ul">${listItems.join('')}</ul>`);
    listItems = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      flushPara();
      flushList();
      if (!inCode) {
        inCode = true;
        codeLines = [];
      } else {
        out.push(`<pre class="mc-md-pre"><code>${esc(codeLines.join('\n'))}</code></pre>`);
        inCode = false;
        codeLines = [];
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    if (!trimmed) {
      flushPara();
      flushList();
      continue;
    }
    if (/^[-*_]{3,}$/.test(trimmed)) {
      flushPara();
      flushList();
      out.push('<hr class="mc-md-hr">');
      continue;
    }
    const hMatch = trimmed.match(/^#{1,6}\s+(.+)$/);
    if (hMatch) {
      flushPara();
      flushList();
      out.push(`<h4 class="mc-md-h">${formatInlineMarkdown(esc(hMatch[1]))}</h4>`);
      continue;
    }
    const liMatch = trimmed.match(/^(?:[-*]|\d+\.)\s+(.+)$/);
    if (liMatch) {
      flushPara();
      listItems.push(`<li>${formatInlineMarkdown(esc(liMatch[1]))}</li>`);
      continue;
    }
    flushList();
    paraLines.push(trimmed);
  }
  if (inCode && codeLines.length > 0) {
    out.push(`<pre class="mc-md-pre"><code>${esc(codeLines.join('\n'))}</code></pre>`);
  }
  flushPara();
  flushList();
  return out.join('');
}

function renderDetailPane(d: ConversationItem): string {
  const disc = ui.openDisclosures[d.id] || {};
  const refreshing = ui.refreshingBriefId === d.id;
  const sending = ui.sendingId === d.id;

  const needsCallText = d.waitingReason || d.briefing?.needsUser || '';
  const needsCallBlock = needsCallText
    ? `<div class="mc-detail-block">
        <div class="mc-detail-label">Needs your call</div>
        <p class="mc-detail-text is-attention">${esc(needsCallText)}</p>
      </div>`
    : '';

  const isActive = d.state === 'working' || d.state === 'bg';
  let briefingBlock = '';
  if (d.briefing && (d.briefing.brief || d.briefing.headline)) {
    const staleTag = d.briefingStale ? '<span class="mc-tag-muted">Updating</span>' : '';
    const inFlightText = isActive
      ? (d.briefing.currentWork || (d.focusIsCurrentTurn ? d.focus : ''))
      : '';
    const inFlightHtml = inFlightText
      ? `<p class="mc-subnote"><strong>In flight now:</strong> ${esc(inFlightText)}</p>`
      : '';
    const priorHtml = d.briefing.priorCompleted
      ? `<p class="mc-subnote"><strong>Done so far:</strong> ${esc(d.briefing.priorCompleted)}</p>`
      : '';

    briefingBlock = `<div class="mc-detail-block">
      <div class="mc-detail-label-row">
        <span class="mc-detail-label">Project briefing</span>
        ${staleTag}
      </div>
      <p class="mc-detail-text">${esc(d.briefing.brief || d.briefing.headline)}</p>
      ${inFlightHtml}
      ${priorHtml}
    </div>`;
  } else {
    const fallbackText =
      (d.focusIsCurrentTurn ? d.focus : '')
      || d.lastPrompt
      || d.lastReply
      || 'Generating briefing...';
    briefingBlock = `<div class="mc-detail-block">
      <div class="mc-detail-label-row">
        <span class="mc-detail-label">Project briefing</span>
        <span class="mc-tag-muted">Generating</span>
      </div>
      <p class="mc-detail-text">${esc(fallbackText)}</p>
    </div>`;
  }

  const nextActions = d.state !== 'working' ? (d.briefing?.nextActions || []) : [];
  const nextBlock =
    nextActions.length > 0
      ? `<div class="mc-detail-block">
          <div class="mc-detail-label">What's next</div>
          <div class="mc-next-list">
            ${nextActions
              .map(
                (na, idx) => `<div class="mc-next-card">
                <div class="mc-next-head">
                  <span class="mc-next-label">${esc(na.label)}</span>
                  <div class="mc-next-btns">
                    <button type="button" class="mc-btn mc-btn-xs mc-btn-primary" data-action="send-next" data-id="${esc(d.id)}" data-idx="${idx}" ${sending ? 'disabled' : ''}>Send</button>
                    <button type="button" class="mc-btn mc-btn-xs" data-action="edit-next" data-id="${esc(d.id)}" data-idx="${idx}">Edit</button>
                  </div>
                </div>
                <p class="mc-next-prompt" data-action="edit-next" data-id="${esc(d.id)}" data-idx="${idx}" title="Click to load into box and edit">${esc(na.prompt)}</p>
              </div>`,
              )
              .join('')}
          </div>
        </div>`
      : '';

  const draft = ui.drafts[d.id] || '';
  const statusBanner =
    ui.sendStatus && ui.sendStatus.conversationId === d.id
      ? `<div class="mc-composer-status is-${ui.sendStatus.kind}" role="status">
          <span class="mc-composer-status-text">${esc(ui.sendStatus.text)}</span>
          ${ui.sendStatus.kind === 'error' ? '<button type="button" class="mc-icon-btn mc-status-dismiss" data-action="dismiss-status" aria-label="Dismiss error">×</button>' : ''}
        </div>`
      : '';
  const composerBlock = `<div class="mc-composer">
    ${statusBanner}
    <textarea class="mc-composer-input" data-composer-id="${esc(d.id)}" rows="2" placeholder="Send a follow-up prompt to this tab...">${esc(draft)}</textarea>
    <div class="mc-composer-foot">
      <span class="mc-composer-hint">Enter sends · Shift+Enter newline</span>
      <button type="button" class="mc-btn mc-btn-primary" data-action="send-custom" data-id="${esc(d.id)}" ${sending ? 'disabled' : ''}>${sending ? 'Sending...' : 'Send'}</button>
    </div>
  </div>`;

  let checklistHtml = '';
  if (d.steps && d.steps.items.length > 0) {
    const itemsHtml = `<ul class="mc-checklist">
      ${d.steps.items
        .map(
          (s) => `<li class="mc-check-item is-${esc(s.status)}">
            <span class="num">${stepGlyph(s.status)}</span>
            <span>${esc(s.title)}</span>
          </li>`,
        )
        .join('')}
    </ul>`;
    if (d.stepsIsCurrentTurn ?? true) {
      checklistHtml = `<div class="mc-detail-block">
        <div class="mc-detail-label">Checklist (${d.steps.done}/${d.steps.total})</div>
        ${itemsHtml}
      </div>`;
    } else {
      checklistHtml = `<details class="mc-disclosure" data-disclosure="checklist" data-thread-id="${esc(d.id)}"${disc.checklist ? ' open' : ''}>
        <summary>Previous turn checklist (${d.steps.done}/${d.steps.total})</summary>
        <div class="mc-disclosure-body">${itemsHtml}</div>
      </details>`;
    }
  }

  const subHtml =
    d.subagents && d.subagents.length > 0
      ? `<div class="mc-detail-block">
          <div class="mc-detail-label">Active subagents (${d.subagents.length})</div>
          <ul class="mc-checklist">
            ${d.subagents
              .map((s) => `<li class="mc-check-item">${esc(s.title)} · ${esc(s.status)}</li>`)
              .join('')}
          </ul>
        </div>`
      : '';

  const replyText = d.lastReplyFull || d.lastReply || '';
  const replyOpen = disc.reply ?? !d.briefing;
  const replyBlock = replyText
    ? `<details class="mc-disclosure" data-disclosure="reply" data-thread-id="${esc(d.id)}"${replyOpen ? ' open' : ''}>
        <summary>Latest reply</summary>
        <div class="mc-disclosure-body mc-md">${renderCleanMarkdown(replyText)}</div>
      </details>`
    : '';

  const eventsHtml =
    d.recentEvents && d.recentEvents.length > 0
      ? `<details class="mc-disclosure" data-disclosure="events" data-thread-id="${esc(d.id)}"${disc.events ? ' open' : ''}>
          <summary>Recent activity (${d.recentEvents.length})</summary>
          <div class="mc-disclosure-body mc-event-list">
            ${d.recentEvents
              .map(
                (ev) => `<div class="mc-event-item">
                  <span class="mc-event-kind">${esc(ev.kind)}</span>
                  <span>${esc(ev.text)}</span>
                </div>`,
              )
              .join('')}
          </div>
        </details>`
      : '';

  const showHostMeta = (ui.snapshot?.hosts?.length || 0) > 1 && Boolean(d.host);

  return `<aside class="mc-detail" aria-label="Conversation details">
    <div class="mc-detail-head">
      <h2 class="mc-detail-title">${esc(d.title)}</h2>
      <button type="button" class="mc-icon-btn" data-action="close-detail" aria-label="Close details" title="Close">${ICON_CLOSE}</button>
    </div>
    <div class="mc-detail-meta">
      <span class="mc-state-cell st-${d.state}">${STATE_ICON[d.state]} ${STATE_LABEL[d.state]}</span>
      ${showHostMeta ? `<span class="mc-host-badge">${esc(d.host)}</span>` : ''}
      <span>${esc(d.projectName)}</span>
      <span class="num">${fmtAge(d.ageMs)}</span>
      <span class="num">${d.stepCount} steps</span>
      ${d.model ? `<span>${esc(d.model)}</span>` : ''}
    </div>
    <div class="mc-detail-actions">
      <button type="button" class="mc-btn" data-action="open" data-id="${esc(d.id)}">${ICON_OPEN} Open in Antigravity</button>
      <button type="button" class="mc-btn" data-action="refresh-brief" data-id="${esc(d.id)}" ${refreshing ? 'disabled' : ''}>${refreshing ? 'Refreshing...' : 'Refresh brief'}</button>
      ${d.state === 'working' ? `<button type="button" class="mc-btn mc-btn-danger" data-action="stop" data-id="${esc(d.id)}">Stop</button>` : ''}
      <button type="button" class="mc-btn" data-action="pin" data-id="${esc(d.id)}">${d.pinned ? 'Unpin' : 'Pin'}</button>
      ${d.slot > 1 ? `<button type="button" class="mc-btn" data-action="move-top" data-id="${esc(d.id)}">Send to top</button>` : ''}
      <button type="button" class="mc-btn" data-action="move-bottom" data-id="${esc(d.id)}">${ICON_BOTTOM} Send to bottom</button>
      <button type="button" class="mc-btn" data-action="hide" data-id="${esc(d.id)}">Hide</button>
      <button type="button" class="mc-btn" data-action="copy-id" data-id="${esc(d.id)}">Copy ID</button>
    </div>
    ${needsCallBlock}
    ${briefingBlock}
    ${nextBlock}
    ${composerBlock}
    ${checklistHtml}
    ${subHtml}
    ${replyBlock}
    ${eventsHtml}
  </aside>`;
}

function render() {
  const root = document.getElementById('root');
  if (!root) return;

  if (!ui.snapshot) {
    root.innerHTML = '<div class="mc-shell"><header class="mc-bar"><div class="mc-bar-group">Mission Control</div></header><div class="mc-empty">Loading conversations...</div></div>';
    return;
  }

  const snap = ui.snapshot;
  const rows = visibleThreads();
  const listHtml =
    ui.view === 'fleet'
      ? renderFleetPane(snap.fleet || [])
      : rows.length > 0
        ? rows.map((item, idx) => renderThreadRow(item, snap.sortMode, idx, rows)).join('')
        : '<div class="mc-empty">No conversations match this filter.</div>';

  const hasDetail = Boolean(ui.detail && ui.view === 'threads');
  const detailHtml = hasDetail && ui.detail ? renderDetailPane(ui.detail) : '';
  const newBarHtml = renderNewBar(snap);

  const renderKey = JSON.stringify({
    bar: { counts: snap.counts, sort: snap.sortMode, filter: ui.filter, hostFilter: ui.hostFilter, view: ui.view, toast: ui.toast, fleet: snap.fleet?.length || 0, hosts: snap.hosts },
    newForm: { open: ui.showNewForm, host: ui.newHost, project: ui.newProject, prompt: ui.newPrompt, creating: ui.creatingNew },
    list: listHtml,
    detail: detailHtml,
    refreshing: ui.refreshingBriefId,
    sending: ui.sendingId,
    sendStatus: ui.sendStatus,
    draft: ui.selectedId ? (ui.drafts[ui.selectedId] || '') : '',
  });

  if (renderKey === ui.lastRenderKey) {
    const clock = document.getElementById('mc-clock');
    if (clock) clock.textContent = fmtClock(snap.generatedAt);
    return;
  }
  ui.lastRenderKey = renderKey;

  const activeEl = document.activeElement as HTMLElement | null;
  const editingComposer =
    activeEl?.classList?.contains('mc-composer-input')
    && (activeEl as HTMLTextAreaElement).dataset.composerId === ui.selectedId
    && hasDetail;
  const editingNewBar =
    ui.showNewForm
    && Boolean(activeEl?.closest?.('.mc-new-bar'));
  if (editingComposer || editingNewBar) {
    const existingList = document.getElementById('mc-list-pane');
    const existingBar = root.querySelector('.mc-bar');
    if (existingList && existingBar) {
      const scroll = existingList.scrollTop;
      existingBar.outerHTML = renderTopBar(snap);
      existingList.innerHTML = listHtml;
      existingList.scrollTop = scroll;
      return;
    }
  }

  const prevList = document.getElementById('mc-list-pane');
  const prevDetail = root.querySelector('.mc-detail');
  const listScroll = prevList ? prevList.scrollTop : 0;
  const detailScroll = prevDetail ? prevDetail.scrollTop : 0;
  const activeKey = (document.activeElement as HTMLElement | null)?.dataset?.focusKey || '';

  root.innerHTML = `<div class="mc-shell">
    ${renderTopBar(snap)}
    <div class="mc-body${hasDetail ? ' has-detail' : ''}">
      <div class="mc-main-col">
        ${newBarHtml}
        <div id="mc-list-pane" class="mc-list-pane" role="grid" aria-label="Conversations">${listHtml}</div>
      </div>
      ${detailHtml}
    </div>
  </div>`;

  const nextList = document.getElementById('mc-list-pane');
  if (nextList) nextList.scrollTop = listScroll;
  const nextDetail = root.querySelector('.mc-detail');
  if (nextDetail) nextDetail.scrollTop = detailScroll;

  if (activeKey) {
    const target = root.querySelector(`[data-focus-key="${CSS.escape(activeKey)}"]`) as HTMLElement | null;
    if (target) target.focus({ preventScroll: true });
  }
}

document.addEventListener('input', (event) => {
  const target = event.target as HTMLElement | null;
  if (target?.classList?.contains('mc-composer-input')) {
    const ta = target as HTMLTextAreaElement;
    const cid = ta.dataset.composerId;
    if (cid) ui.drafts[cid] = ta.value;
    return;
  }
  if (target?.classList?.contains('mc-new-input')) {
    ui.newPrompt = (target as HTMLInputElement).value;
  }
});

document.addEventListener('change', (event) => {
  const sel = event.target as HTMLSelectElement | null;
  if (!sel?.classList?.contains('mc-select')) return;
  const field = sel.dataset.newField;
  if (field === 'host') {
    ui.newHost = sel.value;
    ui.newProject = '';
    render();
  } else if (field === 'project') {
    ui.newProject = sel.value;
  }
});

document.addEventListener(
  'toggle',
  (event) => {
    const det = event.target as HTMLDetailsElement | null;
    if (!det?.classList?.contains('mc-disclosure')) return;
    const tid = det.dataset.threadId;
    const key = det.dataset.disclosure;
    if (!tid || !key) return;
    if (!ui.openDisclosures[tid]) ui.openDisclosures[tid] = {};
    ui.openDisclosures[tid][key] = det.open;
  },
  true,
);

document.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement | null)?.closest('[data-action]') as HTMLElement | null;
  if (!target) return;
  const action = target.dataset.action;
  const id = target.dataset.id || '';

  if (action === 'filter') {
    ui.view = 'threads';
    ui.filter = (target.dataset.filter as FilterMode) || 'all';
    render();
  } else if (action === 'host-filter') {
    ui.view = 'threads';
    ui.hostFilter = target.dataset.host || 'all';
    render();
  } else if (action === 'sort') {
    const sort = target.dataset.sort;
    if (sort) void mutateOrder({ action: 'set_sort', value: sort });
  } else if (action === 'toggle-fleet') {
    ui.view = ui.view === 'fleet' ? 'threads' : 'fleet';
    render();
  } else if (action === 'toggle-new') {
    ui.showNewForm = !ui.showNewForm;
    render();
    if (ui.showNewForm) {
      const inp = document.querySelector<HTMLInputElement>('.mc-new-input');
      if (inp) inp.focus();
    }
  } else if (action === 'create-new') {
    void createNewConversation();
  } else if (action === 'unhide-all') {
    void mutateOrder({ action: 'unhide_all' });
  } else if (action === 'select' && id) {
    void loadThreadDetail(id);
  } else if (action === 'move-bottom' && id) {
    event.stopPropagation();
    void mutateOrder({ action: 'move', conversationId: id, direction: 'bottom' });
  } else if (action === 'move-top' && id) {
    event.stopPropagation();
    void mutateOrder({ action: 'move', conversationId: id, direction: 'top' });
  } else if (action === 'pin' && id) {
    event.stopPropagation();
    void mutateOrder({ action: 'pin', conversationId: id });
  } else if (action === 'hide' && id) {
    event.stopPropagation();
    if (ui.selectedId === id) {
      ui.selectedId = null;
      ui.detail = null;
    }
    void mutateOrder({ action: 'hide', conversationId: id });
  } else if (action === 'open' && id) {
    event.stopPropagation();
    const item = ui.snapshot?.conversations.find((c) => c.id === id) || ui.detail;
    if (item) void focusConversation(item);
  } else if (action === 'refresh-brief' && id) {
    event.stopPropagation();
    void refreshBriefing(id);
  } else if (action === 'stop' && id) {
    event.stopPropagation();
    void stopRunningConversation(id);
  } else if (action === 'run-next' && id) {
    event.stopPropagation();
    const idx = Number(target.dataset.idx || 0);
    const item = ui.snapshot?.conversations.find((c) => c.id === id) || ui.detail;
    const prompt = item?.briefing?.nextActions?.[idx]?.prompt;
    if (prompt) void sendPromptToThread(id, prompt, false);
  } else if (action === 'send-next' && id) {
    event.stopPropagation();
    const idx = Number(target.dataset.idx || 0);
    const item = ui.detail?.id === id ? ui.detail : ui.snapshot?.conversations.find((c) => c.id === id);
    const prompt = item?.briefing?.nextActions?.[idx]?.prompt;
    if (prompt) void sendPromptToThread(id, prompt, false);
  } else if (action === 'edit-next' && id) {
    event.stopPropagation();
    const idx = Number(target.dataset.idx || 0);
    const item = ui.detail?.id === id ? ui.detail : ui.snapshot?.conversations.find((c) => c.id === id);
    const prompt = item?.briefing?.nextActions?.[idx]?.prompt;
    if (prompt) {
      ui.drafts[id] = prompt;
      render();
      const input = document.querySelector<HTMLTextAreaElement>(`.mc-composer-input[data-composer-id="${CSS.escape(id)}"]`);
      if (input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    }
  } else if (action === 'send-custom' && id) {
    event.stopPropagation();
    const ta = document.querySelector<HTMLTextAreaElement>(`.mc-composer-input[data-composer-id="${CSS.escape(id)}"]`);
    const text = ta ? ta.value : (ui.drafts[id] || '');
    void sendPromptToThread(id, text, true);
  } else if (action === 'copy-id' && id) {
    navigator.clipboard?.writeText(id).then(
      () => showToast(`Copied ${id.slice(0, 8)}`),
      () => showToast(id),
    );
  } else if (action === 'dismiss-status') {
    ui.sendStatus = null;
    render();
  } else if (action === 'close-detail') {
    ui.selectedId = null;
    ui.detail = null;
    render();
  }
});

document.addEventListener('keydown', (event) => {
  const el = event.target as HTMLElement | null;
  if (el?.classList?.contains('mc-composer-input')) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      const cid = (el as HTMLTextAreaElement).dataset.composerId || '';
      const val = (el as HTMLTextAreaElement).value;
      if (cid) void sendPromptToThread(cid, val, true);
    }
    return;
  }
  if (el?.classList?.contains('mc-new-input')) {
    if (event.key === 'Enter') {
      event.preventDefault();
      void createNewConversation();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      ui.showNewForm = false;
      render();
    }
    return;
  }

  const tag = el?.tagName || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (event.metaKey || event.ctrlKey) return;

  const rows = visibleThreads();
  if (event.altKey) return;

  if (event.key === 'Escape' && ui.selectedId) {
    event.preventDefault();
    ui.selectedId = null;
    ui.detail = null;
    render();
    return;
  }

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (rows.length === 0 || ui.view !== 'threads') return;
    event.preventDefault();
    const curIdx = rows.findIndex((r) => r.id === ui.selectedId);
    const nextIdx =
      curIdx === -1
        ? 0
        : event.key === 'ArrowDown'
          ? Math.min(rows.length - 1, curIdx + 1)
          : Math.max(0, curIdx - 1);
    void loadThreadDetail(rows[nextIdx].id);
    return;
  }

  if (event.key === 'Enter' && ui.selectedId) {
    const active = document.activeElement as HTMLElement | null;
    if (active && active.tagName === 'BUTTON') return;
    const item = rows.find((r) => r.id === ui.selectedId);
    if (item) {
      event.preventDefault();
      void focusConversation(item);
    }
    return;
  }

  if (event.key.toLowerCase() === 'n' && ui.selectedId) {
    const input = document.querySelector<HTMLTextAreaElement>(`.mc-composer-input[data-composer-id="${CSS.escape(ui.selectedId)}"]`);
    if (input) {
      event.preventDefault();
      input.focus();
    }
    return;
  }

  if (event.key.toLowerCase() === 'b' && ui.selectedId && ui.snapshot?.sortMode === 'fixed') {
    event.preventDefault();
    void mutateOrder({ action: 'move', conversationId: ui.selectedId, direction: 'bottom' });
    return;
  }

  if (event.key.toLowerCase() === 't' && ui.selectedId && ui.snapshot?.sortMode === 'fixed') {
    event.preventDefault();
    void mutateOrder({ action: 'move', conversationId: ui.selectedId, direction: 'top' });
    return;
  }

  if (event.key.toLowerCase() === 'p' && ui.selectedId) {
    event.preventDefault();
    void mutateOrder({ action: 'pin', conversationId: ui.selectedId });
    return;
  }

  const filterKeys: Record<string, FilterMode> = {
    '1': 'all',
    '2': 'attention',
    '3': 'working',
    '4': 'bg',
    '5': 'unread',
    '6': 'idle',
  };
  if (filterKeys[event.key]) {
    event.preventDefault();
    ui.view = 'threads';
    ui.filter = filterKeys[event.key];
    render();
  }
});

// Register all host listeners before connecting.
app.ontoolinput = () => {
  if (!ui.snapshot) render();
};

app.ontoolresult = (result) => {
  ui.hasToolResult = true;
  const sc = result?.structuredContent as BoardSnapshot | undefined;
  if (sc) applySnapshot(sc, true);
};

app.ontoolcancelled = () => {
  ui.pollInFlight = false;
};

app.onhostcontextchanged = (ctx) => {
  applyHostCtx(ctx);
};

async function init() {
  render();
  await app.connect();
  applyHostCtx(app.getHostContext());
  setTimeout(() => {
    if (!ui.hasToolResult) void pollBoard();
  }, 120);
  setInterval(() => {
    void pollBoard();
  }, 2500);
}

void init();
