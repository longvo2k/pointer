// Chrome profiles: read Chrome's own list, find which folder holds a Pointer
// instance, match what a person types, and build the command that opens one.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  chromeUserDataDir,
  readProfiles,
  profileOfInstance,
  hasPointer,
  matchProfile,
  launchCommand,
  chromeIsRunning,
} from "../lib/profiles.mjs";

const EXT = "a".repeat(32);

/** A fake Chrome user data dir. */
function fixture({ localState, stores = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pointer-profiles-"));
  if (localState !== undefined) {
    fs.writeFileSync(path.join(dir, "Local State"), typeof localState === "string" ? localState : JSON.stringify(localState));
  }
  // stores: { "Default": "bytes containing the id" } → Local Extension Settings/<EXT>/000003.log
  for (const [profile, content] of Object.entries(stores)) {
    const store = path.join(dir, profile, "Local Extension Settings", EXT);
    fs.mkdirSync(store, { recursive: true });
    if (content != null) fs.writeFileSync(path.join(store, "000003.log"), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(content), Buffer.from([0])]));
  }
  return dir;
}

const LOCAL_STATE = {
  profile: {
    info_cache: {
      Default: { name: "Work", user_name: "w@co.com", gaia_name: "W" },
      "Profile 4": { name: "Café 'Work'", user_name: "" },
    },
    last_active_profiles: ["Default"],
  },
};

test("user data dir per OS", () => {
  assert.equal(chromeUserDataDir({ platform: "darwin", env: {}, home: "/Users/a" }), "/Users/a/Library/Application Support/Google/Chrome");
  assert.equal(chromeUserDataDir({ platform: "linux", env: {}, home: "/home/a" }), "/home/a/.config/google-chrome");
  assert.equal(chromeUserDataDir({ platform: "win32", env: { LOCALAPPDATA: "C:\\L" }, home: "C:\\Users\\a" }), "C:\\L\\Google\\Chrome\\User Data");
  for (const platform of ["darwin", "linux", "win32"]) {
    assert.equal(chromeUserDataDir({ platform, env: { POINTER_CHROME_DIR: "/x", LOCALAPPDATA: "C:\\L" }, home: "/h" }), "/x");
  }
});

test("reads names, emails and which are running", () => {
  const dir = fixture({ localState: LOCAL_STATE });
  fs.symlinkSync(`myhost-${process.pid}`, path.join(dir, "SingletonLock")); // Chrome is running
  assert.deepEqual(readProfiles(dir), {
    profiles: [
      { dir: "Default", name: "Work", email: "w@co.com", running: true },
      { dir: "Profile 4", name: "Café 'Work'", email: "", running: false },
    ],
    error: null,
  });
});

test("missing or broken Local State", () => {
  const missing = readProfiles(fixture());
  assert.deepEqual(missing.profiles, []);
  assert.match(missing.error, /Local State/);
  const broken = readProfiles(fixture({ localState: "{" }));
  assert.deepEqual(broken.profiles, []);
  assert.match(broken.error, /Local State/);
});

test("finds the profile that holds an instance id", () => {
  const dir = fixture({ localState: LOCAL_STATE, stores: { Default: "pointerInstanceId abc-123", "Profile 4": "other" } });
  assert.equal(profileOfInstance(dir, ["Default", "Profile 4"], [EXT], "abc-123"), "Default");
  assert.equal(profileOfInstance(dir, ["Default", "Profile 4"], [EXT], "zzz-999"), null);
});

test("an id in two folders matches neither", () => {
  const dir = fixture({ localState: LOCAL_STATE, stores: { Default: "abc-123", "Profile 4": "abc-123" } });
  assert.equal(profileOfInstance(dir, ["Default", "Profile 4"], [EXT], "abc-123"), null);
});

test("hasPointer", () => {
  const dir = fixture({ localState: LOCAL_STATE, stores: { Default: null } });
  assert.equal(hasPointer(dir, "Default", ["b".repeat(32), EXT]), true);
  assert.equal(hasPointer(dir, "Profile 4", [EXT]), false);
});

const ENTRIES = [
  { dir: "Default", name: "Work", email: "w@co.com" },
  { dir: "Profile 4", name: "Café 'Work'", email: "" },
];

test("matches names case-insensitively", () => {
  assert.equal(matchProfile("work", ENTRIES).match.dir, "Default");
  assert.equal(matchProfile("W@CO.COM", ENTRIES).match.dir, "Default");
  assert.equal(matchProfile("profile 4", ENTRIES).match.dir, "Profile 4");
  assert.equal(matchProfile("café", ENTRIES).match.dir, "Profile 4");
});

test("ambiguous and empty queries", () => {
  const entries = [
    { dir: "Default", name: "Work", email: "" },
    { dir: "Profile 2", name: "Workshop", email: "" },
  ];
  const amb = matchProfile("wor", entries);
  assert.ok(amb.error);
  assert.deepEqual(amb.candidates.map((c) => c.name).sort(), ["Work", "Workshop"]);
  assert.equal(matchProfile("work", entries).match.name, "Work");
  assert.ok(matchProfile("  ", entries).error);
  assert.ok(matchProfile("nope", entries).error);
});

test("launch arguments", () => {
  assert.deepEqual(launchCommand("Profile 4", { platform: "darwin" }), {
    command: "open",
    args: ["-g", "-na", "Google Chrome", "--args", "--profile-directory=Profile 4"],
  });
  assert.deepEqual(launchCommand("Profile 4", { platform: "linux" }), {
    command: "google-chrome",
    args: ["--profile-directory=Profile 4"],
  });
  const exe = "C:\\PF\\Google\\Chrome\\Application\\chrome.exe";
  assert.deepEqual(launchCommand("Café 'Work'", { platform: "win32", env: { PROGRAMFILES: "C:\\PF" }, exists: (p) => p === exe }), {
    command: exe,
    args: ["--profile-directory=Café 'Work'"],
  });
  assert.throws(() => launchCommand("Default", { platform: "win32", env: { PROGRAMFILES: "C:\\PF" }, exists: () => false }), /not found/);
});

test("chrome is running only when its lock names a live process", () => {
  const dir = fixture({ localState: LOCAL_STATE });
  assert.equal(chromeIsRunning(dir, { platform: "darwin" }), false, "no lock: Chrome is not running");
  fs.symlinkSync(`myhost-${process.pid}`, path.join(dir, "SingletonLock"));
  assert.equal(chromeIsRunning(dir, { platform: "darwin" }), true, "lock names a live pid");
  const stale = fixture({ localState: LOCAL_STATE });
  fs.symlinkSync("myhost-999999", path.join(stale, "SingletonLock"));
  assert.equal(chromeIsRunning(stale, { platform: "linux", alive: () => false }), false, "lock left by a crash");
  assert.equal(chromeIsRunning(dir, { platform: "win32" }), null, "unknown on Windows");
});

test("when Chrome is not running, no profile is running", () => {
  const dir = fixture({ localState: LOCAL_STATE });
  assert.equal(readProfiles(dir, { platform: "darwin" }).profiles[0].running, false);
  fs.symlinkSync(`myhost-${process.pid}`, path.join(dir, "SingletonLock"));
  assert.equal(readProfiles(dir, { platform: "darwin" }).profiles[0].running, true);
});
