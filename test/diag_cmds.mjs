// Probe: get_commands (slash menu source) + get_session_stats (ctx counter source).
import WebSocket from 'ws';

const ws = new WebSocket('ws://127.0.0.1:4321/ws');
ws.on('open', () => {
  ws.send(JSON.stringify({ kind: 'rpc', data: { type: 'get_commands' } }));
  ws.send(JSON.stringify({ kind: 'rpc', data: { type: 'get_session_stats' } }));
  ws.send(JSON.stringify({ kind: 'rpc', data: { type: 'get_available_thinking_levels' } }));
});

ws.on('message', (raw) => {
  let m; try { m = JSON.parse(raw.toString()); } catch { return; }
  if (m.kind !== 'rpc' || !m.data || m.data.type !== 'response') return;
  const c = m.data.command;
  if (c === 'get_commands') {
    console.log('=== get_commands: success=' + m.data.success + ' ===');
    console.log(JSON.stringify(m.data.data, null, 2).slice(0, 4000));
  } else if (c === 'get_session_stats') {
    console.log('\n=== get_session_stats ===');
    console.log(JSON.stringify(m.data.data, null, 2));
  } else if (c === 'get_available_thinking_levels') {
    console.log('\n=== get_available_thinking_levels ===');
    console.log(JSON.stringify(m.data.data, null, 2));
  }
});

setTimeout(() => process.exit(0), 15000);
