// Verify the native-command MAPPINGS actually work over RPC — the whole point.
//
// 2026-09-24: this test originally connected straight to the LIVE server on
// 127.0.0.1:4321 — whatever session happened to be open. Run from a bash tool
// inside that same session, its `compact` RPC hit the live pi MID-TURN, splitting
// the active turn and desyncing the browser view. It now spawns its own throwaway
// pi-web server on :4399 (like test_switch_session.mjs / test_busy_guard.mjs),
// pointed at the --no-session pi wrapper, and refuses to run if :4399 is already
// in use (a lingering scratch server answers healthz with STALE code and would
// lie to every assertion).
//
// A short priming prompt runs first so read-only mappings like
// get_last_assistant_text have real content on the fresh scratch instance.
//
// Run from the project root:  node test/test_native_mappings.mjs
// Requires pi + a reachable model backend. Port 4399 must be free.
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PORT = 4399;
const WRAPPER = path.join(HERE, "pi-nosession");
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
const ok = (n, p, d) => { results.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fail fast: never run against a foreign/lingering server (the 2026-09-24 incident
// happened because this test happily adopted whatever was live).
try {
  const r = await fetch(`${BASE}/healthz`);
  if (r.ok) {
    console.error(`port ${PORT} already answers healthz — a scratch server is lingering. Kill it and re-run.`);
    process.exit(2);
  }
} catch { /* port free — good */ }

const server = spawn(process.execPath, ["server.mjs"], {
  cwd: ROOT,
  env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_HOST: "127.0.0.1", PI_BIN: WRAPPER },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (c) => (serverLog += c));
server.stderr.on("data", (c) => (serverLog += c));

const teardown = () => {
  try { server.kill('SIGTERM'); } catch {}
  try { server.kill('SIGKILL'); } catch {}
};

let healthy = false;
for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(`${BASE}/healthz`);
    const j = await r.json();
    if (j.ok && j.pi === "running") { healthy = true; break; }
  } catch {}
  await sleep(500);
}
if (!healthy) {
  console.log(serverLog);
  console.error("scratch server never became healthy");
  teardown();
  process.exit(2);
}

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
const pending = new Map();
const inbox = [];
ws.on("message", (raw) => {
  let m; try { m = JSON.parse(raw.toString()); } catch { return; }
  inbox.push(m);
  if (m.kind === 'error') { onGuardError(m); return; }
  if (m.kind !== 'rpc' || !m.data || m.data.type !== 'response') return;
  const rec = pending.get(m.data.command);
  if (!rec) return;
  pending.delete(m.data.command);
  let good = false;
  try { good = rec.check(m.data); } catch (e) { good = false; }
  ok(rec.label, good, good ? '' : JSON.stringify(m.data).slice(0, 140));
  rec.resolve();
});

function ask(cmd, label, check) {
  return new Promise((resolve) => {
    const key = cmd.type;
    pending.set(key, { label, check, resolve });
    ws.send(JSON.stringify({ kind: 'rpc', data: cmd }));
    setTimeout(() => { if (pending.has(key)) { pending.delete(key); ok(label, false, 'timeout'); resolve(); } }, 30000);
  });
}

// Guard refusals arrive as kind:"error" (NOT a kind:"rpc" response) with no command
// field — name-matched here so a mid-turn block fails LOUD with the reason instead of
// a silent 30s timeout (the failure mode that hid the 2026-09-24 incident).
function onGuardError(m) {
  const err = m.error || '';
  for (const [key, rec] of [...pending]) {
    if (err.includes(key)) {
      pending.delete(key);
      ok(rec.label, false, `blocked: ${err}`);
      rec.resolve();
    }
  }
}

const waitFor = async (pred, ms = 45000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (inbox.find(pred)) return true;
    await sleep(150);
  }
  return false;
};
const evt = (t) => (m) => m.kind === "rpc" && m.data?.type === t;

try {
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });

  // Prime the fresh scratch session with one short turn so read-only mappings
  // (get_last_assistant_text, get_fork_messages) have real content to verify against.
  // Real model turns take 60-300s — the wait MUST clear agent_settled, otherwise the
  // compact below lands mid-turn and the busy guard (correctly) refuses it.
  ws.send(JSON.stringify({ kind: "rpc", data: { type: "prompt", message: "Reply with exactly: pong" } }));
  ok("priming turn settled (agent_settled)", await waitFor(evt("agent_settled"), 300000));

  // 1. compact -> RPC equivalent of native /compact
  //    success=false with a *reason* still proves the mapping reached pi.
  await ask({ type: 'compact' }, 'native /compact -> rpc compact', (d) =>
    d.success === true || /nothing to compact/i.test(d.error || ''));

  // 2. session stats -> RPC equivalent of native /session
  await ask({ type: 'get_session_stats' }, 'native /session -> rpc get_session_stats', (d) => d.success && d.data && d.data.contextUsage);

  // 3. get_last_assistant_text -> RPC equivalent of native /copy
  //    data may be a string or {text} across pi versions — normalize before checking.
  await ask({ type: 'get_last_assistant_text' }, 'native /copy -> rpc get_last_assistant_text', (d) => {
    if (!d.success || !d.data) return false;
    const t = typeof d.data === "string" ? d.data : (d.data.text || "");
    return /pong/i.test(t);
  });

  // 4. get_fork_messages -> RPC equivalent of native /fork
  await ask({ type: 'get_fork_messages' }, 'native /fork -> rpc get_fork_messages', (d) => d.success && Array.isArray((d.data || {}).messages));

  // 5. models list -> needed by native /model <id>
  await ask({ type: 'get_available_models' }, 'native /model -> rpc get_available_models', (d) => d.success && (d.data.models || []).length > 0);

  // 6. thinking levels -> needed by native /thinking <level>
  await ask({ type: 'get_available_thinking_levels' }, 'native /thinking -> rpc get_available_thinking_levels', (d) => d.success && (d.data.levels || []).length > 0);
} finally {
  teardown();
}

console.log(`\n=== ${results.filter(Boolean).length}/${results.length} native mappings verified ===`);
process.exit(results.every(Boolean) ? 0 : 1);
