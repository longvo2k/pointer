// Verification in the real service worker, against a fake Chrome.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadWorker } from "./fake-chrome.mjs";

const PAGE = { id: 5, url: "https://www.example.com/items/new", title: "New item" };

/** A page whose checks answer from `state()`: "pass" or "pending". */
function checkingPage(state, messages = []) {
  return (type, params) => {
    if (type !== "pointer:check") return undefined;
    const s = state();
    if (s === "gone") throw new Error("Could not establish connection. Receiving end does not exist.");
    const checks = [];
    if (params.text != null) checks.push({ name: "text", want: params.text, state: s, ...(s === "pass" ? { evidence: "Item saved successfully" } : { reason: "not on the page" }) });
    return { ok: true, checks, messages };
  };
}

async function worker(opts = {}) {
  const w = await loadWorker({ tabs: [PAGE], ...opts });
  await w.command("tabs.select", { tabId: 5 });
  return w;
}

test("verify passes when the page shows the text", async () => {
  const w = await worker({ onPage: checkingPage(() => "pass") });
  const r = await w.command("page.verify", { text: "Item saved", timeout: 1000 });
  assert.equal(r.result.state, "pass");
  assert.equal(r.result.checks[0].evidence, "Item saved successfully");
});

test("verify fails at the timeout and carries the page's messages", async () => {
  const w = await worker({ onPage: checkingPage(() => "pending", ["Name is required"]) });
  const started = Date.now();
  const r = await w.command("page.verify", { text: "Item saved", timeout: 300 });
  assert.equal(r.result.state, "fail");
  assert.equal(r.result.checks[0].state, "fail");
  assert.equal(r.result.checks[0].reason, "not on the page");
  assert.deepEqual(r.result.messages, ["Name is required"]);
  assert.ok(Date.now() - started >= 300);
});

test("a page that is navigating counts as not yet, then checking goes on", async () => {
  let calls = 0;
  const w = await worker({ onPage: checkingPage(() => (++calls === 1 ? "gone" : "pass")) });
  const r = await w.command("page.verify", { text: "Item saved", timeout: 2000 });
  assert.equal(r.result.state, "pass");
});

test("the URL check reads the tab", async () => {
  const w = await worker();
  assert.equal((await w.command("page.verify", { url: "/items/new", timeout: 0 })).result.state, "pass");
  const miss = (await w.command("page.verify", { url: "/items/42", timeout: 0 })).result;
  assert.equal(miss.state, "fail");
  assert.equal(miss.checks[0].evidence, "https://www.example.com/items/new");
});

test("a request check without network capture fails at once and says why", async () => {
  const w = await worker();
  const started = Date.now();
  const r = await w.command("page.verify", { request: "POST /api/items", timeout: 5000 });
  assert.equal(r.result.state, "fail");
  assert.match(r.result.checks[0].reason, /network capture was off/);
  assert.ok(Date.now() - started < 1000);
});

/** A click that sends POST /api/items and gets `status` back, with `body`. */
function savingSite(status, body = "") {
  let w;
  const onCdp = (method, params, tabId) => {
    if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") {
      w.cdpEvent(tabId, "Network.requestWillBeSent", { requestId: "r1", request: { method: "POST", url: "https://www.example.com/api/items" }, type: "Fetch", timestamp: 1 });
      w.cdpEvent(tabId, "Network.responseReceived", { requestId: "r1", response: { status, mimeType: "application/json" }, type: "Fetch" });
      w.cdpEvent(tabId, "Network.loadingFinished", { requestId: "r1", encodedDataLength: 20, timestamp: 1.14 });
    }
    if (method === "Network.getResponseBody") return { body, base64Encoded: false };
    return undefined;
  };
  return { onCdp, bind: (worker) => (w = worker) };
}

test("expect with a request starts capture before clicking and passes on a 201", async () => {
  const site = savingSite(201);
  const w = site.bind(await worker({ onCdp: site.onCdp }));
  const r = await w.command("page.act", { ref: "e1", kind: "click", expect: { request: "POST /api/items", timeout: 1000 } });
  const v = r.result.verification;
  assert.equal(v.state, "pass");
  assert.equal(v.checks[0].entry.status, 201);
  assert.equal(v.checks[0].entry.ms, 140);
  const enable = w.log.cdp.indexOf("Network.enable");
  assert.ok(enable >= 0 && enable < w.log.cdp.indexOf("Input.dispatchMouseEvent"));
});

