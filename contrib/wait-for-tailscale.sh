#!/usr/bin/env bash
# Wait until Tailscale actually has an IPv4 address, then exit 0.
#
# Why: pi-web binds the tailnet IP. At boot a systemd user unit starts within the same
# second as tailscaled, so the interface can exist with no address yet. With
# PI_WEB_HOST=auto that would silently fall back to the LAN or 127.0.0.1 — the bind
# *succeeds*, so systemd never restarts it and the UI is off the tailnet until kicked.
#
# Use as ExecStartPre for PI_WEB_HOST=tailscale (which fails loudly instead of falling
# back) or PI_WEB_HOST=auto. Linux only (`ip`); on macOS the equivalent is
# `ifconfig | grep 'inet 100\.'`.
set -u
IFACE="${TAILSCALE_IFACE:-tailscale0}"
TIMEOUT="${TAILSCALE_WAIT_TIMEOUT:-60}"

for _ in $(seq 1 "$TIMEOUT"); do
  if ip -4 addr show "$IFACE" 2>/dev/null | grep -q 'inet '; then
    exit 0
  fi
  sleep 1
done

echo "wait-for-tailscale: $IFACE has no IPv4 address after ${TIMEOUT}s" >&2
exit 1
