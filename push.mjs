/**
 * push.mjs — server-side Web Push delivery.
 *
 * Stores VAPID keys and push subscriptions on disk (mode 0600).
 * Pure, fire-and-forget: never awaited, never throws out of the caller's loop.
 */
import webpush from "web-push";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/* VAPID keys and push subscriptions live in a data directory (default ./data, override
   with PI_WEB_DATA_DIR) so they stay out of git and survive a redeploy. */
let dataDir = join(__dirname, "data");
const vapidFile = () => join(dataDir, "vapid.json");
const subsFile = () => join(dataDir, "push-subs.json");

let publicKey = null;

/* Push services expect a contact in the VAPID subject. Some reject the placeholder outright, so
   allow a real address here (PI_WEB_VAPID_SUBJECT="mailto:you@example.com"). */
const SUBJECT = process.env.PI_WEB_VAPID_SUBJECT || "mailto:pi-web@localhost";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function readJsonSafe(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Initialise VAPID keys. Idempotent — never regenerates if the key file exists.
 * `dir` overrides the data directory (the server passes PI_WEB_DATA_DIR).
 * Returns the publicKey string.
 */
export function initPush(dir) {
  if (dir) dataDir = dir;
  fs.mkdirSync(dataDir, { recursive: true });
  let keys;
  if (fs.existsSync(vapidFile())) {
    keys = readJsonSafe(vapidFile());
  } else {
    keys = webpush.generateVAPIDKeys();
    writeJson(vapidFile(), keys);
  }
  publicKey = keys.publicKey;
  webpush.setVapidDetails(SUBJECT, keys.publicKey, keys.privateKey);
  return publicKey;
}

/** Returns the VAPID publicKey (string). */
export function getPublicKey() {
  return publicKey;
}

/**
 * Upsert a PushSubscription into .push-subs.json, keyed by endpoint.
 */
export function saveSubscription(sub) {
  const subs = readJsonSafe(subsFile()) || [];
  const idx = subs.findIndex((s) => s.endpoint === sub.endpoint);
  if (idx >= 0) {
    subs[idx] = sub;
  } else {
    subs.push(sub);
  }
  writeJson(subsFile(), subs);
  return true;
}

/**
 * Remove the subscription whose endpoint matches.
 */
export function removeSubscription(endpoint) {
  const subs = readJsonSafe(subsFile()) || [];
  const filtered = subs.filter((s) => s.endpoint !== endpoint);
  if (filtered.length !== subs.length) writeJson(subsFile(), filtered);
  return true;
}

/**
 * Pure function: returns a notification payload object, or null.
 */
export function notifyPayloadForEvent(data) {
  if (!data || typeof data !== "object") return null;

  if (data.type === "agent_settled") {
    return { title: "Pi", body: "Reply ready", url: "/", tag: "pi-turn" };
  }

  if (data.type === "extension_ui_request") {
    // Only blocking UI methods
    const BLOCKING_METHODS = new Set(["select", "confirm", "input", "editor"]);
    if (BLOCKING_METHODS.has(data.method)) {
      return {
        title: "Pi needs you",
        body: String(data.message || data.title || "input required").slice(0, 120),
        url: "/",
        tag: "pi-ask",
      };
    }
  }

  return null;
}

/**
 * Send a payload to every stored subscription.
 * Returns a Promise that settles after all sends settle.
 * Each send is individually try/catched — a single failure never
 * rejects the batch. 404/410 results in auto-removal.
 */
export function sendToAll(payload) {
  const subs = readJsonSafe(subsFile()) || [];
  const promises = subs.map((sub) =>
    webpush.sendNotification(sub, JSON.stringify(payload)).catch((err) => {
      // Clean up dead endpoints
      if (err && err.statusCode) {
        try {
          removeSubscription(sub.endpoint);
        } catch (_) {
          // disk/permission failure — can't become an unhandled rejection
        }
      }
    })
  );
  return Promise.allSettled(promises);
}
