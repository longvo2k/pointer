/**
 * Pointer service worker.
 *
 * Bridges a local hub (WebSocket) to the tab the agent is driving:
 *   hub -> page: snapshot / locate / act
 *   hub <- page: refs and coordinates
 * and dispatches *trusted* input through chrome.debugger, so clicks survive
 * React handlers and site-specific pointer checks.
 */

const DEFAULT_PORT = 8790;
const HUB_URL = `ws://127.0.0.1:${DEFAULT_PORT}/ext`;

let socket = null;
let reconnectDelay = 800;
let connected = false;
let lastTabId = null;
let lastFocusedTab = null;
let agentName = "agent";
let stopped = false;
const attached = new Set();
const markedTabs = new Set();
const agentGroups = new Map(); // windowId -> Chrome tab group id
let modifier = "Meta"; // set from platform info

// Chrome's tab-group palette. Purple matches Pointer's accent; the title comes
// from the hub's agent name, so Claude shows up as a "Claude" group.
const GROUP_COLOR = "purple";
const GROUP_TITLE_MAX = 24;

// Toggle when hunting a slow command; logs go to the extension worker console.
const TRACE = false;
const BUILD = "0.2.6";
const traceStart = Date.now();
self.__pointerBuild = BUILD;
function trace(...args) {
  if (TRACE) console.log(`[pointer +${Date.now() - traceStart}ms]`, ...args);
}

chrome.runtime.getPlatformInfo().then((info) => {
  modifier = info.os === "mac" ? "Meta" : "Control";
});

// ------------------------------------------------------------------ socket ---
async function getInstanceId() {
  try {
    const stored = await chrome.storage.local.get("pointerInstanceId");
    if (stored.pointerInstanceId) return stored.pointerInstanceId;
    const id = crypto.randomUUID();
    await chrome.storage.local.set({ pointerInstanceId: id });
    return id;
  } catch {
    return "unknown";
  }
}

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  socket = new WebSocket(HUB_URL);

  socket.addEventListener("open", async () => {
    connected = true;
    reconnectDelay = 800;
    const instanceId = await getInstanceId();
    send({
      event: "hello",
      name: "pointer-extension",
      version: chrome.runtime.getManifest().version,
      instanceId,
      build: self.__pointerBuild || null,
    });
    setBadge("on");
  });

  socket.addEventListener("message", async (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (!msg || !msg.id || !msg.method) return;
    const started = Date.now();
    try {
      const result = await dispatch(msg.method, msg.params || {});
      trace("handled", msg.method, `${Date.now() - started}ms`);
      send({ id: msg.id, ok: true, result });
    } catch (err) {
      trace("failed", msg.method, `${Date.now() - started}ms`, err?.message || String(err));
      send({ id: msg.id, ok: false, error: err?.message || String(err) });
    }
  });

  const drop = () => {
    connected = false;
    setBadge("off");
    socket = null;
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.7, 8000);
  };
  socket.addEventListener("close", drop);
  socket.addEventListener("error", () => {
    try {
      socket?.close();
    } catch {}
  });
}

function send(obj) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(obj));
}

function setBadge(state) {
  chrome.action.setBadgeText({ text: state === "on" ? "on" : "" }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: state === "on" ? "#2563eb" : "#9ca3af" }).catch(() => {});
}

// The service worker can be evicted; this keeps reconnecting while idle.
chrome.alarms.create("pointer-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "pointer-keepalive") connect();
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();

// --------------------------------------------------------------- messaging ---
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === "pointer:stop") {
    stopped = true;
    unmarkTabs().catch(() => {});
    send({ event: "stop", reason: msg.reason || "user" });
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "pointer:keepalive") {
    // Wakes the service worker so the socket survives MV3 idle eviction.
    if (!connected) connect();
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "pointer:hello") {
    sendResponse({ ok: true, connected });
    return;
  }
  if (msg.type === "pointer:status") {
    groupSummary()
      .catch(() => [])
      .then((groups) => {
        sendResponse({
          ok: true,
          connected,
          stopped,
          lastTabId,
          agentName,
          attached: [...attached],
          groups,
          socket: HUB_URL,
        });
      });
    return true;
  }
  if (msg.type === "pointer:reconnect") {
    try {
      socket?.close();
    } catch {}
    socket = null;
    connect();
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "pointer:rename") {
    agentName = msg.name || "agent";
    refreshGroupLabels().catch(() => {});
    sendResponse({ ok: true });
    return;
  }
});

// ------------------------------------------------------------------- tabs ----
async function resolveTab(params = {}) {
  const id = params.tabId ?? lastTabId;
  if (id != null) {
    try {
      return await chrome.tabs.get(id);
    } catch {
      lastTabId = null;
    }
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active) return active;
  const [any] = await chrome.tabs.query({});
  if (!any) throw new Error("No tab available. Open a page first.");
  return any;
}

