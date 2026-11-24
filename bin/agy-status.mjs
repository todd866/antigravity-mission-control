/**
 * agy-status — live non-jumping status readout for Antigravity desktop conversations.
 *
 * Usage:
 *   agy-status          compact aligned instrument table across connected Macs
 *   agy-status --local  only conversations on this Mac
 *   agy-status --json   machine-readable JSON snapshot
 *   agy-status --all    include hidden conversations
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoFedPath = join(scriptDir, '..', 'plugin', 'src', 'federation.mjs');
const pluginFedPath = join(homedir(), '.gemini', 'config', 'plugins', 'mission-control', 'src', 'federation.mjs');
const fedPath = existsSync(repoFedPath) ? repoFedPath : pluginFedPath;

const { getFederatedBoard } = await import(pathToFileURL(fedPath).href);

const args = new Set(process.argv.slice(2));
const jsonMode = args.has('--json');
const includeHidden = args.has('--all');
const localOnly = args.has('--local');

const snap = await getFederatedBoard({ includeFleet: false, includeHidden, localOnly });

if (jsonMode) {
  process.stdout.write(`${JSON.stringify(snap, null, 2)}\n`);
  process.exit(0);
}

function fmtAge(ms) {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

function pad(str, width) {
  const s = String(str ?? '');
  return s.length > width ? `${s.slice(0, Math.max(1, width - 1))}…` : s.padEnd(width);
}

const labels = {
  attention: 'Waiting',
  working: 'Working',
  bg: 'Background',
  unread: 'Unread',
  idle: 'Idle',
};

const { counts } = snap;
const multiHost = (snap.hosts?.length || 0) > 1;
const hostSummary = multiHost
  ? `  [${snap.hosts.map((h) => `${h.name}:${h.online ? 'up' : 'down'}`).join(' ')}]`
  : '';

console.log(
  `ANTIGRAVITY (${snap.sortMode})${hostSummary}  total=${counts.total}  waiting=${counts.attention}  working=${counts.working}  background=${counts.bg}  unread=${counts.unread}  idle=${counts.idle}`,
);

if (multiHost) {
  console.log(
    `${'#'.padStart(2)}  ${'STATUS'.padEnd(10)}  ${'MAC'.padEnd(5)}  ${'PROJECT'.padEnd(14)}  ${'TITLE'.padEnd(30)}  ${'STEP'.padEnd(5)}  ${'AGE'.padStart(4)}  BRIEF / FOCUS`,
  );
} else {
  console.log(
    `${'#'.padStart(2)}  ${'STATUS'.padEnd(10)}  ${'PROJECT'.padEnd(15)}  ${'TITLE'.padEnd(32)}  ${'STEP'.padEnd(5)}  ${'AGE'.padStart(4)}  BRIEF / FOCUS`,
  );
}

for (const c of snap.conversations) {
  const stepStr = c.steps ? `${c.steps.done}/${c.steps.total}` : '  -  ';
  const pinMark = c.pinned ? '*' : ' ';
  const focus = c.waitingReason || c.briefing?.headline || (c.focusIsCurrentTurn ? c.focus : '') || c.lastReply || '';
  const age = `${fmtAge(c.ageMs)}${c.stalled ? '!' : ''}`;
  if (multiHost) {
    console.log(
      `${String(c.slot).padStart(2)}${pinMark}${(labels[c.state] || 'Idle').padEnd(10)}  ${pad(c.host || '-', 5)}  ${pad(c.projectName, 14)}  ${pad(c.title, 30)}  ${stepStr.padEnd(5)}  ${age.padStart(4)}  ${pad(focus, 52)}`,
    );
  } else {
    console.log(
      `${String(c.slot).padStart(2)}${pinMark}${(labels[c.state] || 'Idle').padEnd(10)}  ${pad(c.projectName, 15)}  ${pad(c.title, 32)}  ${stepStr.padEnd(5)}  ${age.padStart(4)}  ${pad(focus, 56)}`,
    );
  }
}
