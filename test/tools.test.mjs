// The tool layer: argument handling and the text agents read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS, normalizeUrl, formatChanges } from "../lib/tools.mjs";

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
