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

// "ctrl+shift+l" -> wtype argv. wtype presses modifiers with -M, taps a keysym
// with -k and releases with -m, so the modifier stack unwinds in reverse.
export function chordToWtypeArgs(chord) {
  const parts = String(chord).split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const key = parts.pop();
  const mods = parts.map((m) => m.toLowerCase());
  const args = [];
  for (const m of mods) args.push("-M", m);
  args.push("-k", key);
  for (const m of [...mods].reverse()) args.push("-m", m);
  return args;
}

const run = (cmd, args, cb) =>
  execFile(cmd, args, { timeout: 10000 }, (err) => cb(err ?? null));

export function makeDispatcher({ log = () => {}, dryRun = false } = {}) {
  return function dispatch({ verb, action, target, key }) {
    const where = target?.label ?? target?.name ?? "no target";

    if (action == null) {
      log(`✗ ${key} → ${verb} · not defined for ${where} (needs input)`);
      return;
    }

    if (typeof action === "string" && action.startsWith("focus:")) {
      const appid = action.slice(6);
      log(`▶ ${key} → focus ${appid}`);
      if (dryRun) return;
      // Best effort by design: with sloppyfocus the pointer can reclaim focus
      // moments later. Decided 2026-08-28 to accept that rather than warp the
      // pointer, which acceleration makes unreliable.
      run("wlrctl", ["toplevel", "focus", `app_id:${appid}`], (err) => {
        if (err) log(`  ✗ focus ${appid}: ${err.message.split("\n")[0]}`);
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
