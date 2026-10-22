/* test_busy_guard.mjs — LIVE regression test for the mid-turn session guard (2026-09-24).
 *
 * The incident: test_native_mappings.mjs (run from a bash tool inside the live pi
 * session) connected to the GUI's WS and sent `compact` to the running pi MID-TURN.
 * The mid-turn compact split the active turn and desynced the browser's view.
 *
 * The fix under test: server.mjs tracks piBusy via agent_start/agent_settled and
 * refuses compact/fork/clone while busy (reply: kind:"error", "pi is mid-turn; ...").
 * Escape hatches (switch_session/new_session/abort) stay unguarded.
 *
 * Self-contained: spawns a THROWAWAY pi-web server on :4399 (never your live
 * :4321) pointed at the --no-session pi wrapper, drives it over the real WebSocket
 * exactly like a browser client, then tears it down. The prompt is engineered to
 * include a 6s bash tool call so the busy window is wide and the test race-free:
 * we wait for the broadcast agent_start BEFORE sending the blocked commands.
 *
 * Run from the project root:  node test/test_busy_guard.mjs
 * Requires pi + a reachable model backend. Port 4399 must be free.
 */
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PORT = 4399;
const WRAPPER = path.join(HERE, "pi-nosession");
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${n}${extra ? "  -- " + extra : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fail fast on a lingering scratch server: its healthz would answer while serving
// STALE code, lying to every assertion below (same footgun the teardown comment warns about).
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

let ws;
const teardown = () => {
  try { ws?.close(); } catch {}
  try { server.kill('SIGTERM'); } catch {}
  try { server.kill('SIGKILL'); } catch {}
};

try {
  let healthy = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      const j = await r.json();
      if (j.ok && j.pi === "running") { healthy = true; break; }
    } catch {}
    await sleep(500);
  }
  ok("scratch server on :4399 healthy (pi running)", healthy);
  if (!healthy) { console.log(serverLog); throw new Error("scratch server never became healthy"); }

  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const inbox = [];
  ws.on("message", (d) => inbox.push(JSON.parse(d.toString())));
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });

  const waitFor = async (pred, ms = 45000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const h = inbox.find(pred);
      if (h) return h;
      await sleep(150);
    }
    return null;
  };
  const rpc = (o) => ws.send(JSON.stringify({ kind: "rpc", data: o }));
  const evt = (t) => (m) => m.kind === "rpc" && m.data?.type === t;
  const isResp = (cmd) => (m) => m.kind === "rpc" && m.data?.type === "response" && m.data?.command === cmd;

  // A turn guaranteed to be in flight for several seconds: a 6s bash tool call.
  rpc({ type: "prompt", message: "Use the bash tool to run exactly: sleep 6 && echo guard-ok\nThen reply with exactly: GUARD-TURN-COMPLETE" });

  const start = await waitFor(evt("agent_start"));
  ok("turn began (agent_start broadcast)", !!start);
  if (!start) throw new Error("no agent_start — cannot test the busy window");

  // The window is open: compact must be REFUSED with the guard error.
  inbox.length = 0;
  rpc({ type: "compact" });
  const blocked = await waitFor((m) => m.kind === "error" && /pi is mid-turn; compact is blocked/.test(m.error || ""), 10000);
  ok("compact mid-turn is blocked by the guard", !!blocked,
     blocked ? blocked.error : (inbox.map((m) => m.kind).join(',') || 'no reply'));

  // The guard covers the other mutators too (fork — same set, no second turn needed).
  rpc({ type: "fork" });
  const blockedFork = await waitFor((m) => m.kind === "error" && /pi is mid-turn; fork is blocked/.test(m.error || ""), 10000);
  ok("fork mid-turn is blocked by the guard", !!blockedFork, blockedFork ? blockedFork.error : 'no reply');

  // Server-side bookkeeping logged the transition into busy.
  ok("server logged the busy transition", /turn started \(agent_start\)/.test(serverLog));

  // Wait for the turn to fully settle (agent_settled fires exactly once at the end —
  // agent_end is NOT sufficient: it may be followed by retry/compaction/continuations).
  // Real model turns take 60-300s (long prefill + thinking + the 6s sleep) — see
  // verify_thinking_live.mjs, which allows 300s. Slow by design; do not "fix" this down.
  const settled = await waitFor(evt("agent_settled"), 300000);
  ok("turn settled (agent_settled broadcast)", !!settled);
  if (!settled) throw new Error("no agent_settled within 300s");
  ok("server logged the settle transition", /turn settled \(agent_settled\)/.test(serverLog));

  // Settled: compact reaches pi again (success, or an honest "nothing to compact").
  rpc({ type: "compact" });
  const after = await waitFor(isResp("compact"), 30000);
  ok("compact after settle is NOT blocked (reaches pi)",
     !!after && !(after?.data?.success === false && /mid-turn/.test(after?.data?.error || '')),
     after ? JSON.stringify(after.data).slice(0, 120) : 'no response');
} finally {
  teardown();
}

console.log(`\n=== ${pass}/${pass + fail} busy-guard assertions passed ===`);
process.exit(fail === 0 ? 0 : 1);
