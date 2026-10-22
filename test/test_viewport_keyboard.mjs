/* test_viewport_keyboard.mjs — the composer bar must stay visible when the
 * on-screen keyboard is open (2026-10-03).
 *
 * A mobile keyboard shrinks the VISUAL viewport but not the layout viewport, so
 * a 100dvh #app hid the composer bar (and the bottom rail) behind the keyboard.
 * Fix: initViewport() pins #app to the visual-viewport height (via the --app-h
 * custom property) whenever the viewport is meaningfully shorter than the layout
 * viewport, and clears it again when it closes.
 *
 * Renders the REAL public/index.html + public/app.js in jsdom with a
 * visualViewport shim and drives resize events.
 *
 * Run: node test/test_viewport_keyboard.mjs
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PUB = path.join(ROOT, 'public');

const require0 = createRequire(import.meta.url);
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
const css = fs.readFileSync(path.join(PUB, 'style.css'), 'utf8');

const results = [];
const ok = (n, p, d) => { results.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`); };

/* boot with a fake visualViewport we can drive. LAYOUT is the layout viewport
   height; VISUAL starts equal to it (no keyboard). */
function boot({ layout = 844 } = {}) {
  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1:4321/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.marked = { parse: (s) => `<p>${String(s)}</p>` };
  window.DOMPurify = { sanitize: (h) => h };
  window.CSS = window.CSS || {};
  if (!window.CSS.escape) window.CSS.escape = (s) => String(s).replace(/["\\]/g, '\\$&');
  window.localStorage.clear();
  window.matchMedia = (q) => ({
    matches: /max-width:\s*860px/.test(q),
    media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });

  // innerHeight is the layout viewport height in this model.
  Object.defineProperty(window, 'innerHeight', { value: layout, configurable: true, writable: true });

  const listeners = { resize: [], scroll: [] };
  const vv = {
    height: layout, width: 390, offsetTop: 0, scale: 1, pageTop: 0,
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
    removeEventListener: (t, f) => { listeners[t] = (listeners[t] || []).filter((x) => x !== f); },
  };
  window.visualViewport = vv;

  class FakeWS {
    constructor() { this.readyState = 1; FakeWS.inst = this; setTimeout(() => this.onopen && this.onopen(), 0); }
    send() {} close() {}
  }
  FakeWS.OPEN = 1;
  window.WebSocket = FakeWS;
  window.eval(appjs);
  if (!FakeWS.inst) window.document.dispatchEvent(new window.Event('DOMContentLoaded'));

  const setKeyboard = (openPx) => {
    vv.height = layout - openPx;
    listeners.resize.forEach((f) => f());
  };
  const appH = () => window.document.documentElement.style.getPropertyValue('--app-h');
  return { window, setKeyboard, appH };
}

/* ---------------- behaviour ---------------- */
const b = boot({ layout: 844 });

ok('no keyboard: --app-h not set (100dvh fallback applies)',
   b.appH() === '', `--app-h="${b.appH()}"`);

b.setKeyboard(300); // keyboard takes 300px
ok('keyboard open (300px): --app-h pins #app to the visual height',
   b.appH() === '544px', `--app-h="${b.appH()}"`);

b.setKeyboard(420);
ok('keyboard taller (420px): --app-h follows the visual height',
   b.appH() === '424px', `--app-h="${b.appH()}"`);

/* hysteresis: a tiny shrink (URL-bar collapse, not a keyboard) must NOT trigger */
const c = boot({ layout: 844 });
c.setKeyboard(40);
ok('small shrink (40px) is ignored — no false keyboard trigger',
   c.appH() === '', `--app-h="${c.appH()}"`);

/* close again -> revert */
b.setKeyboard(0);
ok('keyboard closed: --app-h cleared (app returns to full height)',
   b.appH() === '', `--app-h="${b.appH()}"`);

/* ---------------- static wiring ---------------- */
ok('CSS: #app height uses var(--app-h, 100dvh)',
   /#app\s*\{[^}]*height:\s*var\(--app-h,\s*100dvh\)/s.test(css));
ok('CSS: 100dvh remains the documented fallback', css.includes('var(--app-h, 100dvh)'));
ok('app.js defines initViewport()', /function initViewport\s*\(/.test(appjs));
ok('app.js calls initViewport() during init', /initViewport\(\)\s*;/.test(appjs));
ok('app.js subscribes to visualViewport resize',
   /visualViewport[\s\S]{0,900}addEventListener\(\s*["']resize["']/.test(appjs));
ok('index.html: viewport meta is interactive-widget=resizes-content',
   /name="viewport"[^>]*interactive-widget=resizes-content/.test(html));

const passed = results.filter(Boolean).length;
console.log(`\n=== ${passed}/${results.length} passed ===`);
process.exit(passed === results.length ? 0 : 1);
