import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalAppid,
  appidVariants,
  allAppidsForTarget,
  indexTargets,
  isPassthrough,
  wlrctlFocusArgs,
} from "./identity.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(HERE, "..", "profiles.json"), "utf8"));

test("canonicalAppid lowercases and hyphenates spaces", () => {
  assert.equal(canonicalAppid("Grok Bot"), "grok-bot");
  assert.equal(canonicalAppid("Cursor"), "cursor");
  assert.equal(canonicalAppid("codex-desktop"), "codex-desktop");
  assert.equal(canonicalAppid("Codex Desktop"), "codex-desktop");
  assert.equal(canonicalAppid("com.mitchellh.ghostty"), "com.mitchellh.ghostty");
});

test("appidVariants cover Hyprland Electron spellings", () => {
  const grok = appidVariants("grok-bot");
  assert.ok(grok.includes("grok-bot"));
  assert.ok(grok.includes("Grok Bot"));
  const cursor = appidVariants("cursor");
  assert.ok(cursor.includes("cursor"));
  assert.ok(cursor.includes("Cursor"));
});

test("indexTargets matches Grok Bot and Cursor regardless of compositor spelling", () => {
  const byCanon = indexTargets(cfg.targets);
  assert.equal(byCanon.get(canonicalAppid("Grok Bot"))?.name, "grokbot");
  assert.equal(byCanon.get(canonicalAppid("grok-bot"))?.name, "grokbot");
  assert.equal(byCanon.get(canonicalAppid("Cursor"))?.name, "cursor");
  assert.equal(byCanon.get(canonicalAppid("cursor"))?.name, "cursor");
  assert.equal(byCanon.get(canonicalAppid("firefox")), undefined);
});

test("passthrough treats Codex Desktop as the same app as codex-desktop", () => {
  assert.equal(isPassthrough("codex-desktop", cfg.passthrough), true);
  assert.equal(isPassthrough("Codex Desktop", cfg.passthrough), true);
  assert.equal(isPassthrough("ChatGPT", cfg.passthrough), true);
  assert.equal(isPassthrough("cursor", cfg.passthrough), false);
});

test("wlrctl focus ORs every spelling so a spaced class still matches", () => {
  const grok = cfg.targets.find((t) => t.name === "grokbot");
  const args = wlrctlFocusArgs(allAppidsForTarget(grok));
  assert.equal(args[0], "toplevel");
  assert.equal(args[1], "focus");
  assert.ok(args.includes("app_id:grok-bot"));
  assert.ok(args.includes("app_id:Grok Bot"));
});
