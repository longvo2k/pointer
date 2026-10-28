// The tool layer: argument handling and the text agents read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS, normalizeUrl, formatChanges, formatOpened, resolveViewport, resolveCaption, callTool } from "../lib/tools.mjs";

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

test("hover moves onto the element without clicking and reports what opened", async () => {
  const calls = [];
  const hub = {
    call: async (method, params) => (
      calls.push([method, params]),
      {
        target: { role: "button", name: "Products" },
        url: "https://example.com/",
        changes: { added: ['- link "Pricing" [ref=e12]'], removed: [], changed: [], more: 0 },
      }
    ),
  };
  const out = await callTool(hub, "hover", { ref: "@e4" });
  assert.deepEqual(calls[0], ["page.act", { ref: "e4", kind: "hover" }]);
  assert.match(out.text, /^hovering over button "Products" → https:\/\/example.com\//);
  assert.match(out.text, /\+ link "Pricing" \[ref=e12\]/);
  await assert.rejects(callTool(hub, "hover", {}), /ref/);
});

test("navigate goes back, forward, or reloads and shows the new view", async () => {
  const calls = [];
  const hub = {
    call: async (method, params) => (
      calls.push([method, params]),
      { url: "https://example.com/list?token=abc", snapshot: "- link \"Item\" [ref=e1]" }
    ),
  };
  const out = await callTool(hub, "navigate", { action: "back" });
  assert.deepEqual(calls[0], ["page.history", { action: "back" }]);
  assert.match(out.text, /^went back → https:\/\/example.com\/list\?token=…/);
  assert.match(out.text, /current view:\n- link "Item" \[ref=e1\]/);
  assert.match((await callTool(hub, "navigate", { action: "reload" })).text, /^reloaded/);
  await assert.rejects(callTool(hub, "navigate", { action: "home" }), /back.*forward.*reload/);
  assert.equal(calls.length, 2);
});

test("a click that opens a tab says so, and the tab is the agent's to close", async () => {
  const hub = {
    call: async () => ({
      target: { role: "link", name: "App Store" },
      url: "http://localhost:3000/",
      changes: { added: [], removed: [], changed: [], more: 0 },
      opened: [{ tabId: 1338345369, url: "https://apps.apple.com/app/id1?token=abc#x" }],
    }),
  };
  const out = await callTool(hub, "click", { ref: "e10" });
  assert.match(out.text, /opened tab 1338345369 in the background: https:\/\/apps\.apple\.com\/app\/id1\?token=…/);
  assert.match(out.text, /tab_select 1338345369/);
  assert.doesNotMatch(out.text, /abc/);
  assert.match(TOOLS.find((t) => t.name === "tab_close").description, /clicks opened/);
});

test("formatOpened is empty when nothing opened", () => {
  assert.equal(formatOpened(undefined), "");
  assert.equal(formatOpened([]), "");
});

test("focus is described as interrupting the human", () => {
  assert.match(TOOLS.find((t) => t.name === "tab_open").description, /interrupt/);
});

test("captions are one line, capped, and checked", () => {
  assert.deepEqual(resolveCaption({ text: "  Step 3:\n play   the story ", step: " 3/5 ", seconds: 5, ref: "@e10" }), {
    text: "Step 3: play the story", step: "3/5", seconds: 5, ref: "e10",
  });
  assert.deepEqual(resolveCaption({ clear: true, text: "ignored" }), { clear: true });
  const long = resolveCaption({ text: "x".repeat(500) }).text;
  assert.equal(long.length, 300);
  assert.match(long, /…$/);
  assert.throws(() => resolveCaption({ text: "  " }), /caption text/);
  assert.throws(() => resolveCaption({ text: "hi", seconds: 0 }), /seconds/);
  assert.throws(() => resolveCaption({ text: "hi", seconds: 9999 }), /seconds/);
});

test("say shows a caption, and clear removes it", async () => {
  const calls = [];
  const hub = {
    call: async (method, params) => (
      calls.push([method, params]),
      params.clear ? { cleared: true } : { url: "http://localhost:3000/?token=abc", target: 'button "Play"' }
    ),
  };
  const out = await callTool(hub, "say", { text: "Play a premium story", step: "3/5", ref: "e10" });
  assert.deepEqual(calls[0], ["page.caption", { text: "Play a premium story", step: "3/5", ref: "e10" }]);
  assert.match(out.text, /^showing caption \[3\/5\]: "Play a premium story" until replaced or cleared, outlining button "Play"/);
  assert.match(out.text, /token=…/);
  assert.equal((await callTool(hub, "say", { clear: true })).text, "caption cleared");
  assert.deepEqual(calls[1], ["page.caption", { clear: true }]);
});

test("an action's say shows the caption before acting", async () => {
  const calls = [];
  const hub = {
    call: async (method, params) => (
      calls.push([method, params]),
      { target: { role: "button", name: "Play" }, url: "https://x.test/", changes: { added: [], removed: [], changed: [], more: 0 } }
    ),
  };
  await callTool(hub, "click", { ref: "e10", say: "Play the story; the preview stops at 15 seconds" });
  assert.deepEqual(calls.map((c) => c[0]), ["page.caption", "page.act"]);
  assert.deepEqual(calls[0][1], { text: "Play the story; the preview stops at 15 seconds" });
  assert.deepEqual(calls[1][1], { ref: "e10", kind: "click" });

  calls.length = 0;
  await assert.rejects(callTool(hub, "hover", { say: "nothing to point at" }), /ref/);
  assert.equal(calls.length, 0, "no caption when the action cannot run");

  await callTool(hub, "press", { key: "Escape" });
  assert.deepEqual(calls.map((c) => c[0]), ["page.press"]);
  for (const name of ["click", "hover", "fill", "press", "scroll"]) {
    assert.ok(TOOLS.find((t) => t.name === name).inputSchema.properties.say, `${name} takes say`);
  }
});

test("screenshots leave the caption out unless asked", async () => {
  const calls = [];
  const hub = { call: async (method, params) => (calls.push([method, params]), { dataUrl: "data:image/png;base64,AAAA", url: "https://x.test/" }) };
  await callTool(hub, "screenshot", {});
  await callTool(hub, "screenshot", { caption: true });
  assert.deepEqual(calls, [["page.screenshot", {}], ["page.screenshot", { caption: true }]]);
});

test("console read from the page itself says what it can miss", async () => {
  const hub = {
    call: async () => ({
      started: false,
      reloaded: false,
      pageHook: true,
      url: "https://x.test/login",
      entries: [{ level: "error", text: "boom (app.js:3)" }],
    }),
  };
  const out = await callTool(hub, "console", { level: "errors" });
  assert.match(out.text, /password manager/);
  assert.match(out.text, /1 errors on https:\/\/x\.test\/login/);
  assert.match(out.text, /boom \(app\.js:3\)/);
});
