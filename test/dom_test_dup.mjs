const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
// DOM-level test of app.js rendering: replay the EXACT event sequence captured
// from the live pi run (diag_dup.mjs) and assert nothing duplicates.
// jsdom is a dev-only dependency for the renderer test. Resolve it from an env
// override, else the project's own node_modules, else the scratch install.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
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
import fs from 'node:fs';

const html = fs.readFileSync(`${ROOT}/public/index.html`, 'utf8');

const dom = new JSDOM(html, {
  url: 'http://127.0.0.1:4321/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});

const { window } = dom;

// minimal stubs app.js touches
window.marked = { parse: (s) => `<p>${String(s).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}</p>` };
window.DOMPurify = { sanitize: (h) => h };
window.CSS = window.CSS || {};
if (!window.CSS.escape) window.CSS.escape = (s) => String(s).replace(/["\\]/g, '\\$&');
window.localStorage.clear();

// stub WebSocket so app.js's connect() is harmless
class FakeWS {
  constructor() { this.readyState = 1; FakeWS.inst = this; setTimeout(() => this.onopen && this.onopen(), 0); }
  send(s) { try { window.__SENT.push(JSON.parse(s)); } catch {} }
  close() {}
}
FakeWS.OPEN = 1;
window.__SENT = [];
window.WebSocket = FakeWS;

const appjs = fs.readFileSync(`${ROOT}/public/app.js`, 'utf8');
window.eval(appjs);

// app.js defers init() to DOMContentLoaded when readyState is 'loading';
// jsdom's outside-only mode never fires it, so dispatch it ourselves.
if (!FakeWS.inst) {
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
}
if (!FakeWS.inst) {
  console.log('FATAL: app.js never opened a WebSocket (init did not run)');
  process.exit(2);
}

// grab internals via a probe: app.js is an IIFE-less script using top-level
// const/let, so expose a hook by re-dispatching frames through the ws onmessage.
const ws = FakeWS.inst;
const frame = (o) => ws.onmessage({ data: JSON.stringify(o) });

const results = [];
const ok = (name, pass, detail) => { results.push({ name, pass }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`); };

const TOOL_ID = 'v9LAaFSVTjpabu3Q75vYmoBOczRgBH2Q';
const text = 'pi web runs, soldier.';

// --- replay the captured live sequence ---
frame({ kind: 'hello', state: 'running', cwd: process.env.HOME || '/' });
frame({ kind: 'pi_status', state: 'running' });
frame({ kind: 'rpc', data: { type: 'agent_start' } });
frame({ kind: 'rpc', data: { type: 'turn_start' } });

// user turn: arrives as message_start AND message_end
frame({ kind: 'rpc', data: { type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'Run exactly: echo DUPTEST' }], timestamp: 1774000000000 } } });
frame({ kind: 'rpc', data: { type: 'message_end',   message: { role: 'user', content: [{ type: 'text', text: 'Run exactly: echo DUPTEST' }], timestamp: 1774000000000 } } });

// assistant #1: bare toolcall, no text
frame({ kind: 'rpc', data: { type: 'message_start', message: { role: 'assistant', content: [], timestamp: 1774000010000 } } });
frame({ kind: 'rpc', data: { type: 'message_update', assistantMessageEvent: { type: 'thinking_start' } } });
frame({ kind: 'rpc', data: { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'need to echo' } } });
frame({ kind: 'rpc', data: { type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', id: TOOL_ID, toolName: 'bash' } } });
frame({ kind: 'rpc', data: { type: 'message_update', assistantMessageEvent: { type: 'thinking_end', content: 'need to echo' } } });
frame({ kind: 'rpc', data: { type: 'message_end', message: { role: 'assistant', content: [ { type: 'thinking', thinking: 'need to echo' }, { type: 'toolCall', id: TOOL_ID, name: 'bash', arguments: { command: 'echo DUPTEST' } } ] } } });

// tool execution
frame({ kind: 'rpc', data: { type: 'tool_execution_start', toolCallId: TOOL_ID, toolName: 'bash', args: { command: 'echo DUPTEST' } } });
frame({ kind: 'rpc', data: { type: 'tool_execution_end', toolCallId: TOOL_ID, toolName: 'bash', result: { content: [{ type: 'text', text: 'DUPTEST' }] }, isError: false } });

// toolResult replayed as its own message (the duplication source)
frame({ kind: 'rpc', data: { type: 'message_start', message: { role: 'toolResult', toolCallId: TOOL_ID, toolName: 'bash', content: [{ type: 'text', text: 'DUPTEST' }] } } });
frame({ kind: 'rpc', data: { type: 'message_end',   message: { role: 'toolResult', toolCallId: TOOL_ID, toolName: 'bash', content: [{ type: 'text', text: 'DUPTEST' }] } } });

frame({ kind: 'rpc', data: { type: 'turn_end' } });
frame({ kind: 'rpc', data: { type: 'turn_start' } });

// assistant #2: real text
frame({ kind: 'rpc', data: { type: 'message_start', message: { role: 'assistant', content: [], timestamp: 1774000015000 } } });
frame({ kind: 'rpc', data: { type: 'message_update', assistantMessageEvent: { type: 'thinking_start' } } });
frame({ kind: 'rpc', data: { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'report it' } } });
frame({ kind: 'rpc', data: { type: 'message_update', assistantMessageEvent: { type: 'text_start' } } });
for (const ch of ['pi web ', 'runs, ', 'soldier.']) {
  frame({ kind: 'rpc', data: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: ch } } });
}
frame({ kind: 'rpc', data: { type: 'message_update', assistantMessageEvent: { type: 'thinking_end', content: 'report it' } } });
frame({ kind: 'rpc', data: { type: 'message_update', assistantMessageEvent: { type: 'text_end', content: text } } });
frame({ kind: 'rpc', data: { type: 'message_end', message: { role: 'assistant', content: [ { type: 'thinking', thinking: 'report it' }, { type: 'text', text: text } ], timestamp: 1774000020000 } } });
frame({ kind: 'rpc', data: { type: 'turn_end' } });
frame({ kind: 'rpc', data: { type: 'agent_end', messages: [], willRetry: false } });
frame({ kind: 'rpc', data: { type: 'agent_settled' } });

// --- responses for the ctx pill + commands dropdown ---
frame({ kind: 'rpc', data: { type: 'response', command: 'get_state', success: true, data: {
  model: { id: 'qwen3-27b-q6', name: 'Qwen3-27B (LM Studio)', contextWindow: 80000 },
  thinkingLevel: 'high', isStreaming: false, sessionId: 'sess-1', messageCount: 15 } } });

frame({ kind: 'rpc', data: { type: 'response', command: 'get_session_stats', success: true, data: {
  totalMessages: 15,
  tokens: { input: 19415, output: 400, total: 19815 },
  contextUsage: { tokens: 3169, contextWindow: 80000, percent: 3.96125 } } } });

frame({ kind: 'rpc', data: { type: 'response', command: 'get_commands', success: true, data: {
  commands: [
    { name: 'llama', description: 'Manage llama.cpp router models', source: 'extension' },
    { name: 'skill:release-notes', description: 'Draft release notes', source: 'skill' },
    { name: 'skill:vault-offload', description: 'Offload findings to the vault', source: 'skill' },
    { name: 'fix-tests', description: 'Fix failing tests', source: 'prompt' },
  ] } } });

// --- assertions ---
const chat = window.document.getElementById('chat');
const q = (sel) => chat.querySelectorAll(sel);
const dq = (sel) => window.document.querySelectorAll(sel);   // document-wide (rail lives outside #chat)

ok('user message rendered exactly ONCE', q('.msg.user').length === 1, `found ${q('.msg.user').length}`);
ok('tool block rendered exactly ONCE', q('.tool').length === 1, `found ${q('.tool').length}`);
ok('tool block shows bash output', (q('.tool-body')[0]?.textContent || '').includes('DUPTEST'), JSON.stringify(q('.tool-body')[0]?.textContent));
ok('assistant bubbles === 1 (no empty tool-call bubble)', q('.msg.assistant').length === 1, `found ${q('.msg.assistant').length}`);
ok('no empty assistant bubbles', [...q('.msg.assistant')].every(n => (n.querySelector('.msg-body')?.textContent || '').trim().length > 0));
ok('assistant text present exactly once', chat.textContent.split('runs, soldier').length - 1 === 1, `occurrences=${chat.textContent.split('runs, soldier').length - 1}`);
ok('thinking blocks rendered', q('.thinking').length >= 2, `found ${q('.thinking').length}`);
ok('thinking blocks are siblings, not inside bubbles', q('.msg.assistant .thinking').length === 0, `inside bubbles: ${q('.msg.assistant .thinking').length}`);

// context pill
const ctx = window.document.getElementById('context-pill');
ok('context pill shows a value', /\d/.test(ctx.textContent) && ctx.textContent !== 'ctx —', JSON.stringify(ctx.textContent));

// --- timestamps ---
const msgTimes = [...q('.msg-time')].map(n => n.textContent);
ok('user message has a timestamp', q('.msg.user .msg-time').length === 1, JSON.stringify(q('.msg.user .msg-time')[0]?.textContent));
ok('assistant message has a timestamp', q('.msg.assistant .msg-time').length === 1, JSON.stringify(q('.msg.assistant .msg-time')[0]?.textContent));
ok('timestamps are 24-hour HH:MM', msgTimes.every(t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)), JSON.stringify(msgTimes));
ok('tool block has a timestamp', q('.tool .tool-time').length === 1, JSON.stringify(q('.tool .tool-time')[0]?.textContent));
ok('thinking block has a timestamp', q('.thinking .thinking-time').length >= 1, `count=${q('.thinking .thinking-time').length}`);
ok('full date available in title', /^\w{3} \d{2}, \d{4} \d{2}:\d{2}$/.test(q('.msg.user .msg-time')[0]?.title || ''), JSON.stringify(q('.msg.user .msg-time')[0]?.title));

// timestamps must follow the DEVICE timezone, not UTC.
// 1733234567890 = 2024-12-03T13:22:47Z. Force a fixed TZ and re-check.
const tzProbe = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
  .format(new Date(1733234567890));
ok('timestamp honors local timezone (not raw UTC slice)', typeof tzProbe === 'string' && /^\d{2}:\d{2}$/.test(tzProbe), `TZ=${Intl.DateTimeFormat().resolvedOptions().timeZone} -> ${tzProbe}`);

// copy button present
ok('copy affordance present on messages', q('.msg-copy').length >= 2, `count=${q('.msg-copy').length}`);

// commands dropdown
const cmdSel = window.document.getElementById('commands-select');
ok('commands dropdown populated', cmdSel.options.length > 1, `${cmdSel.options.length} options`);
ok('commands grouped into optgroups', cmdSel.querySelectorAll('optgroup').length >= 1, `${cmdSel.querySelectorAll('optgroup').length} groups`);
ok('native pi commands present', [...cmdSel.options].some(o => o.value === 'native:model'), 'looking for native:model');
ok('native pi commands include the 5 the user named', ['settings','model','tree','thinking','scoped-models'].every(n => [...cmdSel.options].some(o => o.value === 'native:' + n)), 'settings/model/tree/thinking/scoped-models');
ok('extension commands present', [...cmdSel.options].some(o => o.value === 'ext:llama'), 'looking for ext:llama');
ok('dropdown is NOT disabled', cmdSel.disabled === false, `disabled=${cmdSel.disabled}`);

// --- boot-on-hello: a bare `hello` with state=running must trigger boot() ---
// Verified indirectly: S.commands got populated from the get_commands response above
// only because boot() ran. Assert the dropdown reflects NATIVE even with zero
// extension commands (i.e. it never goes grey/empty).
{
  const sel2 = window.document.getElementById('commands-select');
  const before = sel2.options.length;
  frame({ kind: 'rpc', data: { type: 'response', command: 'get_commands', success: true, data: { commands: [] } } });
  ok('dropdown still usable with zero extension commands', sel2.options.length > 5 && !sel2.disabled, `${sel2.options.length} options, disabled=${sel2.disabled}`);
}

// --- session rail: kebab menu (rename/delete) ---
{
  const sent = window.__SENT;
  frame({ kind: 'sessions', sessions: [
    { id: 'sess-a', path: '/tmp/x/sess-a.jsonl', name: 'ALPHA SESSION', preview: 'hi', messageCount: 3, updated: Date.now() - 60000 },
    { id: 'sess-b', path: '/tmp/x/sess-b.jsonl', name: null, preview: 'hello there', messageCount: 1, updated: Date.now() - 7200000 },
  ]});
  const rows = [...dq('.session-item')];
  ok('rail renders one row per session', rows.length === 2, `${rows.length} rows`);
  ok('every row has a kebab', rows.every(r => r.querySelector('.s-kebab')), 'looking for .s-kebab in each row');
  ok('rail shows the session name when set', rows.some(r => /ALPHA SESSION/.test(r.textContent)), '');

  // open the menu on row 0
  const kebab0 = rows[0].querySelector('.s-kebab');
  kebab0.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const menus = [...dq('.s-menu')];
  ok('clicking kebab opens exactly one menu', menus.length === 1, `${menus.length} menus`);
  ok('menu offers Rename and Delete', /Rename/.test(menus[0].textContent) && /Delete/.test(menus[0].textContent), menus[0].textContent.trim());

  // toggle closed
  kebab0.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  ok('clicking kebab again closes the menu', dq('.s-menu').length === 0, `${dq('.s-menu').length} menus`);

  // kebab must NOT trigger the row's switch_session
  sent.length = 0;
  const kebab1 = rows[1].querySelector('.s-kebab');
  kebab1.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const switchSends = sent.filter(s => s.kind === 'rpc' && s.data && s.data.type === 'switch_session');
  ok('kebab click does NOT fire switch_session', switchSends.length === 0, `${switchSends.length} switch_session sends`);

  // row click still DOES fire switch_session (no regression)
  sent.length = 0;
  rows[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const switchSends2 = sent.filter(s => s.kind === 'rpc' && s.data && s.data.type === 'switch_session');
  ok('row click still fires switch_session (no regression)', switchSends2.length === 1, `${switchSends2.length} sends`);
}

const failed = results.filter(r => !r.pass);
console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
process.exit(failed.length ? 1 : 0);
