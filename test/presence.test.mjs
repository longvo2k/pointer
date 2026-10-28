// Presence: what the human sees while an agent works (acting, quiet, stopped, done).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  QUIET_MS,
  CHIP_CLEAR_MS,
  STOPPED_CLEAR_MS,
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
} from "../extension/presence.js";

const SETTINGS = {
  bar: true,
  edge: true,
  labels: true,
  cursorSpeed: "watchable",
  groupStatus: true,
  escStops: true,
  clickStops: true,
};

const cmd = (p, method, params = {}, now = 1000, tabId = 7) => onCommand(p, { method, params, tabId, now });
const active = (now = 1000) => cmd(initialPresence(), "page.act", { kind: "click" }, now);

test("timings match the spec", () => {
  assert.equal(QUIET_MS, 60_000);
  assert.equal(CHIP_CLEAR_MS, 600_000);
  assert.equal(STOPPED_CLEAR_MS, 1_800_000);
});

test("describeCommand names what the agent does", () => {
  for (const m of ["ext.status", "tabs.list", "ext.rename", "ext.reload", "ext.resume", "page.caption", "page.hidePointer"]) {
    assert.equal(describeCommand(m, {}), null, m);
  }
  assert.equal(describeCommand("page.navigate", { url: "https://www.example.com/a" }), "open example.com");
  assert.equal(describeCommand("tabs.open", { url: "https://example.com" }), "open example.com");
  assert.equal(describeCommand("page.snapshot", {}), "read the page");
  assert.equal(describeCommand("page.text", {}), "read the page");
  assert.equal(describeCommand("page.screenshot", {}), "take a screenshot");
  assert.equal(describeCommand("page.find", { query: "sign up" }), 'find "sign up"');
  assert.equal(describeCommand("page.press", { key: "Enter" }), "press Enter");
  assert.equal(describeCommand("page.scroll", {}), "scroll");
  assert.equal(describeCommand("page.wait", {}), "wait");
  assert.equal(describeCommand("page.history", { action: "back" }), "go back");
  assert.equal(describeCommand("page.history", { action: "forward" }), "go forward");
  assert.equal(describeCommand("page.history", { action: "reload" }), "reload");
  for (const m of ["page.act", "page.fill", "page.upload", "page.dialog", "page.layout"]) {
    assert.equal(describeCommand(m, {}), "", m);
  }
});

test("a command makes the agent active and counts actions", () => {
  let p = initialPresence();
  p = cmd(p, "page.act", { kind: "click" }, 1000);
  p = cmd(p, "page.snapshot", {}, 2000);
  p = cmd(p, "page.act", { kind: "click" }, 3000);
  assert.equal(p.state, "active");
  assert.equal(p.actions, 2);
  assert.equal(p.tabId, 7);
  assert.equal(p.lastActivityAt, 3000);
  assert.equal(p.lastAction, "read the page");
  assert.equal(groupPrefix(p), "⌛ ");
});

test("status calls are not activity", () => {
  const p = cmd(initialPresence(), "ext.status");
  assert.equal(p.state, "idle");
});

test("silence turns active into quiet, never notifies", () => {
  const prev = active(1000);
  assert.equal(onTick(prev, 1000 + QUIET_MS - 1).state, "active");
  const next = onTick(prev, 1000 + QUIET_MS);
  assert.equal(next.state, "quiet");
  assert.equal(effectsOf(prev, next).notify, null);
  assert.equal(groupPrefix(next), "⌛ ");
  assert.equal(cmd(next, "page.act", {}, 70_000).state, "active");
});

test("say sets the bar text and step; clearing removes them", () => {
  let p = onSay(active(), { text: "Creating the workspace", step: "3/5", tabId: 7, now: 2000 });
  assert.equal(p.state, "active");
  assert.equal(p.text, "Creating the workspace");
  assert.equal(p.step, "3/5");
  p = onClearSay(p);
  assert.equal(p.text, "");
  assert.equal(p.step, "");
});

