// Locate the Work Louder device kit and resolve the Micro's BLE address.
//
// The kit (@worklouder/wl-device-kit) is PROPRIETARY and is NOT bundled with
// this project. You supply it by pointing MICRO_HERDR_KIT at the copy inside
// your installed Work Louder "Input" app, e.g.
//   .../Input/resources/app.asar.unpacked/node_modules/@worklouder/wl-device-kit/dist/index.js
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

// Kit path: env override, else a few common install locations.
const KIT_CANDIDATES = [
  process.env.MICRO_HERDR_KIT,
  `${process.env.HOME}/projects/input-linux/input-app-0.17.2/node_modules/@worklouder/wl-device-kit/dist/index.js`,
  "/opt/Input/resources/app.asar.unpacked/node_modules/@worklouder/wl-device-kit/dist/index.js",
].filter(Boolean);

export const KIT_PATH = KIT_CANDIDATES.find((p) => existsSync(p)) || KIT_CANDIDATES[0];

if (!KIT_PATH || !existsSync(KIT_PATH)) {
  console.error(
    "micro-herdr: could not find @worklouder/wl-device-kit.\n" +
      "Set MICRO_HERDR_KIT to its dist/index.js inside your installed Work Louder Input app.\n" +
      "The kit is proprietary and is not distributed with this project."
  );
  process.exit(2);
}

// BLE address of the Codex Micro: env override, else auto-detect from bluetoothctl.
export function resolveMac() {
  if (process.env.MICRO_HERDR_MAC) return process.env.MICRO_HERDR_MAC;
  try {
    const out = execFileSync("bluetoothctl", ["devices"], { encoding: "utf8" });
    const line = out.split("\n").find((l) => /codex micro|work ?louder/i.test(l));
    const mac = line?.match(/([0-9A-F]{2}:){5}[0-9A-F]{2}/i)?.[0];
    if (mac) return mac;
  } catch {}
  return null; // caller falls back to HID discovery only
}

export function makeLogger(prefix = "") {
  const on = process.env.MHDEBUG === "1";
  const p = prefix ? `${prefix} ` : "";
  return {
    info: (...a) => on && console.error(`[i]${p}`, ...a),
    error: (...a) => console.error(`[E]${p}`, ...a),
    debug: (...a) => on && console.error(`[d]${p}`, ...a),
    warn: (...a) => on && console.error(`[w]${p}`, ...a),
  };
}

// Device -> host vendor notify methods.
//
// The two v.oai.* entries are the ones the Codex Micro actually emits, and they
// were missing: without them probe.mjs registers handlers for methods the device
// never sends and logs nothing while keys are pressed.
//
// Raw notify payloads use ABBREVIATED field names, unlike the shapes described in
// @worklouder/device-kit-oai's .d.ts files (those describe what that kit hands to
// Codex after normalising):
//   v.oai.hid -> { k: "ACT06", act: 1|0|2, agent?: number }   NOT { key, ... }
//   v.oai.rad -> { a: 0..1, d: 0..1 }                          NOT { angle, distance }
// act: 1 = press, 0 = release, 2 = encoder detent (never has a release edge).
export const NOTIFY_METHODS = [
  "v.oai.hid",
  "v.oai.rad",
  "kb.sa.exec",
  "kb.sa.inserttext",
  "kb.sa.openapp",
  "kb.sa.openurl",
  "kb.radial",
  "kb.cs.show",
  "kb.cs.hide",
  "kb.cs.toggle",
  "alert.generic",
  "mp.fetch_data",
  "diag.report",
];
