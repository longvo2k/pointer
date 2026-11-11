// The real service worker, driven with a fake chrome: presence, stops, groups,
// notifications and blocked sites as the human would meet them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadWorker, later } from "./fake-chrome.mjs";

const PAGE = { id: 5, url: "https://www.example.com/signup", title: "Signup" };

test("a task goes active, stopped, resumed and done, with titles and notifications", async () => {
  const w = await loadWorker({ tabs: [PAGE], settings: { notifyDone: true, notifyStopped: true } });
  await w.command("tabs.select", { tabId: 5 });
  await w.command("page.snapshot", {});
  assert.deepEqual(await w.message({ type: "pointer:stop", reason: "popup" }), { ok: true, accepted: true });
  const refused = await w.command("page.press", { key: "Enter" });
  assert.match(refused.error, /Stopped by the human/);
  await w.command("ext.resume", {});
  await w.command("page.caption", { done: true, text: "All set" });
  assert.deepEqual(w.log.notifications, [
    "pointer-stopped: agent is waiting for you | You stopped it on example.com. Reply in its chat to continue.",
    "pointer-done: agent finished | 0 actions on example.com",
  ]);
  assert.deepEqual([...new Set(w.log.groupTitles)], ["⌛ agent", "✋ agent", "✅ agent"]);
});

test("an action that lands on a blocked site tells the agent nothing about it", async () => {
  const tab = { ...PAGE, backUrl: "https://www.mybank.com/accounts", backTitle: "My Bank — Accounts" };
  const w = await loadWorker({ tabs: [tab], settings: { blockedSites: ["mybank.com"] } });
  await w.command("tabs.select", { tabId: 5 });
  const reply = await w.command("page.history", { action: "back" });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /blocked in Pointer's settings/);
  assert.doesNotMatch(JSON.stringify(reply), /Secret account page|My Bank|mybank/);
});

test("after the worker restarts, an expired done still removes the marks", async () => {
  const first = await loadWorker({ tabs: [PAGE] });
  await first.command("tabs.select", { tabId: 5 });
  await first.command("page.caption", { done: true });
  assert.notEqual(first.tabs.get(5).groupId, -1);
  // Chrome evicts the worker; a new one wakes with the same session storage and browser.
  const second = await loadWorker({
    tabs: [...first.tabs.values()],
    groups: [...first.groups.values()],
    session: first.session,
  });
  await later(11 * 60_000, () => second.alarm());
  assert.equal(second.tabs.get(5).groupId, -1);
});

test("an adopted group gets the current status in its title", async () => {
  const w = await loadWorker({
    tabs: [{ ...PAGE, groupId: 7 }],
    groups: [{ id: 7, title: "✋ agent" }],
  });
  await w.command("tabs.select", { tabId: 5 });
  assert.equal(w.groups.get(7).title, "⌛ agent");
});

test("a stop right after the worker wakes uses the human's settings", async () => {
  const session = { pointerPresence: { state: "active", tabId: 5, lastActivityAt: Date.now(), enteredAt: Date.now(), actions: 2, text: "", step: "", lastAction: "", doneText: "", dismissed: false } };
  const w = await loadWorker({ tabs: [PAGE], session, settings: { notifyStopped: true }, settingsDelayMs: 60 });
  await w.message({ type: "pointer:stop", reason: "popup" });
  await later(0, () => new Promise((r) => setTimeout(r, 120)));
  assert.equal(w.log.notifications.length, 1);
  assert.match(w.log.notifications[0], /^pointer-stopped/);
});

test("the popup learns when the hub is pinned to another profile, and can take it", async () => {
  const w = await loadWorker({ tabs: [PAGE] });
  assert.equal((await w.message({ type: "pointer:status" })).hub, null, "nothing known before the hub says");
  await w.hubEvent({ event: "hub", active: false, pinned: true, browsers: 3 });
  assert.deepEqual((await w.message({ type: "pointer:status" })).hub, { active: false, pinned: true, browsers: 3 });
  assert.deepEqual(await w.message({ type: "pointer:use-here" }), { ok: true });
  assert.deepEqual(w.events().at(-1), { event: "use" });
});

test("tab groups and notifications use the agent's colour and friendly name", async () => {
  const w = await loadWorker({ tabs: [PAGE], settings: { notifyDone: true } });
  await w.command("tabs.select", { tabId: 5, agent: "claude-code" });
  const group = w.groups.get(w.tabs.get(5).groupId);
  assert.equal(group.color, "orange");
  assert.equal(group.title, "⌛ Claude");
  await w.command("page.caption", { done: true, agent: "claude-code" });
  assert.match(w.log.notifications.at(-1), /^pointer-done: Claude finished/);

  const other = await loadWorker({ tabs: [PAGE] });
  await other.command("tabs.select", { tabId: 5, agent: "abc" });
  const g2 = other.groups.get(other.tabs.get(5).groupId);
  assert.equal(g2.color, "blue");
  assert.equal(g2.title, "⌛ abc");
});

test("the worker hands the page its fonts as bytes", async () => {
  const w = await loadWorker({ tabs: [PAGE] });
  const fonts = await w.message({ type: "pointer:fonts" });
  assert.ok(fonts.caveat.length > 1000, "caveat base64");
  assert.ok(fonts.patrick.length > 1000, "patrick base64");
});
