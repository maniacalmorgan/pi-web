#!/usr/bin/env node
/**
 * pi-web — browser front-end for the pi coding agent.
 *
 * Spawns `pi --mode rpc` and bridges its JSONL protocol to browsers over a
 * WebSocket. Serves the static UI from ./public.
 *
 * Env:
 *   PI_WEB_PORT      listen port                    (default 4321)
 *   PI_WEB_HOST      bind address                   (default "auto")
 *                    auto      → Tailscale address if there is one, else a private (RFC1918)
 *                                LAN address, else 127.0.0.1. Never a public address.
 *                    tailscale → the Tailscale (100.64.0.0/10) address, fail if none
 *                    lan       → a private (RFC1918) address, fail if none
 *                    localhost → 127.0.0.1 only
 *                    all       → 0.0.0.0 (every interface — explicit opt-in)
 *                    anything else is used verbatim (an IP or a hostname); naming a PUBLIC
 *                    address requires PI_WEB_TOKEN or PI_WEB_ALLOW_PUBLIC=1
 *   PI_WEB_CWD       agent working directory        (default $HOME)
 *   PI_BIN           pi executable                  (default "pi")
 *   PI_SESSIONS_DIR  where pi keeps sessions        (default $HOME/.pi/agent/sessions)
 *   PI_WEB_DATA_DIR  VAPID keys + push subscriptions (default ./data)
 *   PI_WEB_TOKEN     optional shared secret; when set, every request and WebSocket
 *                    must present it (see "Access control" in the README)
 *   PI_WEB_ALLOWED_ORIGINS  extra origins allowed to open a WebSocket, comma separated, or "*"
 *   PI_WEB_ALLOW_PUBLIC      set to 1 to bind a public address with no token (dangerous)
 *
 * One process listens on ONE address. To serve both a tailnet and a plain LAN at the same time,
 * bind `all` — with the warning that comes with it.
 *
 * Access control: by default there is NO authentication — the intended deployment is a
 * private network (your Tailscale tailnet, or a trusted LAN). This process can run shell
 * commands, so never expose it to the public internet without PI_WEB_TOKEN in front of it.
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { WebSocketServer, WebSocket } from "ws";
import { pickBindAddress, originAllowed, parseAllowedOrigins, listIpv4 } from "./net.mjs";
import {
  initPush,
  getPublicKey,
  saveSubscription,
  removeSubscription,
  notifyPayloadForEvent,
  sendToAll,
} from "./push.mjs";

const PORT = Number(process.env.PI_WEB_PORT || 4321);
const CWD = process.env.PI_WEB_CWD || os.homedir();
const PI_BIN = process.env.PI_BIN || "pi";
const SESSIONS_DIR = process.env.PI_SESSIONS_DIR || path.join(os.homedir(), ".pi", "agent", "sessions");
const DATA_DIR = process.env.PI_WEB_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "data");
const TOKEN = (process.env.PI_WEB_TOKEN || "").trim();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_WS_PAYLOAD = 30 * 1024 * 1024; // roomy: base64 images

/* ------------------------------------------------------------------ */
/* Bind address + request policy                                       */
/* ------------------------------------------------------------------ */

const WANTED_HOST = (process.env.PI_WEB_HOST || "auto").trim();
const RESOLVED = pickBindAddress(WANTED_HOST);

function fatal(msg) {
  console.error(`pi-web: ${msg}`);
  process.exit(1);
}

if (RESOLVED.error) fatal(RESOLVED.error);
const HOST = RESOLVED.host;
const HOST_KIND = RESOLVED.kind;

/* Binding a wide/public address with no auth is a footgun, not a default. `all` is an explicit
   opt-in and only warns; an explicitly named PUBLIC address is refused unless you say otherwise. */
const ALLOW_PUBLIC = /^(1|true|yes)$/i.test(String(process.env.PI_WEB_ALLOW_PUBLIC || ""));
if (HOST_KIND === "public" && !TOKEN) {
  if (!ALLOW_PUBLIC) {
    fatal(
      `refusing to bind the public address ${HOST} without authentication. ` +
        "Set PI_WEB_TOKEN (recommended), or PI_WEB_ALLOW_PUBLIC=1 if you really mean to expose it."
    );
  }
  console.warn(`pi-web: WARNING — binding the public address ${HOST} with no authentication.`);
}

