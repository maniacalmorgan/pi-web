/* test_ctx_pill_live.mjs — LIVE integration check for the ctx-pill refresh cadence.
 *
 * Drives a scratch pi-web server (on :4399 by default) over the real WebSocket:
 *   - sends a real prompt
 *   - polls get_session_stats during the turn
 *   - asserts >= 2 stats responses arrive during the turn and contextUsage.tokens MOVES
 *
 * Start the scratch server first, e.g. (from the project root):
 *   PI_WEB_PORT=4399 PI_WEB_HOST=127.0.0.1 \
 *   PI_BIN=./test/pi-scratchsession node server.mjs &
 */
import WebSocket from 'ws';

const URL = process.env.PIWEB_WS || 'ws://127.0.0.1:4399/ws';
const results = [];
const ok = (n, p, d) => { results.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`); };

const ws = new WebSocket(URL);
let got = 0;
const ctxSeen = [];
let settled = false;

const send = (data) => ws.send(JSON.stringify({ kind: 'rpc', data }));

ws.on('open', () => {
  console.log('connected:', URL);
  send({ type: 'get_session_stats' });                 // baseline
  setTimeout(() => send({ type: 'prompt', message: 'Count from 1 to 5 slowly and think about each number, then reply with exactly: CTXLIVE_OK' }), 600);
  // poll stats mid-turn
  ioPoll = setInterval(() => { if (!settled) send({ type: 'get_session_stats' }); }, 3500);
});
let ioPoll = null;

ws.on('message', (raw) => {
  let m; try { m = JSON.parse(raw.toString()); } catch { return; }
  if (m.kind !== 'rpc') return;
  const d = m.data;
  if (d.type === 'response' && d.command === 'get_session_stats' && d.data) {
    got++;
    const cu = d.data.contextUsage;
    ctxSeen.push(cu ? cu.tokens : null);
  }
  if (d.type === 'agent_settled') {
    settled = true;
    setTimeout(() => {
      clearInterval(ioPoll);
      const distinct = new Set(ctxSeen.filter((x) => x != null));
      ok('server accepted repeated get_session_stats over the live WS', got >= 2, `got=${got}`);
      ok('contextUsage MOVED during the turn (live)', distinct.size >= 2,
         `values=${JSON.stringify(ctxSeen)}`);
      const passed = results.filter(Boolean).length;
      console.log(`\n=== ${passed}/${results.length} passed ===`);
      ws.close();
      setTimeout(() => process.exit(passed === results.length ? 0 : 1), 200);
    }, 1200);
  }
});

ws.on('error', (e) => { console.log('WS ERROR', e.message); process.exit(2); });
setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 200000);
