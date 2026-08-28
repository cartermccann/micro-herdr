// Push-to-talk for the mic key.
//
// Reuses ~/.local/bin/toggle-dictation.sh unmodified. That script is already a
// toggle: the first invocation starts pw-record, the second stops it, runs the
// transcript through Parakeet and types it with wtype. Calling it on press and
// again on release therefore gives hold-to-talk on top of a pipeline that is
// already tested, rather than reimplementing recording and transcription here.
//
// The target is LATCHED at press time and refocused just before the transcript
// is typed. Dictation picks its destination seconds after you start talking, and
// with sloppyfocus=1 the pointer may have wandered in between, so latching is
// what stops a sentence landing in a browser you happened to move the mouse over.
//
// LED states mirror Codex's own constants so muscle memory carries across:
// sea green while recording, white while processing, off when idle.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

const RECORDING = 0x2e8b57;   // Codex uses sea green while recording
const PROCESSING = 0xffffff;  // and white while transcribing

// The base kit's sendLightingPreview takes brightness 0-255, unlike the OAI
// layer's normalised 0-1. Do not mix the two.
const lights = (color, brightness, effect, speed) => ({
  backlight: { effect, brightness, speed, color },
  underglow: { effect, brightness, speed, color },
});

const OFF = lights(0x000000, 0, "off", 0);

export function makeDictation({ script, log = () => {}, getRpc = () => null, focusApp = null }) {
  let recording = false;
  let latched = null;

  const paint = (cfg) => {
    const rpc = getRpc();
    if (rpc == null) return;
    Promise.resolve(rpc.sendLightingPreview(cfg)).catch(() => {});
  };

  const runScript = (cb) =>
    execFile(script, [], { timeout: 120000 }, (err, out, errout) => cb(err ?? null, out, errout));

  return {
    get recording() { return recording; },

    start(target) {
      if (!existsSync(script)) { log(`✗ dictate: ${script} not found`); return; }
      if (recording) { log("· dictate: already recording"); return; }
      recording = true;
      latched = target;
      log(`▶ dictate start · target latched to ${target?.label ?? target?.name ?? "none"}`);
      paint(lights(RECORDING, 200, "solid", 0));
      runScript((err) => {
        if (err) { log(`  ✗ dictate start: ${err.message.split("\n")[0]}`); recording = false; paint(OFF); }
      });
    },

    stop() {
      if (!recording) return;
      recording = false;
      log("▶ dictate stop · transcribing");
      paint(lights(PROCESSING, 200, "solid", 0));

      // Put focus back where it was when you started speaking, then let the
      // script type. Best effort: sloppyfocus can reclaim focus, but it only
      // has to hold for the instant wtype delivers the text.
      const then = () => runScript((err, out) => {
        if (err) log(`  ✗ dictate stop: ${err.message.split("\n")[0]}`);
        else log(`  ✓ dictate done${out?.trim() ? `: ${out.trim().slice(0, 80)}` : ""}`);
        paint(OFF);
      });

      if (latched?.appid && focusApp) focusApp(latched.appid, then);
      else then();
    },

    reset() { recording = false; latched = null; paint(OFF); },
  };
}
