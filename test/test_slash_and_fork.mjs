/* test_slash_and_fork.mjs — typed native commands + the fork popover.
 *
 * Three behaviours fixed 2026-09-28:
 *  1. A typed native command (/new, /compact, /model x, …) must reach pi as its RPC
 *     equivalent, NOT be sent to the LLM as the literal text. (pi's built-ins are
 *     TUI-only; docs say they "would not execute if sent via `prompt`".)
 *  2. Extension / skill / template commands and ordinary prose must still go through
 *     `prompt` unchanged — only KNOWN natives are intercepted.
 *  3. /fork must actually populate the popover from get_fork_messages, and clicking an
 *     entry must send `fork` with that entryId (it used to be a stub with a dev toast).
 *
 * Run: node test/test_slash_and_fork.mjs
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
  return { window, d: window.document, frame };
}

const results = [];
const ok = (n, p, d) => { results.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`); };

const { window: w, d, frame } = boot();
const rpcFrame = (data) => frame({ kind: 'rpc', data });
const sent = () => w.__SENT.map((m) => m.data && m.data.type).filter(Boolean);
const input = d.getElementById('composer-input');
const toastsEl = d.getElementById('toasts');
const toasts = () => toastsEl.textContent.trim();

frame({ kind: 'hello', state: 'running', cwd: process.env.HOME || '/' });
rpcFrame({ type: 'response', command: 'get_available_models', success: true, data: { models: [
  { provider: 'local-lmstudio', id: 'local/qwen3-27b', name: 'local/qwen3-27b (loaded)', contextWindow: 120064 },
] } });
rpcFrame({ type: 'response', command: 'get_commands', success: true, data: { commands: [
  { name: 'release-notes', description: 'Draft release notes', source: 'skill' },
] } });

function type(text) {
  input.value = text;
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
}

/* --- 1. typed natives reach pi as RPC, never as prompt text --- */
const NATIVE_CASES = [
  ['/new',                          'new_session'],
  ['/clone',                        'clone'],
  ['/copy',                         'get_last_assistant_text'],
  ['/export',                       'export_html'],
];
for (const [text, want] of NATIVE_CASES) {
  w.__SENT.length = 0;
  type(text);
  const t = sent();
  ok(`typed "${text}" -> ${want} (not sent to the model)`,
     t.includes(want) && !t.includes('prompt'), JSON.stringify(t));
}

/* /session uses refreshStats, which COALESCES (one in flight, one queued). Drain the
   in-flight stats first, or the assertion measures the coalescing guard, not the command. */
rpcFrame({ type: 'response', command: 'get_session_stats', success: true, data: {
  contextUsage: { tokens: 10, contextWindow: 80000, percent: 0.01 }, tokens: { input: 1, output: 1 } } });
w.__SENT.length = 0;
type('/session');
ok('typed "/session" -> get_session_stats (not sent to the model)',
   sent().includes('get_session_stats') && !sent().includes('prompt'), JSON.stringify(sent()));

/* --- 2. /model <id> routes through set_model with provider; /thinking <lvl> too --- */
w.__SENT.length = 0;
type('/model local/qwen3-27b');
const modelCall = w.__SENT.find((m) => m.data && m.data.type === 'set_model');
ok('typed "/model <id>" sends set_model with provider (not prompt)',
   !!modelCall && modelCall.data.provider === 'local-lmstudio' && !sent().includes('prompt'),
   JSON.stringify(sent()));

/* --- 3. /model with NO arg opens the picker rather than prompting --- */
w.__SENT.length = 0;
d.getElementById('model-pop').classList.add('hidden');
type('/model');
ok('typed "/model" opens the picker', !d.getElementById('model-pop').classList.contains('hidden'));
ok('typed "/model" sends no prompt', !sent().includes('prompt'), JSON.stringify(sent()));

/* --- 4. a typed NATIVE with no arg path still never reaches the model --- */
w.__SENT.length = 0;
type('/thinking');
ok('typed "/thinking" sends no prompt', !sent().includes('prompt'), JSON.stringify(sent()));

/* --- 5. TUI-only native WITH an invented arg -> honest toast, no prompt --- */
w.__SENT.length = 0;
toastsEl.innerHTML = '';
type('/settings foo');
ok('typed "/settings foo" sends no prompt', !sent().includes('prompt'), JSON.stringify(sent()));
ok('typed "/settings foo" explains it is TUI-only', /TUI-only/.test(toasts()), JSON.stringify(toasts()));

/* --- 6. extension/skill commands STILL expand via prompt (must not be intercepted).
   NB: the inline ▾ autocomplete claims the FIRST Enter to complete the command name
   (existing Round-4 behaviour), so the send happens on the second Enter. --- */
w.__SENT.length = 0;
type('/release-notes');
ok('first Enter completes the skill command into the composer (autocomplete)',
   !sent().includes('prompt'), JSON.stringify(sent()));
type(d.getElementById('composer-input').value);
const t6 = sent();
ok('typed "/release-notes" (a skill) still goes through prompt', t6.includes('prompt'), JSON.stringify(t6));

/* --- 7. ordinary prose starting with a slash is NOT intercepted --- */
w.__SENT.length = 0;
type('/notacommand please explain');
ok('unknown "/notacommand ..." still goes to the model as prose', sent().includes('prompt'), JSON.stringify(sent()));

w.__SENT.length = 0;
type('what is 2+2');
ok('plain text is unaffected', sent().includes('prompt'), JSON.stringify(sent()));

/* --- 8. bare TUI-only command prefills instead of firing a dead notice --- */
w.__SENT.length = 0;
toastsEl.innerHTML = '';
type('/tree');
ok('bare "/tree" prefills the composer with its arg hint',
   d.getElementById('composer-input').value.startsWith('/tree'), JSON.stringify(input.value));
ok('bare "/tree" sends nothing', sent().length === 0, JSON.stringify(sent()));

/* --- 9. fork popover: populated from get_fork_messages, click sends entryId --- */
w.__SENT.length = 0;
const forkList = d.getElementById('fork-list');
forkList.innerHTML = '';
frame({ kind: 'rpc', data: { type: 'response', command: 'get_fork_messages', success: true, data: { messages: [
  { entryId: 'e1', text: 'first user message' },
  { entryId: 'e2', text: 'second   user\nmessage' },
] } } });
ok('fork popover renders an entry per message', forkList.children.length === 2, String(forkList.children.length));
ok('fork entries show the message text', /first user message/.test(forkList.textContent), JSON.stringify(forkList.textContent.slice(0, 80)));
ok('no dev placeholder toast is emitted', !/coming from get_fork_messages/.test(toasts()));

forkList.children[1].dispatchEvent(new w.Event('click', { bubbles: true }));
const forkCall = w.__SENT.find((m) => m.data && m.data.type === 'fork');
ok('clicking a fork entry sends `fork` with its entryId',
   !!forkCall && forkCall.data.entryId === 'e2', JSON.stringify(forkCall && forkCall.data));

/* --- 10. empty fork list is honest, not blank --- */
forkList.innerHTML = '';
frame({ kind: 'rpc', data: { type: 'response', command: 'get_fork_messages', success: true, data: { messages: [] } } });
ok('empty fork list says so', /no earlier messages/.test(forkList.textContent), JSON.stringify(forkList.textContent));

const passed = results.filter(Boolean).length;
console.log(`\n=== ${passed}/${results.length} passed ===`);
process.exit(passed === results.length ? 0 : 1);
