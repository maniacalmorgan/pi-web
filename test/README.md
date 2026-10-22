# pi-web tests

Run from the project root. `npm test` runs 16 offline suites via `run-all.mjs` (no browser, no
server, no model backend); `npm run test:serve` adds the live network-posture suite. `jsdom` is a dev dependency used only by the renderer tests — `npm install`
puts it there.

| Script | What it checks | Needs the server running? |
|---|---|---|
| `dom_test_dup.mjs` | Renderer, via jsdom replaying a **captured real event sequence**: no duplicate messages/tool blocks, ctx pill, 28-command dropdown, 24h timestamps + device timezone, rail kebab menu (open/close, offers Rename+Delete, does NOT fire `switch_session`, row click still does). | no |
| `test_touch_kebab.mjs` | CSS: `.s-kebab` hidden by default, revealed on pointer hover, **forced visible under `@media (hover: none)`**, braces balanced. | no |
| `rail_acceptance.mjs` | **Live** server: rename persists to disk + appears in the server's listing; delete removes the file; deleting the **active** session leaves pi answering; path-traversal (`/etc/passwd`, `../..`, non-`.jsonl`) rejected with nothing deleted. Run `setup_rail_test.sh` first; `--cleanup` afterwards. | yes |
| `test_native_mappings.mjs` | **Self-contained live** (2026-09-24: re-targeted off the live `:4321` after it compacted the live session mid-turn): scratch `:4399` via the `pi-nosession` wrapper, a short priming turn, then each native slash command reaches its RPC equivalent (`/compact`, `/session`, `/copy`, `/fork`, `/model`, `/thinking`). Fails fast if `:4399` is already in use. | no* |
| `test_busy_guard.mjs` | **Self-contained live**: scratch `:4399` + a real turn engineered with a 6 s bash tool call — `compact`/`fork` sent during `agent_start..agent_settled` are **refused** with the "pi is mid-turn" guard error, the server logs both transitions, and `compact` after `agent_settled` reaches pi unblocked (guards the 2026-09-24 mid-turn compact incident). Requires `:4399` free. | no* |
| `test_switch_session.mjs` | **Self-contained live**: spawns a throwaway server on `:4399` (never your live `:4321`) via the `pi-nosession` wrapper, then asserts rail switching end-to-end — `switch_session{sessionPath}` succeeds *and pi moves to that file*, the active-row highlight key resolves, and the old `{sessionId}` call still fails with the `startsWith` error (proves the fix is load-bearing). Requires `:4399` free. | no* |
| `test_layout_tweaks.mjs` | Renderer (jsdom, real `index.html` + real `app.js`) + CSS: ctx counter and model button live in `#composer-bar` **under** the composer (not the topbar); `#model-pop` is anchored to `.model-anchor` and opens **upward**; desktop ☰ toggles `#app.rail-collapsed` and **persists** to `localStorage`; startup restores it; the ≤860px drawer path is unchanged; the collapsed grid is a **single `1fr` column** (the `0 1fr` regression is asserted against); CSS braces balance. | no |
| `test_thinking.mjs` | Renderer (jsdom): thinking blocks are **expanded while streaming**, show a live **`mm:ss` timer** (with the full timestamp kept in `title`), carry a **flavour label from the pool**, **auto-collapse** at `message_end`, and **re-expand on click**; the keep-open 🧠 toggle persists to `localStorage` and, when on, a finished step stays expanded. | no |
| `verify_thinking_live.mjs` | **Self-contained live**: scratch server on `:4399` + a real `pi` turn (`--no-session` wrapper) — proves real pi output still emits `thinking_start` / `thinking_delta` / `message_end` (what the timer, labels and auto-collapse key off) and that the served bundle carries the features. Slow (~70-90s). Requires `:4399` free. | no* |
| `test_title_sync.mjs` | Renderer (jsdom): the topbar session title never shows the raw random session id, and agrees with the rail — pi `sessionName` → rail name → rail preview → `—`; live rename/switch retitles it. | no |
| `test_rail_autorefresh.mjs` | **Self-contained live**: scratch `:4399` + a real session file created/modified/deleted on disk — the server pushes an updated session list **unprompted** for each change, and pushes **none** during a 6 s idle window (change-driven, not a spam loop). Requires `:4399` free. | no* |
| `test_pi_contract.mjs` | **Contract check — run before/after ANY pi upgrade.** Three layers: (1) static — every RPC command our server whitelists still exists in pi's `docs/rpc.md`, and `switch_session` is still documented with `sessionPath`; (2) live RPC (scratch `--session-dir`) — round-trips, `switch_session{sessionPath}` works while `{sessionId}` fails, and a real turn emits `message_end` / `agent_settled` / `thinking_*` / `text_delta`; (3) session format — a real session file parsed by the server's own `summarizeSession()`. `--fast` = layers 1+3 only. | no* |
| `test_ctx_pill.mjs` | Renderer (jsdom): the "used" figure comes from `contextUsage.tokens` and **never** the cumulative `tokens.total`; session ops (`switch`/`new`/`fork`/`clone`) refetch stats and **clear first** (no cross-session bleed); `message_end` and `tool_execution_end` each refetch; `refreshStats` is **coalesced** (one in flight, one queued); the pill renders session in/out as `↑in ↓out`. | no |
| `test_model_picker.mjs` | Renderer (jsdom): clicking an available model sends `set_model` **with `provider`** (a bare `modelId` is rejected by pi as `Model not found: undefined/<id>`); models named `... (not loaded)` render with the `unloaded` class, `aria-disabled`, and **no click handler** (not selectable by design); the model button names the **active** model, not the first catalog entry, and a **real-shaped** `set_model` response (the Model object IS `data` — no `model` key) moves the `active` marker onto the chosen row; the `.model-item.unloaded` CSS greys them out; the **refresh-model-list** affordance exists (`#refresh-models` + the `.model-refresh` row) and clicking it asks the server to restart pi. Also covers the typed `/model <arg>` path. | no |
| `test_refresh_models.mjs` | Renderer (jsdom): the **refresh model list** flow. pi's catalogue is a **frozen in-memory snapshot** in `--mode rpc` (no refresh RPC exists), so picking up a model loaded in LM Studio after pi started requires respawning pi. Asserts the client state machine: refresh sends `restart_pi`, the restart's own `hello`/`pi_status` frames **do not** re-run `boot()` (which would clobber the pending restore), the fresh catalogue then triggers **re-opening the same `sessionPath`** and **`set_model` with provider + the loaded id** (a session load re-stamps that session's creation-time model), the button un-busies and state is re-read, and a refresh **mid-turn is refused**. Covers the client only — it does **not** restart a live pi. | no |
| `test_slash_and_fork.mjs` | Renderer (jsdom): a typed **native** command (`/new`, `/compact`, `/session`, `/clone`, `/copy`, `/export`, `/model x`) reaches its **RPC equivalent and is never sent to the model as text** (pi's built-ins are TUI-only); `/model` with no arg opens the picker; a TUI-only command with args shows the honest toast; **extension/skill commands and ordinary prose still go through `prompt`**; a bare TUI-only command prefills its arg hint. Plus `/fork`: `get_fork_messages` populates the popover, clicking an entry sends `fork` with that `entryId`, an empty list says so, and the old dev placeholder toast is gone. | no |
| `test_ctx_window_sync.mjs` | Renderer (jsdom): the ctx pill shows the **active model's** context window, not a lagging `stats.contextUsage.contextWindow` (the 262k-vs-120k bug); `set_model` updates the window and re-renders immediately **and** refreshes stats; the **percentage is derived from the pair the pill displays** (never a stored percent computed against a different window); a session switch with no stats yet shows `ctx —` rather than a stale number; stats still supply a window when the model has none. | no |
| `test_ctx_pill_live.mjs` | **Self-contained live**: scratch `:4399` via the `pi-scratchsession` wrapper (a real session in a scratch dir, so `contextUsage` exists but the rail is untouched) — a real prompt, polling `get_session_stats` during the turn, asserts ≥2 responses arrive and `contextUsage.tokens` **moves**. | no* |
| `test_lull.mjs` | Renderer (jsdom, real timers): the "lull" π indicator — nothing while idle; **shows** after the 1200 ms threshold once a prompt is sent (covers the send→`agent_start` gap); **hides** the instant any activity arrives (thinking delta / tool end); re-shows after another quiet stretch; hidden and stays hidden after `agent_settled`; re-appears after a send that follows a history reload (the node is re-appended because `renderHistory()` clears `#chat`). CSS: bounce keyframes, `.lull-pi` animation, and the `prefers-reduced-motion` override. | no |
| `test_server_bind.mjs` | **Live network posture** (own ports 4391-4397, stub `pi`, no model): binds `localhost`/`lan`/`all`, the startup log tells the truth about which addresses are *not* bound, a public bind without a token exits with the reason, `/healthz` + static + WS are all behind the token, and a cross-origin WebSocket or POST is refused while same-origin and Origin-less clients work. Run with `npm run test:serve`. | no |
| `test_host_resolution.mjs` | **Pure** (fake interface maps): `auto` never selects a public address; `lan` refuses rather than degrading to one; `tailscale` fails loudly when Tailscale is down; `all` is the only wide bind; CGNAT/RFC1918 boundary cases; and the origin policy that blocks cross-site WebSocket hijacking. | no |
| `e2e_piweb_2.mjs` | **Live** server: 12 infra checks — static assets, `/healthz`, WS `hello`, `pi_status`, and `get_state` / `get_available_models` / `get_messages` round-trips. | yes |
| `e2e_piweb_3_stream.mjs` | **Live** end-to-end: a real prompt traverses browser-protocol → WS → server → `pi --mode rpc` → your model backend and returns the sentinel string, with streamed text + thinking deltas. Slow (~60-90s, long prefill). | yes |
| `diag_dup.mjs`, `diag_cmds.mjs` | Diagnostic captures of the live event flow (what the dedup/command fixes were built from). Keep for future debugging. | yes |

`npm test` runs and verifies these **16 offline suites — 318 assertions**:

| suite | assertions |
|---|---|
| `dom_test_dup.mjs` | 32/32 |
| `test_layout_tweaks.mjs` | 48/48 |
| `test_thinking.mjs` | 21/21 |
| `test_lull.mjs` | 20/20 |
| `test_ctx_pill.mjs` | 11/11 |
| `test_ctx_window_sync.mjs` | 7/7 |
| `test_title_sync.mjs` | 11/11 |
| `test_model_picker.mjs` | 41/41 |
| `test_refresh_models.mjs` | 12/12 |
| `test_slash_and_fork.mjs` | 22/22 |
| `test_touch_kebab.mjs` | 5/5 |
| `test_viewport_keyboard.mjs` | 11/11 |
| `test_clipboard_copy.mjs` | 12/12 |
| `test_session_summary.mjs` | 9/9 |
| `test_push.mjs` | 20/20 |
| `test_host_resolution.mjs` | 36/36 |

The live suites print their own totals; their counts depend on the model backend and are not part of
`npm test`.

> **⚠️ Model-backend dependency:** every `*` (live) test that runs a real turn needs the model
> backend reachable (LM Studio, Ollama, or whatever provider pi is configured against) with a model
> loaded, and needs `pi` on `PATH`. A run that returns "Request timed out" with **no file changes**
> is usually the backend being down, not pi.

**Convention:** these are the project's durable tests — the ad-hoc probes originally lived in a
scratch dir that is pruned after 72h, so they were relocated here. Any new pi probe must pass
`pi --no-session` so it does not litter the session rail (see the `pi-orchestrator` skill).

**Shared lull pool:** `test/pool.mjs` extracts `THINK_LABELS` straight from `public/app.js` (the
browser bundle, not importable) at load time and exports `THINK_LABELS` + `POOL_SIZE`. Tests assert
against **that**, never a hand-copy — so editing the pool in `public/app.js` alone keeps every test
in sync, and the bag assertions are `POOL_SIZE`-derived (no hardcoded counts). The regex failing to
match throws at import rather than yielding an empty pool that would pass vacuously.

**Live-test safety (2026-09-24):** self-contained live tests spawn their own throwaway server
on `:4399` (never your live `:4321`) and **fail fast** if `:4399` already answers — a lingering
scratch server answers healthz with stale code and would lie to every assertion.

**Measure what the USER sees, not what the wire carried (2026-09-28).** A UI command that opens a
popover, focuses a control, or updates a pill sends **no RPC** and is working perfectly. Auditing the
command dropdown by "did an RPC go out?" reported 18 false failures; re-measuring against visible
state (popovers, rail, pill text, toasts) showed all of them correct. Assert the outcome a user would
notice — and when a command legitimately sends nothing, check *why* (a coalescing guard and an
open-a-picker branch both look like silence).

**Two jsdom/eval traps that keep recurring in this suite:**
- `public/app.js` runs under `'use strict'`, so `window.eval(appjs)` does **not** put its top-level
  `function` declarations on `window`. Tests must drive the **real DOM path** (set `#composer-input`,
  dispatch `keydown`) rather than calling internals — and production code must not carry a
  `window.*` export just to make a test reachable.
- The inline ▾ autocomplete consumes the **first** Enter to complete a command name; a typed command
  is only sent on the **second**. Any test that types a command into the composer must account for it.