/**
 * Focus is opt-in. Normal agent actions must never pull the human away from
 * the tab or window they are using; only tab_open / tab_focus bring the
 * agent's tab forward. Everything else runs against the tab in place, even
 * when it is in the background.
 */
async function prepareTab(tab, { bringToFront = false, focusWindow = true } = {}) {
  if (!bringToFront) return;
  if (!tab.active) await chrome.tabs.update(tab.id, { active: true });
  const win = await chrome.windows.get(tab.windowId).catch(() => null);
  if (win?.state === "minimized") {
    await chrome.windows.update(tab.windowId, { state: "normal" }).catch(() => {});
  }
  if (focusWindow) {
    try {
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch {}
  }
  lastFocusedTab = tab.id;
}

/**
 * Create a tab without activating it or raising any window. Prefer the window
 * the agent already works in, so new tabs join its group instead of landing in
 * whatever window the human last clicked. With no window open in this profile,
 * create an unfocused one.
 */
async function openBackgroundTab(url) {
  let windowId;
  const last = lastTabId != null ? await chrome.tabs.get(lastTabId).catch(() => null) : null;
  if (last) {
    windowId = last.windowId;
  } else {
    // Each profile runs its own copy of the extension, so this is a window of
    // the agent's profile, never one from the profile the human is in.
    const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
    windowId = win?.id;
  }
  if (windowId == null) {
    const win = await chrome.windows.create({ url, focused: false });
    return win.tabs?.[0] ?? (await chrome.tabs.query({ windowId: win.id }))[0];
  }
  return chrome.tabs.create({ windowId, url, active: false });
}

function agentGroupTitle() {
  return (agentName || "agent").trim().slice(0, GROUP_TITLE_MAX) || "agent";
}

// Group operations touch shared state per window; serialize them so two tabs
// opened at once cannot create two "Claude" groups.
let groupQueue = Promise.resolve();
function queueGroupOp(fn) {
  const run = groupQueue.then(fn, fn);
  groupQueue = run.catch(() => {});
  return run;
}

/**
 * Put an agent tab in the window's agent group, creating it on first use.
 * Tabs already in a group the human made are left alone; groups whose title
 * matches the agent name are adopted (e.g. after the worker was evicted).
 */
async function ensureAgentGroup(tabId) {
  return queueGroupOp(async () => {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || tab.windowId == null || tab.pinned) return null;

    const title = agentGroupTitle();
    const known = agentGroups.get(tab.windowId);

    if (tab.groupId != null && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
      if (tab.groupId === known) {
        await chrome.tabGroups
          .update(tab.groupId, { title, color: GROUP_COLOR })
          .catch(() => {});
        return tab.groupId;
      }

      const existing = await chrome.tabGroups.get(tab.groupId).catch(() => null);
      if (existing && existing.title === title) {
        agentGroups.set(tab.windowId, tab.groupId);
        return tab.groupId;
      }

      // The human grouped this tab deliberately; don't move it.
      return null;
    }

    let groupId = known ?? null;
    if (groupId != null) {
      const alive = await chrome.tabGroups.get(groupId).catch(() => null);
      if (!alive) {
        agentGroups.delete(tab.windowId);
        groupId = null;
      }
    }

    try {
      groupId = await chrome.tabs.group(
        groupId != null ? { tabIds: [tabId], groupId } : { tabIds: [tabId] }
      );
    } catch {
      // Pinned tabs and some restricted pages cannot join a group.
      return null;
    }

    agentGroups.set(tab.windowId, groupId);
    await chrome.tabGroups.update(groupId, { title, color: GROUP_COLOR }).catch(() => {});
    return groupId;
  });
}

async function refreshGroupLabels() {
  const title = agentGroupTitle();
  await Promise.all(
    [...new Set(agentGroups.values())].map((groupId) =>
      chrome.tabGroups.update(groupId, { title, color: GROUP_COLOR }).catch(() => {})
    )
  );
}

async function ungroupAgentTabs() {
  return queueGroupOp(async () => {
    const groupIds = new Set(agentGroups.values());
    agentGroups.clear();
    if (!groupIds.size) return;
    const tabs = await chrome.tabs.query({});
    const tabIds = tabs.filter((tab) => groupIds.has(tab.groupId)).map((tab) => tab.id);
    if (tabIds.length) await chrome.tabs.ungroup(tabIds).catch(() => {});
  });
}

async function groupSummary() {
  const summary = [];
  for (const [windowId, groupId] of agentGroups) {
    const group = await chrome.tabGroups.get(groupId).catch(() => null);
    if (!group) continue;
    const tabs = await chrome.tabs.query({ groupId }).catch(() => []);
    summary.push({
      windowId,
      groupId,
      title: group.title,
      color: group.color,
      collapsed: group.collapsed,
      tabIds: tabs.map((tab) => tab.id),
    });
  }
  return summary;
}

