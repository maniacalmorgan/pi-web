/* test_thinking.mjs — thinking-block features (timer, plain header, expanded-while-streaming,
 * auto-collapse when settled, click-to-reopen, and the keep-open toggle).
 * The flavour phrases now live in the lull π indicator — the header is the plain "✳ thinking…".
 *
 * Runs the REAL public/index.html + public/app.js in jsdom and drives a REAL partial event
 * stream, asserting mid-stream (while thinking is still arriving) and after message_end.
 *
 * Run: node test/test_thinking.mjs
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { THINK_LABELS } from './pool.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PUB = path.join(ROOT, 'public');

const require0 = createRequire(import.meta.url);
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

function boot({ preStorage = {} } = {}) {
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:4321/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.marked = { parse: (s) => `<p>${String(s)}</p>` };
  window.DOMPurify = { sanitize: (h) => h };
  window.CSS = window.CSS || {};
  if (!window.CSS.escape) window.CSS.escape = (s) => String(s).replace(/["\\]/g, '\\$&');
  window.localStorage.clear();
  for (const [k, v] of Object.entries(preStorage)) window.localStorage.setItem(k, v);
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
const chat = d.getElementById('chat');
const q = (sel) => chat.querySelectorAll(sel);
const rpcFrame = (data) => frame({ kind: 'rpc', data });

/* ---- drive a partial stream: thinking arriving, bubble not closed yet ---- */
frame({ kind: 'hello', state: 'running', cwd: process.env.HOME || '/' });
frame({ kind: 'pi_status', state: 'running' });
rpcFrame({ type: 'agent_start' });
rpcFrame({ type: 'turn_start' });
rpcFrame({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: Date.now() } });
rpcFrame({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start' } });
rpcFrame({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'churning on it' } });

const th = q('.thinking')[0];
ok('thinking block created while streaming', !!th);
ok('thinking block is EXPANDED while streaming (not collapsed)',
   !!th && !th.classList.contains('collapsed'), th ? th.className : 'none');
ok('thinking block sits OUTSIDE the assistant bubble', q('.msg.assistant .thinking').length === 0);

const timeEl = th && th.querySelector('.thinking-time');
ok('thinking shows a live TIMER (mm:ss), not a clock timestamp',
   !!timeEl && /^\d+:\d{2}$/.test(timeEl.textContent.trim()),
   timeEl ? JSON.stringify(timeEl.textContent) : 'missing');
ok('timer span still carries the full timestamp in its title',
   !!timeEl && /^\w{3} \d{2}, \d{4} \d{2}:\d{2}$/.test(timeEl.title || ''), JSON.stringify(timeEl && timeEl.title));

const labelEl = th && th.querySelector('.thinking-head span');
const labelText = labelEl ? labelEl.textContent : '';
ok('thinking header is the plain "✳ thinking…" label (flavour phrases moved to the lull π)',
   labelText === '✳ thinking…' && !THINK_LABELS.includes(labelText.slice(2)),
   JSON.stringify(labelText));

const bodyEl = th.querySelector('.thinking-body');
Object.defineProperty(bodyEl, 'scrollHeight', { value: 1234, configurable: true });
bodyEl.scrollTop = 0;
rpcFrame({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: ' more' } });
ok('expanded thinking body auto-scrolls to the bottom while streaming',
   bodyEl.scrollTop === 1234, String(bodyEl.scrollTop));

/* collapsed block must NOT be auto-scrolled */
bodyEl.scrollTop = 0;
th.classList.add('collapsed');
rpcFrame({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: ' hidden' } });
ok('collapsed thinking body is not auto-scrolled', bodyEl.scrollTop === 0, String(bodyEl.scrollTop));

/* re-expanding a still-streaming block jumps to the bottom */
bodyEl.scrollTop = 0;
th.querySelector('.thinking-head').dispatchEvent(new w.MouseEvent('click', { bubbles: true })); // -> expanded
ok('re-expanding a streaming block scrolls its body to the bottom',
   bodyEl.scrollTop === 1234, String(bodyEl.scrollTop));

/* ---- settle the message: thinking should auto-collapse ---- */
rpcFrame({ type: 'message_end', message: { role: 'assistant', content: [
  { type: 'thinking', thinking: 'churning on it' }, { type: 'text', text: 'done.' } ], timestamp: Date.now() } });

const th2 = q('.thinking')[0];
ok('thinking AUTO-COLLAPSES once the step finishes',
   !!th2 && th2.classList.contains('collapsed'), th2 ? th2.className : 'none');
ok('timer is still shown after settling (frozen duration)',
   !!th2 && /^\d+:\d{2}$/.test((th2.querySelector('.thinking-time') || {}).textContent?.trim() || ''),
   th2 ? JSON.stringify(th2.querySelector('.thinking-time').textContent) : '');

/* ---- click to re-expand (same as before) ---- */
th2.querySelector('.thinking-head').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
ok('clicking the head RE-EXPANDS a collapsed thinking block', !th2.classList.contains('collapsed'));
th2.querySelector('.thinking-head').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
ok('clicking again collapses it', th2.classList.contains('collapsed'));

/* ---- the keep-open toggle ---- */
const btn = d.getElementById('think-btn');
ok('keep-open toggle button exists in the composer bar', !!btn);
ok('toggle is off by default', !btn.classList.contains('on'));
btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
ok('clicking the toggle turns it on (class "on")', btn.classList.contains('on'));
ok('toggle persists to localStorage', w.localStorage.getItem('piweb.keepThinkingOpen') === '1',
   String(w.localStorage.getItem('piweb.keepThinkingOpen')));

/* with the toggle ON, a new step must NOT auto-collapse */
rpcFrame({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: Date.now() } });
rpcFrame({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start' } });
rpcFrame({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'second pass' } });
rpcFrame({ type: 'message_end', message: { role: 'assistant', content: [ { type: 'thinking', thinking: 'second pass' } ], timestamp: Date.now() } });
const last = [...q('.thinking')].pop();
ok('with keep-open ON, a finished step stays expanded',
   !!last && !last.classList.contains('collapsed'), last ? last.className : 'none');

/* two thinking blocks -> both carry the plain header (no flavour labels here anymore) */
const labels = [...q('.thinking')].map((b) => (b.querySelector('.thinking-head span') || {}).textContent);
ok('every thinking block uses the plain "✳ thinking…" header (none from the old pool)',
   labels.length >= 2 && labels.every((l) => l === '✳ thinking…' && !THINK_LABELS.includes((l || '').slice(2))),
   JSON.stringify(labels));

/* the saved toggle is honoured on a fresh boot */
{
  const b2 = boot({ preStorage: { 'piweb.keepThinkingOpen': '1' } });
  ok('startup restores keep-open ON from localStorage',
     b2.document.getElementById('think-btn').classList.contains('on'));
  const rpc2 = (data) => b2.frame({ kind: 'rpc', data });
  rpc2({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: Date.now() } });
  rpc2({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start' } });
  rpc2({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'x' } });
  rpc2({ type: 'message_end', message: { role: 'assistant', content: [ { type: 'thinking', thinking: 'x' } ], timestamp: Date.now() } });
  const t2 = b2.document.querySelectorAll('.thinking')[0];
  ok('restored ON state actually prevents auto-collapse',
     !!t2 && !t2.classList.contains('collapsed'));
}

const passed = results.filter(Boolean).length;
console.log(`\n=== ${passed}/${results.length} passed ===`);
process.exit(passed === results.length ? 0 : 1);
