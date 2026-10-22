/* test_pi_contract.mjs — "Is our stack still compatible with this pi?"
 *
 * Run this BEFORE and AFTER any `npm i -g @earendil-works/pi-coding-agent` upgrade.
 * It answers pass/fail, and names the broken surface when it fails.
 *
 * Three layers:
 *   1. STATIC  — pi's docs/rpc.md command+event surface vs our server's whitelist.
 *   2. RPC     — live `pi --mode rpc`: round-trips, switch_session param contract, streamed events.
 *   3. SESSION — session-file format, parsed by the server's own summarizeSession().
 *
 * EVERY pi invocation uses `--no-session` (or an explicit scratch session dir) so this never
 * litters your session rail. Probes must stay ephemeral.
 *
 * Usage:  node test/test_pi_contract.mjs            (all layers; slow ~2-3 min, needs a model)
 *         node test/test_pi_contract.mjs --fast     (layers 1 + 3 only, no model turns)
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, realpathSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PIWEB = path.resolve(HERE, '..');
const PI_BIN = process.env.PI_BIN || 'pi';

/* pi's docs ship with the npm package. Locate it from the global npm root (or from the
   pi binary's real path) rather than a hard-coded location; PI_PKG_DIR overrides. */
function findPiPkgDir() {
  if (process.env.PI_PKG_DIR) return process.env.PI_PKG_DIR;
  const cands = [];
  const root = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' }).stdout?.trim();
  if (root) cands.push(path.join(root, '@earendil-works/pi-coding-agent'));
  try {
    // .../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js
    const real = realpathSync(PI_BIN);
    cands.push(path.resolve(path.dirname(real), '..', '..', '..'));
  } catch { /* pi not on PATH; layer 1 will report it */ }
  return cands.find((c) => existsSync(path.join(c, 'docs', 'rpc.md'))) || '';
}
const PI_PKG_DIR = findPiPkgDir();
const RPC_DOC = path.join(PI_PKG_DIR, 'docs/rpc.md');
const SESSIONS_DIR = path.join(os.homedir(), '.pi/agent/sessions');