/**
 * Mark the agent's tab: a Chrome tab group (visible above the tab strip) and a
 * title badge, e.g. group "Claude" + "Claude · PAVE Inspect".
 */
async function markTab(tabId) {
  markedTabs.add(tabId);
  await ensureAgentGroup(tabId).catch(() => {});
  try {
    await page(tabId, "pointer:mark", { label: agentName });
  } catch {
    // chrome:// and other restricted pages cannot show a badge; ignore.
  }
}

async function unmarkTabs() {
  const tabs = [...markedTabs];
  markedTabs.clear();
  await Promise.all(
    tabs.map((tabId) => page(tabId, "pointer:mark", { off: true }).catch(() => {}))
  );
  await ungroupAgentTabs();
}

async function ensureContent(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "pointer:ping" });
    if (res?.ok) return;
  } catch {}
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch (err) {
    throw new Error(
      `Cannot reach this page (${err?.message || "injection blocked"}). ` +
        `Chrome blocks extensions on chrome://, the Web Store, and some PDFs.`
    );
  }
}

async function page(tabId, type, params = {}) {
  const started = Date.now();
  // A page frozen by alert()/confirm() never answers; fail fast with a hint
  // instead of waiting for the hub's 30s timeout.
  const res = await withTimeout(
    ensureContent(tabId).then(() => chrome.tabs.sendMessage(tabId, { type, params })),
    type === "pointer:wait" ? 28000 : 12000,
    "The page did not respond. It may be busy, or a dialog (alert/confirm) may be open: try the dialog tool."
  );
  const ms = Date.now() - started;
  if (ms > 300) trace("page slow", type, `${ms}ms`);
  if (!res) throw new Error("No response from page. It may have navigated.");
  if (!res.ok) throw new Error(res.error || "Page command failed");
  return res;
}

// ------------------------------------------------------------- trusted input -
function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function attach(tabId) {
  if (attached.has(tabId)) return;
  trace("attach start", tabId);
  try {
    await withTimeout(
      chrome.debugger.attach({ tabId }, "1.3"),
      5000,
      "Chrome did not accept the input driver (window hidden or another debugger attached)."
    );
    attached.add(tabId);
    trace("attach ok", tabId);
  } catch (err) {
    const msg = String(err?.message || err);
    trace("attach error", msg);
    if (!/already attached/i.test(msg)) {
      throw new Error(`Could not attach input driver: ${msg}`);
    }
    attached.add(tabId);
  }
  // Page events tell us when alert()/confirm()/prompt() opens.
  await chrome.debugger.sendCommand({ tabId }, "Page.enable").catch(() => {});
}

chrome.debugger.onDetach.addListener(({ tabId }) => forgetTab(tabId, { keepMarks: true }));
chrome.tabs.onRemoved.addListener((tabId) => forgetTab(tabId));

function forgetTab(tabId, { keepMarks = false } = {}) {
  attached.delete(tabId);
  dialogs.delete(tabId);
  captures.delete(tabId);
  if (!keepMarks) markedTabs.delete(tabId);
}

// ---------------------------------------------------------------- dialogs ---
// alert()/confirm()/prompt() block the page: content scripts stop answering
// and the input event that opened the dialog does not return until it closes.
const dialogs = new Map(); // tabId -> { type, message, defaultPrompt, url }
const dialogWaiters = new Map(); // tabId -> Set<resolve>

function watchDialog(tabId) {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  const set = dialogWaiters.get(tabId) ?? new Set();
  dialogWaiters.set(tabId, set);
  set.add(resolve);
  return { promise, cancel: () => set.delete(resolve) };
}

/** Run input work, but return early if it opens a dialog. */
async function raceDialog(tabId, work) {
  const watch = watchDialog(tabId);
  try {
    const out = await Promise.race([
      work.then(() => ({})),
      watch.promise.then((dialog) => ({ dialog })),
    ]);
    if (out.dialog) work.catch(() => {}); // it settles once the dialog closes
    return out;
  } finally {
    watch.cancel();
  }
}

function assertNoDialog(tabId) {
  const d = dialogs.get(tabId);
  if (d) {
    throw new Error(
      `${/^[aeiou]/.test(d.type) ? "An" : "A"} ${d.type} dialog is open: "${d.message}". Ask the human if it matters, then use the dialog tool to accept or dismiss it.`
    );
  }
}

// ---------------------------------------------------------------- capture ---
// Console and network capture are opt-in per tab: enabling Runtime/Network
// makes the debugger easier for anti-bot scripts to notice, so the tab keeps
// its normal fingerprint until an agent asks for logs.
const captures = new Map(); // tabId -> { console, logs: [], net: Map, order: [] }
const LOG_LIMIT = 300;
const NET_LIMIT = 400;

