// pool.mjs — single source of truth for the lull phrase pool in test assertions.
//
// The phrases live in production as `THINK_LABELS` inside `public/app.js`, which is a
// browser bundle, not a module — so tests cannot `import` it. Rather than hand-copying
// the list into every test (which drifts silently the moment the pool changes), this
// module reads it straight out of the real file at load time. Edit the pool in ONE
// place (public/app.js) and every test follows automatically.
//
// If the regex ever fails to match, the import throws — a loud failure, not a silent
// empty pool that would make "phrase ∈ pool" assertions vacuously true.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP_JS = path.join(HERE, '..', 'public', 'app.js');

export function readThinkLabels(appJsPath = APP_JS) {
  const src = fs.readFileSync(appJsPath, 'utf8');
  const m = src.match(/THINK_LABELS\s*=\s*\[([\s\S]*?)\]/);
  if (!m) throw new Error(`THINK_LABELS not found in ${path.resolve(appJsPath)}`);
  return [...m[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((x) => x[1]);
}

// The live pool, extracted from public/app.js.
export const THINK_LABELS = readThinkLabels();

// Handy for count-derived assertions (bag windows etc.).
export const POOL_SIZE = THINK_LABELS.length;
