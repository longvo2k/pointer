// The hub and Chrome profiles: which profile each browser is, listing every
// profile by name, and switching to one by name (opening it when closed).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import WebSocket from "ws";
import { Hub } from "../lib/hub.mjs";

const EXT = "a".repeat(32);
const ORIGIN = "chrome-extension://" + EXT;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let nextPort = 19400 + Math.floor(Math.random() * 400);
const hubs = [];
after(async () => {
  for (const h of hubs) await h.stop();
});

/** A fake Chrome user data dir: Work (Default), Personal (Profile 4, no Pointer), Client X (Profile 5). */
function chromeDir({ running = ["Default", "Profile 4"], extra = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pointer-hubprof-"));
  const info_cache = {
    Default: { name: "Work", user_name: "w@co.com" },
    "Profile 4": { name: "Personal", user_name: "me@home.com" },
    "Profile 5": { name: "Client X", user_name: "x@client.com" },
    ...extra,
  };
  fs.writeFileSync(path.join(dir, "Local State"), JSON.stringify({ profile: { info_cache, last_active_profiles: running } }));
  for (const p of ["Default", "Profile 5", ...Object.keys(extra)]) {
    fs.mkdirSync(path.join(dir, p, "Local Extension Settings", EXT), { recursive: true });
  }
  return dir;
}

async function startHub(opts = {}) {
  const port = nextPort++;
  const hub = await new Hub({ port, extensionIds: [EXT], previewTimeoutMs: 300, launchWaitMs: 400, runningWaitMs: 400, ...opts }).start();
  hubs.push(hub);
  return hub;
}

/** A fake Pointer in one profile: stores its instance id where Chrome would, then says hello. */
async function fakeBrowser(hub, dir, profile, instanceId) {
  if (profile) {
    const store = path.join(dir, profile, "Local Extension Settings", EXT);
    fs.mkdirSync(store, { recursive: true });
    fs.appendFileSync(path.join(store, "000003.log"), `\u0000pointerInstanceId\u0000"${instanceId}"\u0000`);
  }
  const ws = await new Promise((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${hub.port}/ext`, { origin: ORIGIN });
    s.on("open", () => resolve(s));
    s.on("error", reject);
  });
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (!m.id) return;
    const result = m.method === "tabs.list" ? [{ title: `${instanceId} tab`, url: "https://example.com/" }] : instanceId;
    ws.send(JSON.stringify({ id: m.id, ok: true, result }));
  });
  ws.send(JSON.stringify({ event: "hello", version: "1.0.0", build: "1.0.0", instanceId, extensionId: EXT, lastFocusedAt: 0 }));
  await wait(60);
  return { ws, id: () => hub.listExtensions().find((e) => e.instanceId === instanceId)?.id };
}

function rpc(hub, method, params) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ method, params });
    const req = http.request(
      { host: "127.0.0.1", port: hub.port, method: "POST", path: "/rpc", headers: { "content-type": "application/json" } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(JSON.parse(data)));
      }
    );
    req.end(body);
  });
}

const byName = (res, name) => res.profiles.find((p) => p.name === name);

test("a connection is matched to its Chrome profile", async () => {
  const dir = chromeDir();
  const hub = await startHub({ chromeDir: dir });
  const work = await fakeBrowser(hub, dir, "Default", "inst-work");
  const res = (await rpc(hub, "ext.profiles", {})).result;
  assert.equal(res.error, null);
  assert.deepEqual(byName(res, "Work").connections, [work.id()]);
  assert.equal(byName(res, "Work").installed, true);
  assert.equal(byName(res, "Work").email, "w@co.com");
  assert.deepEqual(byName(res, "Personal").connections, []);
  assert.equal(byName(res, "Personal").installed, false);
  assert.equal(byName(res, "Client X").installed, true);
  assert.deepEqual(byName(res, "Client X").connections, []);
  assert.equal(hub.listExtensions()[0].profileDir, "Default");
  work.ws.close();
});

test("a connection whose id is in no profile is listed as unknown", async () => {
  const dir = chromeDir();
  const hub = await startHub({ chromeDir: dir });
  const ghost = await fakeBrowser(hub, dir, null, "inst-ghost");
  const res = (await rpc(hub, "ext.profiles", {})).result;
  assert.deepEqual(res.unknown.map((b) => b.id), [ghost.id()]);
  assert.ok(res.profiles.every((p) => p.connections.length === 0));
  ghost.ws.close();
});

test("two builds in one profile are listed once, latest first", async () => {
  const dir = chromeDir();
  const hub = await startHub({ chromeDir: dir });
  const older = await fakeBrowser(hub, dir, "Default", "inst-store");
  await wait(20);
  const newer = await fakeBrowser(hub, dir, "Default", "inst-dev");
  const res = (await rpc(hub, "ext.profiles", {})).result;
  assert.deepEqual(byName(res, "Work").connections, [newer.id(), older.id()]);
  assert.equal(res.profiles.filter((p) => p.connections.length).length, 1);
  older.ws.close();
  newer.ws.close();
});

test("ext.profiles with tabs previews each browser", async () => {
  const dir = chromeDir();
  const hub = await startHub({ chromeDir: dir });
  const work = await fakeBrowser(hub, dir, "Default", "inst-tabs");
  const res = (await rpc(hub, "ext.profiles", { tabs: true })).result;
  assert.equal(res.browsers[0].tabs[0].title, "inst-tabs tab");
  work.ws.close();
});

test("no Local State: ext.profiles says why and ext.list is unchanged", async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "pointer-nostate-"));
  const hub = await startHub({ chromeDir: empty });
  const b = await fakeBrowser(hub, empty, null, "inst-plain");
  const res = (await rpc(hub, "ext.profiles", {})).result;
  assert.match(res.error, /Local State/);
  assert.deepEqual(res.profiles, []);
  assert.equal(res.unknown.length, 1);
  const list = (await rpc(hub, "ext.list", {})).result;
  assert.equal(list.length, 1);
  assert.equal(list[0].profileDir, null);
  assert.equal(list[0].instanceId, "inst-plain");
  b.ws.close();
});