function captureFor(tabId) {
  let c = captures.get(tabId);
  if (!c) {
    c = { console: false, network: false, logs: [], net: new Map(), order: [] };
    captures.set(tabId, c);
  }
  return c;
}

function pushLog(tabId, entry) {
  const c = captures.get(tabId);
  if (!c?.console) return;
  c.logs.push({ at: Date.now(), ...entry });
  if (c.logs.length > LOG_LIMIT) c.logs.splice(0, c.logs.length - LOG_LIMIT);
}

function remoteText(arg) {
  if (!arg) return "";
  if (arg.value !== undefined) return typeof arg.value === "string" ? arg.value : JSON.stringify(arg.value);
  // Objects arrive as a preview of their first few properties.
  const pv = arg.preview;
  if (pv?.properties && arg.type === "object" && arg.subtype !== "error") {
    const more = pv.overflow ? ", …" : "";
    if (pv.subtype === "array") return `[${pv.properties.map((p) => p.value).join(", ")}${more}]`;
    return `{${pv.properties.map((p) => `${p.name}: ${p.type === "string" ? JSON.stringify(p.value) : p.value}`).join(", ")}${more}}`;
  }
  return arg.unserializableValue || arg.description || arg.type || "";
}

function where(frame) {
  if (!frame?.url) return "";
  const file = frame.url.split(/[?#]/)[0].split("/").pop() || frame.url;
  return ` (${file}:${(frame.lineNumber ?? 0) + 1})`;
}

chrome.debugger.onEvent.addListener((source, method, p) => {
  const tabId = source.tabId;
  if (tabId == null) return;
  switch (method) {
    case "Page.javascriptDialogOpening": {
      const d = { type: p.type, message: String(p.message || "").slice(0, 300), defaultPrompt: p.defaultPrompt || "", url: p.url };
      dialogs.set(tabId, d);
      for (const resolve of dialogWaiters.get(tabId) ?? []) resolve(d);
      return;
    }
    case "Page.javascriptDialogClosed":
      dialogs.delete(tabId);
      return;
    case "Runtime.consoleAPICalled": {
      const level = { warning: "warning", error: "error", assert: "error" }[p.type] || (p.type === "debug" ? "debug" : "log");
      const text = (p.args || []).map(remoteText).join(" ");
      return pushLog(tabId, { level, text: text + where(p.stackTrace?.callFrames?.[0]) });
    }
    case "Runtime.exceptionThrown": {
      const d = p.exceptionDetails || {};
      const text = d.exception?.description?.split("\n")[0] || d.text || "Uncaught exception";
      return pushLog(tabId, { level: "error", text: text + where(d.stackTrace?.callFrames?.[0] || d) });
    }
    case "Log.entryAdded": {
      const e = p.entry || {};
      const level = e.level === "verbose" ? "debug" : e.level === "info" ? "log" : e.level;
      return pushLog(tabId, { level, text: `[${e.source}] ${e.text}${e.url ? ` (${e.url.slice(0, 100)})` : ""}` });
    }
    case "Network.requestWillBeSent": {
      const c = captures.get(tabId);
      if (!c?.network) return;
      if (!c.net.has(p.requestId)) c.order.push(p.requestId);
      c.net.set(p.requestId, {
        id: p.requestId,
        method: p.request.method,
        url: p.request.url,
        type: p.type || "Other",
        start: p.timestamp,
      });
      while (c.order.length > NET_LIMIT) c.net.delete(c.order.shift());
      return;
    }
    case "Network.responseReceived": {
      const r = captures.get(tabId)?.net.get(p.requestId);
      if (r) Object.assign(r, { status: p.response.status, mime: p.response.mimeType, type: p.type || r.type });
      return;
    }
    case "Network.loadingFinished": {
      const r = captures.get(tabId)?.net.get(p.requestId);
      if (r) Object.assign(r, { size: p.encodedDataLength, ms: Math.round((p.timestamp - r.start) * 1000) });
      return;
    }
    case "Network.loadingFailed": {
      const r = captures.get(tabId)?.net.get(p.requestId);
      if (r) Object.assign(r, { failed: p.canceled ? "canceled" : p.errorText || "failed", ms: Math.round((p.timestamp - r.start) * 1000) });
      return;
    }
  }
});

/** Turn on console or network capture for a tab. Returns true if it was off. */
async function startCapture(tabId, kind) {
  const c = captureFor(tabId);
  if (c[kind]) return false;
  if (kind === "console") {
    await cdp(tabId, "Runtime.enable", {});
    await cdp(tabId, "Log.enable", {}).catch(() => {});
  } else {
    await cdp(tabId, "Network.enable", { maxPostDataSize: 0 });
  }
  c[kind] = true;
  return true;
}
// The content script (and its title badge) is replaced on navigation. Re-mark
// tabs the agent owns once the new document is ready.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "complete" && markedTabs.has(tabId)) markTab(tabId);
});

