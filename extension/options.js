// Pointer's settings page. Every change is saved at once to chrome.storage.local;
// the service worker and open agent tabs pick it up from there.
import { SETTINGS_KEY, withDefaults } from "./settings.js";
import { normalizeSitePattern } from "./sites.js";

const q = (id) => document.getElementById(id);
let settings = withDefaults(undefined);

async function load() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY).catch(() => ({}));
  settings = withDefaults(stored[SETTINGS_KEY]);
  render();
}

let savedTimer = 0;
async function save(patch) {
  settings = withDefaults({ ...settings, ...patch });
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  render();
  q("saved").classList.add("on");
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => q("saved").classList.remove("on"), 1200);
}

function render() {
  for (const input of document.querySelectorAll("input[data-key]")) input.checked = Boolean(settings[input.dataset.key]);
  for (const radio of document.querySelectorAll('input[name="cursorSpeed"]')) radio.checked = radio.value === settings.cursorSpeed;
  renderSites();
}

function renderSites() {
  const list = q("site-list");
  list.replaceChildren();
  if (!settings.blockedSites.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No blocked sites yet.";
    list.append(empty);
    return;
  }
  for (const site of settings.blockedSites) {
    const row = document.createElement("div");
    row.className = "site";
    const name = document.createElement("span");
    name.textContent = site;
    const remove = document.createElement("button");
    remove.className = "x";
    remove.type = "button";
    remove.textContent = "✕";
    remove.setAttribute("aria-label", `Unblock ${site}`);
    remove.addEventListener("click", () => save({ blockedSites: settings.blockedSites.filter((s) => s !== site) }));
    row.append(name, remove);
    list.append(row);
  }
}

// ----------------------------------------------------------------- inputs ---
for (const input of document.querySelectorAll("input[data-key]")) {
  if (input.dataset.notify != null) continue; // notifications ask Chrome first, below
  input.addEventListener("change", () => save({ [input.dataset.key]: input.checked }));
}
for (const radio of document.querySelectorAll('input[name="cursorSpeed"]')) {
  radio.addEventListener("change", () => radio.checked && save({ cursorSpeed: radio.value }));
}

for (const input of document.querySelectorAll("input[data-notify]")) {
  input.addEventListener("change", () => setNotify(input));
}

/** Turning a notification on needs Chrome's notifications permission, asked for once. */
async function setNotify(input) {
  const note = q("notify-note");
  note.hidden = true;
  if (input.checked) {
    let granted = false;
    try {
      granted = await chrome.permissions.request({ permissions: ["notifications"] });
    } catch {}
    if (!granted) {
      input.checked = false;
      note.textContent = "Chrome did not allow notifications, so this stays off.";
      note.hidden = false;
      return;
    }
  }
  await save({ [input.dataset.key]: input.checked });
}

q("test-notification").addEventListener("click", async () => {
  const note = q("notify-note");
  let granted = false;
  try {
    granted = await chrome.permissions.request({ permissions: ["notifications"] });
  } catch {}
  if (!granted) {
    note.textContent = "Chrome did not allow notifications.";
    note.hidden = false;
    return;
  }
  note.hidden = true;
  await chrome.runtime.sendMessage({ type: "pointer:test-notification" }).catch(() => {});
});

// ------------------------------------------------------------------ sites ---
q("add-site").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = q("site-input");
  const error = q("site-error");
  error.textContent = "";
  let pattern;
  try {
    pattern = normalizeSitePattern(input.value);
  } catch (err) {
    error.textContent = err.message;
    return;
  }
  if (!settings.blockedSites.includes(pattern)) await save({ blockedSites: [...settings.blockedSites, pattern] });
  input.value = "";
});

// --------------------------------------------------------------- stopping ---
async function showShortcut() {
  const commands = await chrome.commands.getAll().catch(() => []);
  const stop = commands.find((c) => c.name === "stop-agent");
  const box = q("shortcut");
  box.replaceChildren();
  if (!stop?.shortcut) {
    box.textContent = "Not set";
    return;
  }
  // "⌥⇧S" on a Mac, "Alt+Shift+S" elsewhere: one key per <kbd>.
  const keys = stop.shortcut.includes("+") ? stop.shortcut.split("+") : [...stop.shortcut];
  keys.forEach((k, i) => {
    const kbd = document.createElement("kbd");
    kbd.textContent = k;
    box.append(kbd);
    if (i < keys.length - 1) box.append(" ");
  });
}
q("change-shortcut").addEventListener("click", () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }));

// ------------------------------------------------------------- connection ---
let agentTab = null;
async function refreshStatus() {
  const status = await chrome.runtime.sendMessage({ type: "pointer:status" }).catch(() => null);
  const connected = Boolean(status?.connected);
  const state = !connected ? "offline" : status.stopped ? "stopped" : "connected";
  q("hub-status").dataset.state = state;
  q("hub-state").textContent = { offline: "Offline", stopped: "Stopped", connected: "Connected" }[state];
  const hub = (status?.socket || "ws://127.0.0.1:8790/ext").replace(/^ws:\/\//, "").replace(/\/ext$/, "");
  q("hub-text").textContent = connected ? `Running on ${hub}` : `Can't reach the hub on ${hub}. Is the Pointer server running?`;
  q("hub-address").textContent = `Hub ${hub}`;
  agentTab = status?.lastTabId != null ? await chrome.tabs.get(status.lastTabId).catch(() => null) : null;
  const tabs = (status?.groups || []).reduce((n, g) => n + g.tabIds.length, 0);
  q("agent-text").textContent = agentTab
    ? `${status.agentName || "agent"} · ${tabs || 1} tab${tabs === 1 ? "" : "s"} in its group`
    : "No agent tab right now";
  q("show-tab").disabled = !agentTab;
}
q("show-tab").addEventListener("click", async () => {
  if (!agentTab) return;
  await chrome.tabs.update(agentTab.id, { active: true }).catch(() => {});
  await chrome.windows.update(agentTab.windowId, { focused: true }).catch(() => {});
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[SETTINGS_KEY]) {
    settings = withDefaults(changes[SETTINGS_KEY].newValue);
    render();
  }
});

q("version").textContent = `Version ${chrome.runtime.getManifest().version}`;
load();
showShortcut();
refreshStatus();
setInterval(refreshStatus, 2000);
