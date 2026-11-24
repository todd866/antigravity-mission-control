import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps';

type ThreadState = 'attention' | 'working' | 'bg' | 'unread' | 'idle';
type FilterMode = 'all' | ThreadState;
type SortMode = 'fixed' | 'project' | 'state';
type PhaseKind = 'plan' | 'build' | 'test' | 'debug' | 'review' | 'deploy' | 'research' | 'wait' | 'done';
type HealthKind = 'nominal' | 'caution' | 'blocked' | 'ready';

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
  phase?: PhaseKind;
  health?: HealthKind;
  bullets?: string[];
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

interface RelayItem {
  id: string;
  fromConversationId?: string;
  fromLabel: string;
  targetConversationId: string;
  targetTitle: string;
  targetHost: string;
  message: string;
  hop: number;
  status: 'pending' | 'sent' | 'dismissed' | 'failed';
  autoDelivered?: boolean;
  reason: string;
  createdAt: number;
  resolvedAt?: number;
  error?: string;
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
  autoWake?: boolean;
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

interface CommanderAction {
  id: string;
  kind: string;
  label: string;
  summary: string;
  explicitlyRequested: boolean;
  risk: 'low' | 'medium' | 'high';
  params: Record<string, unknown>;
  status: 'pending' | 'executed' | 'dismissed' | 'failed';
  resultMessage?: string;
  executedAt?: number;
}

interface CommanderMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
  model?: string;
  modelTier?: string;
  routingReason?: string;
  inspectedCount?: number;
  actions?: CommanderAction[];
  followUps?: string[];
}

interface CommanderDigest {
  status?: 'nominal' | 'attention' | 'critical';
  headline: string;
  items: string[];
  starterPrompts: string[];
  generatedAt: number;
}

interface CommanderState {
  version: number;
  preferences: {
    routingMode: 'auto' | 'fast' | 'deep';
    directDispatch: boolean;
  };
  digest: CommanderDigest | null;
  messages: CommanderMessage[];
}

interface ProviderPoolInfo {
  engine: string;
  pool: string;
  remainingPct: number | null;
  resetAt: string;
  jobsLeft?: number | null;
  tokensLeft?: number | null;
  freshness: string;
  paused: boolean;
  available: boolean;
  recentlyReset: boolean;
  unavailableReason?: string;
}

interface ProviderSummary {
  available: boolean;
  generatedAt: number;
  source: string;
  paused: string[];
  pools: ProviderPoolInfo[];
  resetAlerts: Array<{
    engine: string;
    pool: string;
    remainingPct: number | null;
    resetAt: string;
    detectedAt: number;
  }>;
  codex?: {
    installed: boolean;
    available: boolean;
    paused: boolean;
    remainingPct: number | null;
    resetAt: string;
    freshness: string;
    recentlyReset: boolean;
    models: string[];
    defaultModels?: { sol: string; astra: string };
    unavailableReason?: string;
  };
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
    pendingRelays?: number;
  };
  conversations: ConversationItem[];
  fleet: FleetItem[];
  relays?: RelayItem[];
  hosts?: HostInfo[];
  projects?: ProjectInfo[];
  providers?: ProviderSummary | null;
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
    '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2 14.4 13.3H1.6L8 2Z" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="8" cy="10.8" r="0.95" fill="currentColor"/><line x1="8" y1="6.1" x2="8" y2="8.9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  working:
    '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-opacity="0.22" stroke-width="1.8"/><path d="M8 2.5A5.5 5.5 0 0 1 13.5 8" class="mc-spin" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><circle cx="8" cy="8" r="1.7" fill="currentColor"/></svg>',
  bg:
    '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.6 2.1"/><circle cx="8" cy="8" r="2.2" fill="currentColor"/></svg>',
  unread:
    '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2.2 13.8 8 8 13.8 2.2 8 8 2.2Z" fill="currentColor"/><circle cx="8" cy="8" r="1.5" fill="var(--mc-bg)"/></svg>',
  idle:
    '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="4.6" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="1.2" fill="currentColor" fill-opacity="0.55"/></svg>',
};

const PHASE_LABEL: Record<PhaseKind, string> = {
  plan: 'Planning',
  build: 'Building',
  test: 'Testing',
  debug: 'Debugging',
  review: 'Review',
  deploy: 'Deploying',
  research: 'Research',
  wait: 'Needs input',
  done: 'Ready',
};

