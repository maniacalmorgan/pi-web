/* test_model_picker.mjs — the model dropdown: provider fix + greyed-out unloaded models.
 *
 * Runs the REAL public/index.html + public/app.js in jsdom and asserts:
 *   - clicking an available model sends set_model WITH `provider` (pi matches on
 *     provider AND modelId; a bare modelId is rejected as "Model not found:
 *     undefined/<id>") — the live bug fixed 2026-09-28
 *   - the /model slash arg path sends provider too
 *   - models named "... (not loaded)" render with the `unloaded` class and NO click
 *     handler (not selectable, by design — selecting one would make the backend load
 *     it, bypassing that model's custom parameters)
 *   - "/model <unloaded>" is refused with a toast instead of hitting pi
 *   - the model button names the ACTIVE model, not whichever entry the provider lists
 *     first (on a live catalog that first entry may be unloaded)
 *
 * Run: node test/test_model_picker.mjs
 */
import { existsSync } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PUB = path.join(ROOT, 'public');

const JSDOM_CANDIDATES = [
  process.env.JSDOM_PATH,
  new URL('../node_modules/jsdom/lib/api.js', import.meta.url).pathname,
].filter(Boolean);
const jsdomPath = JSDOM_CANDIDATES.find((p) => existsSync(p));
if (!jsdomPath) {
  console.log('jsdom not found. Install it with:  npm i -D jsdom');
  process.exit(2);
}
const { JSDOM } = await import(jsdomPath);

const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const appjs = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');