test("a 422 fails at once with the server's reply", async () => {
  const site = savingSite(422, '{"error":"name is required"}');
  const w = site.bind(await worker({ onCdp: site.onCdp }));
  const started = Date.now();
  const r = await w.command("page.act", { ref: "e1", kind: "click", expect: { request: "POST /api/items", timeout: 5000 } });
  const v = r.result.verification;
  assert.equal(v.state, "fail");
  assert.equal(v.checks[0].entry.status, 422);
  assert.equal(v.checks[0].entry.body, '{"error":"name is required"}');
  assert.ok(Date.now() - started < 3000);
});

test("a request from before the action does not pass the check", async () => {
  const w = await worker();
  await w.command("page.network", {});
  w.cdpEvent(5, "Network.requestWillBeSent", { requestId: "old", request: { method: "POST", url: "https://www.example.com/api/items" }, type: "Fetch", timestamp: 1 });
  w.cdpEvent(5, "Network.responseReceived", { requestId: "old", response: { status: 201 }, type: "Fetch" });
  await new Promise((r) => setTimeout(r, 5));
  const r = await w.command("page.act", { ref: "e1", kind: "click", expect: { request: "POST /api/items", timeout: 300 } });
  assert.equal(r.result.verification.state, "fail");
  assert.equal(r.result.verification.checks[0].reason, "no matching request");
});

test("verify after an action counts that action's requests", async () => {
  const site = savingSite(201);
  const w = site.bind(await worker({ onCdp: site.onCdp }));
  await w.command("page.network", {});
  await w.command("page.act", { ref: "e1", kind: "click" });
  const r = await w.command("page.verify", { request: "/api/items", timeout: 500 });
  assert.equal(r.result.state, "pass");
});

test("an action without expect never turns on network capture", async () => {
  const w = await worker({ onPage: checkingPage(() => "pass") });
  await w.command("page.act", { ref: "e1", kind: "click" });
  await w.command("page.press", { key: "Enter" });
  await w.command("page.verify", { text: "x", timeout: 0 });
  assert.equal(w.log.cdp.includes("Network.enable"), false);
  assert.equal("verification" in (await w.command("page.act", { ref: "e1", kind: "click" })).result, false);
});

test("press and fill run expect after acting", async () => {
  const w = await worker({ onPage: checkingPage(() => "pass") });
  const press = await w.command("page.press", { key: "Enter", expect: { text: "Item saved", timeout: 500 } });
  assert.equal(press.result.verification.state, "pass");
  const fill = await w.command("page.fill", { ref: "e2", text: "", expect: { text: "Item saved", timeout: 500 } });
  assert.equal(fill.result.verification.state, "pass");
});

test("verify can attach a screenshot", async () => {
  const w = await worker({
    onPage: checkingPage(() => "pass"),
    onCdp: (method) => (method === "Page.captureScreenshot" ? { data: "AAAA" } : undefined),
  });
  const r = await w.command("page.verify", { text: "x", timeout: 0, screenshot: true });
  assert.match(r.result.dataUrl, /^data:image\/png;base64,/);
});

test("an open dialog stops the checks and is reported", async () => {
  const w = await worker({ onPage: checkingPage(() => "pending") });
  w.cdpEvent(5, "Page.javascriptDialogOpening", { type: "confirm", message: "Discard changes?" });
  const r = await w.command("page.verify", { text: "Item saved", timeout: 2000 });
  assert.equal(r.result.state, "fail");
  assert.deepEqual([r.result.dialog.type, r.result.dialog.message], ["confirm", "Discard changes?"]);
});

test("a click that opens a dialog returns the dialog, with no checks run", async () => {
  let w;
  w = await worker({
    onPage: checkingPage(() => "pass"),
    onCdp: (method, params, tabId) => {
      if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") {
        w.cdpEvent(tabId, "Page.javascriptDialogOpening", { type: "confirm", message: "Delete?" });
      }
    },
  });
  const r = await w.command("page.act", { ref: "e1", kind: "click", expect: { text: "Deleted", timeout: 500 } });
  assert.equal(r.result.dialog.message, "Delete?");
  assert.equal("verification" in r.result, false);
});
