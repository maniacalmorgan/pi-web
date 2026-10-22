// Acceptance harness for the rail rename/delete feature.
// Drives the LIVE pi-web server over WebSocket — real files, real pi.
// Usage: node rail_acceptance.mjs            (test mode)
//        node rail_acceptance.mjs --cleanup  (remove the test bucket)
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';

const WS = 'ws://127.0.0.1:4321/ws';
const BUCKET = `${process.env.HOME || '/'}/.pi/agent/sessions/--tmp-piweb-railtest--`;
const SESSION_JSONL = fs.readdirSync(BUCKET).filter(f => f.endsWith('.jsonl'))
  .map(f => path.join(BUCKET, f));
const ALPHA = SESSION_JSONL.find(p => p.includes('railalpha'));
const BETA  = SESSION_JSONL.find(p => p.includes('railbeta'));

const results = [];
const ok = (n, p, d) => { results.push({ n, p }); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`); };

if (process.argv.includes('--cleanup')) {
  try { fs.rmSync(BUCKET, { recursive: true, force: true }); console.log(`removed ${BUCKET}`); }
  catch (e) { console.log(`cleanup failed: ${e.message}`); }
  process.exit(0);
}

if (!ALPHA || !BETA) { console.log('SETUP MISSING: run setup_rail_test.sh first'); process.exit(1); }
console.log(`alpha: ${path.basename(ALPHA)}\nbeta:  ${path.basename(BETA)}\n`);

const ws = new WebSocket(WS);
let waited = [];
const seen = (kind, pred) => new Promise((res) => {
  const h = (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.kind === kind && (!pred || pred(m))) { ws.off('message', h); res(m); }
  };
  ws.on('message', h);
  setTimeout(() => { ws.off('message', h); res(null); }, 20000);
});
const send = (o) => ws.send(JSON.stringify(o));

ws.on('open', async () => {
  // ---------- 1. serverside guards: path traversal ----------
  const bad1 = seen('error', m => /path|outside|invalid|reject/i.test(m.error || ''));
  send({ kind: 'delete_session', path: '/etc/passwd' });
  const r1 = await bad1;
  ok('rejects /etc/passwd delete', !!r1, r1 ? r1.error : 'no error frame');
  ok('  and did NOT delete /etc/passwd', fs.existsSync('/etc/passwd'), 'file intact');

  const bad2 = seen('error', m => /path|outside|invalid|reject/i.test(m.error || ''));
  send({ kind: 'delete_session', path: `${process.env.HOME || '/'}/.pi/agent/sessions/../../../etc/hosts` });
  const r2 = await bad2;
  ok('rejects traversal path', !!r2, r2 ? r2.error : 'no error frame');

  const bad3 = seen('error', m => /path|outside|invalid|reject|jsonl/i.test(m.error || ''));
  send({ kind: 'rename_session', path: '/tmp', name: 'nope' });
  const r3 = await bad3;
  ok('rejects non-jsonl / dir path', !!r3, r3 ? r3.error : 'no error frame');

  // ---------- 2. rename ----------
  const NEWNAME = 'RAIL RENAMED ALPHA ' + Date.now().toString().slice(-4);
  const rn = seen('session_action', m => m.action === 'rename' && m.ok);
  send({ kind: 'rename_session', path: ALPHA, name: NEWNAME });
  const r4 = await rn;
  ok('rename_session returns ok', !!r4, r4 ? JSON.stringify(r4) : 'no session_action');

  // name must have hit DISK as a session_info event
  const diskText = fs.readFileSync(ALPHA, 'utf8');
  const hasInfo = diskText.split('\n').some(l => {
    const t = l.trim(); if (!t) return false;
    try { const e = JSON.parse(t); return e.type === 'session_info' && e.name === NEWNAME; } catch { return false; }
  });
  ok('name persisted to disk as session_info', hasInfo, hasInfo ? '' : 'not found in file');

  // and the server's own listing must report it (proves summarizeSession picks it up)
  const sl = seen('sessions', m => (m.sessions || []).some(s => s.path === ALPHA));
  send({ kind: 'get_sessions' });
  const r5 = await sl;
  const rec = r5 && (r5.sessions || []).find(s => s.path === ALPHA);
  ok('server listing reports new name', !!rec && rec.name === NEWNAME, rec ? `name=${rec.name}` : 'not listed');

  // ---------- 3. switch to beta, then delete the ACTIVE session ----------
  const sw = seen('rpc', m => m.data && m.data.type === 'response' && m.data.command === 'switch_session');
  send({ kind: 'rpc', data: { type: 'switch_session', sessionPath: BETA } });
  const r6 = await sw;
  ok('switched to beta (so beta is ACTIVE)', !!r6 && r6.data.success === true, r6 ? JSON.stringify(r6.data) : 'no response');
  await new Promise(r => setTimeout(r, 800));

  const dl = seen('session_action', m => m.action === 'delete' && m.ok);
  send({ kind: 'delete_session', path: BETA });
  const r7 = await dl;
  ok('delete_session returns ok', !!r7, r7 ? JSON.stringify(r7) : 'no session_action');
  ok('beta file is GONE from disk', !fs.existsSync(BETA), fs.existsSync(BETA) ? 'still there' : '');

  // ---------- 4. pi survived deleting its ACTIVE session ----------
  await new Promise(r => setTimeout(r, 1200));
  const gs = seen('rpc', m => m.data && m.data.type === 'response' && m.data.command === 'get_state');
  send({ kind: 'rpc', data: { type: 'get_state' } });
  const r8 = await gs;
  ok('pi still answers get_state after active-file delete', !!r8 && r8.data.success !== false,
     r8 ? `state ok=${r8.data.success}` : 'NO RESPONSE — pi wedged');

  // ---------- 5. alpha (non-active) still exists ----------
  ok('alpha (non-active) untouched by beta delete', fs.existsSync(ALPHA), '');

  // ---------- 6. delete alpha too (cleanup) ----------
  const dl2 = seen('session_action', m => m.action === 'delete' && m.ok);
  send({ kind: 'delete_session', path: ALPHA });
  await dl2;
  ok('alpha deleted on request', !fs.existsSync(ALPHA), '');

  const passed = results.filter(r => r.p).length;
  console.log(`\n=== ${passed}/${results.length} acceptance checks passed ===`);
  process.exit(passed === results.length ? 0 : 1);
});

ws.on('error', (e) => { console.log('ws error: ' + e.message); process.exit(1); });
setTimeout(() => { console.log('\nTIMEOUT'); process.exit(1); }, 180000);
