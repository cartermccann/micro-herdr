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
//
// CHORDS ARE FOCUSED FIRST. wtype delivers to whatever the compositor considers
// focused at the instant the key event lands, which is not necessarily the
// sticky target the chord was chosen for. Both machines focus on pointer hover
// (mango sloppyfocus, Hyprland focus_follows_mouse), so resting the mouse over a
// browser while the target is still Cursor used to send Cursor's Return into the
// browser. The target picks the chord, so the target must also receive it:
// ensureFocus puts the window up first, and refuses to type when it cannot.
// Same reasoning as the latch-and-refocus in dictate.mjs, one keypress shorter.
import { execFile } from "node:child_process";
import { allAppidsForTarget, appidVariants, canonicalAppid, wlrctlFocusArgs } from "./identity.mjs";

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

export function sendWtype(args, { log = () => {}, dryRun = false, what = "", exec = run } = {}) {
  if (dryRun) { log(`  (dry run) wtype ${args.join(" ")}`); return; }
  exec("wtype", args, (err) => {
    if (err) log(`  ✗ ${what || "wtype"}: ${err.message.split("\n")[0]}`);
  });
}

// Hold-to-talk: one chord held down across two key edges.
//
// This is the other call path with the problem the header describes, and it
// needs more than a focus call on each edge. `down` is sent from an ASYNC focus
// callback, so a fast release can arrive first; without a guard the release
// would go out, the focus would then land, and the press would be sent with
// nothing left to release it. That is the phantom held key this is meant to
// avoid, so each press takes a sequence number and a release invalidates it.
//
// The release is sent even when its focus attempt fails: a key left down is
// worse than a release landing in the wrong window.
//
// NOTE: wtype destroys its virtual keyboard when the process exits, so a hold
// split across two invocations does not actually persist (see _grounded
// "grokbot.dictate" in profiles.json). No target uses `hold` today for that
// reason; this keeps the path honest rather than pretending it works.
export function makeHoldPress({
  log = () => {},
  dryRun = false,
  ensureFocus = (_t, done) => done(null),
  exec = run,
} = {}) {
  let held = null;
  let seq = 0;

  const fire = (args, what) => {
    if (dryRun) { log(`  (dry run) wtype ${args.join(" ")}`); return; }
    exec("wtype", args, (e) => { if (e) log(`  ✗ ${what}: ${e.message.split("\n")[0]}`); });
  };

  return {
    get isHeld() { return held != null; },

    down(target, chord, key) {
      const args = chordToHoldArgs(chord);
      if (args == null) { log(`✗ ${key} → unparseable hold ${JSON.stringify(chord)}`); return; }
      const mine = ++seq;
      held = { args, target, seq: mine, sent: false };
      ensureFocus(target, (err) => {
        if (held?.seq !== mine) return;
        if (err) { log(`  ✗ hold down: ${err.message}`); held = null; return; }
        held.sent = true;
        fire(args.down, "hold down");
      });
    },

    up(key) {
      const h = held;
      held = null;
      seq += 1;
      if (h == null) return;
      if (!h.sent) { log(`· ${key} → released before focus landed, nothing was sent`); return; }
      ensureFocus(h.target, (err) => {
        if (err) log(`  ✗ hold up: ${err.message} (sending the release anyway)`);
        fire(h.args.up, "hold up");
      });
    },

    reset() { held = null; seq += 1; },
  };
}

// Raise the target's window and confirm it actually took focus.
//
// The confirmation polls the compositor's OWN focus signal (the same stream
// lib/target.mjs already listens to) rather than sleeping a guessed interval:
// wlrctl exits when the activation request is sent, not when it is honoured.
// settleMs is a short pause after that, because a compositor can report the
// focus change a frame before the surface is ready for synthetic input.
//
// With no focus signal to compare against (no compositor backend, or the very
// first keypress before the watcher has seen a focus change) the raise still
// goes out; only the CONFIRMATION is skipped, and a failed raise then sends the
// chord anyway rather than swallowing it. Skipping the raise as well would have
// left the original bug live in exactly that window. A target with no appid to
// aim at is the one case with nothing to raise, so it passes straight through.
export function makeFocuser({
  log = () => {},
  getFocused = () => null,
  settleMs = 60,
  timeoutMs = 400,
  pollMs = 20,
  dryRun = false,
  exec = run,
} = {}) {
  return function ensureFocus(target, done) {
    const ids = allAppidsForTarget(target);
    if (!ids.length) { done(null); return; }

    const want = new Set(ids.map(canonicalAppid));
    const name = target?.label ?? target?.name ?? "target";
    const focused = getFocused();
    const blind = focused == null;
    if (!blind && want.has(canonicalAppid(focused))) { done(null); return; }
    if (dryRun) { log(`  (dry run) focus ${name} first (${ids.join(" | ")})`); done(null); return; }

    exec("wlrctl", wlrctlFocusArgs(ids), (err) => {
      if (err) {
        if (blind) { done(null); return; }
        done(new Error(`could not focus ${name}: ${err.message.split("\n")[0]}`));
        return;
      }
      if (blind) { setTimeout(() => done(null), settleMs); return; }
      const deadline = Date.now() + timeoutMs;
      const poll = () => {
        const now = getFocused();
        if (now && want.has(canonicalAppid(now))) { setTimeout(() => done(null), settleMs); return; }
        if (Date.now() >= deadline) {
          done(new Error(`focus did not land on ${name} (still ${now ?? "unknown"})`));
          return;
        }
        setTimeout(poll, pollMs);
      };
      poll();
    });
  };
}

export function makeDispatcher({
  log = () => {},
  dryRun = false,
  focusIds = appidVariants,
  ensureFocus = (_t, done) => done(null),
  exec = run,
} = {}) {
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
      exec("wlrctl", wlrctlFocusArgs(ids), (err) => {
        if (err) log(`  ✗ focus ${ids.join(" | ")}: ${err.message.split("\n")[0]}`);
      });
      return;
    }

    if (typeof action === "string" && action.startsWith("shell:")) {
      const cmd = action.slice(6);
      log(`▶ ${key} → shell: ${cmd}`);
      if (dryRun) return;
      exec("/bin/sh", ["-c", cmd], (err) => {
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
    ensureFocus(target, (err) => {
      if (err) { log(`  ✗ ${verb}: ${err.message}`); return; }
      exec("wtype", args, (e) => {
        if (e) log(`  ✗ ${verb}: ${e.message.split("\n")[0]}`);
      });
    });
  };
}
