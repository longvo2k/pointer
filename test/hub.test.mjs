// Hub behavior that keeps the browser safe and the routing right.
// Run with: npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import WebSocket from "ws";
import { Hub, unpackedExtensionId } from "../lib/hub.mjs";

const EXT_ORIGIN = "chrome-extension://" + "a".repeat(32);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let port = 18790 + Math.floor(Math.random() * 500);

function request(path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", (err) => resolve({ status: 0, body: String(err.code || err) }));
    if (body) req.write(body);
    req.end();
  });
}

function connect(origin = EXT_ORIGIN) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ext`, { origin });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

/** A fake extension that answers every command with its own name. */
async function fakeBrowser(name, { focusedAt = 0, build = "1.0.0" } = {}) {
  const ws = await connect();
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.id) ws.send(JSON.stringify({ id: m.id, ok: true, result: name }));
  });
  ws.send(JSON.stringify({ event: "hello", version: "1.0.0", build, instanceId: name, lastFocusedAt: focusedAt }));
  await wait(50);
  return { ws, focus: () => ws.send(JSON.stringify({ event: "focus", at: Date.now() })) };
}

let hub;
before(async () => {
  hub = await new Hub({ port, followIdleMs: 300, extensionIds: ["a".repeat(32)] }).start();
});
after(async () => {
  await hub.stop();
});

test("rpc accepts JSON from local tools", async () => {
  const res = await request("/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "ext.list" }),
  });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).ok, true);
});

test("a failed call answers with a plain message, no stack trace", async () => {
  const res = await request("/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "page.snapshot" }), // no browser connected yet
  });
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.match(body.error, /not connected/);
  assert.doesNotMatch(body.error, /\n\s+at |hub\.mjs/);
});

test("rpc refuses a text/plain POST, the kind any web page can send", async () => {
  const res = await request("/rpc", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ method: "ext.list" }),
  });
  assert.equal(res.status, 415);
});

test("rpc refuses requests that carry a web page Origin", async () => {
  const res = await request("/rpc", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify({ method: "ext.list" }),
  });
  assert.equal(res.status, 403);
});

test("hub refuses a foreign Host header (DNS rebinding)", async () => {
  const res = await request("/health", { headers: { host: `evil.example:${port}` } });
  assert.equal(res.status, 403);
});

test("a web page cannot connect as the extension", async () => {
  await assert.rejects(connect("https://evil.example"));
});

test("duplicate and silent connections from one browser are cleaned up", async () => {
  const silent = await connect(); // never says hello
  const a = await fakeBrowser("dupe-profile");
  const b = await fakeBrowser("dupe-profile");
  await wait(100);
  const mine = hub.listExtensions().filter((e) => e.instanceId === "dupe-profile");
  assert.equal(mine.length, 1, "only the newest connection per profile survives");
  assert.equal(a.ws.readyState, WebSocket.CLOSED);
  for (const ws of [silent, b.ws]) ws.close();
  await wait(100);
});

test("a stale extension copy is flagged", async () => {
  const stale = await fakeBrowser("stale-profile", { build: "0.9.0" });
  const entry = hub.listExtensions().find((e) => e.instanceId === "stale-profile");
  assert.equal(entry.stale, true);
  stale.ws.close();
  await wait(100);
});

test("new tasks follow the focused profile, running tasks never switch", async () => {
  const A = await fakeBrowser("A", { focusedAt: Date.now() - 5000 });
  const B = await fakeBrowser("B", { focusedAt: 0 });
  hub.lastCallAt = 0;
  assert.equal(await hub.call("page.snapshot", {}), "A", "starts where the human was last");

  B.focus();
  await wait(30);
  assert.equal(await hub.call("page.snapshot", {}), "A", "mid-task: stays put");

  await wait(400);
  assert.equal(await hub.call("page.snapshot", {}), "B", "next task: follows the human");

  A.focus();
  const bId = hub.listExtensions().find((e) => e.instanceId === "B").id;
  await request("/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "ext.use", params: { id: bId } }),
  });
  await wait(400);
  assert.equal(await hub.call("page.snapshot", {}), "B", "a pin wins over focus");

  A.ws.close();
  B.ws.close();
  await wait(100);
});

test("an extension that is not Pointer cannot connect", async () => {
  await assert.rejects(connect("chrome-extension://" + "b".repeat(32)));
  assert.equal((await hub.health()).rejectedExtension, "b".repeat(32), "status can explain the refusal");
});

test("an unpacked extension id is derived from its folder path", () => {
  const id = unpackedExtensionId("/Users/ada/pointer/extension");
  assert.match(id, /^[a-p]{32}$/);
  assert.equal(id, unpackedExtensionId("/Users/ada/pointer/extension"));
  assert.notEqual(id, unpackedExtensionId("/Users/ada/other/extension"));
});

test("a reply only counts from the connection the request went to", async () => {
  const real = await connect();
  real.send(JSON.stringify({ event: "hello", instanceId: "reply-real", version: "1", build: "1", lastFocusedAt: Date.now() }));
  real.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.id) setTimeout(() => real.send(JSON.stringify({ id: m.id, ok: true, result: "real" })), 80);
  });
  const other = await connect();
  other.send(JSON.stringify({ event: "hello", instanceId: "reply-other", version: "1", build: "1" }));
  await wait(50);
  hub.pinned = false;
  hub.activeId = hub.listExtensions().find((e) => e.instanceId === "reply-real").id;
  const pending = hub.call("page.text", {});
  await wait(20);
  for (let id = 1; id < hub.nextId; id++) other.send(JSON.stringify({ id, ok: true, result: "forged" }));
  assert.equal(await pending, "real");
  real.close();
  other.close();
  await wait(100);
});

test("a focus time from the future does not take over", async () => {
  const A = await fakeBrowser("future-A", { focusedAt: Date.now() - 1000 });
  const B = await fakeBrowser("future-B");
  B.ws.send(JSON.stringify({ event: "focus", at: 9e15 }));
  await wait(30);
  const b = hub.listExtensions().find((e) => e.instanceId === "future-B");
  assert.ok(b.lastFocusedAt <= Date.now(), "focus time is clamped to now");
  A.ws.close();
  B.ws.close();
  await wait(100);
});

test("rpc refuses an oversized body", async () => {
  const body = JSON.stringify({ method: "ext.list", pad: "x".repeat(2 * 1024 * 1024) });
  const res = await request("/rpc", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    body,
  });
  assert.equal(res.status, 413);
});