const FAST = process.argv.includes('--fast');
const results = [];
const ok = (layer, name, pass, detail = '') => {
  results.push({ layer, name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${layer}] ${name}${detail ? '  -- ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const piVersion = spawnSync(PI_BIN, ['--version'], { encoding: 'utf8' }).stdout?.trim() || 'unknown';
console.log(`\n=== pi contract check — pi version ${piVersion} ===\n`);

/* ─────────────────────────── layer 1: static contract ─────────────────────────── */
console.log('--- layer 1: static (docs/rpc.md vs our whitelist) ---');

let doc = '';
try { doc = (await import('node:fs')).readFileSync(RPC_DOC, 'utf8'); } catch { /* handled below */ }
ok('static', 'docs/rpc.md readable', !!doc, doc ? `${doc.length} bytes` : RPC_DOC);

// commands are `#### name` headings; events are `### name` headings after the Event Types marker.
// Restrict to the CORE protocol section — the "Extension UI Protocol" section also uses `####`
// for its own request types (select/confirm/editor/…) and JS class names, which are not RPC
// commands and would show up as misleading "we don't expose these" noise.
const uiIdx = doc.indexOf('## Extension UI Protocol');
const coreDoc = uiIdx < 0 ? doc : doc.slice(0, uiIdx);
const docCommands = [...coreDoc.matchAll(/^####\s+([A-Za-z_][\w]*)/gm)].map((m) => m[1]);
const evIdx = doc.indexOf('### Event Types');
const docEvents = evIdx < 0 ? [] : [...doc.slice(evIdx).matchAll(/^###\s+(.+)$/gm)]
  .flatMap((m) => m[1].split('/'))
  .map((s) => s.trim())
  .filter((s) => /^[a-z_]+$/.test(s));

ok('static', 'doc lists RPC commands', docCommands.length > 20, `${docCommands.length} commands`);
ok('static', 'doc lists event types', docEvents.length >= 6, `${docEvents.length} events`);

// our server's whitelist
const serverSrc = (await import('node:fs')).readFileSync(path.join(PIWEB, 'server.mjs'), 'utf8');
const wlMatch = serverSrc.match(/const ALLOWED_COMMANDS = new Set\(\[([\s\S]*?)\]\);/);
const whitelist = wlMatch ? [...wlMatch[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]) : [];
ok('static', 'server ALLOWED_COMMANDS parsed', whitelist.length > 20, `${whitelist.length} allowed`);

// THE compatibility assertion: every command our bridge relies on must still exist in the docs
const missing = whitelist.filter((c) => c !== 'extension_ui_response' && !docCommands.includes(c));
ok('static', 'every command the server whitelists still exists in pi docs',
   missing.length === 0, missing.length ? `GONE: ${missing.join(', ')}` : 'all present');

const extra = docCommands.filter((c) => !whitelist.includes(c));
if (extra.length) console.log(`      note: pi offers ${extra.length} command(s) we don't expose: ${extra.join(', ')}`);

// the specific param-name contract that bit us once
ok('static', 'switch_session documented with sessionPath (not sessionId)',
   /switch_session[\s\S]{0,400}sessionPath/.test(doc));

/* ─────────────────────────── layer 3: session format ─────────────────────────── */
console.log('\n--- layer 3: session file format + the server-side parser ---');

function walkSessions(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkSessions(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}
const allSessions = walkSessions(SESSIONS_DIR).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
ok('session', 'existing session files found', allSessions.length > 0, `${allSessions.length}`);

if (allSessions.length) {
  const sample = allSessions[0];
  const lines = (await import('node:fs')).readFileSync(sample, 'utf8').split('\n').filter((l) => l.trim());
  let header = null;
  for (const l of lines) { try { const e = JSON.parse(l); if (e.type === 'session') { header = e; break; } } catch {} }
  ok('session', 'session file has a type:"session" header', !!header, header ? `id=${header.id}` : 'NO HEADER');
  ok('session', 'header carries id + timestamp + cwd',
     !!(header && header.id && header.timestamp && header.cwd),
     header ? `v${header.version} keys=${Object.keys(header).join(',')}` : '');

  // parse a REAL session file with the server's OWN summarizeSession() (extracted straight
  // from server.mjs by test/summarize.mjs) — never a re-implementation that could drift.
  const { summarizeSession } = await import('./summarize.mjs');
  let info = null;
  try { info = summarizeSession(lines.join('\n'), sample); } catch (e) { info = { error: e.message }; }
  ok('session', 'summarizeSession() still parses a real session file',
     !!(info && info.id), info ? `id=${String(info.id).slice(0, 20)} msgs=${info.messageCount}` : 'null');
}

/* ─────────────────────────── layer 2: live model turns ─────────────────────────────── */
if (FAST) {
  console.log('\n(fast mode — skipping the live RPC layer)');
} else {

/* ---- layer 2: RPC (the dialect this server speaks) ---- */
console.log('\n--- layer 2: live RPC dialect (what this server speaks) ---');

// Use a SCRATCH session dir, not --no-session: --no-session leaves no session file, and the
// real surfaces DO have one (get_state.sessionFile is load-bearing for the rail highlight).
// A scratch dir gives us the true shape while keeping the probe ephemeral.
const scratchSessions = mkdtempSync(path.join(os.tmpdir(), 'pi-contract-sessions-'));

const rpc = spawn(PI_BIN, ['--session-dir', scratchSessions, '--mode', 'rpc'],
  { stdio: ['pipe', 'pipe', 'pipe'], cwd: os.homedir() });
let rbuf = '';
const rIn = [];
rpc.stdout.on('data', (c) => {
  rbuf += c.toString();
  let i;
  while ((i = rbuf.indexOf('\n')) >= 0) { const l = rbuf.slice(0, i); rbuf = rbuf.slice(i + 1); if (l.trim()) { try { rIn.push(JSON.parse(l)); } catch {} } }
});
rpc.stderr.on('data', () => {});   // reasoning noise; keep the run quiet
let rCursor = 0;                    // consume-once cursor: never re-count an event
const take = () => { const out = rIn.slice(rCursor); rCursor = rIn.length; return out; };
const rpcSend = (o) => rpc.stdin.write(JSON.stringify(o) + '\n');
/* Search only responses that arrived AFTER `from`. Without the floor, a second identical command
   re-finds the FIRST response — which made a rejected switch_session look like the earlier
   successful one (and hid the real result). */
const waitResp = async (cmd, from, ms = 30000) => {
  const start = from ?? 0;
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const h = rIn.slice(start).find((r) => r.type === 'response' && r.command === cmd);
    if (h) return h;
    await sleep(150);
  }
  return null;
};

await sleep(1500);
let floor = rIn.length;
rpcSend({ type: 'get_state' });
let st = await waitResp('get_state', floor);
ok('rpc', 'get_state round-trip', !!st && st.success === true,
   st ? `sessionFile=${path.basename(st.data?.sessionFile || '')}` : 'no response');
ok('rpc', 'get_state still exposes sessionFile + sessionId + messageCount',
   !!(st && st.data && st.data.sessionFile && st.data.sessionId !== undefined && st.data.messageCount !== undefined),
   st ? `keys=${Object.keys(st.data || {}).join(',')}` : '');

floor = rIn.length;
rpcSend({ type: 'get_available_models' });
const md = await waitResp('get_available_models', floor);
const models = md?.data?.models || md?.data || [];
ok('rpc', 'get_available_models round-trip', md?.success === true, `models=${Array.isArray(models) ? models.length : '?'}`);

floor = rIn.length;
rpcSend({ type: 'get_messages' });
const gm = await waitResp('get_messages', floor);
ok('rpc', 'get_messages round-trip', gm?.success === true);

// the param-name contract: sessionPath works, sessionId must still fail. Build a second real
// session in the scratch dir so we have something legitimate to switch TO.
{
  const r2 = spawnSync(PI_BIN, ['--session-dir', scratchSessions, '--session-id', 'second', '--mode', 'json', '-p', 'say hi'],
    { encoding: 'utf8', timeout: 240000, maxBuffer: 16 * 1024 * 1024 });
  void r2;
}
const scratchFiles = existsSync(scratchSessions) ? readdirSync(scratchSessions).filter((f) => f.endsWith('.jsonl')) : [];
const target = scratchFiles.find((f) => path.join(scratchSessions, f) !== st?.data?.sessionFile);
if (!target) {
  ok('rpc', 'a second session exists to switch to', false, `found ${scratchFiles.length} session file(s)`);
} else {
  floor = rIn.length;
  rpcSend({ type: 'switch_session', sessionPath: path.join(scratchSessions, target) });
  const sw = await waitResp('switch_session', floor);
  ok('rpc', 'switch_session{sessionPath} succeeds', sw?.success === true, sw ? `cancelled=${sw.data?.cancelled}` : 'no response');
}
floor = rIn.length;
rpcSend({ type: 'switch_session', sessionId: 'bogus' });
const bad = await waitResp('switch_session', floor);
ok('rpc', 'switch_session{sessionId} still rejected (old bug stays dead)',
   bad?.success === false, bad ? `${bad.success} ${JSON.stringify(bad.error)}` : 'no response');

// streamed-event contract: the events pi-web's timer / labels / auto-close key off.
// Consume each event EXACTLY once (take()), and tally in a single pass.
take();  // drop everything queued so far
rpcSend({ type: 'prompt', message: 'Reply with exactly: CONTRACT_OK' });
const evSeen = { thinking_start: 0, thinking_delta: 0, thinking_end: 0, message_end: 0, agent_settled: 0, text_delta: 0 };
const t0 = Date.now();
while (Date.now() - t0 < 240000) {
  for (const r of take()) {
    if (r.type === 'message_update' && r.assistantMessageEvent) {
      const a = r.assistantMessageEvent.type;
      if (a in evSeen) evSeen[a]++;
    } else if (r.type in evSeen) {
      evSeen[r.type]++;
    }
  }
  if (evSeen.agent_settled > 0) break;
  await sleep(400);
}
ok('rpc', 'turn emits message_end', evSeen.message_end > 0, `count=${evSeen.message_end}`);
ok('rpc', 'turn emits agent_settled', evSeen.agent_settled > 0, `count=${evSeen.agent_settled}`);
ok('rpc', 'turn emits thinking_start + thinking_delta (drives the live UI)',
   evSeen.thinking_start > 0 && evSeen.thinking_delta > 0,
   `start=${evSeen.thinking_start} delta=${evSeen.thinking_delta}`);
ok('rpc', 'turn emits streamed text (text_delta)', evSeen.text_delta > 0, `count=${evSeen.text_delta}`);
rpc.kill('SIGKILL');
try { rmSync(scratchSessions, { recursive: true, force: true }); } catch {}

}

/* ─────────────────────────── verdict ─────────────────────────── */
const failed = results.filter((r) => !r.pass);
const byLayer = {};
for (const r of results) {
  byLayer[r.layer] = byLayer[r.layer] || { pass: 0, total: 0 };
  byLayer[r.layer].total++;
  if (r.pass) byLayer[r.layer].pass++;
}
console.log('\n--- per-layer ---');
for (const [l, v] of Object.entries(byLayer)) console.log(`  ${l.padEnd(8)} ${v.pass}/${v.total}`);

console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
if (failed.length) {
  console.log('\nBROKEN SURFACES:');
  for (const f of failed) console.log(`  - [${f.layer}] ${f.name}`);
  console.log('\nVerdict: pi upgrade BREAKS or RISKS our stack. Fix, or pin back (see the pi-harness-upgrade skill).');
} else {
  console.log(`\nVerdict: pi ${piVersion} is COMPATIBLE with our stack (rpc + session format).`);
}
process.exit(failed.length ? 1 : 0);
