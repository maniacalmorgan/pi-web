/* summarize.mjs — single source of truth for `summarizeSession()` in the tests.
 *
 * The real implementation lives in `server.mjs`, which is a side-effectful server
 * (it binds a port and spawns pi on import), so tests cannot import it. Rather than
 * hand-copy the logic (which drifts silently the moment the server changes), this
 * module extracts the `function summarizeSession(...)` source straight out of
 * server.mjs and evaluates it. Edit the server in ONE place; the tests follow.
 *
 * If the extraction ever fails, the import throws — a loud failure, not a silent
 * zeroed function that would make every assertion vacuously true.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_MJS = path.join(HERE, '..', 'server.mjs');

/** Extract and compile summarizeSession() from server.mjs. */
export function loadSummarizeSession(serverPath = SERVER_MJS) {
  const src = fs.readFileSync(serverPath, 'utf8');
  const start = src.indexOf('function summarizeSession(');
  if (start === -1) throw new Error(`summarizeSession not found in ${serverPath}`);
  // Match to the closing brace at column 0 (the function is top-level).
  const end = src.indexOf('\n}', start);
  if (end === -1) throw new Error(`end of summarizeSession not found in ${serverPath}`);
  const body = src.slice(start, end + 2);
  // summarizeSession() uses path.basename() and JSON/text built-ins — provide the
  // module-level deps it closes over in server.mjs (`path` is the only one).
  // eslint-disable-next-line no-new-func
  return new Function('path', `${body}\nreturn summarizeSession;`)(path);
}

export const summarizeSession = loadSummarizeSession();
