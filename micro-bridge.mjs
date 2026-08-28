// micro-bridge — drive any GUI agent app from the Work Louder Codex Micro.
//
// The Micro is not Codex-locked. Every key, top row and bottom row alike, emits
// a vendor notify `{"m":"v.oai.hid","p":{"k":<key>,"act":1|0|2}}` over BLE-HID;
// the "prompt / voice / send" meanings live in Codex's renderer, not the
// hardware. This reads that channel directly, decides which app you are working
// in, and performs the equivalent action there.
//
//   key press  ->  verb (profiles.json "keys")
//   verb       ->  action for the FOCUSED target (profiles.json "verbs")
//   action     ->  wtype chord | wlrctl focus | shell command
//
// Hardware facts this depends on, all measured 2026-08-28 on firmware v0.4.1:
//   - act: 1 press, 0 release, 2 encoder detent (detents never have a release)
//   - the wide mic cap fires ACT10 AND ACT11 in the same millisecond
//   - ENC_CLK bounces at ~1 ms; detents arrive 15-30 ms apart and must all pass
//   - raw notify fields are ABBREVIATED: {k, act}, not {key, act}
//
// Codex desktop takes exclusive ownership of the hidraw node, so it must be
// closed before this can connect. That is by design: this is a mode you switch
// into, not a co-tenant.
import { KIT_PATH, resolveMac, makeLogger } from "./lib/kit.mjs";
import { watchTarget } from "./lib/target.mjs";
import { makeDispatcher } from "./lib/dispatch.mjs";
import { makeDictation } from "./lib/dictate.mjs";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = process.env.MICRO_BRIDGE_CONFIG || join(HERE, "profiles.json");
const DRY_RUN = process.env.MICRO_BRIDGE_DRYRUN === "1";

const { WLDeviceDiscovery, WLDeviceCommImpl, WLRPCApi } = await import(KIT_PATH);
const kitLog = makeLogger();
const MAC = resolveMac();
const ts = () => new Date().toISOString().slice(11, 19);
const say = (...a) => console.log(`[${ts()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One physical press of the wide mic cap sends two codes. Codex registers that
// slot as ACT10_ACT11 and acts only on ACT10; do the same or everything on that
// key fires twice.
const IGNORED_KEYS = new Set(["ACT11"]);

let cfg;
function loadConfig() {
  cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  const mapped = Object.values(cfg.keys ?? {}).filter(Boolean).length;
  const unresolved = [];
  for (const [t, verbs] of Object.entries(cfg.verbs ?? {}))
    for (const [v, a] of Object.entries(verbs)) if (a == null) unresolved.push(`${t}.${v}`);
  say(`config: ${mapped} keys mapped, ${cfg.targets.length} targets, ${unresolved.length} verbs still unresolved`);
  if (unresolved.length) say(`  unresolved: ${unresolved.join(", ")}`);
}
loadConfig();
process.on("SIGHUP", () => { say("SIGHUP — reloading config"); try { loadConfig(); } catch (e) { say("config error:", e.message); } });

const dispatch = makeDispatcher({ log: say, dryRun: DRY_RUN });
const targets = watchTarget({
  targets: cfg.targets,
  fallback: cfg.fallback,
  log: say,
});

// Live RPC handle, set on connect. Dictation uses it to drive the LEDs, so it
// has to be read lazily rather than captured once at startup.
let rpc = null;

const dictation = makeDictation({
  script: process.env.MICRO_BRIDGE_DICTATE || join(homedir(), ".local/bin/toggle-dictation.sh"),
  log: say,
  getRpc: () => rpc,
  focusApp: (appid, done) =>
    execFile("wlrctl", ["toplevel", "focus", `app_id:${appid}`], { timeout: 5000 }, () => done()),
});

// Debounce presses and releases only. Detents must all be delivered; ENC_CLK
// genuinely bounces and needs it.
const lastFire = new Map();

function onKey({ k, act }) {
  if (IGNORED_KEYS.has(k)) return;
  if (act !== 2) {
    const now = Date.now();
    const id = `${k}:${act}`;
    if (now - (lastFire.get(id) || 0) < 120) return;
    lastFire.set(id, now);
  }

  const verb = cfg.keys?.[k];

  // Push-to-talk is the one verb that needs both edges: hold to record, release
  // to transcribe. Handled before the release guard below.
  if (verb === "dictate") {
    if (DRY_RUN) { say(`▶ ${k} → dictate ${act === 1 ? "start" : "stop"} (dry run)`); return; }
    if (act === 1) dictation.start(targets.active);
    else if (act === 0) dictation.stop();
    return;
  }

  // Every other verb fires on press or detent. Release edges still arrive here,
  // which is the part the old daemon discarded before any binding could see them.
  if (act === 0) return;
  if (verb == null) { if (act === 1) say(`· ${k} (unmapped)`); return; }

  const target = targets.active;
  const action = verb.startsWith("focus:") || verb.startsWith("shell:")
    ? verb
    : cfg.verbs?.[target?.name]?.[verb] ?? null;

  dispatch({ verb, action, target, key: k });
}

const bleConnect = () =>
  new Promise((r) => execFile("bluetoothctl", ["connect", MAC], { timeout: 15000 }, () => r()));

async function findMicro() {
  const disc = new WLDeviceDiscovery(kitLog);
  const list = await Promise.resolve(disc.findWLDevices());
  return list.find((d) => d.deviceType === "codex_micro") || list[0];
}

async function loop() {
  say(`micro-bridge starting${DRY_RUN ? " (DRY RUN — logging only)" : ""}`);
  for (;;) {
    let dev = await findMicro();
    if (!dev) { await bleConnect(); await sleep(1500); dev = await findMicro(); }
    if (!dev) { await sleep(2500); continue; }

    const comm = new WLDeviceCommImpl(kitLog);
    let down = false;
    comm.onConnectionEvent((e) => { if (e.type !== 0) down = true; });

    if (!(await comm.connect(dev).catch(() => false))) {
      // The usual cause is Codex desktop holding the node. Say so, since the
      // kit's own error does not.
      say("connect failed — is Codex desktop running and holding /dev/hidraw*?");
      await sleep(3000);
      continue;
    }
    comm.addNotifyHandler("v.oai.hid", onKey);
    rpc = new WLRPCApi(comm, kitLog);
    say(`✅ connected @ ${dev.portPath} — active target: ${targets.active?.label ?? "none"}`);

    while (!down) await sleep(300);
    say("link dropped — reconnecting…");
    rpc = null;
    dictation.reset();
    try { await comm.disconnect(); } catch {}
    await sleep(500);
  }
}

process.on("SIGINT", () => { say("stopping"); targets.stop(); process.exit(0); });
loop().catch((e) => { console.error("fatal:", e); process.exit(1); });
