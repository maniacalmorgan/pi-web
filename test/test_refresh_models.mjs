/* test_refresh_models.mjs — the "refresh model list" flow.
 *
 * Why this exists: in `pi --mode rpc` pi's model catalogue is a FROZEN in-memory
 * snapshot — there is no refresh RPC (verified: `refreshModelCatalogs` ships only in the
 * TUI/interactive bundle, and rpc-entry.js references it zero times). So a model loaded in
 * LM Studio after pi started is invisible until the pi child is respawned. The refresh
 * button does exactly that — surgically — and must then put the user back where they were:
 * re-open the same session (the respawn drops pi onto a new empty one) and re-point the
 * active model at the loaded one (loading a session file re-stamps the model that session
 * was created with, which may not be the loaded one).
 *
 * This suite covers that client state machine. It does NOT restart a live pi.
 *
 * Run: node test/test_refresh_models.mjs
 */
import { existsSync } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PUB = path.join(ROOT, 'public');

const JSDOM_CANDIDATES = [
  process.env.JSDOM_PATH,
  new URL('../node_modules/jsdom/lib/api.js', import.meta.url).pathname,
].filter(Boolean);
const jsdomPath = JSDOM_CANDIDATES.find((p) => existsSync(p));
if (!jsdomPath) {
  console.log('jsdom not found. Install it with:  npm i -D jsdom');
  process.exit(2);
}
const { JSDOM } = await import(jsdomPath);

const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const appjs = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');

function boot() {
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:4321/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.marked = { parse: (s) => `<p>${String(s)}</p>` };
  window.DOMPurify = { sanitize: (h) => h };
  window.CSS = window.CSS || {};
  if (!window.CSS.escape) window.CSS.escape = (s) => String(s).replace(/["\\]/g, '\\$&');
  window.localStorage.clear();
  window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  class FakeWS {
    constructor() { this.readyState = 1; FakeWS.inst = this; setTimeout(() => this.onopen && this.onopen(), 0); }
    send(s) { try { window.__SENT.push(JSON.parse(s)); } catch {} }
    close() {}
  }
  FakeWS.OPEN = 1;
  window.__SENT = [];
  window.WebSocket = FakeWS;
  window.eval(appjs);
  if (!FakeWS.inst) window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  const frame = (o) => FakeWS.inst.onmessage({ data: JSON.stringify(o) });
  return { window, document: window.document, frame };
}

const results = [];
const ok = (n, p, d) => { results.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`); };

const SESSION = `${process.env.HOME || '/'}/.pi/agent/sessions/--home-user--/2026-01-02T03-04-05-678Z_0f4b1c2e-9a7d-4b3e-8c15-6d2a7e90b4c1.jsonl`;
const CATALOG = [
  { provider: 'local-lmstudio', id: 'local/qwen3-27b', name: 'local/qwen3-27b (loaded)', contextWindow: 262144 },
  { provider: 'local-lmstudio', id: 'qwen3-27b-q6', name: 'qwen3-27b-q6 (not loaded)', contextWindow: 262144 },
];

const { window: w, document: d, frame } = boot();
const rpcFrame = (data) => frame({ kind: 'rpc', data });
const sent = (fn) => w.__SENT.filter(fn);

/* --- boot on a live pi, with an active session on the loaded model --- */
frame({ kind: 'hello', state: 'running', cwd: process.env.HOME || '/' });
rpcFrame({ type: 'response', command: 'get_state', success: true, data: {
  model: CATALOG[0], sessionId: '0f4b1c2e', sessionFile: SESSION, isStreaming: false, messageCount: 41,
} });
rpcFrame({ type: 'response', command: 'get_available_models', success: true, data: { models: CATALOG } });

/* --- 1. the refresh affordances exist and are wired --- */
const barBtn = d.getElementById('refresh-models');
ok('composer bar has a refresh button', !!barBtn);
const listRow = d.querySelector('#model-list .model-item.model-refresh');
ok('model list has a refresh row', !!listRow);

/* --- 2. clicking refresh asks the server to respawn pi --- */
const restartCount = () => sent((m) => m.kind === 'restart_pi').length;
const before = restartCount();
listRow.dispatchEvent(new w.Event('click', { bubbles: true }));
ok('refresh sends restart_pi to the server', restartCount() === before + 1, `${before} -> ${restartCount()}`);
ok('the picker closes during a refresh', d.getElementById('model-pop').classList.contains('hidden'));

/* --- 3. the restart's own hello/pi_status must NOT re-run boot() (that would
       clobber the pending restore and spam the transcript) --- */
const stateCalls = () => sent((m) => m.kind === 'rpc' && m.data && m.data.type === 'get_state').length;
const stateBefore = stateCalls();
frame({ kind: 'hello', state: 'starting', cwd: process.env.HOME || '/' });
frame({ kind: 'pi_status', state: 'running' });
ok('boot() is suppressed during the restart window (no extra get_state)',
   stateCalls() === stateBefore, `${stateBefore} -> ${stateCalls()}`);

/* --- 4. the fresh catalogue lands -> session re-opened + model re-pointed --- */
const switchCalls = () => sent((m) => m.kind === 'rpc' && m.data && m.data.type === 'switch_session');
const setModelCalls = () => sent((m) => m.kind === 'rpc' && m.data && m.data.type === 'set_model');
const swBefore = switchCalls().length, smBefore = setModelCalls().length;
rpcFrame({ type: 'response', command: 'get_available_models', success: true, data: { models: CATALOG } });

const sw = switchCalls().slice(swBefore);
ok('the same session is re-opened after the restart', sw.length === 1, String(sw.length));
ok('switch_session targets the session we were on', sw[0] && sw[0].data.sessionPath === SESSION,
   sw[0] ? sw[0].data.sessionPath : 'none');

const sm = setModelCalls().slice(smBefore);
ok('the model is re-pointed after the session re-open', sm.length === 1, String(sm.length));
ok('set_model carries provider + the loaded model id (session load re-stamps the old model)',
   sm[0] && sm[0].data.provider === 'local-lmstudio' && sm[0].data.modelId === 'local/qwen3-27b',
   sm[0] ? JSON.stringify(sm[0].data) : 'none');

/* --- 5. the flow completes: button un-busied, state re-read --- */
ok('refresh button is no longer busy', !barBtn.classList.contains('busy'));
ok('state is re-read so the button + ctx pill reflect the refreshed model',
   stateCalls() > stateBefore, `${stateBefore} -> ${stateCalls()}`);

/* --- 6. a refresh while streaming is refused (it would kill the turn) --- */
const beforeStreaming = restartCount();
rpcFrame({ type: 'response', command: 'get_state', success: true, data: {
  model: CATALOG[0], sessionId: '0f4b1c2e', sessionFile: SESSION, isStreaming: true, messageCount: 41,
} });
barBtn.dispatchEvent(new w.Event('click', { bubbles: true }));
ok('refresh is refused mid-turn (no restart_pi sent)', restartCount() === beforeStreaming,
   `${beforeStreaming} -> ${restartCount()}`);

const passed = results.filter(Boolean).length;
console.log(`\n=== ${passed}/${results.length} passed ===`);
process.exit(passed === results.length ? 0 : 1);