function boot() {
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:4321/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.marked = { parse: (s) => `<p>${String(s)}</p>` };
  window.DOMPurify = { sanitize: (h) => h };
  window.CSS = window.CSS || {};
  if (!window.CSS.escape) window.CSS.escape = (s) => String(s).replace(/["\\]/g, '\\$&');
  window.localStorage.clear();
  window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  class FakeWS {
    constructor() { this.readyState = 1; FakeWS.inst = this; setTimeout(() => this.onopen && this.onopen(), 0); }
    send(s) { try { window.__SENT.push(JSON.parse(s)); } catch {} }
    close() {}
  }
  FakeWS.OPEN = 1;
  window.__SENT = [];
  window.WebSocket = FakeWS;
  window.eval(appjs);
  if (!FakeWS.inst) window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  const frame = (o) => FakeWS.inst.onmessage({ data: JSON.stringify(o) });
  return { window, document: window.document, frame };
}

const results = [];
const ok = (n, p, d) => { results.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`); };

const { window: w, document: d, frame } = boot();
const rpcFrame = (data) => frame({ kind: 'rpc', data });

/* A live catalogue spanning all three providers (so the grouping is exercised). */
const CATALOG = [
  { provider: 'local-lmstudio', id: 'local/qwen3-27b', name: 'local/qwen3-27b (loaded)', contextWindow: 120064 },
  { provider: 'local-lmstudio', id: 'qwen3-27b-q6', name: 'qwen3-27b-q6 (not loaded)', contextWindow: 262144 },
  { provider: 'local-lmstudio', id: 'qwen3-27b-q8', name: 'qwen3-27b-q8 (not loaded)', contextWindow: 262144 },
  { provider: 'ollama-cloud', id: 'deepseek-v4.1-flash', name: 'DS-Flash', contextWindow: 1048576 },
  { provider: 'ollama-cloud', id: 'deepseek-v4-pro:0813', name: 'DS-Pro', contextWindow: 1048576 },
  { provider: 'openrouter', id: 'deepseek-flash-assist', name: 'deepseek-flash-assist', contextWindow: 262144 },
  { provider: 'openrouter', id: 'deepseek-pro-assist', name: 'deepseek-pro-assist', contextWindow: 262144 },
];

/* boot: pi already running -> boot() fires get_available_models; answer it. */
frame({ kind: 'hello', state: 'running', cwd: process.env.HOME || '/' });
const modelsSent = () => w.__SENT.filter((m) => m.kind === 'rpc' && m.data && m.data.type === 'get_available_models').length;
ok('boot requests the model list', modelsSent() >= 1, String(modelsSent()));
rpcFrame({ type: 'response', command: 'get_available_models', success: true, data: { models: CATALOG } });

/* --- 1. rendering: loaded selectable, unloaded greyed --- */
/* The refresh affordance is a standing entry in the list, not a catalog model — excluded
   from the catalog-count assertions but asserted separately below. */
const refreshRow = d.querySelector('#model-list .model-item.model-refresh');
/* Round 24: the list is a two-pane flyout — a provider pane + one OPEN bucket —
   so "items" is the models in the open pane (the active provider, the first one here). */
const items = [...d.querySelectorAll('#model-list .model-models .model-item')]
  .filter((n) => !n.classList.contains('model-back'));
ok('the open pane renders the active provider\'s entries', items.length === 3, String(items.length));
ok('the model list offers a refresh affordance', !!refreshRow && /refresh/.test(refreshRow.textContent),
   refreshRow ? JSON.stringify(refreshRow.textContent) : 'missing');
const unloadedItems = items.filter((n) => n.classList.contains('unloaded'));
ok('the two not-loaded models carry the `unloaded` class', unloadedItems.length === 2, String(unloadedItems.length));
ok('the loaded model is NOT marked unloaded',
   !items.find((n) => n.textContent.includes('local/qwen3-27b')).classList.contains('unloaded'));
ok('unloaded entries are marked aria-disabled', unloadedItems.every((n) => n.getAttribute('aria-disabled') === 'true'));
ok('loaded entry is not aria-disabled',
   items.find((n) => n.textContent.includes('local/qwen3-27b')).getAttribute('aria-disabled') === null);

/* --- 2. clicking an unloaded model does NOT reach pi --- */
const setModelCalls = () => w.__SENT.filter((m) => m.kind === 'rpc' && m.data && m.data.type === 'set_model');
const beforeUnloadedClick = setModelCalls().length;
for (const n of unloadedItems) n.dispatchEvent(new w.Event('click', { bubbles: true }));
ok('clicking greyed models sends NO set_model', setModelCalls().length === beforeUnloadedClick,
   `${beforeUnloadedClick} -> ${setModelCalls().length}`);

/* --- 3. clicking the loaded model DOES reach pi, WITH provider --- */
const loadedEl = items.find((n) => n.textContent.includes('local/qwen3-27b'));
loadedEl.dispatchEvent(new w.Event('click', { bubbles: true }));
const calls = setModelCalls();
ok('clicking an available model sends set_model', calls.length === 1, String(calls.length));
const call = calls[0] && calls[0].data;
ok('set_model carries the PROVIDER (the live bug: bare modelId is rejected)',
   call && call.provider === 'local-lmstudio', JSON.stringify(call));
ok('set_model carries the modelId', call && call.modelId === 'local/qwen3-27b', JSON.stringify(call));

/* --- 4. the model button toggles the picker (the real, reachable /model route) --- */
const pop = d.getElementById('model-pop');
pop.classList.add('hidden');
d.getElementById('model-btn').dispatchEvent(new w.Event('click', { bubbles: true }));
ok('clicking the model button opens the picker', !pop.classList.contains('hidden'));

/* --- 4b. the "/model <arg>" path IS reachable (Round 17) and must send provider ---
   This replaced an older note that claimed the path was unreachable because a typed
   "/model x" reached pi as plain text. That stopped being true in Round 17: sendPrompt()
   now intercepts typed native commands and routes "/model <name>" to selectModel(rest),
   so the path is live and carries the same load-bearing provider fix — and it must be
   tested like any other reachable path. */
const setModelCalls3 = () => w.__SENT.filter((m) => m.kind === 'rpc' && m.data && m.data.type === 'set_model');
const promptFrames = () => w.__SENT.filter((m) => m.kind === 'rpc' && m.data && m.data.type === 'prompt');
const beforeTyped = setModelCalls3().length;
const beforePrompts = promptFrames().length;
const inp = d.getElementById('composer-input');
inp.value = '/model local/qwen3-27b';
inp.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', shiftKey: false, bubbles: true }));
const afterTyped = setModelCalls3();
ok('typed "/model <name>" reaches set_model (the arg path is live, not dead)',
   afterTyped.length === beforeTyped + 1, `${beforeTyped} -> ${afterTyped.length}`);
const typedCall = afterTyped[afterTyped.length - 1] && afterTyped[afterTyped.length - 1].data;
ok('typed "/model <name>" carries the PROVIDER too',
   typedCall && typedCall.provider === 'local-lmstudio' && typedCall.modelId === 'local/qwen3-27b',
   JSON.stringify(typedCall));
ok('typed "/model <name>" is NOT sent to pi as a literal text prompt',
   promptFrames().length === beforePrompts, `${beforePrompts} -> ${promptFrames().length}`);

/* --- 5. the button names the ACTIVE model, not the first catalog entry ---
   The response shape here is pi's REAL one: the Model object IS `data` (there is no
   `model` key — verified live 2026-10-08). Reading only `data.model` silently threw the
   answer away, so the old model stayed named and stayed marked active: the dropdown
   "didn't stick". */
rpcFrame({ type: 'response', command: 'set_model', success: true, data: CATALOG[0] });
rpcFrame({ type: 'response', command: 'get_available_models', success: true, data: { models: CATALOG } });
const btn = d.getElementById('model-btn');
ok('model button names the active model, not the first listed entry',
   btn.textContent.includes('local/qwen3-27b') && !btn.textContent.includes('not loaded'),
   JSON.stringify(btn.textContent));
ok('a real-shaped set_model response moves the ACTIVE marker onto the chosen row',
   [...d.querySelectorAll('#model-list .model-models .model-item.active')]
     .every((n) => n.textContent.includes('local/qwen3-27b')),
   JSON.stringify([...d.querySelectorAll('#model-list .model-models .model-item.active')].map((n) => n.textContent)));

/* --- 6. CSS: the unloaded style exists and greys it out --- */
const css = fs.readFileSync(path.join(PUB, 'style.css'), 'utf8');
ok('CSS defines .model-item.unloaded', /\.model-item\.unloaded\s*\{/.test(css));
ok('CSS greys unloaded entries (dim colour + no pointer)',
   /\.model-item\.unloaded\s*\{[^}]*--fg-faint/.test(css) && /\.model-item\.unloaded\s*\{[^}]*cursor:\s*default/.test(css));
ok('CSS removes the hover highlight for unloaded entries',
   /\.model-item\.unloaded:hover\s*\{[^}]*background:\s*none/.test(css));

/* --- 7. refresh-models (2026-09-30). pi's catalogue is a FROZEN in-memory snapshot in
   --mode rpc — no refresh RPC exists — so a model loaded in LM Studio after pi started is
   invisible until the pi child is respawned. These assert the escape hatch exists and that
   it actually asks the server to restart pi (the client then re-opens the session). --- */
const liveRefreshRow = d.querySelector('#model-list .model-item.model-refresh');
const restartCalls = () => w.__SENT.filter((m) => m.kind === 'restart_pi');
const beforeRestart = restartCalls().length;
liveRefreshRow.dispatchEvent(new w.Event('click', { bubbles: true }));
ok('clicking refresh asks the server to restart the pi process',
   restartCalls().length === beforeRestart + 1, `${beforeRestart} -> ${restartCalls().length}`);
ok('the composer bar has a refresh button', !!d.getElementById('refresh-models'));
ok('CSS styles the model-list refresh row', /\.model-item\.model-refresh\s*\{/.test(css));
ok('CSS styles the composer refresh button', /\.refresh-models\s*\{/.test(css));

/* --- 8. two-pane model flyout: a provider pane plus the
   OPEN provider's models beside it; a provider tap swaps the models pane; mobile
   slides the pair (drill-in) with a "← Providers" row to come back. --- */
const dproviders = [...d.querySelectorAll('#model-list .model-providers .model-provider')].map((h) => h.textContent);
ok('provider pane lists one row per provider', dproviders.length === 3, JSON.stringify(dproviders));
ok('provider rows are labelled via PROVIDER_LABELS, in catalogue order',
   JSON.stringify(dproviders) === JSON.stringify(['LM Studio', 'Ollama Cloud', 'OpenRouter']), JSON.stringify(dproviders));

/* providers live on the LEFT pane, models on the RIGHT pane (side by side) */
const panes = d.querySelector('#model-list .model-panes');
const left = d.querySelector('#model-list .model-providers');
const right = d.querySelector('#model-list .model-models');
ok('the flyout has a provider pane and a models pane',
   !!panes && !!left && !!right && panes.contains(left) && panes.contains(right)
   && left.compareDocumentPosition(right) & 4 /* right follows left */, 'panes present');
ok('providers live in the LEFT pane',
   [...left.querySelectorAll('.model-provider')].length === 3 && left.querySelectorAll('.model-models').length === 0);

/* the models pane holds only the open provider and its models are the RIGHT ones */
const rightTexts = [...right.querySelectorAll('.model-item')].map((n) => n.textContent);
ok('models pane shows only the open (active) provider\'s models',
   rightTexts.includes('local/qwen3-27b (loaded)') && rightTexts.includes('qwen3-27b-q6 (not loaded)')
   && !rightTexts.includes('DS-Flash') && !rightTexts.includes('deepseek-pro-assist'),
   JSON.stringify(rightTexts));
ok('the open provider row is marked active',
   !!d.querySelector('#model-list .model-provider.active')
   && d.querySelector('#model-list .model-provider.active').textContent === 'LM Studio');
ok('the provider holding the active model is flagged (has-active)',
   !!d.querySelector('#model-list .model-provider.has-active'));

/* tapping a different provider swaps the models pane (desktop behaviour) */
const setCallsP = () => w.__SENT.filter((m) => m.kind === 'rpc' && m.data && m.data.type === 'set_model');
const beforeSwap = setCallsP().length;
[...left.querySelectorAll('.model-provider')].find((n) => n.textContent === 'OpenRouter')
  .dispatchEvent(new w.Event('click', { bubbles: true }));
const rightTexts2 = [...d.querySelectorAll('#model-list .model-models .model-item')].map((n) => n.textContent);
ok('tapping a provider swaps the models pane (no set_model fired)',
   rightTexts2.includes('deepseek-pro-assist') && rightTexts2.includes('deepseek-flash-assist')
   && !rightTexts2.includes('local/qwen3-27b (loaded)') && setCallsP().length === beforeSwap,
   JSON.stringify(rightTexts2));
ok('the tapped provider is now the active row',
   d.querySelector('#model-list .model-provider.active').textContent === 'OpenRouter');

/* a model in the swapped pane still selects with provider+id */
const orItem = [...d.querySelectorAll('#model-list .model-models .model-item')]
  .find((n) => n.textContent === 'deepseek-pro-assist');
const beforeOr = setCallsP().length;
orItem.dispatchEvent(new w.Event('click', { bubbles: true }));
const lastSet = setCallsP()[setCallsP().length - 1];
ok('clicking a model in the swapped pane sends set_model with provider+id',
   setCallsP().length === beforeOr + 1 && lastSet.data.provider === 'openrouter'
   && lastSet.data.modelId === 'deepseek-pro-assist', JSON.stringify(lastSet ? lastSet.data : null));

/* phone drill-in: the models pane is what slides, driven by .show-models on the list */
ok('a "← Providers" row exists in the models pane (phone back affordance)',
   !!right.querySelector('.model-item.model-back')
   && /Providers/.test(right.querySelector('.model-item.model-back').textContent));

/* re-open the picker -> reset to the provider list (modelDrilled=false clears show-models) */
const list = d.getElementById('model-list');
list.classList.add('show-models');
d.getElementById('model-pop').classList.add('hidden');
d.getElementById('model-btn').dispatchEvent(new w.Event('click', { bubbles: true }));
ok('re-opening the picker resets to the provider list (clears show-models)',
   !list.classList.contains('show-models'), 'show-models=' + list.classList.contains('show-models'));

/* static CSS wiring for the two-pane layout */
ok('CSS lays the panes side by side (flex row)',
   /\.model-panes\s*\{[^}]*display:\s*flex/.test(css));
ok('CSS widens #model-pop for two panes', /#model-pop\s*\{[^}]*min-width:\s*360px/.test(css));
ok('CSS styles .model-provider rows', /\.model-provider\s*\{/.test(css));
ok('CSS slides the pair on a phone (.show-models -> translateX(-50%))',
   /\.model-list\.show-models\s+\.model-panes\s*\{[^}]*translateX\(-50%\)/.test(css));
ok('CSS reveals the back row on a phone',
   /\.model-list\s+\.model-item\.model-back\s*\{[^}]*display:\s*block/.test(css));

const passed = results.filter(Boolean).length;
console.log(`\n=== ${passed}/${results.length} passed ===`);
process.exit(passed === results.length ? 0 : 1);
