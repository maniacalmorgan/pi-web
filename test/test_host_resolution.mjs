/**
 * test_host_resolution.mjs — the bind-address and origin-policy rules, tested without ports.
 *
 * These are the rules a stranger's server lives or dies by, so they get fake interface maps and
 * deterministic assertions rather than "it bound something on my machine":
 *
 *   - `auto` must NEVER select a public address (the default has no auth);
 *   - `lan` must refuse rather than degrade to a public one;
 *   - `all` is the only wide bind, and it is explicit;
 *   - a WebSocket from another origin must be refused (cross-site WebSocket hijacking), while a
 *     same-origin page and an Origin-less CLI client are both still allowed.
 *
 * Run: node test/test_host_resolution.mjs
 */
import * as net from "../net.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`PASS  ${name}${extra ? "  -- " + extra : ""}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? "  -- " + extra : ""}`); }
};

const iface = (name, address, internal = false) => [name, [{ address, family: "IPv4", internal }]];
const map = (...pairs) => Object.fromEntries(pairs);

const TAILSCALE = "100.97.12.34";
const LAN = "192.168.1.20";
const PUBLIC = "203.0.113.9"; // TEST-NET-3, but "public" to the classifier
const LINK_LOCAL = "169.254.10.10";

const MIXED = map(iface("tailscale0", TAILSCALE), iface("eth0", LAN), iface("eth1", PUBLIC));
const LAN_ONLY = map(iface("eth0", LAN));
const PUBLIC_ONLY = map(iface("eth0", PUBLIC));
const TS_ONLY = map(iface("tailscale0", TAILSCALE));
const NONE = map(iface("lo", "127.0.0.1", true));
const LINK_LOCAL_ONLY = map(iface("eth0", LINK_LOCAL));

/* ---------- classification boundaries ---------- */
ok("CGNAT low edge 100.64 is Tailscale", net.isCgnat("100.64.0.1") === true);
ok("100.63 is not Tailscale", net.isCgnat("100.63.0.1") === false);
ok("CGNAT high edge 100.127 is Tailscale", net.isCgnat("100.127.255.1") === true);
ok("100.128 is not Tailscale", net.isCgnat("100.128.0.1") === false);
ok("RFC1918 ranges classify as private",
   ["10.1.2.3", "172.16.0.1", "172.31.255.254", "192.168.0.1"].every((ip) => net.isPrivate(ip)));
ok("172.32 and 11.x are not private",
   !net.isPrivate("172.32.0.1") && !net.isPrivate("11.0.0.1") && !net.isPrivate("192.169.0.1"));
ok("classify() names the four kinds",
   net.classify("127.0.0.1") === "loopback" && net.classify(TAILSCALE) === "tailscale" &&
   net.classify(LAN) === "private" && net.classify(PUBLIC) === "public" &&
   net.classify("example.lan") === "hostname");

/* ---------- auto: Tailscale → private LAN → loopback, never public ---------- */
{
  const r = net.pickBindAddress("auto", MIXED);
  ok("auto prefers Tailscale when present", r.host === TAILSCALE && r.kind === "tailscale", JSON.stringify(r));
}
{
  const r = net.pickBindAddress("auto", LAN_ONLY);
  ok("auto falls back to a private LAN address", r.host === LAN && r.kind === "private", JSON.stringify(r));
}
{
  const r = net.pickBindAddress("auto", PUBLIC_ONLY);
  ok("auto NEVER binds a public address (falls back to loopback)",
     r.host === "127.0.0.1" && r.kind === "loopback", JSON.stringify(r));
}
{
  const r = net.pickBindAddress("auto", NONE);
  ok("auto with no usable interface binds loopback", r.host === "127.0.0.1" && r.kind === "loopback", JSON.stringify(r));
}
{
  const r = net.pickBindAddress("auto", LINK_LOCAL_ONLY);
  ok("auto ignores link-local 169.254 addresses", r.host === "127.0.0.1", JSON.stringify(r));
}
ok("auto is the default when PI_WEB_HOST is unset/blank",
   net.pickBindAddress("", LAN_ONLY).host === LAN && net.pickBindAddress(undefined, LAN_ONLY).host === LAN);

