/**
 * Run every offline suite (no browser, no server, no model backend needed).
 *
 * Renderer suites drive the real public/index.html + public/app.js in jsdom; the push suite
 * exercises push.mjs directly. Live suites (server + real pi + a model) are listed in
 * test/README.md and are deliberately not run here.
 *
 * Usage: npm test        (exit code 1 if any suite fails)
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

const SUITES = [
  "dom_test_dup.mjs",          // rendering, duplicate suppression, commands, timestamps
  "test_layout_tweaks.mjs",    // composer bar, model popover, collapsible rail
  "test_thinking.mjs",         // thinking blocks, live timer, auto-collapse
  "test_lull.mjs",             // the bouncing π lull indicator
  "test_ctx_pill.mjs",         // context pill: source of truth, coalescing, in/out
  "test_ctx_window_sync.mjs",  // ctx window follows the active model
  "test_title_sync.mjs",       // topbar title vs rail name/preview
  "test_model_picker.mjs",     // two-pane model flyout, unloaded models, set_model shape
  "test_refresh_models.mjs",   // refresh-model-list state machine
  "test_slash_and_fork.mjs",   // native slash commands -> RPC, /fork popover
  "test_touch_kebab.mjs",      // hover affordances reachable on touch
  "test_viewport_keyboard.mjs",// mobile keyboard vs the composer bar
  "test_clipboard_copy.mjs",   // clipboard on insecure origins
  "test_session_summary.mjs",  // the rail's session summariser
  "test_push.mjs",             // VAPID keys, subscriptions, notification payloads
  "test_host_resolution.mjs",  // bind-address rules + WebSocket origin policy (pure, no ports)
];

if (!fs.existsSync(path.join(ROOT, "node_modules", "jsdom"))) {
  console.log("jsdom is not installed — run `npm install` first (it is a devDependency).\n");
}

let failed = 0;
for (const suite of SUITES) {
  const file = path.join(ROOT, "test", suite);
  const r = spawnSync(process.execPath, [file], { cwd: ROOT, encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  const total = [...out.matchAll(/^=== (\d+)\/(\d+) passed ===$/gm)].pop();
  const summary = total ? `${total[1]}/${total[2]}` : out.trim().split("\n").slice(-1)[0] || "(no output)";
  const okRun = r.status === 0;
  if (!okRun) {
    failed++;
    console.log(`FAIL  ${suite}  — ${summary}`);
    console.log(out.split("\n").filter((l) => /^(FAIL|Error|.*Error:)/.test(l)).slice(0, 8).map((l) => "        " + l).join("\n"));
  } else {
    console.log(`ok    ${suite.padEnd(28)} ${summary}`);
  }
}

console.log(failed ? `\n${failed} suite(s) failed` : `\nall ${SUITES.length} suites passed`);
process.exit(failed ? 1 : 0);
