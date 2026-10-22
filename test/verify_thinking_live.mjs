/* verify_thinking_live.mjs — LIVE: does a REAL pi turn still emit the thinking events the
 * client's timer/label/auto-close depend on, and does the served bundle contain the features?
 *
 * Spawns a THROWAWAY server on :4399 (never the user's :4321) with the --no-session wrapper,
 * sends one real prompt through the real WebSocket, and inspects the real event stream.
 */
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = 4399;
const BASE = `http://127.0.0.1:${PORT}`;
const WRAPPER = path.join(HERE, 'pi-nosession');

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
  // SIGTERM then SIGKILL — see test_switch_session.mjs: a lingering :4399 makes the next
  // run's health poll lie while serving stale code.
  try { server.kill('SIGTERM'); } catch {}
  try { server.kill('SIGKILL'); } catch {}
};

const seen = { thinkingStart: 0, thinkingDelta: 0, thinkingEnd: 0, textDelta: 0, msgEnd: 0, settled: false, errors: [] };

try {
  let healthy = false;
  for (let i = 0; i < 40; i++) {
    try { const j = await (await fetch(`${BASE}/healthz`)).json(); if (j.ok && j.pi === 'running') { healthy = true; break; } } catch {}
    await sleep(500);
  }
  ok('scratch :4399 server healthy', healthy);
  if (!healthy) { console.log(log); throw new Error('no scratch server'); }

  const js = await (await fetch(`${BASE}/app.js`)).text();
  ok('served bundle has THINK_LABELS', js.includes('THINK_LABELS'));
  ok('served bundle has the live timer', js.includes('startThinkTimer'));
  ok('served bundle has finishThinking (auto-collapse)', js.includes('finishThinking'));
  ok('served bundle has the keep-open toggle', js.includes('piweb.keepThinkingOpen'));

  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.kind === 'error') { seen.errors.push(m.error); return; }
    if (m.kind !== 'rpc' || !m.data) return;
    const d = m.data;
    if (d.type === 'response') { if (!d.success && d.error) seen.errors.push(`${d.command}: ${d.error}`); return; }
    if (d.type === 'message_update' && d.assistantMessageEvent) {
      const a = d.assistantMessageEvent;
      if (a.type === 'thinking_start') seen.thinkingStart++;
      if (a.type === 'thinking_delta') seen.thinkingDelta++;
      if (a.type === 'thinking_end') seen.thinkingEnd++;
      if (a.type === 'text_delta') seen.textDelta++;
    }
    if (d.type === 'message_end') seen.msgEnd++;
    if (d.type === 'agent_settled') seen.settled = true;
  });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ok('ws connected to scratch server', true);

  ws.send(JSON.stringify({ kind: 'rpc', data: { type: 'prompt', message: 'Think it through, then reply with exactly: THINK_OK' } }));
  console.log('  prompt sent; waiting for the turn to settle…');

  const t0 = Date.now();
  while (!seen.settled && Date.now() - t0 < 300000) await sleep(1000);
  ok('turn settled', seen.settled, `${((Date.now() - t0) / 1000).toFixed(0)}s`);
  ok('live stream emitted thinking_start', seen.thinkingStart > 0, `count=${seen.thinkingStart}`);
  ok('live stream emitted thinking_delta (drives the live timer)', seen.thinkingDelta > 0, `count=${seen.thinkingDelta}`);
  ok('live stream emitted message_end (drives auto-collapse)', seen.msgEnd > 0, `count=${seen.msgEnd}`);
  ok('no errors during the turn', seen.errors.length === 0, seen.errors.join('; ') || 'none');
} catch (e) {
  fail++;
  console.log(`FAIL  harness error: ${e.message}`);
  if (log) console.log('--- server log ---\n' + log.slice(-1500));
} finally {
  teardown();
}
console.log(`\n=== ${pass}/${pass + fail} passed ===`);
process.exit(fail ? 1 : 0);