/* ---------- lan: RFC1918 only, and loud when there is none ---------- */
{
  const r = net.pickBindAddress("lan", MIXED);
  ok("lan ignores the Tailscale address and picks the private one",
     r.host === LAN && r.kind === "private", JSON.stringify(r));
}
{
  const r = net.pickBindAddress("lan", PUBLIC_ONLY);
  ok("lan REFUSES a public-only host instead of degrading to it",
     !!r.error && r.host === undefined, r.error);
  ok("lan's refusal names the address it found, so the user can act",
     !!r.error && r.error.includes(PUBLIC), r.error);
}
{
  const r = net.pickBindAddress("lan", NONE);
  ok("lan with no interface at all is an error, not a loopback bind",
     !!r.error && /no private/.test(r.error), r.error);
}
{
  // 192.168 wins over 10.x over 172.16/12 — the address most likely to be the home LAN.
  const m = map(iface("eth0", "172.20.0.5"), iface("eth1", "10.5.5.5"), iface("eth2", LAN));
  const r = net.pickBindAddress("lan", m);
  ok("lan prefers 192.168 over 10/8 over 172.16/12", r.host === LAN, JSON.stringify(r));
}

/* ---------- tailscale ---------- */
{
  ok("tailscale picks the CGNAT address", net.pickBindAddress("tailscale", MIXED).host === TAILSCALE);
  const r = net.pickBindAddress("tailscale", LAN_ONLY);
  ok("tailscale FAILS LOUDLY when Tailscale is down", !!r.error && !!r.host === false, r.error);
  ok("the failure says what it was looking for", !!r.error && r.error.includes("100.64.0.0/10"), r.error);
}

/* ---------- localhost / all / explicit ---------- */
{
  const l = net.pickBindAddress("localhost", MIXED);
  ok("localhost binds loopback even when Tailscale is up",
     l.host === "127.0.0.1" && l.kind === "loopback", JSON.stringify(l));
  const a = net.pickBindAddress("all", MIXED);
  ok("all is an explicit wide bind", a.host === "0.0.0.0" && a.kind === "all", JSON.stringify(a));
  const e = net.pickBindAddress(LAN, MIXED);
  ok("an explicit address is honoured verbatim", e.host === LAN && e.source === "explicit");
  const p = net.pickBindAddress(PUBLIC, MIXED);
  ok("an explicit PUBLIC address is classified public (server then demands a token)",
     p.host === PUBLIC && p.kind === "public", JSON.stringify(p));
}

/* ---------- interface bookkeeping ---------- */
{
  const numericFamily = map(["eth0", [{ address: LAN, family: 4, internal: false }]]);
  ok("numeric family:4 (newer Node) is counted as IPv4",
     net.pickBindAddress("lan", numericFamily).host === LAN);
  const internalOnly = map(["eth0", [{ address: LAN, family: "IPv4", internal: true }]]);
  ok("internal addresses are never offered as a LAN bind",
     net.lanAddress(internalOnly) === null);
}

/* ---------- origin policy (cross-site WebSocket hijacking) ---------- */
{
  const sameOrigin = { origin: `http://${LAN}:4321`, host: `${LAN}:4321` };
  ok("same-origin page is allowed", net.originAllowed(sameOrigin) === true);
  ok("a CLI client with no Origin is allowed", net.originAllowed({ host: `${LAN}:4321` }) === true);
  ok("a page on another site is REFUSED",
     net.originAllowed({ origin: "https://evil.example", host: `${LAN}:4321` }) === false);
  ok("a malformed Origin is refused", net.originAllowed({ origin: "not a url", host: `${LAN}:4321` }) === false);
  ok("a different port on the same host is refused",
     net.originAllowed({ origin: `http://${LAN}:8080`, host: `${LAN}:4321` }) === false);
  ok("PI_WEB_ALLOWED_ORIGINS='*' allows anything",
     net.originAllowed({ origin: "https://evil.example", host: `${LAN}:4321` }, { allowAny: true }) === true);
  ok("an explicitly allow-listed origin is allowed",
     net.originAllowed({ origin: "https://dash.example", host: `${LAN}:4321` },
       { allowed: ["https://dash.example"] }) === true);
  const p = net.parseAllowedOrigins(" https://a.example , https://b.example ");
  ok("the allow-list env var is parsed and trimmed",
     p.allowAny === false && p.allowed.length === 2 && p.allowed[0] === "https://a.example", JSON.stringify(p));
  ok("an empty allow-list env var means 'no extra origins'",
     net.parseAllowedOrigins("").allowed.length === 0 && net.parseAllowedOrigins(undefined).allowAny === false);
}

console.log(`\n=== ${pass}/${pass + fail} passed ===`);
process.exit(fail ? 1 : 0);
