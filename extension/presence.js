/**
 * Presence: what the human sees while an agent works in a tab.
 *
 *   idle → active ⇄ quiet → done
 *            ↓  ↑ resume
 *          stopped
 *
 * "Thinking" is not a state here: the page shows it from lastActivityAt.
 * "quiet" is a guess (no command for a minute); "done" is the agent saying so.
 * Pure: plain JSON in and out, no chrome.* calls, `now` always passed in.
 */

export const THINKING_MS = 2000;
export const QUIET_MS = 60_000;
export const CHIP_CLEAR_MS = 10 * 60_000;
export const STOPPED_CLEAR_MS = 30 * 60_000;
export const PREFIXES = ["⌛ ", "✋ ", "✅ "];

/** Calls that are not the agent working: status checks, settings-free housekeeping. */
const NOT_ACTIVITY = new Set([
  "ext.status",
  "tabs.list",
  "ext.rename",
  "ext.reload",
  "ext.resume",
  "page.caption",
  "page.hidePointer",
  // Closing tabs is clean-up, often right after say done; it must not restart the task.
  "tabs.close",
]);

/** Calls that change the page, counted in "N actions". */
const ACTIONS = new Set([
  "page.act",
  "page.fill",
  "page.press",
  "page.scroll",
  "page.upload",
  "page.dialog",
  "page.navigate",
  "page.history",
  "tabs.open",
]);

const HISTORY = { back: "go back", forward: "go forward", reload: "reload" };

export function initialPresence() {
  return {
    state: "idle",
    tabId: null,
    lastActivityAt: 0,
    enteredAt: 0,
    actions: 0,
    text: "",
    step: "",
    lastAction: "",
    doneText: "",
    dismissed: false,
  };
}

function hostOf(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, "");
  } catch {
    return String(url || "");
  }
}

/** A short description of a command for the bar; "" when the page labels it; null when it is not activity. */
export function describeCommand(method, params = {}) {
  if (NOT_ACTIVITY.has(method)) return null;
  switch (method) {
    case "tabs.open":
    case "page.navigate":
      return params.url ? `open ${hostOf(params.url)}` : "open a tab";
    case "page.snapshot":
    case "page.text":
      return "read the page";
    case "page.screenshot":
      return "take a screenshot";
    case "page.find":
      return `find "${String(params.query ?? "").slice(0, 60)}"`;
    case "page.press":
      return `press ${params.key || "Enter"}`;
    case "page.scroll":
      return "scroll";
    case "page.wait":
      return "wait";
    case "page.history":
      return HISTORY[params.action] || "navigate";
    default:
      return "";
  }
}

/** Move into "active" (from idle, quiet or done); a new task after idle or done starts fresh. */
function activate(p, { tabId, now, label = "", action = false }) {
  const fresh = p.state === "idle" || p.state === "done";
  const base = fresh ? { ...initialPresence() } : p;
  return {
    ...base,
    state: "active",
    tabId: tabId ?? p.tabId,
    lastActivityAt: now,
    enteredAt: p.state === "active" ? p.enteredAt : now,
    actions: base.actions + (action ? 1 : 0),
    lastAction: label || base.lastAction,
    dismissed: false,
  };
}

/**
 * `held`: the human's stop still holds (only resume lifts it). A command then
 * shows the agent as stopped, never as working, whatever the bar showed before.
 */
export function onCommand(p, { method, params = {}, tabId, now, held = false }) {
  const label = describeCommand(method, params);
  if (label === null || p.state === "stopped") return p;
  // After say done, agents often look once more (a screenshot for their report).
  // Only an action that changes the page starts a new task; a look keeps the ✅.
  if (p.state === "done" && !held && !ACTIONS.has(method)) return p;
  const next = activate(p, { tabId, now, label, action: ACTIONS.has(method) && !held });
  return held ? { ...next, state: "stopped", enteredAt: now } : next;
}

export function onSay(p, { text = "", step = "", done = false, tabId, now }) {
  if (done) return onExplicitDone({ ...p, tabId: tabId ?? p.tabId }, { now, text });
  if (p.state === "stopped") return p;
  return { ...activate(p, { tabId, now }), text, step };
}