async function cdp(tabId, method, params) {
  await attach(tabId);
  const started = Date.now();
  try {
    return await withTimeout(
      chrome.debugger.sendCommand({ tabId }, method, params),
      15000,
      `Input command timed out (${method}). The page may be frozen.`
    );
  } finally {
    const ms = Date.now() - started;
    if (ms > 300) trace("cdp slow", method, `${ms}ms`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A hidden tab still accepts CDP input, but Chrome can throttle each input
 * event until the renderer wakes up (observed at ~5s per move). Focus
 * emulation makes the page believe it is visible/focused without activating
 * the tab, so trusted input stays fast while the human is elsewhere. It is
 * scoped to the action: turn it off again when we are done.
 */
async function setFocusEmulation(tabId, enabled) {
  try {
    await cdp(tabId, "Emulation.setFocusEmulationEnabled", { enabled });
  } catch (err) {
    trace("focus emulation failed", err?.message || String(err));
  }
}

/**
 * Run an input action with focus emulation when the tab is in the background.
 * The tab itself never becomes active, so the human stays where they are.
 */
async function withBackgroundInput(tab, fn) {
  const background = !tab.active;
  if (background) await setFocusEmulation(tab.id, true);
  try {
    return await fn();
  } finally {
    if (background) {
      // While a dialog is open the renderer is paused and this would wait.
      const off = setFocusEmulation(tab.id, false);
      if (!dialogs.has(tab.id)) await off;
    }
  }
}

const KEYMAP = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  " ": { code: "Space", keyCode: 32, text: " " },
};

async function pressKey(tabId, combo) {
  const parts = String(combo).split("+");
  const keyName = parts.pop();
  const modifiers =
    (parts.includes("Meta") ? 4 : 0) |
    (parts.includes("Control") ? 2 : 0) |
    (parts.includes("Alt") ? 1 : 0) |
    (parts.includes("Shift") ? 8 : 0);
  const spec = KEYMAP[keyName] || {
    code: keyName.length === 1 ? `Key${keyName.toUpperCase()}` : keyName,
    keyCode: keyName.length === 1 ? keyName.toUpperCase().charCodeAt(0) : 0,
    text: keyName.length === 1 ? keyName : undefined,
  };

  // CDP key events don't trigger the OS editing shortcuts (⌘A on macOS does
  // nothing), so name the editing command explicitly.
  const primary = modifiers & (modifier === "Meta" ? 4 : 2);
  const commands = primary && keyName.toLowerCase() === "a" ? ["selectAll"] : undefined;

  await cdp(tabId, "Input.dispatchKeyEvent", {
    type: spec.text ? "keyDown" : "rawKeyDown",
    modifiers,
    key: keyName,
    code: spec.code,
    windowsVirtualKeyCode: spec.keyCode,
    nativeVirtualKeyCode: spec.keyCode,
    text: modifiers ? undefined : spec.text,
    commands,
  });
  await cdp(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp",
    modifiers,
    key: keyName,
    code: spec.code,
    windowsVirtualKeyCode: spec.keyCode,
  });
}

async function mouseTo(tabId, x, y, steps = 8) {
  await attach(tabId);
  // Approach from slightly above so hover menus open on the way in.
  const fromY = Math.max(0, y - 24);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    await cdp(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: Math.round(x - (1 - t) * 12),
      y: Math.round(fromY + (y - fromY) * t),
      button: "none",
    });
    await sleep(12);
  }
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
}

async function clickAt(tabId, x, y, beforePress) {
  trace("clickAt start");
  await mouseTo(tabId, x, y);
  trace("mouseTo done");
  // Refresh the guard immediately before the press: a slow attach must not let
  // the agent's own click be mistaken for a human takeover.
  if (beforePress) {
    await beforePress();
    trace("guard refreshed");
  }
  await cdp(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1,
  });
  trace("pressed");
  await sleep(40);
  await cdp(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1,
  });
  trace("released");
}

async function fillAt(tabId, x, y, text, beforePress) {
  await clickAt(tabId, x, y, beforePress);
  await sleep(60);
  await pressKey(tabId, `${modifier}+a`);
  await cdp(tabId, "Input.insertText", { text: String(text) });
}

// ------------------------------------------------------------ change report --
/** Record what is on screen before an action. Returns the document id. */
async function takeBaseline(tabId) {
  try {
    return (await page(tabId, "pointer:baseline", {})).docId;
  } catch {
    return null;
  }
}

/**
 * What changed on screen since the baseline. If the action started a page
 * load, wait for it so the report describes the new page.
 */
