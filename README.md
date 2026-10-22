# pi-web

A browser front-end for the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) (`pi`).

It runs a small Node server next to your `pi` install, keeps one `pi --mode rpc` process alive, and
bridges its JSONL protocol to any browser over a WebSocket. You get the CLI agent's whole session —
streaming replies, thinking blocks, live tool calls, sessions, model switching, slash commands —
in a UI that works on a phone.

```
browser  ──HTTP/WS──▶  server.mjs  ──stdin/stdout JSONL──▶  pi --mode rpc  ──▶  your model
```

- **Two runtime dependencies** — `ws` for the relay and `web-push` for notifications — and no build
  step, no bundler, no CDN: `marked` and `DOMPurify` are vendored in `public/vendor/`, so the UI
  works with no internet access.
- **Binds to Tailscale by default**, falls back to the LAN, and never silently decides for you: it
  prints every address it is reachable on at startup.
- **Mobile-first**: responsive rail, dark/light, swipeable control bars, keyboard-aware composer,
  installable as a PWA, optional Web Push when a reply lands or the agent needs your input.
- **Honest about what is missing**: pi's TUI-only commands (`/tree`, `/settings`, …) have no RPC
  equivalent, so they are listed but say so instead of silently doing nothing.

---

## Requirements

| | |
|---|---|
| Node.js | **22 or newer** (24 LTS recommended) |
| pi | `npm i -g @earendil-works/pi-coding-agent` — developed and tested against **0.86.x** |
| Model backend | anything pi can talk to: LM Studio, Ollama, or a hosted provider |
| Network | Tailscale (recommended), a trusted LAN, or just localhost |

`pi` must be able to run non-interactively: check `pi --version` prints a version, and that a
one-shot `pi -p "hello"` answers. If that fails, fix the model config first — pi-web only relays.

---

## Quick start

```bash
git clone <this repo> pi-web && cd pi-web
npm install
npm start
```

`npm start` prints the address it actually opened, and — because that is easy to misread — the
addresses it is *not* listening on:

```
pi-web listening on http://100.101.102.103:4321 (cwd=/home/you, bind=tailscale)
not bound: 192.168.1.50 (one address per listen — PI_WEB_HOST=all serves them all)
pi-web: access control: NONE (network-level only — do not expose this to the internet)
```

Open that URL from a device that can reach it.

### Choose where it listens

`PI_WEB_HOST` decides the bind address. **One process listens on exactly one address**, so pick the
network you will actually use from:

```bash
npm start                              # auto: Tailscale → private LAN → 127.0.0.1
PI_WEB_HOST=tailscale npm start        # tailnet only; exits with an error if Tailscale is down
PI_WEB_HOST=lan npm start              # a private (RFC1918) address, or an error if there is none
PI_WEB_HOST=localhost npm start        # this machine only
PI_WEB_HOST=all npm start              # 0.0.0.0 — every interface, both networks at once
PI_WEB_HOST=192.168.1.50 npm start      # any explicit address or hostname
```

Rules worth knowing, because they are the difference between "convenient" and "accidentally on the
internet":

- **`auto` never selects a public address.** It takes a Tailscale address if there is one, else a
  private LAN address, else loopback. On a VPS or cloud box it will not put a shell on the internet
  by default.
- **`lan` means RFC1918 only** and fails loudly (naming the addresses it found) rather than
  degrading to a public one.
- **Naming a public address** (`PI_WEB_HOST=203.0.113.9`) is refused unless `PI_WEB_TOKEN` is set, or
  you insist with `PI_WEB_ALLOW_PUBLIC=1`.
- **`all` is an explicit opt-in** and logs a warning. Use it when you want the tailnet *and* the LAN
  at the same time — a Tailscale device can reach the LAN address too, but only while it is on that
  LAN, so most people just leave `auto` on Tailscale.

A Tailscale address is recognised by its range (`100.64.0.0/10`), so this works the same on Linux,
macOS and Windows — no `tailscale0` interface name assumptions.

