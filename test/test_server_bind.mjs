/**
 * test_server_bind.mjs — live checks for the parts of server.mjs that only exist once a socket is
 * open: which address it binds, what it logs about that, the token gate, and the origin policy.
 *
 * Uses a STUB `pi` (a shell loop that reads stdin and never speaks), so no model is contacted and
 * no session file is created. Each case gets its own port and its own scratch data dir.
 *
 * Run: node test/test_server_bind.mjs        (needs ports 4391-4399 free)
 *
 * Nothing here proves the UI works — that is the jsdom suites' job. This proves the network posture.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { listIpv4, tailscaleAddress, lanAddress } from "../net.mjs";

const REPO = path.resolve(import.meta.dirname, "..");
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-bind-"));
const STUB = path.join(SCRATCH, "pi-stub");
fs.writeFileSync(STUB, "#!/usr/bin/env bash\nwhile IFS= read -r _; do :; done\n", { mode: 0o755 });
const SESSIONS = path.join(SCRATCH, "sessions");
fs.mkdirSync(SESSIONS, { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`PASS  ${name}${extra ? "  -- " + extra : ""}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? "  -- " + extra : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(host, port, urlPath, headers = {}, method = "GET", body = null) {
  return new Promise((resolve) => {
    const req = http.request({ host, port, path: urlPath, method, headers }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", (e) => resolve({ status: 0, error: e.code || e.message, headers: {}, body: "" }));
    req.setTimeout(3000, () => { req.destroy(); resolve({ status: 0, error: "timeout", headers: {}, body: "" }); });
    req.end(body == null ? undefined : body);
  });
}

function startServer(env, port) {
  const child = spawn(process.execPath, [path.join(REPO, "server.mjs")], {
    cwd: REPO,
    env: {
      ...process.env,
      PI_BIN: STUB,
      PI_SESSIONS_DIR: SESSIONS,
      PI_WEB_PORT: String(port),
      PI_WEB_DATA_DIR: path.join(SCRATCH, "data-" + port),
      PI_WEB_CWD: SCRATCH,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  child.out = () => out;
  child.exited = new Promise((r) => child.on("exit", (code) => r(code)));
  return child;
}

async function waitUp(host, port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const r = await request(host, port, "/healthz");
    if (r.status === 200) return r;
    await sleep(100);
  }
  return null;
}

function wsProbe(host, port, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${host}:${port}/ws`, { headers });
    const t = setTimeout(() => { try { ws.terminate(); } catch {} resolve({ connected: false, reason: "timeout" }); }, 4000);
    ws.on("message", (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.kind === "hello") { clearTimeout(t); ws.close(); resolve({ connected: true, hello: m }); }
    });
    ws.on("error", (e) => { clearTimeout(t); resolve({ connected: false, reason: e.message }); });
    ws.on("unexpected-response", (req, res) => {
      clearTimeout(t); resolve({ connected: false, reason: "http " + res.statusCode });
    });
  });
}

const TS = tailscaleAddress();
const LAN = lanAddress();

/* ---------- 1. localhost: static, traversal, WS ---------- */
{
  const port = 4391;
  const srv = startServer({ PI_WEB_HOST: "localhost" }, port);
  const h = await waitUp("127.0.0.1", port);
  ok("localhost binds and answers /healthz", !!h && JSON.parse(h.body).ok === true, h ? h.body : srv.out().slice(-200));
  const idx = await request("127.0.0.1", port, "/");
  ok("serves index.html", idx.status === 200 && idx.body.includes('<div id="app">'));
  const trav = await request("127.0.0.1", port, "/../../etc/passwd");
  ok("path traversal does not escape public/", trav.status === 404 || trav.status === 403, "status=" + trav.status);
  const ws = await wsProbe("127.0.0.1", port);
  ok("WS /ws delivers hello (Origin-less client allowed)", ws.connected && ws.hello.state === "running", JSON.stringify(ws.hello || ws.reason));
  srv.kill("SIGTERM"); await sleep(250);
}

/* ---------- 2. auto: one address, and the log says so ---------- */
{
  const port = 4392;
  const srv = startServer({ PI_WEB_HOST: "auto" }, port);
  await sleep(700);
  const log = srv.out();
  const m = /listening on http:\/\/([0-9.]+):4392/.exec(log);
  const bound = m ? m[1] : null;
  ok("auto binds a usable address", !!bound, "bound=" + bound);
  ok("the log never claims additional listening addresses",
     !/also reachable at/.test(log), log.split("\n").filter((l) => /listening|not bound/.test(l)).join(" | "));
  const h = bound ? await waitUp(bound, port) : null;
  ok("the bound address answers", !!h && h.status === 200);
  if (bound && LAN && bound === TS) {
    const lanTry = await request(LAN, port, "/healthz");
    ok("an address it is NOT bound to really is not listening (honest log)",
       lanTry.status === 0, `${LAN} → ${lanTry.error}`);
    ok("the log names the addresses it is not serving",
       log.includes("not bound:") && log.includes(LAN), log.split("\n").find((l) => l.includes("not bound")) || "");
  }
  srv.kill("SIGTERM"); await sleep(250);
}