const ORIGIN_POLICY = parseAllowedOrigins(process.env.PI_WEB_ALLOWED_ORIGINS);

/* ------------------------------------------------------------------ */
/* Access control (opt-in shared secret, PI_WEB_TOKEN)                 */
/* ------------------------------------------------------------------ */

/**
 * Constant-time comparison that doesn't leak the token length.
 * sha256 both sides so the buffers are always the same size.
 */
function tokenMatches(candidate) {
  if (!TOKEN) return true;
  if (typeof candidate !== "string" || !candidate) return false;
  const a = crypto.createHash("sha256").update(candidate).digest();
  const b = crypto.createHash("sha256").update(TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

function cookieValue(header, name) {
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** The token may arrive as a cookie (set by the ?token= exchange), a query param,
    an Authorization: Bearer header, or X-Pi-Web-Token. */
function isAuthorized(req, url) {
  if (!TOKEN) return true;
  if (tokenMatches(cookieValue(req.headers.cookie, "piweb_token"))) return true;
  if (url && tokenMatches(url.searchParams.get("token"))) return true;
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ") && tokenMatches(auth.slice(7).trim())) return true;
  if (tokenMatches(req.headers["x-pi-web-token"])) return true;
  return false;
}

const AUTH_COOKIE = `piweb_token=${encodeURIComponent(TOKEN)}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`;


/* ------------------------------------------------------------------ */
/* Pi RPC process management                                           */
/* ------------------------------------------------------------------ */

let proc = null;
let piState = "stopped"; // stopped | starting | running | exited
let currentSessionFile = null; // last sessionFile reported by pi via get_state
// True while pi is mid-turn (agent_start .. agent_settled). Boolean set/clear, NOT
// a counter: one prompt can emit agent_end + retries/compaction/queued continuations,
// but agent_settled fires exactly once at the end (docs/rpc.md). Reset on every pi
// lifecycle transition so a crashed/hung pi never leaves the guard latched.
let piBusy = false;
const clients = new Set();

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(s);
  }
}

function piSend(cmd) {
  if (!proc || proc.stdin.destroyed) throw new Error("pi process not running");
  proc.stdin.write(JSON.stringify(cmd) + "\n");
}

/**
 * Read request body as a string. Resolves on 'end', 'error', or after 16 KB.
 * 10-s safety timeout (unref'd) prevents hanging forever.
 */
function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    const safety = setTimeout(() => { resolve(data); }, 10_000);
    safety.unref();
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 16 * 1024) {
        req.destroy();
        clearTimeout(safety);
        resolve(data);
      }
    });
    req.on("end", () => { clearTimeout(safety); resolve(data); });
    req.on("error", () => { clearTimeout(safety); resolve(data); });
  });
}

