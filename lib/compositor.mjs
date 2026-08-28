// Follow the focused window, whichever compositor is running.
//
// Two backends, auto-detected, because the two machines this runs on use
// different compositors and the focus signal is the only part that differs:
//
//   mango     (atlas)   `mmsg watch focusing-client` streams newline-delimited
//                       JSON, one full client object per focus change.
//   hyprland  (kronos)  the event socket at
//                       $XDG_RUNTIME_DIR/hypr/$SIG/.socket2.sock emits
//                       `activewindow>>CLASS,TITLE` on every focus change.
//
// Both normalise to { appid, title }. Hyprland's window `class` and mango's
// `appid` carry the same identity and, usefully, the same spellings: `cursor`,
// `grok-bot` and `codex-desktop` are identical on both machines, so
// profiles.json needs no per-host variant.
//
// Keystrokes and window activation deliberately do NOT vary by backend. wtype
// and wlrctl work on both compositors (both implement virtual-keyboard-v1 and
// foreign-toplevel-management) and are packaged for both, so there is one code
// path for injection rather than a second axis of divergence.
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { existsSync, readdirSync, statSync } from "node:fs";

const runtimeDir = () => process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;

// Hyprland exports HYPRLAND_INSTANCE_SIGNATURE to its children, but a service
// started outside the compositor's own process tree may not inherit it. Fall
// back to the newest instance directory rather than going blind.
function hyprSignature() {
  if (process.env.HYPRLAND_INSTANCE_SIGNATURE) return process.env.HYPRLAND_INSTANCE_SIGNATURE;
  const base = `${runtimeDir()}/hypr`;
  if (!existsSync(base)) return null;
  const dirs = readdirSync(base)
    .map((d) => ({ d, t: statSync(`${base}/${d}`).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return dirs[0]?.d ?? null;
}

export function detectCompositor() {
  const sig = hyprSignature();
  if (sig && existsSync(`${runtimeDir()}/hypr/${sig}/.socket2.sock`)) return "hyprland";
  if (process.env.MANGO_INSTANCE_SIGNATURE) return "mango";
  const base = runtimeDir();
  if (existsSync(base) && readdirSync(base).some((f) => /^mango-.*\.sock$/.test(f))) return "mango";
  return null;
}

// --- mango -------------------------------------------------------------------
function watchMango({ onFocus, log }) {
  let child = null, stopped = false, buf = "";

  const start = () => {
    if (stopped) return;
    child = spawn("mmsg", ["watch", "focusing-client"], { stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const c = JSON.parse(line);
          if (c?.appid) onFocus({ appid: c.appid, title: c.title ?? null });
        } catch { /* mmsg emits only whole lines, but never trust that */ }
      }
    });
    const retry = (ms) => { child = null; if (!stopped) setTimeout(start, ms); };
    child.on("exit", () => retry(1000));
    child.on("error", (e) => { log(`focus: mmsg error ${e.message}`); retry(2000); });
  };
  start();
  return { stop() { stopped = true; try { child?.kill(); } catch {} } };
}

// --- hyprland ----------------------------------------------------------------
function watchHyprland({ onFocus, log }) {
  let sock = null, stopped = false, buf = "";

  const start = () => {
    if (stopped) return;
    const sig = hyprSignature();
    if (!sig) { log("focus: no hyprland instance found"); setTimeout(start, 3000); return; }
    const path = `${runtimeDir()}/hypr/${sig}/.socket2.sock`;

    sock = connect(path);
    sock.setEncoding("utf8");
    sock.on("data", (chunk) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        // Lines are `EVENT>>DATA`. activewindow carries `CLASS,TITLE`, and the
        // title may itself contain commas, so split on the FIRST one only.
        const sep = line.indexOf(">>");
        if (sep < 0) continue;
        if (line.slice(0, sep) !== "activewindow") continue;
        const data = line.slice(sep + 2);
        const comma = data.indexOf(",");
        const appid = (comma < 0 ? data : data.slice(0, comma)).trim();
        const title = comma < 0 ? null : data.slice(comma + 1);
        // Focusing empty space emits an empty class; treat it as "no target"
        // rather than as a window called "".
        if (appid) onFocus({ appid, title });
      }
    });
    const retry = (ms) => { sock = null; if (!stopped) setTimeout(start, ms); };
    sock.on("close", () => retry(1000));
    sock.on("error", (e) => { log(`focus: hyprland socket ${e.message}`); retry(2000); });
  };
  start();
  return { stop() { stopped = true; try { sock?.destroy(); } catch {} } };
}

export function watchFocus({ onFocus, log = () => {}, backend = null }) {
  const which = backend ?? detectCompositor();
  if (which === "hyprland") { log("focus backend: hyprland"); return watchHyprland({ onFocus, log }); }
  if (which === "mango") { log("focus backend: mango"); return watchMango({ onFocus, log }); }
  log("focus backend: NONE detected — target will stay on the fallback");
  return { stop() {} };
}
