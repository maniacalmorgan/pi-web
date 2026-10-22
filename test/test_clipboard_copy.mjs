/* test_clipboard_copy.mjs — copy must actually work (or fail LOUDLY) on the http origin.
 *
 * BUG (independent review, 2026-10-03): the client called
 *   navigator.clipboard?.writeText(text).then(...)
 * `navigator.clipboard` is undefined on any non-secure origin (plain http:// that
 * isn't localhost) — the real deployment is http://127.0.0.1:4321 — so the
 * optional chain short-circuited to a no-op with NO toast: /copy and the per-message
 * ⧉ button silently did nothing.
 *
 * Fix: copyText(text, onResult) prefers the async Clipboard API only when
 * `navigator.clipboard && window.isSecureContext`, else falls back to a hidden
 * textarea + document.execCommand('copy'); either way it reports the outcome.
 *
 * This test compiles the REAL copyText() out of public/app.js and drives it with
 * injected navigator/document, so it exercises shipping code, not a copy.
 *
 * Run: node test/test_clipboard_copy.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_JS = path.join(HERE, '..', 'public', 'app.js');
const src = fs.readFileSync(APP_JS, 'utf8');

function loadCopyText() {
  const start = src.indexOf('function copyText(');
  if (start === -1) throw new Error('copyText not found in public/app.js');
  const end = src.indexOf('\n}', start);
  if (end === -1) throw new Error('end of copyText not found');
  const body = src.slice(start, end + 2);
  // eslint-disable-next-line no-new-func
  return new Function('navigator', 'window', 'document', `${body}\nreturn copyText;`);
}

const results = [];
const ok = (n, p, d) => { results.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`); };
const tick = () => new Promise((r) => setTimeout(r, 10));

/* A minimal document good enough for the textarea fallback. */
function makeDoc({ execResult = true } = {}) {
  const calls = { exec: 0, appended: 0, removed: 0, value: null };
  const doc = {
    execCommand(cmd) { calls.exec++; calls.cmd = cmd; return execResult; },
    createElement(tag) {
      return {
        tag, style: {}, _attrs: {},
        setAttribute(k, v) { this._attrs[k] = v; },
        select() { calls.value = this.value; },
        set value(v) { this._v = v; }, get value() { return this._v; },
      };
    },
    body: {
      appendChild() { calls.appended++; },
      removeChild() { calls.removed++; },
    },
  };
  return { doc, calls };
}

const makeCopyText = loadCopyText();

/* ---------- 1. insecure origin: fallback shim runs and reports success ---------- */
{
  const { doc, calls } = makeDoc({ execResult: true });
  const nav = {}; // no clipboard (insecure origin)
  const win = { isSecureContext: false };
  const copyText = makeCopyText(nav, win, doc);
  let got = null;
  copyText('hello world', (okv) => { got = okv; });
  ok('insecure origin: uses the textarea + execCommand fallback',
     calls.exec === 1 && calls.cmd === 'copy', `exec=${calls.exec} cmd=${calls.cmd}`);
  ok('insecure origin: the textarea is cleaned up (appended then removed)',
     calls.appended === 1 && calls.removed === 1, `appended=${calls.appended} removed=${calls.removed}`);
  ok('insecure origin: reports SUCCESS (not a silent no-op)',
     got === true, `onResult=${got}`);
  ok('insecure origin: the exact text reached the textarea',
     calls.value === 'hello world', JSON.stringify(calls.value));
}

/* ---------- 2. fallback failure is reported (still loud, never silent) ---------- */
{
  const { doc, calls } = makeDoc({ execResult: false });
  const copyText = makeCopyText({}, { isSecureContext: false }, doc);
  let got = null;
  copyText('x', (okv) => { got = okv; });
  ok('insecure origin: execCommand=false -> reports FAILURE (loud, not silent)',
     got === false && calls.exec === 1, `onResult=${got}`);
}

/* ---------- 3. secure origin: prefers the async Clipboard API ---------- */
{
  let written = null;
  const nav = { clipboard: { writeText: (t) => { written = t; return Promise.resolve(); } } };
  const doc = makeDoc();
  const copyText = makeCopyText(nav, { isSecureContext: true }, doc.doc);
  let got = null;
  copyText('secure text', (okv) => { got = okv; });
  await tick();
  ok('secure origin: uses navigator.clipboard.writeText', written === 'secure text', JSON.stringify(written));
  ok('secure origin: does NOT touch execCommand', doc.calls.exec === 0, String(doc.calls.exec));
  ok('secure origin: reports SUCCESS', got === true, `onResult=${got}`);
}

/* ---------- 4. secure origin + API rejection is reported ---------- */
{
  const nav = { clipboard: { writeText: () => Promise.reject(new Error('denied')) } };
  const copyText = makeCopyText(nav, { isSecureContext: true }, makeDoc().doc);
  let got = null;
  copyText('x', (okv) => { got = okv; });
  await tick();
  ok('secure origin: writeText rejection -> reports FAILURE', got === false, `onResult=${got}`);
}

/* ---------- 5. static wiring: the silent pattern is gone, both sites use copyText ---------- */
/* Strip comments first: the fix's own doc-comment quotes the OLD pattern, so a naive
   substring search would match the documentation, not live code. */
const codeOnly = src
  .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // line comments (avoid eating "http://")
ok('app.js code no longer contains the silent `navigator.clipboard?.writeText` pattern',
   !codeOnly.includes('navigator.clipboard?.writeText'), 'silent pattern removed from live code');
ok('app.js defines copyText()', /function copyText\s*\(/.test(src));
{
  // both copy call sites (/copy handler + per-message ⧉ button) go through copyText
  const uses = (codeOnly.match(/copyText\(/g) || []).length;
  ok('both copy sites route through copyText()', uses >= 3, `copyText( occurrences=${uses} (def + 2 call sites)`);
}

const passed = results.filter(Boolean).length;
console.log(`\n=== ${passed}/${results.length} passed ===`);
process.exit(passed === results.length ? 0 : 1);
