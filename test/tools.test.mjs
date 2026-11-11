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

test("say done needs no text", () => {
  assert.deepEqual(resolveCaption({ done: true }), { done: true });
  assert.deepEqual(resolveCaption({ done: true, text: " All  set " }), { done: true, text: "All set" });
});

test("say without text or done still fails", () => {
  assert.throws(() => resolveCaption({}), /caption text/);
});

test("the say tool offers done", () => {
  const say = TOOLS.find((t) => t.name === "say");
  assert.equal(say.inputSchema.properties.done.type, "boolean");
  assert.match(say.description, /done: true/);
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

test("screenshot help says what is left out of the image", () => {
  const shot = TOOLS.find((t) => t.name === "screenshot");
  assert.doesNotMatch(shot.description, /Includes the pointer/);
  assert.match(shot.description, /left out unless you pass caption: true/);
});

// ---------------------------------------------------------- browser picking ---
import http from "node:http";

const NOW = Date.now();
const BROWSERS = [
  {
    id: "e681844f-1111", instanceId: "i1", build: "0.2.25", version: "0.2.25", stale: false,
    active: true, pinned: true, connectedAt: NOW - 300_000, lastFocusedAt: NOW - 120_000,
    tabCount: 2, tabs: [{ title: "Other project", url: "https://other.example.com/board" }, { title: "Docs", url: "https://docs.example.com/" }],
  },
  {
    id: "a8e4b2f6-2222", instanceId: "i2", build: "0.2.25", version: "0.2.25", stale: false,
    active: false, pinned: false, connectedAt: NOW - 3_600_000, lastFocusedAt: NOW - 10_000,
    tabCount: 12, tabs: [{ title: "Kai — Inbox", url: "https://mail.example.com/inbox?token=abc#x" }],
  },
  { id: "c0ffee00-3333", instanceId: "i3", build: "0.2.25", version: "0.2.25", active: false, pinned: false, connectedAt: NOW - 60_000, lastFocusedAt: 0, tabsError: "did not answer in time" },
];

function pickingHub(browsers = BROWSERS) {
  const calls = [];
  return {
    calls,
    port: 1,
    call: async (method, params) => {
      calls.push([method, params]);
      if (method === "ext.list") return browsers;
      if (method === "ext.use") {
        if (params.id === "auto") return { active: browsers[1].id, pinned: false };
        const m = browsers.find((b) => b.id.startsWith(params.id));
        if (!m) throw new Error(`No browser matching ${params.id}`);
        return { active: m.id, pinned: true };
      }
      if (method === "ext.status") return { agentName: "agent", groups: [], attached: [] };
      throw new Error(method);
    },
  };
}

test("browsers_list shows each profile with its tabs, the mode, and how to switch", async () => {
  const hub = pickingHub();
  const out = await callTool(hub, "browsers_list", {});
  assert.deepEqual(hub.calls.at(-1), ["ext.list", { tabs: true }], "an older hub without ext.profiles");
  assert.match(out.text, /^3 browsers connected\. Mode: pinned to e681844f/);
  assert.match(out.text, /→ e681844f {2}active, pinned/);
  assert.match(out.text, /a8e4b2f6 .*focused 10s ago/);
  assert.match(out.text, /12 tabs, e\.g\.:\n\s+Kai — Inbox — mail\.example\.com\/inbox\?token=…/);
  assert.doesNotMatch(out.text, /abc|#x/, "tokens and fragments are stripped");
  assert.match(out.text, /c0ffee00 .*\n\s+tabs: did not answer in time/);
  assert.match(out.text, /browser_use/);
  assert.match(out.text, /only when the human asks/);
});

test("browsers_list with nothing connected says so", async () => {
  const out = await callTool(pickingHub([]), "browsers_list", {});
  assert.match(out.text, /No browser connected/);
});

test("browser_use pins a browser by id prefix, or follows focus with auto", async () => {
  const hub = pickingHub();
  const pinned = await callTool(hub, "browser_use", { id: "a8e4" });
  assert.deepEqual(hub.calls.at(-1), ["ext.use", { id: "a8e4" }]);
  assert.match(pinned.text, /^Pinned to a8e4b2f6\./);
  assert.match(pinned.text, /Tell the human/);
  const auto = await callTool(hub, "browser_use", { id: "auto" });
  assert.match(auto.text, /^Following the profile the human uses/);
});

test("browser_use with an unknown id lists the ids that exist", async () => {
  await assert.rejects(callTool(pickingHub(), "browser_use", { id: "zzzz" }), /No browser matching zzzz.*e681844f, a8e4b2f6, c0ffee00/s);
  await assert.rejects(callTool(pickingHub(), "browser_use", {}), /Pass profile/);
});

test("browser_use says to switch only when the human asks, and nothing else switches", () => {
  const use = TOOLS.find((t) => t.name === "browser_use");
  assert.match(use.description, /only when the human asks/i);
  assert.equal(use.inputSchema.required, undefined, "profile or id, neither required on its own");
  assert.match(use.description, /closed.*opens it/i);
  const list = TOOLS.find((t) => t.name === "browsers_list");
  assert.ok(list, "browsers_list exists");
});

async function withHealth(fn) {
  const server = http.createServer((_q, r) => r.end(JSON.stringify({ ok: true, extension: true })));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(server.address().port);
  } finally {
    server.close();
  }
}

test("browser_status says the hub is pinned and why focus changes are ignored", async () => {
  await withHealth(async (port) => {
    const hub = { ...pickingHub(), port };
    const out = await callTool(hub, "browser_status", {});
    assert.match(out.text, /Browser: e681844f/);
    assert.match(out.text, /Mode: pinned/);
    assert.match(out.text, /Other browsers: a8e4b2f6, c0ffee00/);
    assert.match(out.text, /focus changes in other profiles are ignored/);
    assert.match(out.text, /browsers_list/);
    assert.match(out.text, /browser_use/);
  });
});

test("browser_status following focus has no pin hint", async () => {
  await withHealth(async (port) => {
    const unpinned = BROWSERS.map((b) => ({ ...b, pinned: false }));
    const out = await callTool({ ...pickingHub(unpinned), port }, "browser_status", {});
    assert.match(out.text, /Mode: following focus/);
    assert.doesNotMatch(out.text, /are ignored/);
    const single = await callTool({ ...pickingHub([unpinned[0]]), port }, "browser_status", {});
    assert.doesNotMatch(single.text, /Other browsers/);
  });
});


// Profiles by name: what ext.profiles answers, and the tools that read it.
const PROFILES = {
  error: null,
  profiles: [
    { dir: "Profile 6", name: "Old test", email: "", running: false, installed: false, connections: [] },
    { dir: "Profile 5", name: "Client X", email: "x@client.com", running: false, installed: true, connections: [] },
    { dir: "Profile 4", name: "Personal", email: "me@home.com", running: false, installed: true, connections: ["p1"] },
    { dir: "Default", name: "Work", email: "w@co.com", running: true, installed: true, connections: ["w2", "w1"] },
    { dir: "Profile 7", name: "Side", email: "", running: true, installed: true, connections: [] },
  ],
  unknown: [{ id: "deadbeef-9", instanceId: "i9", active: false, pinned: false, profileDir: null, tabCount: 0 }],
  browsers: [
    { id: "w2", instanceId: "i2", active: true, pinned: true, profileDir: "Default", tabCount: 2, tabs: [{ title: "Board", url: "https://work.example.com/board" }] },
    { id: "w1", instanceId: "i1", active: false, pinned: false, profileDir: "Default", tabCount: 0 },
    { id: "p1", instanceId: "i3", active: false, pinned: false, profileDir: "Profile 4", tabCount: 0 },
    { id: "deadbeef-9", instanceId: "i9", active: false, pinned: false, profileDir: null, tabCount: 0 },
  ],
};

function profilesHub(result = PROFILES, use = {}) {
  const calls = [];
  return {
    calls,
    port: 1,
    call: async (method, params) => {
      calls.push([method, params]);
      if (method === "ext.profiles") return result;
      if (method === "ext.list") return result.browsers;
      if (method === "ext.use") return use;
      if (method === "ext.status") return { agentName: "agent", groups: [], attached: [] };
      throw new Error(method);
    },
  };
}

test("browsers_list names every profile", async () => {
  const hub = profilesHub();
  const out = await callTool(hub, "browsers_list", {});
  assert.deepEqual(hub.calls[0], ["ext.profiles", { tabs: true }]);
  const t = out.text;
  assert.match(t, /^5 Chrome profiles, 2 open with Pointer\. Mode: pinned to Work\./);
  const order = [/→ Work\s+w@co\.com\s+open · active · pinned · 2 Pointer builds connected/, /Personal\s+me@home\.com\s+open/, /Side\s+open · Pointer not connected/, /Client X\s+x@client\.com\s+closed · Pointer installed/, /Old test\s+closed · Pointer not installed/, /\(unknown\)\s+deadbeef\s+open · profile not found in Chrome's list/];
  let at = 0;
  for (const re of order) {
    const m = t.slice(at).match(re);
    assert.ok(m, `${re} after position ${at}:\n${t}`);
    at += m.index + m[0].length;
  }
  assert.match(t, /2 tabs, e\.g\.:\n\s+Board — work\.example\.com\/board/);
  assert.match(t, /browser_use \{ profile: "…" \}/);
  assert.match(t, /only when the human asks/);
});

test("browsers_list without Local State falls back", async () => {
  const hub = profilesHub({ ...PROFILES, profiles: [], error: "Chrome's Local State not found in /x, so profile names are missing." });
  const out = await callTool(hub, "browsers_list", {});
  assert.match(out.text, /Local State not found/);
  assert.match(out.text, /4 browsers connected/);
});

test("browsers_list on an older hub uses ext.list", async () => {
  const out = await callTool(pickingHub(), "browsers_list", {});
  assert.match(out.text, /^3 browsers connected/);
});

test("browser_use takes a profile", async () => {
  const opened = profilesHub(PROFILES, { active: "x1", pinned: true, opened: true, profile: { name: "Client X", email: "x@client.com" } });
  const out = await callTool(opened, "browser_use", { profile: "Client X" });
  assert.deepEqual(opened.calls.at(-1), ["ext.use", { profile: "Client X" }]);
  assert.match(out.text, /^Opened Client X and switched to it\./);
  assert.match(out.text, /Tell the human/);
  const open = profilesHub(PROFILES, { active: "w2", pinned: true, opened: false, profile: { name: "Work", email: "w@co.com" } });
  assert.match((await callTool(open, "browser_use", { profile: "work" })).text, /Switched to Work \(w@co\.com\)/);
  const auto = profilesHub(PROFILES, { active: "w2", pinned: false });
  await callTool(auto, "browser_use", { profile: "auto" });
  assert.deepEqual(auto.calls.at(-1), ["ext.use", { id: "auto" }]);
});

test("browser_status names the profile", async () => {
  await withHealth(async (port) => {
    const out = await callTool({ ...profilesHub(), port }, "browser_status", {});
    assert.match(out.text, /Driving: Work \(w@co\.com\)/);
  });
});

test("browsers_list still flags a stale extension copy", async () => {
  const stale = { ...PROFILES, browsers: PROFILES.browsers.map((b) => (b.id === "p1" ? { ...b, stale: true, version: "0.3.0", build: "0.2.9" } : b)) };
  const out = await callTool(profilesHub(stale), "browsers_list", {});
  assert.match(out.text, /Personal .*stale: files are v0\.3\.0, Chrome runs 0\.2\.9/);
});

test("browser_use { profile } on an older hub explains the restart", async () => {
  const old = { port: 1, call: async (m) => { if (m === "ext.use") throw new Error('Pass a browser id, or "auto"'); return []; } };
  await assert.rejects(callTool(old, "browser_use", { profile: "Work" }), /older Pointer.*restart/i);
});
