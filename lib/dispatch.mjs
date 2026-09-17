// Execute a verb against the active target.
//
// Every verb resolves to one of three things:
//   a chord   -> synthesised keystroke via wtype (the GUI path)
//   focus:X   -> window activation via wlrctl, target-independent
//   shell:X   -> arbitrary command, the escape hatch
//
// A verb the active profile does not define is NOT silently swallowed and is
// NOT guessed at: it logs as unresolved. A macropad that quietly does the wrong
// thing in the wrong app is worse than one that does nothing.
import { execFile } from "node:child_process";
import { appidVariants, wlrctlFocusArgs } from "./identity.mjs";

export function chordToWtypeArgs(chord) {
  const parts = String(chord).split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const key = parts.pop();
  const keyMods = parts.map((m) => m.toLowerCase());
  const args = [];
  for (const m of keyMods) args.push("-M", m);
  args.push("-k", key);
  for (const m of [...keyMods].reverse()) args.push("-m", m);
  return args;
}

const run = (cmd, args, cb) =>
  execFile(cmd, args, { timeout: 10000 }, (err) => cb(err ?? null));

export function chordToHoldArgs(chord) {
  const parts = String(chord).split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const key = parts.pop();
  const mods = parts.map((m) => m.toLowerCase());
  const down = [];
  for (const m of mods) down.push("-M", m);
  down.push("-P", key);
  const up = ["-p", key];
  for (const m of [...mods].reverse()) up.push("-m", m);
  return { down, up };
}

export function sendWtype(args, { log = () => {}, dryRun = false, what = "" } = {}) {
  if (dryRun) { log(`  (dry run) wtype ${args.join(" ")}`); return; }
  run("wtype", args, (err) => {
    if (err) log(`  ✗ ${what || "wtype"}: ${err.message.split("\n")[0]}`);
  });
}

export function makeDispatcher({ log = () => {}, dryRun = false, focusIds = appidVariants } = {}) {
  return function dispatch({ verb, action, target, key }) {
    const where = target?.label ?? target?.name ?? "no target";

    if (action == null) {
      log(`✗ ${key} → ${verb} · not defined for ${where} (needs input)`);
      return;
    }

    if (typeof action === "string" && action.startsWith("focus:")) {
      const appid = action.slice(6);
      const ids = focusIds(appid);
      log(`▶ ${key} → focus ${ids.join(" | ")}`);
      if (dryRun) return;
      run("wlrctl", wlrctlFocusArgs(ids), (err) => {
        if (err) log(`  ✗ focus ${ids.join(" | ")}: ${err.message.split("\n")[0]}`);
      });
      return;
    }

    if (typeof action === "string" && action.startsWith("shell:")) {
      const cmd = action.slice(6);
      log(`▶ ${key} → shell: ${cmd}`);
      if (dryRun) return;
      run("/bin/sh", ["-c", cmd], (err) => {
        if (err) log(`  ✗ ${verb}: ${err.message.split("\n")[0]}`);
      });
      return;
    }

    const args = chordToWtypeArgs(action);
    if (args == null) {
      log(`✗ ${key} → ${verb} · unparseable action ${JSON.stringify(action)}`);
      return;
    }
    log(`▶ ${key} → ${verb} [${action}] in ${where}`);
    if (dryRun) return;
    run("wtype", args, (err) => {
      if (err) log(`  ✗ ${verb}: ${err.message.split("\n")[0]}`);
    });
  };
}
