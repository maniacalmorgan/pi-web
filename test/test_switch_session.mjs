/* test_switch_session.mjs — LIVE regression test for rail session switching + highlight.
 *
 * Covers the 2026-09-23 bug: the client sent `sessionId` to switch_session (pi wants
 * `sessionPath`), so clicking a session failed with
 *   "Cannot read properties of undefined (reading 'startsWith')"
 * and the active-row highlight never matched (get_state returns a raw UUID as `sessionId`,
 * but rail rows are keyed on the header id / file path).
 *
 * Self-contained: spawns a THROWAWAY pi-web server on :4399 (never your live :4321),
 * pointed at a --no-session pi wrapper so no session litter is created, drives it over the
 * real WebSocket exactly as the browser client does, then tears it down.
 *
 * Run from the project root:  node test/test_switch_session.mjs
 * Requires the live server to be UP? No. Requires pi + a reachable model backend.
 * Port 4399 must be free (registered as a test port).
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
  // SIGTERM then SIGKILL — a scratch server that lingers on :4399 makes the NEXT run's health
  // poll lie (it answers while serving stale code). Hard-kill so the port is always freed.
  try { server.kill('SIGTERM'); } catch {}
  try { server.kill('SIGKILL'); } catch {}
};

try {
  // wait for the scratch server to be healthy
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

  // the scratch instance must be serving the FIXED client bundle
  const js = await (await fetch(`${BASE}/app.js`)).text();
  ok("client sends sessionPath (not sessionId) on switch", js.includes("sessionPath: s.path"));
  ok("client no longer sends sessionId for switch", !js.includes("type: 'switch_session', sessionId"));
  ok("client records activeSessionFile from get_state", js.includes("S.activeSessionFile = data.sessionFile"));
  ok("rail highlight keys off the path", js.includes("s.path === S.activeSessionFile"));

  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const inbox = [];
  ws.on("message", (d) => inbox.push(JSON.parse(d.toString())));
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });

  const waitFor = async (pred, ms = 25000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const h = inbox.find(pred); if (h) return h; await sleep(150); }
    return null;
  };
  const rpc = (o) => ws.send(JSON.stringify({ kind: "rpc", data: o }));
  const isResp = (cmd) => (m) => m.kind === "rpc" && m.data?.type === "response" && m.data?.command === cmd;

  ws.send(JSON.stringify({ kind: "get_sessions" }));
  const listMsg = await waitFor((m) => m.kind === "sessions" && Array.isArray(m.sessions) && m.sessions.length > 1);
  if (!listMsg) throw new Error("no session list from scratch server");
  const rows = listMsg.sessions;
  ok("session list has >=2 rows", rows.length >= 2, `${rows.length}`);
  ok("every row exposes a .path (the highlight key)", rows.every((s) => typeof s.path === "string" && s.path.endsWith(".jsonl")));

  rpc({ type: "get_state" });
  const st0 = await waitFor(isResp("get_state"));
  const curFile = st0?.data?.data?.sessionFile;
  const target = rows.find((s) => s.path !== curFile) || rows[0];

  // A) the FIXED call succeeds AND pi actually moves there
  inbox.length = 0;
  rpc({ type: "switch_session", sessionPath: target.path });
  const a = await waitFor(isResp("switch_session"));
  ok("switch_session{sessionPath} succeeds", a?.data?.success === true,
     a ? `success=${a.data.success} cancelled=${a.data?.data?.cancelled}` : "no response");
  rpc({ type: "get_state" });
  const st1 = await waitFor(isResp("get_state"));
  const nowFile = st1?.data?.data?.sessionFile;
  ok("pi is now on the target session file", nowFile === target.path, `${nowFile}`);

  // B) the highlight key resolves against the rail listing
  ok("get_state.sessionFile matches a rail row (highlight works)", rows.some((s) => s.path === nowFile));

  // C) the OLD call still fails — proves the fix is load-bearing, not cosmetic
  inbox.length = 0;
  rpc({ type: "switch_session", sessionId: target.id });
  const c = await waitFor(isResp("switch_session"));
  const err = c?.data?.error || "";
  ok("switch_session{sessionId} still fails (bug is real)", c?.data?.success === false && err.includes("startsWith"),
     `success=${c?.data?.success} error=${JSON.stringify(err)}`);
} catch (e) {
  fail++;
  console.log(`FAIL  harness error: ${e.message}`);
  if (serverLog) console.log("--- scratch server log ---\n" + serverLog.slice(-2000));
} finally {
  teardown();
}

console.log(`\n=== ${pass}/${pass + fail} passed ===`);
process.exit(fail ? 1 : 0);
