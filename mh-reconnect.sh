#!/usr/bin/env bash
# micro-reconnect — keep the Codex Micro's Bluetooth link up despite its
# rotating BLE address, and log connect/disconnect transitions for diagnostics.
#
# The Micro re-advertises under a new, non-resolvable static-random address that
# BlueZ won't auto-reconnect to. This watches for it advertising under ANY
# address and pairs+connects it. It only acts while the Bluetooth link is down.
# App-mode safe: manages only the Bluetooth link, never opens the HID device.
#
# Transition logs (grep the journal for "EVENT"):
#   EVENT connected    <id>                 — BT link came up
#   EVENT disconnected after <N>s           — BT link dropped, was up N seconds
#   EVENT usb-mode <id>                     — on the cable; BT work suspended
#   EVENT reconnecting <addr> attempt <n>   — trying the live address
#   EVENT radio-stalled                     — adapter stopped answering scans
# Correlate the "disconnected" timestamps with the btmon reason-code logger
# (codex-bt-monitor system service) to see WHY each drop happened.
set -uo pipefail

BT_BUS=0005          # HID bus id for the Bluetooth transport (0003 = USB)
SCAN_SECS=10         # length of one discovery window
BACKOFF_MIN=8        # first pause between scan attempts
BACKOFF_MAX=300      # ceiling, so a missing device can't free-run the radio
STALL_AFTER=20       # consecutive empty scans before declaring the radio stalled

log() { echo "[$(date +%H:%M:%S)] $*"; }

# HID id of a Codex Micro on a given bus prefix. The kernel HID name is
# 0005:VVVV:PPPP.NNNN over Bluetooth and 0003:... over USB. The old version
# matched any bus, so a charging cable looked exactly like a live BT link and
# the reconnect path went to sleep for as long as the Micro was plugged in.
codex_on_bus() {
  local want=$1 h id
  for h in /sys/class/hidraw/hidraw*; do
    grep -q Codex "$h/device/uevent" 2>/dev/null || continue
    id=$(basename "$(readlink -f "$h/device")" 2>/dev/null) || continue
    [[ $id == "$want":* ]] && { printf '%s\n' "$id"; return 0; }
  done
  return 1
}

# Every address BlueZ currently knows that names itself a Codex Micro. This
# includes stale bonds, so callers must filter with is_live().
codex_addrs() { bluetoothctl devices 2>/dev/null | awk '/Codex Micro/ {print $2}'; }

# A device carries an RSSI property only while it is being seen in an active
# discovery session, which is what separates "advertising right now" from
# "an old bond still in the object tree".
is_live() { bluetoothctl info "$1" 2>/dev/null | grep -q "RSSI:"; }

is_bonded() { bluetoothctl info "$1" 2>/dev/null | grep -q "Paired: yes"; }

# Hold one discovery window, then read the object tree.
#
# bluetoothctl only emits its [NEW]/[CHG] event lines when stdout is a TTY.
# Piped into a shell it prints nothing but "Discovery started", so the previous
# `while read` over `scan on` output never matched a single line and the
# reconnect path silently never fired — every reconnect in the logs was really
# the device reattaching on its own. Reading `devices` after the window works
# headless.
scan_once() {
  local a
  bluetoothctl --timeout "$SCAN_SECS" scan on >/dev/null 2>&1
  for a in $(codex_addrs); do
    is_live "$a" && { printf '%s\n' "$a"; return 0; }
  done
  return 1
}

# Pair in ONE persistent bluetoothctl session. Separate `bluetoothctl pair` /
# `trust` / `connect` invocations each register+tear-down their own agent, so no
# agent is alive when the async pairing-confirmation request arrives — BlueZ
# then logs "No agent available for request type 2" and the pair fails with
# AuthenticationFailed. Keeping stdin open (via the sleeps) holds the
# NoInputNoOutput JustWorks agent alive across the handshake so it auto-confirms.
#
# NOTE: do NOT remove/prune bonds here. Removing the host-side bond while the
# device still holds its side causes AuthenticationFailed (key mismatch) and
# requires the device's manual pairing gesture to recover.
pair_and_connect() {
  local a=$1
  if is_bonded "$a"; then
    ( echo "connect $a"; sleep 5; echo "quit" ) | bluetoothctl >/dev/null 2>&1
  else
    ( echo "agent NoInputNoOutput"; sleep 1
      echo "default-agent";         sleep 1
      echo "pair $a";               sleep 9
      echo "trust $a";              sleep 1
      echo "connect $a";            sleep 4
      echo "quit" ) | bluetoothctl >/dev/null 2>&1
  fi
}

log "micro-reconnect starting"
was_up=0; up_since=0; attempt=0; empty=0; backoff=$BACKOFF_MIN; usb_noted=0

while true; do
  # On the cable the Micro switches to USB HID and stops advertising, so there
  # is nothing to reconnect to. Idle instead of scanning into the void.
  if usb_id=$(codex_on_bus 0003); then
    if (( ! usb_noted )); then log "EVENT usb-mode $usb_id"; usb_noted=1; fi
    was_up=0; empty=0; backoff=$BACKOFF_MIN
    sleep 6; continue
  fi
  usb_noted=0

  if id=$(codex_on_bus "$BT_BUS"); then
    if (( ! was_up )); then
      was_up=1; up_since=$(date +%s); attempt=0; empty=0; backoff=$BACKOFF_MIN
      log "EVENT connected $id"
    fi
    sleep 6; continue
  fi

  # transition: up -> down
  if (( was_up )); then
    log "EVENT disconnected after $(( $(date +%s) - up_since ))s"
    was_up=0
  fi

  if addr=$(scan_once); then
    empty=0; backoff=$BACKOFF_MIN
    attempt=$((attempt+1))
    log "EVENT reconnecting $addr attempt $attempt"
    pair_and_connect "$addr"
    sleep 4
    continue
  fi

  # Nothing advertising. Back off so a device that is simply away (asleep, out
  # of range, flat) cannot drive an unbounded scan loop. Hammering LE Set Scan
  # Enable for hours is what wedged the RTL8852BU on 2026-07-27: the controller
  # started returning -110 on opcode 0x2042 and stopped reporting advertisements
  # entirely until btusb was reloaded.
  empty=$((empty+1))
  if (( empty == STALL_AFTER )); then
    log "EVENT radio-stalled — $empty empty scans; check: dmesg | grep 'hci0.*tx timeout'"
    log "  if the adapter is wedged: sudo modprobe -r btusb && sudo modprobe btusb"
  fi
  sleep "$backoff"
  (( backoff < BACKOFF_MAX )) && backoff=$(( backoff * 2 ))
  (( backoff > BACKOFF_MAX )) && backoff=$BACKOFF_MAX
done
