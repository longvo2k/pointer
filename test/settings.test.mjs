// Settings: what the human chose on the settings page, with safe defaults.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SETTINGS_KEY, DEFAULT_SETTINGS, withDefaults } from "../extension/settings.js";

test("settings live under one key", () => {
  assert.equal(SETTINGS_KEY, "pointerSettings");
});

test("missing settings get the defaults", () => {
  assert.deepEqual(withDefaults(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(DEFAULT_SETTINGS, {
    bar: true,
    edge: true,
    cursorSpeed: "watchable",
    labels: true,
    groupStatus: true,
    notifyDone: false,
    notifyStopped: false,
    sound: false,
    escStops: true,
    clickStops: true,
    blockedSites: [],
  });
});

test("bad values fall back", () => {
  const s = withDefaults({ bar: "yes", cursorSpeed: "warp", extra: 1, edge: false, cursor: "fast" });
  assert.equal(s.bar, true);
  assert.equal(s.edge, false);
  assert.equal(s.cursorSpeed, "watchable");
  assert.equal("extra" in s, false);
  assert.equal(withDefaults({ cursorSpeed: "fast" }).cursorSpeed, "fast");
});

test("blocked sites are cleaned", () => {
  assert.deepEqual(withDefaults({ blockedSites: ["https://www.MyBank.com", "", "mybank.com", 3] }).blockedSites, ["mybank.com/*"]);
  assert.deepEqual(withDefaults({ blockedSites: "mybank.com" }).blockedSites, []);
});

test("defaults are never shared between calls", () => {
  const a = withDefaults(undefined);
  a.blockedSites.push("x.com/*");
  assert.deepEqual(withDefaults(undefined).blockedSites, []);
});
