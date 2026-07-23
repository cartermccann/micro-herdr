// micro-herdrd — bridge the Work Louder Codex Micro to herdr / shell on Linux.
//
// The Micro's keys (AG00-05 agent keys, ACT06-12 action keys, ENC_* encoder)
// emit vendor notifies `{"m":"v.oai.hid","p":{"k":<key>,"act":1|0}}` over BLE-HID.
// This daemon connects via the WL kit, listens for those, and runs the shell
// command bound to each key on press. Config: bindings.json (SIGHUP to reload).
//
// Requires @worklouder/wl-device-kit (proprietary, NOT bundled) — see lib/kit.mjs.
import { KIT_PATH, resolveMac, makeLogger } from "./lib/kit.mjs";
import { execFile, exec } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BINDINGS_FILE = process.env.MH_BINDINGS || join(HERE, "bindings.json");

const { WLDeviceDiscovery, WLDeviceCommImpl, WLRPCApi } = await import(KIT_PATH);
const log = makeLogger();
const MAC = resolveMac();
const ts = () => new Date().toISOString().slice(11, 19);
const say = (...a) => console.log(`[${ts()}]`, ...a);

let bindings = {};
function loadBindings() {
  try {
    bindings = JSON.parse(readFileSync(BINDINGS_FILE, "utf8")).bindings || {};
    say(`loaded ${Object.keys(bindings).filter((k) => bindings[k]).length} active bindings from ${BINDINGS_FILE}`);
  } catch (e) {
    say("bindings load error:", e.message);
  }
}
loadBindings();
process.on("SIGHUP", () => { say("SIGHUP — reloading bindings"); loadBindings(); });

function runBinding(cmd, key) {
  say(`▶ ${key} → ${cmd}`);
  exec(cmd, { timeout: 15000, env: process.env }, (err, out, errout) => {
    if (err) say(`  ✗ ${key}: ${err.message.split("\n")[0]}`);
    else if (out?.trim()) say(`  ✓ ${key}: ${out.trim().split("\n")[0].slice(0, 120)}`);
  });
}

// Debounce so a key that emits act:1 twice quickly fires once.
const lastFire = new Map();
function onKey({ k, act }) {
  if (act !== 1) return;                       // press only
  const now = Date.now();
  if (now - (lastFire.get(k) || 0) < 120) return;
  lastFire.set(k, now);
  const cmd = bindings[k];
  if (cmd) runBinding(cmd, k);
  else say(`· ${k} (unbound)`);
}

const bleConnect = () =>
  new Promise((r) => execFile("bluetoothctl", ["connect", MAC], { timeout: 15000 }, () => r()));

// ---- Fleet-status LEDs -----------------------------------------------------
// Poll `herdr agent list` and drive the Micro's backlight + underglow:
//   any agent blocked  -> red breathing (attention!)
//   any agent working  -> calm dim teal, solid
//   all idle / none    -> LEDs off
const LIGHT_STATES = {
  blocked: {
    backlight: { effect: "breath", brightness: 220, speed: 160, color: 0xff2222 },
    underglow: { effect: "breath", brightness: 220, speed: 160, color: 0xff2222 },
  },
  working: {
    backlight: { effect: "solid", brightness: 70, speed: 0, color: 0x18b2a6 },
    underglow: { effect: "solid", brightness: 40, speed: 0, color: 0x18b2a6 },
  },
  idle: {
    backlight: { effect: "off", brightness: 0, speed: 0, color: 0x000000 },
    underglow: { effect: "off", brightness: 0, speed: 0, color: 0x000000 },
  },
};

function fleetState(cb) {
  exec("herdr agent list", { timeout: 8000 }, (err, out) => {
    if (err) return cb(null);
    try {
      const agents = JSON.parse(out).result.agents || [];
      const statuses = agents.map((a) => a.agent_status);
      if (statuses.includes("blocked")) return cb("blocked");
      if (statuses.includes("working")) return cb("working");
      return cb("idle");
    } catch { cb(null); }
  });
}

function startStatusLeds(rpc) {
  let last = null;
  const tick = () =>
    fleetState((state) => {
      if (!state || state === last) return;
      last = state;
      say(`fleet → ${state} (LEDs)`);
      rpc.sendLightingPreview(LIGHT_STATES[state]).catch(() => {});
    });
  tick();
  const iv = setInterval(tick, 3000);
  return () => clearInterval(iv);
}

async function findMicro() {
  const disc = new WLDeviceDiscovery(log);
  const list = await Promise.resolve(disc.findWLDevices());
  return list.find((d) => d.deviceType === "codex_micro") || list[0];
}

async function loop() {
  say("micro-herdrd starting — waiting for Codex Micro…");
  for (;;) {
    let dev = await findMicro();
    if (!dev) { await bleConnect(); await sleep(1500); dev = await findMicro(); }
    if (!dev) { await sleep(2500); continue; }

    const comm = new WLDeviceCommImpl(log);
    let down = false;
    comm.onConnectionEvent((e) => { if (e.type !== 0) down = true; });

    if (!(await comm.connect(dev).catch(() => false))) { await sleep(2000); continue; }
    comm.addNotifyHandler("v.oai.hid", onKey);
    say(`✅ connected @ ${dev.portPath} — Codex Micro live`);

    const rpc = new WLRPCApi(comm, log);
    const stopLeds = startStatusLeds(rpc);

    while (!down) await sleep(300);
    say("link dropped — reconnecting…");
    stopLeds();
    try { await comm.disconnect(); } catch {}
    await sleep(500);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.on("SIGINT", () => { say("stopping"); process.exit(0); });
loop().catch((e) => { console.error("fatal:", e); process.exit(1); });