/* ---------- 3. lan: private only ---------- */
if (LAN) {
  const port = 4393;
  const srv = startServer({ PI_WEB_HOST: "lan" }, port);
  await sleep(700);
  const m = /listening on http:\/\/([0-9.]+):4393/.exec(srv.out());
  const bound = m ? m[1] : null;
  ok("lan binds a private (RFC1918) address", bound === LAN, `bound=${bound} expected=${LAN}`);
  const h = bound ? await waitUp(bound, port) : null;
  ok("the lan-bound address answers", !!h && h.status === 200);
  srv.kill("SIGTERM"); await sleep(250);
} else {
  console.log("SKIP  lan case — this host has no private IPv4 address");
}

/* ---------- 4. all: every interface ---------- */
{
  const port = 4394;
  const srv = startServer({ PI_WEB_HOST: "all" }, port);
  await sleep(700);
  const log = srv.out();
  ok("all logs that it answers on every interface", /answering on every interface/.test(log));
  const h = await waitUp("127.0.0.1", port);
  ok("all answers on loopback", !!h && h.status === 200);
  if (LAN) {
    const viaLan = await request(LAN, port, "/healthz");
    ok("all answers on the LAN address too (both networks from one listen)", viaLan.status === 200, `${LAN} → ${viaLan.status}`);
  }
  if (TS) {
    const viaTs = await request(TS, port, "/healthz");
    ok("all answers on the Tailscale address as well", viaTs.status === 200, `${TS} → ${viaTs.status}`);
  }
  srv.kill("SIGTERM"); await sleep(250);
}

/* ---------- 5. a public bind without a token is refused ---------- */
{
  const port = 4395;
  const srv = startServer({ PI_WEB_HOST: "203.0.113.9" }, port);
  const code = await Promise.race([srv.exited, sleep(3000).then(() => "still-running")]);
  const log = srv.out();
  ok("binding a public address with no token exits instead of exposing the agent",
     code === 1, `exit=${code}`);
  ok("the refusal names the fix", /PI_WEB_TOKEN/.test(log), log.trim().split("\n").pop());
  try { srv.kill("SIGTERM"); } catch {}
}

/* ---------- 6. token gate + origin policy ---------- */
{
  const port = 4396;
  const TOKEN = "s3cret-smoke-token";
  const srv = startServer({ PI_WEB_HOST: "localhost", PI_WEB_TOKEN: TOKEN }, port);
  await sleep(800);

  ok("anonymous request is refused", (await request("127.0.0.1", port, "/")).status === 401);
  ok("/healthz is gated too", (await request("127.0.0.1", port, "/healthz")).status === 401);
  ok("a wrong token is refused", (await request("127.0.0.1", port, "/?token=nope")).status === 401);

  const good = await request("127.0.0.1", port, "/?token=" + TOKEN);
  const cookie = (good.headers["set-cookie"]?.[0] || "").split(";")[0];
  ok("?token= sets a cookie and redirects", good.status === 302 && cookie.startsWith("piweb_token="), "status=" + good.status);
  ok("the redirect strips the token from the URL", good.headers.location === "/", "location=" + good.headers.location);

  const withCookie = await request("127.0.0.1", port, "/", { cookie });
  ok("the cookie authorises the app", withCookie.status === 200 && withCookie.body.includes('<div id="app">'));
  ok("Authorization: Bearer works for scripts",
     (await request("127.0.0.1", port, "/healthz", { authorization: "Bearer " + TOKEN })).status === 200);
  ok("WS without a token is refused", (await wsProbe("127.0.0.1", port)).connected === false);
  ok("WS with the cookie connects",
     (await new Promise((resolve) => {
       const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } });
       const t = setTimeout(() => { try { ws.terminate(); } catch {} resolve(false); }, 4000);
       ws.on("message", (raw) => { try { if (JSON.parse(raw.toString()).kind === "hello") { clearTimeout(t); ws.close(); resolve(true); } } catch {} });
       ws.on("error", () => { clearTimeout(t); resolve(false); });
     })) === true);
  srv.kill("SIGTERM"); await sleep(250);
}

/* ---------- 7. origin policy with no token (the default deployment) ---------- */
{
  const port = 4397;
  const srv = startServer({ PI_WEB_HOST: "localhost" }, port);
  await waitUp("127.0.0.1", port);

  const evil = await wsProbe("127.0.0.1", port, { origin: "https://evil.example" });
  ok("a WebSocket from another site is refused (CSWSH)", evil.connected === false && evil.reason.includes("403"), evil.reason);

  const same = await wsProbe("127.0.0.1", port, { origin: `http://127.0.0.1:${port}` });
  ok("a same-origin WebSocket still connects", same.connected === true, JSON.stringify(same.hello || same.reason));

  const sub = JSON.stringify({ endpoint: "https://push.example/sub", keys: { p256dh: "x", auth: "y" } });
  const crossPost = await request("127.0.0.1", port, "/push/subscribe",
    { origin: "https://evil.example", "content-type": "application/json" }, "POST", sub);
  ok("a cross-origin POST is refused", crossPost.status === 403, "status=" + crossPost.status);

  const samePost = await request("127.0.0.1", port, "/push/subscribe",
    { origin: `http://127.0.0.1:${port}`, "content-type": "application/json" }, "POST", sub);
  ok("a same-origin POST is accepted", samePost.status === 200, "status=" + samePost.status);

  ok("the default run logs that it has no auth", /access control: NONE/.test(srv.out()));
  srv.kill("SIGTERM"); await sleep(250);
}

/* ---------- cleanup ---------- */
try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {}
console.log(`\n=== ${pass}/${pass + fail} passed ===`);
process.exit(fail ? 1 : 0);
