// A small fake of the chrome.* APIs the service worker uses, so tests can load
// the real extension/background.js in node and drive it like the hub would.
// It covers what the tests need, not all of Chrome.

let loads = 0;

/**
 * Load a fresh copy of the worker against a new fake browser.
 * `session` carries chrome.storage.session across loads, like a worker that
 * Chrome evicted and woke again. `settingsDelayMs` makes reading settings slow.
 */
export async function loadWorker({ tabs = [], groups = [], settings = {}, session = {}, settingsDelayMs = 0 } = {}) {
  const log = { notifications: [], pageMessages: [], groupTitles: [], ungrouped: [] };
  const listeners = { runtime: [], storage: [], alarm: [], updated: [] };
  const tabMap = new Map(tabs.map((t) => [t.id, { windowId: 1, active: false, status: "complete", groupId: -1, title: "Page", ...t }]));
  const groupMap = new Map(groups.map((g) => [g.id, { windowId: 1, collapsed: false, color: "purple", ...g }]));
  const local = { pointerSettings: settings };
  let socket = null;
  let nextTabId = 100;
  let nextGroupId = 50;
  const ev = (list) => ({ addListener: (f) => list?.push(f), removeListener: (f) => list && list.splice(list.indexOf(f) >>> 0, 1) });
  const fireUpdated = (tabId, info) => {
    const tab = tabMap.get(tabId);
    for (const f of [...listeners.updated]) f(tabId, info, { ...tab });
  };

  globalThis.self = globalThis;
  globalThis.WebSocket = class {
    constructor() {
      this.readyState = 1; // never fires "open": no heartbeat timer keeps the test alive
      this.l = {};
      this.replies = [];
      socket = this;
    }
    addEventListener(type, f) {
      this.l[type] = f;
    }
    send(s) {
      const m = JSON.parse(s);
      if (m.id) this.replies.push(m);
    }
    close() {}
  };
  globalThis.WebSocket.OPEN = 1;

  globalThis.chrome = {
    runtime: {
      id: "pointer-test",
      getManifest: () => ({ version: "test" }),
      getPlatformInfo: async () => ({ os: "mac" }),
      onMessage: ev(listeners.runtime),
      onStartup: ev(),
      onInstalled: ev(),
      sendMessage: async () => ({}),
      reload() {},
    },
    storage: {
      session: {
        get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in session).map((k) => [k, session[k]])),
        set: async (o) => Object.assign(session, JSON.parse(JSON.stringify(o))),
      },
      local: {
        get: async (k) => {
          if (settingsDelayMs) await new Promise((r) => setTimeout(r, settingsDelayMs));
          return { [k]: local[k] };
        },
        set: async (o) => Object.assign(local, o),
      },
      onChanged: ev(listeners.storage),
    },
    alarms: { get: async () => ({ name: "pointer-keepalive" }), create() {}, onAlarm: ev(listeners.alarm) },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    windows: {
      onFocusChanged: ev(),
      getLastFocused: async () => ({ id: 1, focused: true }),
      get: async () => ({ id: 1, state: "normal" }),
      update: async () => {},
    },
    commands: { onCommand: ev() },
    tabs: {
      get: async (id) => {
        const t = tabMap.get(id);
        if (!t) throw new Error(`No tab with id: ${id}`);
        return { ...t };
      },
      query: async (q = {}) => [...tabMap.values()].filter((t) => (q.groupId == null || t.groupId === q.groupId) && (!q.active || t.active)).map((t) => ({ ...t })),
      create: async ({ url }) => {
        const t = { id: nextTabId++, windowId: 1, active: false, status: "complete", groupId: -1, title: "New", url };
        tabMap.set(t.id, t);
        return { ...t };
      },
      update: async (id, o) => {
        const t = tabMap.get(id);
        Object.assign(t, o);
        if (o.url) {
          fireUpdated(id, { url: o.url });
          fireUpdated(id, { status: "complete" });
        }
        return { ...t };
      },
      remove: async (id) => void tabMap.delete(id),
      group: async ({ tabIds, groupId }) => {
        const id = groupId ?? nextGroupId++;
        if (!groupMap.has(id)) groupMap.set(id, { id, windowId: 1, title: "", color: "grey", collapsed: false });
        for (const t of tabIds) tabMap.get(t).groupId = id;
        return id;
      },
      ungroup: async (ids) => {
        for (const t of [].concat(ids)) {
          tabMap.get(t).groupId = -1;
          log.ungrouped.push(t);
        }
      },
      goBack: async (id) => {
        // The human's history: going back lands where the test said it would.
        const t = tabMap.get(id);
        t.url = t.backUrl;
        t.title = t.backTitle || "Back";
        fireUpdated(id, { url: t.url, status: "loading" });
        fireUpdated(id, { status: "complete" });
      },
      sendMessage: async (_id, m) => {
        log.pageMessages.push({ tabId: _id, type: m.type, params: m.params });
        if (m.type === "pointer:snapshot") return { ok: true, text: `- link "Secret account page" [ref=e1]` };
        return { ok: true, title: "Page" };
      },
      onUpdated: ev(listeners.updated),
      onRemoved: ev(),
      onCreated: ev(),
      onActivated: ev(),
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      get: async (id) => {
        const g = groupMap.get(id);
        if (!g) throw new Error(`No group with id: ${id}`);
        return { ...g };
      },
      query: async (q = {}) => [...groupMap.values()].filter((g) => q.windowId == null || g.windowId === q.windowId).map((g) => ({ ...g })),
      update: async (id, o) => {
        Object.assign(groupMap.get(id) || {}, o);
        if (o.title != null) log.groupTitles.push(o.title);
        return { ...groupMap.get(id) };
      },
    },
    scripting: { executeScript: async () => [] },
    debugger: { onDetach: ev(), onEvent: ev(), attach: async () => {}, sendCommand: async () => ({}), detach: async () => {} },
    permissions: { contains: async () => true, onAdded: ev() },
    notifications: {
      create: async (id, o) => void log.notifications.push(`${id}: ${o.title} | ${o.message}`),
      onClicked: ev(),
      clear: async () => {},
    },
  };

  await import(new URL(`../extension/background.js?load=${++loads}`, import.meta.url));
  await tick(20);

  let n = 0;
  const worker = {
    log,
    session,
    tabs: tabMap,
    groups: groupMap,
    /** Send a hub command; resolves with the reply ({ ok, result } or { ok: false, error }). */
    async command(method, params = {}) {
      const id = `c${++n}`;
      await socket.l.message({ data: JSON.stringify({ id, method, params }) });
      await tick(10);
      return socket.replies.find((r) => r.id === id);
    },
    /** A message from a page or the popup, like chrome.runtime.sendMessage. */
    message(msg) {
      return new Promise((resolve) => {
        for (const f of listeners.runtime) {
          if (f(msg, { id: "pointer-test" }, resolve) !== true) resolve();
        }
      });
    },
    async alarm() {
      for (const f of listeners.alarm) f({ name: "pointer-keepalive" });
      await tick(20);
    },
  };
  return worker;
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Run fn with Date.now moved forward by ms. */
export async function later(ms, fn) {
  const real = Date.now;
  const at = real() + ms;
  Date.now = () => at;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}
