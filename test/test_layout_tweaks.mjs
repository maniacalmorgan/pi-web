/* test_layout_tweaks.mjs — DOM + CSS assertions for the composer-bar / model-pop-up /
 * rail-collapse changes (2026-09-23).
 *
 * Renders the REAL public/index.html and runs the REAL public/app.js in jsdom, then asserts:
 *   - the ctx counter + model button live in a #composer-bar under the composer (not the topbar)
 *   - #model-pop is anchored to that bar and opens UPWARD (CSS)
 *   - the ☰ toggle collapses the desktop rail and persists the state to localStorage
 *   - the ≤860px drawer behaviour is preserved
 * Pure static checks (CSS rules present, braces balanced) round it out.
 *
 * Run: node test/test_layout_tweaks.mjs
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

/* build a jsdom with app.js eval'd, a stubbed WebSocket and matchMedia.
   mobile=true makes matchMedia('(max-width: 860px)') report matches=true. */
function boot({ mobile = false, preStorage = {} } = {}) {
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
  for (const [k, v] of Object.entries(preStorage)) window.localStorage.setItem(k, v);

  window.matchMedia = (q) => ({
    matches: mobile ? /max-width:\s*860px/.test(q) : !/max-width:\s*860px/.test(q),
    media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });

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
  return { window, document: window.document };
}

/* ---------------- DOM structure ---------------- */
const { window: w, document: d } = boot();
const app = d.getElementById('app');
const composerWrap = d.getElementById('composer-wrap');
const composer = d.getElementById('composer');
const ctxPill = d.getElementById('context-pill');
const modelBtn = d.getElementById('model-btn');
const modelPop = d.getElementById('model-pop');
const bar = d.getElementById('composer-bar');
const topbarRight = d.querySelector('.topbar-right');

ok('#composer-bar exists', !!bar);
ok('ctx pill is inside #composer-bar', !!bar && bar.contains(ctxPill));
ok('model button is inside #composer-bar', !!bar && bar.contains(modelBtn));
ok('#composer-bar lives in #composer-wrap (bottom of screen)', !!bar && composerWrap.contains(bar));
ok('ctx pill is NOT in the topbar anymore', !(topbarRight && topbarRight.contains(ctxPill)));
ok('model button is NOT in the topbar anymore', !(topbarRight && topbarRight.contains(modelBtn)));
ok('other topbar controls still in the topbar',
   !!(topbarRight && topbarRight.contains(d.getElementById('status-pill')) && topbarRight.contains(d.getElementById('theme-btn'))));

// bar must come AFTER the composer in document order
const kids = Array.from(composerWrap.children);
ok('#composer-bar is rendered after #composer', kids.indexOf(bar) > kids.indexOf(composer),
   `composer@${kids.indexOf(composer)} bar@${kids.indexOf(bar)}`);

// the model popover must be anchored to the bar so it can open upward, and it
// must NOT live inside the scrollable strip (#composer-scroll) — an overflow
// container would clip the upward-opening menu (this was the 2026-09-24 risk)
const barKids = Array.from(bar ? bar.children : []);
ok('#model-pop is a DIRECT child of #composer-bar (not the strip)',
   !!bar && bar.contains(modelPop) && modelPop.parentElement === bar,
   barKids.map((k) => k.id || k.className).join(','));
ok('#model-pop is NOT inside the scrollable #composer-scroll (unclipped)',
   !!modelPop && !modelPop.closest('#composer-scroll'));
ok('strip holds exactly the ctx pill + model button + think button',
   !!bar.querySelector('#composer-scroll') &&
   bar.querySelector('#composer-scroll').contains(ctxPill) &&
   bar.querySelector('#composer-scroll').contains(modelBtn) &&
   bar.querySelector('#composer-scroll').contains(d.getElementById('think-btn')));
ok('#fork-pop left in place (not moved into the bar)', !(bar && bar.contains(d.getElementById('fork-pop'))));

/* ---------------- rail collapse (desktop) ---------------- */
const w2 = boot().window;
const d2 = w2.document;
const app2 = d2.getElementById('app');
const toggle2 = d2.getElementById('rail-toggle');
const rail2 = d2.getElementById('rail');
const scrim2 = d2.getElementById('rail-scrim');

