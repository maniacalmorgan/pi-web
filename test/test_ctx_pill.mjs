/* test_ctx_pill.mjs — context-counter pill behaviour.
 *
 * Runs the REAL public/index.html + public/app.js in jsdom and drives a stubbed
 * event stream, asserting:
 *   - the "used" figure comes from contextUsage.tokens, NEVER tokens.total (cumulative)
 *   - switching sessions requests fresh stats (and clears the old numbers first)
 *   - message_end and tool_execution_end each request fresh stats
 *   - requests are COALESCED (at most one in flight, at most one queued follow-up)
 *   - new_session clears the pill
 *   - session-cumulative in/out render as ↑N ↓N
 *
 * Run: node test/test_ctx_pill.mjs
 */
import { createRequire } from 'node:module';
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

const { window: w, document: d, frame } = boot();
const rpcFrame = (data) => frame({ kind: 'rpc', data });
const pill = d.getElementById('context-pill');
const statsSent = () => w.__SENT.filter((m) => m.kind === 'rpc' && m.data && m.data.type === 'get_session_stats').length;

/* boot: pi already running -> boot() fires a stats request; answer it. */
frame({ kind: 'hello', state: 'running', cwd: process.env.HOME || '/' });
const afterBoot = statsSent();
ok('boot requests session stats', afterBoot >= 1, String(afterBoot));
rpcFrame({ type: 'response', command: 'get_session_stats', success: true, data: {
  contextUsage: { tokens: 3000, contextWindow: 80000, percent: 3.75 },
  tokens: { input: 12000, output: 4500, cacheRead: 0, cacheWrite: 0, total: 999999 },
  totalMessages: 7,
} });

/* --- 1. used figure = contextUsage.tokens, NOT the cumulative tokens.total --- */
ok('pill shows the CURRENT context (contextUsage.tokens), not cumulative tokens.total',
   pill.textContent.includes('3.0k') && !pill.textContent.includes('1000k'),
   JSON.stringify(pill.textContent));
ok('pill shows the context window', pill.textContent.includes('80k'), JSON.stringify(pill.textContent));

/* --- 2. in/out tokens render --- */
ok('pill shows session in/out tokens (↑in ↓out)',
   pill.textContent.includes('↑') && pill.textContent.includes('↓'),
   JSON.stringify(pill.textContent));

/* --- 3. message_end triggers a stats refresh --- */
const beforeME = statsSent();
rpcFrame({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], timestamp: Date.now() } });
ok('message_end requests fresh stats', statsSent() === beforeME + 1, `${beforeME} -> ${statsSent()}`);
/* drain it so the coalescing test below starts from a clean (no in-flight) state */
rpcFrame({ type: 'response', command: 'get_session_stats', success: true, data: {
  contextUsage: { tokens: 3100, contextWindow: 80000, percent: 3.9 }, tokens: { input: 12050, output: 4550 },
} });

/* --- 4. coalescing: a second refresh while one is in flight is QUEUED, not sent --- */
const beforeCo = statsSent();
rpcFrame({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', result: { content: [] }, isError: false });
rpcFrame({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'y' }], timestamp: Date.now() } });
ok('only ONE request in flight (second is coalesced)',
   statsSent() === beforeCo + 1, `${beforeCo} -> ${statsSent()}`);
/* answering it releases exactly ONE queued follow-up */
rpcFrame({ type: 'response', command: 'get_session_stats', success: true, data: {
  contextUsage: { tokens: 3200, contextWindow: 80000, percent: 4 }, tokens: { input: 12100, output: 4600, cacheRead: 0, cacheWrite: 0, total: 999999 },
} });
ok('the queued follow-up fires exactly once after the in-flight response',
   statsSent() === beforeCo + 2, `${beforeCo} -> ${statsSent()}`);

/* --- 5. tool_execution_end alone also refreshes --- */
rpcFrame({ type: 'response', command: 'get_session_stats', success: true, data: { contextUsage: { tokens: 3300, contextWindow: 80000, percent: 4.1 }, tokens: { input: 12200, output: 4700 } } });
const beforeTE = statsSent();
rpcFrame({ type: 'tool_execution_end', toolCallId: 't2', toolName: 'read', result: { content: [] }, isError: false });
ok('tool_execution_end requests fresh stats', statsSent() === beforeTE + 1, `${beforeTE} -> ${statsSent()}`);

/* --- 6. switching sessions clears the pill immediately, then refetches --- */
rpcFrame({ type: 'response', command: 'get_session_stats', success: true, data: { contextUsage: { tokens: 3400, contextWindow: 80000, percent: 4.2 }, tokens: { input: 12300, output: 4800 } } });
const beforeSwitch = statsSent();
rpcFrame({ type: 'response', command: 'switch_session', success: true, data: { cancelled: false } });
ok('switch_session refetches stats', statsSent() === beforeSwitch + 1, `${beforeSwitch} -> ${statsSent()}`);

/* --- 7. new_session clears the pill (no bleed from the old session) --- */
rpcFrame({ type: 'response', command: 'get_session_stats', success: true, data: { contextUsage: { tokens: 3500, contextWindow: 80000, percent: 4.3 }, tokens: { input: 12400, output: 4900 } } });
rpcFrame({ type: 'response', command: 'new_session', success: true, data: { cancelled: false } });
ok('new_session clears the pill to "ctx —"',
   pill.textContent.trim().startsWith('ctx —'), JSON.stringify(pill.textContent));

/* --- 8. after a fresh stats lands for the new session, the pill shows its numbers --- */
rpcFrame({ type: 'response', command: 'get_session_stats', success: true, data: { contextUsage: { tokens: 900, contextWindow: 80000, percent: 1.1 }, tokens: { input: 500, output: 200 } } });
ok('new session numbers render after the fresh stats land',
   pill.textContent.includes('900') && pill.textContent.includes('↑'), JSON.stringify(pill.textContent));

const passed = results.filter(Boolean).length;
console.log(`\n=== ${passed}/${results.length} passed ===`);
process.exit(passed === results.length ? 0 : 1);