const PHASE_ICON: Record<PhaseKind, string> = {
  plan: '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.4"/><polygon points="10.8,5.2 9,9 5.2,10.8 7,7" fill="currentColor"/></svg>',
  build: '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10.4 3.2a3.2 3.2 0 0 0-3.8 4.4L3 11.2 4.8 13l3.6-3.6a3.2 3.2 0 0 0 4.4-3.8l-1.9 1.9-1.5-1.5 1.9-1.8Z" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/></svg>',
  test: '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 2.5h4M7 2.5v3.6L3.6 12a1.2 1.2 0 0 0 1 1.8h6.8a1.2 1.2 0 0 0 1-1.8L9 6.1V2.5" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  debug: '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8.5" r="4" stroke="currentColor" stroke-width="1.35"/><path d="M8 2.5v2M3 6l2 1M13 6l-2 1M2.5 10h2M11.5 10h2M8 6.5v4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  review: '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M 1.8 8s2.4-4 6.2-4 6.2 4 6.2 4-2.4 4-6.2 4S1.8 8 1.8 8Z" stroke="currentColor" stroke-width="1.35"/><circle cx="8" cy="8" r="1.8" fill="currentColor"/></svg>',
  deploy: '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2.2c2.4 1.6 3.5 4.1 3.5 7l-3.5 2-3.5-2c0-2.9 1.1-5.4 3.5-7Z" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/><path d="M6 12.2 5 14M10 12.2l1 1.8" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/></svg>',
  research: '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="4.2" stroke="currentColor" stroke-width="1.4"/><path d="M10.2 10.2 13.5 13.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  wait: '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.35"/><path d="M8 5v3.3l2.2 1.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  done: '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3.5 8.3 2.9 2.9 6.1-6.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

const ICON_PIN =
  '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M 5.5 2.5h5l-.6 4.2 2.1 2.1v1.2H8.7v3.5l-.7.8-.7-.8V10H4V8.8l2.1-2.1-.6-4.2Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" fill="currentColor" fill-opacity="var(--pin-fill, 0)"/></svg>';
const ICON_BOTTOM =
  '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2.5v7.5M4.8 7.2 8 10.4l3.2-3.2M3.5 13h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_TOP =
  '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 13.5V6M4.8 8.8 8 5.6l3.2 3.2M3.5 3h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_CLOSE =
  '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const ICON_OPEN =
  '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3.5h6.5V10M12.2 3.8 4.5 11.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_REFRESH =
  '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.3-3.4M13 2.5v2.8h-2.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_BOLT =
  '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8.8 2 4 8.8h3.6L6.8 14l5.2-7H8.4L8.8 2Z" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/></svg>';
const ICON_STOP =
  '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.4" fill="currentColor"/></svg>';
const ICON_COPY =
  '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5.5" y="5.5" width="7" height="7.5" rx="1.2" stroke="currentColor" stroke-width="1.3"/><path d="M10.5 3.5h-6a1 1 0 0 0-1 1v6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
const ICON_SEARCH =
  '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.4"/><path d="m10.5 10.5 3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
const ICON_HELP =
  '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.8" stroke="currentColor" stroke-width="1.35"/><path d="M6.3 6.2a1.8 1.8 0 0 1 3.4.6c0 1.1-1.7 1.4-1.7 2.4" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/><circle cx="8" cy="11.4" r="0.75" fill="currentColor"/></svg>';
const ICON_SPARK =
  '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2 9.4 6.6 14 8l-4.6 1.4L8 14 6.6 9.4 2 8l4.6-1.4L8 2Z" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/></svg>';
const ICON_RELAY =
  '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 5.5h8.5m0 0-2-2m2 2-2 2M13 10.5H4.5m0 0 2-2m-2 2 2 2" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_CLI =
  '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4.2 5.2 3 2.8-3 2.8M8.4 11h3.4" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/></svg>';

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

function effectivePhase(item: ConversationItem): PhaseKind {
  const p = item.briefing?.phase;
  if (p && PHASE_ICON[p]) return p;
  if (item.state === 'attention') return 'wait';
  if (item.state === 'working') return 'build';
  if (item.state === 'bg') return 'test';
  return 'done';
}

function modelShortChip(rawModel?: string): { code: string; label: string } {
  const m = String(rawModel || '').trim().toLowerCase();
  if (!m) return { code: '', label: '' };
  if (m.includes('neon')) return { code: 'N', label: rawModel || 'Neon' };
  if (m.includes('carbon')) return { code: 'C', label: rawModel || 'Carbon' };
  if (m.includes('flash')) return { code: 'F', label: rawModel || 'Flash' };
  if (m.includes('hydrogen')) return { code: 'H', label: rawModel || 'Hydrogen' };
  if (m.includes('opus')) return { code: 'O', label: rawModel || 'Opus' };
  if (m.includes('sonnet')) return { code: 'S', label: rawModel || 'Sonnet' };
  return { code: m[0].toUpperCase(), label: rawModel || m };
}

function actionKindIcon(kind: string): string {
  if (kind === 'send_to_agent' || kind === 'start_new_agent') return ICON_OPEN;
  if (kind === 'relay_to_agent' || kind === 'approve_relay' || kind === 'dismiss_relay') return ICON_RELAY;
  if (kind === 'stop_agent') return ICON_STOP;
  if (kind === 'toggle_auto_wake') return ICON_BOLT;
  return ICON_CLI;
}

const ui = {
  snapshot: null as BoardSnapshot | null,
  filter: 'all' as FilterMode,
  hostFilter: 'all' as string,
  view: 'threads' as 'threads' | 'fleet' | 'relay' | 'commander',
  selectedId: null as string | null,
  detail: null as ConversationItem | null,
  refreshingBriefId: null as string | null,
  sendingId: null as string | null,
  relayActionId: null as string | null,
  commander: null as CommanderState | null,
  commanderDraft: '',
  commanderSending: false,
  commanderDigestBusy: false,
  commanderActionBusyId: null as string | null,
  commanderEditId: null as string | null,
  commanderEditDraft: '',
  showNewForm: false,
  newHost: '' as string,
  newProject: '' as string,
  newPrompt: '' as string,
  creatingNew: false,
  findOpen: false,
  findQuery: '',
  paletteOpen: false,
  paletteQuery: '',
  paletteIndex: 0,
  helpOpen: false,
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
  const q = ui.findQuery.trim().toLowerCase();
  if (q) {
    list = list.filter((c) => {
      const hay = `${c.title} ${c.projectName} ${c.host || ''} ${c.model || ''} ${c.waitingReason} ${c.briefing?.headline || ''} ${c.focus}`.toLowerCase();
      return hay.includes(q);
    });
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
        text: act.ok ? 'Sent, agent is responding' : msg,
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
  ui.sendStatus = { conversationId, kind: 'sending', text: 'Sending prompt to Antigravity' };
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
      ui.sendStatus = { conversationId, kind: 'sent', text: 'Sent, agent is responding' };
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

async function approveRelayAction(relayId: string, host?: string, editedText?: string) {
  if (!relayId || ui.relayActionId) return;
  ui.relayActionId = relayId;
  render();
  try {
    const args: Record<string, string> = { relayId };
    if (host) args.host = host;
    if (editedText && editedText.trim()) args.text = editedText.trim();
    const res = await app.callServerTool({ name: 'approve_relay', arguments: args });
    const sc = res?.structuredContent as { ok?: boolean; message?: string; error?: string } | undefined;
    showToast(sc?.ok ? (sc.message || 'Sent relay') : (sc?.error || 'Could not send relay'));
    if (sc?.ok) scheduleRapidRefresh();
    else void pollBoard();
  } catch {
    showToast('Could not send relay');
  } finally {
    ui.relayActionId = null;
    render();
  }
}

async function dismissRelayAction(relayId: string, host?: string) {
  if (!relayId || ui.relayActionId) return;
  ui.relayActionId = relayId;
  render();
  try {
    const res = await app.callServerTool({
      name: 'dismiss_relay',
      arguments: host ? { relayId, host } : { relayId },
    });
    const sc = res?.structuredContent as { ok?: boolean; message?: string; error?: string } | undefined;
    showToast(sc?.ok ? (sc.message || 'Dismissed relay') : (sc?.error || 'Could not dismiss relay'));
    void pollBoard();
  } catch {
    showToast('Could not dismiss relay');
  } finally {
    ui.relayActionId = null;
    render();
  }
}

async function toggleAutoWakeAction(item: ConversationItem) {
  try {
    const res = await app.callServerTool({
      name: 'toggle_auto_wake',
      arguments: item.host ? { conversationId: item.id, host: item.host } : { conversationId: item.id },
    });
    const sc = res?.structuredContent as { ok?: boolean; autoWake?: boolean; message?: string; error?: string } | undefined;
    if (sc?.ok) {
      if (ui.detail?.id === item.id) {
        ui.detail = { ...ui.detail, autoWake: Boolean(sc.autoWake) };
      }
      if (ui.snapshot) {
        ui.snapshot = {
          ...ui.snapshot,
          conversations: ui.snapshot.conversations.map((c) =>
            c.id === item.id ? { ...c, autoWake: Boolean(sc.autoWake) } : c,
          ),
        };
      }
      showToast(sc.message || (sc.autoWake ? 'Auto-wake enabled' : 'Auto-wake disabled'));
      void pollBoard();
    } else {
      showToast(sc?.error || 'Could not update auto-wake');
    }
  } catch {
    showToast('Could not update auto-wake');
  }
}

async function ensureCommanderLoaded() {
  if (!ui.commander) {
    try {
      const res = await app.callServerTool({ name: 'get_commander_state', arguments: {} });
      const sc = res?.structuredContent as { ok?: boolean; state?: CommanderState } | undefined;
      if (sc?.state) {
        ui.commander = sc.state;
        render();
      }
    } catch {
      // Keep UI responsive even before host replies.
    }
  }
  if (!ui.commander?.digest && !ui.commanderDigestBusy) {
    void refreshCommanderDigest(false);
  }
}

async function refreshCommanderDigest(force = false) {
  if (ui.commanderDigestBusy) return;
  ui.commanderDigestBusy = true;
  render();
  try {
    const res = await app.callServerTool({ name: 'get_commander_digest', arguments: { force } });
    const sc = res?.structuredContent as { ok?: boolean; state?: CommanderState; error?: string } | undefined;
    if (sc?.state) ui.commander = sc.state;
    else if (sc?.error) showToast(sc.error);
  } catch {
    showToast('Could not load Commander digest');
  } finally {
    ui.commanderDigestBusy = false;
    render();
  }
}

async function sendCommanderPrompt(overrideText?: string) {
  const clean = String(overrideText ?? ui.commanderDraft).trim();
  if (!clean || ui.commanderSending) return;
  if (overrideText === undefined) ui.commanderDraft = '';
  ui.commanderSending = true;
  render();
  try {
    const res = await app.callServerTool({
      name: 'send_commander_message',
      arguments: {
        text: clean,
        routingMode: ui.commander?.preferences?.routingMode || 'auto',
        directDispatch: Boolean(ui.commander?.preferences?.directDispatch),
      },
    });
    const sc = res?.structuredContent as { ok?: boolean; state?: CommanderState; error?: string } | undefined;
    if (sc?.state) {
      ui.commander = sc.state;
      void pollBoard();
    } else if (sc?.error) {
      showToast(sc.error);
    }
  } catch {
    showToast('Commander request failed');
  } finally {
    ui.commanderSending = false;
    render();
    const scroller = document.getElementById('mc-ai-scroll');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }
}

async function executeCommanderActionUi(actionId: string, editedText?: string) {
  if (!actionId || ui.commanderActionBusyId) return;
  ui.commanderActionBusyId = actionId;
  render();
  try {
    const args: Record<string, string> = { actionId };
    if (editedText && editedText.trim()) args.editedText = editedText.trim();
    const res = await app.callServerTool({ name: 'execute_commander_action', arguments: args });
    const sc = res?.structuredContent as { ok?: boolean; message?: string; error?: string; state?: CommanderState } | undefined;
    if (sc?.state) ui.commander = sc.state;
    ui.commanderEditId = null;
    ui.commanderEditDraft = '';
    showToast(sc?.ok ? (sc.message || 'Action completed') : (sc?.error || 'Action failed'));
    void pollBoard();
  } catch {
    showToast('Action failed');
  } finally {
    ui.commanderActionBusyId = null;
    render();
  }
}

async function dismissCommanderActionUi(actionId: string) {
  if (!actionId || ui.commanderActionBusyId) return;
  ui.commanderActionBusyId = actionId;
  render();
  try {
    const res = await app.callServerTool({ name: 'dismiss_commander_action', arguments: { actionId } });
    const sc = res?.structuredContent as { ok?: boolean; state?: CommanderState; error?: string } | undefined;
    if (sc?.state) ui.commander = sc.state;
    if (ui.commanderEditId === actionId) {
      ui.commanderEditId = null;
      ui.commanderEditDraft = '';
    }
  } catch {
    showToast('Could not skip action');
  } finally {
    ui.commanderActionBusyId = null;
    render();
  }
}

async function updateCommanderSettingsUi(patch: { routingMode?: 'auto' | 'fast' | 'deep'; directDispatch?: boolean }) {
  try {
    const res = await app.callServerTool({ name: 'update_commander_settings', arguments: patch });
    const sc = res?.structuredContent as { ok?: boolean; state?: CommanderState } | undefined;
    if (sc?.state) {
      ui.commander = sc.state;
      render();
    }
  } catch {
    showToast('Could not save setting');
  }
}

async function clearCommanderChatUi() {
  try {
    const res = await app.callServerTool({ name: 'clear_commander_chat', arguments: {} });
    const sc = res?.structuredContent as { ok?: boolean; state?: CommanderState } | undefined;
    if (sc?.state) {
      ui.commander = sc.state;
      ui.commanderEditId = null;
      ui.commanderEditDraft = '';
      render();
    }
  } catch {
    showToast('Could not reset chat');
  }
}

function renderTopBar(snap: BoardSnapshot): string {
  const c = snap.counts;
  const filters: Array<{ key: FilterMode; label: string; count: number; icon: string; keyHint: string }> = [
    { key: 'all', label: 'All', count: c.total, icon: '', keyHint: '1' },
    { key: 'attention', label: 'Waiting', count: c.attention, icon: STATE_ICON.attention, keyHint: '2' },
    { key: 'working', label: 'Working', count: c.working, icon: STATE_ICON.working, keyHint: '3' },
    { key: 'bg', label: 'Background', count: c.bg, icon: STATE_ICON.bg, keyHint: '4' },
    { key: 'unread', label: 'Unread', count: c.unread, icon: STATE_ICON.unread, keyHint: '5' },
    { key: 'idle', label: 'Idle', count: c.idle, icon: STATE_ICON.idle, keyHint: '6' },
  ];

  const filterHtml = filters
    .map((f) => {
      const active = ui.view === 'threads' && ui.filter === f.key;
      const cls = f.key === 'all' ? '' : f.count === 0 ? 'is-zero' : `st-${f.key}`;
      const labelSpan = f.key === 'all' ? '<span>All</span>' : `<span class="mc-filter-label">${f.label}</span>`;
      return `<button type="button" class="mc-filter-btn ${cls}" data-action="filter" data-filter="${f.key}" data-focus-key="filter:${f.key}" aria-pressed="${active}" aria-label="${f.label} (${f.count})" title="${f.label} (${f.count}) [${f.keyHint}]">
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
      ? `<button type="button" class="mc-btn" data-action="toggle-fleet" data-focus-key="fleet" aria-pressed="${ui.view === 'fleet'}" title="Local CLI agents">${ICON_CLI}<span>${fleetCount}</span></button>`
      : '';

  const relays = snap.relays || [];
  const pendingRelaysCount = relays.filter((r) => r.status === 'pending').length;
  const relayBtn =
    relays.length > 0 || ui.view === 'relay'
      ? `<button type="button" class="mc-btn${pendingRelaysCount > 0 ? ' is-relay-pending' : ''}" data-action="toggle-relay" data-focus-key="relay" aria-pressed="${ui.view === 'relay'}" title="Agent Relay messages (Cmd+3)">${ICON_RELAY}${pendingRelaysCount > 0 ? ` <span class="num">${pendingRelaysCount}</span>` : ' <span>Relay</span>'}</button>`
      : '';

  const hiddenBtn =
    c.hidden > 0
      ? `<button type="button" class="mc-btn" data-action="unhide-all" data-focus-key="unhide" title="Restore hidden conversations">Show <span class="num">${c.hidden}</span></button>`
      : '';

  const aiBtn = `<button type="button" class="mc-btn${ui.commanderSending ? ' is-autowake-on' : ''}" data-action="toggle-commander" data-focus-key="commander" aria-pressed="${ui.view === 'commander'}" title="AI Commander (Cmd+2)">${ICON_SPARK}<span>AI</span></button>`;

  const toastHtml = ui.toast ? `<span class="mc-toast" title="${esc(ui.toast)}">${esc(ui.toast)}</span>` : '';

  const teleSegments = [
    { key: 'attention', count: c.attention, label: 'Waiting' },
    { key: 'working', count: c.working, label: 'Working' },
    { key: 'bg', count: c.bg, label: 'Background' },
    { key: 'unread', count: c.unread, label: 'Unread' },
    { key: 'idle', count: c.idle, label: 'Idle' },
  ]
    .filter((s) => s.count > 0)
    .map((s) => `<span class="mc-tele-seg st-${s.key}" style="flex-grow:${s.count}" title="${s.count} ${s.label}"></span>`)
    .join('');

  return `<div class="mc-bar-wrap">
    <header class="mc-bar">
      <div class="mc-bar-group">${filterHtml}${hostSegHtml}</div>
      <div class="mc-bar-right">
        ${toastHtml}
        <button type="button" class="mc-icon-btn is-bordered" data-action="toggle-find" aria-pressed="${ui.findOpen}" title="Find threads (/ or Cmd+F)" aria-label="Find">${ICON_SEARCH}</button>
        <button type="button" class="mc-btn" data-action="toggle-new" data-focus-key="new-btn" aria-pressed="${ui.showNewForm}" title="Start new conversation">+ New</button>
        ${aiBtn}
        ${relayBtn}
        ${fleetBtn}
        ${hiddenBtn}
        <div class="mc-seg mc-bar-sort" role="group" aria-label="Sort order">${sortHtml}</div>
        <button type="button" class="mc-icon-btn" data-action="toggle-help" aria-pressed="${ui.helpOpen}" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">${ICON_HELP}</button>
        <span id="mc-clock" class="mc-clock num">${fmtClock(snap.generatedAt)}</span>
      </div>
    </header>
    <div class="mc-telemetry-bar" aria-hidden="true">${teleSegments}</div>
  </div>`;
}

function renderFindBar(matchCount: number, totalCount: number): string {
  if (!ui.findOpen && !ui.findQuery) return '';
  return `<div class="mc-find-float" role="search" aria-label="Find threads">
    ${ICON_SEARCH}
    <input type="text" class="mc-find-input" value="${esc(ui.findQuery)}" placeholder="Filter title, project, or model">
    <span class="mc-find-count num">${matchCount}/${totalCount}</span>
    <button type="button" class="mc-icon-btn" data-action="close-find" aria-label="Close find" title="Close (Esc)">${ICON_CLOSE}</button>
  </div>`;
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
    <input type="text" class="mc-new-input" data-new-field="prompt" value="${esc(ui.newPrompt)}" placeholder="Write a prompt to start a new Antigravity conversation">
    <button type="button" class="mc-btn mc-btn-primary" data-action="create-new" ${ui.creatingNew ? 'disabled' : ''}>${ui.creatingNew ? 'Starting' : 'Start'}</button>
    <button type="button" class="mc-btn" data-action="toggle-new">Cancel</button>
  </div>`;
}

function renderStepGauge(item: ConversationItem): string {
  if (!item.steps || item.steps.total <= 0) {
    return '<span class="mc-step-ratio num">—</span>';
  }
  const { done, total, items } = item.steps;
  if (total <= 10 && items && items.length > 0) {
    const segs = items
      .slice(0, 10)
      .map((s) => `<span class="mc-step-seg is-${esc(s.status)}"></span>`)
      .join('');
    return `<div class="mc-step-segs" aria-hidden="true">${segs}</div>
      <span class="mc-step-ratio num">${done}/${total}</span>`;
  }
  const pct = Math.round((done / total) * 100);
  const fillCls = done === total ? 'mc-bar-fill is-done' : 'mc-bar-fill';
  return `<div class="mc-bar-track" aria-hidden="true"><div class="${fillCls}" style="width:${pct}%"></div></div>
    <span class="mc-step-ratio num">${done}/${total}</span>`;
}

function renderThreadRow(item: ConversationItem): string {
  const focusText =
    item.waitingReason
    || item.briefing?.headline
    || (item.focusIsCurrentTurn ? item.focus : '')
    || item.lastReply
    || '—';
  const focusCls = item.waitingReason ? 'mc-focus-cell is-attention' : 'mc-focus-cell';

  const next0 = item.state !== 'working' ? item.briefing?.nextActions?.[0] : undefined;
  const nextPillHtml = next0
    ? `<button type="button" class="mc-next-pill" data-action="run-next" data-id="${esc(item.id)}" data-idx="0" data-focus-key="next:${esc(item.id)}" title="Send now: ${esc(next0.prompt)}">▶ ${esc(next0.label)}</button>`
    : '';

  const phase = effectivePhase(item);
  const phaseChipHtml = `<span class="mc-phase-chip is-${phase}" title="Phase: ${PHASE_LABEL[phase]}">${PHASE_ICON[phase]}</span>`;

  const subTag = item.subagentCount > 0 ? ` · ${item.subagentCount} sub` : '';
  const showHostBadge = (ui.snapshot?.hosts?.length || 0) > 1 && ui.hostFilter === 'all' && Boolean(item.host);
  const hostBadgeHtml = showHostBadge ? `<span class="mc-host-badge">${esc(item.host)}</span>` : '';
  const modelChip = modelShortChip(item.model);
  const modelChipHtml = modelChip.code
    ? `<span class="mc-model-chip" title="${esc(modelChip.label)}">${esc(modelChip.code)}</span>`
    : '';

  const pendingRowRelays = (ui.snapshot?.relays || []).filter(
    (r) => r.status === 'pending' && r.targetConversationId === item.id,
  ).length;
  const wakeBadgeHtml = item.autoWake
    ? `<span class="mc-wake-badge" title="Guarded agent Auto-wake enabled">${ICON_BOLT}</span>`
    : '';
  const relayRowBadgeHtml = pendingRowRelays > 0
    ? `<span class="mc-relay-badge" title="${pendingRowRelays} pending agent relay">${pendingRowRelays}</span>`
    : '';
  const stepTitle = item.steps?.currentTitle ? `${item.steps.done}/${item.steps.total}: ${item.steps.currentTitle}` : '';
  const selected = ui.selectedId === item.id;
  const pinDotHtml = item.pinned ? '<span class="mc-pin-dot" title="Pinned"></span>' : '';

  return `<div class="mc-row${selected ? ' is-selected' : ''}" role="row" tabindex="0" data-action="select" data-id="${esc(item.id)}" data-focus-key="row:${esc(item.id)}">
    <div class="mc-slot-cell">${pinDotHtml}<span class="mc-slot-num num">${item.slot}</span></div>
    <div class="mc-state-cell st-${item.state}" aria-label="${STATE_LABEL[item.state]}" title="${esc(item.waitingReason || STATE_LABEL[item.state])}">
      ${STATE_ICON[item.state]}
    </div>
    <div class="mc-title-cell">
      <div class="mc-title-line">
        ${phaseChipHtml}
        <span class="mc-title">${esc(item.title)}</span>
      </div>
      <div class="mc-title-meta">
        <span class="mc-project">${esc(item.projectName)}${esc(subTag)}</span>
        ${hostBadgeHtml}
        ${modelChipHtml}
        ${wakeBadgeHtml}
        ${relayRowBadgeHtml}
      </div>
    </div>
    <div class="${focusCls}">
      <span class="mc-focus-text">${esc(focusText)}</span>
      ${nextPillHtml}
    </div>
    <div class="mc-steps-cell" title="${esc(stepTitle)}">${renderStepGauge(item)}</div>
    <div class="mc-age-cell num${item.stalled ? ' is-stalled' : ''}" title="${item.stalled ? 'Working without update over 5m' : ''}">${fmtAge(item.ageMs)}</div>
    <div class="mc-actions-cell">
      <button type="button" class="mc-icon-btn" data-action="open" data-id="${esc(item.id)}" data-focus-key="open:${esc(item.id)}" aria-label="Open ${esc(item.title)}" title="Focus in Antigravity">${ICON_OPEN}</button>
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

function renderRelayPane(relays: RelayItem[]): string {
  const pending = relays.filter((r) => r.status === 'pending');
  const recent = relays.filter((r) => r.status !== 'pending');
  if (relays.length === 0) {
    return '<div class="mc-empty">No agent relay messages yet.</div>';
  }

  const pendingHtml =
    pending.length > 0
      ? pending
          .map((r) => {
            const busy = ui.relayActionId === r.id;
            const age = fmtAge(Math.max(0, Date.now() - Number(r.createdAt || 0)));
            return `<div class="mc-relay-card is-pending">
              <div class="mc-relay-head">
                <div class="mc-relay-route">
                  ${ICON_RELAY}
                  <strong>${esc(r.fromLabel)}</strong> → <strong>${esc(r.targetTitle)}</strong>
                  ${r.targetHost ? `<span class="mc-host-badge">${esc(r.targetHost)}</span>` : ''}
                  <span class="num mc-relay-age">${age}</span>
                </div>
                <div class="mc-relay-actions">
                  <button type="button" class="mc-btn mc-btn-xs mc-btn-primary" data-action="approve-relay" data-id="${esc(r.id)}" data-host="${esc(r.targetHost)}" ${busy ? 'disabled' : ''}>${busy ? 'Sending' : 'Approve & Send'}</button>
                  <button type="button" class="mc-btn mc-btn-xs" data-action="edit-relay-in-tab" data-id="${esc(r.id)}" data-target-id="${esc(r.targetConversationId)}">Edit in tab</button>
                  <button type="button" class="mc-btn mc-btn-xs" data-action="dismiss-relay" data-id="${esc(r.id)}" data-host="${esc(r.targetHost)}" ${busy ? 'disabled' : ''}>Dismiss</button>
                </div>
              </div>
              <p class="mc-relay-msg">${esc(r.message)}</p>
              <div class="mc-relay-reason">${esc(r.reason)}</div>
              ${r.error ? `<div class="mc-relay-error">${esc(r.error)}</div>` : ''}
            </div>`;
          })
          .join('')
      : '<div class="mc-empty">No pending agent messages waiting for approval.</div>';

  const recentHtml =
    recent.length > 0
      ? `<details class="mc-disclosure mc-relay-history">
          <summary>Recent relays (${recent.length})</summary>
          <div class="mc-disclosure-body mc-relay-list">
            ${recent
              .map((r) => {
                const age = fmtAge(Math.max(0, Date.now() - Number(r.resolvedAt || r.createdAt || 0)));
                return `<div class="mc-relay-card">
                  <div class="mc-relay-head">
                    <div class="mc-relay-route">
                      <span class="mc-tag-muted">${esc(r.status)}</span>
                      <strong>${esc(r.fromLabel)}</strong> → <strong>${esc(r.targetTitle)}</strong>
                      ${r.targetHost ? `<span class="mc-host-badge">${esc(r.targetHost)}</span>` : ''}
                    </div>
                    <span class="num mc-relay-age">${age}</span>
                  </div>
                  <p class="mc-relay-msg">${esc(r.message)}</p>
                  <div class="mc-relay-reason">${esc(r.reason)}</div>
                </div>`;
              })
              .join('')}
          </div>
        </details>`
      : '';

  return `<div class="mc-relay-pane">${pendingHtml}${recentHtml}</div>`;
}

function getActionEditDefault(act: CommanderAction): string {
  const p = act.params || {};
  return String(p.text ?? p.message ?? p.note ?? act.summary ?? '');
}

function renderCommanderActionCard(act: CommanderAction): string {
  const busy = ui.commanderActionBusyId === act.id;
  const editing = ui.commanderEditId === act.id;
  const riskLabel = act.risk === 'high' ? 'Confirm + high impact' : act.risk === 'medium' ? 'Agent action' : 'Safe action';
  const cardCls = `mc-ai-action-card risk-${act.risk}${act.status === 'executed' ? ' is-executed' : ''}`;

  let controlsHtml = '';
  if (act.status === 'pending' || act.status === 'failed') {
    if (editing) {
      controlsHtml = `<div class="mc-relay-actions">
        <button type="button" class="mc-btn mc-btn-xs mc-btn-primary" data-action="ai-action-save-run" data-id="${esc(act.id)}" ${busy ? 'disabled' : ''}>${busy ? 'Running' : 'Save & Run'}</button>
        <button type="button" class="mc-btn mc-btn-xs" data-action="ai-action-cancel-edit" data-id="${esc(act.id)}" ${busy ? 'disabled' : ''}>Cancel</button>
      </div>`;
    } else {
      const canEdit = ['send_to_agent', 'relay_to_agent', 'start_new_agent', 'approve_relay', 'fleet_mail', 'fleet_snooze'].includes(act.kind);
      controlsHtml = `<div class="mc-relay-actions">
        <button type="button" class="mc-btn mc-btn-xs mc-btn-primary" data-action="ai-action-run" data-id="${esc(act.id)}" ${busy ? 'disabled' : ''}>${busy ? 'Running' : 'Run'}</button>
        ${canEdit ? `<button type="button" class="mc-btn mc-btn-xs" data-action="ai-action-edit" data-id="${esc(act.id)}" ${busy ? 'disabled' : ''}>Edit</button>` : ''}
        <button type="button" class="mc-btn mc-btn-xs" data-action="ai-action-dismiss" data-id="${esc(act.id)}" ${busy ? 'disabled' : ''}>Skip</button>
      </div>`;
    }
  } else {
    const statusLabel = act.status === 'executed' ? 'Done' : 'Skipped';
    controlsHtml = `<span class="mc-tag-muted">${statusLabel}</span>`;
  }

  return `<div class="${cardCls}">
    <div class="mc-ai-action-head">
      <div class="mc-ai-action-title">
        <span class="mc-risk-dot is-${act.risk}" title="${riskLabel}"></span>
        ${actionKindIcon(act.kind)}
        <span>${esc(act.label)}</span>
      </div>
      ${controlsHtml}
    </div>
    <div class="mc-ai-action-summary">${esc(act.summary)}</div>
    ${editing ? `<textarea class="mc-ai-edit-area" data-ai-edit-id="${esc(act.id)}" rows="2">${esc(ui.commanderEditDraft)}</textarea>` : ''}
    ${act.resultMessage ? `<div class="mc-relay-reason">${esc(act.resultMessage)}</div>` : ''}
  </div>`;
}

function renderProviderPills(providers?: ProviderSummary | null): string {
  if (!providers) return '';
  const grouped = new Map<string, ProviderPoolInfo[]>();
  for (const p of providers.pools || []) {
    if (p.paused || p.remainingPct === null) continue;
    const eng = p.engine.toLowerCase();
    const arr = grouped.get(eng) || [];
    arr.push(p);
    grouped.set(eng, arr);
  }

  const byEngine = new Map<string, ProviderPoolInfo>();
  for (const [eng, list] of grouped.entries()) {
    let chosen: ProviderPoolInfo;
    if (eng === 'cursor') {
      chosen = list.reduce((best, cur) => ((cur.remainingPct ?? -1) > (best.remainingPct ?? -1) ? cur : best));
    } else {
      const scoped = eng === 'gemini' ? list.filter((p) => p.pool === 'week' || p.pool === '5h') : list;
      const cand = scoped.length > 0 ? scoped : list;
      chosen = cand.reduce((low, cur) => ((cur.remainingPct ?? 999) < (low.remainingPct ?? 999) ? cur : low));
    }
    byEngine.set(eng, chosen);
  }

  if (providers.codex?.available && !byEngine.has('codex')) {
    byEngine.set('codex', {
      engine: 'codex',
      pool: 'codex:primary',
      remainingPct: providers.codex.remainingPct,
      resetAt: providers.codex.resetAt || '',
      freshness: providers.codex.freshness || 'unknown',
      paused: false,
      available: true,
      recentlyReset: Boolean(providers.codex.recentlyReset),
    });
  }
  const order = ['codex', 'gemini', 'cursor', 'zai'];
  const entries = Array.from(byEngine.entries()).sort((a, b) => {
    const ai = order.indexOf(a[0]);
    const bi = order.indexOf(b[0]);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
  if (entries.length === 0) return '';

  const codexModels = providers.codex?.defaultModels
    ? `${providers.codex.defaultModels.astra} / ${providers.codex.defaultModels.sol}`
    : '';
  const pills = entries.slice(0, 4).map(([eng, pool]) => {
    const pct = pool.remainingPct === null ? '' : `${Math.round(pool.remainingPct)}%`;
    const isWarn = pool.remainingPct !== null && pool.remainingPct < 25;
    const isReset = Boolean(pool.recentlyReset && !isWarn);
    const cls = isReset ? ' is-reset' : isWarn ? ' is-warn' : '';
    const allForEng = grouped.get(eng) || [pool];
    const poolBreakdown = allForEng
      .map((item) => `${item.pool} ${item.remainingPct !== null ? `${Math.round(item.remainingPct)}%` : 'ok'}`)
      .join(', ');
    const extraTip = eng === 'codex' && codexModels ? ` | Models: ${codexModels}` : '';
    const resetTip = isReset ? ' | Recently reset' : '';
    const tip = `${eng.toUpperCase()}: ${poolBreakdown}${resetTip}${pool.resetAt ? ` | Resets ${pool.resetAt}` : ''}${extraTip}`;
    const resetTag = isReset ? '<span class="mc-pool-tag">Reset</span>' : '';
    return `<div class="mc-pool-pill${cls}" title="${esc(tip)}"><span class="mc-pool-dot"></span><span class="mc-pool-name">${esc(eng)}</span>${pct ? `<span class="num">${esc(pct)}</span>` : ''}${resetTag}</div>`;
  });
  return `<div class="mc-ai-pools">${pills.join('')}</div>`;
}

function renderCommanderPane(snap: BoardSnapshot): string {
  const cmdState: CommanderState = ui.commander || {
    version: 1,
    preferences: { routingMode: 'auto', directDispatch: false },
    digest: null,
    messages: [],
  };
  const prefs = cmdState.preferences;
  const hosts = snap.hosts || [];
  const pendingRelays = (snap.relays || []).filter((r) => r.status === 'pending').length;

  const nodesHtml =
    hosts.length > 0
      ? `<div class="mc-ai-nodes">${hosts
          .map((h) => {
            const countTxt = h.conversationCount !== undefined ? `<span class="num">${h.conversationCount}</span>` : '';
            return `<div class="mc-node-card" title="${h.online ? 'Connected' : esc(h.error || 'Offline')}">
              <span class="mc-host-dot ${h.online ? 'is-on' : 'is-off'}"></span>
              <span class="mc-node-name">${esc(h.name)}</span>
              ${countTxt}
            </div>`;
          })
          .join('')}</div>`
      : '';
  const poolsHtml = renderProviderPills(snap.providers);

  const digest = cmdState.digest;
  const digestStatus = digest?.status || (snap.counts.attention > 0 || pendingRelays > 0 ? 'attention' : 'nominal');
  const starterDefaults = ['Triage waiting', 'Active agents', 'Pending relays'];
  const starters = digest?.starterPrompts?.length ? digest.starterPrompts : starterDefaults;

  const digestCard = digest
    ? `<div class="mc-ai-digest">
        <div class="mc-ai-digest-head">
          <div class="mc-ai-digest-title-row">
            <span class="mc-health-dot is-${esc(digestStatus)}"></span>
            <span class="mc-ai-digest-title">${esc(digest.headline)}</span>
          </div>
          <span class="num mc-relay-age">${fmtClock(digest.generatedAt)}</span>
        </div>
        <ul class="mc-ai-digest-list">
          ${(digest.items || []).slice(0, 3).map((it) => `<li>${esc(it)}</li>`).join('')}
        </ul>
      </div>`
    : `<div class="mc-ai-digest">
        <div class="mc-ai-digest-head">
          <div class="mc-ai-digest-title-row">
            <span class="mc-health-dot is-nominal"></span>
            <span class="mc-ai-digest-title">AI Commander</span>
          </div>
          <span class="mc-tag-muted">${ui.commanderDigestBusy ? 'Updating' : 'Ready'}</span>
        </div>
      </div>`;

  const quickTiles = [
    {
      icon: STATE_ICON.attention,
      tone: snap.counts.attention > 0 ? 'is-attention' : '',
      title: starters[0] || 'Triage waiting',
      sub: `${snap.counts.attention} waiting`,
    },
    {
      icon: STATE_ICON.working,
      tone: '',
      title: starters[1] || 'Active agents',
      sub: `${snap.counts.working + snap.counts.bg} running`,
    },
    {
      icon: ICON_RELAY,
      tone: pendingRelays > 0 ? 'is-attention' : '',
      title: starters[2] || 'Pending relays',
      sub: `${pendingRelays} awaiting approval`,
    },
    {
      icon: ICON_SPARK,
      tone: 'is-unread',
      title: 'Draft next steps',
      sub: `${snap.counts.unread + snap.counts.idle} ready`,
    },
  ];

  const launchGridHtml =
    cmdState.messages.length === 0
      ? `<div class="mc-ai-launch-grid">
          ${quickTiles
            .map(
              (tile) => `<button type="button" class="mc-ai-launch-tile" data-action="ai-followup" data-prompt="${esc(tile.title)}" ${ui.commanderSending ? 'disabled' : ''}>
              <span class="mc-ai-launch-icon ${tile.tone}">${tile.icon}</span>
              <span class="mc-ai-launch-text">
                <span class="mc-ai-launch-title">${esc(tile.title)}</span>
                <span class="mc-ai-launch-sub num">${esc(tile.sub)}</span>
              </span>
            </button>`,
            )
            .join('')}
        </div>`
      : '';

  const msgsHtml = (cmdState.messages || [])
    .map((m) => {
      if (m.role === 'user') {
        return `<div class="mc-ai-msg is-user"><div class="mc-ai-body">${esc(m.text)}</div></div>`;
      }
      const tier = (m.modelTier || 'Flash').trim();
      const tierCls = `tier-${tier.toLowerCase()}`;
      const inspBadge = m.inspectedCount && m.inspectedCount > 0 ? `<span class="mc-tag-muted">Inspected ${m.inspectedCount}</span>` : '';
      const actionsHtml = m.actions && m.actions.length > 0 ? `<div class="mc-ai-actions">${m.actions.map(renderCommanderActionCard).join('')}</div>` : '';
      const followHtml = m.followUps && m.followUps.length > 0 ? `<div class="mc-ai-chips">${m.followUps.map((f) => `<button type="button" class="mc-ai-chip" data-action="ai-followup" data-prompt="${esc(f)}" ${ui.commanderSending ? 'disabled' : ''}>${esc(f)}</button>`).join('')}</div>` : '';
      return `<div class="mc-ai-msg is-assistant">
        <div class="mc-ai-msg-head">
          <strong>Commander</strong>
          <span class="mc-tier-badge ${esc(tierCls)}" title="${esc(m.routingReason || '')}">${esc(tier)}</span>
          ${inspBadge}
          <span class="num">${fmtClock(m.createdAt)}</span>
        </div>
        <div class="mc-ai-body">${esc(m.text)}</div>
        ${actionsHtml}
        ${followHtml}
      </div>`;
    })
    .join('');

  const thinkingHtml = ui.commanderSending
    ? `<div class="mc-ai-msg is-assistant"><div class="mc-ai-msg-head"><strong>Commander</strong><span class="mc-tag-muted">Thinking</span></div></div>`
    : '';

  const modes: Array<{ key: 'auto' | 'fast' | 'deep'; label: string }> = [
    { key: 'auto', label: 'Auto' },
    { key: 'fast', label: 'Fast' },
    { key: 'deep', label: 'Deep' },
  ];
  const modeSegHtml = `<div class="mc-seg" role="group" aria-label="Model routing mode">
    ${modes.map((md) => `<button type="button" class="mc-seg-btn" data-action="ai-routing" data-mode="${md.key}" aria-pressed="${prefs.routingMode === md.key}">${md.label}</button>`).join('')}
  </div>`;

  return `<div class="mc-ai-shell">
    <div class="mc-ai-top">
      <div class="mc-ai-summary">
        ${nodesHtml}
        ${poolsHtml}
        <span class="st-working">${STATE_ICON.working} <strong class="num">${snap.counts.working}</strong></span>
        <span class="st-attention">${STATE_ICON.attention} <strong class="num">${snap.counts.attention}</strong></span>
        <span>${ICON_RELAY} <strong class="num">${pendingRelays}</strong></span>
      </div>
      <div class="mc-ai-top-actions">
        <button type="button" class="mc-icon-btn is-bordered" data-action="ai-refresh-digest" ${ui.commanderDigestBusy ? 'disabled' : ''} title="Refresh executive digest" aria-label="Refresh digest">${ICON_REFRESH}</button>
        <button type="button" class="mc-btn" data-action="ai-clear" ${ui.commanderSending ? 'disabled' : ''}>New chat</button>
      </div>
    </div>
    <div id="mc-ai-scroll" class="mc-ai-scroll">
      ${digestCard}
      ${launchGridHtml}
      ${msgsHtml}
      ${thinkingHtml}
    </div>
    <div class="mc-ai-composer">
      <div class="mc-ai-controls">
        ${modeSegHtml}
        <button type="button" class="mc-btn${prefs.directDispatch ? ' is-autowake-on' : ''}" data-action="ai-toggle-direct" aria-pressed="${prefs.directDispatch}" title="Execute explicitly requested low and medium actions immediately instead of waiting for confirmation">${prefs.directDispatch ? 'Direct dispatch: On' : 'Confirm actions: On'}</button>
      </div>
      <div class="mc-ai-input-row">
        <textarea class="mc-ai-input" rows="2" placeholder="Ask Commander or issue a directive">${esc(ui.commanderDraft)}</textarea>
        <button type="button" class="mc-btn mc-btn-primary" data-action="ai-send" ${ui.commanderSending ? 'disabled' : ''}>${ui.commanderSending ? 'Thinking' : 'Send'}</button>
      </div>
    </div>
  </div>`;
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
  const cleaned = String(raw || '')
    .replace(/\u2026/g, '')
    .replace(/\.{3,}/g, '')
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, '$1')
    .replace(/\/Users\/[^\s),.;:]+/g, '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (!cleaned) return '';

  const lines = cleaned.split('\n');
  const out: string[] = [];
  let inList = false;
  let inCode = false;
  let codeBuf: string[] = [];

  const closeList = () => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      closeList();
      if (inCode) {
        out.push(`<pre class="mc-md-pre">${esc(codeBuf.join('\n'))}</pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    if (!trimmed) {
      closeList();
      continue;
    }
    if (/^---+$/.test(trimmed)) {
      closeList();
      out.push('<hr class="mc-md-hr">');
      continue;
    }
    const heading = trimmed.match(/^#{1,4}\s+(.+)$/);
    if (heading) {
      closeList();
      out.push(`<div class="mc-md-h">${formatInlineMarkdown(esc(heading[1]))}</div>`);
      continue;
    }
    const bullet = trimmed.match(/^(?:[-*+]|\d+\.)\s+(.+)$/);
    if (bullet) {
      if (!inList) {
        out.push('<ul class="mc-md-ul">');
        inList = true;
      }
      out.push(`<li>${formatInlineMarkdown(esc(bullet[1]))}</li>`);
      continue;
    }
    closeList();
    out.push(`<p class="mc-md-p">${formatInlineMarkdown(esc(trimmed))}</p>`);
  }
  closeList();
  if (inCode && codeBuf.length > 0) {
    out.push(`<pre class="mc-md-pre">${esc(codeBuf.join('\n'))}</pre>`);
  }
  return out.join('');
}

function renderProgressRing(d: ConversationItem): string {
  const r = 13;
  const circ = 2 * Math.PI * r;
  if (d.steps && d.steps.total > 0) {
    const ratio = Math.max(0, Math.min(1, d.steps.done / d.steps.total));
    const offset = circ * (1 - ratio);
    const stroke = d.steps.done === d.steps.total ? 'var(--mc-unread)' : d.state === 'attention' ? 'var(--mc-attention)' : 'var(--mc-working)';
    return `<div class="mc-ring-wrap" title="${d.steps.done}/${d.steps.total} steps">
      <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true">
        <circle cx="17" cy="17" r="${r}" fill="none" stroke="var(--mc-bg-3)" stroke-width="3"/>
        <circle cx="17" cy="17" r="${r}" fill="none" stroke="${stroke}" stroke-width="3" stroke-linecap="round"
          stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}" transform="rotate(-90 17 17)"/>
      </svg>
      <span class="mc-ring-label">${d.steps.done}/${d.steps.total}</span>
    </div>`;
  }
  return `<div class="mc-ring-wrap st-${d.state}" title="${STATE_LABEL[d.state]}">
    <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true">
      <circle cx="17" cy="17" r="${r}" fill="none" stroke="var(--mc-bg-3)" stroke-width="2.5"/>
    </svg>
    <span class="mc-ring-label">${STATE_ICON[d.state]}</span>
  </div>`;
}

function renderDetailPane(d: ConversationItem): string {
  const disc = ui.openDisclosures[d.id] || {};
  const refreshing = ui.refreshingBriefId === d.id;
  const sending = ui.sendingId === d.id;
  const phase = effectivePhase(d);
  const modelChip = modelShortChip(d.model);

  const needsCallText = d.waitingReason || d.briefing?.needsUser || '';
  const needsCallBlock = needsCallText
    ? `<div class="mc-detail-block">
        <div class="mc-detail-label st-attention">${STATE_ICON.attention} Needs your call</div>
        <p class="mc-detail-text is-attention">${esc(needsCallText)}</p>
      </div>`
    : '';

  let briefingBlock = '';
  if (d.briefing && (d.briefing.brief || d.briefing.headline)) {
    const staleTag = d.briefingStale ? '<span class="mc-tag-muted">Updating</span>' : '';
    const health = d.briefing.health || (d.state === 'attention' ? 'blocked' : d.state === 'working' ? 'nominal' : 'ready');
    const bullets = d.briefing.bullets && d.briefing.bullets.length > 0
      ? d.briefing.bullets
      : [d.briefing.currentWork, d.briefing.priorCompleted].filter(Boolean).slice(0, 2);
    const bulletsHtml = bullets.length > 0
      ? `<ul class="mc-brief-bullets">${bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`
      : '';

    briefingBlock = `<div class="mc-detail-block">
      <div class="mc-detail-label-row">
        <span class="mc-detail-label"><span class="mc-health-dot is-${esc(health)}"></span>Briefing</span>
        ${staleTag}
      </div>
      <p class="mc-detail-text">${esc(d.briefing.brief || d.briefing.headline)}</p>
      ${bulletsHtml}
    </div>`;
  } else {
    const fallbackText =
      (d.focusIsCurrentTurn ? d.focus : '')
      || d.lastPrompt
      || d.lastReply
      || 'Synthesizing briefing';
    briefingBlock = `<div class="mc-detail-block">
      <div class="mc-detail-label-row">
        <span class="mc-detail-label"><span class="mc-health-dot is-nominal"></span>Briefing</span>
        <span class="mc-tag-muted">Pending</span>
      </div>
      <p class="mc-detail-text">${esc(fallbackText)}</p>
    </div>`;
  }

  const nextActions = d.state !== 'working' ? (d.briefing?.nextActions || []) : [];
  const nextBlock =
    nextActions.length > 0
      ? `<div class="mc-detail-block">
          <div class="mc-detail-label">What's next <span class="mc-kbd">1</span>${nextActions.length > 1 ? '<span class="mc-kbd">2</span>' : ''}</div>
          <div class="mc-next-list">
            ${nextActions
              .map(
                (na, idx) => `<div class="mc-next-card">
                <div class="mc-next-head">
                  <span class="mc-next-label">${esc(na.label)}</span>
                  <div class="mc-next-btns">
                    <button type="button" class="mc-btn mc-btn-xs mc-btn-primary" data-action="send-next" data-id="${esc(d.id)}" data-idx="${idx}" ${sending ? 'disabled' : ''}>▶ Send</button>
                    <button type="button" class="mc-btn mc-btn-xs" data-action="edit-next" data-id="${esc(d.id)}" data-idx="${idx}">Edit</button>
                  </div>
                </div>
                <p class="mc-next-prompt" data-action="edit-next" data-id="${esc(d.id)}" data-idx="${idx}" title="Click to edit prompt">${esc(na.prompt)}</p>
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
    <textarea class="mc-composer-input" data-composer-id="${esc(d.id)}" rows="2" placeholder="Send a follow-up prompt (n)">${esc(draft)}</textarea>
    <div class="mc-composer-foot">
      <span class="mc-composer-hint">Enter sends · Shift+Enter newline</span>
      <button type="button" class="mc-btn mc-btn-primary" data-action="send-custom" data-id="${esc(d.id)}" ${sending ? 'disabled' : ''}>${sending ? 'Sending' : 'Send'}</button>
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
  const pendingRelaysForTab = (ui.snapshot?.relays || []).filter(
    (r) => r.status === 'pending' && r.targetConversationId === d.id,
  );
  const pendingRelaysBlock =
    pendingRelaysForTab.length > 0
      ? `<div class="mc-detail-block">
          <div class="mc-detail-label">Pending agent messages (${pendingRelaysForTab.length})</div>
          <div class="mc-relay-list">
            ${pendingRelaysForTab
              .map((r) => {
                const busy = ui.relayActionId === r.id;
                return `<div class="mc-next-card is-pending">
                  <div class="mc-next-head">
                    <span class="mc-next-label">From ${esc(r.fromLabel)}</span>
                    <div class="mc-next-btns">
                      <button type="button" class="mc-btn mc-btn-xs mc-btn-primary" data-action="approve-relay" data-id="${esc(r.id)}" data-host="${esc(r.targetHost)}" ${busy ? 'disabled' : ''}>${busy ? 'Sending' : 'Approve & Send'}</button>
                      <button type="button" class="mc-btn mc-btn-xs" data-action="edit-relay" data-id="${esc(r.id)}" data-target-id="${esc(d.id)}">Edit</button>
                      <button type="button" class="mc-btn mc-btn-xs" data-action="dismiss-relay" data-id="${esc(r.id)}" data-host="${esc(r.targetHost)}" ${busy ? 'disabled' : ''}>Dismiss</button>
                    </div>
                  </div>
                  <p class="mc-relay-msg">${esc(r.message)}</p>
                  <div class="mc-relay-reason">${esc(r.reason)}</div>
                  ${r.error ? `<div class="mc-relay-error">${esc(r.error)}</div>` : ''}
                </div>`;
              })
              .join('')}
          </div>
        </div>`
      : '';

  return `<aside class="mc-detail" aria-label="Conversation details">
    <div class="mc-detail-head">
      <div class="mc-detail-hero">
        ${renderProgressRing(d)}
        <div class="mc-detail-title-col">
          <h2 class="mc-detail-title">${esc(d.title)}</h2>
          <div class="mc-detail-meta">
            <span class="mc-phase-chip is-${phase}" title="Phase: ${PHASE_LABEL[phase]}">${PHASE_ICON[phase]}</span>
            <span>${PHASE_LABEL[phase]}</span>
            ${showHostMeta ? `<span class="mc-host-badge">${esc(d.host)}</span>` : ''}
            <span>${esc(d.projectName)}</span>
            <span class="num">${fmtAge(d.ageMs)}</span>
            ${modelChip.code ? `<span class="mc-model-chip" title="${esc(modelChip.label)}">${esc(modelChip.code)}</span>` : ''}
          </div>
        </div>
      </div>
      <button type="button" class="mc-icon-btn" data-action="close-detail" aria-label="Close details" title="Close inspector (Esc)">${ICON_CLOSE}</button>
    </div>
    <div class="mc-detail-icon-bar" role="toolbar" aria-label="Thread actions">
      <button type="button" class="mc-btn mc-btn-open-hero" data-action="open" data-id="${esc(d.id)}" title="Open in Antigravity (Enter)">${ICON_OPEN} Open</button>
      <button type="button" class="mc-icon-btn is-bordered" data-action="refresh-brief" data-id="${esc(d.id)}" ${refreshing ? 'disabled' : ''} title="Refresh AI briefing (r)" aria-label="Refresh brief">${ICON_REFRESH}</button>
      <button type="button" class="mc-icon-btn is-bordered${d.autoWake ? ' is-autowake-on' : ''}" data-action="toggle-autowake" data-id="${esc(d.id)}" aria-pressed="${Boolean(d.autoWake)}" title="Auto-wake when idle (a)" aria-label="Toggle auto-wake">${ICON_BOLT}</button>
      ${d.state === 'working' ? `<button type="button" class="mc-icon-btn is-bordered is-danger" data-action="stop" data-id="${esc(d.id)}" title="Stop active run" aria-label="Stop">${ICON_STOP}</button>` : ''}
      <button type="button" class="mc-icon-btn is-bordered" data-action="pin" data-id="${esc(d.id)}" aria-pressed="${d.pinned}" title="${d.pinned ? 'Unpin (p)' : 'Pin to top (p)'}" aria-label="Pin">${ICON_PIN}</button>
      ${d.slot > 1 ? `<button type="button" class="mc-icon-btn is-bordered" data-action="move-top" data-id="${esc(d.id)}" title="Send to top (t)" aria-label="Send to top">${ICON_TOP}</button>` : ''}
      <button type="button" class="mc-icon-btn is-bordered" data-action="move-bottom" data-id="${esc(d.id)}" title="Send to bottom (b)" aria-label="Send to bottom">${ICON_BOTTOM}</button>
      <button type="button" class="mc-icon-btn is-bordered" data-action="hide" data-id="${esc(d.id)}" title="Hide from board (x)" aria-label="Hide">${ICON_CLOSE}</button>
      <button type="button" class="mc-icon-btn is-bordered" data-action="copy-id" data-id="${esc(d.id)}" title="Copy thread ID" aria-label="Copy ID">${ICON_COPY}</button>
    </div>
    ${pendingRelaysBlock}
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

interface PaletteEntry {
  kind: 'cmd' | 'thread';
  id: string;
  label: string;
  sub: string;
  kbd: string;
  icon: string;
  run: () => void;
}

function buildPaletteEntries(snap: BoardSnapshot): PaletteEntry[] {
  const q = ui.paletteQuery.trim().toLowerCase();
  const commands: PaletteEntry[] = [
    {
      kind: 'cmd',
      id: 'view-threads',
      label: 'Switch to Board',
      sub: 'Live cockpit rows and detail inspector',
      kbd: '⌘1',
      icon: STATE_ICON.unread,
      run: () => {
        ui.view = 'threads';
        ui.paletteOpen = false;
        render();
      },
    },
    {
      kind: 'cmd',
      id: 'view-commander',
      label: 'Open AI Commander',
      sub: 'Autonomous briefing and multi-agent triage',
      kbd: '⌘2',
      icon: ICON_SPARK,
      run: () => {
        ui.view = 'commander';
        ui.paletteOpen = false;
        render();
        void ensureCommanderLoaded();
      },
    },
    {
      kind: 'cmd',
      id: 'view-relay',
      label: 'Open Agent Relays',
      sub: 'Approve or inspect agent-to-agent messages',
      kbd: '⌘3',
      icon: ICON_RELAY,
      run: () => {
        ui.view = 'relay';
        ui.paletteOpen = false;
        render();
      },
    },
    {
      kind: 'cmd',
      id: 'new-thread',
      label: 'Start New Conversation',
      sub: 'Launch a fresh Antigravity session',
      kbd: 'N',
      icon: ICON_OPEN,
      run: () => {
        ui.view = 'threads';
        ui.showNewForm = true;
        ui.paletteOpen = false;
        render();
        document.querySelector<HTMLInputElement>('.mc-new-input')?.focus();
      },
    },
    {
      kind: 'cmd',
      id: 'refresh-digest',
      label: 'Refresh AI Executive Digest',
      sub: 'Synthesize fresh summary across hosts',
      kbd: '↻',
      icon: ICON_REFRESH,
      run: () => {
        ui.view = 'commander';
        ui.paletteOpen = false;
        render();
        void refreshCommanderDigest(true);
      },
    },
    {
      kind: 'cmd',
      id: 'open-find',
      label: 'Find in Board',
      sub: 'Filter threads by title, project, or model',
      kbd: '/',
      icon: ICON_SEARCH,
      run: () => {
        ui.view = 'threads';
        ui.paletteOpen = false;
        ui.findOpen = true;
        render();
        document.querySelector<HTMLInputElement>('.mc-find-input')?.focus();
      },
    },
    {
      kind: 'cmd',
      id: 'show-help',
      label: 'Keyboard Shortcuts HUD',
      sub: 'Single-screen keycap reference',
      kbd: '?',
      icon: ICON_HELP,
      run: () => {
        ui.paletteOpen = false;
        ui.helpOpen = true;
        render();
      },
    },
  ];

  const threads: PaletteEntry[] = (snap.conversations || []).map((c) => ({
    kind: 'thread',
    id: c.id,
    label: c.title,
    sub: `${c.projectName}${c.host ? ` · ${c.host.toUpperCase()}` : ''} · ${STATE_LABEL[c.state]}`,
    kbd: `#${c.slot}`,
    icon: `<span class="st-${c.state}">${STATE_ICON[c.state]}</span>`,
    run: () => {
      ui.view = 'threads';
      ui.paletteOpen = false;
      void loadThreadDetail(c.id);
    },
  }));

  const all = [...commands, ...threads];
  if (!q) return all.slice(0, 14);
  return all
    .filter((entry) => `${entry.label} ${entry.sub}`.toLowerCase().includes(q))
    .slice(0, 16);
}

function renderPaletteOverlay(snap: BoardSnapshot): string {
  if (!ui.paletteOpen) return '';
  const entries = buildPaletteEntries(snap);
  const clampedIdx = Math.max(0, Math.min(ui.paletteIndex, Math.max(0, entries.length - 1)));
  ui.paletteIndex = clampedIdx;
  const rowsHtml =
    entries.length > 0
      ? entries
          .map(
            (e, idx) => `<button type="button" class="mc-palette-item${idx === clampedIdx ? ' is-active' : ''}" data-action="palette-pick" data-idx="${idx}">
            <span class="mc-palette-item-left">
              ${e.icon}
              <span class="mc-title">${esc(e.label)}</span>
              <span class="mc-palette-sub">${esc(e.sub)}</span>
            </span>
            <span class="mc-kbd">${esc(e.kbd)}</span>
          </button>`,
          )
          .join('')
      : '<div class="mc-empty">No commands or threads match.</div>';

  return `<div class="mc-overlay-backdrop" data-action="close-overlays">
    <div class="mc-palette" role="dialog" aria-label="Command palette">
      <div class="mc-palette-head">
        ${ICON_SEARCH}
        <input type="text" class="mc-palette-input" value="${esc(ui.paletteQuery)}" placeholder="Jump to thread or run command">
        <span class="mc-kbd">Esc</span>
      </div>
      <div class="mc-palette-list">${rowsHtml}</div>
    </div>
  </div>`;
}

function renderHelpHud(): string {
  if (!ui.helpOpen) return '';
  const cols: Array<{ title: string; items: Array<[string, string]> }> = [
    {
      title: 'Navigate',
      items: [
        ['j / k / ↑ / ↓', 'Next / prev thread'],
        ['g / G', 'Top / bottom row'],
        ['/', 'Inline filter bar'],
        ['⌘K', 'Command palette'],
        ['Esc', 'Dismiss top layer'],
      ],
    },
    {
      title: 'Selected Thread',
      items: [
        ['Enter', 'Focus in Antigravity'],
        ['n', 'Focus composer'],
        ['1 / 2', 'Send next suggestion'],
        ['r / a', 'Refresh brief / Auto-wake'],
        ['p / b / x', 'Pin / Bottom / Hide'],
      ],
    },
    {
      title: 'Views & Tools',
      items: [
        ['⌘1', 'Board view'],
        ['⌘2', 'AI Commander'],
        ['⌘3', 'Agent Relays'],
        ['?', 'Toggle shortcuts HUD'],
      ],
    },
  ];

  return `<div class="mc-overlay-backdrop" data-action="close-overlays">
    <div class="mc-hud" role="dialog" aria-label="Keyboard shortcuts">
      <div class="mc-hud-head">
        <h3 class="mc-hud-title">Keyboard Shortcuts</h3>
        <button type="button" class="mc-icon-btn" data-action="toggle-help" aria-label="Close shortcuts" title="Close (Esc)">${ICON_CLOSE}</button>
      </div>
      <div class="mc-hud-grid">
        ${cols
          .map(
            (col) => `<div class="mc-hud-col">
            <div class="mc-hud-col-title">${col.title}</div>
            ${col.items
              .map(([k, label]) => `<div class="mc-hud-row"><span>${label}</span><span class="mc-kbd">${k}</span></div>`)
              .join('')}
          </div>`,
          )
          .join('')}
      </div>
    </div>
  </div>`;
}

function render() {
  const root = document.getElementById('root');
  if (!root) return;

  if (!ui.snapshot) {
    root.innerHTML = '<div class="mc-shell"><header class="mc-bar"><div class="mc-bar-group">Mission Control</div></header><div class="mc-empty">Loading conversations</div></div>';
    return;
  }

  const snap = ui.snapshot;
  const rows = visibleThreads();
  const isCommander = ui.view === 'commander';
  const commanderHtml = isCommander ? renderCommanderPane(snap) : '';
  const listHtml = isCommander
    ? ''
    : ui.view === 'fleet'
      ? renderFleetPane(snap.fleet || [])
      : ui.view === 'relay'
        ? renderRelayPane(snap.relays || [])
        : rows.length > 0
          ? rows.map((item) => renderThreadRow(item)).join('')
          : '<div class="mc-empty">No conversations match this filter.</div>';

  const hasDetail = Boolean(ui.detail && ui.view === 'threads');
  const detailHtml = hasDetail && ui.detail ? renderDetailPane(ui.detail) : '';
  const newBarHtml = renderNewBar(snap);
  const hostFilteredTotal = ui.hostFilter === 'all'
    ? snap.conversations.length
    : snap.conversations.filter((c) => c.host === ui.hostFilter).length;
  const findBarHtml = !isCommander ? renderFindBar(rows.length, hostFilteredTotal) : '';
  const paletteHtml = renderPaletteOverlay(snap);
  const helpHtml = renderHelpHud();

  const renderKey = JSON.stringify({
    bar: { counts: snap.counts, sort: snap.sortMode, filter: ui.filter, hostFilter: ui.hostFilter, view: ui.view, toast: ui.toast, fleet: snap.fleet?.length || 0, hosts: snap.hosts, findOpen: ui.findOpen, helpOpen: ui.helpOpen },
    newForm: { open: ui.showNewForm, host: ui.newHost, project: ui.newProject, prompt: ui.newPrompt, creating: ui.creatingNew },
    find: { open: ui.findOpen, q: ui.findQuery },
    overlays: { paletteOpen: ui.paletteOpen, paletteQ: ui.paletteQuery, paletteIdx: ui.paletteIndex, helpOpen: ui.helpOpen },
    list: listHtml,
    detail: detailHtml,
    commander: commanderHtml,
    refreshing: ui.refreshingBriefId,
    sending: ui.sendingId,
    relayAction: ui.relayActionId,
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

  if (ui.paletteOpen && activeEl?.classList?.contains('mc-palette-input')) {
    const existingList = root.querySelector('.mc-palette-list');
    if (existingList) {
      const tmp = document.createElement('div');
      tmp.innerHTML = paletteHtml;
      const nextList = tmp.querySelector('.mc-palette-list');
      if (nextList) existingList.innerHTML = nextList.innerHTML;
      return;
    }
  }

  if (ui.findOpen && activeEl?.classList?.contains('mc-find-input')) {
    const existingList = document.getElementById('mc-list-pane');
    const existingCount = root.querySelector('.mc-find-count');
    if (existingList) existingList.innerHTML = listHtml;
    if (existingCount) existingCount.textContent = `${rows.length}/${hostFilteredTotal}`;
    return;
  }

  if (isCommander && activeEl?.classList?.contains('mc-ai-input')) {
    const existingBar = root.querySelector('.mc-bar-wrap');
    const existingTop = root.querySelector('.mc-ai-top');
    const existingScroll = document.getElementById('mc-ai-scroll');
    const existingControls = root.querySelector('.mc-ai-controls');
    const existingSend = root.querySelector('[data-action="ai-send"]') as HTMLButtonElement | null;
    if (existingBar && existingTop && existingScroll && existingControls) {
      const prevScrollTop = existingScroll.scrollTop;
      const wasAtBottom = existingScroll.scrollTop + existingScroll.clientHeight >= existingScroll.scrollHeight - 24;
      const tmp = document.createElement('div');
      tmp.innerHTML = commanderHtml;
      const newTop = tmp.querySelector('.mc-ai-top');
      const newScroll = tmp.querySelector('#mc-ai-scroll');
      const newControls = tmp.querySelector('.mc-ai-controls');
      existingBar.outerHTML = renderTopBar(snap);
      if (newTop) existingTop.innerHTML = newTop.innerHTML;
      if (newScroll) {
        existingScroll.innerHTML = newScroll.innerHTML;
        existingScroll.scrollTop = wasAtBottom ? existingScroll.scrollHeight : prevScrollTop;
      }
      if (newControls) existingControls.innerHTML = newControls.innerHTML;
      if (existingSend) {
        existingSend.disabled = ui.commanderSending;
        existingSend.textContent = ui.commanderSending ? 'Thinking' : 'Send';
      }
      return;
    }
  }

  if (isCommander && activeEl?.classList?.contains('mc-ai-edit-area')) {
    const existingBar = root.querySelector('.mc-bar-wrap');
    const existingTop = root.querySelector('.mc-ai-top');
    if (existingBar) existingBar.outerHTML = renderTopBar(snap);
    if (existingTop) {
      const tmp = document.createElement('div');
      tmp.innerHTML = commanderHtml;
      const newTop = tmp.querySelector('.mc-ai-top');
      if (newTop) existingTop.innerHTML = newTop.innerHTML;
    }
    return;
  }

  const editingComposer =
    activeEl?.classList?.contains('mc-composer-input')
    && (activeEl as HTMLTextAreaElement).dataset.composerId === ui.selectedId
    && hasDetail;
  const editingNewBar =
    ui.showNewForm
    && Boolean(activeEl?.closest?.('.mc-new-bar'));
  if (editingComposer || editingNewBar) {
    const existingList = document.getElementById('mc-list-pane');
    const existingBar = root.querySelector('.mc-bar-wrap');
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
  const prevAiScroll = document.getElementById('mc-ai-scroll');
  const listScroll = prevList ? prevList.scrollTop : 0;
  const detailScroll = prevDetail ? prevDetail.scrollTop : 0;
  const aiScroll = prevAiScroll ? prevAiScroll.scrollTop : 0;
  const activeKey = (document.activeElement as HTMLElement | null)?.dataset?.focusKey || '';

  const mainShellHtml = isCommander
    ? commanderHtml
    : `<div class="mc-body${hasDetail ? ' has-detail' : ''}">
        <div class="mc-main-col">
          ${newBarHtml}
          ${findBarHtml}
          <div id="mc-list-pane" class="mc-list-pane" role="grid" aria-label="Conversations">${listHtml}</div>
        </div>
        ${detailHtml}
      </div>`;

  root.innerHTML = `<div class="mc-shell">
    ${renderTopBar(snap)}
    ${mainShellHtml}
    ${paletteHtml}
    ${helpHtml}
  </div>`;

  const nextList = document.getElementById('mc-list-pane');
  if (nextList) nextList.scrollTop = listScroll;
  const nextDetail = root.querySelector('.mc-detail');
  if (nextDetail) nextDetail.scrollTop = detailScroll;
  const nextAiScroll = document.getElementById('mc-ai-scroll');
  if (nextAiScroll) nextAiScroll.scrollTop = aiScroll;

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
  if (target?.classList?.contains('mc-ai-input')) {
    ui.commanderDraft = (target as HTMLTextAreaElement).value;
    return;
  }
  if (target?.classList?.contains('mc-ai-edit-area')) {
    ui.commanderEditDraft = (target as HTMLTextAreaElement).value;
    return;
  }
  if (target?.classList?.contains('mc-find-input')) {
    ui.findQuery = (target as HTMLInputElement).value;
    render();
    return;
  }
  if (target?.classList?.contains('mc-palette-input')) {
    ui.paletteQuery = (target as HTMLInputElement).value;
    ui.paletteIndex = 0;
    render();
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
  const rawTarget = event.target as HTMLElement | null;
  if (rawTarget?.classList?.contains('mc-overlay-backdrop')) {
    ui.paletteOpen = false;
    ui.helpOpen = false;
    render();
    return;
  }
  const target = rawTarget?.closest('[data-action]') as HTMLElement | null;
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
  } else if (action === 'toggle-commander') {
    ui.view = ui.view === 'commander' ? 'threads' : 'commander';
    render();
    if (ui.view === 'commander') {
      void ensureCommanderLoaded();
      const inp = document.querySelector<HTMLTextAreaElement>('.mc-ai-input');
      if (inp) inp.focus();
    }
  } else if (action === 'toggle-help') {
    ui.paletteOpen = false;
    ui.helpOpen = !ui.helpOpen;
    render();
  } else if (action === 'toggle-find') {
    ui.view = 'threads';
    ui.findOpen = !ui.findOpen;
    if (!ui.findOpen) ui.findQuery = '';
    render();
    if (ui.findOpen) document.querySelector<HTMLInputElement>('.mc-find-input')?.focus();
  } else if (action === 'close-find') {
    ui.findOpen = false;
    ui.findQuery = '';
    render();
  } else if (action === 'palette-pick') {
    const idx = Number(target.dataset.idx || 0);
    if (ui.snapshot) {
      const entries = buildPaletteEntries(ui.snapshot);
      entries[idx]?.run();
    }
  } else if (action === 'ai-refresh-digest') {
    void refreshCommanderDigest(true);
  } else if (action === 'ai-clear') {
    void clearCommanderChatUi();
  } else if (action === 'ai-routing') {
    const mode = target.dataset.mode as 'auto' | 'fast' | 'deep' | undefined;
    if (mode) void updateCommanderSettingsUi({ routingMode: mode });
  } else if (action === 'ai-toggle-direct') {
    const cur = Boolean(ui.commander?.preferences?.directDispatch);
    void updateCommanderSettingsUi({ directDispatch: !cur });
  } else if (action === 'ai-send') {
    const ta = document.querySelector<HTMLTextAreaElement>('.mc-ai-input');
    const txt = ta ? ta.value : ui.commanderDraft;
    void sendCommanderPrompt(txt);
  } else if (action === 'ai-followup') {
    const prompt = target.dataset.prompt || target.textContent || '';
    if (prompt.trim()) void sendCommanderPrompt(prompt);
  } else if (action === 'ai-action-run' && id) {
    void executeCommanderActionUi(id);
  } else if (action === 'ai-action-edit' && id) {
    let found: CommanderAction | undefined;
    for (const m of ui.commander?.messages || []) {
      found = m.actions?.find((a) => a.id === id);
      if (found) break;
    }
    if (found) {
      ui.commanderEditId = id;
      ui.commanderEditDraft = getActionEditDefault(found);
      render();
      const ta = document.querySelector<HTMLTextAreaElement>(`.mc-ai-edit-area[data-ai-edit-id="${CSS.escape(id)}"]`);
      if (ta) ta.focus();
    }
  } else if (action === 'ai-action-save-run' && id) {
    const ta = document.querySelector<HTMLTextAreaElement>(`.mc-ai-edit-area[data-ai-edit-id="${CSS.escape(id)}"]`);
    const edited = ta ? ta.value : ui.commanderEditDraft;
    void executeCommanderActionUi(id, edited);
  } else if (action === 'ai-action-cancel-edit') {
    ui.commanderEditId = null;
    ui.commanderEditDraft = '';
    render();
  } else if (action === 'ai-action-dismiss' && id) {
    void dismissCommanderActionUi(id);
  } else if (action === 'toggle-relay') {
    ui.view = ui.view === 'relay' ? 'threads' : 'relay';
    render();
  } else if (action === 'approve-relay' && id) {
    event.stopPropagation();
    void approveRelayAction(id, target.dataset.host);
  } else if (action === 'dismiss-relay' && id) {
    event.stopPropagation();
    void dismissRelayAction(id, target.dataset.host);
  } else if (action === 'edit-relay' && id) {
    event.stopPropagation();
    const tid = target.dataset.targetId || ui.selectedId || '';
    const relay = (ui.snapshot?.relays || []).find((r) => r.id === id);
    if (tid && relay) {
      ui.drafts[tid] = relay.message;
      render();
      const input = document.querySelector<HTMLTextAreaElement>(`.mc-composer-input[data-composer-id="${CSS.escape(tid)}"]`);
      if (input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    }
  } else if (action === 'edit-relay-in-tab' && id) {
    event.stopPropagation();
    const tid = target.dataset.targetId || '';
    const relay = (ui.snapshot?.relays || []).find((r) => r.id === id);
    if (tid && relay) {
      ui.view = 'threads';
      ui.drafts[tid] = relay.message;
      void loadThreadDetail(tid);
    }
  } else if (action === 'toggle-autowake' && id) {
    event.stopPropagation();
    const item = ui.detail?.id === id ? ui.detail : ui.snapshot?.conversations.find((c) => c.id === id);
    if (item) void toggleAutoWakeAction(item);
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
  const mod = event.metaKey || event.ctrlKey;

  if (mod && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    ui.helpOpen = false;
    ui.paletteOpen = !ui.paletteOpen;
    ui.paletteQuery = '';
    ui.paletteIndex = 0;
    render();
    if (ui.paletteOpen) document.querySelector<HTMLInputElement>('.mc-palette-input')?.focus();
    return;
  }

  if (mod && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    ui.view = 'threads';
    ui.paletteOpen = false;
    ui.helpOpen = false;
    ui.findOpen = true;
    render();
    document.querySelector<HTMLInputElement>('.mc-find-input')?.focus();
    return;
  }

  if (mod && event.key === '/') {
    event.preventDefault();
    ui.paletteOpen = false;
    ui.helpOpen = !ui.helpOpen;
    render();
    return;
  }

  if (mod && (event.key === '1' || event.key === '2' || event.key === '3')) {
    event.preventDefault();
    ui.paletteOpen = false;
    ui.helpOpen = false;
    ui.view = event.key === '1' ? 'threads' : event.key === '2' ? 'commander' : 'relay';
    render();
    if (ui.view === 'commander') {
      void ensureCommanderLoaded();
      document.querySelector<HTMLTextAreaElement>('.mc-ai-input')?.focus();
    }
    return;
  }

  if (ui.paletteOpen) {
    if (event.key === 'Escape') {
      event.preventDefault();
      ui.paletteOpen = false;
      render();
      return;
    }
    if (ui.snapshot) {
      const entries = buildPaletteEntries(ui.snapshot);
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        ui.paletteIndex = Math.min(Math.max(0, entries.length - 1), ui.paletteIndex + 1);
        render();
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        ui.paletteIndex = Math.max(0, ui.paletteIndex - 1);
        render();
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        entries[ui.paletteIndex]?.run();
        return;
      }
    }
    return;
  }

  if (ui.helpOpen) {
    if (event.key === 'Escape' || event.key === '?') {
      event.preventDefault();
      ui.helpOpen = false;
      render();
    }
    return;
  }

  if (el?.classList?.contains('mc-find-input')) {
    if (event.key === 'Escape') {
      event.preventDefault();
      ui.findOpen = false;
      ui.findQuery = '';
      render();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const rows = visibleThreads();
      if (rows.length > 0) {
        const cur = rows.findIndex((r) => r.id === ui.selectedId);
        const nextIdx = event.shiftKey
          ? (cur <= 0 ? rows.length - 1 : cur - 1)
          : (cur === -1 ? 0 : (cur + 1) % rows.length);
        void loadThreadDetail(rows[nextIdx].id);
      }
    }
    return;
  }

  if (el?.classList?.contains('mc-composer-input')) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      const cid = (el as HTMLTextAreaElement).dataset.composerId || '';
      const val = (el as HTMLTextAreaElement).value;
      if (cid) void sendPromptToThread(cid, val, true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      (el as HTMLTextAreaElement).blur();
    }
    return;
  }

  if (el?.classList?.contains('mc-ai-input')) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendCommanderPrompt((el as HTMLTextAreaElement).value);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      (el as HTMLTextAreaElement).blur();
    }
    return;
  }

  if (el?.classList?.contains('mc-ai-edit-area')) {
    if (event.key === 'Escape') {
      event.preventDefault();
      ui.commanderEditId = null;
      ui.commanderEditDraft = '';
      render();
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
  if (mod || event.altKey) return;

  if (event.key === '?') {
    event.preventDefault();
    ui.helpOpen = true;
    render();
    return;
  }

  if (event.key === '/') {
    event.preventDefault();
    ui.view = 'threads';
    ui.findOpen = true;
    render();
    document.querySelector<HTMLInputElement>('.mc-find-input')?.focus();
    return;
  }

  if (event.key === 'Escape') {
    if (ui.findOpen || ui.findQuery) {
      event.preventDefault();
      ui.findOpen = false;
      ui.findQuery = '';
      render();
      return;
    }
    if (ui.showNewForm) {
      event.preventDefault();
      ui.showNewForm = false;
      render();
      return;
    }
    if (ui.commanderEditId) {
      event.preventDefault();
      ui.commanderEditId = null;
      ui.commanderEditDraft = '';
      render();
      return;
    }
    if (ui.selectedId) {
      event.preventDefault();
      ui.selectedId = null;
      ui.detail = null;
      render();
      return;
    }
  }

  const rows = visibleThreads();

  if (event.key === 'ArrowDown' || event.key === 'j' || event.key === 'ArrowUp' || event.key === 'k') {
    if (rows.length === 0 || ui.view !== 'threads') return;
    event.preventDefault();
    const down = event.key === 'ArrowDown' || event.key === 'j';
    const curIdx = rows.findIndex((r) => r.id === ui.selectedId);
    const nextIdx =
      curIdx === -1
        ? 0
        : down
          ? Math.min(rows.length - 1, curIdx + 1)
          : Math.max(0, curIdx - 1);
    void loadThreadDetail(rows[nextIdx].id);
    return;
  }

  if (event.key === 'g' || event.key === 'G') {
    if (rows.length === 0 || ui.view !== 'threads') return;
    event.preventDefault();
    const targetRow = event.key === 'g' ? rows[0] : rows[rows.length - 1];
    void loadThreadDetail(targetRow.id);
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

  if (event.key.toLowerCase() === 'r' && ui.selectedId) {
    event.preventDefault();
    void refreshBriefing(ui.selectedId);
    return;
  }

  if (event.key.toLowerCase() === 'a' && ui.selectedId) {
    const item = ui.detail?.id === ui.selectedId ? ui.detail : rows.find((r) => r.id === ui.selectedId);
    if (item) {
      event.preventDefault();
      void toggleAutoWakeAction(item);
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

  if (event.key.toLowerCase() === 'x' && ui.selectedId) {
    const targetId = ui.selectedId;
    event.preventDefault();
    ui.selectedId = null;
    ui.detail = null;
    void mutateOrder({ action: 'hide', conversationId: targetId });
    return;
  }

  if ((event.key === '1' || event.key === '2') && ui.selectedId && ui.view === 'threads') {
    const item = ui.detail?.id === ui.selectedId ? ui.detail : rows.find((r) => r.id === ui.selectedId);
    const idx = event.key === '1' ? 0 : 1;
    const prompt = item?.state !== 'working' ? item?.briefing?.nextActions?.[idx]?.prompt : undefined;
    if (prompt) {
      event.preventDefault();
      void sendPromptToThread(ui.selectedId, prompt, false);
      return;
    }
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
