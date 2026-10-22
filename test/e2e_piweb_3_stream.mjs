// Live streaming test: send a real prompt and verify the full event flow.
import WebSocket from 'ws';

const WS_URL = 'ws://127.0.0.1:4321/ws';
const PROMPT = 'Reply with exactly: PIWEB_E2E_OK';

const seen = {
  agentStart: false, agentSettled: false,
  messageStart: 0, messageEnd: 0,
  textDeltas: 0, text: '',
  thinkingDeltas: 0,
  toolStarts: 0, toolEnds: 0,
  errors: [],
};

const ws = new WebSocket(WS_URL);
let sent = false;
let settled = false;

const done = (why) => {
  if (settled) return;
  settled = true;
  console.log(`\n--- finished: ${why} ---`);
  console.log('agent_start        :', seen.agentStart);
  console.log('message_start      :', seen.messageStart);
  console.log('text_delta count   :', seen.textDeltas);
  console.log('thinking_delta cnt :', seen.thinkingDeltas);
  console.log('tool starts/ends   :', seen.toolStarts, '/', seen.toolEnds);
  console.log('message_end        :', seen.messageEnd);
  console.log('agent_settled      :', seen.agentSettled);
  console.log('errors             :', seen.errors.length ? seen.errors : 'none');
  console.log('\nASSISTANT TEXT:\n' + JSON.stringify(seen.text));
  const pass = seen.agentStart && seen.messageStart > 0 && (seen.textDeltas > 0 || seen.text.length > 0) && seen.agentSettled;
  console.log('\n' + (pass ? 'PASS' : 'FAIL') + '  live streaming round-trip');
  try { ws.close(); } catch {}
  process.exit(pass ? 0 : 1);
};

const hardTimeout = setTimeout(() => done('TIMEOUT after 240s'), 240000);

ws.on('open', () => {
  if (sent) return;
  sent = true;
  console.log('sending prompt: ' + JSON.stringify(PROMPT));
  ws.send(JSON.stringify({ kind: 'rpc', data: { type: 'prompt', message: PROMPT } }));
});

const t0 = Date.now();
ws.on('message', (raw) => {
  let m;
  try { m = JSON.parse(raw.toString()); } catch { return; }

  if (m.kind === 'error') { seen.errors.push(m.error); return; }
  if (m.kind !== 'rpc' || !m.data) return;

  const d = m.data;

  if (d.type === 'response') {
    if (!d.success && d.error) seen.errors.push(`${d.command}: ${d.error}`);
    if (d.command === 'prompt') console.log(`  prompt accepted (success=${d.success}) at +${((Date.now()-t0)/1000).toFixed(1)}s`);
    return;
  }

  if (d.type === 'extension_ui_request') return;

  switch (d.type) {
    case 'agent_start': seen.agentStart = true; console.log(`  +${((Date.now()-t0)/1000).toFixed(1)}s agent_start`); break;
    case 'message_start': seen.messageStart++; break;
    case 'message_end': seen.messageEnd++; break;
    case 'agent_settled': seen.agentSettled = true; clearTimeout(hardTimeout); setTimeout(() => done('agent_settled'), 400); break;
    case 'tool_execution_start': seen.toolStarts++; break;
    case 'tool_execution_end': seen.toolEnds++; break;
    case 'message_update': {
      const a = d.assistantMessageEvent;
      if (!a) break;
      if (a.type === 'text_delta') { seen.textDeltas++; seen.text += a.delta || ''; }
      if (a.type === 'thinking_delta') seen.thinkingDeltas++;
      break;
    }
    case 'agent_end': console.log(`  +${((Date.now()-t0)/1000).toFixed(1)}s agent_end`); break;
  }
});

ws.on('error', (e) => { seen.errors.push('ws: ' + e.message); done('ws error'); });
