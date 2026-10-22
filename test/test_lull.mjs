/* test_lull.mjs — the "lull" indicator (bouncing π shown while pi works but nothing
 * visible is happening).
 *
 * Runs the REAL public/index.html + public/app.js in jsdom with REAL timers and asserts:
 *   - nothing shows when idle
 *   - shows after the threshold once a prompt is sent (the send -> agent_start gap)
 *   - hides the instant any activity arrives (thinking delta / tool end)
 *   - hides on tool_execution_start and does NOT re-show while a tool is
 *     running, even after >1200ms of silence (tool block is visibly running)
 *   - re-shows after another quiet stretch
 *   - hides + stays hidden once the turn settles
 *   - the node is re-appended after a history reload (renderHistory clears #chat)
 * Plus CSS assertions: the bounce keyframes, the .lull-pi animation, and the
 * prefers-reduced-motion override.
 *
 * Plus a shuffle-bag section: the lull text is driven through the DOM (send + activity
 * events the lull listens to) and read from .lull-text — no production export used —
 * proving the phrase comes from the THINK_LABELS pool (read via ./pool.mjs), no repeats
 * until the whole pool has shown, and a fresh bag never re-opens on the last phrase.
 *
 * (No CSS edits — the π phrase is a plain text span; .lull-text needs no new styles.)
 *
 * Run: node test/test_lull.mjs
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { THINK_LABELS, POOL_SIZE } from './pool.mjs';

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
const css = fs.readFileSync(path.join(PUB, 'style.css'), 'utf8');

/* pool: read straight from public/app.js via ./pool.mjs (no hand-copy) */

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { window: w, document: d, frame } = boot();
const rpcFrame = (data) => frame({ kind: 'rpc', data });
const lull = () => d.querySelector('.lull');
const visible = () => { const l = lull(); return !!l && !l.classList.contains('hidden'); };

frame({ kind: 'hello', state: 'running', cwd: process.env.HOME || '/' });
rpcFrame({ type: 'response', command: 'get_state', success: true, data: { sessionId: 'x', isStreaming: false } });

/* --- idle: nothing shows --- */
ok('no lull indicator while idle', !visible(), JSON.stringify(lull() && lull().className));

/* --- send a prompt: lull should appear after the threshold (no agent_start yet) --- */
d.getElementById('composer-input').value = 'hello';
d.getElementById('send-btn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
ok('lull hidden immediately after send (not yet at threshold)', !visible());
await sleep(1400);
ok('lull SHOWS after the threshold with no activity (covers send->agent_start gap)',
   visible(), JSON.stringify(lull() && lull().className));
ok('lull node contains the π glyph', !!lull() && /π/.test(lull().textContent), JSON.stringify(lull() && lull().textContent));

/* --- activity hides it instantly --- */
rpcFrame({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: Date.now() } });
rpcFrame({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'x' } });
ok('lull hides the instant activity arrives', !visible());

/* --- and re-shows after another quiet stretch --- */
await sleep(1400);
ok('lull re-shows after a quiet stretch', visible());

/* --- tool RUNNING: the π must stay hidden during a long silent tool execution --- */
rpcFrame({ type: 'tool_execution_start', toolCallId: 't2', toolName: 'bash', args: { command: 'sleep 5' } });
ok('lull hides on tool_execution_start (NEW)', !visible());
await sleep(1400);
ok('lull does NOT show while a tool is running, even after >1200ms of silence (NEW)', !visible());

/* --- tool end also hides it --- */
rpcFrame({ type: 'tool_execution_end', toolCallId: 't2', toolName: 'bash', result: { content: [] }, isError: false });
ok('tool_execution_end hides the lull', !visible());

/* --- settle: hidden and STAYS hidden --- */
rpcFrame({ type: 'agent_settled' });
await sleep(1400);
ok('lull stays hidden after the turn settles', !visible());

