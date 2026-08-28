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
// hidraw allows MULTIPLE concurrent readers, so this and Codex desktop can and
// do hold the same node at once — measured: /dev/hidraw6 open in both `node
// micro-bridge.mjs` and Codex's Electron. Both then act on the same key, which
// is why the mic key produced two transcriptions. The fix is the passthrough
// list in profiles.json, not shutting Codex down.
import { KIT_PATH, resolveMac, makeLogger } from "./lib/kit.mjs";
import { watchTarget } from "./lib/target.mjs";
import { makeDispatcher, chordToHoldArgs, sendWtype } from "./lib/dispatch.mjs";
import { makeDictation } from "./lib/dictate.mjs";
import { makePainter, Preset, Colour } from "./lib/lighting.mjs";
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
// Declared before watchTarget because its onChange closure reads it: a const
// declared later would sit in its temporal dead zone and throw if the
// compositor emitted a focus change before this module finished evaluating.
let dictation = null;

const targets = watchTarget({
  targets: cfg.targets,
  fallback: cfg.fallback,
  log: say,
  onChange: (t) => { if (!dictation?.recording) paintTarget(t); },
});

// Live RPC handle, set on connect. Dictation uses it to drive the LEDs, so it
// has to be read lazily rather than captured once at startup.
let rpc = null;

const paint = makePainter({ getRpc: () => rpc, log: say });

dictation = makeDictation({
  script: process.env.MICRO_BRIDGE_DICTATE || join(homedir(), ".local/bin/toggle-dictation.sh"),
  log: say,
  paint,
  focusApp: (appid, done) =>
    execFile("wlrctl", ["toplevel", "focus", `app_id:${appid}`], { timeout: 5000 }, () => done()),
});

// Show which target the keys will act on. Neither Cursor nor Grokbot exposes
// agent state to query, so per-target colour is the honest version of status
// lighting: it answers "where will this key go?", which is the question the
// sticky-target rule makes worth asking.
function paintTarget(t) {
  const colour = t?.name ? cfg.targetColours?.[t.name] : null;
  if (colour == null) { paint(Preset.off(), "target"); return; }
  paint(Preset.target(typeof colour === "string" ? parseInt(colour, 16) : colour), `target ${t.name}`);
}

// Use the app's OWN dictation where it has one, and the local Parakeet pipeline
// where it does not. Terminals are the clearest "does not" case, which is where
// the CLI agents live.
//
//   "parakeet"                     local pipeline, hold to record
//   { hold: "<chord>" }            hold a chord for as long as the mic key is
//                                  held, for apps whose hotkey is push-to-talk
//   { start: "<c>", stop: "<c>" }  separate start and stop commands
let heldChord = null;

function handleDictate(k, act, strategy) {
  if (strategy == null) {
    if (act === 1) say(`✗ ${k} → dictate · not defined for ${targets.active?.label ?? "no target"} (needs input)`);
    return;
  }

  if (strategy === "parakeet") {
    if (DRY_RUN) { say(`▶ ${k} → dictate ${act === 1 ? "start" : "stop"} · parakeet (dry run)`); return; }
    if (act === 1) dictation.start(targets.active);
    else if (act === 0) dictation.stop();
    return;
  }

  if (typeof strategy === "object" && strategy.hold) {
    const args = chordToHoldArgs(strategy.hold);
    if (args == null) { say(`✗ ${k} → dictate · unparseable hold ${JSON.stringify(strategy.hold)}`); return; }
    if (act === 1) {
      say(`▶ ${k} → dictate hold ${strategy.hold} in ${targets.active?.label}`);
      heldChord = args;
      sendWtype(args.down, { log: say, dryRun: DRY_RUN, what: "dictate down" });
    } else if (act === 0 && heldChord) {
      // Release whatever was actually pressed, not what the config says now:
      // profiles.json can be reloaded with SIGHUP mid-hold, and leaving a
      // modifier stuck down would wreck every subsequent keystroke.
      sendWtype(heldChord.up, { log: say, dryRun: DRY_RUN, what: "dictate up" });
      heldChord = null;
    }
    return;
  }

  if (typeof strategy === "object" && (strategy.start || strategy.stop)) {
    const chord = act === 1 ? strategy.start : strategy.stop;
    if (!chord) return;
    say(`▶ ${k} → dictate ${act === 1 ? "start" : "stop"} [${chord}] in ${targets.active?.label}`);
    dispatch({ verb: "dictate", action: chord, target: targets.active, key: k });
    return;
  }

  if (act === 1) say(`✗ ${k} → dictate · unknown strategy ${JSON.stringify(strategy)}`);
}

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

  // PASSTHROUGH. Codex desktop reads the same hidraw node as we do (hidraw
  // allows multiple concurrent readers) and acts on the same keys with its own
  // native Micro integration. Acting here too makes every key fire twice —
  // most visibly the mic key, which produced two transcriptions. While a
  // passthrough app has focus, the device belongs to it.
  const focused = targets.focused;
  if (focused && cfg.passthrough?.includes(focused)) {
    if (act === 1) say(`· ${k} → passthrough (${focused} owns the device)`);
    return;
  }

  const verb = cfg.keys?.[k];

  // Push-to-talk is the one verb that needs both edges: hold to record, release
  // to transcribe. Handled before the release guard below.
  if (verb === "dictate") {
    const strategy = cfg.verbs?.[targets.active?.name]?.dictate ?? null;
    handleDictate(k, act, strategy);
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
      say("connect failed — check the device is awake and the hidraw node is readable");
      await sleep(3000);
      continue;
    }
    comm.addNotifyHandler("v.oai.hid", onKey);
    rpc = new WLRPCApi(comm, kitLog);
    say(`✅ connected @ ${dev.portPath} — active target: ${targets.active?.label ?? "none"}`);
    paintTarget(targets.active);

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