ok('desktop: rail starts expanded', !app2.classList.contains('rail-collapsed'));
toggle2.dispatchEvent(new w2.MouseEvent('click', { bubbles: true }));
ok('desktop: clicking ☰ collapses the rail (#app.rail-collapsed)', app2.classList.contains('rail-collapsed'));
ok('desktop: collapse persists to localStorage(piweb.railCollapsed=1)',
   w2.localStorage.getItem('piweb.railCollapsed') === '1',
   String(w2.localStorage.getItem('piweb.railCollapsed')));
ok('desktop: collapse does NOT open the mobile drawer', !rail2.classList.contains('open') && scrim2.classList.contains('hidden'));
toggle2.dispatchEvent(new w2.MouseEvent('click', { bubbles: true }));
ok('desktop: clicking ☰ again expands', !app2.classList.contains('rail-collapsed'));
ok('desktop: expand persists (piweb.railCollapsed=0)', w2.localStorage.getItem('piweb.railCollapsed') === '0');

/* startup honours the saved collapsed state */
const w3 = boot({ preStorage: { 'piweb.railCollapsed': '1' } }).window;
ok('startup restores collapsed rail from localStorage',
   w3.document.getElementById('app').classList.contains('rail-collapsed'));

/* ---------------- drawer behaviour preserved on mobile ---------------- */
const w4 = boot({ mobile: true }).window;
const d4 = w4.document;
d4.getElementById('rail-toggle').dispatchEvent(new w4.MouseEvent('click', { bubbles: true }));
ok('mobile: ☰ still opens the drawer (not the collapse class)',
   d4.getElementById('rail').classList.contains('open') && !d4.getElementById('app').classList.contains('rail-collapsed'));
ok('mobile: drawer scrim becomes visible', !d4.getElementById('rail-scrim').classList.contains('hidden'));

/* ---------------- swipeable topbar (2026-09-24) ---------------- */
/* NOTE: jsdom ignores @media rules in getComputedStyle AND has no layout engine
   (scrollWidth is always 0), so this section asserts DOM structure + CSS rule
   TEXT. Real overflow/swipe behaviour is verified by the phone smoke test. */
const topbarScroll = d.getElementById('topbar-scroll');
ok('#topbar-scroll strip exists', !!topbarScroll);
ok('session title is inside the scroll strip', !!topbarScroll && topbarScroll.contains(d.getElementById('session-title')));
ok('topbar-right controls are inside the scroll strip', !!topbarScroll && topbarScroll.contains(topbarRight));
ok('rail toggle is PINNED (not a descendant of #topbar-scroll)',
   !!d.getElementById('rail-toggle') && !d.getElementById('rail-toggle').closest('#topbar-scroll'));
const topbarKids = Array.from(d.getElementById('topbar').children);
ok('topbar order: pinned ☰ first, then the scroll strip',
   topbarKids[0].id === 'rail-toggle' && topbarKids[1].id === 'topbar-scroll',
   topbarKids.map((k) => k.id || k.className).join(','));
ok('thinking/commands/compact still render (not removed from DOM)',
   !!(d.getElementById('thinking-select') && d.getElementById('commands-select') && d.getElementById('compact-btn')));

