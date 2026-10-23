// The tool layer: argument handling and the text agents read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS, normalizeUrl, formatChanges, resolveViewport, callTool } from "../lib/tools.mjs";

test("bare domains become https URLs; schemes are kept", () => {
  assert.equal(normalizeUrl("example.com"), "https://example.com");
  assert.equal(normalizeUrl("http://127.0.0.1:8080/x"), "http://127.0.0.1:8080/x");
  assert.equal(normalizeUrl("about:blank"), "about:blank");
  assert.throws(() => normalizeUrl(""));
});

test("every tool has a name, a description, and an object schema", () => {
  const names = new Set();
  for (const t of TOOLS) {
    assert.match(t.name, /^[a-z_]+$/);
    assert.ok(!names.has(t.name), `duplicate tool ${t.name}`);
    names.add(t.name);
    assert.ok(t.description.length > 20, `${t.name} needs a real description`);
    assert.equal(t.inputSchema.type, "object");
  }
});

test("there is no tool that runs arbitrary JavaScript", () => {
  for (const t of TOOLS) assert.doesNotMatch(t.name, /eval|exec|script|javascript/i);
});

test("change reports list added, removed, and changed lines", () => {
  const text = formatChanges({
    added: ['- button "Download ZIP" [ref=e9]'],
    removed: ['- button "Open" [ref=e2]'],
    changed: ['- button "Code" [ref=e3] expanded'],
    more: 0,
  });
  assert.match(text, /\+ button "Download ZIP"/);
  assert.match(text, /- button "Open"/);
  assert.match(text, /~ button "Code" \[ref=e3\] expanded/);
});

test("a navigation shows the new view instead of a diff", () => {
  const text = formatChanges({ navigated: true, snapshot: "url: https://example.com/next" });
  assert.match(text, /new page, current view:\nurl: https:\/\/example.com\/next/);
});

test("no change is said plainly", () => {
  assert.equal(formatChanges({ added: [], removed: [], changed: [], more: 0 }), "\nno change in view");
});

test("viewport presets emulate phone, tablet, and desktop sizes", () => {
  assert.deepEqual(resolveViewport({ preset: "mobile" }), { width: 375, height: 812, deviceScaleFactor: 3, mobile: true, label: "mobile" });
  assert.equal(resolveViewport({ preset: "tablet" }).width, 768);
  assert.equal(resolveViewport({ preset: "desktop" }).mobile, false);
  assert.equal(resolveViewport({ preset: "tablet", mobile: false }).mobile, false);
  assert.deepEqual(resolveViewport({ preset: "reset" }), { reset: true });
});

test("a custom viewport needs whole-number sizes in range", () => {
  assert.deepEqual(resolveViewport({ width: 390, height: 844, mobile: true }), {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true, label: "custom",
  });
  assert.equal(resolveViewport({ width: "1024", height: "768" }).mobile, false);
  assert.throws(() => resolveViewport({}), /preset/);
  assert.throws(() => resolveViewport({ width: 390 }), /height/);
  assert.throws(() => resolveViewport({ width: 100, height: 800 }), /200 to 4000/);
  assert.throws(() => resolveViewport({ width: 390.5, height: 800 }), /whole number/);
  assert.throws(() => resolveViewport({ preset: "watch" }), /Unknown preset/);
  assert.throws(() => resolveViewport({ preset: "mobile", width: 400, height: 800 }), /not both/);
});

test("the viewport tool sends the size and reports the new view", async () => {
  const calls = [];
  const hub = { call: async (method, params) => (calls.push([method, params]), { url: "https://example.com/", snapshot: "- link \"Menu\" [ref=e1]" }) };
  const out = await callTool(hub, "viewport", { preset: "mobile" });
  assert.equal(calls[0][0], "page.viewport");
  assert.equal(calls[0][1].width, 375);
  assert.match(out.text, /^viewport 375x812 \(mobile, touch\) → https:\/\/example.com\//);
  assert.match(out.text, /link "Menu" \[ref=e1\]/);
  const reset = await callTool(hub, "viewport", { preset: "reset" });
  assert.deepEqual(calls[1][1], { reset: true });
  assert.match(reset.text, /^viewport reset/);
});
