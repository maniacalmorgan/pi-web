/* test_title_sync.mjs — the topbar session title must never show the raw random session id,
 * and must agree with the left rail.
 *
 * Bug: get_state returns a random `sessionId` for GUI-created sessions, and the topbar fell back
 * to it, while the rail showed the first-message preview. Fix: one shared rule —
 * pi's sessionName -> the active rail row's name -> its preview -> fallback.
 *
 * Run: node test/test_title_sync.mjs
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const results = [];
const ok = (n, p, d) => { results.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`); };

const ACTIVE_PATH = `${process.env.HOME || '/'}/.pi/agent/sessions/--home-user--/2026-01-02T03-04-05-678Z_0f4b1c2e-9a7d-4b3e-8c15-6d2a7e90b4c1.jsonl`;
const RANDOM_ID = '0f4b1c2e-9a7d-4b3e-8c15-6d2a7e90b4c1';   // pi reports this as `sessionId`
const OTHER_PATH = '/tmp/x/other.jsonl';

frame({ kind: 'hello', state: 'running', cwd: process.env.HOME || '/' });
frame({ kind: 'pi_status', state: 'running' });

const title = () => window.document.getElementById('session-name').textContent;

ok('topbar starts empty', title() === '—', JSON.stringify(title()));

/* --- no name anywhere: must fall back to the rail PREVIEW, not the random id --- */
frame({ kind: 'sessions', sessions: [
  { id: RANDOM_ID, path: ACTIVE_PATH, name: null, preview: 'build me a thing please', messageCount: 2, updated: Date.now() },
  { id: 'other', path: OTHER_PATH, name: null, preview: 'unrelated', messageCount: 1, updated: Date.now() - 1000 },
]});
frame({ kind: 'rpc', data: { type: 'response', command: 'get_state', success: true, data: {
  sessionId: RANDOM_ID, sessionFile: ACTIVE_PATH, messageCount: 2, isStreaming: false } } });

ok('topbar does NOT show the raw random session id', !title().includes(RANDOM_ID), JSON.stringify(title()));
ok('topbar shows the active session PREVIEW when there is no name',
   title() === 'build me a thing please', JSON.stringify(title()));
ok('topbar did not pick the other row\'s preview', title() !== 'unrelated');

/* --- a real name wins over the preview --- */
frame({ kind: 'sessions', sessions: [
  { id: RANDOM_ID, path: ACTIVE_PATH, name: 'PI-WEB ORCHESTRATION', preview: 'build me a thing please', messageCount: 2, updated: Date.now() },
]});
ok('topbar updates to the session NAME when the rail reports one',
   title() === 'PI-WEB ORCHESTRATION', JSON.stringify(title()));
ok('topbar still does not leak the random id', !title().includes(RANDOM_ID));

/* --- pi's own sessionName takes priority over everything --- */
frame({ kind: 'rpc', data: { type: 'response', command: 'get_state', success: true, data: {
  sessionId: RANDOM_ID, sessionFile: ACTIVE_PATH, sessionName: 'named-in-pi', messageCount: 2, isStreaming: false } } });
ok('pi sessionName wins over the rail name', title() === 'named-in-pi', JSON.stringify(title()));

/* --- a rename while pi has no name must refresh the topbar live --- */
frame({ kind: 'rpc', data: { type: 'response', command: 'get_state', success: true, data: {
  sessionId: RANDOM_ID, sessionFile: ACTIVE_PATH, messageCount: 2, isStreaming: false } } });
ok('back to the rail preview after pi drops the name', title() === 'PI-WEB ORCHESTRATION', JSON.stringify(title()));
frame({ kind: 'sessions', sessions: [
  { id: RANDOM_ID, path: ACTIVE_PATH, name: 'RENAMED LIVE', preview: 'build me a thing please', messageCount: 2, updated: Date.now() },
]});
ok('a rename refreshes the topbar live (renderSessions updates it)',
   title() === 'RENAMED LIVE', JSON.stringify(title()));

/* --- switching away shows the other session\'s identity, still never an id --- */
frame({ kind: 'rpc', data: { type: 'response', command: 'get_state', success: true, data: {
  sessionId: 'other-uuid-9999', sessionFile: OTHER_PATH, messageCount: 1, isStreaming: false } } });
ok('switching sessions retitles the topbar without a raw id',
   !title().includes('other-uuid-9999') && title() !== 'RENAMED LIVE', JSON.stringify(title()));

/* --- nothing at all: the em-dash fallback, not an id --- */
frame({ kind: 'rpc', data: { type: 'response', command: 'get_state', success: true, data: {
  sessionId: 'totally-unknown-id', sessionFile: '/nowhere/zzz.jsonl', messageCount: 0, isStreaming: false } } });
ok('unknown session falls back to — (never the id)',
   title() === '—' && !title().includes('totally-unknown-id'), JSON.stringify(title()));

const passed = results.filter(Boolean).length;
console.log(`\n=== ${passed}/${results.length} passed ===`);
process.exit(passed === results.length ? 0 : 1);
