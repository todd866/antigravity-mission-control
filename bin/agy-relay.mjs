/**
 * agy-relay — CLI for agents (CLI or scripts) to inspect tabs and send/queue messages across Macs.
 *
 * Usage:
 *   agy-relay list [--mac HOST] [--json]
 *   agy-relay send --to <id|title> [--host HOST] [--from LABEL] [--hop N] "<message>"
 *   agy-relay status [relay-id] [--json]
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const TOKEN_PATH = join(HOME, '.local', 'state', 'agy-control', 'token');

function readToken() {
  if (!existsSync(TOKEN_PATH)) {
    throw new Error(`Missing token at ${TOKEN_PATH}`);
  }
  const tok = readFileSync(TOKEN_PATH, 'utf8').trim();
  if (tok.length < 16) throw new Error('Invalid Mission Control token');
  return tok;
}

async function resolveBaseUrl() {
  if (process.env.AGY_CONTROL_URL) {
    return process.env.AGY_CONTROL_URL.replace(/\/+$/, '');
  }
  const ports = process.env.AGY_CONTROL_PORT
    ? [Number(process.env.AGY_CONTROL_PORT)]
    : [8696, 8698];
  for (const port of ports) {
    const base = `http://127.0.0.1:${port}`;
    try {
      const resp = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(4500) });
      if (!resp.ok) continue;
      const body = await resp.json().catch(() => null);
      if (body?.service === 'agy-control-api') return base;
    } catch {
      // Try next port.
    }
  }
  throw new Error('Could not find running agy-control-api on localhost (tried 8696, 8698)');
}

async function apiJson(baseUrl, token, path, { method = 'GET', body = undefined } = {}) {
  const resp = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(25000),
  });
  const text = await resp.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { ok: resp.ok, error: text || `HTTP ${resp.status}` };
  }
  return { status: resp.status, json };
}

function usage() {
  console.log(`Usage:
  agy-relay list [--mac HOST] [--json]
  agy-relay send --to <id|title> [--host HOST] [--from LABEL] [--hop N] "<message>"
  agy-relay status [relay-id] [--json]`);
}

function parseFlags(args) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--json') {
      opts.json = true;
    } else if ((a === '--to' || a === '--host' || a === '--mac' || a === '--from' || a === '--message' || a === '--hop') && i + 1 < args.length) {
      opts[a.slice(2)] = args[i + 1];
      i += 1;
    } else if (a.startsWith('--') && a.includes('=')) {
      const eq = a.indexOf('=');
      opts[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (a === '-h' || a === '--help') {
      opts.help = true;
    } else {
      positional.push(a);
    }
  }
  return { opts, positional };
}

async function main() {
  const [cmd = 'help', ...rest] = process.argv.slice(2);
  const { opts, positional } = parseFlags(rest);
  if (cmd === 'help' || cmd === '--help' || cmd === '-h' || opts.help) {
    usage();
    return;
  }

  const token = readToken();
  const baseUrl = await resolveBaseUrl();

  if (cmd === 'list') {
    const { status, json } = await apiJson(baseUrl, token, '/v1/board');
    if (status >= 300 || !Array.isArray(json.conversations)) {
      console.error(json?.error || `HTTP ${status}`);
      process.exit(1);
    }
    const hostFilter = opts.mac || opts.host || '';
    const rows = hostFilter
      ? json.conversations.filter((c) => c.host === hostFilter)
      : json.conversations;
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      return;
    }
    for (const c of rows) {
      const aw = c.autoWake ? ' [auto-wake]' : '';
      const hl = c.waitingReason || c.briefing?.headline || c.lastReply || '';
      console.log(`#${c.slot} ${c.id.slice(0, 8)} [${c.host || json.host}] ${c.state}${aw}  ${c.title} — ${hl}`);
    }
    return;
  }

  if (cmd === 'send') {
    const target = (opts.to || '').trim();
    const message = (opts.message || positional.join(' ')).trim();
    if (!target || !message) {
      usage();
      process.exit(2);
    }
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target);
    const localHost = hostname().replace(/\.local$/, '');
    const fromConvId = process.env.ANTIGRAVITY_CONVERSATION_ID || '';
    const defaultFrom = fromConvId ? `CLI/Agent ${fromConvId.slice(0, 8)} (${localHost})` : `CLI (${localHost})`;
    const payload = {
      ...(isUuid ? { targetConversationId: target } : { targetTitle: target }),
      ...(opts.host || opts.mac ? { host: opts.host || opts.mac } : {}),
      message,
      fromConversationId: fromConvId,
      fromLabel: opts.from || defaultFrom,
      hop: Number(opts.hop || 1),
    };
    const { status, json } = await apiJson(baseUrl, token, '/v1/relay', { method: 'POST', body: payload });
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
    } else if (json?.ok) {
      const r = json.relay;
      console.log(`${json.delivery.toUpperCase()} ${r.id} -> ${r.targetTitle} [${r.targetHost}]: ${r.reason}`);
    } else {
      console.error(json?.error || `HTTP ${status}`);
    }
    if (!json?.ok || status >= 300) process.exit(1);
    return;
  }

  if (cmd === 'status') {
    const relayId = positional[0] || '';
    const path = relayId ? `/v1/relay?relayId=${encodeURIComponent(relayId)}` : '/v1/relay';
    const { status, json } = await apiJson(baseUrl, token, path);
    if (status >= 300) {
      console.error(json?.error || `HTTP ${status}`);
      process.exit(1);
    }
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
      return;
    }
    const relays = json.relays || [];
    if (relays.length === 0) {
      console.log('No relay messages.');
      return;
    }
    for (const r of relays) {
      console.log(`[${r.status.toUpperCase()}] ${r.id.slice(0, 8)}  ${r.fromLabel} -> ${r.targetTitle} (${r.targetHost})  ${r.reason}`);
    }
    return;
  }

  usage();
  process.exit(2);
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
