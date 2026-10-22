/* test_session_summary.mjs — the rail's message count must survive a rename.
 *
 * BUG (found by an independent review, 2026-10-03): summarizeSession() in server.mjs
 * early-exited once it had `header && name && preview`. `name` only exists for
 * RENAMED sessions (pi appends a `session_info` event whenever the user renames),
 * and that event can land anywhere in the file — often at EOF. So for renamed
 * sessions the counter froze near the first user message: the rail showed e.g.
 * "1" for a 180-message session. Measured on the real sessions dir: 38/180, 6/30,
 * 2/15. Fix: drop the early exit (listSessions already reads the whole file).
 *
 * The test drives the REAL summarizeSession() extracted from server.mjs, plus the
 * real sessions on disk as a regression sample.
 *
 * Run: node test/test_session_summary.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summarizeSession, SERVER_MJS } from './summarize.mjs';

const results = [];
const ok = (n, p, d) => { results.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`); };

/* Build a JSONL session from an array of event objects. */
function sessionFile(events) {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}
const msg = (role, text) => ({ type: 'message', message: { role, content: text } });

/* ---- 1. the exact regression: rename event lands AFTER many messages ---- */
const longSession = [
  { type: 'session', id: 'S1', cwd: '/home/x', timestamp: '2026-10-03T00:00:00Z' },
  msg('system', 'sys'),
  msg('user', 'first user message'),
  ...Array.from({ length: 120 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', 'm' + i)),
  { type: 'session_info', name: 'my renamed session' }, // rename appended near EOF
];
const info = summarizeSession(sessionFile(longSession), '/sessions/S1.jsonl');
ok('renamed session counts ALL messages, not just up to the rename',
   info && info.messageCount === 122, info ? `count=${info.messageCount} (expected 122)` : 'null');
ok('renamed session still reports its name', info && info.name === 'my renamed session', info && String(info.name));
ok('renamed session still reports the first-user preview', info && info.preview === 'first user message', info && String(info.preview));

/* ---- 2. unnamed session: identical count (no regression for the common case) ---- */
const unnamed = longSession.filter((e) => e.type !== 'session_info');
const info2 = summarizeSession(sessionFile(unnamed), '/sessions/S2.jsonl');
ok('unnamed session count is unchanged',
   info2 && info2.messageCount === 122, info2 ? String(info2.messageCount) : 'null');
ok('unnamed session name is null', info2 && info2.name === null, info2 && String(info2.name));

/* ---- 3. rename in the MIDDLE (the early exit used to fire mid-file) ---- */
const midRename = [
  { type: 'session', id: 'S3', cwd: '/home/x', timestamp: '2026-10-03T00:00:00Z' },
  msg('system', 'sys'),
  msg('user', 'hello'),
  { type: 'session_info', name: 'mid' },
  ...Array.from({ length: 40 }, (_, i) => msg('user', 'x' + i)),
];
const info3 = summarizeSession(sessionFile(midRename), '/sessions/S3.jsonl');
ok('rename in the middle still counts every later message',
   info3 && info3.messageCount === 42, info3 ? String(info3.messageCount) : 'null');

/* ---- 4. no header -> null (unchanged contract) ---- */
ok('a file with no session header returns null',
   summarizeSession([msg('user', 'orphan')].map(JSON.stringify).join('\n') + '\n', '/x.jsonl') === null);

/* ---- 5. real on-disk sessions: renamed ones must not undercount ---- */
const SESSIONS_DIR = path.join(os.homedir(), '.pi', 'agent', 'sessions');
let realChecked = 0;
let undercounts = 0;
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.jsonl')) checkOne(p);
  }
}
function checkOne(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  const info = summarizeSession(text, file);
  if (!info || !info.name) return; // only renamed sessions are the regression case
  // ground truth: count message lines directly
  const real = text.split('\n').filter((l) => l.trim()).reduce((n, l) => {
    try { return n + (JSON.parse(l).type === 'message' ? 1 : 0); } catch { return n; }
  }, 0);
  realChecked++;
  if (info.messageCount !== real) {
    undercounts++;
    console.log(`   undercount: ${path.basename(file)} -> ${info.messageCount} vs real ${real}`);
  }
}
if (fs.existsSync(SESSIONS_DIR)) walk(SESSIONS_DIR);
ok('every RENAMED session on disk now reports its true message count',
   realChecked > 0 && undercounts === 0,
   `${realChecked} renamed session(s) checked, ${undercounts} wrong`);

/* ---- 6. static: the early exit is really gone ---- */
const src = fs.readFileSync(SERVER_MJS, 'utf8');
ok('server.mjs no longer early-exits on header && name && preview',
   !/if\s*\(\s*header\s*&&\s*name\s*&&\s*preview\s*\)\s*break/.test(src));

const passed = results.filter(Boolean).length;
console.log(`\n=== ${passed}/${results.length} passed ===`);
process.exit(passed === results.length ? 0 : 1);
