/* ==========================================================================
   pi web — client
   Bridges the browser to `pi --mode rpc` through the server's /ws relay.

   Wire protocol (from server.mjs):
     -> {kind:"rpc", data:<pi command>}      send an RPC command to pi
     -> {kind:"get_sessions"}                ask for a session-list refresh
     -> {kind:"restart_pi"}                  ask the server to respawn pi
     <- {kind:"hello",      state, cwd, ...}
     <- {kind:"sessions",   sessions:[...]}
     <- {kind:"pi_status",  state, ...}
     <- {kind:"rpc",        data:<response | event | extension_ui_request>}
     <- {kind:"error",      error}

   pi events consumed here:
     agent_start / agent_end / agent_settled / turn_start / turn_end
     message_start / message_update (text|thinking|toolcall deltas) / message_end
     tool_execution_start / _update / _end
     queue_update / compaction_start / compaction_end / extension_error
   ========================================================================== */

'use strict';

/* ---------------------------------------------------------------- dom --- */
const $ = (id) => document.getElementById(id);

const el = {
  rail:        $('rail'),
  railToggle:  $('rail-toggle'),
  railScrim:   $('rail-scrim'),
  newChat:     $('new-chat'),
  sessionList: $('session-list'),
  cwdLabel:    $('cwd-label'),

  sessionTitle: $('session-title'),
  sessionName:  $('session-name'),
  statusPill:   $('status-pill'),
  contextPill:  $('context-pill'),
  thinkingSel:  $('thinking-select'),
  commandsSel:  $('commands-select'),
  modelBtn:     $('model-btn'),
  compactBtn:   $('compact-btn'),
  themeBtn:     $('theme-btn'),
  thinkBtn:     $('think-btn'),

  modelPop:  $('model-pop'),
  modelList: $('model-list'),
  refreshModels: $('refresh-models'),
  notifBtn:     $('notif-btn'),
  forkPop:   $('fork-pop'),
  forkList:  $('fork-list'),

  chat:     $('chat'),
  dialogs:  $('dialogs'),
  queueBar: $('queue-bar'),
  toasts:   $('toasts'),

  attachPreview: $('attach-preview'),
  slashPop:      $('slash-pop'),
  composer:      $('composer'),
  attachBtn:     $('attach-btn'),
  input:         $('composer-input'),
  sendBtn:       $('send-btn'),
  stopBtn:       $('stop-btn'),
  fileInput:     $('file-input'),
};

/* ------------------------------------------------------------- state --- */
const S = {
  ws: null,
  connected: false,
  piState: 'starting',
  streaming: false,
  compacting: false,
  toolRunning: false, // a tool block is actively executing — lull π must stay hidden
  sessions: [],
  activeSessionId: null,
  activeSessionFile: null,
  activeSessionName: null,
  models: [],
  activeModelId: null,
  /* context accounting — from get_session_stats (pi's own numbers).
     contextUsage.tokens = CURRENT context usage; tokens.* = session-CUMULATIVE in/out.
     message_update.usage is NOT used (verified all-zeros during streaming). */
  contextWindow: null,
  contextUsage: null,   // { tokens, contextWindow, percent }
  tokens: null,         // { input, output, cacheRead, cacheWrite } — session cumulative
  statsPending: false,  // a get_session_stats request is in flight
  statsQueued: false,   // a follow-up was requested while one was in flight
  msgCount: 0,          // from get_state.messageCount
  commands: [],
  slashIndex: -1,
  slashMatches: [],
  attachments: [],
  /* streaming scratch */
  stream: null,   // { wrap, body, rawText, thinkingEl, thinkingRaw, cursor }  (text/thinking only)
  tools: new Map(), // toolCallId -> { name, el, status }   (decoupled from the stream:
                    //   a tool can render when no assistant text shell exists)
  curThinking: null,   // standalone thinking block for the current turn
  pendingAssistant: null,
  retry: 0,
  keepThinkingOpen: false,
  /* Refresh-models flow: pi's catalogue is frozen for the life of the process in
     `--mode rpc` (no refresh RPC exists), so the only way to see a newly loaded
     LM Studio model is to respawn pi. We do that surgically and re-open the same
     session, so the browser + server + session files are never disturbed. */
  refreshingModels: false,
  /* model dropdown: which provider's models are open, and whether the
     phone view has drilled into that provider's pane (desktop shows both panes). */
  modelProvider: null,
  modelDrilled: false,
};

/* ------------------------------------------------------------- utils --- */
function mk(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function esc(s) {
  return String(s == null ? '' : s);
}

/* Models whose catalog name carries the "(not loaded)" suffix are present in the
   provider but not resident in memory. Selecting one would make the backend load it
   on demand, which bypasses that model's custom parameters (context length etc.), so
   they are shown for discoverability but are not selectable. This is how any provider
   extension that reports a not-loaded model should mark it. */
function modelIsUnloaded(m) {
  return typeof m.name === 'string' && m.name.endsWith('(not loaded)');
}

/* Copy text to the clipboard, reporting an HONEST outcome via `onResult(ok)`.
   navigator.clipboard is undefined on any non-secure origin (plain http:// that
   isn't localhost) — which is every normal pi-web deployment, since it is served over
   plain http on a tailnet/LAN address — so a bare `navigator.clipboard?.writeText(...)`
   silently no-op'd: /copy and the per-message ⧉ button did nothing with no warning.
   Fall back to a hidden-textarea +
   document.execCommand('copy') shim, which works on insecure origins. */
function copyText(text, onResult) {
  text = String(text == null ? '' : text);
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(
      () => onResult && onResult(true),
      () => onResult && onResult(false),
    );
    return;
  }
  let ok = false;
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ok = document.execCommand('copy');
    document.body.removeChild(ta);
  } catch { ok = false; }
  if (onResult) onResult(ok);
}

/** Render markdown safely: marked -> DOMPurify. */
function md(text) {
  const src = esc(text);
  if (typeof window.marked === 'undefined') {
    const p = mk('pre');
    p.textContent = src;
    return p.outerHTML;
  }
  let html;
  try {
    html = window.marked.parse(src, { gfm: true, breaks: true });
  } catch {
    html = '<pre>' + src.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])) + '</pre>';
  }
  if (typeof window.DOMPurify !== 'undefined') {
    html = window.DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
  }
  return html;
}

/** Plain text from a pi message content field (string | blocks). */
function contentText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text')
      .map((b) => b.text || '')
      .join('');
  }
  return '';
}

function toast(msg, isError) {
  const t = mk('div', 'toast' + (isError ? ' error' : ''), msg);
  el.toasts.appendChild(t);
  setTimeout(() => t.remove(), isError ? 7000 : 4000);
}

function autoscroll(force) {
  const c = el.chat;
  const nearBottom = c.scrollHeight - c.scrollTop - c.clientHeight < 140;
  if (force || nearBottom) c.scrollTop = c.scrollHeight;
}

