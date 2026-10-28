/**
 * Pointer service worker.
 *
 * Bridges a local hub (WebSocket) to the tab the agent is driving:
 *   hub -> page: snapshot / locate / act
 *   hub <- page: refs and coordinates
 * and dispatches *trusted* input through chrome.debugger, so clicks survive
 * React handlers and site-specific pointer checks.
 */

import {
  initialPresence,
  describeCommand,
  onCommand,
  onSay,
  onClearSay,
  onExplicitDone,
  stopAccepted,
  onHumanStop,
  onResume,
  onTick,
  onDismiss,
  groupPrefix,
  baseGroupTitle,
  effectsOf,
  viewOf,
  notificationText,
} from "./presence.js";
import { SETTINGS_KEY, withDefaults } from "./settings.js";
import { isBlockedUrl } from "./sites.js";

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
const openedTabs = new Set(); // tabs tab_open created; tab_close may close these
const viewports = new Map(); // tabId -> emulated screen size, reapplied if the debugger reattaches
const captions = new Map(); // tabId -> { text, step, until }, shown again after the page loads
let presence = initialPresence(); // what the human sees: active, quiet, stopped, done (see presence.js)
let commandsInFlight = 0;
// The human's choices from the settings page; only that page writes them.
let settings = withDefaults(undefined);

// The human's stop, the agent's own tabs and emulated sizes must survive the
// service worker being suspended, so they live in session storage too.
const restored = chrome.storage.session
  .get([
    "pointerStopped",
    "pointerOpenedTabs",
    "pointerViewports",
    "pointerCaptions",
    "pointerPresence",
    "pointerMarkedTabs",
    "pointerAgentGroups",
  ])
  .then((v) => {
    stopped = stopped || Boolean(v.pointerStopped);
    for (const id of v.pointerOpenedTabs || []) openedTabs.add(Number(id));
    for (const [id, size] of Object.entries(v.pointerViewports || {})) {
      if (!viewports.has(Number(id))) viewports.set(Number(id), size);
    }
    for (const [id, cap] of Object.entries(v.pointerCaptions || {})) {
      if (!captions.has(Number(id))) captions.set(Number(id), cap);
    }
    if (v.pointerPresence && presence.state === "idle") presence = { ...initialPresence(), ...v.pointerPresence };
    // The agent's tabs and groups, so a worker Chrome woke again can still retitle and clear them.
    for (const id of v.pointerMarkedTabs || []) markedTabs.add(Number(id));
    for (const [windowId, groupId] of Object.entries(v.pointerAgentGroups || {})) {
      if (!agentGroups.has(Number(windowId))) agentGroups.set(Number(windowId), groupId);
    }
  })
  .catch(() => {});

const settingsLoaded = chrome.storage.local
  .get(SETTINGS_KEY)
  .then((v) => {
    settings = withDefaults(v?.[SETTINGS_KEY]);
  })
  .catch(() => {});

// Saved state and the human's settings are both back: every path that acts on
// them after the worker wakes (commands, stops, alarms, page loads) waits for this.
const ready = Promise.all([restored, settingsLoaded]);

// A change on the settings page applies at once: titles and the agent's tab update.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[SETTINGS_KEY]) return;
  settings = withDefaults(changes[SETTINGS_KEY].newValue);
  refreshGroupLabels().catch(() => {});
  pushPresence();
});

function saveState() {
  chrome.storage.session
    .set({
      pointerStopped: stopped,
      pointerOpenedTabs: [...openedTabs],
      pointerViewports: Object.fromEntries(viewports),
      pointerCaptions: Object.fromEntries(captions),
      pointerPresence: presence,
      pointerMarkedTabs: [...markedTabs],
      pointerAgentGroups: Object.fromEntries(agentGroups),
    })
    .catch(() => {});
}
const agentGroups = new Map(); // windowId -> Chrome tab group id
let modifier = "Meta"; // set from platform info

// Chrome's tab-group palette. Purple matches Pointer's accent; the title comes
// from the hub's agent name, so Claude shows up as a "Claude" group.
const GROUP_COLOR = "purple";
const GROUP_TITLE_MAX = 24;

// Toggle when hunting a slow command; logs go to the extension worker console.
const TRACE = false;
const BUILD = "0.2.24";
const traceStart = Date.now();
self.__pointerBuild = BUILD;
// When the agent runs with POINTER_DEBUG, each call's trace goes back with its
// result, so a slow step shows up in the agent's log, not only in this console.
let callTrace = null;
function trace(...args) {
  if (TRACE) console.log(`[pointer +${Date.now() - traceStart}ms]`, ...args);
  if (callTrace && callTrace.lines.length < 200) {
    callTrace.lines.push(`+${Date.now() - callTrace.start}ms ${args.join(" ")}`);
  }
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

let reconnectTimer = null;
let heartbeat = null;

/**
 * One socket at a time. Every handler acts only on the socket it belongs to:
 * a stale socket closing must never clear or close the live one, or a fresh
 * connect() opens a second socket while the first stays open (the hub then
 * routes commands to a connection that never said hello).
 */
function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const ws = new WebSocket(HUB_URL);
  socket = ws;
  const sendOn = (obj) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };

  ws.addEventListener("open", async () => {
    if (socket !== ws) return ws.close();
    connected = true;
    reconnectDelay = 800;
    const instanceId = await getInstanceId();
    sendOn({
      event: "hello",
      name: "pointer-extension",
      version: chrome.runtime.getManifest().version,
      instanceId,
      build: self.__pointerBuild || null,
      lastFocusedAt: await focusedAt(),
    });
    setBadge("on");
    // MV3 stops an idle service worker after ~30s, which drops the socket.
    // Traffic every 20s keeps it alive (Chrome 116+).
    clearInterval(heartbeat);
    heartbeat = setInterval(() => sendOn({ event: "ping" }), 20000);
  });

  ws.addEventListener("message", async (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (!msg || !msg.id) return;
    if (typeof msg.method !== "string") {
      sendOn({ id: msg.id, ok: false, error: "Malformed command: method is missing" });
      return;
    }
    const started = Date.now();
    const debug = msg.params?.debug === true;
    if (debug) callTrace = { start: started, lines: [] };
    const traced = () => {
      const lines = debug && callTrace ? callTrace.lines : undefined;
      if (debug) callTrace = null;
      return lines;
    };
    try {
      const result = await dispatch(msg.method, msg.params || {});
      trace("handled", msg.method, `${Date.now() - started}ms`);
      const lines = traced();
      const out = lines && result && typeof result === "object" && !Array.isArray(result) ? { ...result, _trace: lines } : result;
      sendOn({ id: msg.id, ok: true, result: out });
    } catch (err) {
      trace("failed", msg.method, `${Date.now() - started}ms`, err?.message || String(err));
      const lines = traced();
      const error = err instanceof Error ? String(err.message) : "Command failed";
      sendOn({ id: msg.id, ok: false, error, ...(lines ? { trace: lines } : {}) });
    }
  });

  ws.addEventListener("close", () => {
    if (socket !== ws) return; // an old socket; the live one is unaffected
    socket = null;
    connected = false;
    clearInterval(heartbeat);
    setBadge("off");
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.7, 8000);
  });
  ws.addEventListener("error", () => {
    try {
      ws.close();
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

// ---------------------------------------------------------- focus tracking ---
// Each Chrome profile runs its own copy of this extension. Telling the hub when
// this profile last had a focused window lets it start the next task in the
// profile the human is using. Stored in session storage so an evicted worker
// remembers it.
async function focusedAt() {
  let at = 0;
  try {
    at = (await chrome.storage.session.get("pointerFocusedAt")).pointerFocusedAt || 0;
  } catch {}
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    if (win?.focused) at = Date.now(); // a window of this profile is in front right now
  } catch {}
  return at;
}

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return; // focus left this profile
  const at = Date.now();
  chrome.storage.session.set({ pointerFocusedAt: at }).catch(() => {});
  if (connected) send({ event: "focus", at });
  else connect(); // hello carries the timestamp
});