function spawnPi() {
  if (proc) return;
  piState = "starting";
  piBusy = false;
  log(`spawning pi (cwd=${CWD})`);
  proc = spawn(PI_BIN, ["--mode", "rpc"], {
    cwd: CWD,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const spawned = proc;
  let started = false;
  const timeout = setTimeout(() => {
    if (!started) log("warn: pi still not ready after 20s");
  }, 20_000);
  timeout.unref();

  // Mark ready on SPAWN, not on the first stdout line.
  // pi emits NOTHING until it receives a command, so gating readiness on its first
  // output line deadlocks: the server won't send a command until state==="running",
  // and pi won't print until it gets one. (Found by end-to-end test, 2026-09-22.)
  const markReady = (why) => {
    if (started) return;
    started = true;
    clearTimeout(timeout);
    piState = "running";
    log(`pi ready (${why})`);
    broadcast({ kind: "pi_status", state: "running" });
    refreshSessions();
  };
  proc.on("spawn", () => markReady("spawn event"));

  // Strict JSONL reader per docs/rpc.md: split on \n only, strip trailing \r.
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  const onLine = (line) => {
    let data;
    try {
      data = JSON.parse(line);
    } catch (e) {
      log("warn: bad JSON line from pi:", line.slice(0, 200));
      return;
    }
    if (!started) markReady("first output line");
    // Track mid-turn state for the busy guard (see piBusy above).
    if (data.type === "agent_start") {
      if (!piBusy) { piBusy = true; log("turn started (agent_start)"); }
    } else if (data.type === "agent_settled") {
      if (piBusy) { piBusy = false; log("turn settled (agent_settled)"); }
    }
    // Push notification hook — sendToAll returns a Promise; .catch() is now meaningful
    {
      const p = notifyPayloadForEvent(data);
      if (p) sendToAll(p).catch(() => {});
    }
    // Push a session-list update after operations that mutate session files.
    if (
      data.type === "response" &&
      ["new_session", "switch_session", "fork", "clone", "set_session_name"].includes(data.command)
    ) {
      refreshSessions();
    }
    // Track which session file pi currently has open, so rename/delete of the
    // active session can keep pi's in-memory state consistent.
    if (data.type === "response" && data.command === "get_state" && data.success && data.data?.sessionFile) {
      currentSessionFile = data.data.sessionFile;
    }
    broadcast({ kind: "rpc", data });
  };

  proc.stdout.on("data", (chunk) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    for (;;) {
      const i = buffer.indexOf("\n");
      if (i === -1) break;
      let line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim()) onLine(line);
    }
  });
  proc.stderr.on("data", (d) => {
    const s = String(d).trim();
    if (s) log("pi stderr:", s.slice(0, 500));
  });
  proc.on("error", (e) => {
    log("pi spawn error:", e.message);
    piState = "exited";
    piBusy = false;
    proc = null;
    broadcast({ kind: "pi_status", state: "exited", error: e.message });
  });
  proc.on("exit", (code, signal) => {
    log(`pi exited code=${code} signal=${signal}`);
    // Stale-exit guard (2026-09-28): if a restart already replaced `proc`, this exit
    // belongs to a superseded child — do NOT null out the live one or broadcast
    // "exited", which would leave clients thinking pi is dead while it is running.
    if (proc !== spawned) {
      log("  (ignoring exit from a superseded pi process)");
      return;
    }
    piState = "exited";
    piBusy = false;
    proc = null;
    broadcast({ kind: "pi_status", state: "exited", code });
  });
}

/* Whitelisted RPC command types the browser may send to pi. */
/* Commands that rebuild/rebranch the active session's history. Refused while pi is
   mid-turn: they split the in-flight turn and desync any client viewing that session
   (2026-09-24 incident: a stray test client's `compact` split the live turn). Escape
   hatches (switch_session, new_session, delete_session, abort) are deliberately NOT
   here — switching away from a runaway turn must keep working. */
const BUSY_BLOCKED = new Set(["compact", "fork", "clone"]);

const ALLOWED_COMMANDS = new Set([
  // prompting
  "prompt", "steer", "follow_up", "abort", "clear_queue", "new_session",
  // state
  "get_state", "get_messages",
  // model
  "set_model", "cycle_model", "get_available_models",
  // thinking
  "set_thinking_level", "cycle_thinking_level", "get_available_thinking_levels",
  // queue modes
  "set_steering_mode", "set_follow_up_mode",
  // compaction / retry
  "compact", "set_auto_compaction", "set_auto_retry", "abort_retry",
  // bash
  "bash", "abort_bash",
  // session
  "get_session_stats", "export_html", "switch_session", "fork", "clone",
  "get_fork_messages", "get_entries", "get_tree", "get_last_assistant_text",
  "set_session_name",
  // commands
  "get_commands",
  // extension UI sub-protocol (responses go to stdin)
  "extension_ui_response",
]);

/* ------------------------------------------------------------------ */
/* Session listing (left rail)                                         */
/* ------------------------------------------------------------------ */

async function listSessions() {
  const files = [];
  try {
    const entries = await fsp.readdir(SESSIONS_DIR, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(SESSIONS_DIR, e.name);
      if (e.isDirectory()) {
        const sub = await fsp.readdir(p).catch(() => []);
        for (const f of sub) if (f.endsWith(".jsonl")) files.push(path.join(p, f));
      } else if (e.isFile() && e.name.endsWith(".jsonl")) {
        files.push(p);
      }
    }
  } catch {
    return [];
  }
  const out = [];
  await Promise.all(
    files.map(async (file) => {
      try {
        const stat = await fsp.stat(file);
        if (stat.size > 50 * 1024 * 1024) return; // skip monsters
        const text = await fsp.readFile(file, "utf8");
        const info = summarizeSession(text, file);
        if (info) {
          info.updated = stat.mtimeMs;
          out.push(info);
        }
      } catch {
        /* unreadable file: skip */
      }
    })
  );
  out.sort((a, b) => b.updated - a.updated);
  return out;
}

