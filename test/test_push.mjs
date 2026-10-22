const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
// Independent verification of the pi-web server-side push work (an independent test,
// deliberately NOT Pi's). Run: node verify_push.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = `${ROOT}`;
const DATA = path.join(dir, "data");
const m = await import(path.join(dir, "push.mjs"));

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("PASS", name, extra); }
  else { fail++; console.log("FAIL", name, extra); }
};

// 1. VAPID idempotency + file mode
const k1 = m.initPush(DATA);
const k2 = m.initPush(DATA);
ok("initPush idempotent (same key twice)", k1 === k2, `len=${k1.length}`);
ok("vapid publicKey is 87 chars (b64url P-256)", k1.length === 87);
const vmode = (fs.statSync(path.join(DATA, "vapid.json")).mode & 0o777).toString(8);
ok("vapid.json mode 600", vmode === "600", vmode);

// 2. subscription upsert/remove
const subA = { endpoint: "https://example.test/a", keys: { p256dh: "x", auth: "y" } };
const subB = { endpoint: "https://example.test/b", keys: { p256dh: "x", auth: "y" } };
m.saveSubscription(subA);
m.saveSubscription(subB);
m.saveSubscription({ ...subA, keys: { p256dh: "z", auth: "w" } }); // update
let subs = JSON.parse(fs.readFileSync(path.join(DATA, "push-subs.json"), "utf8"));
ok("saveSubscription upserts by endpoint (2, not 3)", subs.length === 2, `len=${subs.length}`);
ok("upsert replaced the record", subs.find(s => s.endpoint.endsWith("/a")).keys.p256dh === "z");
m.removeSubscription("https://example.test/a");
subs = JSON.parse(fs.readFileSync(path.join(DATA, "push-subs.json"), "utf8"));
ok("removeSubscription removes one", subs.length === 1 && subs[0].endpoint.endsWith("/b"));
const smode = (fs.statSync(path.join(DATA, "push-subs.json")).mode & 0o777).toString(8);
ok("push-subs.json mode 600", smode === "600", smode);

// 3. trigger filter
ok("agent_settled -> payload", m.notifyPayloadForEvent({ type: "agent_settled" })?.body === "Reply ready");
for (const meth of ["select", "confirm", "input", "editor"]) {
  ok(`extension_ui_request ${meth} -> payload`, m.notifyPayloadForEvent({ type: "extension_ui_request", method: meth, message: "q" }) !== null);
}
for (const meth of ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]) {
  ok(`extension_ui_request ${meth} -> null`, m.notifyPayloadForEvent({ type: "extension_ui_request", method: meth }) === null);
}
ok("unrelated event -> null", m.notifyPayloadForEvent({ type: "text_delta" }) === null);

// 4. THE HOOK INTEGRATION — how server.mjs actually calls it
const p = m.notifyPayloadForEvent({ type: "agent_settled" });
const ret = m.sendToAll(p);
ok("sendToAll returns a thenable (so .catch() is valid)", ret && typeof ret.catch === "function",
   `actually returned: ${ret === undefined ? "undefined" : typeof ret}`);
let hookThrew = false;
try { m.sendToAll(p).catch(() => {}); } catch (e) { hookThrew = true; console.log("  -> hook threw:", e.constructor.name, e.message); }
ok("server hook `sendToAll(p).catch(...)` does NOT throw", !hookThrew);

// cleanup — leave no generated key material behind in a checkout
m.removeSubscription("https://example.test/b");
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
