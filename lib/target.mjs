// Resolve which target an input belongs to, from whatever window has focus.
//
// The focus signal itself comes from lib/compositor.mjs, which abstracts over
// mango (atlas) and Hyprland (kronos). This file holds the policy, which is the
// part worth being careful about.
//
// STICKY TARGETS. Both machines focus windows on pointer hover (mango's
// sloppyfocus, Hyprland's focus_follows_mouse). If the active profile changed on
// every focus event, resting the mouse over a browser would silently redirect
// your next keypress into it. So the profile only moves when focus lands on a
// *known* target and otherwise holds its last value. Hovering a terminal, a
// browser or Codex desktop leaves your target alone.
import { watchFocus } from "./compositor.mjs";
import { canonicalAppid, indexTargets } from "./identity.mjs";

export function watchTarget({ targets, fallback, onChange = () => {}, log = () => {} }) {
  const byCanon = indexTargets(targets);
  let active = targets.find((t) => t.name === fallback) ?? targets[0] ?? null;
  let lastSeen = null;
  let focused = null;
  let focusedTitle = null;

  const watcher = watchFocus({
    log,
    onFocus: ({ appid, title }) => {
      focusedTitle = title ?? null;
      if (appid === lastSeen) return;
      lastSeen = appid;
      focused = appid;

      if (appid == null) {
        log(`focus → nothing · holding ${active?.name ?? "none"}`);
        return;
      }

      const t = byCanon.get(canonicalAppid(appid));
      if (t == null) {
        log(`focus → ${appid} · not a target, holding ${active?.name ?? "none"}`);
        return;
      }
      if (t.name === active?.name) return;
      active = t;
      log(`target → ${t.label ?? t.name}`);
      onChange(t);
    },
  });

  return {
    get active() { return active; },
    get focused() { return focused; },
    get focusedTitle() { return focusedTitle; },
    stop() { watcher.stop(); },
  };
}