function summarizeSession(text, file) {
  let header = null;
  let name = null;
  let preview = null;
  let count = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "session" && !header) header = e;
    else if (e.type === "session_info" && e.name) name = e.name;
    else if (e.type === "message" && e.message?.role === "user" && !preview) {
      const c = e.message.content;
      if (typeof c === "string") preview = c;
      else if (Array.isArray(c)) preview = c.find((b) => b.type === "text")?.text;
      if (preview) {
        preview = preview.replace(/\s+/g, " ").trim();
        if (preview.length > 80) preview = preview.slice(0, 80) + "…";
      }
    }
    if (e.type === "message") count++;
    /* NO early exit (fixed 2026-10-03): `name` is only present for RENAMED sessions,
       and pi appends the renaming `session_info` event whenever the user renames —
       which can be at EOF, long after the first user message. Breaking once
       header+name+preview were set therefore stopped counting mid-file for exactly
       the renamed sessions (observed 38/180, 6/30, 2/15). listSessions() already
       reads the whole file, so a full scan is free. */
  }
  if (!header) return null;
  return {
    id: header.id,
    path: file,
    cwd: header.cwd || null,
    created: header.timestamp || null,
    name: name || null,
    preview: preview || null,
    messageCount: count,
    fileName: path.basename(file, ".jsonl"),
  };
}

let lastSessionList = [];
async function refreshSessions() {
  try {
    lastSessionList = await listSessions();
    broadcast({ kind: "sessions", sessions: lastSessionList });
  } catch (e) {
    log("session list error:", e.message);
  }
}

/* ---- cheap session-change watcher ---------------------------------------
   pi appends to the session file AFTER sending its RPC response, so refreshing
   only on that response races the write and leaves the rail stale until the next
   reply. Poll a (mtime,size) fingerprint and refresh only on real change. */
async function sessionFingerprint() {
  try {
    const entries = await fsp.readdir(SESSIONS_DIR, { withFileTypes: true });
    const parts = [];
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(".jsonl")) {
        const st = await fsp.stat(path.join(SESSIONS_DIR, e.name)).catch(() => null);
        if (st) parts.push(`${e.name}:${st.mtimeMs}:${st.size}`);
      } else if (e.isDirectory()) {
        const sub = await fsp.readdir(path.join(SESSIONS_DIR, e.name)).catch(() => []);
        for (const f of sub) {
          if (!f.endsWith(".jsonl")) continue;
          const st = await fsp.stat(path.join(SESSIONS_DIR, e.name, f)).catch(() => null);
          if (st) parts.push(`${e.name}/${f}:${st.mtimeMs}:${st.size}`);
        }
      }
    }
    return parts.sort().join("|");
  } catch {
    return "";
  }
}

let sessionWatch = null;
function startSessionWatcher() {
  if (sessionWatch) return;
  let last = null;
  sessionWatch = setInterval(async () => {
    const fp = await sessionFingerprint();
    if (last !== null && fp !== last) refreshSessions();
    last = fp;
  }, 3000);
  if (sessionWatch.unref) sessionWatch.unref();
}

/**
 * Validate a client-supplied session file path. Throws Error (with a
 * human-readable reason) unless it is a real .jsonl file inside SESSIONS_DIR.
 * Returns the resolved path. Unauthenticated tailnet service — this guard
 * matters: blocks path traversal and writes/reads outside the sessions dir.
 */
async function assertSessionFile(p) {
  if (typeof p !== "string" || !p.trim()) throw new Error("path must be a non-empty string");
  const r = path.resolve(p);
  if (!r.startsWith(SESSIONS_DIR + path.sep)) throw new Error("path must be inside the sessions directory");
  if (!r.endsWith(".jsonl")) throw new Error("path must end with .jsonl");
  try {
    await fsp.stat(r);
  } catch {
    throw new Error("session file not found");
  }
  return r;
}

