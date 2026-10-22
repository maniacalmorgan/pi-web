const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
// Verify the touch fix actually applies: parse style.css and confirm the
// @media (hover: none) block exists and targets .s-kebab. Also confirm the
// hover rule still hides it under a pointer device.
import fs from 'node:fs';

const css = fs.readFileSync(`${ROOT}/public/style.css`, 'utf8');

const results = [];
const ok = (n, p, d) => { results.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`); };

// 1. base rule hides the kebab
ok('base .s-kebab is opacity:0 (hidden by default)',
  /\.s-kebab\s*\{[^}]*opacity:\s*0/.test(css), '');

// 2. pointer devices reveal on hover
ok('hover reveals kebab under a pointer device',
  /\.session-item:hover\s+\.s-kebab[\s\S]{0,80}?opacity:\s*1/.test(css), '');

// 3. the touch override exists
const m = css.match(/@media\s*\(hover:\s*none\)\s*\{([\s\S]*?)\n\}/);
ok('@media (hover: none) block present', !!m, m ? '' : 'NOT FOUND — mobile unreachable');

// 4. and it forces the kebab visible
ok('touch override forces .s-kebab opacity:1',
  !!m && /\.s-kebab\s*\{[^}]*opacity:\s*1/.test(m[1]), m ? m[1].trim().replace(/\s+/g, ' ') : '');

// 5. sanity: brace balance in the file (a broken @media would wreck the rest)
let depth = 0, min = 0;
for (const ch of css) { if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth < min) min = depth; } }
ok('CSS braces balanced', depth === 0 && min === 0, `final depth=${depth} min=${min}`);

const passed = results.filter(Boolean).length;
console.log(`\n=== ${passed}/${results.length} passed ===`);
process.exit(passed === results.length ? 0 : 1);