**Tailscale (recommended).** Install Tailscale on the machine running pi-web and on your phone or
laptop, sign both into the same tailnet, and `npm start`. Nothing is exposed to the internet, and
every device on your tailnet can reach the UI. If you would rather not install Tailscale's client
on the pi-web host, `tailscale serve` in front of a `PI_WEB_HOST=localhost` instance is an equally
good setup — and it gives you HTTPS, which some browser features require (see
[Push notifications and PWA](#push-notifications-and-pwa)).

**Plain LAN.** Nothing extra to install: run with `PI_WEB_HOST=lan` (or `auto` on a host without
Tailscale) and use the LAN URL. This is HTTP-over-your-network: fine on a home network you trust,
not fine on café wifi, and **never** fine on a port-forwarded router.

### Port

`PI_WEB_PORT` (default `4321`).

---

## Access control

By default there is **no authentication**. That is a deliberate, documented choice: the intended
deployment is a private network where the network *is* the perimeter. Understand what you are
trusting: anything that can reach this port can run shell commands as your user, through pi.

If the network is not enough for you, set a shared secret:

```bash
PI_WEB_TOKEN="$(openssl rand -hex 24)" npm start
# then open http://<address>:4321/?token=<the token> once
```

The `?token=` exchange sets an `HttpOnly` cookie and redirects to the clean URL, so the secret
leaves the address bar and history immediately, and the UI's own fetches and WebSocket carry it from
then on. Other accepted forms:

| How | Use |
|---|---|
| Cookie | what the browser gets after the `?token=` exchange |
| `?token=…` on the URL | quickest way to open it on any device |
| `Authorization: Bearer <token>` | scripts, `curl` |
| `X-Pi-Web-Token: <token>` | scripts that dislike `Authorization` |

`/healthz` is gated too (it is cheap, but it names the process state). Unauthorised WebSocket
upgrades are refused with `401` at the HTTP layer, not accepted-then-dropped. Token comparison is
constant-time over SHA-256 digests, so neither the value nor the length leaks through timing.

**Cross-site protection, with or without a token.** A browser will open a WebSocket to any host it
can reach — so without a check, a page on the internet could talk to the pi-web instance on your LAN
and drive the agent. WebSocket upgrades and non-GET requests are therefore required to come from
this origin: a browser sends `Origin`, it must match `Host`, and Origin-less clients (CLI, scripts,
`curl`) are unaffected. If you serve the UI from somewhere else — a reverse proxy on another host,
a separate dashboard — allow-list it:

```bash
PI_WEB_ALLOWED_ORIGINS="https://dash.example" npm start   # comma separated, or "*" to disable the check
```

The auth cookie is `HttpOnly` and `SameSite=Lax`, and deliberately **not** `Secure`, because the
default deployment is plain HTTP on a private network. If you put TLS in front, add `Secure` yourself
(or terminate TLS at a proxy that does), and remember that a cookie set with `Secure` will not work
over the plain-HTTP address at all.

**Put TLS in front if the network is not private.** Either `tailscale serve` (easiest), or any
reverse proxy that terminates HTTPS and proxies `/` and `/ws`:

```nginx
location / { proxy_pass http://127.0.0.1:4321; proxy_http_version 1.1;
             proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; }
```

---

## Configuration

Every option is an environment variable. Nothing is persisted except the push keys in `data/`.

| Variable | Default | What it does |
|---|---|---|
| `PI_WEB_PORT` | `4321` | listen port |
| `PI_WEB_HOST` | `auto` | `auto` \| `tailscale` \| `lan` \| `localhost` \| `all` \| an IP or hostname |
| `PI_WEB_CWD` | `$HOME` | working directory the agent runs in (what it can see and edit) |
| `PI_BIN` | `pi` | path to the pi binary (must be a **path**, not a command line) |
| `PI_SESSIONS_DIR` | `$HOME/.pi/agent/sessions` | where pi stores sessions, for the left rail |
| `PI_WEB_DATA_DIR` | `./data` | VAPID keys + push subscriptions, created on first run |
| `PI_WEB_TOKEN` | *(unset)* | opt-in shared secret (see above) |
| `PI_WEB_ALLOWED_ORIGINS` | *(unset)* | extra origins allowed to open a WebSocket; comma separated or `*` |
| `PI_WEB_ALLOW_PUBLIC` | *(unset)* | `1` permits binding a public address with no token (dangerous) |
| `PI_WEB_VAPID_SUBJECT` | `mailto:pi-web@localhost` | VAPID contact; some push services reject the placeholder |

Copy `.env.example` to `.env` if you prefer a file, but note that the server does **not** read
`.env` itself — use your init system, a shell wrapper, or `node --env-file=.env server.mjs`.

---

## Running it as a service

A systemd **user** unit template is in [`contrib/pi-web.service`](contrib/pi-web.service):

```bash
mkdir -p ~/.config/systemd/user
cp contrib/pi-web.service ~/.config/systemd/user/
systemctl --user edit --full pi-web.service   # set WorkingDirectory/ExecStart to your checkout
systemctl --user enable --now pi-web.service
loginctl enable-linger "$USER"                # keep it running after logout / at boot
journalctl --user -u pi-web -f
```

Two things worth knowing, both learned the hard way:

- **Tailscale at boot.** A `PI_WEB_HOST=tailscale` start can race `tailscaled`: the interface exists
  a moment before it has an address. Use `contrib/wait-for-tailscale.sh` as `ExecStartPre`, or pin
  the address in `PI_WEB_HOST`.
- **Restart after server changes.** `server.mjs` runs the code it booted with. The browser, by
  contrast, is served `no-cache`, so a plain reload picks up changes to `public/*` with no restart.

On macOS use a `launchd` agent with the same environment; on Windows, `nssm` or a scheduled task.

---

## Using it

- **Sessions** — left rail. New (＋), switch, rename, delete (`⋯` on a row). A session is pi's own
  `.jsonl` file, so anything you have in the TUI shows up here.
- **Streaming** — text, thinking, and tool calls stream live. Tool output streams inside its block;
  thinking blocks show a live timer and collapse when they finish (the 🧠 toggle keeps them open).
- **Composer** — Enter sends, Shift+Enter newline. Attach images (sent as pi's native `images`
  field) or text files (inlined into the prompt as context). Sending mid-turn queues the message.
- **Slash commands** — try `/`. The dropdown lists 24 **native pi commands** and then whatever your
  extensions, skills and prompt templates provide. Native commands are mapped onto their RPC
  equivalents; extension/skill/template commands go through the prompt as pi expects. A handful of
  natives (`/tree`, `/scoped-models`, `/settings`, `/hotkeys`, …) are **TUI-only** — pi documents
  that they "would not execute if sent via prompt" — so they show an honest notice instead.
- **Model** — the two-pane model picker shows whatever providers pi reports, grouped by provider.
  Models marked `(not loaded)` are visible but not selectable on purpose: loading one on demand
  typically bypasses the per-model parameters (context length and friends) you configured in the
  backend. pi's catalogue is a snapshot for the life of the process, so `⟳ refresh model list`
  restarts the *pi child only* (your server, socket and sessions are untouched) to re-read it.
- **Context pill** — `3.2k / 180k · 1.8% · ↑12k ↓4.5k`, from pi's own `get_session_stats`, using the
  active model's window so a model switch cannot leave a stale denominator behind.
- **Timestamps** — 24-hour, in the **client device's** timezone; nothing to configure.
- **Theme** — ☾ / ☀, remembered per browser.

### Push notifications and PWA

`🔔` registers the browser for Web Push: you get a notification when a turn settles and when pi
blocks waiting for your input (a select/confirm/input dialog).

Browsers only allow service workers and Push on a **secure context** — HTTPS, or `localhost`. Plain
`http://` on a tailnet or LAN address is *not* one, so on those URLs the notification button will
not be able to subscribe. Two good options:

1. `tailscale serve --bg 4321` — gives you `https://<machine>.<tailnet>.ts.net` with a real
   certificate, and everything (PWA install, push, clipboard) works.
2. Reverse proxy with TLS in front of `PI_WEB_HOST=localhost`.

The clipboard buttons already degrade gracefully on insecure origins (they fall back to a
`textarea` + `execCommand('copy')` shim) — that one is handled.

---

## Tests

```bash
npm test              # 16 offline suites, 318 assertions, no model and no server needed
npm run test:serve    # live network posture: bind modes, token gate, origin policy (binds 4391-4397)
```

Renderer suites run the **real** `public/index.html` + `public/app.js` in jsdom and replay captured
event sequences — no browser, no server. `test_host_resolution.mjs` checks the bind rules and the
WebSocket origin policy against fake interface maps, and `test_server_bind.mjs` proves the same
things on real sockets with a stub `pi` (no model, no session files). `test/README.md` lists every script, what it covers, and
which ones need a live server, a real model backend, or `pi` on `PATH`.

The one worth knowing about before you upgrade pi:

```bash
node test/test_pi_contract.mjs          # full: static docs surface + live RPC + session format
node test/test_pi_contract.mjs --fast   # static + session format only, no model turns
```

It checks that every RPC command this server whitelists still exists in pi's own `docs/rpc.md`,
that `switch_session` still takes `sessionPath`, and that a real turn still emits the events the UI
keys off. Run it before and after `npm i -g @earendil-works/pi-coding-agent`. Live probes use
`--no-session` / a scratch session dir so they never litter your session rail.

---

## How it works

| File | Role |
|---|---|
| `server.mjs` | HTTP + static files, the `/ws` relay, pi child-process lifecycle, session listing, push triggers, optional token auth |
| `push.mjs` | VAPID key management, subscription store, notification payloads, delivery |
| `public/app.js` | the whole client: RPC, rendering, session rail, model picker, slash commands, attachments, dialogs, reconnect |
| `public/style.css` | dark + light themes, responsive layout, mobile drawer and keyboard handling |
| `public/vendor/` | `marked` + `DOMPurify`, vendored so the UI works with no internet access |

Design notes that are load-bearing if you plan to change things:

- **Readiness is the child's `spawn` event, not its first line of output.** `pi --mode rpc` prints
  nothing until it is sent a command, so gating on output deadlocks against a client that waits for
  "running".
- **The stdout reader splits on `\n` only.** Node's `readline` also splits on U+2028/2029, which
  corrupts JSONL.
- **One logical message arrives over several channels.** A user turn is emitted as both
  `message_start` and `message_end`; a tool result arrives as `tool_execution_end` *and* as a
  replayed `toolResult` message. The client keys tool blocks by `data-tool-id` and renders user
  messages only on `message_start`, otherwise everything triples.
- **Session-list refresh is fingerprint-driven** (mtime+size, 3 s poll), so the rail updates on its
  own but the server stays silent when nothing changed.
- **The browser may send only whitelisted RPC commands** (`ALLOWED_COMMANDS` in `server.mjs`);
  `compact`/`fork`/`clone` are additionally refused mid-turn, because they would split the
  in-flight turn.
- **Session rename/delete take a path, not an id**, and the path is validated to be a real `.jsonl`
  inside the sessions directory — this endpoint is reachable by anything on your network.

`GET /healthz` → `{"ok":true,"pi":"running"}` is the readiness probe.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `pi spawn error: ENOENT` | `pi` is not on the server's `PATH` — set `PI_BIN=/full/path/to/pi` |
| `pi is not running (state=exited)` in the UI | pi died; check the journal. `⟳ refresh model list` respawns the child |
| Bound to `127.0.0.1` when you expected the tailnet | Tailscale was not up when the server started (with `PI_WEB_HOST=auto` that is a silent fallback, so use `tailscale` explicitly plus `contrib/wait-for-tailscale.sh`) |
| `refusing to bind the public address … without authentication` | working as intended: `auto` never picks a public address, and an explicit one needs `PI_WEB_TOKEN` |
| A LAN device can't reach a Tailscale-bound instance | it is bound to the tailnet address only — use `PI_WEB_HOST=all`, or reach it over Tailscale |
| Notifications never arrive | Push needs HTTPS: use `tailscale serve`, or set `PI_WEB_VAPID_SUBJECT` to a real address if your push service rejects the placeholder |
| `EADDRINUSE` | another instance on that port; change `PI_WEB_PORT` |
| Rail is empty | `PI_SESSIONS_DIR` points somewhere pi does not write |
| Model list is stale after loading a model | expected: pi's catalogue is a snapshot in RPC mode — `⟳ refresh model list` |
| Nothing streams and pi logs timeouts | the model backend, not pi-web: verify the backend answers, then retry |

---

## License

MIT — see [LICENSE](LICENSE).