/* ---------------- CSS rules ---------------- */
ok('#topbar-scroll is the overflow-x:auto strip',
   /#topbar-scroll\s*\{[^}]*overflow-x:\s*auto/.test(css),
   (css.match(/#topbar-scroll\s*\{[^}]*\}/) || [''])[0].replace(/\s+/g, ' '));
ok('#topbar-scroll scrollbar is hidden (webkit + firefox)',
   /#topbar-scroll::-webkit-scrollbar\s*\{[^}]*display:\s*none/.test(css) &&
   /#topbar-scroll\s*\{[^}]*scrollbar-width:\s*none/.test(css));

const mobileBlock = (css.match(/@media\s*\(max-width:\s*860px\)\s*\{([\s\S]*?)\n\}/) || [])[1] || '';
ok('mobile @media (max-width: 860px) block present', !!mobileBlock);
ok('mobile: topbar no longer hides the selects / compact button',
   !!mobileBlock && !/\.topbar-right\s+\.select[^{]*\{[^}]*display:\s*none/.test(mobileBlock) &&
   !/\.icon-btn:not\(#theme-btn\)\s*\{[^}]*display:\s*none/.test(mobileBlock));
ok('mobile: 48px touch-target topbar height', /#topbar\s*\{[^}]*min-height:\s*48px/.test(mobileBlock));
ok('mobile: strip has overscroll-behavior-x: contain (iOS rubber-band)',
   /#topbar-scroll\s*\{[^}]*overscroll-behavior-x:\s*contain/.test(mobileBlock));
ok('mobile: strip edge fade is -webkit-mask-image + mask-image (both prefixed)',
   /#topbar-scroll\s*\{[^}]*-webkit-mask-image:.*mask-image:.*linear-gradient/s.test(mobileBlock));
ok('mobile: title is the fixed-ish chunk that lets the strip overflow (140px / 45vw)',
   /\.session-title\s*\{[^}]*min-width:\s*140px[^}]*max-width:\s*45vw/.test(mobileBlock));
ok('desktop regression guard: 45vw title cap appears exactly once, in the mobile block',
   (css.match(/max-width:\s*45vw/g) || []).length === 1 && /max-width:\s*45vw/.test(mobileBlock));
ok('.composer-bar rule present (no overflow — stays a non-scrolling anchor)',
   /\.composer-bar\s*\{[^}]*display:\s*flex/.test(css) &&
   !/\.composer-bar\s*\{[^}]*overflow/.test(css));
ok('#composer-scroll is the overflow-x:auto strip (mirrors #topbar-scroll)',
   /#composer-scroll\s*\{[^}]*overflow-x:\s*auto/.test(css) &&
   /#composer-scroll\s*\{[^}]*scrollbar-width:\s*none/.test(css) &&
   /#composer-scroll::-webkit-scrollbar\s*\{[^}]*display:\s*none/.test(css),
   (css.match(/#composer-scroll\s*\{[^}]*\}/) || [''])[0].replace(/\s+/g, ' '));
ok('mobile: #composer-scroll gets overscroll-behavior-x: contain + edge-fade masks (both prefixes)',
   /#composer-scroll\s*\{[^}]*overscroll-behavior-x:\s*contain/.test(mobileBlock) &&
   /#composer-scroll\s*\{[^}]*-webkit-mask-image:.*mask-image:.*linear-gradient/s.test(mobileBlock));
ok('.composer-bar rule present', /\.composer-bar\s*\{[^}]*display:\s*flex/.test(css));
ok('.model-anchor is position:relative (popover anchor)', /\.model-anchor\s*\{[^}]*position:\s*relative/.test(css));
ok('#model-pop opens upward (bottom: calc(100%…))',
   /#model-pop\s*\{[^}]*bottom:\s*calc\(100%/.test(css),
   (css.match(/#model-pop\s*\{[^}]*\}/) || [''])[0].replace(/\s+/g, ' '));
ok('#rail-toggle is no longer display:none',
   !/#rail-toggle\s*\{[^}]*display:\s*none/.test(css));
const mq = css.match(/@media\s*\(min-width:\s*861px\)\s*\{([\s\S]*?)\n\}/);
ok('desktop @media (min-width: 861px) block present', !!mq);
ok('collapsed rail uses a SINGLE full-width column (1fr, not 0 1fr) — #main must not fall into a 0-width column',
   !!mq && /#app\.rail-collapsed\s*\{[^}]*grid-template-columns:\s*1fr\s*(;|})/.test(mq[1]),
   (mq && (mq[1].match(/#app\.rail-collapsed\s*\{[^}]*\}/) || [''])[0].replace(/\s+/g, ' ')) || 'no block');
ok('collapsed rail template is NOT the buggy "0 1fr"',
   !!mq && !/#app\.rail-collapsed\s*\{[^}]*grid-template-columns:\s*0\s+1fr/.test(mq[1]));
ok('collapsed rail hidden rule present', !!mq && /#app\.rail-collapsed\s+#rail\s*\{[^}]*display:\s*none/.test(mq[1]));

let depth = 0, min = 0;
for (const ch of css) { if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth < min) min = depth; } }
ok('CSS braces balanced', depth === 0 && min === 0, `final depth=${depth} min=${min}`);

const passed = results.filter(Boolean).length;
console.log(`\n=== ${passed}/${results.length} passed ===`);
process.exit(passed === results.length ? 0 : 1);
