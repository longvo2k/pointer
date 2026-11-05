// The verify tool and expect: argument checks and the result the agent reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS, resolveChecks, formatVerification, callTool } from "../lib/tools.mjs";

const PASSED = {
  state: "pass",
  elapsedMs: 600,
  url: "https://example.com/items/42",
  checks: [
    { name: "text", want: "Item saved", state: "pass", evidence: "Item saved successfully" },
    {
      name: "request",
      want: "POST /api/items",
      state: "pass",
      entry: { method: "POST", status: 201, url: "https://example.com/api/items", ms: 142 },
    },
    { name: "url", want: "/items/", state: "pass", evidence: "https://example.com/items/42" },
  ],
};

const FAILED = {
  state: "fail",
  elapsedMs: 5000,
  url: "https://example.com/items/new",
  messages: ["Name is required"],
  checks: [
    { name: "text", want: "Item saved", state: "fail", reason: "not on the page" },
    {
      name: "request",
      want: "POST /api/items",
      state: "fail",
      entry: { method: "POST", status: 422, url: "https://example.com/api/items", ms: 80, body: '{"error":"name is required"}' },
    },
    { name: "url", want: "/items/new", state: "pass", evidence: "https://example.com/items/new" },
  ],
};

test("verify is a tool, and click, fill and press take expect", () => {
  const verify = TOOLS.find((t) => t.name === "verify");
  assert.ok(verify);
  for (const key of ["text", "gone", "selector", "field", "equals", "url", "request", "status", "timeout", "screenshot"]) {
    assert.ok(verify.inputSchema.properties[key], `verify needs ${key}`);
  }
  for (const name of ["click", "fill", "press"]) {
    const expect = TOOLS.find((t) => t.name === name).inputSchema.properties.expect;
    assert.equal(expect?.type, "object", `${name} needs expect`);
    assert.ok(expect.properties.request);
  }
});

test("checks are refused when they cannot mean anything", () => {
  assert.throws(() => resolveChecks({}), /at least one check/);
  assert.throws(() => resolveChecks({ screenshot: true }), /at least one check/);
  assert.throws(() => resolveChecks({ equals: "a" }), /field/);
  assert.throws(() => resolveChecks({ field: "e4" }), /equals/);
  assert.throws(() => resolveChecks({ status: 201 }), /request/);
  assert.throws(() => resolveChecks({ request: "/x", status: 99 }), /100 to 599/);
  assert.throws(() => resolveChecks({ text: "x", timeout: 30001 }), /0 to 30000/);
  assert.throws(() => resolveChecks({ text: "x", timeout: -1 }), /0 to 30000/);
});

test("valid checks get defaults", () => {
  assert.deepEqual(resolveChecks({ text: "Saved" }), { text: "Saved", timeout: 5000, screenshot: false });
  assert.deepEqual(resolveChecks({ field: "@e4", equals: "", timeout: 0 }), { field: "e4", equals: "", timeout: 0, screenshot: false });
  assert.deepEqual(resolveChecks({ request: "POST /api/items", status: 201, screenshot: true }), {
    request: "POST /api/items",
    status: 201,
    timeout: 5000,
    screenshot: true,
  });
});

test("a passing result reads as proof, one line per check", () => {
  assert.equal(
    formatVerification(PASSED),
    [
      "verified (3 checks, 0.6s):",
      '✓ text "Item saved" — "Item saved successfully"',
      "✓ request POST /api/items — POST 201 example.com/api/items (142ms)",
      '✓ url "/items/" — example.com/items/42',
    ].join("\n")
  );
});

test("a failing result shows what happened instead", () => {
  assert.equal(
    formatVerification(FAILED),
    [
      "NOT verified (2 of 3 checks failed after 5.0s):",
      '✗ text "Item saved" — not on the page',
      '  messages on the page: "Name is required"',
      '✗ request POST /api/items — POST 422 example.com/api/items: {"error":"name is required"}',
      '✓ url "/items/new" — example.com/items/new',
    ].join("\n")
  );
});

test("a failed URL check shows the URL without secrets", () => {
  const out = formatVerification({
    state: "fail",
    elapsedMs: 0,
    checks: [{ name: "url", want: "/done", state: "fail", evidence: "https://example.com/login?token=abc#x" }],
  });
  assert.match(out, /✗ url "\/done" — the URL is example.com\/login\?token=…$/);
});

test("a dialog stops the checks and says so", () => {
  const out = formatVerification({ state: "fail", elapsedMs: 100, checks: [], dialog: { type: "confirm", message: "Discard?" } });
  assert.match(out, /^NOT verified: a confirm dialog is waiting \("Discard\?"\)/);
});

test("verify sends the checks and returns the result", async () => {
  const calls = [];
  const hub = { call: async (m, p) => (calls.push([m, p]), PASSED) };
  const out = await callTool(hub, "verify", { text: "Saved" });
  assert.deepEqual(calls, [["page.verify", { text: "Saved", timeout: 5000, screenshot: false }]]);
  assert.match(out.text, /^verified/);
  assert.equal(out.image, undefined);
});

test("verify can attach a screenshot as evidence", async () => {
  const hub = { call: async () => ({ ...PASSED, dataUrl: "data:image/png;base64,AAAA" }) };
  const out = await callTool(hub, "verify", { text: "x", screenshot: true });
  assert.deepEqual(out.image, { mimeType: "image/png", data: "AAAA" });
});

test("verify refuses bad checks before reaching the browser", async () => {
  const hub = { call: async () => assert.fail("must not reach the browser") };
  await assert.rejects(callTool(hub, "verify", {}), /at least one check/);
});

test("click with expect reports the action, then the verification, without failing", async () => {
  const calls = [];
  const hub = {
    call: async (m, p) => (
      calls.push([m, p]),
      { target: { role: "button", name: "Save" }, url: "https://example.com/items/new", changes: { added: [], removed: [], changed: [] }, verification: FAILED }
    ),
  };
  const out = await callTool(hub, "click", { ref: "e1", expect: { text: "Item saved", request: "POST /api/items" } });
  assert.deepEqual(calls[0], [
    "page.act",
    { ref: "e1", kind: "click", expect: { text: "Item saved", request: "POST /api/items", timeout: 5000, screenshot: false } },
  ]);
  assert.match(out.text, /^clicked button "Save"/);
  assert.match(out.text, /\n\nNOT verified \(2 of 3/);
  assert.equal(out.isError, undefined);
});

test("fill and press pass expect too; actions without it send none", async () => {
  const calls = [];
  const hub = { call: async (m, p) => (calls.push([m, p]), { target: "Name", key: "Enter", url: "https://example.com/", verification: PASSED }) };
  const fill = await callTool(hub, "fill", { ref: "e2", text: "Box", expect: { gone: "Unsaved" } });
  assert.equal(calls[0][1].expect.gone, "Unsaved");
  assert.match(fill.text, /\n\nverified/);
  await callTool(hub, "press", { key: "Enter", expect: { url: "/done" } });
  assert.equal(calls[1][1].expect.url, "/done");
  await callTool(hub, "click", { ref: "e1" });
  assert.equal("expect" in calls[2][1], false);
  await assert.rejects(callTool(hub, "click", { ref: "e1", expect: {} }), /at least one check/);
});