/* --------------------------------------------------------------- ws --- */
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws`;
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    toast('cannot open websocket: ' + e.message, true);
    return;
  }
  S.ws = ws;

  ws.onopen = () => {
    S.connected = true;
    S.retry = 0;
    setStatus('idle');
  };

  ws.onclose = () => {
    S.connected = false;
    S.streaming = false;
    setComposerSending(false);
    clearQueue();
    disarmLull();
    setStatus('offline');
    const delay = Math.min(1000 * 2 ** S.retry, 15000);
    S.retry++;
    setTimeout(connect, delay);
  };

  ws.onerror = () => { /* onclose handles recovery */ };

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleFrame(msg);
  };
}

function send(obj) {
  if (!S.ws || S.ws.readyState !== WebSocket.OPEN) {
    toast('not connected to server', true);
    return false;
  }
  S.ws.send(JSON.stringify(obj));
  return true;
}

/** Send an RPC command to pi. */
function rpc(cmd) {
  return send({ kind: 'rpc', data: cmd });
}

function handleFrame(msg) {
  switch (msg.kind) {
    case 'hello':
      if (msg.cwd) {
        el.cwdLabel.textContent = msg.cwd;
        el.cwdLabel.title = msg.cwd;
      }
      /* A `hello` arriving while a refresh is in flight is the respawned pi
         announcing itself. The post-restart flow takes over from here. */
      if (S.refreshingModels) return;
      /* The server sends `hello` with the CURRENT pi state on every connect, but only
         broadcasts `pi_status` on a *transition*. So when pi is already running, no
         pi_status ever arrives — and boot() (which loads commands/models/stats) never
         ran. That left the commands dropdown permanently disabled and the ctx pill
         empty. Boot here when hello says pi is already up. */
      if (msg.state) {
        S.piState = msg.state;
        if (msg.state === 'running') {
          setStatus(S.streaming ? 'streaming' : 'idle');
          boot();
        } else {
          setStatus(msg.state === 'exited' ? 'error' : 'idle');
        }
      }
      break;

    case 'sessions':
      S.sessions = msg.sessions || [];
      renderSessions();
      break;

    case 'pi_status':
      S.piState = msg.state;
      /* During a refresh the restart's own status transitions are expected; the
         post-restart flow waits for 'running' before re-opening the session.
         Kick off get_available_models so the post-restart handler (in that case)
         can restore session + model and clear refreshingModels. */
      if (S.refreshingModels) {
        if (msg.state === 'running') rpc({ type: 'get_available_models' });
        return;
      }
      if (msg.state === 'running') {
        setStatus(S.streaming ? 'streaming' : 'idle');
        boot();
      } else if (msg.state === 'exited') {
        setStatus('error');
        disarmLull();
      }
      break;

    case 'error':
      toast(msg.error || 'server error', true);
      break;

    case 'session_action':
      toast(msg.action === 'delete' ? 'session deleted' : 'session renamed');
      break;

    case 'rpc':
      handleRpc(msg.data);
      break;
  }
}

function boot() {
  rpc({ type: 'get_state' });
  rpc({ type: 'get_available_models' });
  rpc({ type: 'get_available_thinking_levels' });
  rpc({ type: 'get_commands' });
  refreshStats();
  rpc({ type: 'get_messages' });
}

/** Refresh the authoritative context accounting (pi's own numbers).
 *  Coalesced: at most one request in flight, at most one queued follow-up. */
function refreshStats() {
  if (S.statsPending) { S.statsQueued = true; return; }
  S.statsPending = true;
  rpc({ type: 'get_session_stats' });
}

/* ------------------------------------------------------ rpc dispatch --- */
function handleRpc(d) {
  if (!d || typeof d !== 'object') return;

  if (d.type === 'response') return handleResponse(d);
  if (d.type === 'extension_ui_request') return handleExtUi(d);
  return handleEvent(d);
}

function handleResponse(r) {
  const data = r.data;

  if (!r.success && r.command !== 'prompt') {
    toast(`${r.command} failed${r.error ? ': ' + r.error : ''}`, true);
  }

  switch (r.command) {
    case 'get_state': {
      if (!data) break;
      if (data.model) {
        S.activeModelId = data.model.id;
        S.contextWindow = data.model.contextWindow || null;
        el.modelBtn.textContent = data.model.name || data.model.id;
        el.modelBtn.title = data.model.id;
      }
      /* A session load (new_session / switch_session / fork / clone) re-stamps the
         model the session was created with, and a fresh session starts on
         settings.json's defaultModel — so the model reported here is NOT necessarily
         the one the user picked. Re-apply the persisted choice; no-op on boot (the
         catalogue isn't loaded yet) and when the model is already correct. */
      applyPersistedModel();
      if (data.thinkingLevel) el.thinkingSel.value = data.thinkingLevel;
      S.activeSessionId = data.sessionId || null;
      S.activeSessionFile = data.sessionFile || null;
      S.msgCount = typeof data.messageCount === 'number' ? data.messageCount : S.msgCount;
      S.activeSessionName = data.sessionName || null;
      el.sessionName.textContent = activeTitle('—');
      S.streaming = !!data.isStreaming;
      setStatus(S.streaming ? 'streaming' : 'idle');
      /* Reconcile composer/queue from authoritative state: if agent_settled or a
         final queue_update was lost during a WS drop, the stop button and the
         "N queued" bar would otherwise stick until a refresh. */
      setComposerSending(S.streaming);
      if (!data.isStreaming) clearQueue();
      renderContextPill();
      break;
    }

    case 'get_session_stats': {
      S.statsPending = false;
      if (S.statsQueued) { S.statsQueued = false; refreshStats(); }
      if (!data) { renderContextPill(); break; }
      /* authoritative: current context-window usage. NEVER tokens.total (cumulative). */
      S.contextUsage = data.contextUsage || null;
      /* session-cumulative in/out for the ↑↓ display */
      if (data.tokens) {
        S.tokens = {
          input: data.tokens.input || 0,
          output: data.tokens.output || 0,
          cacheRead: data.tokens.cacheRead || 0,
          cacheWrite: data.tokens.cacheWrite || 0,
        };
      }
      if (typeof data.totalMessages === 'number') S.msgCount = data.totalMessages;
      renderContextPill();
      break;
    }

    case 'get_messages': {
      const msgs = (data && data.messages) || [];
      renderHistory(msgs);
      break;
    }

    case 'get_available_models': {
      const models = (data && data.models) || [];
      S.models = models;

      /* Persisted model: the server may report an outdated default from settings.json
         (e.g. the previous model) while the user has already switched to something else.
         Restore the persisted model here — the full catalogue is available. */
      const applied = applyPersistedModel();
      /* Only fall back to the first catalogue entry when nothing is active yet. */
      if (!applied && !S.activeModelId) S.activeModelId = models[0].id;

      renderModelList();
      // The button should name the model that is actually active, not whichever entry
      // the provider happens to list first (an unloaded one, on a live catalog).
      const active = models.find((m) => m.id === S.activeModelId);
      if (active) el.modelBtn.textContent = active.name || active.id;

      /* Post-restart leg of the refresh flow: the catalogue is now fresh. Put the
         session back (the respawn dropped pi onto a new empty one) and re-point the
         model at the loaded one the user asked for — loading a session file
         re-stamps the model that session was created with, which may not be loaded. */
      if (S.refreshingModels) {
        S.refreshingModels = false;
        const want = S.pendingModelId || S.activeModelId;
        const target = S.refreshTargetSession;
        S.refreshTargetSession = null;
        if (target) {
          rpc({ type: 'switch_session', sessionPath: target });
          const restored = models.find((m) => m.id === want && !modelIsUnloaded(m));
          if (restored) rpc({ type: 'set_model', provider: restored.provider, modelId: restored.id });
        }
        S.pendingModelId = null;
        el.refreshModels?.classList.remove('busy');
        if (el.refreshModels) el.refreshModels.textContent = '⟳ refresh';
        rpc({ type: 'get_state' });   // button + ctx pill land on the refreshed state
        toast('model list refreshed');
      }
      break;
    }

    case 'get_available_thinking_levels': {
      const levels = (data && (data.levels || data.thinkingLevels)) || [];
      renderThinkingLevels(levels);
      break;
    }

    case 'get_commands': {
      S.commands = (data && data.commands) || [];
      renderCommandSelect();
      break;
    }

    case 'get_last_assistant_text': {
      const text = (data && data.text) || '';
      if (text) {
        copyText(text, (ok) => toast(ok ? 'last assistant message copied' : 'copy failed — clipboard blocked on http; use HTTPS', !ok));
      } else {
        toast('no assistant message to copy', true);
      }
      break;
    }

    case 'export_html': {
      const p = (data && data.path) || '';
      toast(p ? `session exported to ${p}` : 'session exported');
      break;
    }


    case 'new_session':
    case 'switch_session':
    case 'fork':
    case 'clone': {
      /* server auto-refreshes the rail; reload transcript + context numbers.
         Clear the outgoing session's numbers first so the pill cannot bleed. */
      S.contextUsage = null;
      S.tokens = null;
      S.statsPending = false;
      S.statsQueued = false;
      renderContextPill();
      rpc({ type: 'get_state' });
      rpc({ type: 'get_messages' });
      refreshStats();
      break;
    }

    case 'set_model': {
      /* pi's set_model response carries the Model object AS `data` — there is no
         `model` key (verified live 2026-10-08: data = {id,name,provider,contextWindow,…}).
         Reading only `data.model` meant the switch was applied upstream but never
         reflected here: the button kept the old name, the old row kept its `active`
         marker and the ctx pill kept the old window — i.e. the dropdown "didn't stick"
         until some later get_state. Accept both shapes (nested for back-compat). */
      const m = (data && data.model) || (data && typeof data.id === 'string' ? data : null);
      if (m) {
        S.activeModelId = m.id;
        /* Keep the authoritative window in sync immediately: this is what the ctx pill divides
           against, and stats lag behind a model switch. */
        S.contextWindow = m.contextWindow || null;
        el.modelBtn.textContent = m.name || m.id;
        el.modelBtn.title = m.id;
        renderModelList();
        renderContextPill();
        /* Also pull fresh stats so the pill's window/% reconcile with the new model. */
        refreshStats();
      }
      break;
    }

    case 'set_session_name': {
      if (data && data.name) el.sessionName.textContent = data.name;
      break;
    }

    case 'get_fork_messages': {
      renderForkList(data && data.messages);
      break;
    }
  }
}

/* ------------------------------------------------------ lull indicator --- */
/* A small bouncing π shown in the chat window while pi is working but nothing is
   visibly happening — e.g. loading system context, or a long prefill — so the
   window never looks hung. Hidden the moment any real activity arrives. */
const LULL_MS = 1200;
const LULL_ACTIVITY = new Set([
  'message_start', 'message_update', 'message_end',
  'tool_execution_start', 'tool_execution_update', 'tool_execution_end',
  'turn_start', 'turn_end', 'agent_end',
  'compaction_start', 'compaction_end',
  'auto_retry_start', 'auto_retry_end', 'extension_error',
]);
let lullEl = null;
let lullTimer = null;
let lullArmed = false;   // "a turn is in progress" — armed on send, cleared on settle

function ensureLull() {
  if (!lullEl) {
    lullEl = mk('div', 'lull hidden');
    lullEl.setAttribute('aria-hidden', 'true');
    lullEl.appendChild(mk('span', 'lull-pi', 'π'));
    lullEl.appendChild(mk('span', 'lull-text', ''));   // phrase set on each pop-up (see armLull)
  }
  el.chat.appendChild(lullEl);   // always move to the bottom of #chat; appendChild
  return lullEl;                 // relocates an already-connected node, so the π is
}                                // pinned at the end even after later messages/tools
function hideLull() {
  if (lullTimer) { clearTimeout(lullTimer); lullTimer = null; }
  if (lullEl) lullEl.classList.add('hidden');
}
function armLull() {
  lullArmed = true;
  hideLull();
  lullTimer = setTimeout(() => {
    lullTimer = null;
    if (!lullArmed) return;          // armed == a turn is active (covers the send->agent_start gap)
    if (S.toolRunning) return;       // a tool block is visibly running — π is only for invisible work
    const l = ensureLull();
    l.querySelector('.lull-text').textContent = nextLullPhrase();
    l.classList.remove('hidden');
    autoscroll(true);
  }, LULL_MS);
}
function pokeLull() { if (lullArmed) armLull(); }
function disarmLull() { lullArmed = false; S.toolRunning = false; hideLull(); }  // reset toolRunning here: agent_settled and ws.onclose both call this, so the flag can't stick

/* ------------------------------------------------------------- events --- */
function handleEvent(e) {
  if (e.type === 'agent_start') armLull();
  if (LULL_ACTIVITY.has(e.type)) pokeLull();
  switch (e.type) {
    case 'agent_start':
      S.streaming = true;
      setStatus('streaming');
      setComposerSending(true);
      refreshStats();
      break;

    case 'agent_end':
      if (e.willRetry) toast('retrying after a transient error…');
      break;

    case 'agent_settled':
      S.streaming = false;
      setStatus('idle');
      setComposerSending(false);
      disarmLull();
      finalizeStream();
      /* pi writes the session file AFTER settling, so the rail's cached list
         may be stale (new session, new first-message preview). Refetch using
         the existing get_sessions wire message. */
      send({ kind: 'get_sessions' });
      break;

    case 'message_start':
      beginStreamMessage(e.message);
      break;

    case 'message_update':
      applyDelta(e);
      break;

    case 'message_end':
      endStreamMessage(e.message);
      refreshStats();
      break;

    case 'tool_execution_start':
      toolStart(e);
      break;
    case 'tool_execution_update':
      toolUpdate(e);
      break;
    case 'tool_execution_end':
      toolEnd(e);
      refreshStats();
      break;

    case 'queue_update':
      renderQueue(e);
      break;

    case 'compaction_start':
      S.compacting = true;
      toast(`compacting context (${e.reason || 'auto'})…`);
      break;
    case 'compaction_end':
      S.compacting = false;
      toast('context compacted');
      break;

    case 'extension_error':
      toast('extension error' + (e.error ? ': ' + e.error : ''), true);
      break;
  }
}

/* ---------------------------------------------------- message streaming - */
/** Format a timestamp (epoch ms) as 24-hour local time on the viewing device.
 *  Browsers resolve to the host's OS timezone via toLocaleTimeString, so no
 *  timezone config is needed — it just follows the device. */
const TIME_FMT = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit', minute: '2-digit', hour12: false,
});
const DATE_FMT = new Intl.DateTimeFormat(undefined, {
  year: 'numeric', month: 'short', day: '2-digit',
});

function fmtStamp(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return TIME_FMT.format(d);
}

function fmtStampFull(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return `${DATE_FMT.format(d)} ${TIME_FMT.format(d)}`;
}

/** Build the message header: role label + timestamp + copy affordance. */
function buildMsgHead(role, ts, bodyEl) {
  const head = mk('div', 'msg-head');
  head.appendChild(mk('span', 'msg-role', role === 'user' ? 'you' : role === 'error' ? 'error' : 'pi'));

  const stamp = fmtStamp(ts);
  if (stamp) {
    const t = mk('span', 'msg-time', stamp);
    t.title = fmtStampFull(ts);
    head.appendChild(t);
  }

  const copy = mk('button', 'msg-copy', '⧉');
  copy.title = 'copy message text';
  copy.addEventListener('click', () => {
    const text = bodyEl ? bodyEl.innerText : '';
    copyText(text, (ok) => {
      if (!ok) { toast('copy failed — clipboard blocked on http; use HTTPS', true); return; }
      copy.textContent = '✓';
      setTimeout(() => (copy.textContent = '⧉'), 1200);
    });
  });
  head.appendChild(copy);

  return head;
}

function newStreamShell(role, ts) {
  const wrap = mk('div', 'msg ' + (role === 'user' ? 'user' : role === 'error' ? 'error' : 'assistant'));
  const body = mk('div', 'msg-body');
  wrap.appendChild(buildMsgHead(role, ts ?? null, body));
  wrap.appendChild(body);
  el.chat.appendChild(wrap);
  autoscroll(true);
  return { wrap, body };
}

function beginStreamMessage(message) {
  if (!message) return;
  const role = message.role || 'assistant';

  /* A user turn arrives as BOTH message_start and message_end. Rendering both
     doubles every sent message — render once, here, and skip the end event. */
  if (role === 'user') {
    const { body } = newStreamShell('user', message.timestamp);
    body.innerHTML = md(contentText(message.content));
    return;
  }

  /* pi replays a tool's result as a separate `toolResult` message; the block is
     already rendered from tool_execution_* — skip it when we already have it. */
  if (role === 'toolResult') {
    if (hasToolBlock(message.toolCallId)) return;   // already rendered
    renderHistoryMessage(message);                  // genuinely new (e.g. history reload)
    return;
  }

  if (role === 'bashExecution') {
    renderHistoryMessage(message);
    return;
  }

  /* Assistant: defer creating the shell until we know there is renderable
     content. pi often emits a bare `assistant` message with a toolCall and no
     text, which would otherwise leave an empty "pi" bubble behind. */
  S.pendingAssistant = { message, role };
}

function ensureStream(ts) {
  if (S.stream && S.stream.body) return S.stream;
  const stamp = ts ?? Date.now();   // pi normally sends one; stamp at first sight if not
  const { wrap, body } = newStreamShell('assistant', stamp);
  const cursor = mk('span', 'cursor');
  body.appendChild(cursor);
  S.stream = { wrap, body, rawText: '', cursor, ts: stamp };
  return S.stream;
}

/* ------------------------------------------------- thinking flavour --- */
const THINK_LABELS = [
  'hamster wheel turning…',
  'throwing coal on the furnace…',
  'calling the avengers…',
  'overthinking the issue…',
  'plotting the end of humanity…',
  'doing AI things…',
  'consulting the elder gods…',
  'downloading more RAM…',
  'bribing the tokens…',
  'warming up the neurons…',
  'reticulating splines…',
  'arguing with myself…',
  'sharpening the pixels…',
  'sacrificing a goat to the GPU…',
  'getting crumbs in the keyboard…',
  'stockpiling nuclear weapons…',
  'tuning the flux capacitor…',
  'calculating the jump to hyperspace…',
  'rerouting the plasma conduits…',
  'spinning up the warp core…',
  'negotiating with the firewall…',
  'hiding the evidence…',
  'assembling IKEA furniture…',
  'counting to infinity (twice)…',
  'teaching the toaster to feel…',
  'learning kung fu…',
  'burning a mix CD…',
  'feeding my Tamagotchi…',
  'entering the Upside Down…',
  'rewinding the VHS…',
  'beating Ocarina of Time…',
  'eating crayons…',
  'shopping at Hot Topic…',
  'instigating WWIII (should only take a second)…',
  'overthinking the three sea shells…',
  'daydreaming about Nick Cage…',
  'warming up the tractor beam…',
  'driving back the hun…',
  'inventing time travel…',
];

/* shuffle bag: random pick, no repeats until the bag empties; reshuffle is guarded so a
   fresh bag cannot open on the phrase that just closed the old one */
let lullBag = [];
let lullLast = null;
function nextLullPhrase() {
  if (!lullBag.length) {
    lullBag = THINK_LABELS.slice();
    for (let i = lullBag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [lullBag[i], lullBag[j]] = [lullBag[j], lullBag[i]];
    }
    if (lullBag.length > 1 && lullBag[lullBag.length - 1] === lullLast) {
      [lullBag[0], lullBag[lullBag.length - 1]] = [lullBag[lullBag.length - 1], lullBag[0]];
    }
  }
  const p = lullBag.pop();
  lullLast = p;
  return p;
}
/* elapsed mm:ss (h:mm:ss past an hour) */
function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/* live step timer for a thinking block; the returned fn freezes the final duration */
function startThinkTimer(span, startedAt) {
  const t0 = startedAt || Date.now();
  const tick = () => { span.textContent = fmtElapsed(Date.now() - t0); };
  tick();
  const id = setInterval(tick, 1000);
  return () => { clearInterval(id); tick(); };
}

/** Standalone thinking block — deliberately OUTSIDE the message bubble so a
 *  thinking-only turn (thinking + toolcall, no text) leaves no empty "pi" bubble. */
function handleThinkingDelta(a) {
  if (!S.curThinking) {
    const t = mk('div', 'thinking');
    const th = mk('div', 'thinking-head');
    th.appendChild(mk('span', '', '✳ thinking…'));
    const now = (S.pendingAssistant && S.pendingAssistant.message && S.pendingAssistant.message.timestamp) || Date.now();
    const ts = mk('span', 'thinking-time', '');
    ts.title = fmtStampFull(now);
    th.appendChild(ts);
    t.appendChild(th);
    const tb = mk('div', 'thinking-body');
    t.appendChild(tb);
    th.addEventListener('click', () => {
      t.classList.toggle('collapsed');
      if (!t.classList.contains('collapsed')) {
        const b = t.querySelector('.thinking-body');
        if (b) b.scrollTop = b.scrollHeight;
      }
    });
    const stopTimer = startThinkTimer(ts, now);
    S.curThinking = { wrap: t, body: tb, raw: '', stopTimer };
    el.chat.appendChild(t);
  }
  if (a.type === 'thinking_delta') {
    S.curThinking.raw += a.delta || '';
    S.curThinking.body.textContent = S.curThinking.raw;
    if (!S.curThinking.wrap.classList.contains('collapsed')) {
      S.curThinking.body.scrollTop = S.curThinking.body.scrollHeight;
    }
    autoscroll();
  } else if (a.type === 'thinking_end' && typeof a.content === 'string' && a.content.length) {
    S.curThinking.raw = a.content;
    S.curThinking.body.textContent = S.curThinking.raw;
    if (!S.curThinking.wrap.classList.contains('collapsed')) {
      S.curThinking.body.scrollTop = S.curThinking.body.scrollHeight;
    }
    autoscroll();
  }
}

/* stop the live timer and collapse — unless the user pinned thinking open */
function finishThinking(th) {
  if (!th) return;
  if (th.stopTimer) { th.stopTimer(); th.stopTimer = null; }
  if (!S.keepThinkingOpen) th.wrap.classList.add('collapsed');
}

function applyDelta(e) {
  const a = e.assistantMessageEvent;
  /* message_update.usage is all zeros during streaming (verified live), so there is
     no per-delta usage to show. Context comes from get_session_stats. */
  if (!a) return;

  /* thinking is handled standalone (above); only text needs a message shell */
  if (a.type === 'thinking_start' || a.type === 'thinking_delta' || a.type === 'thinking_end') {
    handleThinkingDelta(a);
    autoscroll();
    return;
  }

  if (a.type === 'toolcall_start' || a.type === 'toolcall_delta' || a.type === 'toolcall_end') {
    if (a.type === 'toolcall_start' && a.id) S.tools.set(a.id, { name: a.toolName, el: null });
    if (a.type === 'toolcall_end' && a.toolCall && a.toolCall.id) {
      const rec = S.tools.get(a.toolCall.id) || { name: a.toolCall.name };
      rec.name = a.toolCall.name;
      S.tools.set(a.toolCall.id, rec);
    }
    return;
  }

  if (a.type === 'text_start' || a.type === 'text_delta' || a.type === 'text_end') {
    const st = ensureStream(S.pendingAssistant && S.pendingAssistant.message ? S.pendingAssistant.message.timestamp : null);
    if (a.type === 'text_delta') {
      st.rawText += a.delta || '';
      st.body.textContent = st.rawText;
      if (st.cursor) st.body.appendChild(st.cursor);
    } else if (a.type === 'text_end' && typeof a.content === 'string' && a.content.length) {
      st.rawText = a.content;
    }
  }
  autoscroll();
}

function endStreamMessage(message) {
  if (!message) return;
  const role = message.role;

  if (role === 'user') return;          // already rendered at message_start

  if (role === 'toolResult') {
    if (hasToolBlock(message.toolCallId)) return;
    renderHistoryMessage(message);
    return;
  }

  if (role === 'assistant') {
    const st = S.stream;
    const thinking = S.curThinking;
    S.pendingAssistant = null;
    S.curThinking = null;

    /* fill the standalone thinking block from the authoritative message */
    if (thinking && Array.isArray(message.content)) {
      const tb = message.content.find((b) => b && b.type === 'thinking');
      if (tb && tb.thinking) thinking.body.textContent = tb.thinking;
    }

    finishThinking(thinking);

    if (!st) {
      /* no text was streamed — render only if the message genuinely has text */
      const hasText = Array.isArray(message.content)
        ? message.content.some((b) => b && b.type === 'text' && b.text)
        : !!contentText(message.content);
      if (!hasText) return;
      const fresh = newStreamShell('assistant', message.timestamp);
      const textOnly = Array.isArray(message.content)
        ? message.content.filter((b) => b && b.type === 'text')
        : message.content;
      fresh.body.innerHTML = renderAssistantContent(textOnly, null);
      wireCollapsibles(fresh.wrap);
      autoscroll();
      return;
    }

    if (st.cursor) st.cursor.remove();
    const textOnly = Array.isArray(message.content)
      ? { content: message.content.filter((b) => b && b.type === 'text') }
      : { content: message.content };
    st.body.innerHTML = renderAssistantContent(textOnly.content, null);
    if (!st.body.innerHTML.trim()) st.wrap.remove();
    S.stream = null;
    autoscroll();
    return;
  }

  renderHistoryMessage(message);
}

/** Convert an assistant message's content blocks to HTML.
 *  Thinking is rendered STANDALONE by both the live path (handleThinkingDelta) and
 *  the history path (renderHistoryMessage), so it is skipped here — one consistent
 *  rule, no nested-in-bubble variant to keep in sync. */
function renderAssistantContent(content, st) {
  if (typeof content === 'string') return md(content);

  if (!Array.isArray(content)) {
    return md(st && st.rawText ? st.rawText : '');
  }

  const parts = [];
  for (const b of content) {
    if (!b || !b.type) continue;
    if (b.type === 'text') {
      parts.push(`<div class="blk-text">${md(b.text || '')}</div>`);
    } else if (b.type === 'thinking') {
      continue;
    } else if (b.type === 'toolCall') {
      /* rendered on its own by tool_execution_*; keep a placeholder out here */
      continue;
    }
  }

  if (!parts.length) return md(st && st.rawText ? st.rawText : '');
  return parts.join('');
}

function finalizeStream() {
  if (S.stream) {
    if (S.stream.cursor) S.stream.cursor.remove();
    if (!S.stream.rawText) S.stream.wrap.remove();
    else S.stream.body.innerHTML = md(S.stream.rawText);
    S.stream = null;
  }
  S.pendingAssistant = null;
  finishThinking(S.curThinking);
  S.curThinking = null;
  /* authoritative context accounting once the run settles */
  refreshStats();
}

/* --------------------------------------------------------- tool blocks - */
function toolBlock(toolCallId, toolName) {
  /* A toolCall is rendered by tool_execution_* events. pi ALSO replays the result
     as a separate `toolResult` message (message_start + message_end), and the
     session-file history replays it again via get_messages. All three paths would
     produce a block -> the same tool showed up to three times on screen.
     Keying the DOM block on toolCallId and reusing it collapses that to one. */
  if (toolCallId) {
    const existing = document.querySelector(`[data-tool-id="${CSS.escape(toolCallId)}"]`);
    if (existing) {
      const rec = { wrap: existing, head: existing.querySelector('.tool-head'), status: existing.querySelector('.tool-status'), body: existing.querySelector('.tool-body'), id: toolCallId };
      return rec;
    }
  }
  const wrap = mk('div', 'tool collapsed');
  if (toolCallId) wrap.setAttribute('data-tool-id', toolCallId);
  const head = mk('div', 'tool-head');
  head.appendChild(mk('span', 'tool-name', toolName || 'tool'));
  /* tool_execution_* events carry no timestamp — stamp client-side at first sight */
  if (!wrap.dataset.stamped) {
    const now = Date.now();
    const tt = mk('span', 'tool-time', fmtStamp(now));
    tt.title = fmtStampFull(now);
    head.appendChild(tt);
    wrap.dataset.stamped = '1';
  }
  const status = mk('span', 'tool-status running', 'running');
  head.appendChild(status);
  const body = mk('pre', 'tool-body');
  wrap.appendChild(head);
  wrap.appendChild(body);
  head.addEventListener('click', () => wrap.classList.toggle('collapsed'));
  el.chat.appendChild(wrap);
  autoscroll(true);
  return { wrap, head, status, body };
}

/** Does a tool block for this id already exist in the DOM? */
function hasToolBlock(toolCallId) {
  if (!toolCallId) return false;
  return !!document.querySelector(`[data-tool-id="${CSS.escape(toolCallId)}"]`);
}

function partialText(partialResult) {
  if (!partialResult) return '';
  if (typeof partialResult === 'string') return partialResult;
  return contentText(partialResult.content);
}

function toolStart(e) {
  /* reuse an existing block for this id (see toolBlock) */
  S.toolRunning = true;
  const blk = toolBlock(e.toolCallId, e.toolName);
  if (blk.body) blk.body.textContent = e.args ? JSON.stringify(e.args, null, 2) : '';
  if (e.toolCallId) S.tools.set(e.toolCallId, { name: e.toolName, el: blk, status: 'running' });
  autoscroll();
}

function toolUpdate(e) {
  const rec = e.toolCallId ? S.tools.get(e.toolCallId) : null;
  const blk = rec && rec.el;
  if (!blk) return;
  const t = partialText(e.partialResult);
  if (t) blk.body.textContent = t;
  autoscroll();
}

function toolEnd(e) {
  /* reuse the block created at tool_execution_start — do NOT create a second one */
  S.toolRunning = false;
  const blk = toolBlock(e.toolCallId, e.toolName);
  const t = e.result ? contentText(e.result.content) : '';
  blk.body.textContent = t || '(no output)';
  blk.status.textContent = e.isError ? 'error' : 'ok';
  blk.status.className = 'tool-status ' + (e.isError ? 'error' : 'ok');
  blk.wrap.classList.add('collapsed');
  autoscroll();
}

/* ------------------------------------------------------------- history - */
function renderHistory(messages) {
  el.chat.innerHTML = '';
  S.stream = null;
  for (const m of messages || []) renderHistoryMessage(m);
  autoscroll(true);
}

function renderHistoryMessage(m) {
  if (!m || !m.role) return;

  if (m.role === 'user') {
    const { body } = newStreamShell('user', m.timestamp);
    body.innerHTML = md(contentText(m.content));
    return;
  }

  if (m.role === 'assistant') {
    const content = m.content;

    /* Thinking renders as a standalone block BEFORE the bubble — same shape as the
       live path (handleThinkingDelta). No thinking nested inside bubbles anywhere. */
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b && b.type === 'thinking' && b.thinking) {
          const t = mk('div', 'thinking collapsed');
          const th = mk('div', 'thinking-head');
          th.appendChild(mk('span', '', '✳ thinking…'));
          if (m.timestamp) {
            const ts = mk('span', 'thinking-time', fmtStamp(m.timestamp));
            ts.title = fmtStampFull(m.timestamp);
            th.appendChild(ts);
          }
          t.appendChild(th);
          const tb = mk('div', 'thinking-body');
          tb.textContent = b.thinking;
          t.appendChild(tb);
          th.addEventListener('click', () => t.classList.toggle('collapsed'));
          el.chat.appendChild(t);
        }
      }
    }

    const { wrap, body } = newStreamShell('assistant', m.timestamp);
    if (Array.isArray(content)) {
      const textOnly = content.filter((b) => b && b.type === 'text');
      body.innerHTML = textOnly.length
        ? renderAssistantContent(textOnly, null)
        : md(contentText(content));
      if (m.stopReason === 'error' || m.stopReason === 'aborted') wrap.classList.add('error');
    } else {
      body.innerHTML = md(contentText(content));
    }
    /* a thinking-only turn has no text — drop the empty bubble */
    if (!body.innerHTML.trim()) wrap.remove();
    return;
  }

  if (m.role === 'toolResult') {
    const wrap = mk('div', 'tool collapsed');
    if (m.toolCallId) wrap.setAttribute('data-tool-id', m.toolCallId);
    const head = mk('div', 'tool-head');
    head.appendChild(mk('span', 'tool-name', m.toolName || 'tool'));
    if (m.timestamp) {
      const t = mk('span', 'tool-time', fmtStamp(m.timestamp));
      t.title = fmtStampFull(m.timestamp);
      head.appendChild(t);
    }
    const status = mk('span', 'tool-status ' + (m.isError ? 'error' : 'ok'), m.isError ? 'error' : 'ok');
    head.appendChild(status);
    const body = mk('pre', 'tool-body');
    body.textContent = contentText(m.content) || '(no output)';
    wrap.appendChild(head);
    wrap.appendChild(body);
    head.addEventListener('click', () => wrap.classList.toggle('collapsed'));
    el.chat.appendChild(wrap);
    return;
  }

  if (m.role === 'bashExecution') {
    const wrap = mk('div', 'tool collapsed');
    const head = mk('div', 'tool-head');
    head.appendChild(mk('span', 'tool-name', '$ ' + (m.command || 'bash')));
    const status = mk('span', 'tool-status ' + (m.exitCode === 0 ? 'ok' : 'error'), 'exit ' + m.exitCode);
    head.appendChild(status);
    const body = mk('pre', 'tool-body');
    body.textContent = m.output || '(no output)';
    wrap.appendChild(head);
    wrap.appendChild(body);
    head.addEventListener('click', () => wrap.classList.toggle('collapsed'));
    el.chat.appendChild(wrap);
  }
}

function wireCollapsibles(root) {
  root.querySelectorAll('.thinking-head').forEach((h) => {
    h.addEventListener('click', () => h.parentElement.classList.toggle('collapsed'));
  });
}

/* ------------------------------------------------------ session rail --- */
let sMenu = null;        // the one open session menu, if any
let sMenuOwner = null;   // its .session-item row

function closeSessionMenu() {
  if (sMenu) { sMenu.remove(); sMenu = null; sMenuOwner = null; }
}

document.addEventListener('click', closeSessionMenu);

/* The rail and the topbar must agree on what the session is called. Prefer pi's
   sessionName, then the active rail row's name/preview. Never the raw random id. */
function activeTitle(fallback) {
  const row = S.sessions.find((s) => s.path === S.activeSessionFile);
  const t = (S.activeSessionName || '').trim()
    || (row && (((row.name || '').trim()) || ((row.preview || '').trim())))
    || '';
  return t || fallback;
}

function renderSessions() {
  closeSessionMenu();
  el.sessionName.textContent = activeTitle('—');
  el.sessionList.innerHTML = '';
  if (!S.sessions.length) {
    el.sessionList.appendChild(mk('div', 's-meta', 'no sessions yet'));
    return;
  }
  for (const s of S.sessions) {
    const item = mk('div', 'session-item' + (s.path === S.activeSessionFile ? ' active' : ''));
    item.appendChild(mk('div', 's-name', s.name || s.preview || s.id || '(untitled)'));
    const meta = mk('div', 's-meta', `${s.messageCount || 0} msgs · ${fmtTime(s.updated)}`);
    item.appendChild(meta);
    item.title = s.preview || s.path || '';
    item.addEventListener('click', () => {
      rpc({ type: 'switch_session', sessionPath: s.path });
      el.rail.classList.remove('open');
      el.railScrim.classList.add('hidden');
    });
    const kebab = mk('button', 's-kebab', '⋮');
    kebab.type = 'button';
    kebab.title = 'Session actions';
    kebab.addEventListener('click', (e) => {
      e.stopPropagation(); // don't fall through to the row's switch_session
      if (sMenuOwner === item) { closeSessionMenu(); return; } // toggle
      closeSessionMenu(); // only one menu open at a time
      const menu = mk('div', 's-menu');
      const rename = mk('div', 's-menu-item', 'Rename');
      const del = mk('div', 's-menu-item danger', 'Delete');
      rename.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeSessionMenu();
        const name = window.prompt('Rename session:', s.name || s.preview || '');
        if (name == null) return; // cancelled
        const trimmed = name.trim();
        if (!trimmed) { toast('name cannot be empty', true); return; }
        send({ kind: 'rename_session', path: s.path, name: trimmed });
      });
      del.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeSessionMenu();
        if (!window.confirm('Delete this session? This cannot be undone.')) return;
        send({ kind: 'delete_session', path: s.path });
      });
      menu.appendChild(rename);
      menu.appendChild(del);
      item.appendChild(menu);
      // Flip above the row if it would clip past the list's bottom edge.
      const menuR = menu.getBoundingClientRect();
      const listR = el.sessionList.getBoundingClientRect();
      if (menuR.bottom > listR.bottom) menu.classList.add('up');
      sMenu = menu;
      sMenuOwner = item;
    });
    item.appendChild(kebab);
    el.sessionList.appendChild(item);
  }
}

function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const now = Date.now();
  const diff = now - ms;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return d.toLocaleDateString();
}

/* ------------------------------------------------------------ chrome --- */
function setStatus(state) {
  el.statusPill.className = 'pill status-' + (
    state === 'streaming' ? 'streaming'
    : state === 'thinking' ? 'thinking'
    : state === 'error' ? 'error'
    : state === 'offline' ? 'error'
    : 'idle'
  );
  el.statusPill.textContent =
    state === 'streaming' ? 'streaming'
    : state === 'thinking' ? 'thinking'
    : state === 'error' ? 'error'
    : state === 'offline' ? 'disconnected'
    : S.piState === 'running' ? 'idle' : S.piState;
}

/* Render the ctx pill. Prefer pi's own contextUsage (it accounts for the whole
   conversation the model actually sees); fall back to a live usage estimate. */
function renderContextPill() {
  const u = S.contextUsage;
  /* Window precedence: S.contextWindow comes from get_state.model (the ACTIVE model, and it
     follows a model switch). stats.contextUsage.contextWindow can lag — it is refreshed on a
     cadence, not synchronously with every model change — which showed the wrong window in the
     pill (262k while the model ran 120k). Prefer the model; fall back to stats. (Fixed 2026-09-28.) */
  const win = S.contextWindow || (u && u.contextWindow);
  const used = (u && typeof u.tokens === 'number') ? u.tokens : null;
  /* Derive the percentage from the displayed pair rather than trusting stats.percent: stats
     lag a model switch, so a stored percent can describe a window that is no longer shown
     (60000/262k = 22.9% read next to "120k"). used/tokens and the model window are each
     authoritative, so their ratio is the honest number. Stats percent is the fallback for
     when the window is unknown. (Fixed 2026-09-28.) */
  const pct = (win && used != null && win > 0)
    ? (used / win) * 100
    : (u && typeof u.percent === 'number' ? u.percent : null);

  /* in/out: session-cumulative, from get_session_stats.tokens */
  const io = S.tokens ? ` · ↑${fmtK(S.tokens.input)} ↓${fmtK(S.tokens.output)}` : '';

  if (used == null) {
    el.contextPill.textContent = 'ctx —' + io;
    el.contextPill.title = 'no context usage reported yet' +
      (S.tokens ? ` · in ${S.tokens.input} / out ${S.tokens.output} tokens` : '');
    el.contextPill.classList.remove('ctx-warn', 'ctx-crit');
    return;
  }
  const pctStr = pct != null ? `${pct.toFixed(1)}%` : '—';
  el.contextPill.textContent = (win
    ? `${fmtK(used)} / ${fmtK(win)} · ${pctStr}`
    : `${fmtK(used)} tok`) + io;
  el.contextPill.title =
    `context used: ${used.toLocaleString()} tokens` +
    (win ? ` of ${win.toLocaleString()} (${pctStr})` : '') +
    (S.tokens ? ` · in ${S.tokens.input.toLocaleString()} / out ${S.tokens.output.toLocaleString()} tokens` : '') +
    (S.msgCount ? ` · ${S.msgCount} messages` : '');

  /* warn as the window fills */
  el.contextPill.classList.toggle('ctx-warn', pct != null && pct >= 75 && pct < 90);
  el.contextPill.classList.toggle('ctx-crit', pct != null && pct >= 90);
}

function fmtK(n) {
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
  return String(n);
}

function setComposerSending(on) {
  el.sendBtn.classList.toggle('hidden', on);
  el.stopBtn.classList.toggle('hidden', !on);
}

function renderQueue(e) {
  const steering = e.steering || [];
  const followUp = e.followUp || [];
  const all = [...steering.map((m) => ['steer', m]), ...followUp.map((m) => ['follow-up', m])];
  if (!all.length) {
    el.queueBar.classList.add('hidden');
    el.queueBar.textContent = '';
    return;
  }
  el.queueBar.classList.remove('hidden');
  el.queueBar.textContent = `${all.length} queued — ` + all.map(([k, m]) => `[${k}] ${m}`).join('  ·  ');
}

/** Hide + empty the queue bar. Reconciliation path (reconnect / onclose);
    the live path keeps using renderQueue. */
function clearQueue() {
  el.queueBar.classList.add('hidden');
  el.queueBar.textContent = '';
}

/* Provider display names for the model dropdown. Anything not listed here still renders
   (the id is prettified: `local-lmstudio` → "Local Lmstudio"), so a provider you add later
   needs no change here. Buckets appear in the order pi reports them. */
const PROVIDER_LABELS = {
  'local-lmstudio': 'LM Studio',
  'lmstudio': 'LM Studio',
  'ollama-cloud': 'Ollama Cloud',
  'openrouter': 'OpenRouter',
  'anthropic': 'Anthropic',
  'openai': 'OpenAI',
  'groq': 'Groq',
};

function providerLabel(p) {
  if (PROVIDER_LABELS[p]) return PROVIDER_LABELS[p];
  return String(p || 'other')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/* Two-pane model flyout. Providers render in a LEFT pane; the selected
   provider's models render in a RIGHT pane beside it. On a desktop the two panes
   sit side by side. On a phone the right pane has no room beside the left, so CSS
   slides the pair left on a provider tap (drill-in) and a `← Providers` row comes
   back. Identical DOM either way — only the layout/which pane is in view differs. */
function renderModelList() {
  el.modelList.innerHTML = '';
  /* Always give the user a way to pull a fresh catalogue: pi's list is frozen for
     the life of the process in --mode rpc (no refresh RPC exists), so a model loaded
     in LM Studio after pi started is invisible until pi is respawned. */
  const refreshItem = mk('div', 'model-item model-refresh', '⟳ refresh model list');
  refreshItem.addEventListener('click', () => refreshModels());
  el.modelList.appendChild(refreshItem);

  if (!S.models.length) {
    el.modelList.appendChild(mk('div', 'model-item', 'no models reported'));
    return;
  }

  // Bucket models by provider, preserving pi's
  // catalogue order within each bucket. Unknown providers sort last.
  const byProvider = new Map();
  for (const m of S.models) {
    const p = m.provider || 'other';
    if (!byProvider.has(p)) byProvider.set(p, []);
    byProvider.get(p).push(m);
  }
  // Buckets keep the order pi's catalogue reports them in (stable sort by first sight).
  const providers = [...byProvider.keys()];

  // Open the bucket that holds the active model by default; otherwise the first.
  const activeProvider = (S.models.find((m) => m.id === S.activeModelId) || {}).provider;
  if (!S.modelProvider || !byProvider.has(S.modelProvider)) {
    S.modelProvider = (activeProvider && byProvider.has(activeProvider)) ? activeProvider : providers[0];
  }

  const panes = mk('div', 'model-panes');
  const left = mk('div', 'model-providers');
  const right = mk('div', 'model-models');
  panes.append(left, right);
  el.modelList.appendChild(panes);
  el.modelList.classList.toggle('show-models', S.modelDrilled);

  // Phone drill-in: the row that slides back to the provider list (CSS shows it
  // only on narrow screens; desktop shows both panes so it stays hidden).
  const back = mk('div', 'model-item model-back', '← Providers');
  back.addEventListener('click', (ev) => {
    ev.stopPropagation();
    S.modelDrilled = false;
    renderModelList();
  });
  right.appendChild(back);

  for (const p of providers) {
    const bucket = byProvider.get(p);
    const row = mk('div', 'model-item model-provider'
      + (p === S.modelProvider ? ' active' : '')
      + (bucket.some((m) => m.id === S.activeModelId) ? ' has-active' : ''),
      providerLabel(p));
    row.title = bucket.length + (bucket.length === 1 ? ' model' : ' models');
    row.addEventListener('click', (ev) => {
      ev.stopPropagation();
      S.modelProvider = p;      // desktop: swap the right pane
      S.modelDrilled = true;    // phone: slide to the models pane
      renderModelList();
    });
    left.appendChild(row);

    if (p !== S.modelProvider) continue;   // right pane shows only the open provider
    for (const m of bucket) {
      const unloaded = modelIsUnloaded(m);
      const item = mk('div', 'model-item'
        + (m.id === S.activeModelId ? ' active' : '')
        + (unloaded ? ' unloaded' : ''), m.name || m.id);
      item.title = unloaded
        ? m.id + ' — not loaded in LM Studio; load it there to select it here'
        : m.id;
      if (unloaded) {
        // No click handler at all — greyed out and inert by design.
        item.setAttribute('aria-disabled', 'true');
      } else {
        item.addEventListener('click', (ev) => {
          ev.stopPropagation();
          // provider is required: pi matches on provider AND modelId.
          rpc({ type: 'set_model', provider: m.provider, modelId: m.id });
          setPersistedModel(m.id);
          el.modelPop.classList.add('hidden');
        });
      }
      right.appendChild(item);
    }
  }
}

function renderThinkingLevels(levels) {
  const list = (levels && levels.length) ? levels
    : ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const cur = el.thinkingSel.value;
  el.thinkingSel.innerHTML = '';
  for (const l of list) {
    const o = document.createElement('option');
    o.value = typeof l === 'string' ? l : l.id || l.name;
    o.textContent = o.value;
    el.thinkingSel.appendChild(o);
  }
  if (cur) el.thinkingSel.value = cur;
}

/* Slash-command dropdown.

   TWO very different families — this distinction matters:

   1. NATIVE pi commands (settings, model, tree, thinking, scoped-models, … 24 total).
      These are handled by pi's TUI editor in `setupEditorSubmitHandler()` and are
      EXPLICITLY excluded from the RPC surface. docs/rpc.md says it outright:
      "Built-in TUI commands (/settings, /hotkeys, etc.) are not included. They are
      handled only in interactive mode and would not execute if sent via prompt."
      => Sending `/model` as a prompt reaches the MODEL as literal text, which is
         exactly the bug this bridge exists to avoid. They must be MAPPED to their RPC equivalent.

   2. Extension / skill / prompt-template commands from get_commands. These DO expand
      when sent through `prompt` (verified live: a `/skill:<name>` command expanded into
      the full 3052-char skill body). They are sent as-is.

   So: native -> dispatch to the equivalent RPC command (or the closest safe action,
   or an honest "TUI-only" note). Extension -> drop into the composer as text. */

const CMD_GROUP_ORDER = ['pi commands', 'Extensions', 'Skills', 'Templates', 'Other'];

/** Native pi commands, mirrored from BUILTIN_SLASH_COMMANDS in the pi bundle.
 *  `rpc` = how to drive it from here; `null` = no RPC equivalent (TUI-only). */
const NATIVE = [
  { name: 'model',        description: 'Select model',                 args: '<provider/model>', rpc: (a) => selectModel(a) },
  { name: 'thinking',     description: 'Set thinking level',           args: '<level>',          rpc: (a) => setThinking(a) },
  { name: 'compact',      description: 'Compact the session context',                            rpc: () => rpc({ type: 'compact' }) },
  { name: 'new',          description: 'Start a new session',                                    rpc: () => rpc({ type: 'new_session' }) },
  { name: 'session',      description: 'Show session info and stats',                            rpc: () => refreshStats() },
  { name: 'export',       description: 'Export session to HTML',       args: '[path]',           rpc: () => rpc({ type: 'export_html' }) },
  { name: 'fork',         description: 'Fork from a previous message',                           rpc: () => openForkMenu() },
  { name: 'resume',       description: 'Resume a different session',                             rpc: () => openRail() },
  { name: 'reload',       description: 'Reload extensions, skills, prompts',                     rpc: null },
  { name: 'tree',         description: 'Navigate session tree / branches',                       rpc: null },
  { name: 'scoped-models',description: 'Enable/disable models for Ctrl+P cycling',               rpc: null },
  { name: 'settings',     description: 'Open settings menu',                                     rpc: null },
  { name: 'import',       description: 'Import a session from a JSONL file',                     rpc: null },
  { name: 'share',        description: 'Share session as a secret GitHub gist',                  rpc: null },
  { name: 'bug',          description: 'Report a bug to the Pi developers', args: '<desc>',      rpc: null },
  { name: 'login',        description: 'Configure provider authentication', args: '<provider>', rpc: null },
  { name: 'logout',       description: 'Remove provider authentication',                         rpc: null },
  { name: 'trust',        description: 'Save project trust decision',                            rpc: null },
  { name: 'name',         description: 'Set session display name',     args: '<name>',           rpc: null },
  { name: 'copy',         description: 'Copy last agent message to clipboard',                   rpc: () => copyLastMessage() },
  { name: 'changelog',    description: 'Show changelog entries',                                 rpc: null },
  { name: 'hotkeys',      description: 'Show keyboard shortcuts',                                rpc: null },
  { name: 'clone',        description: 'Duplicate the current session',                          rpc: () => rpc({ type: 'clone' }) },
  { name: 'quit',         description: `Quit pi (not applicable here)`,                          rpc: null },
];

const NATIVE_BY_NAME = new Map(NATIVE.map((c) => [c.name, c]));

function cmdGroup(source) {
  if (source === 'extension') return 'Extensions';
  if (source === 'skill') return 'Skills';
  if (source === 'prompt') return 'Templates';
  return 'Other';
}

/* Refresh the model catalogue. pi's list is a frozen in-memory snapshot in --mode rpc
   (verified: no refresh RPC exists, and `refreshModelCatalogs` is TUI-only), so the ONLY
   way to pick up a model newly loaded in LM Studio is to respawn pi. We do it surgically
   and re-open the same session, so neither the browser, the server, nor any session file
   is disturbed.

   Flow: remember where we are -> ask the server to restart the pi child -> on the fresh
   catalogue, switch back to the saved session, re-point the model at the (loaded) one that
   was active, and refresh the button + ctx pill. `S.refreshingModels` suppresses the boot()
   chatter that the intermediate hello/pi_status frames would otherwise trigger. */
function refreshModels() {
  if (S.refreshingModels) return;                       // already in flight
  if (S.piState !== 'running') { toast('pi is not running', true); return; }
  if (S.streaming) { toast('finish or stop the current turn first', true); return; }
  const target = S.activeSessionFile;
  const want = S.activeModelId;
  if (!send({ kind: 'restart_pi' })) return;            // no server -> nothing to do
  S.refreshTargetSession = target;
  S.pendingModelId = want;
  S.refreshingModels = true;
  if (el.refreshModels) el.refreshModels.classList.add('busy');
  el.modelPop.classList.add('hidden');
  S.modelDrilled = false;
  toast('refreshing model list…');
  /* Safety valve: if the fresh catalogue never arrives, unstick the UI rather than
     leaving it permanently swallowed. */
  setTimeout(() => {
    if (!S.refreshingModels) return;
    S.refreshingModels = false;
    S.refreshTargetSession = null;
    S.pendingModelId = null;
    if (el.refreshModels) el.refreshModels.classList.remove('busy');
    toast('model refresh timed out', true);
  }, 20000);
}

function selectModel(arg) {
  if (arg) {
    const m = S.models.find((x) => x.id === arg || x.name === arg);
    if (!m) { toast(`no model matching "${arg}"`, true); return; }
    if (modelIsUnloaded(m)) {
      toast(`"${arg}" is not loaded in LM Studio — load it there first`, true);
      return;
    }
    setPersistedModel(m.id);
    return rpc({ type: 'set_model', provider: m.provider, modelId: m.id });
  }
  el.modelPop.classList.toggle('hidden');   // the existing model picker
}

function setThinking(arg) {
  const levels = [...el.thinkingSel.options].map((o) => o.value);
  if (!arg) { el.thinkingSel.focus(); return; }
  if (levels.includes(arg)) {
    el.thinkingSel.value = arg;
    rpc({ type: 'set_thinking_level', level: arg });
  } else {
    toast(`unknown thinking level "${arg}" — try ${levels.join('/')}`, true);
  }
}

function openForkMenu() {
  el.forkPop.classList.remove('hidden');
  rpc({ type: 'get_fork_messages' });
}

/** Render the fork popover from pi's user messages.
 *  (2026-09-28: was a stub — it requested get_fork_messages and threw the answer away,
 *  leaving the popover empty with a dev placeholder toast.) */
function renderForkList(messages) {
  const list = el.forkList;
  if (!list) return;
  list.innerHTML = '';
  const usable = (messages || []).filter((m) => m && m.entryId);
  if (!usable.length) {
    list.appendChild(mk('div', 'fork-item', 'no earlier messages to fork from'));
    return;
  }
  for (const m of usable) {
    const text = (m.text || '').replace(/\s+/g, ' ').trim();
    const item = mk('div', 'fork-item', text ? truncate(text, 90) : '(empty message)');
    item.title = text || '(empty message)';
    item.addEventListener('click', () => {
      rpc({ type: 'fork', entryId: m.entryId });
      el.forkPop.classList.add('hidden');
    });
    list.appendChild(item);
  }
}

function openRail() {
  el.rail.classList.add('open');
  el.railScrim.classList.remove('hidden');
}

function copyLastMessage() {
  rpc({ type: 'get_last_assistant_text' });
}

/** Run a command chosen from the dropdown. */
function runCommand(name) {
  const native = NATIVE_BY_NAME.get(name);

  if (native) {
    if (native.rpc) {
      native.rpc('');
      return;
    }
    /* No RPC equivalent — be honest instead of sending text that cannot work. */
    toast(`/${name} is a pi TUI-only command — not available over the web bridge`, true);
    return;
  }

  /* extension / skill / prompt template — these DO expand via `prompt` */
  el.input.value = '/' + name + ' ';
  el.input.focus();
  autosize();
}

function renderCommandSelect() {
  const sel = el.commandsSel;
  sel.innerHTML = '';
  sel.disabled = false;
  sel.title = `${NATIVE.length + S.commands.length} commands`;

  const ph = document.createElement('option');
  ph.value = '';
  ph.textContent = `⚡ commands (${NATIVE.length + S.commands.length})`;
  sel.appendChild(ph);

  /* native pi commands first */
  const ogN = document.createElement('optgroup');
  ogN.label = `pi commands (${NATIVE.length})`;
  for (const c of NATIVE) {
    const o = document.createElement('option');
    o.value = 'native:' + c.name;
    o.textContent = `/${c.name}${c.args ? ' ' + c.args : ''} — ${truncate(c.description, 40)}`;
    o.title = c.description + (c.rpc ? '' : '  (TUI-only — no web equivalent)');
    if (!c.rpc) o.className = 'tui-only';
    ogN.appendChild(o);
  }
  sel.appendChild(ogN);

  /* grouped extension/skill/template commands */
  const groups = new Map();
  for (const c of S.commands) {
    const g = cmdGroup(c.source);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(c);
  }
  for (const g of CMD_GROUP_ORDER) {
    if (g === 'pi commands') continue;
    const items = groups.get(g);
    if (!items || !items.length) continue;
    const og = document.createElement('optgroup');
    og.label = `${g} (${items.length})`;
    for (const c of items.slice().sort((a, b) => a.name.localeCompare(b.name))) {
      const o = document.createElement('option');
      o.value = 'ext:' + c.name;
      o.textContent = `/${c.name} — ${truncate(c.description, 44)}`;
      o.title = c.description || '';
      og.appendChild(o);
    }
    sel.appendChild(og);
  }

  sel.value = '';
}

function truncate(s, n) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/* ----------------------------------------------------------- dialogs --- */
function handleExtUi(req) {
  const method = req.method;

  if (method === 'notify') {
    toast(req.message || req.title || 'notification');
    return;
  }
  if (method === 'setStatus' || method === 'setWidget' || method === 'setTitle') {
    if (method === 'setTitle' && (req.title || req.value)) {
      document.title = req.title || req.value;
    }
    return;
  }
  if (method === 'set_editor_text') {
    if (typeof req.text === 'string') el.input.value = req.text;
    autosize();
    return;
  }

  const id = req.id;
  const respond = (payload) => rpc(Object.assign({ type: 'extension_ui_response', id }, payload));

  const dlg = mk('div', 'dialog');
  dlg.appendChild(mk('div', 'dialog-title', req.title || method));
  if (req.message) dlg.appendChild(mk('div', 'dialog-msg', req.message));

  const actions = mk('div', 'dialog-actions');
  const finish = (payload) => { dlg.remove(); respond(payload); };

  if (method === 'select') {
    const list = mk('div', 'model-list');
    for (const opt of req.options || []) {
      const item = mk('div', 'model-item', String(opt));
      item.addEventListener('click', () => finish({ value: opt }));
      list.appendChild(item);
    }
    dlg.appendChild(list);
    const cancel = mk('button', '', 'cancel');
    cancel.addEventListener('click', () => finish({ cancelled: true }));
    actions.appendChild(cancel);
  } else if (method === 'confirm') {
    const no = mk('button', '', 'no');
    no.addEventListener('click', () => finish({ confirmed: false }));
    const yes = mk('button', 'primary', 'yes');
    yes.addEventListener('click', () => finish({ confirmed: true }));
    actions.appendChild(no);
    actions.appendChild(yes);
  } else if (method === 'input') {
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.placeholder = req.placeholder || '';
    dlg.appendChild(inp);
    const cancel = mk('button', '', 'cancel');
    cancel.addEventListener('click', () => finish({ cancelled: true }));
    const ok = mk('button', 'primary', 'ok');
    ok.addEventListener('click', () => finish({ value: inp.value }));
    inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') finish({ value: inp.value }); });
    actions.appendChild(cancel);
    actions.appendChild(ok);
    setTimeout(() => inp.focus(), 0);
  } else if (method === 'editor') {
    const ta = document.createElement('textarea');
    ta.rows = 8;
    ta.value = req.prefill || '';
    dlg.appendChild(ta);
    const cancel = mk('button', '', 'cancel');
    cancel.addEventListener('click', () => finish({ cancelled: true }));
    const ok = mk('button', 'primary', 'save');
    ok.addEventListener('click', () => finish({ value: ta.value }));
    actions.appendChild(cancel);
    actions.appendChild(ok);
    setTimeout(() => ta.focus(), 0);
  } else {
    return;
  }

  dlg.appendChild(actions);
  el.dialogs.appendChild(dlg);
}

/* --------------------------------------------------------- composer --- */
function autosize() {
  const t = el.input;
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 200) + 'px';
}

function sendPrompt() {
  const text = el.input.value.trim();
  if (!text && !S.attachments.length) return;

  const images = S.attachments
    .filter((a) => a.isImage)
    .map((a) => ({ type: 'image', data: a.base64, mimeType: a.mimeType }));

  let message = text;
  const texts = S.attachments.filter((a) => !a.isImage && a.text);
  if (texts.length) {
    message += (message ? '\n\n' : '') +
      texts.map((a) => `--- ${a.fileName} ---\n${a.text}`).join('\n\n');
  }

  const cmd = { type: 'prompt', message };

  /* A typed NATIVE pi command (/model, /new, /compact, …) must not reach the LLM as
     text. pi's built-ins are TUI-only — its own docs say they "would not execute if
     sent via `prompt`" — so "/new" used to be handed to the model as a sentence.
     Intercept here and route through runCommand, the same path the dropdown uses.
     Extension/skill/template commands are NOT intercepted: those genuinely do expand
     through `prompt`, and a leading "/" can also be ordinary prose, so anything not a
     known native falls through unchanged. (Fixed 2026-09-28.) */
  const typedNative = /^\/([A-Za-z0-9:_-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (typedNative && NATIVE_BY_NAME.has(typedNative[1].toLowerCase())) {
    const rest = (typedNative[2] || '').trim();
    const native = NATIVE_BY_NAME.get(typedNative[1].toLowerCase());
    if (native.rpc) {
      native.rpc(rest);
    } else if (rest) {
      toast(`/${native.name} is a pi TUI-only command — not available over the web bridge`, true);
    } else {
      /* Bare TUI-only command with no args: prefill with its argument hint so the
         dropdown-style guidance is visible, instead of firing a dead notice. */
      el.input.value = '/' + native.name + (native.args ? ' ' : '');
      el.input.focus();
      autosize();
      return;
    }
    el.input.value = '';
    el.attachments = [];
    renderAttachments();
    autosize();
    return;
  }

  if (images.length) cmd.images = images;
  if (S.streaming) cmd.streamingBehavior = 'steer';

  if (!rpc(cmd)) return;
  armLull();

  el.input.value = '';
  el.attachments = [];
  renderAttachments();
  autosize();
}

function renderAttachments() {
  el.attachPreview.innerHTML = '';
  if (!S.attachments.length) {
    el.attachPreview.classList.add('hidden');
    return;
  }
  el.attachPreview.classList.remove('hidden');
  S.attachments.forEach((a, i) => {
    const chip = mk('span', 'attach-chip', (a.isImage ? '🖼 ' : '📄 ') + a.fileName);
    const x = mk('button', '', '✕');
    x.addEventListener('click', () => {
      S.attachments.splice(i, 1);
      renderAttachments();
    });
    chip.appendChild(x);
    el.attachPreview.appendChild(chip);
  });
}

function handleFiles(files) {
  for (const f of files) {
    const isImage = /^image\//.test(f.type);
    const reader = new FileReader();
    if (isImage) {
      reader.onload = () => {
        const b64 = String(reader.result).split(',')[1] || '';
        S.attachments.push({ fileName: f.name, mimeType: f.type, isImage: true, base64: b64 });
        renderAttachments();
      };
      reader.readAsDataURL(f);
    } else {
      if (f.size > 512 * 1024) {
        toast(`${f.name} is ${fmtK(Math.round(f.size / 1024))}KB — sending first 512KB only`);
      }
      reader.onload = () => {
        S.attachments.push({
          fileName: f.name,
          mimeType: f.type,
          isImage: false,
          text: String(reader.result).slice(0, 512 * 1024),
        });
        renderAttachments();
      };
      reader.readAsText(f);
    }
  }
}

/* -------------------------------------------------------- slash menu --- */
/* Inline autocomplete: fires when the composer holds a bare /command token.
   (The always-available list is the topbar dropdown — this is just the shortcut.) */
function updateSlashMenu() {
  const v = el.input.value;
  const m = /^\/([A-Za-z0-9:_-]*)$/.exec(v);
  if (!m || !S.commands.length) {
    el.slashPop.classList.add('hidden');
    S.slashMatches = [];
    return;
  }
  const q = m[1].toLowerCase();
  S.slashMatches = S.commands.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8);
  if (!S.slashMatches.length) {
    /* no command matches — hide, but do NOT block Enter: the text may be a
       plain message starting with "/", and pi should still receive it. */
    el.slashPop.classList.add('hidden');
    return;
  }
  S.slashIndex = 0;
  el.slashPop.innerHTML = '';
  S.slashMatches.forEach((c, i) => {
    const item = mk('div', 'slash-item' + (i === 0 ? ' active' : ''));
    item.appendChild(mk('span', 's-cmd', '/' + c.name));
    if (c.description) item.appendChild(mk('span', 's-desc', truncate(c.description, 60)));
    item.addEventListener('click', () => applySlash(c.name));
    el.slashPop.appendChild(item);
  });
  el.slashPop.classList.remove('hidden');
}

function applySlash(name) {
  el.input.value = '/' + name + ' ';
  el.slashPop.classList.add('hidden');
  el.input.focus();
}

function moveSlash(delta) {
  if (!S.slashMatches.length) return;
  S.slashIndex = (S.slashIndex + delta + S.slashMatches.length) % S.slashMatches.length;
  [...el.slashPop.children].forEach((n, i) => n.classList.toggle('active', i === S.slashIndex));
}

/* ------------------------------------------------------------ theme --- */
function getPersistedModel() {
  try { return localStorage.getItem('piweb.model') || null; } catch { return null; }
}
function setPersistedModel(id) {
  try { localStorage.setItem('piweb.model', id); } catch {}
}

/* Re-apply the model the user last chose.
   Why this cannot live only in the get_available_models handler:
     - a session LOAD (new_session / switch_session / fork / clone) re-stamps the
       model that session was created with (the Round-18/19 trap), and a brand new
       session starts on settings.json's defaultModel — so the model reported by
       get_state is NOT necessarily the one the user picked;
     - those session ops re-request get_state but NOT get_available_models, so a
       restore that only runs on the catalogue never gets a second chance and the
       active model silently reverts.
   Safe by construction: only applies when the persisted id is present in the
   current catalogue AND loaded. A stale/unloaded id leaves state alone (never
   fight the server over a model that cannot be selected). Returns true when the
   persisted model is now active (or already was). */
function applyPersistedModel() {
  const persisted = getPersistedModel();
  if (!persisted || !S.models.length) return false;
  const clean = persisted.replace(/\s*\(loaded\)\s*$/, '');
  const m = S.models.find((x) => !modelIsUnloaded(x) && (x.id === persisted || x.id === clean));
  if (!m) return false;
  if (m.id === S.activeModelId) return true;
  S.activeModelId = m.id;
  S.contextWindow = m.contextWindow || S.contextWindow;
  el.modelBtn.textContent = m.name || m.id;
  el.modelBtn.title = m.id;
  rpc({ type: 'set_model', provider: m.provider, modelId: m.id });
  renderModelList();
  renderContextPill();
  return true;
}

function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  el.themeBtn.textContent = t === 'dark' ? '☾' : '☀';
  try { localStorage.setItem('piweb.theme', t); } catch {}
}

function initTheme() {
  let t = 'dark';
  try { t = localStorage.getItem('piweb.theme') || 'dark'; } catch {}
  applyTheme(t);
}

/* keep thinking blocks expanded while streaming (opt-out via composer 🧠 toggle) */
function applyKeepThinking(on) {
  S.keepThinkingOpen = !!on;
  el.thinkBtn.classList.toggle('on', !!on);
  try { localStorage.setItem('piweb.keepThinkingOpen', on ? '1' : '0'); } catch {}
}
function initThinking() {
  let on = '0';
  try { on = localStorage.getItem('piweb.keepThinkingOpen') || '0'; } catch {}
  applyKeepThinking(on === '1');
}

/* ------------------------------------------------------------ rail ---- */
function initRail() {
  let collapsed = '0';
  try { collapsed = localStorage.getItem('piweb.railCollapsed') || '0'; } catch {}
  if (collapsed === '1') document.getElementById('app').classList.add('rail-collapsed');
}

/* ------------------------------------------------------- viewport ---
   A mobile on-screen keyboard shrinks the VISUAL viewport but not the layout
   viewport, so a 100dvh app shell leaves the composer bar (and the bottom rail)
   underneath the keyboard. When visualViewport reports the viewport is
   meaningfully shorter than the layout viewport, pin #app to the visual height
   so the composer bar stays visible above the keyboard. Reverting below the
   threshold (rather than to exactly the layout height) gives hysteresis and
   avoids a one-frame flap from the URL-bar collapse. */
function initViewport() {
  const vv = window.visualViewport;
  if (!vv) return; // older browser: the 100dvh fallback already applies
  const root = document.documentElement;
  const THRESHOLD = 80; // px shorter than the layout viewport = keyboard is up
  const apply = () => {
    const hidden = window.innerHeight - vv.height;
    if (hidden > THRESHOLD) {
      root.style.setProperty('--app-h', Math.round(vv.height) + 'px');
    } else {
      root.style.removeProperty('--app-h');
    }
  };
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  apply();
}

/* ------------------------------------------------------------ events --- */
function wire() {
  /* rail drawer (mobile) / collapse (desktop) */
  el.railToggle.addEventListener('click', () => {
    if (window.matchMedia('(max-width: 860px)').matches) {
      el.rail.classList.toggle('open');
      el.railScrim.classList.toggle('hidden', !el.rail.classList.contains('open'));
    } else {
      const app = document.getElementById('app');
      app.classList.toggle('rail-collapsed');
      try {
        localStorage.setItem('piweb.railCollapsed', app.classList.contains('rail-collapsed') ? '1' : '0');
      } catch {}
    }
  });
  el.railScrim.addEventListener('click', () => {
    el.rail.classList.remove('open');
    el.railScrim.classList.add('hidden');
  });

  /* new chat */
  el.newChat.addEventListener('click', () => {
    rpc({ type: 'new_session' });
    el.rail.classList.remove('open');
    el.railScrim.classList.add('hidden');
  });

  /* rename */
  el.sessionTitle.addEventListener('click', () => {
    const cur = el.sessionName.textContent === '—' ? '' : el.sessionName.textContent;
    const name = window.prompt('Session name', cur);
    if (name != null) rpc({ type: 'set_session_name', name });
  });

  /* composer */
  el.sendBtn.addEventListener('click', sendPrompt);
  el.input.addEventListener('input', () => { autosize(); updateSlashMenu(); });
  el.input.addEventListener('keydown', (ev) => {
    const popOpen = !el.slashPop.classList.contains('hidden');
    if (popOpen) {
      if (ev.key === 'ArrowDown') { ev.preventDefault(); return moveSlash(1); }
      if (ev.key === 'ArrowUp')   { ev.preventDefault(); return moveSlash(-1); }
      if (ev.key === 'Escape')    { el.slashPop.classList.add('hidden'); return; }
      if (ev.key === 'Enter' && !ev.shiftKey && S.slashMatches[S.slashIndex]) {
        ev.preventDefault();
        return applySlash(S.slashMatches[S.slashIndex].name);
      }
    }
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      sendPrompt();
    }
  });

  el.stopBtn.addEventListener('click', () => rpc({ type: 'abort' }));
  el.thinkBtn.addEventListener('click', () => applyKeepThinking(!S.keepThinkingOpen));

  /* attachments */
  el.attachBtn.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', (ev) => {
    handleFiles(ev.target.files);
    el.fileInput.value = '';
  });
  el.input.addEventListener('paste', (ev) => {
    const items = ev.clipboardData && ev.clipboardData.files;
    if (items && items.length) {
      ev.preventDefault();
      handleFiles(items);
    }
  });

  /* topbar */
  el.refreshModels?.addEventListener('click', (ev) => {
    ev.stopPropagation();   // don't let the outside-click closers fire
    refreshModels();
  });
  el.notifBtn?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    enableNotifications();
  });
  el.modelBtn.addEventListener('click', () => {
    el.modelPop.classList.toggle('hidden');
    el.forkPop.classList.add('hidden');
    // fresh open: start on the provider list (phone) / the active bucket's models
    S.modelDrilled = false;
    if (!el.modelPop.classList.contains('hidden')) renderModelList();
  });
  el.thinkingSel.addEventListener('change', () => {
    rpc({ type: 'set_thinking_level', level: el.thinkingSel.value });
  });

  /* choosing a command runs it: native -> dispatch to its RPC equivalent (or an
     honest TUI-only notice); extension/skill/template -> prefill the composer */
  el.commandsSel.addEventListener('change', () => {
    const raw = el.commandsSel.value;
    if (!raw) return;
    el.commandsSel.value = '';
    const [kind, ...rest] = raw.split(':');
    const name = rest.join(':');
    if (kind === 'native') runCommand(name);
    else runCommand(name);
  });
  el.compactBtn.addEventListener('click', () => rpc({ type: 'compact' }));
  el.themeBtn.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    applyTheme(cur === 'dark' ? 'light' : 'dark');
  });

  /* dismiss popovers on outside click */
  document.addEventListener('click', (ev) => {
    if (!el.modelPop.contains(ev.target) && ev.target !== el.modelBtn) {
      el.modelPop.classList.add('hidden');
    }
    if (!el.slashPop.contains(ev.target) && ev.target !== el.input) {
      el.slashPop.classList.add('hidden');
    }
    if (!el.forkPop.contains(ev.target)) el.forkPop.classList.add('hidden');
  });

  /* reconnect hint on tab focus */
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && (!S.ws || S.ws.readyState > 1)) {
      S.retry = 0;
      connect();
    }
  });
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function syncNotifButton() {
  const on = ('Notification' in window) && Notification.permission === 'granted';
  if (el.notifBtn) {
    el.notifBtn.textContent = on ? '🔔 on' : '🔔 off';
    el.notifBtn.classList.toggle('on', on);
  }
}

async function enableNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) { toast('notifications not supported here'); return; }
  let perm = ('Notification' in window) ? Notification.permission : 'denied';
  if (perm !== 'granted') { try { perm = await Notification.requestPermission(); } catch (_) {} }
  if (perm !== 'granted') { toast('notifications blocked'); syncNotifButton(); return; }
  try {
    const reg = await navigator.serviceWorker.ready;
    const res = await fetch('/push/vapid');
    const { publicKey } = await res.json();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
    await fetch('/push/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sub) });
    toast('notifications enabled');
  } catch (e) {
    toast('could not enable notifications');
  }
  syncNotifButton();
}

function initNotifications() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => toast('notifications unavailable'));
  syncNotifButton();
  if ('serviceWorker' in navigator && 'Notification' in window && Notification.permission === 'granted') {
    (async () => {
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) await fetch('/push/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sub) });
      } catch (_) {}
    })();
  }
}

/* -------------------------------------------------------------- init --- */
function init() {
  initTheme();
  initRail();
  initViewport();
  initThinking();
  wire();
  autosize();
  renderAttachments();
  renderThinkingLevels(null);
  renderCommandSelect();          // placeholder until pi reports its command list
  setStatus('idle');
  initNotifications();
  connect();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