test("say done is an explicit done that notifies", () => {
  const prev = active();
  const next = onSay(prev, { done: true, text: "All set", tabId: 7, now: 5000 });
  assert.equal(next.state, "done");
  assert.equal(next.doneText, "All set");
  assert.equal(effectsOf(prev, next).notify, "done");
  assert.equal(groupPrefix(next), "✅ ");
  assert.equal(onExplicitDone(prev, { now: 5000 }).state, "done");
});

test("a new task after done starts counting again", () => {
  const done = onSay(active(), { done: true, tabId: 7, now: 5000 });
  const p = cmd(done, "page.act", {}, 9000);
  assert.equal(p.state, "active");
  assert.equal(p.actions, 1);
  assert.equal(p.doneText, "");
});

test("Esc and clicks stop only while working", () => {
  const working = active();
  const quiet = onTick(working, 1000 + QUIET_MS);
  const stopped = onHumanStop(working, { now: 2000 });
  const done = onExplicitDone(working, { now: 2000 });
  const idle = initialPresence();
  for (const src of ["esc", "click", "bar"]) {
    assert.equal(stopAccepted(working, src), true, `${src} active`);
    assert.equal(stopAccepted(quiet, src), true, `${src} quiet`);
    assert.equal(stopAccepted(stopped, src), false, `${src} stopped`);
    assert.equal(stopAccepted(done, src), false, `${src} done`);
    assert.equal(stopAccepted(idle, src), false, `${src} idle`);
  }
  for (const p of [working, quiet, stopped, done, idle]) {
    assert.equal(stopAccepted(p, "popup"), true);
    assert.equal(stopAccepted(p, "shortcut"), true);
  }
});

test("a human stop holds through reads and lifts on resume", () => {
  const prev = active();
  const stopped = onHumanStop(prev, { now: 2000 });
  assert.equal(stopped.state, "stopped");
  assert.equal(effectsOf(prev, stopped).notify, "stopped");
  assert.equal(groupPrefix(stopped), "✋ ");
  assert.equal(cmd(stopped, "page.snapshot", {}, 3000).state, "stopped");
  assert.equal(onResume(stopped, { now: 4000 }).state, "active");
});

test("a stop with no agent working changes nothing", () => {
  const idle = initialPresence();
  assert.equal(onHumanStop(idle, { now: 1 }).state, "idle");
  const done = onExplicitDone(active(), { now: 2000 });
  const after = onHumanStop(done, { now: 3000 });
  assert.equal(after.state, "done");
  assert.equal(effectsOf(done, after).notify, null);
});

test("done clears after ten minutes and unmarks", () => {
  const done = onExplicitDone(active(), { now: 2000 });
  assert.equal(onTick(done, 2000 + CHIP_CLEAR_MS - 1).state, "done");
  const next = onTick(done, 2000 + CHIP_CLEAR_MS);
  assert.equal(next.state, "idle");
  assert.equal(effectsOf(done, next).unmark, true);
  assert.equal(effectsOf(done, next).retitle, true);
});

test("quiet clears after ten minutes without unmarking", () => {
  const quiet = onTick(active(1000), 1000 + QUIET_MS);
  const next = onTick(quiet, quiet.enteredAt + CHIP_CLEAR_MS);
  assert.equal(next.state, "idle");
  assert.equal(effectsOf(quiet, next).unmark, false);
});

test("an unresumed stop clears its marks after thirty minutes", () => {
  const stopped = onHumanStop(active(), { now: 2000 });
  assert.equal(onTick(stopped, 2000 + STOPPED_CLEAR_MS - 1).state, "stopped");
  const next = onTick(stopped, 2000 + STOPPED_CLEAR_MS);
  assert.equal(next.state, "idle");
  assert.equal(effectsOf(stopped, next).unmark, true);
});