// The service worker can be evicted; this keeps reconnecting while idle.
// Create the alarm only once: re-creating it on every worker start resets its
// clock, so a worker that keeps waking up early could postpone it forever.
chrome.alarms.get("pointer-keepalive").then((alarm) => {
  if (!alarm) chrome.alarms.create("pointer-keepalive", { periodInMinutes: 0.5 });
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "pointer-keepalive") {
    connect();
    ready.then(() => applyPresence(onTick(presence, Date.now())));
  }
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();

// --------------------------------------------------------------- messaging ---
/**
 * The human stopped the agent (Escape, a click in its tab, the popup, or the
 * keyboard shortcut). The stop holds until the agent calls resume, which it
 * should do only after the human agrees.
 */
const STOP_SOURCES = { escape: "esc", takeover: "click", bar: "bar", popup: "popup", shortcut: "shortcut" };

async function stopAgent(reason) {
  await ready;
  // Esc, a click and the bar count only while the agent may be working; the
  // popup and the shortcut always stop, even with no agent in sight.
  const source = STOP_SOURCES[reason] || "popup";
  if (!stopAccepted(presence, source)) return false;
  stopped = true;
  clearCaptions().catch(() => {});
  saveState();
  // The tab group and badges stay (as "✋ name"), so the human can see who is waiting.
  applyPresence(onHumanStop(presence, { now: Date.now() }));
  send({ event: "stop", reason: reason || "user" });
  return true;
}

// A shortcut is handled by Chrome itself, so a page cannot swallow it the way
// it can swallow Escape.
chrome.commands?.onCommand.addListener((command) => {
  if (command === "stop-agent") stopAgent("shortcut");
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || sender?.id !== chrome.runtime.id) return;
  if (msg.type === "pointer:stop") {
    stopAgent(msg.reason).then(
      (accepted) => sendResponse({ ok: true, accepted }),
      () => sendResponse({ ok: false })
    );
    return true;
  }
  if (msg.type === "pointer:test-notification") {
    // The settings page's Test button: shown even while the human is looking.
    watchNotificationClicks();
    (async () => {
      if (!(await canNotify())) return sendResponse({ ok: false });
      await chrome.notifications.create("pointer-test", {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "Pointer notifications work",
        message: "You'll see this when an agent finishes or needs you.",
        silent: !settings.sound,
      });
      sendResponse({ ok: true });
    })().catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === "pointer:dismiss") {
    // Got it on the stopped bar, or ✕ on a chip. Never resumes the agent.
    ready.then(() => applyPresence(onDismiss(presence, Date.now())));
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
/**
 * The tab a command acts on. Every tab command passes through here, so this is
 * where sites the human blocked, and extension pages (the settings page), are
 * refused. allowBlocked is only for the agent's own stop, which must always work.
 */
async function resolveTab(params = {}, { allowBlocked = false } = {}) {
  const tab = await findTab(params);
  if (!allowBlocked) {
    assertNotExtensionPage(tab.url);
    assertSiteAllowed(tab.url);
  }
  return tab;
}

async function findTab(params) {
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

const BLOCKED_MESSAGE = "This site is blocked in Pointer's settings. Ask the human to do this step.";

const isBlocked = (url) => isBlockedUrl(String(url || ""), settings.blockedSites);

/** Refuse a site the human listed on the settings page. */
function assertSiteAllowed(url) {
  if (isBlocked(url)) throw new Error(BLOCKED_MESSAGE);
}

/** Refuse extension pages, so an agent can never reach Pointer's settings. */
function assertNotExtensionPage(url) {
  if (String(url || "").startsWith("chrome-extension://")) throw new Error("Pointer cannot act on extension pages.");
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
  const name = (agentName || "agent").trim().slice(0, GROUP_TITLE_MAX) || "agent";
  return (settings.groupStatus ? groupPrefix(presence) : "") + name;
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
      if (existing && baseGroupTitle(existing.title) === baseGroupTitle(title)) {
        agentGroups.set(tab.windowId, tab.groupId);
        saveState();
        // It may still carry an old ⌛ ✋ ✅ from before the worker restarted.
        if (existing.title !== title) await chrome.tabGroups.update(tab.groupId, { title }).catch(() => {});
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
    saveState();
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
    saveState();
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
  if (!markedTabs.has(tabId)) {
    markedTabs.add(tabId);
    saveState();
  }
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
  saveState();
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
  // Emulation ends with the debugger session; restore the size the agent chose.
  const size = viewports.get(tabId);
  if (size) await applyViewport(tabId, size).catch(() => {});
}

/** Emulate a screen size in one tab, or clear it. Never touches the window. */
async function applyViewport(tabId, size) {
  const send = (method, params) => chrome.debugger.sendCommand({ tabId }, method, params);
  if (!size) {
    await send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await send("Emulation.clearDeviceMetricsOverride");
    return;
  }
  // Touch first, so resize handlers that check for touch see the new value.
  await send("Emulation.setTouchEmulationEnabled", size.mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
  await send("Emulation.setDeviceMetricsOverride", {
    width: size.width,
    height: size.height,
    deviceScaleFactor: size.deviceScaleFactor,
    mobile: size.mobile,
  });
}

chrome.debugger.onDetach.addListener(({ tabId }) => forgetTab(tabId, { keepMarks: true }));
chrome.tabs.onRemoved.addListener((tabId) => forgetTab(tabId));

function forgetTab(tabId, { keepMarks = false } = {}) {
  attached.delete(tabId);
  if (!keepMarks) openedTabs.delete(tabId);
  dialogs.delete(tabId);
  captures.delete(tabId);
  if (!keepMarks) markedTabs.delete(tabId);
  if (!keepMarks) viewports.delete(tabId);
  if (!keepMarks) captions.delete(tabId);
  if (!keepMarks) saveState();
}

/**
 * Chrome refuses debugger input on a page that contains another extension's
 * frame (a password manager's autofill popup, for example). Reading still
 * works through the content script, so input falls back to page events.
 */
const PICKER_INPUTS = new Set(["date", "time", "datetime-local", "month", "week", "color", "range"]);

function debuggerBlocked(err) {
  return /chrome-extension:\/\/ URL of different extension|Cannot access a chrome-extension|Detached while handling command/i.test(
    String(err?.message || err)
  );
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
  return {
    promise,
    cancel: () => {
      set.delete(resolve);
      if (!set.size && dialogWaiters.get(tabId) === set) dialogWaiters.delete(tabId);
    },
  };
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

/** The first stack frame from the page itself, not an extension's console hook. */
function pageFrame(frames = []) {
  return frames.find((f) => f.url && !f.url.startsWith("chrome-extension://")) || frames[0];
}

function where(frame) {
  if (!frame?.url) return "";
  const file = frame.url.split(/[?#]/)[0].split("/").pop() || frame.url;
  return ` (${file}:${(frame.lineNumber ?? 0) + 1})`;
}

const eventWaiters = new Map(); // `${tabId}:${method}` -> Set<resolve>

/** Resolve with the params of the next `method` event in this tab. */
function nextEvent(tabId, method) {
  const key = `${tabId}:${method}`;
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  const set = eventWaiters.get(key) ?? new Set();
  eventWaiters.set(key, set);
  set.add(resolve);
  return {
    promise,
    cancel: () => {
      set.delete(resolve);
      if (!set.size && eventWaiters.get(key) === set) eventWaiters.delete(key);
    },
  };
}

chrome.debugger.onEvent.addListener((source, method, p) => {
  const tabId = source.tabId;
  if (tabId == null) return;
  const waiting = eventWaiters.get(`${tabId}:${method}`);
  if (waiting?.size) {
    for (const resolve of waiting) resolve(p);
    waiting.clear();
    eventWaiters.delete(`${tabId}:${method}`);
  }
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
      return pushLog(tabId, { level, text: text + where(pageFrame(p.stackTrace?.callFrames)) });
    }
    case "Runtime.exceptionThrown": {
      const d = p.exceptionDetails || {};
      const text = d.exception?.description?.split("\n")[0] || d.text || "Uncaught exception";
      return pushLog(tabId, { level: "error", text: text + where(pageFrame(d.stackTrace?.callFrames) || d) });
    }
    case "Log.entryAdded": {
      const e = p.entry || {};
      const level = e.level === "verbose" ? "debug" : e.level === "info" ? "log" : e.level;
      return pushLog(tabId, { level, text: `[${e.source}] ${e.text}${e.url ? ` (${e.url.slice(0, 100)})` : ""}` });
    }
    case "Network.requestWillBeSent": {
      const c = captures.get(tabId);
      if (!c?.network) return;
      // Other extensions' own files are not the page's traffic.
      if (p.request.url.startsWith("chrome-extension://")) return;
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

// Console capture without the debugger. Chrome refuses the debugger on a page
// that holds another extension's frame (a password manager's), so a hook in
// the page itself records console calls and uncaught errors from now on.
// It lives in the document: a navigation or reload removes it.
function installConsoleHook() {
  if (window.__pointerConsole) return;
  const logs = [];
  const text = (a) => {
    if (typeof a === "string") return a;
    if (a instanceof Error) return String(a.stack || a).split("\n")[0];
    try {
      return JSON.stringify(a) ?? String(a);
    } catch {
      return String(a);
    }
  };
  const push = (level, msg) => {
    logs.push({ at: Date.now(), level, text: msg });
    if (logs.length > 300) logs.splice(0, logs.length - 300);
  };
  const levels = { log: "log", info: "log", debug: "debug", warn: "warning", error: "error" };
  for (const [name, level] of Object.entries(levels)) {
    const orig = console[name];
    console[name] = function (...args) {
      try {
        push(level, args.map(text).join(" "));
      } catch {}
      return orig.apply(this, args);
    };
  }
  addEventListener(
    "error",
    (e) => {
      if (e.target && e.target !== window) {
        const src = e.target.src || e.target.href || "";
        return push("error", `Failed to load ${String(e.target.tagName || "resource").toLowerCase()} ${src.slice(0, 100)}`);
      }
      const file = e.filename ? ` (${e.filename.split(/[?#]/)[0].split("/").pop()}:${e.lineno})` : "";
      push("error", (e.error ? text(e.error) : e.message || "Uncaught error") + file);
    },
    true
  );
  addEventListener("unhandledrejection", (e) => push("error", `Uncaught (in promise) ${text(e.reason)}`));
  Object.defineProperty(window, "__pointerConsole", { value: logs });
}

function readConsoleHook(clear) {
  const logs = window.__pointerConsole;
  if (!logs) return null;
  const out = logs.slice();
  if (clear) logs.length = 0;
  return out;
}

async function pageConsole(tab, params) {
  const run = (func, args = []) =>
    chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func, args }).then((r) => r?.[0]?.result);
  if (params.reload) {
    assertNoDialog(tab.id);
    await chrome.tabs.reload(tab.id);
    await sleep(200);
    await waitForLoad(tab.id, 20000);
    await markTab(tab.id);
  }
  let entries = await run(readConsoleHook, [Boolean(params.clear)]);
  const started = entries == null;
  if (started) {
    await run(installConsoleHook);
    entries = [];
  }
  return { started, reloaded: Boolean(params.reload), url: (await chrome.tabs.get(tab.id)).url, entries, pageHook: true };
}

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
// tabs the agent owns once the new document is ready, and bring back a caption
// the agent is still showing there.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== "complete") return;
  ready.then(() => afterLoad(tabId, tab));
});

function afterLoad(tabId, tab) {
  // The agent's tab landed on a blocked site (a click, a redirect): draw nothing
  // there; every further command on it is refused by resolveTab.
  if (isBlocked(tab?.url) && (markedTabs.has(tabId) || tabId === presence.tabId)) {
    page(tabId, "pointer:hide", {}).catch(() => {});
    page(tabId, "pointer:presence", viewOf(initialPresence(), settings, agentName)).catch(() => {});
    return;
  }
  if (markedTabs.has(tabId)) markTab(tabId);
  if (tabId === presence.tabId) pushPresence(tabId);
  const cap = captions.get(tabId);
  if (cap && !stopped) {
    if (cap.until && cap.until <= Date.now()) {
      captions.delete(tabId);
      saveState();
    } else {
      page(tabId, "pointer:caption", cap).catch(() => {});
    }
  }
}

/** Take every caption down, e.g. when the human stops the agent. */
async function clearCaptions() {
  const live = [...captions.keys()].filter((id) => {
    const until = captions.get(id).until;
    return !until || until > Date.now();
  });
  const ids = [...captions.keys()];
  captions.clear();
  saveState();
  await Promise.all(ids.map((id) => page(id, "pointer:caption", { off: true }).catch(() => {})));
  return live.length > 0;
}

async function cdp(tabId, method, params) {
  if (stopped && method.startsWith("Input.")) throw new Error(STOP_MESSAGE);
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

/** A wait the caller asked for, kept between 0 and `max` ms. */
function clampMs(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n > max) return max;
  if (n < 0) return 0;
  return n;
}

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
const tabLocks = new Map(); // tabId -> promise of the input work in progress

/** Input on one tab runs one call at a time, so mouse and key events never interleave. */
async function withTabLock(tabId, fn) {
  const prev = tabLocks.get(tabId) || Promise.resolve();
  let release;
  const mine = prev.then(() => new Promise((r) => (release = r)));
  tabLocks.set(tabId, mine);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (tabLocks.get(tabId) === mine) tabLocks.delete(tabId);
  }
}

async function withBackgroundInput(tab, fn) {
  return withTabLock(tab.id, async () => {
    const input = await beginAgentInput(tab);
    try {
      return await backgroundInput(tab, fn);
    } finally {
      endAgentInput(tab.id, input);
    }
  });
}

// ------------------------------------------------------- tabs from clicks ---
// A click on a target="_blank" link (or a page's window.open) makes a tab the
// agent caused but did not open with tab_open. Such a tab is the agent's: it
// joins the group, tab_close can close it, and it must not take focus from
// the human. Only a tab opened by the agent's tab during, or just after, the
// agent's own input counts, so links the human opens are never touched.
const SPAWN_GRACE_MS = 4000;
const agentInputs = new Map(); // tabId -> { windowId, start, until, active, focusedWindow, spawned: [] }

async function beginAgentInput(tab) {
  const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId }).catch(() => []);
  const focused = await chrome.windows.getLastFocused().catch(() => null);
  const input = {
    windowId: tab.windowId,
    start: Date.now(),
    until: Infinity,
    active: active?.id ?? null,
    focusedWindow: focused?.focused ? focused.id : null,
    spawned: [],
  };
  agentInputs.set(tab.id, input);
  return input;
}

function endAgentInput(tabId, input) {
  input.until = Date.now() + SPAWN_GRACE_MS;
  setTimeout(() => {
    if (agentInputs.get(tabId) === input) agentInputs.delete(tabId);
  }, SPAWN_GRACE_MS + 50);
}

/** The agent input that a new tab came from, if any. */
function inputFor(tab) {
  const now = Date.now();
  if (tab.openerTabId != null) {
    const input = agentInputs.get(tab.openerTabId);
    return input && now <= input.until ? { opener: tab.openerTabId, input } : null;
  }
  // Chrome leaves out the opener for some popups; accept a tab in the agent's
  // window only while a click is still in flight there. A blank new tab is the
  // human pressing Cmd/Ctrl+T, never a link.
  const url = tab.pendingUrl || tab.url || "";
  if (!url || /^chrome:\/\/new-?tab|^about:blank/i.test(url)) return null;
  for (const [opener, input] of agentInputs) {
    if (input.windowId === tab.windowId && input.until === Infinity) return { opener, input };
  }
  return null;
}

chrome.tabs.onCreated.addListener((tab) => {
  const from = inputFor(tab);
  if (!from) return;
  adoptSpawnedTab(tab, from).catch((err) => trace("adopt failed", err?.message || String(err)));
});

async function adoptSpawnedTab(tab, { opener, input }) {
  await restored;
  openedTabs.add(tab.id);
  markedTabs.add(tab.id);
  saveState();
  input.spawned.push({ tabId: tab.id, url: tab.pendingUrl || tab.url || "" });
  trace("adopted tab", tab.id, "from", opener);
  // Give the human back the tab and window they had. Chrome may activate the
  // tab just after it is created, so look again after a moment.
  await keepFocus(tab, input);
  setTimeout(() => keepFocus(tab, input).catch(() => {}), 150);
  await ensureAgentGroup(tab.id).catch(() => {});
}

async function keepFocus(tab, input) {
  const now = await chrome.tabs.get(tab.id).catch(() => null);
  if (!now) return;
  if (now.active && input.active != null && input.active !== tab.id) {
    if (now.windowId === input.windowId) await chrome.tabs.update(input.active, { active: true }).catch(() => {});
  }
  if (input.focusedWindow != null && now.windowId !== input.focusedWindow) {
    const win = await chrome.windows.get(now.windowId).catch(() => null);
    if (win?.focused) await chrome.windows.update(input.focusedWindow, { focused: true }).catch(() => {});
  }
}

/** Tabs the input now running in this tab has opened (call it inside withBackgroundInput). */
async function spawnedTabs(tabId) {
  const input = agentInputs.get(tabId);
  if (!input) return [];
  const out = [];
  for (const s of input.spawned) {
    const t = await chrome.tabs.get(s.tabId).catch(() => null);
    if (t) out.push({ tabId: t.id, url: t.pendingUrl || t.url || s.url });
  }
  return out;
}

async function backgroundInput(tab, fn) {
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

/**
 * Upload through a button that opens the file picker itself (no file input in
 * the page until clicked). Intercept the picker so no OS dialog appears, click
 * the button, and hand the picker's input the files.
 */
async function uploadThroughChooser(tab, target, files) {
  const docId = await takeBaseline(tab.id);
  await cdp(tab.id, "Page.enable", {});
  await cdp(tab.id, "Page.setInterceptFileChooserDialog", { enabled: true });
  const opened = nextEvent(tab.id, "Page.fileChooserOpened");
  try {
    await Promise.race([
      page(tab.id, "pointer:act", { x: target.x, y: target.y, rect: target.rect, label: target.name, action: "upload", click: true }).catch(() => {}),
      sleep(1200),
    ]);
    const markAgentInput = () => page(tab.id, "pointer:agent-window", { ms: 2000 }).catch(() => {});
    await clickAt(tab.id, target.x, target.y, markAgentInput);
    const chooser = await withTimeout(
      opened.promise,
      5000,
      "Clicking that element did not open a file picker. Pass the ref of the upload button."
    );
    if (files.length > 1 && chooser.mode !== "selectMultiple") {
      throw new Error(`This picker takes one file; ${files.length} were given.`);
    }
    await cdp(tab.id, "DOM.setFileInputFiles", { files, backendNodeId: chooser.backendNodeId });
  } finally {
    opened.cancel();
    await cdp(tab.id, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
  }
  await sleep(400);
  const changes = await collectChanges(tab.id, docId);
  return { ok: true, target: target.name, accept: "", files: files.length, url: (await chrome.tabs.get(tab.id)).url, changes };
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
async function collectChanges(tabId, docId, { loaded = false, ...opts } = {}) {
  if (!docId) return null;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  // `loaded`: the caller already waited for the page (see settle).
  if (tab?.status === "loading" && !loaded) await waitForLoad(tabId, 10000);
  try {
    const { ok, ...report } = await page(tabId, "pointer:changes", { docId, ...opts });
    return report;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------- dispatch --
const STOP_MESSAGE =
  "Stopped by the human. Ask them before continuing; once they agree, call resume.";

/** The stop holds until resume: every refused call says so, not just the first. */
function assertNotStopped() {
  if (stopped) throw new Error(STOP_MESSAGE);
}

/** Only web pages and a blank tab: no file://, chrome://, data: or javascript:. */
function assertWebUrl(url) {
  if (url === "about:blank") return;
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Not a valid URL: ${url}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`Pointer opens only http and https pages, not ${u.protocol}`);
  }
}

const SECRET_FILE =
  /^(id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p12|pfx|kdbx|keychain|keychain-db|gpg|asc)|credentials(\.json)?|.*secret.*|.*\.env|\.env.*)$/i;

/** Refuse hidden files and anything that looks like a key or credential. */
function assertUploadable(file) {
  const parts = String(file).split(/[\\/]+/).filter(Boolean);
  const name = parts[parts.length - 1] || "";
  if (parts.some((p) => p.startsWith(".")) || SECRET_FILE.test(name)) {
    throw new Error(
      `Pointer will not upload ${name}: it is a hidden file or looks like a key or credential. ` +
        "If the human really means it, they can attach it themselves."
    );
  }
}

/**
 * Every agent command passes through here: it counts as activity for the
 * presence the human sees, then runs. After it finishes, presence follows the
 * tab the agent ended up on (tab_open, tab_select) and restarts the
 * "thinking" clock.
 */
async function dispatch(method, params) {
  await ready;
  const requestedAgent = String(params?.agent || "").trim();
  if (requestedAgent && requestedAgent !== agentName) {
    agentName = requestedAgent;
    refreshGroupLabels().catch(() => {});
  }
  const counts = describeCommand(method, params || {}) !== null;
  applyPresence(onCommand(presence, { method, params, tabId: params?.tabId ?? lastTabId, now: Date.now(), held: stopped }));
  if (counts) commandsInFlight++;
  try {
    const result = await runCommand(method, params);
    await assertResultNotBlocked(method, result);
    return result;
  } finally {
    if (counts) {
      commandsInFlight = Math.max(0, commandsInFlight - 1);
      if (presence.state === "active") {
        applyPresence({ ...presence, tabId: lastTabId ?? presence.tabId, lastActivityAt: Date.now() });
      }
    }
  }
}

// Calls whose results never carry page content, or that must work anywhere.
const NO_PAGE_RESULT = new Set(["ext.status", "ext.rename", "ext.reload", "ext.resume", "tabs.list", "tabs.close", "page.hidePointer", "page.caption"]);

/**
 * The block is checked before a command, but a click, Enter, history step or
 * redirect can land on a blocked site during it. Then the result (a snapshot,
 * the changes, the new URL and title) must not reach the agent.
 */
async function assertResultNotBlocked(method, result) {
  if (NO_PAGE_RESULT.has(method) || !settings.blockedSites.length) return;
  const tabId = result?.tabId ?? lastTabId;
  if (tabId == null) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab && isBlocked(tab.url)) {
    throw new Error(
      "That took the tab to a site blocked in Pointer's settings, so Pointer shows nothing from it. " +
        "Ask the human to do this step."
    );
  }
}

/** Push the current presence to the tab it belongs to. */
function pushPresence(tabId = presence.tabId) {
  if (tabId == null) return;
  const view = { ...viewOf(presence, settings, agentName), busy: commandsInFlight > 0 };
  page(tabId, "pointer:presence", view).catch(() => {});
}

/**
 * The one place presence changes. Side effects follow from the change: the
 * old tab is cleared, group titles get their ⌛ ✋ ✅, marks go when a done or
 * an unresumed stop expires, and the human may be notified.
 */
function applyPresence(next) {
  const prev = presence;
  if (next === prev) return;
  presence = next;
  saveState();
  const fx = effectsOf(prev, next);
  if (fx.clearTab != null) {
    page(fx.clearTab, "pointer:presence", viewOf(initialPresence(), settings, agentName)).catch(() => {});
  }
  if (fx.unmark) unmarkTabs().catch(() => {});
  else if (fx.retitle) refreshGroupLabels().catch(() => {});
  pushPresence();
  if (fx.notify) notifyFor(fx.notify).catch(() => {});
}

/** Is the human looking at the agent's tab right now (its window focused, the tab in front)? */
async function humanIsWatching(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.active) return false;
  const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
  return Boolean(win?.focused && win.id === tab.windowId);
}

async function canNotify() {
  if (!chrome.notifications) return false; // absent until the human allows notifications
  return chrome.permissions.contains({ permissions: ["notifications"] }).catch(() => false);
}

/**
 * Tell the human the agent finished or is waiting for them: only if they turned
 * it on, and only when they are not already looking at the agent's tab.
 */
async function notifyFor(kind) {
  if (kind === "done" ? !settings.notifyDone : !settings.notifyStopped) return;
  if (!(await canNotify())) return;
  const tabId = presence.tabId;
  if (tabId != null && (await humanIsWatching(tabId))) return;
  const tab = tabId != null ? await chrome.tabs.get(tabId).catch(() => null) : null;
  let host = "this page";
  try {
    if (tab?.url) host = new URL(tab.url).hostname.replace(/^www\./, "") || host;
  } catch {}
  const { title, message } = notificationText(kind, { agent: agentName, actions: presence.actions, host });
  await chrome.notifications.create(`pointer-${kind}`, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title,
    message,
    silent: !settings.sound,
  });
}

/** Clicking a notification brings the agent's tab and window forward. */
function watchNotificationClicks() {
  if (!chrome.notifications || watchNotificationClicks.done) return;
  watchNotificationClicks.done = true;
  chrome.notifications.onClicked.addListener(async (id) => {
    if (!id.startsWith("pointer-")) return;
    chrome.notifications.clear(id).catch(() => {});
    if (id === "pointer-test") return;
    const tab = presence.tabId != null ? await chrome.tabs.get(presence.tabId).catch(() => null) : null;
    if (!tab) return;
    await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  });
}
watchNotificationClicks();
// The API appears when the human grants the permission on the settings page.
chrome.permissions?.onAdded?.addListener(() => watchNotificationClicks());

async function runCommand(method, params) {
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
        .filter((t) => t.url && !t.url.startsWith("chrome://") && !t.url.startsWith("chrome-extension://"))
        .map((t) => ({
          tabId: t.id,
          // A blocked site is listed, but the agent never learns what is on it.
          title: isBlocked(t.url) ? "(blocked site)" : t.title,
          url: isBlocked(t.url) ? "" : t.url,
          active: t.active,
          agent: t.id === lastTabId,
          windowId: t.windowId,
        }));
    }

    case "tabs.select": {
      // Switch the agent's working tab without bringing it forward.
      const tab = await chrome.tabs.get(Number(params.tabId));
      assertNotExtensionPage(tab.url);
      assertSiteAllowed(tab.url);
      lastTabId = tab.id;
      await markTab(tab.id);
      return { tabId: tab.id, url: tab.url, title: tab.title };
    }

    case "tabs.open": {
      assertNotStopped();
      assertWebUrl(params.url || "about:blank");
      assertSiteAllowed(params.url);
      // Open in the background, like Claude in Chrome: the human stays on the
      // tab and window (or profile) they are using. Only an explicit
      // focus: true brings the new tab forward.
      const tab = await openBackgroundTab(params.url || "about:blank");
      lastTabId = tab.id;
      openedTabs.add(tab.id);
      saveState();
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
      assertNotStopped();
      const tab = await chrome.tabs.get(params.tabId ?? lastTabId);
      assertNotExtensionPage(tab.url);
      assertSiteAllowed(tab.url);
      lastTabId = tab.id;
      await prepareTab(tab, { bringToFront: true, focusWindow: params.focusWindow !== false });
      await markTab(tab.id);
      return { tabId: tab.id, url: tab.url, title: tab.title };
    }

    case "tabs.close": {
      // Only tabs the agent opened. A tab the human handed over (tab_select,
      // or the page they were on) is theirs: the agent never closes it.
      const ids = params.all ? [...openedTabs] : [Number(params.tabId ?? lastTabId)];
      const closed = [];
      for (const id of ids) {
        if (!openedTabs.has(id)) {
          if (!params.all) throw new Error(`Tab ${id} was not opened by the agent; ask the human to close it.`);
          continue;
        }
        await chrome.tabs.remove(id).catch(() => {});
        openedTabs.delete(id);
        markedTabs.delete(id);
        if (lastTabId === id) lastTabId = null;
        closed.push(id);
      }
      saveState();
      // Closing all its tabs means the agent is finished. The human's own tabs it
      // worked in keep a done mark for a while; the marks go when it clears.
      if (params.all) {
        await clearCaptions().catch(() => {});
        const keep = presence.tabId != null && markedTabs.has(presence.tabId) ? presence.tabId : [...markedTabs][0] ?? null;
        applyPresence(onExplicitDone({ ...presence, tabId: keep }, { now: Date.now() }));
      }
      return { closed };
    }

    case "page.navigate": {
      assertNotStopped();
      assertWebUrl(String(params.url || ""));
      assertSiteAllowed(params.url);
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

    case "page.history": {
      assertNotStopped();
      const action = params.action;
      if (!HISTORY_ACTIONS[action]) throw new Error('action must be "back", "forward" or "reload"');
      const tab = await resolveTab(params);
      lastTabId = tab.id;
      assertNoDialog(tab.id);
      await markTab(tab.id);
      const started = watchNavigation(tab.id);
      try {
        await HISTORY_ACTIONS[action](tab.id);
      } catch (err) {
        started.cancel();
        if (action !== "reload" && /history|next page|previous page/i.test(err?.message || "")) {
          throw new Error(`There is no page to go ${action} to in this tab.`);
        }
        throw err;
      }
      const navigated = await started.promise;
      if (!navigated && action !== "reload") {
        throw new Error(`There is no page to go ${action} to in this tab.`);
      }
      await waitForLoad(tab.id);
      await markTab(tab.id);
      const snap = await page(tab.id, "pointer:snapshot", { scope: "viewport" });
      const fresh = await chrome.tabs.get(tab.id);
      return { tabId: tab.id, url: fresh.url, title: fresh.title, snapshot: snap.text };
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

    case "page.layout": {
      const tab = await resolveTab(params);
      lastTabId = tab.id;
      assertNoDialog(tab.id);
      await markTab(tab.id);
      const res = await page(tab.id, "pointer:layout", { scope: params.scope, limit: params.limit });
      return { text: res.text, url: (await chrome.tabs.get(tab.id)).url };
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
        let synthetic = false;
        const nav = watchNavigation(tab.id, 10000);
        try {
          if (action === "click") {
            try {
              const { dialog } = await raceDialog(tab.id, clickAt(tab.id, spot.x, spot.y, markAgentInput));
              if (dialog) {
                nav.cancel();
                return { ok: true, target: { role: spot.role, name: spot.name }, url: tab.url, dialog };
              }
            } catch (err) {
              if (!debuggerBlocked(err)) throw err;
              await page(tab.id, "pointer:domclick", params);
              synthetic = true;
            }
          } else if (action === "hover") {
            try {
              await mouseTo(tab.id, spot.x, spot.y);
            } catch (err) {
              if (!debuggerBlocked(err)) throw err;
              await page(tab.id, "pointer:domhover", params);
              synthetic = true;
            }
          }
        } catch (err) {
          nav.cancel();
          throw err;
        }
        trace("act input done");

        // Give the page a beat to react so the report sees the result.
        const navigated = await settle(tab.id, nav, clampMs(params.settleMs, 240, 5000));
        const changes = await collectChanges(tab.id, docId, { loaded: navigated });
        const after = await chrome.tabs.get(tab.id);
        trace("act done");
        return {
          ok: true,
          target: { role: spot.role, name: spot.name },
          url: after.url,
          x: spot.x,
          y: spot.y,
          changes,
          synthetic,
          opened: await spawnedTabs(tab.id),
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
        // Date, time, color and range inputs are segmented pickers that ignore
        // typed text; setting the value directly is the only reliable way.
        const pickerInput = PICKER_INPUTS.has(spot.inputType);
        const text = String(params.text ?? "");
        const field = { ref: params.ref, selector: params.selector };
        let synthetic = params.trusted === false;
        const readValue = () => page(tab.id, "pointer:value", field).then((r) => r.value, () => null);
        const domSet = () => page(tab.id, "pointer:domfill", { ...field, text });
        // With another extension's frame on the page, Chrome can drop trusted
        // input without an error. Count the fill as landed only if the field
        // holds the text, or at least changed (masked inputs reformat it).
        let before = null;
        const landed = async () => {
          if (!text) return true;
          const now = await readValue();
          return now === null || now === text || (now !== "" && now !== before);
        };
        const assertLanded = async () => {
          if (await landed()) return;
          throw new Error(
            `The text did not reach "${label}": the field is still ${before ? "unchanged" : "empty"}. ` +
              "Another extension's frame (often a password manager) may be taking the input. " +
              "Ask the human to close that popup, then try again."
          );
        };
        const submit = () =>
          synthetic || pickerInput ? page(tab.id, "pointer:dompress", { key: "Enter" }) : pressKey(tab.id, "Enter");
        const nav = watchNavigation(tab.id, 10000);
        const typing = (async () => {
          if (synthetic || pickerInput) {
            await domSet();
          } else {
            before = await readValue();
            await fillAt(tab.id, spot.x, spot.y, text, markAgentInput);
            if (!(await landed())) {
              trace("fill did not land; using page events");
              await domSet();
              synthetic = true;
            }
          }
          if (synthetic) await assertLanded();
          if (params.submit) await submit();
        })();
        try {
          const { dialog } = await raceDialog(tab.id, typing);
          if (dialog) {
            nav.cancel();
            return { ok: true, target: label, url: tab.url, dialog };
          }
        } catch (err) {
          if (!debuggerBlocked(err)) {
            nav.cancel();
            throw err;
          }
          synthetic = true;
          try {
            await domSet();
            await assertLanded();
            if (params.submit) await submit();
          } catch (err2) {
            nav.cancel();
            throw err2;
          }
        }
        const navigated = await settle(tab.id, nav, params.submit ? 240 : 120, params.submit ? 800 : 150);
        const changes = await collectChanges(tab.id, docId, { loaded: navigated });
        return { ok: true, target: label, url: (await chrome.tabs.get(tab.id)).url, changes, synthetic, opened: await spawnedTabs(tab.id) };
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
        const key = params.key || "Enter";
        // Enter often submits a form: notice the page load so the report
        // describes the new page, not the one being left.
        const nav = watchNavigation(tab.id, 10000);
        let synthetic = false;
        try {
          const { dialog } = await raceDialog(tab.id, pressKey(tab.id, key));
          if (dialog) {
            nav.cancel();
            return { ok: true, key, url: tab.url, dialog };
          }
        } catch (err) {
          if (!debuggerBlocked(err)) {
            nav.cancel();
            throw err;
          }
          await page(tab.id, "pointer:dompress", { key });
          synthetic = true;
        }
        const navigated = await settle(tab.id, nav, 240, key === "Enter" ? 800 : 150);
        const changes = await collectChanges(tab.id, docId, { loaded: navigated });
        return { ok: true, key, url: (await chrome.tabs.get(tab.id)).url, navigated, changes, synthetic, opened: await spawnedTabs(tab.id) };
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
      assertNotStopped();
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
      files.forEach(assertUploadable);
      return await withBackgroundInput(tab, async () => {
        const target = await page(tab.id, "pointer:file-input", params);
        if (target.chooser) return await uploadThroughChooser(tab, target, files);
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
        const { root } = await cdp(tab.id, "DOM.getDocument", { depth: 0 }).catch((err) => {
          if (!debuggerBlocked(err)) throw err;
          throw new Error(
            "Chrome blocks file uploads here because another extension (often a password manager) put a frame on this page. " +
              "Ask the human to close that popup or attach the file themselves."
          );
        });
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
      if (params.reload) assertNotStopped();
      const tab = await resolveTab(params);
      lastTabId = tab.id;
      let started;
      try {
        started = await startCapture(tab.id, kind);
      } catch (err) {
        if (!debuggerBlocked(err)) throw err;
        if (kind === "console") return await pageConsole(tab, params);
        throw new Error(
          "Chrome blocks network capture on this page because another extension (often a password manager) " +
            "put a frame on it. Ask the human to close that popup, then try again."
        );
      }
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
      // The bar, edge, cursor and caption are for the human watching; keep them
      // out of the agent's view unless it asks for them (caption: true).
      const hideOverlay = !params.caption;
      if (hideOverlay) await page(tab.id, "pointer:overlay-visible", { on: false }).catch(() => {});
      try {
        await sleep(120);
        return await captureTab(tab, params);
      } finally {
        if (hideOverlay) await page(tab.id, "pointer:overlay-visible", { on: true }).catch(() => {});
      }
    }

    case "page.caption": {
      if (params.clear) {
        applyPresence(onClearSay(presence));
        return { cleared: await clearCaptions() };
      }
      if (params.done) {
        // The agent says the task is finished: the bar becomes a done chip.
        const tab = await resolveTab(params).catch(() => null);
        await clearCaptions().catch(() => {});
        const text = String(params.text || "").trim().slice(0, 300);
        applyPresence(onSay(presence, { done: true, text, tabId: tab?.id ?? presence.tabId, now: Date.now() }));
        return { url: tab?.url || "", done: true };
      }
      assertNotStopped();
      const text = String(params.text || "").trim();
      if (!text) throw new Error("Pass the caption text, or clear: true to remove it.");
      const tab = await resolveTab(params);
      lastTabId = tab.id;
      assertNoDialog(tab.id);
      await markTab(tab.id);
      const seconds = Number(params.seconds);
      const cap = {
        text: text.slice(0, 300),
        step: params.step ? String(params.step).slice(0, 24) : "",
        until: seconds > 0 ? Date.now() + Math.min(seconds, 600) * 1000 : null,
      };
      const res = await page(tab.id, "pointer:caption", { ...cap, ref: params.ref, selector: params.selector });
      // One caption at a time: it narrates the agent, in the tab it works in now.
      for (const id of [...captions.keys()]) {
        if (id !== tab.id) page(id, "pointer:caption", { off: true }).catch(() => {});
        captions.delete(id);
      }
      captions.set(tab.id, cap);
      saveState();
      applyPresence(onSay(presence, { text: cap.text, step: cap.step, tabId: tab.id, now: Date.now() }));
      return { url: (await chrome.tabs.get(tab.id)).url, target: res.target || null };
    }

    case "page.viewport": {
      assertNotStopped();
      if (!params.reset) {
        for (const k of ["width", "height"]) {
          const n = Number(params[k]);
          if (!Number.isInteger(n) || n < 200 || n > 4000) throw new Error(`${k} must be a whole number from 200 to 4000.`);
        }
      }
      const tab = await resolveTab(params);
      lastTabId = tab.id;
      assertNoDialog(tab.id);
      await markTab(tab.id);
      const size = params.reset
        ? null
        : {
            width: Number(params.width),
            height: Number(params.height),
            deviceScaleFactor: Number(params.deviceScaleFactor) || 1,
            mobile: Boolean(params.mobile),
          };
      try {
        await attach(tab.id);
        // A background tab holds resize events until it next renders; keep it
        // awake while the new size settles so script-driven layouts update too.
        await withBackgroundInput(tab, async () => {
          await applyViewport(tab.id, size);
          await sleep(300);
        });
      } catch (err) {
        if (debuggerBlocked(err)) {
          throw new Error(
            "Chrome blocks screen-size emulation on this page because another extension's frame (often a password " +
              "manager popup) is in it. Ask the human to close that popup, then try again."
          );
        }
        throw err;
      }
      if (size) viewports.set(tab.id, size);
      else viewports.delete(tab.id);
      saveState();
      const snap = await page(tab.id, "pointer:snapshot", { scope: "viewport" });
      const fresh = await chrome.tabs.get(tab.id);
      return { tabId: tab.id, url: fresh.url, snapshot: snap.text };
    }

    case "page.hidePointer": {
      const tab = await resolveTab(params, { allowBlocked: true });
      await page(tab.id, "pointer:hide", {});
      await clearCaptions();
      // The agent's own stop: it is finished (notify), then clean up at once.
      applyPresence(onExplicitDone(presence, { now: Date.now() }));
      applyPresence(onDismiss(presence, Date.now()));
      await unmarkTabs();
      return { ok: true };
    }

    case "ext.rename":
      agentName = params.name || agentName;
      await refreshGroupLabels();
      return { agentName, groups: await groupSummary() };

    case "ext.reload":
      // A reload clears session storage, and with it a pending stop.
      assertNotStopped();
      // Pick up edited unpacked files without asking the human to click reload.
      setTimeout(() => chrome.runtime.reload(), 200);
      return { reloading: true };

    case "ext.resume": {
      // The agent asked the human and they agreed to continue.
      const was = stopped;
      stopped = false;
      saveState();
      applyPresence(onResume(presence, { now: Date.now() }));
      return { resumed: was };
    }

    default:
      throw new Error(`Unknown method ${method}`);
  }
}

/** Capture a tab as an image: the window capture when it is on screen, CDP otherwise. */
async function captureTab(tab, params) {
  const format = params.format || "png";
  trace("shot start");
  let dataUrl = null;
  // captureVisibleTab grabs whatever tab is visible in that window, so it
  // is only correct for the agent tab. If the human moved to another tab
  // or app, render the agent tab with CDP instead.
  const fresh = await chrome.tabs.get(tab.id);
  const win = await chrome.windows.get(fresh.windowId).catch(() => null);
  // An emulated screen size only shows up in a CDP capture.
  const visible = fresh.active && win?.focused !== false && win?.state !== "minimized" && !viewports.has(fresh.id);
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
    try {
      const res = await cdp(fresh.id, "Page.captureScreenshot", {
        format,
        quality: format === "jpeg" ? params.quality : undefined,
      });
      dataUrl = `data:image/${format === "jpeg" ? "jpeg" : "png"};base64,${res.data}`;
      trace("shot via cdp");
    } catch (err) {
      if (!debuggerBlocked(err)) throw err;
      // Another extension's frame (a password manager popup) blocks CDP.
      // If the tab is the visible one in its window, the window capture works.
      if (fresh.active && win?.state !== "minimized" && !viewports.has(fresh.id)) {
        dataUrl = await withTimeout(
          chrome.tabs.captureVisibleTab(fresh.windowId, { format, quality: params.quality }),
          6000,
          "Screenshot timed out (window hidden or occluded)."
        );
      } else {
        throw new Error(
          "Chrome blocks screenshots of this background tab because another extension's frame (often a password " +
            "manager popup) is on the page. Ask the human to close that popup, or bring the tab forward with tab_focus."
        );
      }
    }
  }
  return { dataUrl, tabId: tab.id, url: tab.url };
}

const HISTORY_ACTIONS = {
  back: (tabId) => chrome.tabs.goBack(tabId),
  forward: (tabId) => chrome.tabs.goForward(tabId),
  reload: (tabId) => chrome.tabs.reload(tabId),
};

/**
 * Resolve true once the tab starts a navigation (a load or a URL change, which
 * also covers pages restored from the back/forward cache and in-app history),
 * or false if none starts in time. Without this, waitForLoad could return
 * before the navigation begins and report the old page.
 */
function watchNavigation(tabId, timeout = 3000) {
  let finish;
  const promise = new Promise((resolve) => {
    const listener = (id, change) => {
      if (id === tabId && (change.status === "loading" || change.url)) finish(true);
    };
    const timer = setTimeout(() => finish(false), timeout);
    finish = (value) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(value);
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
  return { promise, cancel: () => finish(false) };
}

/**
 * Give the page a beat to react to input. If the input started a page load
 * (a submit, a link), wait for the new page so the report describes it.
 * `grace` is how long to keep watching for a load that starts late, such as
 * a form whose script checks the fields before it submits.
 */
async function settle(tabId, nav, ms, grace = 150) {
  await sleep(ms);
  const navigated = await Promise.race([nav.promise, sleep(grace).then(() => false)]);
  nav.cancel();
  if (navigated) await waitForLoad(tabId, 10000);
  return navigated;
}

/**
 * Wait for the tab's page to load. Chrome reports "complete" only after every
 * image, font and script has arrived, and some pages never get there (a file
 * from a server that does not answer, an endless request). So once the new
 * document is parsed, allow it READY_GRACE_MS more, then carry on.
 */
const READY_GRACE_MS = 2000;

async function waitForLoad(tabId, timeout = 20000) {
  const start = Date.now();
  let readySince = 0;
  while (Date.now() - start < timeout) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    if (tab.status === "complete") {
      if (Date.now() - start > 1000) trace("load waited", `${Date.now() - start}ms`);
      await sleep(250);
      return;
    }
    // pendingUrl: the navigation has not committed, so the old page is still there.
    if (!tab.pendingUrl && (await documentParsed(tabId))) {
      readySince ||= Date.now();
      if (Date.now() - readySince >= READY_GRACE_MS) {
        trace("load still running after the page was ready; going on", `${Date.now() - start}ms`);
        return;
      }
    } else {
      readySince = 0;
    }
    await sleep(120);
  }
  trace("load timed out", `${timeout}ms`);
}

/** True once the tab's document has been parsed (readyState past "loading"). */
async function documentParsed(tabId) {
  try {
    const [r] = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        injectImmediately: true,
        func: () => document.readyState,
      }),
      1000,
      "readyState check timed out"
    );
    return Boolean(r?.result) && r.result !== "loading";
  } catch {
    return false;
  }
}
