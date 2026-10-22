/**
 * net.mjs — where pi-web listens, and who is allowed to talk to it.
 *
 * Pure functions over an `interfaces` map (the shape `os.networkInterfaces()` returns). Keeping
 * these decisions out of server.mjs means they can be tested without opening a port — and the
 * rules they encode are load-bearing:
 *
 *   - `auto` never selects a public address. A host with a public IPv4 (a VPS, a cloud box) must
 *     not have its agent UI silently exposed to the internet, because the default has no auth.
 *   - `lan` means RFC1918 only, and fails loudly when there is no such address instead of
 *     degrading to something reachable from outside.
 *   - Only `all` (or an explicit address) can produce a wide bind, and it says so.
 */
import os from "node:os";

export const LOOPBACK = "127.0.0.1";
export const ANY = "0.0.0.0";

const PRIVATE = [
  { rank: 0, re: /^192\.168\./ },
  { rank: 1, re: /^10\./ },
  { rank: 2, re: /^172\.(1[6-9]|2\d|3[01])\./ },
];

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Tailscale hands out addresses from the CGNAT range 100.64.0.0/10. */
export function isCgnat(ip) {
  const m = /^100\.(\d+)\./.exec(String(ip));
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

/** RFC1918 — the ranges a "LAN" can actually mean. */
export function isPrivate(ip) {
  return PRIVATE.some((p) => p.re.test(String(ip)));
}

export function isLoopback(ip) {
  return ip === LOOPBACK || ip === "::1";
}

export function isLinkLocal(ip) {
  return /^169\.254\./.test(String(ip));
}

/** 'loopback' | 'tailscale' | 'private' | 'public' | 'hostname' */
export function classify(ip) {
  const s = String(ip || "");
  if (isLoopback(s)) return "loopback";
  if (isCgnat(s)) return "tailscale";
  if (isPrivate(s)) return "private";
  if (IPV4.test(s)) return "public";
  return "hostname";
}

/** Every non-internal IPv4 address, with the interface it lives on. */
export function listIpv4(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const [name, addrs] of Object.entries(interfaces || {})) {
    for (const a of addrs || []) {
      // Node reports `family` as 4 on new versions and "IPv4" on old ones.
      const v4 = a.family === "IPv4" || a.family === 4;
      if (v4 && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

export function tailscaleAddress(interfaces) {
  return listIpv4(interfaces).find((a) => isCgnat(a.address))?.address || null;
}

/** The best LAN address: 192.168/16 first, then 10/8, then 172.16/12. Never a public one. */
export function lanAddress(interfaces) {
  const cands = listIpv4(interfaces)
    .filter((a) => isPrivate(a.address) && !isLinkLocal(a.address))
    .map((a) => ({ ...a, rank: PRIVATE.find((p) => p.re.test(a.address)).rank }))
    .sort((a, b) => a.rank - b.rank);
  return cands[0]?.address || null;
}

/**
 * Decide the bind address.
 *
 * `want` is PI_WEB_HOST: auto | tailscale | lan | localhost | all | an IP or hostname.
 * Returns `{ host, kind, source }` or `{ error }` — never a guess.
 */
export function pickBindAddress(want = "auto", interfaces = os.networkInterfaces()) {
  const mode = String(want || "auto").trim();
  const lower = mode.toLowerCase();

  switch (lower) {
    case "auto": {
      const ts = tailscaleAddress(interfaces);
      if (ts) return { host: ts, kind: "tailscale", source: "auto" };
      const lan = lanAddress(interfaces);
      if (lan) return { host: lan, kind: "private", source: "auto" };
      return { host: LOOPBACK, kind: "loopback", source: "auto" };
    }
    case "tailscale": {
      const ts = tailscaleAddress(interfaces);
      if (!ts) {
        return {
          error:
            "PI_WEB_HOST=tailscale but no Tailscale address (100.64.0.0/10) was found — is Tailscale up?",
        };
      }
      return { host: ts, kind: "tailscale", source: "tailscale" };
    }
    case "lan": {
      const lan = lanAddress(interfaces);
      if (!lan) {
        const seen = listIpv4(interfaces).map((a) => a.address);
        return {
          error:
            "PI_WEB_HOST=lan but no private (RFC1918) IPv4 address was found" +
            (seen.length ? ` — this host has: ${seen.join(", ")}` : " — this host has none"),
        };
      }
      return { host: lan, kind: "private", source: "lan" };
    }
    case "localhost":
    case "loopback":
      return { host: LOOPBACK, kind: "loopback", source: "localhost" };
    case "all":
    case "any":
      return { host: ANY, kind: "all", source: "all" };
    default:
      return { host: mode, kind: classify(mode), source: "explicit" };
  }
}

/**
 * WebSocket origin policy.
 *
 * A browser will happily open a WebSocket to any host it can reach, and with no token set that
 * socket can drive the agent — so a page on the internet could talk to a pi-web instance on your
 * LAN (cross-site WebSocket hijacking). Browsers always send `Origin` on a WebSocket handshake,
 * so requiring it to match `Host` closes that hole without affecting anything else:
 *
 *   - a same-origin page sends Origin == Host → allowed;
 *   - a CLI client (curl, a test, the bundled scripts) sends no Origin → allowed;
 *   - a page on another site sends a different Origin → refused, unless explicitly allow-listed.
 */
export function originAllowed(headers = {}, { allowAny = false, allowed = [] } = {}) {
  const origin = headers.origin || headers.Origin;
  if (!origin) return true;
  if (allowAny) return true;
  const host = headers.host || headers.Host || "";
  try {
    if (new URL(origin).host === host) return true;
  } catch {
    return false; // malformed Origin: treat as hostile
  }
  return allowed.includes(origin);
}

/** Parse PI_WEB_ALLOWED_ORIGINS ("*" or a comma-separated list of origins). */
export function parseAllowedOrigins(raw) {
  const value = String(raw || "").trim();
  if (!value) return { allowAny: false, allowed: [] };
  if (value === "*") return { allowAny: true, allowed: [] };
  return {
    allowAny: false,
    allowed: value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