test("dismissing: done goes idle, quiet and stopped only hide", () => {
  const done = onExplicitDone(active(), { now: 2000 });
  const d = onDismiss(done, 3000);
  assert.equal(d.state, "idle");
  assert.equal(effectsOf(done, d).unmark, true);
  const stopped = onDismiss(onHumanStop(active(), { now: 2000 }), 3000);
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.dismissed, true);
  assert.equal(viewOf(stopped, SETTINGS, "Claude Code").mode, "off");
});

test("switching tabs reports the old tab to clear", () => {
  const one = cmd(initialPresence(), "page.act", {}, 1000, 1);
  const two = cmd(one, "page.act", {}, 2000, 2);
  assert.equal(effectsOf(one, two).clearTab, 1);
  assert.equal(effectsOf(two, cmd(two, "page.act", {}, 3000, 2)).clearTab, null);
});

test("baseGroupTitle strips every prefix", () => {
  for (const t of ["⌛ Claude Code", "✋ Claude Code", "✅ Claude Code", "Claude Code"]) {
    assert.equal(baseGroupTitle(t), "Claude Code");
  }
});

test("presence survives a JSON round trip and still goes quiet", () => {
  const p = active(1000);
  assert.equal(onTick(JSON.parse(JSON.stringify(p)), p.lastActivityAt + 90_000).state, "quiet");
});

test("the view follows settings", () => {
  const p = onSay(active(), { text: "Hi", step: "1/2", tabId: 7, now: 1500 });
  const v = viewOf(p, SETTINGS, "Claude Code");
  assert.equal(v.mode, "active");
  assert.equal(v.agent, "Claude Code");
  assert.equal(v.text, "Hi");
  assert.equal(v.step, "1/2");
  assert.deepEqual(v.tabStops, { esc: true, click: true });
  const off = viewOf(p, { ...SETTINGS, escStops: false, cursorSpeed: "fast", bar: false }, "a");
  assert.equal(off.tabStops.esc, false);
  assert.equal(off.tabStops.click, true);
  assert.equal(off.cursor, "fast");
  assert.equal(off.bar, false);
  const quiet = onDismiss(onTick(active(1000), 1000 + QUIET_MS), 70_000);
  assert.equal(viewOf(quiet, SETTINGS, "a").mode, "off");
  assert.equal(viewOf(quiet, SETTINGS, "a").tabStops.esc, true);
  assert.equal(viewOf(initialPresence(), SETTINGS, "a").mode, "off");
});

test("notification text", () => {
  assert.deepEqual(notificationText("done", { agent: "Claude Code", actions: 1, host: "example.com" }), {
    title: "Claude Code finished",
    message: "1 action on example.com",
  });
  assert.equal(notificationText("done", { agent: "Claude Code", actions: 5, host: "example.com" }).message, "5 actions on example.com");
  assert.deepEqual(notificationText("stopped", { agent: "Claude Code", actions: 5, host: "example.com" }), {
    title: "Claude Code is waiting for you",
    message: "You stopped it on example.com. Reply in its chat to continue.",
  });
});

test("closing tabs after say done keeps the done mark and does not notify again", () => {
  const done = onSay(cmd(active(), "page.act", {}, 1500), { done: true, text: "All set", tabId: 7, now: 2000 });
  const after = cmd(done, "tabs.close", { all: true }, 2500);
  assert.equal(after.state, "done");
  assert.equal(after.doneText, "All set");
  assert.equal(effectsOf(done, onExplicitDone(after, { now: 2600 })).notify, null);
});

test("a command while the human's stop holds shows the agent as stopped", () => {
  for (const from of [initialPresence(), onExplicitDone(active(), { now: 1500 })]) {
    const p = onCommand(from, { method: "page.snapshot", params: {}, tabId: 7, now: 3000, held: true });
    assert.equal(p.state, "stopped");
    assert.equal(groupPrefix(p), "✋ ");
    assert.equal(stopAccepted(p, "esc"), false);
  }
  const resumed = onCommand(initialPresence(), { method: "page.snapshot", params: {}, tabId: 7, now: 3000, held: false });
  assert.equal(resumed.state, "active");
});
