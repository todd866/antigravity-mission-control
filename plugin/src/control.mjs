import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const HOME = homedir();
const DB_PATH = join(HOME, '.gemini', 'antigravity', 'conversation_summaries.db');
const STATE_DIR = join(HOME, '.local', 'state', 'agy-monitor');
const LAST_ACTION_PATH = join(STATE_DIR, 'last-action.json');

function discoverAgentDesktop() {
  if (process.env.AGENT_DESKTOP_BIN && existsSync(process.env.AGENT_DESKTOP_BIN)) {
    return process.env.AGENT_DESKTOP_BIN;
  }
  const candidates = [
    join(dirname(process.execPath), 'agent-desktop'),
    '/opt/homebrew/bin/agent-desktop',
    join(HOME, '.local', 'bin', 'agent-desktop'),
    '/usr/local/bin/agent-desktop',
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return 'agent-desktop';
}

const AGENT_DESKTOP = discoverAgentDesktop();
const AX_HELP_MSG = process.env.AGY_HELPER_APP
  ? `Grant Accessibility to ${process.env.AGY_HELPER_APP} in System Settings > Privacy & Security > Accessibility to allow remote Focus, Stop, and Send.`
  : `Grant Accessibility to node (${process.execPath}) in System Settings > Privacy & Security > Accessibility to allow remote Focus, Stop, and Send.`;

let macAccessibilityOk = true;

export function getMacAccessibilityOk() {
  return macAccessibilityOk;
}

// Serialize all agent-desktop mutations to avoid racing UI state.
let uiQueue = Promise.resolve();
function withUiLock(fn) {
  const next = uiQueue.then(fn, fn);
  uiQueue = next.catch(() => {});
  return next;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeLastAction(payload) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const data = {
      ok: Boolean(payload?.ok),
      conversationId: String(payload?.conversationId || ''),
      title: String(payload?.title || ''),
      message: String(payload?.message || ''),
      error: String(payload?.error || ''),
      at: Date.now(),
    };
    const tmp = `${LAST_ACTION_PATH}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    renameSync(tmp, LAST_ACTION_PATH);
  } catch {
    // Non-fatal; board polling still reflects live DB status.
  }
}

export async function runAgentDesktop(args, timeoutMs = 12000) {
  let parsed = { ok: false };
  try {
    const res = await execFileAsync(AGENT_DESKTOP, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
    });
    const text = (res.stdout || '').trim();
    parsed = text ? JSON.parse(text) : { ok: false };
  } catch (err) {
    const stdout = typeof err?.stdout === 'string' ? err.stdout.trim() : '';
    if (stdout.startsWith('{')) {
      try {
        parsed = JSON.parse(stdout);
      } catch {
        throw new Error(stdout);
      }
    } else {
      throw new Error(stdout || err?.stderr?.trim() || err?.message || 'agent-desktop failed');
    }
  }
  if (parsed?.ok === true) {
    macAccessibilityOk = true;
  } else if (parsed?.error?.code === 'PERM_DENIED') {
    macAccessibilityOk = false;
  }
  return parsed;
}

export async function checkAccessibility() {
  try {
    const r = await runAgentDesktop(['status'], 5000);
    const state = r?.data?.permissions?.accessibility?.state;
    if (state) {
      macAccessibilityOk = state === 'granted';
    }
    return macAccessibilityOk;
  } catch {
    return macAccessibilityOk;
  }
}

function mapAxError(res, fallbackMsg) {
  if (res?.error?.code === 'PERM_DENIED') {
    return { status: 503, body: { ok: false, errorCode: 'PERM_DENIED', error: AX_HELP_MSG } };
  }
  return {
    status: 502,
    body: { ok: false, errorCode: res?.error?.code || 'AX_ERROR', error: res?.error?.message || fallbackMsg },
  };
}

function isAgyWebareaName(rawName) {
  const s = String(rawName || '');
  return s === 'Antigravity' || s.endsWith(' - Antigravity');
}

function isAgyWebareaPath(path) {
  if (!Array.isArray(path)) return false;
  return path.some((segment) => {
    const s = String(segment || '');
    return s.startsWith('webarea:') && isAgyWebareaName(s.slice('webarea:'.length));
  });
}

function segmentsAfterSidebar(path) {
  if (!Array.isArray(path)) return -1;
  const idx = path.indexOf('navigation:Sidebar');
  return idx === -1 ? -1 : path.length - idx - 1;
}

function getWebareaSegmentName(path) {
  if (!Array.isArray(path)) return '';
  const seg = path.find((p) => {
    const s = String(p || '');
    return s.startsWith('webarea:') && isAgyWebareaName(s.slice('webarea:'.length));
  });
  return seg ? String(seg).slice('webarea:'.length) : '';
}

function findWebareaGroup(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.role === 'webarea' && isAgyWebareaName(node.name)) {
    return (node.children || [])[0] || null;
  }
  for (const child of node.children || []) {
    const found = findWebareaGroup(child);
    if (found) return found;
  }
  return null;
}

async function snapshotAntigravitySidebarTree() {
  const skel = await runAgentDesktop(
    ['snapshot', '--app', 'Antigravity', '--skeleton', '-i', '--compact', '--timeout-ms', '8000'],
    10000,
  );
  if (skel?.ok === false && skel?.error) {
    const err = new Error(skel.error.code === 'PERM_DENIED' ? AX_HELP_MSG : (skel.error.message || 'Accessibility snapshot failed'));
    err.httpStatus = skel.error.code === 'PERM_DENIED' ? 503 : 502;
    throw err;
  }
  const waGroup = findWebareaGroup(skel?.data?.tree);
  if (!waGroup?.ref_id) {
    throw new Error('Antigravity main window webarea is not accessible');
  }
  const drill = await runAgentDesktop(
    ['snapshot', '--root', waGroup.ref_id, '--max-depth', '10', '-i', '--compact', '--timeout-ms', '8000'],
    10000,
  );
  if (!drill?.ok || !drill?.data?.tree) {
    throw new Error(drill?.error?.message || 'Could not read Antigravity sidebar accessibility tree');
  }
  return drill.data.tree;
}

function collectNodes(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (predicate(node)) out.push(node);
  for (const child of node.children || []) {
    collectNodes(child, predicate, out);
  }
  return out;
}

function findConversationRowGroup(tree, title) {
  let match = null;
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.role === 'group') {
      const links = collectNodes(node, (n) => n.role === 'link' && n.name === title);
      if (links.length === 1) {
        const allLinks = collectNodes(node, (n) => n.role === 'link');
        if (allLinks.length === 1) {
          match = node;
        }
      }
    }
    for (const child of node.children || []) walk(child);
  }
  walk(tree);
  return match;
}

function findProjectNewLinkRef(tree, projectName) {
  let foundRef = null;
  function walk(node) {
    if (foundRef || !node || typeof node !== 'object') return;
    if (node.role === 'group') {
      const projBtns = collectNodes(node, (n) => n.role === 'button' && n.name === projectName);
      const newLinks = collectNodes(node, (n) => n.role === 'link' && n.name === 'New Conversation in Project');
      if (projBtns.length === 1 && newLinks.length === 1 && newLinks[0].ref_id) {
        foundRef = newLinks[0].ref_id;
        return;
      }
    }
    for (const child of node.children || []) walk(child);
  }
  walk(tree);
  return foundRef;
}

async function findTopNavLinkRef(name, timeoutMs = 4000) {
  const res = await runAgentDesktop(
    ['find', '--app', 'Antigravity', '--role', 'link', '--name', name, '--timeout-ms', String(timeoutMs)],
    timeoutMs + 2000,
  );
  if (res?.ok === false && res?.error) {
    return { errorRes: res, ref: null };
  }
  const match = (res?.data?.matches || []).find((m) => {
    const segs = segmentsAfterSidebar(m.path);
    return isAgyWebareaPath(m.path) && segs >= 0 && segs <= 3;
  });
  return { errorRes: null, ref: match?.ref_id || null };
}

async function expandSidebarSeeMore() {
  const res = await runAgentDesktop(
    ['find', '--app', 'Antigravity', '--role', 'button', '--name', 'See more', '--timeout-ms', '1200'],
    3000,
  ).catch(() => null);
  const btns = (res?.data?.matches || []).filter(
    (m) => isAgyWebareaPath(m.path) && segmentsAfterSidebar(m.path) >= 0 && m.ref_id,
  );
  if (btns.length === 0) return false;
  for (const btn of btns.slice(0, 3)) {
    await runAgentDesktop(['click', btn.ref_id], 4000).catch(() => {});
  }
  await sleep(300);
  return true;
}

async function findConversationLinkRef(title, timeoutMs = 6000) {
  const findRow = async (ms) => {
    const res = await runAgentDesktop(
      ['find', '--app', 'Antigravity', '--role', 'link', '--name', title, '--timeout-ms', String(ms)],
      ms + 2000,
    );
    if (res?.ok === false && res?.error) {
      return { errorRes: res, ref: null };
    }
    const rowMatch = (res?.data?.matches || []).find(
      (m) => isAgyWebareaPath(m.path) && segmentsAfterSidebar(m.path) > 3,
    );
    return { errorRes: null, ref: rowMatch?.ref_id || null };
  };

  const first = await findRow(timeoutMs);
  if (first.errorRes || first.ref) return first;

  const expanded = await expandSidebarSeeMore();
  if (!expanded) return first;
  return findRow(3500);
}

async function findMessageInput(timeoutMs = 1500) {
  const res = await runAgentDesktop(
    ['find', '--app', 'Antigravity', '--role', 'textfield', '--name', 'Message input', '--timeout-ms', String(timeoutMs)],
    timeoutMs + 2000,
  ).catch(() => null);
  if (!res?.ok) return null;
  return (res?.data?.matches || []).find((m) => isAgyWebareaPath(m.path) && m.ref_id) || null;
}

async function detectGlobalMissionControl() {
  const match = await findMessageInput(450);
  if (!match) return true;
  const waName = getWebareaSegmentName(match.path);
  return waName.startsWith('Mission Control') || waName.startsWith('Plugins');
}

function readConversationProgress(conversationId) {
  if (!conversationId || !existsSync(DB_PATH)) return null;
  const safeId = String(conversationId).replace(/[^a-zA-Z0-9-]/g, '');
  if (!safeId) return null;
  try {
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    try {
      const row = db
        .prepare(
          'SELECT step_count, status, last_user_input_time FROM conversation_summaries WHERE conversation_id = ? LIMIT 1',
        )
        .get(safeId);
      if (!row) return null;
      return {
        stepCount: Number(row.step_count || 0),
        status: String(row.status || ''),
        lastUserInputTime: String(row.last_user_input_time || ''),
      };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

async function findSendButtonRef(timeoutMs = 1800) {
  for (const name of ['Send message', 'Queue message', 'Send']) {
    const found = await runAgentDesktop(
      ['find', '--app', 'Antigravity', '--role', 'button', '--name', name, '--timeout-ms', String(timeoutMs)],
      timeoutMs + 1500,
    ).catch(() => null);
    const match = (found?.data?.matches || []).find((m) => isAgyWebareaPath(m.path) && m.ref_id);
    if (match?.ref_id) return match.ref_id;
  }
  return null;
}

async function submitComposerText(text, conversationId = null) {
  const cleanText = String(text || '').replace(/\r?\n+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 8000);
  if (!cleanText) {
    return { status: 400, body: { ok: false, error: 'Prompt text cannot be empty' } };
  }

  let inputMatch = null;
  for (let i = 0; i < 10; i += 1) {
    await sleep(320);
    inputMatch = await findMessageInput(800);
    if (inputMatch?.ref_id) break;
  }
  if (!inputMatch?.ref_id) {
    return { status: 502, body: { ok: false, error: 'Message input not found in Antigravity window' } };
  }

  const valBefore = await runAgentDesktop(['get', inputMatch.ref_id, '--property', 'value'], 4000);
  if (valBefore?.ok === false && valBefore?.error) {
    return mapAxError(valBefore, 'Could not inspect Message input');
  }
  const existingValue = typeof valBefore?.data?.value === 'string' ? valBefore.data.value.trim() : '';
  if (existingValue.length > 0) {
    return {
      status: 409,
      body: {
        ok: false,
        errorCode: 'ACTIVE_DRAFT',
        error: 'Active draft in Message input on Mac; cancelled to avoid overwriting',
      },
    };
  }

  const baseline = conversationId ? readConversationProgress(conversationId) : null;

  const clickInput = await runAgentDesktop(['--headed', 'click', inputMatch.ref_id], 10000);
  if (!clickInput?.ok) {
    return mapAxError(clickInput, 'Could not focus Message input');
  }

  const typeTimeoutMs = Math.max(12000, 6000 + cleanText.length * 45);
  const typeRes = await runAgentDesktop(
    ['--headed', 'type', inputMatch.ref_id, cleanText],
    typeTimeoutMs,
  );
  if (!typeRes?.ok) {
    const fallbackRead = await runAgentDesktop(['get', inputMatch.ref_id, '--property', 'value'], 3000).catch(() => null);
    if (!String(fallbackRead?.data?.value || '').trim()) {
      return mapAxError(typeRes, 'Could not type prompt into Message input');
    }
  }

  await sleep(180);
  const valCheck = await runAgentDesktop(['get', inputMatch.ref_id, '--property', 'value'], 4000).catch(() => null);
  const sendRef = await findSendButtonRef(1800);
  if (!String(valCheck?.data?.value || '').trim() && !sendRef) {
    return { status: 502, body: { ok: false, error: 'Prompt text did not appear in Antigravity Message input' } };
  }

  let submitAttempted = false;
  if (sendRef) {
    const clickSend = await runAgentDesktop(['--headed', 'click', sendRef], 10000);
    if (clickSend?.ok) {
      submitAttempted = true;
    }
  }
  if (!submitAttempted) {
    const pressRes = await runAgentDesktop(['--headed', 'press', 'return', '--app', 'Antigravity'], 10000);
    if (!pressRes?.ok) {
      return mapAxError(pressRes, 'Could not submit prompt in Antigravity');
    }
  }

  // Verify delivery by confirming either Message input cleared or DB recorded the new turn.
  for (let i = 0; i < 10; i += 1) {
    await sleep(350);
    if (conversationId && baseline) {
      const nowDb = readConversationProgress(conversationId);
      if (
        nowDb &&
        (nowDb.status === 'CASCADE_RUN_STATUS_RUNNING' ||
          nowDb.lastUserInputTime !== baseline.lastUserInputTime ||
          nowDb.stepCount > baseline.stepCount)
      ) {
        return { status: 200, body: { ok: true } };
      }
    }
    const freshInput = await findMessageInput(600);
    if (freshInput?.ref_id) {
      const postVal = await runAgentDesktop(['get', freshInput.ref_id, '--property', 'value'], 2500).catch(() => null);
      if (postVal?.ok && String(postVal?.data?.value || '').trim() === '') {
        const lingeringSend = await findSendButtonRef(400);
        if (!lingeringSend) {
          return { status: 200, body: { ok: true } };
        }
      }
    }
  }

  return {
    status: 502,
    body: { ok: false, error: 'Prompt was typed into Antigravity but did not submit' },
  };
}

export async function focusThread(detail) {
  if (!detail?.title) {
    return { status: 404, body: { ok: false, error: 'Conversation not found' } };
  }
  return withUiLock(async () => {
    const { errorRes, ref } = await findConversationLinkRef(detail.title, 6000);
    if (errorRes) {
      return mapAxError(errorRes, 'Accessibility lookup failed');
    }
    if (!ref) {
      return {
        status: 404,
        body: {
          ok: false,
          error: `Conversation "${detail.title}" is not visible in the sidebar`,
          fallbackHint: `Press Cmd+K and type "${detail.title}"`,
        },
      };
    }
    const clicked = await runAgentDesktop(['click', ref]);
    if (!clicked?.ok) {
      return mapAxError(clicked, 'Sidebar click failed');
    }
    return { status: 200, body: { ok: true, title: detail.title, message: `Focused ${detail.title}` } };
  });
}

export async function stopThread(detail) {
  if (!detail?.title) {
    return { status: 404, body: { ok: false, error: 'Conversation not found' } };
  }
  return withUiLock(async () => {
    const tree = await snapshotAntigravitySidebarTree();
    const rowGroup = findConversationRowGroup(tree, detail.title);
    if (!rowGroup) {
      return {
        status: 404,
        body: { ok: false, error: `Could not isolate sidebar row for "${detail.title}"` },
      };
    }
    const stopBtn = collectNodes(rowGroup, (n) => n.role === 'button' && n.name === 'Stop execution')[0];
    if (!stopBtn?.ref_id) {
      return {
        status: 404,
        body: { ok: false, error: `No active Stop button on "${detail.title}"` },
      };
    }
    const clicked = await runAgentDesktop(['click', stopBtn.ref_id]);
    if (!clicked?.ok) {
      return mapAxError(clicked, 'Stop click failed');
    }
    return { status: 200, body: { ok: true, title: detail.title, message: `Stopped ${detail.title}` } };
  });
}

export async function sendMessageToThread(detail, text) {
  if (!detail?.title) {
    const body = { ok: false, error: 'Conversation not found' };
    writeLastAction({ ok: false, conversationId: detail?.id, error: body.error });
    return { status: 404, body };
  }
  return withUiLock(async () => {
    const wasOnGlobal = await detectGlobalMissionControl();
    const { errorRes, ref } = await findConversationLinkRef(detail.title, 6000);
    if (errorRes) {
      const mapped = mapAxError(errorRes, 'Accessibility lookup failed');
      writeLastAction({ ok: false, conversationId: detail.id, title: detail.title, error: mapped.body.error });
      return mapped;
    }
    if (!ref) {
      const body = { ok: false, error: `Conversation "${detail.title}" not visible in sidebar` };
      writeLastAction({ ok: false, conversationId: detail.id, title: detail.title, error: body.error });
      return { status: 404, body };
    }
    const clicked = await runAgentDesktop(['click', ref]);
    if (!clicked?.ok) {
      const mapped = mapAxError(clicked, 'Could not select thread');
      writeLastAction({ ok: false, conversationId: detail.id, title: detail.title, error: mapped.body.error });
      return mapped;
    }

    const res = await submitComposerText(text, detail.id);

    if (wasOnGlobal && res.status === 200) {
      const nav = await findTopNavLinkRef('Mission Control', 2500).catch(() => ({ ref: null }));
      if (nav?.ref) {
        await runAgentDesktop(['click', nav.ref], 4000).catch(() => {});
      }
    }

    if (res.status === 200) {
      const msg = `Sent to ${detail.title}`;
      writeLastAction({ ok: true, conversationId: detail.id, title: detail.title, message: msg });
      return { status: 200, body: { ok: true, title: detail.title, message: msg } };
    }

    writeLastAction({
      ok: false,
      conversationId: detail.id,
      title: detail.title,
      error: res.body?.error || 'Could not send prompt',
    });
    return res;
  });
}

export async function startNewThread(projectName, text) {
  return withUiLock(async () => {
    let newRef = null;
    if (projectName) {
      const tree = await snapshotAntigravitySidebarTree();
      newRef = findProjectNewLinkRef(tree, projectName);
    }
    if (!newRef) {
      const topNew = await findTopNavLinkRef('New Conversation', 4500);
      if (topNew.errorRes) {
        const mapped = mapAxError(topNew.errorRes, 'Accessibility lookup failed');
        writeLastAction({ ok: false, error: mapped.body.error });
        return mapped;
      }
      newRef = topNew.ref;
    }
    if (!newRef) {
      const body = { ok: false, error: 'New Conversation button not visible in sidebar' };
      writeLastAction({ ok: false, error: body.error });
      return { status: 404, body };
    }
    const clicked = await runAgentDesktop(['click', newRef]);
    if (!clicked?.ok) {
      const mapped = mapAxError(clicked, 'Could not start new conversation');
      writeLastAction({ ok: false, error: mapped.body.error });
      return mapped;
    }
    const res = await submitComposerText(text, null);
    if (res.status === 200) {
      const msg = `Started new conversation${projectName ? ` in ${projectName}` : ''}`;
      writeLastAction({ ok: true, message: msg });
      return { status: 200, body: { ok: true, message: msg } };
    }
    writeLastAction({ ok: false, error: res.body?.error || 'Could not start conversation' });
    return res;
  });
}
