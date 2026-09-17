# micro-herdr

Turn the **OpenAI Codex Micro** (Work Louder macropad) into a physical control
surface for AI coding agents on **Linux**, over Bluetooth.

The Codex Micro officially integrates only with ChatGPT Desktop on macOS/Windows.
This bridges it to [herdr](https://herdr.dev) (or any shell command) on Linux:
map its keys to agent actions, and drive its RGB from live agent status.

> Built for and tested with herdr + a niri/PipeWire NixOS setup, but the binding
> layer is just "key → shell command", so it adapts to anything.

The **GUI-agent bridge** (`micro-bridge.mjs`, this branch) drives Cursor and
Grokbot from the same keys. Sticky-target matching compares a canonical
`app_id` (lowercase, spaces to hyphens) because Hyprland reports Electron's
productName (`Grok Bot`, `Cursor`) while mango on atlas reported the hyphenated
desktop ids. `wlrctl toplevel focus` is called with every spelling; repeated
`app_id:` keys are OR.

## What it does

- **Agent keys → herdr** — focus agents, approve/deny the blocked one, show status
- **Status LEDs** — keys glow red-breathing when an agent is blocked, teal when
  working, off when idle (polls `herdr agent list`)
- **Volume knob** — remap the encoder to native HID volume codes (`set-encoder.mjs`)
- Runs as a **systemd user service** with automatic BLE reconnect

## How it works

The Micro's keys emit vendor notifies `{"m":"v.oai.hid","p":{"k":<key>,"act":1|0}}`
over BLE-HID. `micro-herdrd.mjs` connects via the Work Louder device kit, listens
for those, and runs the shell command bound to each key. Key codes: `AG00`–`AG05`
(agent keys), `ACT06`–`ACT12` (action keys).

## Requirements

- Linux with BlueZ (`bluetoothctl`) and Node.js ≥ 20
- The Codex Micro paired over Bluetooth
- **`@worklouder/wl-device-kit`** — proprietary, **NOT included**. It ships inside
  the Work Louder "Input" desktop app; point `MICRO_HERDR_KIT` at its
  `.../@worklouder/wl-device-kit/dist/index.js`. (See
  [worklouder/input-linux](https://github.com/worklouder/input-linux) for building
  Input on Linux.)
- `herdr` and `jq` on `PATH` for the default bindings; `wpctl` for the volume remap

## Setup

```sh
export MICRO_HERDR_KIT=/path/to/@worklouder/wl-device-kit/dist/index.js
# MICRO_HERDR_MAC is auto-detected from bluetoothctl; set it to override.

# try it in the foreground
node micro-herdrd.mjs

# install as a user service (edit the ExecStart path in the unit first)
cp micro-herdr.service ~/.config/systemd/user/
systemctl --user enable --now micro-herdr
```

Optional — make the knob control system volume (writes the device keymap;
original is backed up locally, restore with `node set-encoder.mjs restore`;
**power-cycle the Micro afterward** so firmware reloads it):

```sh
node set-encoder.mjs
```

## Configuring keys

Edit `bindings.json` (`key → shell command`, fired on press; empty = ignore),
then reload:

```sh
systemctl --user reload micro-herdr    # or: pkill -HUP -f micro-herdrd
```

Find which code a physical key sends: `journalctl --user -u micro-herdr -f`, then
press it. Helper verbs for herdr live in `bin/mh`
(`focus-nth`, `cycle`, `status`, `approve`, `deny`).

## Files

| file | purpose |
|------|---------|
| `micro-herdrd.mjs` | the daemon — key router, status LEDs, BLE reconnect |
| `bindings.json` | your key map (hot-reloads on SIGHUP) |
| `bin/mh` | herdr helper verbs |
| `lib/kit.mjs` | kit-path + MAC resolution + shared logger |
| `lib/identity.mjs` | match Hyprland/mango Electron `app_id` spellings (`Grok Bot` vs `grok-bot`) |
| `lib/compositor.mjs` | mango vs Hyprland focus backends |
| `set-encoder.mjs` | remap the encoder to volume codes (and restore) |
| `probe.mjs` / `inspect.mjs` | dev tools: log raw events / dump device config |

## Notes & disclaimer

Unofficial, unaffiliated with OpenAI or Work Louder. It interoperates with the
Codex Micro over Bluetooth using Work Louder's own device kit, which you must
supply yourself — no proprietary code is redistributed here. Use at your own risk.

The Micro speaks the same vendor HID protocol over **USB as well as Bluetooth**.
An earlier version of this README claimed USB-C was charge-only. That is wrong:
on firmware v0.4.1 it enumerates as `303a:8360` on the USB bus and the bridge
connects over it. Prefer USB where you can, because the node is stable, with no
rotating BLE address and no reconnect loop. One caveat: the `hidraw` number is
*not* stable across reconnects, so always go through device discovery rather than
a hardcoded path.
