// One-shot: remap the Codex Micro encoder from the inert KV_OAI_ENC_* codes to
// standard HID volume codes, so the knob controls system volume natively.
//   node set-encoder.mjs           -> volume (CC=VOLD, CW=VOLU, CLK=MUTE)
//   node set-encoder.mjs restore   -> restore backups/keymap.json.orig
// Reversible: original keymap is in backups/keymap.json.orig.
import { KIT_PATH, resolveMac, makeLogger } from "./lib/kit.mjs";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const RESTORE = process.argv[2] === "restore";
const { WLDeviceDiscovery, WLDeviceCommImpl, WLRPCApi } = await import(KIT_PATH);
const log = makeLogger();
const MAC = resolveMac();
const ble = () => new Promise((r) => execFile("bluetoothctl", ["connect", MAC], { timeout: 15000 }, () => r()));

async function main() {
  const disc = new WLDeviceDiscovery(log);
  let dev;
  for (let i = 0; i < 10 && !dev; i++) {
    const list = await Promise.resolve(disc.findWLDevices());
    dev = list.find((d) => d.deviceType === "codex_micro") || list[0];
    if (!dev) { await ble(); await new Promise((r) => setTimeout(r, 2000)); }
  }
  if (!dev) { console.log("device not found — wake it"); process.exit(1); }

  const comm = new WLDeviceCommImpl(log);
  if (!(await comm.connect(dev))) { console.log("connect failed"); process.exit(1); }
  const rpc = new WLRPCApi(comm, log);

  const read = async () => (await rpc.readFile("keymap.json")).data;
  let km = await read();
  console.log("current encoders:", km.match(/"encoders":\[\[[^\]]*\]\]/)?.[0]);

  // Never write the device keymap without a restorable copy of the original.
  // `restore` has always read this file, but nothing ever wrote it — so running
  // this script used to be a one-way door.
  const BACKUP_DIR = new URL("./backups/", import.meta.url);
  const BACKUP = new URL("./backups/keymap.json.orig", import.meta.url);
  if (!RESTORE && !existsSync(BACKUP)) {
    mkdirSync(BACKUP_DIR, { recursive: true });
    writeFileSync(BACKUP, km);
    console.log(`backed up original keymap -> backups/keymap.json.orig (${km.length}b)`);
  }

  let next;
  if (RESTORE) {
    if (!existsSync(BACKUP)) {
      console.log("!! no backups/keymap.json.orig to restore from — aborting");
      await comm.disconnect().catch(() => {});
      process.exit(1);
    }
    next = JSON.parse(readFileSync(BACKUP, "utf8"));
    next = JSON.stringify(next);
  } else {
    // CC (counter-clockwise) -> VOLD, CW (clockwise) -> VOLU, CLK (click) -> MUTE
    next = km.replace(
      /"encoders":\[\[[^\]]*\]\]/,
      '"encoders":[["KC_VOLD","KC_VOLU","KC_MUTE"]]'
    );
    if (next === km) { console.log("!! encoder pattern not found — aborting"); process.exit(1); }
  }

  console.log("writing keymap.json…");
  await rpc.writeFile("keymap.json", next);
  await new Promise((r) => setTimeout(r, 400));

  const after = await read();
  console.log("new encoders:    ", after.match(/"encoders":\[\[[^\]]*\]\]/)?.[0]);
  console.log(after.includes(RESTORE ? "KV_OAI_ENC" : "KC_VOLU") ? "✅ applied" : "⚠️ verify failed");

  await comm.disconnect().catch(() => {});
  process.exit(0);
}
main().catch((e) => { console.error("fatal:", e); process.exit(1); });
