// Step timings from the extension reach the caller when it asks for debug.
import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { Hub } from "../lib/hub.mjs";

const port = 19400 + Math.floor(Math.random() * 400);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("a failed call keeps the extension's trace; a good one returns it in the result", async () => {
  const hub = await new Hub({ port, extensionIds: ["b".repeat(32)] }).start();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ext`, { origin: "chrome-extension://" + "b".repeat(32) });
  await new Promise((r, j) => (ws.on("open", r), ws.on("error", j)));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (!m.id) return;
    const trace = m.params.debug ? ["+5ms locate", "+9000ms load waited 9000ms"] : undefined;
    if (m.method === "page.fail") ws.send(JSON.stringify({ id: m.id, ok: false, error: "nope", trace }));
    else ws.send(JSON.stringify({ id: m.id, ok: true, result: { ok: true, _trace: trace } }));
  });
  ws.send(JSON.stringify({ event: "hello", version: "1.0.0", build: "1.0.0", instanceId: "t", lastFocusedAt: 0 }));
  await wait(50);
  try {
    const rpc = async (method, params) =>
      (await fetch(`http://127.0.0.1:${port}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method, params }),
      })).json();

    const bad = await rpc("page.fail", { debug: true });
    assert.equal(bad.ok, false);
    assert.equal(bad.error, "nope");
    assert.deepEqual(bad.trace, ["+5ms locate", "+9000ms load waited 9000ms"]);

    const good = await rpc("page.ok", { debug: true });
    assert.deepEqual(good.result._trace, ["+5ms locate", "+9000ms load waited 9000ms"]);

    const quiet = await rpc("page.fail", {});
    assert.equal(quiet.trace, undefined);
  } finally {
    ws.close();
    await hub.stop();
  }
});