async function collectChanges(tabId, docId, opts = {}) {
  if (!docId) return null;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.status === "loading") await waitForLoad(tabId, 10000);
  try {
    const { ok, ...report } = await page(tabId, "pointer:changes", { docId, ...opts });
    return report;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------- dispatch --
function assertNotStopped() {
  if (stopped) {
    stopped = false;
    throw new Error("Stopped by the human. Ask before continuing.");
  }
}

async function dispatch(method, params) {
  const requestedAgent = String(params?.agent || "").trim();
  if (requestedAgent && requestedAgent !== agentName) {
    agentName = requestedAgent;
    refreshGroupLabels().catch(() => {});
  }
  switch (method) {
    case "ext.status":
      return {
        connected,
        lastTabId,
        agentName,
        attached: [...attached],
        groups: await groupSummary(),
        build: self.__pointerBuild || null,
      };

    case "tabs.list": {
      const tabs = await chrome.tabs.query({});
      return tabs
        .filter((t) => t.url && !t.url.startsWith("chrome://"))
        .map((t) => ({
          tabId: t.id,
          title: t.title,
          url: t.url,
          active: t.active,
          windowId: t.windowId,
        }));
    }

    case "tabs.open": {
      // Open in the background, like Claude in Chrome: the human stays on the
      // tab and window (or profile) they are using. Only an explicit
      // focus: true brings the new tab forward.
      const tab = await openBackgroundTab(params.url || "about:blank");
      lastTabId = tab.id;
      // Group it now so the human can spot it; the title badge follows on load.
      markedTabs.add(tab.id);
      await ensureAgentGroup(tab.id).catch(() => {});
      if (params.focus === true) {
        await prepareTab(tab, { bringToFront: true, focusWindow: params.focusWindow !== false });
      }
      await waitForLoad(tab.id);
      await markTab(tab.id);
      const fresh = await chrome.tabs.get(tab.id).catch(() => tab);
      return { tabId: tab.id, url: fresh.url || params.url, focused: params.focus === true };
    }

    case "tabs.focus": {
      const tab = await chrome.tabs.get(params.tabId ?? lastTabId);
      lastTabId = tab.id;
      await prepareTab(tab, { bringToFront: true, focusWindow: params.focusWindow !== false });
      await markTab(tab.id);
      return { tabId: tab.id, url: tab.url, title: tab.title };
    }

    case "tabs.close": {
      const tab = await resolveTab(params);
      await chrome.tabs.remove(tab.id);
      markedTabs.delete(tab.id);
      if (lastTabId === tab.id) lastTabId = null;
      return { closed: tab.id };
    }

    case "page.navigate": {
      const tab = await resolveTab(params);
      lastTabId = tab.id;
      assertNoDialog(tab.id);
      await prepareTab(tab);
      await chrome.tabs.update(tab.id, { url: params.url });
      await waitForLoad(tab.id);
      await markTab(tab.id);
      const fresh = await chrome.tabs.get(tab.id);
      return { tabId: tab.id, url: fresh.url, title: fresh.title };
    }

    case "page.snapshot": {
      const tab = await resolveTab(params);
      lastTabId = tab.id;
      assertNoDialog(tab.id);
      await prepareTab(tab);
      await markTab(tab.id);
      const res = await page(tab.id, "pointer:snapshot", params);
      return { tabId: tab.id, text: res.text, url: (await chrome.tabs.get(tab.id)).url };
    }

    case "page.text": {
      const tab = await resolveTab(params);
      lastTabId = tab.id;
      assertNoDialog(tab.id);
      await markTab(tab.id);
      const res = await page(tab.id, "pointer:text", params);
      return { text: res.text };
    }

    case "page.act": {
      assertNotStopped();
      trace("act start", params.ref || params.selector || "", params.kind || "click");
      const tab = await resolveTab(params);
      lastTabId = tab.id;
      assertNoDialog(tab.id);
      await prepareTab(tab);
      await markTab(tab.id);
      trace("act active");

      return await withBackgroundInput(tab, async () => {
        const spot = await page(tab.id, "pointer:locate", params);
        trace("act located", spot.x, spot.y);
        // After locate: it may have scrolled the target into view.
        const docId = await takeBaseline(tab.id);
        const action = params.kind || "click";
        const label = spot.name || (params.ref ? params.ref : params.selector);

        // Best-effort visual: never let a throttled animation stall the click.
        await Promise.race([
          page(tab.id, "pointer:act", {
            x: spot.x,
            y: spot.y,
            rect: spot.rect,
            label,
            action: action === "click" ? "click" : action,
            click: action === "click",
          }).catch(() => {}),
          sleep(1200),
        ]);
        trace("act visual done");

        const markAgentInput = () =>
          page(tab.id, "pointer:agent-window", { ms: 2000 }).catch(() => {});
        if (action === "click") {
          const { dialog } = await raceDialog(tab.id, clickAt(tab.id, spot.x, spot.y, markAgentInput));
          if (dialog) return { ok: true, target: { role: spot.role, name: spot.name }, url: tab.url, dialog };
        } else if (action === "hover") {
          await mouseTo(tab.id, spot.x, spot.y);
        }
        trace("act input done");

        // Give the page a beat to react so the report sees the result.
        await sleep(params.settleMs ?? 240);
        const changes = await collectChanges(tab.id, docId);
        const after = await chrome.tabs.get(tab.id);
        trace("act done");
        return {
          ok: true,
          target: { role: spot.role, name: spot.name },
          url: after.url,
          x: spot.x,
          y: spot.y,
          changes,
        };
      });
    }

    case "page.fill": {
      assertNotStopped();
      const tab = await resolveTab(params);
      lastTabId = tab.id;
      assertNoDialog(tab.id);
      await prepareTab(tab);
      await markTab(tab.id);
      return await withBackgroundInput(tab, async () => {
        const spot = await page(tab.id, "pointer:locate", params);
        const label = spot.name || params.ref || "field";
        const docId = await takeBaseline(tab.id);

        await Promise.race([
          page(tab.id, "pointer:act", {
            x: spot.x, y: spot.y, rect: spot.rect, label, action: "type",
          }).catch(() => {}),
          sleep(1200),
        ]);
        const markAgentInput = () =>
          page(tab.id, "pointer:agent-window", { ms: 2000 }).catch(() => {});
        const typing = (async () => {
          if (params.trusted === false) {
            await page(tab.id, "pointer:domfill", { ref: params.ref, selector: params.selector, text: params.text });
          } else {
            await fillAt(tab.id, spot.x, spot.y, params.text ?? "", markAgentInput);
          }
          if (params.submit) await pressKey(tab.id, "Enter");
        })();
        const { dialog } = await raceDialog(tab.id, typing);
        if (dialog) return { ok: true, target: label, url: tab.url, dialog };
        await sleep(params.submit ? 240 : 120);
        const changes = await collectChanges(tab.id, docId);
        return { ok: true, target: label, url: (await chrome.tabs.get(tab.id)).url, changes };
      });
    }

    case "page.press": {
      assertNotStopped();
      const tab = await resolveTab(params);
      lastTabId = tab.id;
      assertNoDialog(tab.id);
      await prepareTab(tab);
      await markTab(tab.id);
      return await withBackgroundInput(tab, async () => {
        await page(tab.id, "pointer:agent-window", { ms: 2000 });
        const docId = await takeBaseline(tab.id);
        const { dialog } = await raceDialog(tab.id, pressKey(tab.id, params.key || "Enter"));
        if (dialog) return { ok: true, key: params.key || "Enter", url: tab.url, dialog };
        await sleep(240);
        const changes = await collectChanges(tab.id, docId);
        return { ok: true, key: params.key || "Enter", url: (await chrome.tabs.get(tab.id)).url, changes };
      });
    }

    case "page.scroll": {
      assertNotStopped();
      const tab = await resolveTab(params);
      lastTabId = tab.id;
      assertNoDialog(tab.id);
      await markTab(tab.id);
      const docId = await takeBaseline(tab.id);
      const res = await page(tab.id, "pointer:scroll", params);
      await sleep(150); // let lazy content render
      // Only what scrolled into view; what left the screen is noise here.
      res.changes = await collectChanges(tab.id, docId, { addedOnly: true });
      return res;
    }

    case "page.find": {
      const tab = await resolveTab(params);
      lastTabId = tab.id;
      assertNoDialog(tab.id);
      await markTab(tab.id);
      const res = await page(tab.id, "pointer:find", params);
      return { text: res.text };
    }

    case "page.dialog": {
      const tab = await resolveTab(params);
      const open = dialogs.get(tab.id);
      try {
        await cdp(tab.id, "Page.handleJavaScriptDialog", {
          accept: params.action === "accept",
          promptText: params.text != null ? String(params.text) : undefined,
        });
      } catch (err) {
        if (/no dialog/i.test(String(err?.message))) throw new Error("No dialog is open.");
        throw err;
      }
      dialogs.delete(tab.id);
      await sleep(240);
      return { ok: true, dialog: open || null, action: params.action, url: (await chrome.tabs.get(tab.id)).url };
    }

    case "page.upload": {
      assertNotStopped();
      const tab = await resolveTab(params);
      lastTabId = tab.id;
      assertNoDialog(tab.id);
      await markTab(tab.id);
      const files = (params.paths || []).map(String);
      if (!files.length) throw new Error("Pass at least one file path.");
      return await withBackgroundInput(tab, async () => {
        const target = await page(tab.id, "pointer:file-input", params);
        if (files.length > 1 && !target.multiple) {
          throw new Error(`This file input takes one file; ${files.length} were given.`);
        }
        const docId = await takeBaseline(tab.id);
        if (target.x != null) {
          await Promise.race([
            page(tab.id, "pointer:act", { x: target.x, y: target.y, rect: target.rect, label: target.name, action: "upload" }).catch(() => {}),
            sleep(1200),
          ]);
        }
        const { root } = await cdp(tab.id, "DOM.getDocument", { depth: 0 });
        const { nodeId } = await cdp(tab.id, "DOM.querySelector", {
          nodeId: root.nodeId,
          selector: '[data-pointer-upload="1"]',
        });
        if (!nodeId) throw new Error("The file input disappeared before the upload.");
        try {
          await cdp(tab.id, "DOM.setFileInputFiles", { files, nodeId });
        } catch (err) {
          const msg = String(err?.message || err);
          if (/not allowed|file access|permission/i.test(msg)) {
            throw new Error(
              `Chrome refused the upload (${msg}). Turn on "Allow access to file URLs" for Pointer at chrome://extensions → Details.`
            );
          }
          throw err;
        }
        await sleep(240);
        const changes = await collectChanges(tab.id, docId);
        return { ok: true, target: target.name, accept: target.accept, files: files.length, url: (await chrome.tabs.get(tab.id)).url, changes };
      });
    }

    case "page.console":
    case "page.network": {
      const kind = method === "page.console" ? "console" : "network";
      const tab = await resolveTab(params);
      lastTabId = tab.id;
      const started = await startCapture(tab.id, kind);
      if (params.reload) {
        assertNoDialog(tab.id);
        await chrome.tabs.reload(tab.id);
        await sleep(200);
        await waitForLoad(tab.id, 20000);
        await markTab(tab.id);
      }
      const c = captureFor(tab.id);
      if (kind === "network" && params.body) {
        const r = c.net.get(String(params.body));
        if (!r) throw new Error(`No captured request with id ${params.body}.`);
        const res = await cdp(tab.id, "Network.getResponseBody", { requestId: r.id });
        return { request: r, body: res.base64Encoded ? null : res.body, base64: res.base64Encoded };
      }
      const out = kind === "console" ? c.logs.slice() : c.order.map((id) => c.net.get(id)).filter(Boolean);
      if (params.clear) {
        if (kind === "console") c.logs = [];
        else {
          c.net.clear();
          c.order = [];
        }
      }
      return { started, reloaded: Boolean(params.reload), url: (await chrome.tabs.get(tab.id)).url, entries: out };
    }

    case "page.wait": {
      const tab = await resolveTab(params);
      lastTabId = tab.id;
      assertNoDialog(tab.id);
      await markTab(tab.id);
      return page(tab.id, "pointer:wait", params);
    }

    case "page.screenshot": {
      const tab = await resolveTab(params);
      lastTabId = tab.id;
      assertNoDialog(tab.id);
      await prepareTab(tab);
      await markTab(tab.id);
      await sleep(120);
      const format = params.format || "png";
      trace("shot start");
      let dataUrl = null;
      // captureVisibleTab grabs whatever tab is visible in that window, so it
      // is only correct for the agent tab. If the human moved to another tab
      // or app, render the agent tab with CDP instead.
      const fresh = await chrome.tabs.get(tab.id);
      const win = await chrome.windows.get(fresh.windowId).catch(() => null);
      const visible = fresh.active && win?.focused !== false && win?.state !== "minimized";
      if (visible) {
        try {
          dataUrl = await withTimeout(
            chrome.tabs.captureVisibleTab(fresh.windowId, {
              format,
              quality: params.quality,
            }),
            6000,
            "Screenshot timed out (window hidden or occluded)."
          );
          trace("shot captured");
        } catch (err) {
          trace("shot fallback", err?.message || String(err));
        }
      }
      if (!dataUrl) {
        const res = await cdp(fresh.id, "Page.captureScreenshot", {
          format,
          quality: format === "jpeg" ? params.quality : undefined,
        });
        dataUrl = `data:image/${format === "jpeg" ? "jpeg" : "png"};base64,${res.data}`;
        trace("shot via cdp");
      }
      return { dataUrl, tabId: tab.id, url: tab.url };
    }

    case "page.hidePointer": {
      const tab = await resolveTab(params);
      await page(tab.id, "pointer:hide", {});
      await unmarkTabs();
      return { ok: true };
    }

    case "ext.rename":
      agentName = params.name || agentName;
      await refreshGroupLabels();
      return { agentName, groups: await groupSummary() };

    case "ext.reload":
      // Pick up edited unpacked files without asking the human to click reload.
      setTimeout(() => chrome.runtime.reload(), 200);
      return { reloading: true };

    default:
      throw new Error(`Unknown method ${method}`);
  }
}

async function waitForLoad(tabId, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    if (tab.status === "complete") {
      await sleep(250);
      return;
    }
    await sleep(120);
  }
}