function isCurrentSessionFile(p) {
  return !!(currentSessionFile && path.resolve(currentSessionFile) === path.resolve(p));
}

/* ------------------------------------------------------------------ */
/* HTTP + WebSocket                                                    */
/* ------------------------------------------------------------------ */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  // Access control first — this server fronts a process that can run shell commands.
  if (TOKEN) {
    const qTok = url.searchParams.get("token");
    if (qTok !== null && tokenMatches(qTok)) {
      // Exchange ?token=… for a cookie (so the UI's own fetches and the WS carry it)
      // and redirect to the same URL without the secret in the address bar/history.
      const clean = new URL(url.toString());
      clean.searchParams.delete("token");
      res.writeHead(302, {
        "set-cookie": AUTH_COOKIE,
        location: clean.pathname + (clean.search || ""),
      });
      res.end();
      return;
    }
    if (!isAuthorized(req, url)) {
      res.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(
        "<!doctype html><meta charset=utf-8><title>pi-web — locked</title>" +
          "<h1>401 — locked</h1><p>This pi-web instance requires a token. " +
          "Open the address you were given with <code>?token=…</code> appended once; " +
          "the browser will remember it.</p>"
      );
      return;
    }
  }
  // State-changing requests must come from this origin (see originAllowed() in net.mjs).
  if (req.method !== "GET" && req.method !== "HEAD" && !originAllowed(req.headers, ORIGIN_POLICY)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("forbidden origin");
    return;
  }
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, pi: piState }));
    return;
  }
  // ---- Web Push endpoints ----
  if (url.pathname === "/push/vapid") {
    if (req.method !== "GET") { res.writeHead(405); res.end("method not allowed"); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ publicKey: getPublicKey() }));
    return;
  }
  if (url.pathname === "/push/subscribe") {
    if (req.method !== "POST") { res.writeHead(405); res.end("method not allowed"); return; }
    (async () => {
      const buf = await readBody(req);
      if (!buf) { res.writeHead(400); res.end("empty body"); return; }
      try {
        const sub = JSON.parse(buf);
        saveSubscription(sub);
      } catch {
        res.writeHead(400); res.end("bad json"); return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    })();
    return;
  }
  if (url.pathname === "/push/unsubscribe") {
    if (req.method !== "POST") { res.writeHead(405); res.end("method not allowed"); return; }
    (async () => {
      const buf = await readBody(req);
      if (!buf) { res.writeHead(400); res.end("empty body"); return; }
      try {
        const body = JSON.parse(buf);
        if (body && typeof body.endpoint === "string") removeSubscription(body.endpoint);
      } catch {
        res.writeHead(400); res.end("bad json"); return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    })();
    return;
  }
  // static files
  let p = url.pathname === "/" ? "/index.html" : url.pathname;
  p = path.normalize(p).replace(/^(\.\.[/\\])+/, "");
  const file = path.join(PUBLIC_DIR, p);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  fsp.readFile(file).then((buf) => {
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] || "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(buf);
  }).catch(() => {
    res.writeHead(404);
    res.end("not found");
  });
});

