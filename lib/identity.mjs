// Window identity for sticky targets, passthrough, and wlrctl focus.
//
// Electron on Wayland does not reliably emit the same string the desktop file
// uses. Chromium lowercases WM_CLASS on X11 but keeps the productName (spaces
// and all) as the Wayland app_id; newer Electron slugs "Grok Bot" to grok-bot;
// Cursor is `cursor` on some builds and `Cursor` on others. Atlas (mango)
// happened to match the hyphenated forms in profiles.json. Hyprland reports
// whatever the client set, so an exact Map lookup misses the window and the
// sticky target never moves.
//
// Matching therefore compares a canonical form (lowercase, spaces/underscores
// to hyphens). Focus asks wlrctl to accept ANY of the generated spellings:
// repeated app_id keys are OR, which is how wlrctl's matchspec works.

export function canonicalAppid(appid) {
  return String(appid ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

export function appidVariants(appid) {
  const raw = String(appid ?? "").trim();
  if (!raw) return [];
  const canon = canonicalAppid(raw);
  const words = canon.split("-").filter(Boolean);
  const titled = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  const spaced = words.join(" ");
  return [...new Set([raw, canon, titled, spaced, raw.toLowerCase()])];
}

export function allAppidsForTarget(target) {
  const seeds = [target?.appid, ...(target?.appidAliases ?? [])].filter(Boolean);
  return [...new Set(seeds.flatMap(appidVariants))];
}

export function indexTargets(targets) {
  const byCanon = new Map();
  for (const t of targets ?? []) {
    for (const id of allAppidsForTarget(t)) {
      const key = canonicalAppid(id);
      if (key && !byCanon.has(key)) byCanon.set(key, t);
    }
  }
  return byCanon;
}

export function isPassthrough(focused, list) {
  if (!focused || !list?.length) return false;
  const c = canonicalAppid(focused);
  return list.some((entry) => canonicalAppid(entry) === c);
}

export function wlrctlFocusArgs(appids) {
  const ids = [...new Set((appids ?? []).map((id) => String(id).trim()).filter(Boolean))];
  return ["toplevel", "focus", ...ids.map((id) => `app_id:${id}`)];
}
