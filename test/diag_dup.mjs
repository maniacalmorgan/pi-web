// Diagnostic: log EVERY event in order for one prompt, so we can see exactly
// what renders twice. Also dump the get_state shape (for the ctx counter).
import WebSocket from 'ws';

const ws = new WebSocket('ws://127.0.0.1:4321/ws');
let sent = false;
const t0 = Date.now();
const el = () => '+' + ((Date.now() - t0) / 1000).toFixed(1) + 's';

function roleSig(m) {
  if (!m) return '?';
  const c = m.content;
  if (typeof c === 'string') return `${m.role}/str(${c.length})`;
  if (Array.isArray(c)) return `${m.role}/[${c.map((b) => b.type).join(',')}]`;
  return m.role || '?';
}

ws.on('open', () => {
  ws.send(JSON.stringify({ kind: 'rpc', data: { type: 'get_state' } }));
  console.log('=== GET_STATE REQUESTED ===');
});

ws.on('message', (raw) => {
  let m;
  try { m = JSON.parse(raw.toString()); } catch { return; }

  if (m.kind === 'hello') { console.log(`[hello] state=${m.state}`); return; }
  if (m.kind === 'sessions') { console.log(`[sessions] n=${(m.sessions||[]).length}`); return; }
  if (m.kind === 'pi_status') { console.log(`[pi_status] ${m.state}`); return; }
  if (m.kind === 'error') { console.log(`[error] ${m.error}`); return; }
  if (m.kind !== 'rpc') return;

  const d = m.data;

  if (d.type === 'response') {
    if (d.command === 'get_state') {
      console.log('=== GET_STATE RESPONSE (raw) ===');
      console.log(JSON.stringify(d.data, null, 2));
      console.log('=== SENDING PROMPT ===');
      if (!sent) {
        sent = true;
        ws.send(JSON.stringify({ kind: 'rpc', data: { type: 'prompt', message: 'Run exactly: echo DUPTEST' } }));
      }
    } else {
      console.log(`${el()} [response] ${d.command} success=${d.success}${d.error ? ' error=' + d.error : ''}`);
    }
    return;
  }

  if (d.type === 'extension_ui_request') { console.log(`${el()} [ext_ui] ${d.method}`); return; }

  switch (d.type) {
    case 'message_start':
      console.log(`${el()} message_START  ${roleSig(d.message)}`);
      break;
    case 'message_end':
      console.log(`${el()} message_END    ${roleSig(d.message)}`);
      break;
    case 'tool_execution_start':
      console.log(`${el()} tool_START     ${d.toolName} id=${d.toolCallId}`);
      break;
    case 'tool_execution_end':
      console.log(`${el()} tool_END       ${d.toolName} id=${d.toolCallId} isError=${d.isError}`);
      break;
    case 'tool_execution_update':
      break;
    case 'message_update': {
      const a = d.assistantMessageEvent;
      if (a && (a.type === 'text_start' || a.type === 'text_end' || a.type === 'thinking_start' || a.type === 'thinking_end' || a.type === 'toolcall_start')) {
        console.log(`${el()} msg_update     ${a.type}${a.toolName ? ' ' + a.toolName : ''}`);
      }
      break;
    }
    case 'agent_settled':
      console.log(`${el()} agent_settled`);
      console.log('\n=== DONE ===');
      setTimeout(() => { ws.close(); process.exit(0); }, 500);
      break;
    default:
      console.log(`${el()} [${d.type}]`);
  }
});

ws.on('error', (e) => { console.log('ws error: ' + e.message); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 240000);
