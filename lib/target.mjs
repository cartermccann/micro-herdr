// Resolve which target an input belongs to, from whatever window has focus.
//
// Mango streams the focused client as newline-delimited JSON on
// `mmsg watch focusing-client` — one full client object per change, plus an
// initial state, and it repeats itself, so lines are deduped by appid. Watching
// beats polling here: the daemon always knows what was focused at the instant a
// key arrived, with no interval to race against.
//
// STICKY TARGETS. atlas runs sloppyfocus=1, so focus follows the pointer. If the
// active profile changed on every focus event, resting the mouse over a browser
// would silently redirect your next keypress into it. So the profile only moves
// when focus lands on a *known* target and otherwise holds its last value.
// Hovering a terminal, a browser or Codex leaves your target alone.
import { spawn } from "node:child_process";

export function watchTarget({ targets, fallback, onChange = () => {}, log = () => {} }) {
  const byAppid = new Map(targets.map((t) => [t.appid, t]));
  let active = targets.find((t) => t.name === fallback) ?? targets[0] ?? null;
  let lastSeen = null;
  let child = null;
  let stopped = false;
  let buf = "";

  function handleLine(line) {
    if (!line.trim()) return;
    let c;
    try { c = JSON.parse(line); } catch { return; }
    if (!c?.appid || c.appid === lastSeen) return;   // mmsg repeats itself
    lastSeen = c.appid;

    const t = byAppid.get(c.appid);
    if (t == null) {
      log(`focus → ${c.appid} · not a target, holding ${active?.name ?? "none"}`);
      return;
    }
    if (t.name === active?.name) return;
    active = t;
    log(`target → ${t.label ?? t.name}`);
    onChange(t);
  }

  function start() {
    if (stopped) return;
    child = spawn("mmsg", ["watch", "focusing-client"], { stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) handleLine(l);
    });
    // If mmsg or the compositor restarts, the daemon must not go blind: it would
    // keep dispatching to a stale target forever. Always climb back on.
    const retry = (ms) => { child = null; if (!stopped) setTimeout(start, ms); };
    child.on("exit", () => retry(1000));
    child.on("error", () => retry(2000));
  }
  start();

  return {
    get active() { return active; },
    stop() { stopped = true; try { child?.kill(); } catch {} },
  };
}
