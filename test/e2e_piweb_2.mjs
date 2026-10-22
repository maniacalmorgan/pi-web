// End-to-end test of pi-web: HTTP static, WS connect, RPC round-trip through pi.
import WebSocket from 'ws';
import http from 'node:http';

const BASE = 'http://127.0.0.1:4321';
const WS_URL = 'ws://127.0.0.1:4321/ws';

const results = [];
function ok(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
}

function get(path) {
  return new Promise((resolve) => {
    const req = http.get(BASE + path, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body, type: res.headers['content-type'] }));
    });
    req.on('error', (e) => resolve({ status: 0, body: '', error: e.message }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
  });
}

async function testHttp() {
  const idx = await get('/');
  ok('GET /          serves index.html', idx.status === 200 && /<div id="app">/.test(idx.body), `status=${idx.status} type=${idx.type}`);

  const css = await get('/style.css');
  ok('GET /style.css is real CSS', css.status === 200 && css.body.length > 5000 && /--bg:/.test(css.body), `${css.body.length} bytes`);

  const js = await get('/app.js');
  ok('GET /app.js    is real JS', js.status === 200 && js.body.length > 20000 && /WebSocket/.test(js.body), `${js.body.length} bytes`);

  const marked = await get('/vendor/marked.min.js');
  ok('GET /vendor/marked.min.js', marked.status === 200 && marked.body.length > 10000, `${marked.body.length} bytes`);

  const pur = await get('/vendor/purify.min.js');
  ok('GET /vendor/purify.min.js', pur.status === 200 && pur.body.length > 10000, `${pur.body.length} bytes`);

  const hz = await get('/healthz');
  let hzOk = false, hzDetail = '';
  try {
    const j = JSON.parse(hz.body);
    hzOk = j.ok === true;
    hzDetail = 'pi=' + j.pi;
  } catch {}
  ok('GET /healthz   reports ok', hzOk, hzDetail);

  const trav = await get('/../../etc/passwd');
  ok('path traversal is blocked', trav.status === 403 || trav.status === 404, `status=${trav.status}`);
}

function testWs() {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL);
    const seen = { hello: false, piRunning: false, stateResp: false, toolsResp: false, msgsResp: false };
    let stateData = null, toolCount = null, msgCount = null;
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      ok('WS   receives hello frame', seen.hello);
      ok('WS   pi reports running', seen.piRunning);
      ok('WS   get_state round-trip', seen.stateResp, stateData ? `model=${stateData.model?.id} thinking=${stateData.thinkingLevel} streaming=${stateData.isStreaming}` : '');
      ok('WS   get_available_models round-trip', seen.toolsResp, `models=${toolCount}`);
      ok('WS   get_messages round-trip', seen.msgsResp, `messages=${msgCount}`);
      try { ws.close(); } catch {}
      resolve();
    };

    const t = setTimeout(() => { console.log('   (WS test timed out — partial results)'); finish(); }, 30000);

    ws.on('open', () => {
      ws.send(JSON.stringify({ kind: 'rpc', data: { type: 'get_state' } }));
      ws.send(JSON.stringify({ kind: 'rpc', data: { type: 'get_available_models' } }));
      ws.send(JSON.stringify({ kind: 'rpc', data: { type: 'get_messages' } }));
    });

    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }

      if (m.kind === 'hello') seen.hello = true;
      if (m.kind === 'pi_status' && m.state === 'running') seen.piRunning = true;

      if (m.kind === 'rpc' && m.data && m.data.type === 'response') {
        if (m.data.command === 'get_state' && m.data.success) {
          seen.stateResp = true;
          stateData = m.data.data;
          if (stateData && typeof stateData.isStreaming === 'boolean') seen.piRunning = true;
        }
        if (m.data.command === 'get_available_models' && m.data.success) {
          seen.toolsResp = true;
          toolCount = (m.data.data && m.data.data.models || []).length;
        }
        if (m.data.command === 'get_messages' && m.data.success) {
          seen.msgsResp = true;
          msgCount = (m.data.data && m.data.data.messages || []).length;
        }
        if (seen.stateResp && seen.toolsResp && seen.msgsResp) {
          clearTimeout(t);
          setTimeout(finish, 300);
        }
      }

      if (m.kind === 'error') {
        console.log('   server error frame:', m.error);
      }
    });

    ws.on('error', (e) => {
      ok('WS   connect', false, e.message);
      clearTimeout(t);
      finish();
    });
  });
}

(async () => {
  console.log('=== HTTP ===');
  await testHttp();
  console.log('\n=== WEBSOCKET + RPC ===');
  await testWs();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  process.exit(failed.length ? 1 : 0);
})();
