const q = (id) => document.getElementById(id);
let currentTab = null;

async function getStatus() {
  try {
    return await chrome.runtime.sendMessage({ type: "pointer:status" });
  } catch {
    return null;
  }
}

async function getTab(id) {
  if (id == null) return null;
  return chrome.tabs.get(id).catch(() => null);
}

function hostOf(url) {
  try {
    const u = new URL(url);
    return u.host || u.protocol.replace(":", "");
  } catch {
    return url || "";
  }
}

async function refresh() {
  const status = await getStatus();
  const connected = !!status?.connected;
  const stopped = !!status?.stopped;
  const tab = await getTab(status?.lastTabId);
  currentTab = tab;

  // Status pill
  const state = !connected ? "offline" : stopped ? "stopped" : "connected";
  q("status").dataset.state = state;
  q("status-text").textContent = { offline: "Offline", stopped: "Stopped", connected: "Connected" }[state];

  // Agent card
  const hasAgent = connected && !!tab;
  q("active").hidden = !hasAgent;
  q("empty").hidden = hasAgent;
  q("empty").textContent = connected
    ? "Connected. No tab in use yet."
    : "Can't reach the hub. Make sure the Pointer server is running.";
  if (hasAgent) {
    q("agent-name").textContent = status.agentName || "agent";
    q("agent-tag").textContent = stopped ? "stopped" : "driving";
    q("tab-title").textContent = tab.title || "Untitled tab";
    q("tab-host").textContent = hostOf(tab.url);
    q("fav").style.backgroundImage = tab.favIconUrl ? `url("${tab.favIconUrl}")` : "";
  }

  // Actions: Reconnect is the main action when offline; Stop when an agent is active.
  q("reconnect-main").hidden = connected;
  q("stop-wrap").hidden = !connected;
  q("stop").disabled = stopped || !tab;
  q("reconnect").hidden = !connected;
  q("hub").textContent = status?.socket || "ws://127.0.0.1:8790/ext";
}

async function reconnect(btn) {
  btn.disabled = true;
  await chrome.runtime.sendMessage({ type: "pointer:reconnect" }).catch(() => {});
  setTimeout(async () => {
    await refresh();
    btn.disabled = false;
  }, 600);
}

q("reconnect").addEventListener("click", (e) => reconnect(e.currentTarget));
q("reconnect-main").addEventListener("click", (e) => reconnect(e.currentTarget));

q("tab").addEventListener("click", async () => {
  if (!currentTab) return;
  await chrome.tabs.update(currentTab.id, { active: true }).catch(() => {});
  await chrome.windows.update(currentTab.windowId, { focused: true }).catch(() => {});
  window.close();
});

q("stop").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "pointer:stop", reason: "popup" }).catch(() => {});
  window.close();
});

q("settings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

refresh();
setInterval(refresh, 1000);