export function onClearSay(p) {
  return { ...p, text: "", step: "" };
}

/** The agent said it is finished: say done, tab_close all, or its own stop. */
export function onExplicitDone(p, { now, text = "" }) {
  // Already done (say done, then tab_close all): keep the mark and the summary.
  if (p.state === "done") return text ? { ...p, doneText: text } : p;
  return { ...p, state: "done", enteredAt: now, doneText: text, dismissed: false };
}

/** Esc, a click and the bar's Stop only count while the agent may be working; popup and shortcut always do. */
export function stopAccepted(p, source) {
  if (source === "popup" || source === "shortcut") return true;
  return p.state === "active" || p.state === "quiet";
}

export function onHumanStop(p, { now }) {
  if (p.state !== "active" && p.state !== "quiet") return p;
  return { ...p, state: "stopped", enteredAt: now, dismissed: false };
}

export function onResume(p, { now }) {
  if (p.state !== "stopped") return p;
  return { ...p, state: "active", enteredAt: now, lastActivityAt: now, dismissed: false };
}

export function onTick(p, now) {
  if (p.state === "active" && now - p.lastActivityAt >= QUIET_MS) {
    return { ...p, state: "quiet", enteredAt: now };
  }
  if ((p.state === "done" || p.state === "quiet") && now - p.enteredAt >= CHIP_CLEAR_MS) {
    return { ...p, state: "idle", enteredAt: now, dismissed: false };
  }
  if (p.state === "stopped" && now - p.enteredAt >= STOPPED_CLEAR_MS) {
    return { ...p, state: "idle", enteredAt: now, dismissed: false };
  }
  return p;
}

/** ✕ on a chip, or Got it on the stopped bar. Done ends; quiet and stopped only hide. */
export function onDismiss(p, now) {
  if (p.state === "done") return { ...p, state: "idle", enteredAt: now, dismissed: false };
  if (p.state === "quiet" || p.state === "stopped") return { ...p, dismissed: true };
  return p;
}

export function groupPrefix(p) {
  if (p.state === "active" || p.state === "quiet") return PREFIXES[0];
  if (p.state === "stopped") return PREFIXES[1];
  if (p.state === "done") return PREFIXES[2];
  return "";
}

export function baseGroupTitle(title) {
  let t = String(title ?? "");
  for (const prefix of PREFIXES) if (t.startsWith(prefix)) t = t.slice(prefix.length);
  return t;
}

/** What the worker has to do when presence moves from prev to next. */
export function effectsOf(prev, next) {
  const entered = (s) => next.state === s && prev.state !== s;
  return {
    notify: entered("done") ? "done" : entered("stopped") ? "stopped" : null,
    unmark: next.state === "idle" && (prev.state === "done" || prev.state === "stopped"),
    retitle: groupPrefix(prev) !== groupPrefix(next),
    clearTab: prev.tabId != null && prev.tabId !== next.tabId ? prev.tabId : null,
  };
}

/** What the page draws. Settings decide what is shown; presence decides the state. */
export function viewOf(p, settings, agent) {
  const off = p.state === "idle" || p.dismissed;
  return {
    mode: off ? "off" : p.state,
    agent: String(agent || "agent"),
    text: p.text,
    step: p.step,
    lastAction: p.lastAction,
    lastActivityAt: p.lastActivityAt,
    actions: p.actions,
    doneText: p.doneText,
    bar: settings.bar !== false,
    edge: settings.edge !== false,
    labels: settings.labels !== false,
    cursor: settings.cursorSpeed === "fast" ? "fast" : "watchable",
    tabStops: {
      esc: settings.escStops !== false && stopAccepted(p, "esc"),
      click: settings.clickStops !== false && stopAccepted(p, "click"),
    },
  };
}

export function notificationText(kind, { agent, actions, host }) {
  if (kind === "stopped") {
    return {
      title: `${agent} is waiting for you`,
      message: `You stopped it on ${host}. Reply in its chat to continue.`,
    };
  }
  return { title: `${agent} finished`, message: `${actions} action${actions === 1 ? "" : "s"} on ${host}` };
}