/* noServer + an explicit upgrade handler so an unauthorized socket is refused at the
   HTTP layer (401) instead of being accepted and closed afterwards. */
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  if (!isAuthorized(req, url)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  if (!originAllowed(req.headers, ORIGIN_POLICY)) {
    // A browser page on another site cannot drive this agent. See originAllowed() in net.mjs.
    log(`refused cross-origin websocket from ${req.headers.origin}`);
    socket.write("HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws) => {
  clients.add(ws);
  log(`client connected (${clients.size} total)`);
  if (!proc) spawnPi(); // lazy (re)start
  ws.send(
    JSON.stringify({
      kind: "hello",
      state: piState,
      cwd: CWD,
      sessionsDir: SESSIONS_DIR,
      port: PORT,
    })
  );
  if (lastSessionList.length) ws.send(JSON.stringify({ kind: "sessions", sessions: lastSessionList }));

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const reply = (o) => ws.send(JSON.stringify(o));
    try {
      if (msg.kind === "rpc") {
        const cmd = msg.data;
        if (!cmd || typeof cmd !== "object" || !ALLOWED_COMMANDS.has(cmd.type)) {
          reply({ kind: "error", error: `command not allowed: ${cmd?.type}` });
          return;
        }
        if (piState !== "running") {
          reply({ kind: "error", error: `pi is not running (state=${piState})` });
          return;
        }
        if (BUSY_BLOCKED.has(cmd.type) && piBusy) {
          reply({ kind: "error", error: `pi is mid-turn; ${cmd.type} is blocked until the turn settles` });
          return;
        }
        piSend(cmd);
      } else if (msg.kind === "get_sessions") {
        refreshSessions();
      } else if (msg.kind === "restart_pi") {
        // Stop the old child and clear `proc` BEFORE spawning, so spawnPi()'s
        // `if (proc) return` guard cannot silently swallow the respawn. The old
        // child's exit event is ignored by the stale-exit guard in spawnPi().
        // (Bug fixed 2026-09-28: kill-then-spawn raced the async exit event, so the
        // first restart_pi left the server with state "exited" and no pi at all.)
        if (proc) {
          proc.kill("SIGTERM");
          proc = null;
        }
        piState = "starting";
        spawnPi();
      } else if (msg.kind === "rename_session") {
        let p;
        try {
          p = await assertSessionFile(msg.path);
        } catch (e) {
          reply({ kind: "error", error: e.message });
          return;
        }
        const name = typeof msg.name === "string" ? msg.name.trim() : "";
        if (!name) {
          reply({ kind: "error", error: "name must be a non-empty string" });
          return;
        }
        // Append the bare session_info event — verified accepted by pi; it
        // reports the name as sessionName on next load.
        await fsp.appendFile(p, JSON.stringify({ type: "session_info", name }) + "\n");
        // If this is the session pi currently has open, sync pi's in-memory
        // name (set_session_name only targets the current session).
        if (isCurrentSessionFile(p) && piState === "running") {
          piSend({ type: "set_session_name", name });
        }
        refreshSessions();
        reply({ kind: "session_action", action: "rename", ok: true });
      } else if (msg.kind === "delete_session") {
        let p;
        try {
          p = await assertSessionFile(msg.path);
        } catch (e) {
          reply({ kind: "error", error: e.message });
          return;
        }
        const wasCurrent = isCurrentSessionFile(p);
        // Move pi off the file before unlinking it, so it doesn't keep
        // writing to a deleted path.
        if (wasCurrent && piState === "running") piSend({ type: "new_session" });
        await fsp.unlink(p);
        if (wasCurrent) currentSessionFile = null;
        refreshSessions();
        reply({ kind: "session_action", action: "delete", ok: true });
      }
    } catch (e) {
      reply({ kind: "error", error: e.message });
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    log(`client disconnected (${clients.size} total)`);
  });
  ws.on("error", (e) => log("ws error:", e.message));
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`port ${PORT} on ${HOST} is already in use`);
    process.exit(1);
  }
  throw e;
});

// Initialise Web Push (idempotent — loads or generates the VAPID key file in DATA_DIR)
initPush(DATA_DIR);
log(`push initialised (data dir: ${DATA_DIR})`);

server.listen(PORT, HOST, () => {
  log(`pi-web listening on http://${HOST}:${PORT} (cwd=${CWD}, bind=${HOST_KIND})`);
  if (HOST_KIND === "all") {
    const ips = listIpv4().map((a) => `http://${a.address}:${PORT}`);
    log(`answering on every interface${ips.length ? ": " + ips.join("  ") : ""}`);
  } else {
    // One listen == one address. Saying "also reachable at …" here would be a lie: the socket is
    // bound to HOST only. List the addresses we are NOT serving so that is unambiguous.
    const others = listIpv4()
      .map((a) => a.address)
      .filter((ip) => ip !== HOST);
    if (others.length) {
      log(`not bound: ${others.join(", ")} (one address per listen — PI_WEB_HOST=all serves them all)`);
    }
  }
  if (TOKEN) log("access control: PI_WEB_TOKEN is set — open the URL once with ?token=…");
  else log("access control: NONE (network-level only — do not expose this to the internet)");
  spawnPi();
  startSessionWatcher();
});

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
function shutdown() {
  log("shutting down");
  try {
    proc?.kill("SIGTERM");
  } catch {}
  for (const ws of clients) ws.close(1001, "server shutting down");
  setTimeout(() => process.exit(0), 500).unref();
}
