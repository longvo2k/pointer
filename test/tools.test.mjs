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

test("only web pages can be opened", () => {
  for (const bad of ["file:///etc/passwd", "chrome://settings", "javascript:alert(1)", "data:text/html,hi"]) {
    assert.throws(() => normalizeUrl(bad), /http and https/, bad);
  }
  assert.equal(normalizeUrl("HTTPS://example.com"), "HTTPS://example.com");
  assert.equal(normalizeUrl("localhost:3000/app"), "http://localhost:3000/app");
  assert.equal(normalizeUrl("example.com:8443/x"), "https://example.com:8443/x");
});

test("resume asks the extension to continue after a human stop", async () => {
  const calls = [];
  const hub = { call: async (method) => (calls.push(method), { resumed: true }) };
  const out = await callTool(hub, "resume", {});
  assert.deepEqual(calls, ["ext.resume"]);
  assert.match(out.text, /resumed/);
  assert.match(TOOLS.find((t) => t.name === "resume").description, /human/i);
});

test("upload refuses keys, credentials, and hidden files", async () => {
  const hub = { call: async () => assert.fail("must not reach the browser") };
  for (const p of ["~/.ssh/id_rsa", "/tmp/project/.env", "/tmp/server.pem", "/tmp/aws/credentials", "/tmp/x/.config/token.txt"]) {
    await assert.rejects(callTool(hub, "upload", { paths: [p] }), /will not upload/, p);
  }
});

test("urls in tool output lose tokens and the fragment", async () => {
  const hub = {
    call: async () => ({
      target: { role: "button", name: "Go" },
      url: "https://app.example.com/cb?code=abc123&state=xyz&page=2#access_token=secret",
      changes: { added: [], removed: [], changed: [], more: 0 },
    }),
  };
  const out = await callTool(hub, "click", { ref: "e1" });
  assert.doesNotMatch(out.text, /abc123|secret/);
  assert.match(out.text, /state=xyz&page=2/);
});

test("layout passes the scope and shows the findings", async () => {
  const calls = [];
  const hub = {
    call: async (method, params) => (
      calls.push([method, params]),
      { text: "layout at 375x812 (touch), whole page: 1 problems, 0 warnings\n! page is 17px wider than the screen", url: "https://x.test/a#t=1" }
    ),
  };
  const out = await callTool(hub, "layout", { scope: "viewport" });
  assert.deepEqual(calls[0], ["page.layout", { scope: "viewport", limit: undefined }]);
  assert.match(out.text, /17px wider/);
  assert.match(out.text, /→ https:\/\/x\.test\/a$/);
  await callTool(hub, "layout", {});
  assert.equal(calls[1][1].scope, "all");
});