/* --- history reload clears #chat; the next arm must re-append the node --- */
d.getElementById('composer-input').value = 'again';
d.getElementById('send-btn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await sleep(1400);
ok('lull re-appears after a send that follows a history reload',
   visible() && !!lull() && lull().isConnected);

/* --- CSS assertions --- */
ok('style.css defines the bounce keyframes', /@keyframes\s+lull-bounce/.test(css));
ok('the π glyph animates (lull-bounce)', /\.lull-pi\s*\{[^}]*lull-bounce/.test(css));
ok('prefers-reduced-motion disables the animation', /prefers-reduced-motion[^}]*\{[^}]*\.lull-pi\s*\{[^}]*animation:\s*none/.test(css));
ok('CSS braces balanced', (() => { let n = 0; for (const ch of css) { if (ch === '{') n++; else if (ch === '}') n--; if (n < 0) return false; } return n === 0; })());

/* --- shuffle bag: prove the lull text through the DOM, not an internal function ---
   The loop drives the real user-facing path: each iteration sends a prompt (arms the
   lull; the π pops after LULL_MS) and then pokes it with an activity event the lull
   listens to (turn_start: in LULL_ACTIVITY, no render side effects) so it hides +
   re-arms and the next iteration pops again. Every pop-up's text is read from
   .lull-text. The internal phrase-draw function stays private to app.js — this test
   never names it. */
{
  /* Fresh window: the bag is shared app state and the assertions above already popped the
     π (consuming phrases), so a cold bag is what makes the full-permutation assertion exact. */
  const bag = boot();
  const bw = bag.window;
  const bd = bag.document;
  const blull = () => bd.querySelector('.lull');
  const bvis = () => { const l = blull(); return !!l && !l.classList.contains('hidden'); };
  const btext = () => { const l = blull(); const t = l && l.querySelector('.lull-text'); return t ? t.textContent : null; };

  const N = POOL_SIZE + 6;   // bag 1 (a full pool) + 6 draws into bag 2
  const pops = [];
  for (let i = 0; i < N; i++) {
    bd.getElementById('composer-input').value = 'bag' + i;
    bd.getElementById('send-btn').dispatchEvent(new bw.MouseEvent('click', { bubbles: true }));
    await sleep(1350);                       // LULL_MS (1200) + margin: the π pops
    if (bvis()) pops.push(btext());
    /* poke with an activity event the lull listens to (turn_start: in LULL_ACTIVITY, no render
       side effects) so it hides + re-arms and the NEXT iteration pops again */
    bag.frame({ kind: 'rpc', data: { type: 'turn_start' } });
    await sleep(60);
  }

  ok(`harness sanity: all ${N} send+poke iterations produced a visible pop`,
     pops.length === N, `pops=${pops.length}`);
  ok('every pop-up shows a THINK_LABELS pool phrase — never the old hardcoded "pi is working…"',
     pops.length === N && pops.every((p) => THINK_LABELS.includes(p)),
     JSON.stringify(pops));
  ok(`first ${POOL_SIZE} pops are a full permutation of the pool (bag 1: all ${POOL_SIZE} distinct, none missing)`,
     new Set(pops.slice(0, POOL_SIZE)).size === POOL_SIZE && THINK_LABELS.every((p) => pops.slice(0, POOL_SIZE).includes(p)),
     JSON.stringify(pops.slice(0, POOL_SIZE)));
  ok(`pops ${POOL_SIZE + 1}-${N} are all distinct (bag 2 starts clean, no repeats within a bag)`,
     new Set(pops.slice(POOL_SIZE, N)).size === N - POOL_SIZE,
     JSON.stringify(pops.slice(POOL_SIZE, N)));
  ok('fresh bag does NOT re-open on the phrase that closed the previous bag (reshuffle guard)',
     pops[POOL_SIZE] !== pops[POOL_SIZE - 1],
     JSON.stringify({ bag1Closed: pops[POOL_SIZE - 1], bag2Opened: pops[POOL_SIZE] }));
  /* NOTE: do NOT assert distinctness over a POOL_SIZE-window straddling the bag boundary —
     a fresh bag is a reshuffle of the SAME pool, so such a window
     legitimately contains repeats. The no-repeat guarantee is per-bag, by design. */
}

const passed = results.filter(Boolean).length;
console.log(`\n=== ${passed}/${results.length} passed ===`);
process.exit(passed === results.length ? 0 : 1);
