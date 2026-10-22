/* test_ctx_window_sync.mjs — the ctx pill must show the ACTIVE model's context window.
 *
 * Regression guard for the 2026-09-28 report: the pill showed 262k while the model was
 * running 120k. Two causes, both covered here:
 *   1. renderContextPill() preferred stats.contextUsage.contextWindow, which lags a model
 *      switch — it must prefer S.contextWindow (from get_state.model).
 *   2. set_model did not update the window or refresh stats at all.
 *
 * Run: node test/test_ctx_window_sync.mjs
 */
import { existsSync } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(path.resolve(HERE, '..'), 'public');
const jsdomPath = [
  process.env.JSDOM_PATH,
  new URL('../node_modules/jsdom/lib/api.js', import.meta.url).pathname,
].filter(Boolean).find((p) => existsSync(p));
if (!jsdomPath) { console.log('jsdom not found:  npm i -D jsdom'); process.exit(2); }
const { JSDOM } = await import(jsdomPath);

const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const appjs = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');

const dom = new JSDOM(html, { url: 'http://127.0.0.1:4321/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window: w } = dom;
w.marked = { parse: (s) => `<p>${s}</p>` };
w.DOMPurify = { sanitize: (h) => h };
w.CSS = w.CSS || {};
w.localStorage.clear();
w.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
class FakeWS {
  constructor() { this.readyState = 1; FakeWS.inst = this; setTimeout(() => this.onopen && this.onopen(), 0); }
  send(s) { try { w.__SENT.push(JSON.parse(s)); } catch {} }
  close() {}
}
FakeWS.OPEN = 1; w.__SENT = []; w.WebSocket = FakeWS;
w.eval(appjs);
if (!FakeWS.inst) w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
const d = w.document;
const frame = (o) => FakeWS.inst.onmessage({ data: JSON.stringify(o) });
const rpcFrame = (data) => frame({ kind: 'rpc', data });

const results = [];
const ok = (n, p, x) => { results.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${x ? '  -- ' + x : ''}`); };
const pill = () => d.getElementById('context-pill').textContent;
const statsSent = () => w.__SENT.filter((m) => m.data && m.data.type === 'get_session_stats').length;

const LOADED_MODEL = { provider: 'local-lmstudio', id: 'local/qwen3-27b', name: 'local/qwen3-27b (loaded)', contextWindow: 120064 };
const QWEN    = { provider: 'local-lmstudio', id: 'qwen3-27b-q6',        name: 'qwen3-27b-q6 (not loaded)', contextWindow: 262144 };

frame({ kind: 'hello', state: 'running', cwd: process.env.HOME || '/' });
rpcFrame({ type: 'response', command: 'get_available_models', success: true, data: { models: [LOADED_MODEL, QWEN] } });

/* --- 1. stale-stats scenario: model says 120064, stats still say 262144 --- */
rpcFrame({ type: 'response', command: 'get_state', success: true, data: { model: LOADED_MODEL } });
rpcFrame({ type: 'response', command: 'get_session_stats', success: true, data: {
  contextUsage: { tokens: 60000, contextWindow: 262144, percent: 22.9 }, tokens: { input: 1, output: 1 } } });
ok('pill shows the ACTIVE model window (120k), not the lagging stats window (262k)',
   pill().includes('120k') && !pill().includes('262k'), JSON.stringify(pill()));

/* --- 2. switching models updates the pill immediately from the set_model response.
   pi's REAL response carries the Model object AS `data` — no `model` key (verified live
   2026-10-08). The fixture used to nest it, which let a real-world bug hide: reading only
   `data.model` threw the answer away and the pill kept the old window. --- */
rpcFrame({ type: 'response', command: 'set_model', success: true, data: { ...QWEN, name: 'qwen3-27b-q6' } });
ok('set_model immediately re-renders the pill with the new window',
   pill().includes('262k'), JSON.stringify(pill()));

/* --- 3. set_model also asks for fresh stats (so %/tokens reconcile) ---
   refreshStats coalesces, so drain any in-flight request first or we measure the guard. */
rpcFrame({ type: 'response', command: 'get_session_stats', success: true, data: {
  contextUsage: { tokens: 60000, contextWindow: 262144, percent: 22.9 }, tokens: { input: 1, output: 1 } } });
const before = statsSent();
rpcFrame({ type: 'response', command: 'set_model', success: true, data: LOADED_MODEL });
ok('set_model refreshes session stats', statsSent() === before + 1, `${before} -> ${statsSent()}`);
ok('pill reflects the switched-back model', pill().includes('120k'), JSON.stringify(pill()));

/* --- 3b. the percentage must describe the window actually shown (60000/120064 = 50%) --- */
ok('percent is derived from the shown window, not a stale stored percent',
   pill().includes('50.0%') && !pill().includes('22.9%'), JSON.stringify(pill()));

/* --- 4. with no stats at all, the model window still stands alone --- */
rpcFrame({ type: 'response', command: 'switch_session', success: true, data: { cancelled: false } });
rpcFrame({ type: 'response', command: 'get_state', success: true, data: { model: LOADED_MODEL } });
ok('after a session switch with no stats yet, the pill is clear (not a stale number)',
   /ctx —/.test(pill()), JSON.stringify(pill()));

/* --- 5. falling back: if the model window is unknown, stats still supply one --- */
rpcFrame({ type: 'response', command: 'get_state', success: true, data: { model: { provider: 'p', id: 'm' } } });
rpcFrame({ type: 'response', command: 'get_session_stats', success: true, data: {
  contextUsage: { tokens: 1000, contextWindow: 32000, percent: 3.1 }, tokens: { input: 5, output: 5 } } });
ok('with no model window, the pill falls back to the stats window',
   pill().includes('32k'), JSON.stringify(pill()));

const passed = results.filter(Boolean).length;
console.log(`\n=== ${passed}/${results.length} passed ===`);
process.exit(passed === results.length ? 0 : 1);
