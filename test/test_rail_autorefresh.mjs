/* test_rail_autorefresh.mjs — LIVE: the server must push an updated session list on its OWN,
 * without the client asking, when session files change on disk.
 *
 * This is the bug: refreshSessions() only ran on a mutating RPC *response*, and pi writes the
 * session file AFTER sending that response — so a refresh raced the write and the rail stayed
 * stale until an unrelated event. The fix is a server-side fingerprint watcher.
 *
 * Spawns a THROWAWAY server on :4399 (never the user's :4321) with the --no-session wrapper,
 * connects, then creates a REAL session file on disk the same way pi does and asserts the server
 * pushes a new list unprompted. Cleans up the file it created.
 */
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = 4399;
const BASE = `http://127.0.0.1:${PORT}`;
const WRAPPER = path.join(HERE, 'pi-nosession');
const SESSIONS_DIR = path.join(os.homedir(), '.pi/agent/sessions');
const TMP_BUCKET = path.join(SESSIONS_DIR, '--tmp-piweb-railrefresh--');
const FIXTURE = path.join(TMP_BUCKET, 'fixture-railrefresh.jsonl');

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, ['server.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_HOST: '127.0.0.1', PI_BIN: WRAPPER },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (c) => (log += c));
server.stderr.on('data', (c) => (log += c));
let ws;
const teardown = () => {
  try { ws?.close(); } catch {}
  try { server.kill('SIGTERM'); } catch {}
  try { server.kill('SIGKILL'); } catch {}
  try { fs.rmSync(TMP_BUCKET, { recursive: true, force: true }); } catch {}
};

try {
  // make sure no stale fixture from a previous run is counted
  try { fs.rmSync(TMP_BUCKET, { recursive: true, force: true }); } catch {}

  let healthy = false;
  for (let i = 0; i < 40; i++) {
    try { const j = await (await fetch(`${BASE}/healthz`)).json(); if (j.ok && j.pi === 'running') { healthy = true; break; } } catch {}
    await sleep(500);
  }
  ok('scratch :4399 server healthy', healthy);
  if (!healthy) { console.log(log); throw new Error('no scratch server'); }

  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const lists = [];
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.kind === 'sessions' && Array.isArray(m.sessions)) lists.push(m.sessions.map((s) => s.path));
  });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

  // the server pushes a list on connect (hello/spawn path) — wait for the first one
  for (let i = 0; i < 40 && lists.length === 0; i++) await sleep(250);
  ok('server pushes an initial session list on connect', lists.length > 0, `pushed ${lists.length}`);
  const baseline = lists.length;

  // Count pushes over a quiet window BEFORE touching anything: the watcher must NOT spam.
  // NOTE: this scratch server watches the SAME sessions dir as the live GUI, so if the user happens
  // to be active there, a change (or two) can legitimately land in this window. A *broken* watcher
  // would push once per 3s poll (~2-3 in 6s), so tolerating <=1 still catches the spam case while
  // not failing on unrelated real activity.
  const quietBefore = lists.length;
  await sleep(6000);
  const idlePushes = lists.length - quietBefore;
  ok('watcher is quiet when nothing changes (no needless pushes)',
     idlePushes <= 1, `pushes during 6s idle: ${idlePushes}`);

  // now create a REAL session file the way pi does, and touch nothing else
  fs.mkdirSync(TMP_BUCKET, { recursive: true });
  fs.writeFileSync(FIXTURE,
    JSON.stringify({ type: 'session', version: 3, id: 'fixture-railrefresh', timestamp: new Date().toISOString(), cwd: os.homedir() }) + '\n' +
    JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'rail refresh probe' }], timestamp: Date.now() } }) + '\n');

  // the watcher polls at 3s — allow a couple of cycles
  const t0 = Date.now();
  let sawIt = false;
  while (Date.now() - t0 < 20000) {
    if (lists.some((l) => l.includes(FIXTURE))) { sawIt = true; break; }
    await sleep(500);
  }
  ok('server PUSHES an updated list on its own after a file appears (no client request)', sawIt,
     `list pushes since baseline: ${lists.length - baseline}`);
  ok('the pushed list actually contains the new file', lists.some((l) => l.includes(FIXTURE)));

  // and it notices a modification too (order/mtime change)
  const before2 = lists.length;
  await sleep(500);
  fs.appendFileSync(FIXTURE, JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'second message' }], timestamp: Date.now() } }) + '\n');
  const t1 = Date.now();
  while (Date.now() - t1 < 20000 && lists.length === before2) await sleep(500);
  ok('server also pushes when an existing session changes', lists.length > before2, `extra pushes: ${lists.length - before2}`);

  // deleting it must also propagate (the rail drops the row on its own)
  fs.rmSync(FIXTURE, { force: true });
  const t2 = Date.now();
  let gone = false;
  while (Date.now() - t2 < 20000) {
    const last = lists[lists.length - 1] || [];
    if (!last.includes(FIXTURE)) { gone = true; break; }
    await sleep(500);
  }
  ok('server pushes when a session disappears', gone, 'last list no longer contains the fixture');
} catch (e) {
  fail++;
  console.log(`FAIL  harness error: ${e.message}`);
  if (log) console.log('--- server log ---\n' + log.slice(-1500));
} finally {
  teardown();
}
console.log(`\n=== ${pass}/${pass + fail} passed ===`);
process.exit(fail ? 1 : 0);
