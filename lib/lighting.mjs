// Drive the Micro's LEDs over the vendor RGB channel.
//
// Use v.oai.rgbcfg, not the base kit's sendLightingPreview. Measured
// 2026-08-28: sendLightingPreview resolves to `undefined` whether or not the
// device did anything, so it can never report failure, while v.oai.rgbcfg
// returns {"result":{"ok":1}} and is what Codex itself uses.
//
// Two zones: `keys` under the caps, `ambient` for the outer ring. Brightness
// and speed here are NORMALISED 0-1, unlike the base kit's 0-255 brightness.
export const Effect = {
  off: 0, solid: 1, snake: 2, rainbow: 3, breath: 4, gradient: 5, shallowBreath: 6,
};

// Codex's own dictation colours, reused so muscle memory carries across.
export const Colour = {
  recording: 0x2e8b57,   // sea green
  processing: 0xffffff,  // white
  cursor: 0x2f7fe0,
  grokbot: 0xc06010,
};

const side = (effect, brightness, speed, color) => ({ effect, brightness, speed, magic: 0, color });

export const Preset = {
  off: () => ({ keys: side(Effect.off, 0, 0, 0), ambient: side(Effect.off, 0, 0, 0) }),
  recording: () => ({
    keys: side(Effect.solid, 0.85, 0, Colour.recording),
    ambient: side(Effect.snake, 0.85, 0.4, Colour.recording),
  }),
  processing: () => ({
    keys: side(Effect.solid, 0.85, 0, Colour.processing),
    ambient: side(Effect.snake, 0.85, 0.4, Colour.processing),
  }),
  target: (colour) => ({
    keys: side(Effect.solid, 0.35, 0, colour),
    ambient: side(Effect.off, 0, 0, 0),
  }),
};

export function makePainter({ getRpc, log = () => {} }) {
  let inflight = Promise.resolve();

  // Serialise writes. The device answers each rgbcfg individually and the
  // Codex service queues its own lighting writes for the same reason.
  return function paint(config, label = "") {
    const rpc = getRpc();
    if (rpc == null) { log("· lighting skipped: no rpc handle"); return inflight; }
    inflight = inflight.then(async () => {
      try {
        const res = await rpc.getRpcClient().sendRpcCall({ method: "v.oai.rgbcfg", params: config });
        if (res?.result?.ok !== 1) log(`  ✗ lighting${label ? ` ${label}` : ""}: device did not ack (${JSON.stringify(res?.result)})`);
      } catch (e) {
        log(`  ✗ lighting${label ? ` ${label}` : ""}: ${String(e?.message ?? e).split("\n")[0]}`);
      }
    });
    return inflight;
  };
}
