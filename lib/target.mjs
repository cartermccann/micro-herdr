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

export function watchTarget({ targets, fallback, onChange = () => {}, log = () => {} }) {
  const byAppid = new Map(targets.map((t) => [t.appid, t]));
  let active = targets.find((t) => t.name === fallback) ?? targets[0] ?? null;
  let lastSeen = null;
  // The RAW focused appid, kept separately from the sticky target. Passthrough
  // needs it: when an app handles the Micro natively (Codex desktop reads the
  // same hidraw node and acts on the same keys), the bridge has to stay out of
  // the way entirely, and that decision depends on what is focused RIGHT NOW,
  // not on the last known target.
  let focused = null;
  let focusedTitle = null;

  const watcher = watchFocus({
    log,
    onFocus: ({ appid, title }) => {
      // Track the title even when the appid has not changed: one app can have
      // several windows that behave differently, which is the whole reason
      // window variants exist (Cursor's Agents window ignores the workbench
      // keybindings that its main window honours).
      focusedTitle = title ?? null;
      if (appid === lastSeen) return;   // both backends repeat themselves
      lastSeen = appid;
      focused = appid;

      const t = byAppid.get(appid);
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
