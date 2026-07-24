#!/usr/bin/env bash
# micro-reconnect — keep the Codex Micro's Bluetooth link up despite its
# rotating BLE address, and log connect/disconnect transitions for diagnostics.
#
# The Micro re-advertises under a new, non-resolvable static-random address that
# BlueZ won't auto-reconnect to. This watches for it advertising under ANY
# address and pairs+connects it. It only acts while disconnected, and prunes
# accumulated stale bonds. App-mode safe: manages only the Bluetooth link, never
# opens the HID device.
#
# Transition logs (grep the journal for "EVENT"):
#   EVENT connected    <addr>              — link came up
#   EVENT disconnected after <N>s          — link dropped, was up N seconds
#   EVENT reconnecting <addr> attempt <n>  — trying the live address
# Correlate the "disconnected" timestamps with the btmon reason-code logger
# (codex-bt-monitor system service) to see WHY each drop happened.
set -uo pipefail

NAME_RE='Device [0-9A-F:]{17} .*Codex Micro'
log() { echo "[$(date +%H:%M:%S)] $*"; }

connected_addr() {
  for h in /sys/class/hidraw/hidraw*; do
    if grep -q Codex "$h/device/uevent" 2>/dev/null; then
      # kernel HID name is 0005:VVVV:PPPP.NNNN — good enough as an id
      basename "$(readlink -f "$h/device")" 2>/dev/null; return 0
    fi
  done
  return 1
}

# NOTE: do NOT remove/prune bonds here. Removing the host-side bond while the
# device still holds its side causes AuthenticationFailed (key mismatch) and
# requires the device's manual pairing gesture to recover. Stale bonds are
# harmless; we just pair whatever fresh address the device is advertising.

log "micro-reconnect starting"
was_up=0; up_since=0; attempt=0
while true; do
  if id=$(connected_addr); then
    if (( ! was_up )); then
      was_up=1; up_since=$(date +%s); attempt=0
      log "EVENT connected $id"
    fi
    sleep 6; continue
  fi

  # transition: up -> down
  if (( was_up )); then
    dur=$(( $(date +%s) - up_since ))
    log "EVENT disconnected after ${dur}s"
    was_up=0
  fi

  # disconnected: scan briefly, connect the first live Codex address
  while read -r line; do
    [[ "$line" =~ $NAME_RE ]] || continue
    a=$(grep -oE "[0-9A-F:]{17}" <<<"$line" | head -1)
    attempt=$((attempt+1))
    log "EVENT reconnecting $a attempt $attempt"
    bluetoothctl pair "$a"    >/dev/null 2>&1
    bluetoothctl trust "$a"   >/dev/null 2>&1
    bluetoothctl connect "$a" >/dev/null 2>&1
    break
  done < <(bluetoothctl --timeout 12 scan on 2>&1)
  sleep 4
done
