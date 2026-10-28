# On-page Presence and Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the human, at all times, that an agent holds a tab, what it is doing, whether it needs
them and how to stop it; and give Pointer a settings page with notifications and a site blocklist.

**Architecture:** Three small pure ES modules in `extension/` (`sites.js`, `settings.js`,
`presence.js`) hold the blocklist matcher, the settings defaults and the presence state machine, and
are unit-tested with `node --test`. The service worker (`background.js`, already a module) imports
them: it feeds every command through the state machine in `dispatch()`, persists the state, and pushes
a "view" to the agent's tab. The content script (`content.js`, a classic script) renders the control
bar and edge from that view. A plain `options.html` / `options.js` page edits `chrome.storage.local`.

**Tech Stack:** Chrome MV3 extension (plain JavaScript, no build step), Node 18+ `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-28-on-page-presence-design.md` (read it before any task;
it is the source of truth for wording, states and timings).

## Global Constraints

- No new runtime dependency, no framework, no build step; plain unminified JavaScript.
- Pointer talks only to `127.0.0.1`; no outside servers.
- The only manifest permission change is `optional_permissions: ["notifications"]` plus
  `options_ui`. No new required permission (it would disable the extension for existing users).
- `minimum_chrome_version` stays `116`.
- A human stop must hold until the agent calls `resume`. The popup Stop button and the
  Alt+Shift+S shortcut always stop; settings can never turn them off.
- No agent command reads or writes settings.
- Timings: thinking after `2000` ms; quiet after `60000` ms without a command; the done chip and
  quiet chip clear after `10 * 60_000` ms; stopped marks clear after `30 * 60_000` ms.
- Group-title prefixes are exactly `"⌛ "`, `"✋ "`, `"✅ "`.
- Blocked-site refusal text, exactly: `This site is blocked in Pointer's settings. Ask the human to do this step.`
- `fill` never shows typed text anywhere in the presence UI; only the field name.
- Tests: `npm test` (`node --test`) must pass after every task.

## Review Focus

1. **The agent's own click lands where the bar sits.** Expected: the bar moves out of the way before
   input, the click reaches the page, and it is not taken as the human pressing Stop. (Task 5,
   manual check 5.3.)
2. **The service worker is evicted mid-task.** Expected: state comes back from session storage and
   quiet/cleanup still happen on the next alarm tick. (Task 2 test `presence survives a JSON round
   trip and still goes quiet`; Task 4 restore step.)
3. **The group title already carries a prefix when the worker restarts.** Expected: the existing
   `⌛ Claude Code` group is adopted, not a second group created. (Task 2 test `baseGroupTitle strips
   every prefix`; Task 4 uses it in `ensureAgentGroup`.)
4. **Blocklist URLs that try to look like the blocked site** (`https://mybank.com@evil.io`,
   `https://mybank.com.evil.io`, upper case, ports). Expected: decided on the real hostname.
   (Task 1 tests.)
5. **The agent moves to another tab.** Expected: the bar leaves the old tab and appears on the new one;
   the old tab never keeps a stale "acting" bar. (Task 2 test `switching tabs reports the old tab to
   clear`; Task 4 applies it.)

---

## File Structure

| File | Responsibility |
|---|---|
| `extension/sites.js` (new) | Blocklist pattern normalisation and matching. Pure. |
| `extension/settings.js` (new) | `SETTINGS_KEY`, `DEFAULT_SETTINGS`, `withDefaults()`. Pure. |
| `extension/presence.js` (new) | Presence state machine, command descriptions, group prefixes, view and notification text. Pure. |
| `extension/background.js` | Wires the three modules into dispatch, stop/resume, groups, alarms, notifications, blocklist. |
| `extension/content.js` | Control bar, edge, states, Stop/Got it/✕ buttons, hide-all for screenshots. |
| `extension/options.html`, `extension/options.js` (new) | Settings page. |
| `extension/popup.html`, `extension/popup.js` | Gear link to the settings page. |
| `extension/manifest.json` | `options_ui`, `optional_permissions`. |
| `lib/tools.mjs`, `bin/pointer.mjs` | `done` on `say`. |
| `skills/pointer/SKILL.md`, `README.md` | Docs. |
| `test/sites.test.mjs`, `test/settings.test.mjs`, `test/presence.test.mjs` (new), `test/tools.test.mjs` | Tests. |

Content scripts cannot import modules, so `content.js` never imports `presence.js`; it renders the
`PresenceView` object the worker sends.

---

### Task 1: Blocklist matcher

**Files:**
- Create: `extension/sites.js`
- Test: `test/sites.test.mjs`

**Interfaces:**
- Produces:
  - `normalizeSitePattern(input: string): string` — canonical pattern; throws `Error` with a
    human-readable message on invalid input.
  - `isBlockedUrl(url: string, patterns: string[]): boolean`

Rules (from the spec): case-insensitive; leading `http://`, `https://` and `www.` are dropped; a bare
domain becomes `domain/*`; `*` matches any run of characters; matching is against
`hostname + pathname` of the parsed URL (port and userinfo ignored); only `http:`/`https:` URLs can
be blocked.

- [ ] **Step 1: Write the failing tests** in `test/sites.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSitePattern, isBlockedUrl } from "../extension/sites.js";

test("patterns are normalised", () => {
  assert.equal(normalizeSitePattern("https://www.MyBank.com"), "mybank.com/*");
  assert.equal(normalizeSitePattern("admin.example.com/*"), "admin.example.com/*");
  assert.equal(normalizeSitePattern("  github.com/MyOrg/*  "), "github.com/myorg/*");
  assert.equal(normalizeSitePattern("*.mybank.com"), "*.mybank.com/*");
  for (const bad of ["", "   ", "http://", "chrome://settings", "file:///etc"]) {
    assert.throws(() => normalizeSitePattern(bad));
  }
});

test("a blocked domain covers its pages, not look-alikes", () => {
  const p = ["mybank.com/*"];
  assert.equal(isBlockedUrl("https://www.mybank.com/login", p), true);
  assert.equal(isBlockedUrl("https://MyBank.com:8443/", p), true);
  assert.equal(isBlockedUrl("https://user@mybank.com/", p), true);
  assert.equal(isBlockedUrl("https://mybank.com.evil.io/", p), false);
  assert.equal(isBlockedUrl("https://mybank.com@evil.io/", p), false);
  assert.equal(isBlockedUrl("https://notmybank.com/", p), false);
});

test("subdomain and path patterns", () => {
  assert.equal(isBlockedUrl("https://a.b.mybank.com/x", ["*.mybank.com/*"]), true);
  assert.equal(isBlockedUrl("https://github.com/myorg/repo", ["github.com/myorg/*"]), true);
  assert.equal(isBlockedUrl("https://github.com/MyOrg/Repo", ["github.com/myorg/*"]), true);
  assert.equal(isBlockedUrl("https://github.com/other", ["github.com/myorg/*"]), false);
});

test("non-web URLs and empty lists are never blocked", () => {
  assert.equal(isBlockedUrl("about:blank", ["*"]), false);
  assert.equal(isBlockedUrl("not a url", ["*"]), false);
  assert.equal(isBlockedUrl("https://mybank.com/", []), false);
});
```

- [ ] **Step 2: Run** `node --test test/sites.test.mjs` — expected FAIL (module not found).
- [ ] **Step 3: Implement** both functions in `extension/sites.js` (ES module, no `chrome.*`).
  Match by turning the pattern into an anchored, case-insensitive `RegExp` with every character
  escaped except `*` → `.*`, tested against `hostname.replace(/^www\./, "") + pathname`.
- [ ] **Step 4: Run** `npm test` — expected PASS.
- [ ] **Step 5: Commit** `feat(extension): match blocked sites`.

---

### Task 2: Presence state machine

**Files:**
- Create: `extension/presence.js`
- Test: `test/presence.test.mjs`

**Interfaces:**
- Produces (all pure, plain-JSON state, `now` always passed in):

```js
export const THINKING_MS = 2000, QUIET_MS = 60_000, CHIP_CLEAR_MS = 10 * 60_000, STOPPED_CLEAR_MS = 30 * 60_000;
export const PREFIXES = ["⌛ ", "✋ ", "✅ "];

/** @typedef {{ state: "idle"|"active"|"quiet"|"stopped"|"done", tabId: number|null,
 *   lastActivityAt: number, enteredAt: number, actions: number, text: string, step: string,
 *   lastAction: string, doneText: string, dismissed: boolean }} Presence */

initialPresence(): Presence
describeCommand(method: string, params: object): string | null   // null = not agent activity
onCommand(p: Presence, { method, params, tabId, now }): Presence
onSay(p, { text, step, done, tabId, now }): Presence             // done:true = explicit done
onClearSay(p): Presence
onExplicitDone(p, { now, text }): Presence                       // tab_close all, agent `stop`
stopAccepted(p, source: "esc"|"click"|"bar"|"popup"|"shortcut"): boolean
onHumanStop(p, { now }): Presence
onResume(p, { now }): Presence
onTick(p, now): Presence
onDismiss(p, now): Presence
groupPrefix(p): string
baseGroupTitle(title: string): string
effectsOf(prev: Presence, next: Presence): { notify: "done"|"stopped"|null, unmark: boolean, retitle: boolean, clearTab: number|null }
viewOf(p, settings, agent: string): PresenceView
notificationText(kind: "done"|"stopped", { agent: string, actions: number, host: string }): { title: string, message: string }

/** @typedef {{ mode: "off"|"active"|"quiet"|"stopped"|"done", agent: string, text: string,
 *   step: string, lastAction: string, lastActivityAt: number, actions: number, doneText: string,
 *   bar: boolean, edge: boolean, labels: boolean, cursor: "watchable"|"fast",
 *   tabStops: { esc: boolean, click: boolean } }} PresenceView */
```

Behaviour the tests pin:
- `describeCommand`: `null` for `ext.status`, `tabs.list`, `ext.rename`, `ext.reload`, `ext.resume`,
  `page.caption`, `page.hidePointer`. `"open example.com"` for `tabs.open`/`page.navigate` (host of
  `params.url`, `www.` dropped). `"read the page"` for `page.snapshot` and `page.text`.
  `"take a screenshot"`, `'find "sign up"'` (`params.query`), `"press Enter"` (`params.key`),
  `"scroll"`, `"wait"`, `"go back"`/`"go forward"`/`"reload"` (`page.history` `params.action`
  `back`/`forward`/`reload`). `""` (activity, label comes from the page) for `page.act`,
  `page.fill`, `page.upload`, `page.dialog`, and anything else.
- Counted as an action (`actions += 1`): `page.act`, `page.fill`, `page.press`, `page.scroll`,
  `page.upload`, `page.dialog`, `page.navigate`, `page.history`, `tabs.open`.
- `onCommand` from `idle`/`done`/`quiet` → `active`; from `idle`/`done` it also resets `actions`,
  `text`, `step`, `doneText`, `dismissed`. In `stopped` nothing changes.
- `stopAccepted`: `popup`/`shortcut` always true; `esc`/`click`/`bar` only in `active` or `quiet`.
- `onHumanStop` moves `active`/`quiet` → `stopped`; other states unchanged.
- `onTick`: `active` idle ≥ `QUIET_MS` → `quiet`; `done` or `quiet` for ≥ `CHIP_CLEAR_MS` → `idle`;
  `stopped` for ≥ `STOPPED_CLEAR_MS` → `idle`.
- `onDismiss`: `done` → `idle`; `quiet`/`stopped` → `dismissed: true`.
- `effectsOf`: `notify` is `"done"` only on entering `done`, `"stopped"` only on entering
  `stopped` (never on entering `quiet`); `unmark` on `done → idle` and `stopped → idle`;
  `retitle` when `groupPrefix` changes; `clearTab` is the previous `tabId` when it changed.
- `groupPrefix`: `active`/`quiet` `"⌛ "`, `stopped` `"✋ "`, `done` `"✅ "`, `idle` `""`.
- `viewOf`: `mode` is `"off"` for `idle` and for `dismissed`; `bar`, `edge`, `labels`, `cursor`
  come from settings (`cursorSpeed`); `tabStops.esc = settings.escStops && stopAccepted(p, "esc")`,
  same for `click`.
- `notificationText`: done → title `"<agent> finished"`, message `"<n> action(s) on <host>"`
  (`"1 action"`, `"5 actions"`); stopped → title `"<agent> is waiting for you"`, message
  `"You stopped it on <host>. Reply in its chat to continue."`.

- [ ] **Step 1: Write the failing tests** in `test/presence.test.mjs`. Required test names and core
  assertions:
  - `describeCommand names what the agent does` — every mapping above, including
    `describeCommand("ext.status", {}) === null` and
    `describeCommand("page.navigate", { url: "https://www.example.com/a" }) === "open example.com"`.
  - `a command makes the agent active and counts actions` — two `page.act` + one `page.snapshot`
    from `initialPresence()` → `state === "active"`, `actions === 2`.
  - `silence turns active into quiet, never notifies` — `onTick(p, p.lastActivityAt + 60_000).state === "quiet"`
    and `effectsOf(prev, next).notify === null`.
  - `say done is an explicit done that notifies` — `onSay(p, { done: true, text: "All set", ... })`
    → `state "done"`, `doneText "All set"`, `effectsOf().notify === "done"`, `groupPrefix === "✅ "`.
  - `Esc and clicks stop only while working` — `stopAccepted` true for `esc` in `active` and
    `quiet`; false in `stopped`, `done`, `idle`; `popup` true in all five.
  - `a human stop holds through reads and lifts on resume` — `onHumanStop` then `onCommand(page.snapshot)`
    stays `stopped`; `onResume` → `active`; entering `stopped` gives `notify === "stopped"`.
  - `done clears after ten minutes and unmarks` — `onTick(done, enteredAt + 600_000)` → `idle`,
    `effectsOf().unmark === true`.
  - `an unresumed stop clears its marks after thirty minutes` — `onTick(stopped, enteredAt + 1_800_000)`
    → `idle`, `unmark === true`.
  - `switching tabs reports the old tab to clear` — `onCommand` on tab 1 then tab 2 →
    `effectsOf().clearTab === 1`.
  - `baseGroupTitle strips every prefix` — `"⌛ Claude Code"`, `"✋ Claude Code"`,
    `"✅ Claude Code"`, `"Claude Code"` all → `"Claude Code"`.
  - `presence survives a JSON round trip and still goes quiet` —
    `onTick(JSON.parse(JSON.stringify(p)), p.lastActivityAt + 90_000).state === "quiet"`.
  - `the view follows settings` — with `escStops: false`, `viewOf(...).tabStops.esc === false`;
    `cursorSpeed: "fast"` → `cursor === "fast"`; dismissed quiet → `mode === "off"`.
  - `notification text` — exact strings above for 1 and 5 actions.
- [ ] **Step 2: Run** `node --test test/presence.test.mjs` — expected FAIL.
- [ ] **Step 3: Implement** `extension/presence.js` with the signatures above (no `chrome.*`, every
  function returns a new object).
- [ ] **Step 4: Run** `npm test` — expected PASS.
- [ ] **Step 5: Commit** `feat(extension): presence state machine`.

---

### Task 3: `done` on `say`

**Files:**
- Modify: `lib/tools.mjs` (`say` schema ~line 312, `resolveCaption` ~line 425, `case "say"` ~line 811)
- Modify: `bin/pointer.mjs` (`case "say"` ~line 370, usage text ~lines 22 and 424)
- Modify: `skills/pointer/SKILL.md` (narration section ~line 197 and clean-up ~line 224)
- Test: `test/tools.test.mjs`

**Interfaces:**
- Produces: `resolveCaption(args)` returns `{ done: true, text? }` when `args.done` is true (text
  optional, same trimming/limit as today). `page.caption` hub params may carry `done: true`.

- [ ] **Step 1: Write failing tests** in `test/tools.test.mjs`:
  - `say done needs no text` — `resolveCaption({ done: true })` deep-equals `{ done: true }`;
    `resolveCaption({ done: true, text: " All  set " })` deep-equals `{ done: true, text: "All set" }`.
  - `say without text or done still fails` — `assert.throws(() => resolveCaption({}))`.
  - `the say tool offers done` — `TOOLS.find(t => t.name === "say").inputSchema.properties.done.type === "boolean"`.
- [ ] **Step 2: Run** `node --test test/tools.test.mjs` — expected FAIL.
- [ ] **Step 3: Implement**: add `done` to the schema with description
  `"Mark the task finished: the human sees a done mark and, if they turned it on, a notification. Text is optional."`;
  append to the tool description: `"End a finished task with say done: true."`. In `case "say"`,
  a done result reads `marked done` (+ `: "<text>"` when given). CLI: `pointer say --done ["text"]`.
  SKILL.md: tell agents to finish every task with `say` `done: true` (or `tab_close all`), and
  to write a short summary as its text.
- [ ] **Step 4: Run** `npm test` — expected PASS.
- [ ] **Step 5: Commit** `feat: let agents mark a task done with say`.

---

### Task 4: Presence in the service worker

**Files:**
- Modify: `extension/background.js`

**Interfaces:**
- Consumes: Task 2 functions; `withDefaults`/`SETTINGS_KEY` from Task 6 are not needed yet — use a
  local `let settings = { bar: true, edge: true, labels: true, cursorSpeed: "watchable", groupStatus: true, escStops: true, clickStops: true }`
  that Task 6 replaces.
- Produces (used by Tasks 5–8):
  - Message to the tab: `{ type: "pointer:presence", params: PresenceView }`.
  - Message to the tab: `{ type: "pointer:overlay-visible", params: { on: boolean } }` (replaces
    `pointer:caption-visible`).
  - Messages from the tab: `{ type: "pointer:stop", reason: "escape"|"takeover"|"bar" }` (existing,
    plus `"bar"`) and `{ type: "pointer:dismiss" }` (new).
  - `async function applyPresence(next: Presence): Promise<void>` — the only place that assigns
    the module-level `presence`; runs `effectsOf`, persists, retitles groups, pushes the view,
    clears `clearTab`, calls `unmarkTabs()` on `unmark`, and calls `notifyFor(kind)` (a no-op stub
    until Task 7).

- [ ] **Step 1: State and persistence.** Add `let presence = initialPresence()`; restore it in the
  existing `restored` block (key `pointerPresence`) and save it in `saveState()`.
- [ ] **Step 2: Feed commands.** At the top of `dispatch()` (after `await restored`), compute
  `describeCommand(method, params)`; when not `null`, call `applyPresence(onCommand(...))` with the
  tab id the command targets (`params.tabId ?? lastTabId`, updated again after `resolveTab`). In
  `case "page.caption"`: `onSay` / `onClearSay`; `case "tabs.close"` with `all` and
  `case "page.hidePointer"`: `onExplicitDone`. For `page.hidePointer` (the agent's `stop` tool) follow
  it at once with `onDismiss`, so it still notifies "done" but keeps today's immediate cleanup. For
  `tabs.close all`, drop the direct `unmarkTabs()` call: the done chip stays on a remaining human
  tab and the marks clear through `effectsOf().unmark` later, per the spec.
- [ ] **Step 3: Stop and resume.** `stopAgent(reason)` maps `escape→esc`, `takeover→click`,
  `bar`, `popup`, `shortcut`; for `esc`/`click`/`bar` it returns early when `!stopAccepted(presence, source)`.
  It no longer calls `unmarkTabs()`; it calls `applyPresence(onHumanStop(...))`. `ext.resume`
  calls `applyPresence(onResume(...))`. Add the `pointer:dismiss` message → `applyPresence(onDismiss(...))`.
- [ ] **Step 4: Ticks.** In the existing `pointer-keepalive` alarm handler, call
  `applyPresence(onTick(presence, Date.now()))`.
- [ ] **Step 5: Group titles.** `agentGroupTitle()` returns `(settings.groupStatus ? groupPrefix(presence) : "") + name`;
  `ensureAgentGroup` compares `baseGroupTitle(existing.title)` with the plain name when adopting.
- [ ] **Step 6: Screenshots.** In `case "page.screenshot"`, hide with `pointer:overlay-visible`
  `{ on: false }` whenever `!params.caption` (not only when a caption exists), restore in `finally`.
- [ ] **Step 7: Re-push after navigation.** In the `tabs.onUpdated` `complete` listener, re-send the
  view to `presence.tabId` (the content script is new after a load).
- [ ] **Step 8: Run** `npm test` — expected PASS (no regressions).
- [ ] **Step 9: Commit** `feat(extension): track agent presence in the worker`.

---

### Task 5: Control bar and edge in the page

**Files:**
- Modify: `extension/content.js` (overlay markup ~lines 30–125, caption functions ~282–398,
  `coverAt` ~807, message switch ~1290–1410, Esc/click listeners ~1526–1552)

**Interfaces:**
- Consumes: `pointer:presence` (`PresenceView`), `pointer:overlay-visible` from Task 4.
- Produces: sends `pointer:stop` with reason `"bar"` and `pointer:dismiss`.

Behaviour (look and copy from the spec and the approved mockups: dark bar, blue agent pill,
`#2563eb` edge while active, `#d97706` amber when stopped, white Stop button):
- `active`: `[agent] [step] text-or-lastAction  ■ Stop`. Text priority: caption text, then the
  page's own last action label (from `say(action, label)` in `pointer:act`), then `view.lastAction`.
  After `THINKING_MS` (2000) since `view.lastActivityAt`, show `Thinking…  · last: <lastAction>`;
  a 500 ms interval re-checks while `mode === "active"`.
- `quiet`: chip `No activity from <agent> for a minute ✕`.
- `stopped`: amber bar `Stopped | <agent> is waiting for you. Reply in its chat to let it continue. | Got it`.
- `done`: chip `✅ <agent> finished here · <n> actions` (`doneText` replaces the default when set) `✕`.
- `off`: nothing drawn. `view.bar === false` hides bar and chips; `view.edge === false` hides the edge.
- The bar (and only the bar/chip) has `pointer-events: auto`; its buttons act only on
  `event.isTrusted` and ignore clicks inside `agentWindowUntil` (the agent's own input).
  Stop → `pointer:stop` `"bar"`; Got it / ✕ → `pointer:dismiss`.
- The bar's own `pointerdown` must not trigger the page-level takeover listener (stop propagation
  inside the shadow root, or check `e.composedPath()` includes the overlay host).
- `coverAt` ignores `overlayHost` as a hit. Before `pointer:act`, `pointer:locate` and fill input,
  if the target point is inside the bar's rect, move the bar to the top (extend `placeCaption`).
- Esc/click listeners use `view.tabStops.esc` / `view.tabStops.click` together with the existing
  `humanCanSeeAgentTab()` guard.
- `view.labels === false` suppresses the action label next to the cursor; `view.cursor === "fast"`
  caps `move()` at 120 ms.
- `pointer:overlay-visible` hides/restores the whole overlay (bar, chip, edge, cursor, label, ripple,
  outline) via `visibility` on the host — no transitions, so screenshots never catch a fade.
- Respect `prefers-reduced-motion` for bar transitions.

- [ ] **Step 1: Load the unpacked extension** from this checkout (`chrome://extensions` → Developer
  mode → Load unpacked → `extension/`), removing the Web Store copy first; start the hub
  (`node bin/pointer.mjs status`).
- [ ] **Step 2: Implement** the markup, styles, view rendering and listeners above.
- [ ] **Step 3: Manual checks** (reload the extension with `node bin/pointer.mjs reload`, then):
  - 5.1 `pointer open example.com` → bar shows `open example.com`, blue edge, group `⌛ <name>`.
  - 5.2 wait 3 s → bar shows `Thinking…`.
  - 5.3 open a long page (e.g. a Wikipedia article), `pointer scroll` to the end, and `pointer click`
    a link in the footer that sits under the bar → the bar moves to the top first, the click works,
    and the agent is not stopped.
  - 5.4 click the bar's Stop → amber bar, group `✋ <name>`, next `pointer click` is refused with the
    stop message; `pointer resume` → blue again.
  - 5.5 `pointer say --done "All set"` → chip `✅ … All set`, group `✅ <name>`, edge gone; ✕ clears it.
  - 5.6 `pointer screenshot` → saved image has no bar, edge or cursor.
  - 5.7 press Esc on the page after done → nothing happens (agent not stopped).
- [ ] **Step 4: Run** `npm test` — expected PASS.
- [ ] **Step 5: Commit** `feat(extension): control bar and edge on the agent's tab`.

---

### Task 6: Settings page

**Files:**
- Create: `extension/settings.js`, `extension/options.html`, `extension/options.js`
- Modify: `extension/manifest.json`, `extension/popup.html`, `extension/popup.js`, `extension/background.js`
- Test: `test/settings.test.mjs`

**Interfaces:**
- Consumes: `normalizeSitePattern` (Task 1).
- Produces:
  - `SETTINGS_KEY = "pointerSettings"`
  - `DEFAULT_SETTINGS = { bar: true, edge: true, cursorSpeed: "watchable", labels: true, groupStatus: true, notifyDone: false, notifyStopped: false, sound: false, escStops: true, clickStops: true, blockedSites: [] }`
  - `withDefaults(stored: unknown): Settings` — unknown keys dropped, wrong types fall back to the
    default, `cursorSpeed` only `"watchable"|"fast"`, `blockedSites` passed through
    `normalizeSitePattern` with invalid entries dropped and duplicates removed.
  - Background: module-level `settings` loaded with `withDefaults` and kept current via
    `chrome.storage.onChanged`; on change, re-push the view and retitle groups.

- [ ] **Step 1: Write failing tests** `test/settings.test.mjs`:
  - `missing settings get the defaults` — `withDefaults(undefined)` deep-equals `DEFAULT_SETTINGS`.
  - `bad values fall back` — `withDefaults({ bar: "yes", cursorSpeed: "warp", extra: 1 })` →
    `bar === true`, `cursorSpeed === "watchable"`, no `extra` key.
  - `blocked sites are cleaned` — `withDefaults({ blockedSites: ["https://www.MyBank.com", "", "mybank.com", 3] }).blockedSites`
    deep-equals `["mybank.com/*"]`.
- [ ] **Step 2: Run** `node --test test/settings.test.mjs` — expected FAIL.
- [ ] **Step 3: Implement** `extension/settings.js`.
- [ ] **Step 4: Run** `npm test` — expected PASS.
- [ ] **Step 5: Build the page.** `options.html` + `options.js` (`<script type="module">`), same
  colour tokens, light/dark and font as `popup.html`; sections and wording exactly as the spec's
  settings table and the approved mockup (left nav: General, On the page, Notifications, Stopping,
  Sites, Privacy; version and hub address under the nav). Every control writes the whole object
  with `chrome.storage.local.set({ [SETTINGS_KEY]: ... })`. Connection reads `pointer:status`.
  "Show tabs" focuses `lastTabId`. Keyboard shortcut shows `chrome.commands.getAll()`'s
  `stop-agent` shortcut; "Change" opens `chrome://extensions/shortcuts` with `chrome.tabs.create`.
  Sites: input + Block button (shows the `normalizeSitePattern` error inline), list with ✕.
  Render the Notifications section's switches and Test button now, saving their values; Task 7
  adds the permission request and the real sending.
- [ ] **Step 6: Manifest and popup.** Add `"options_ui": { "page": "options.html", "open_in_tab": true }`
  and `"optional_permissions": ["notifications"]`. Popup header gets a gear button
  (`aria-label="Settings"`) calling `chrome.runtime.openOptionsPage()`.
- [ ] **Step 7: Wire settings into the worker** (replace Task 4's local object) and verify by hand:
  turning off Control bar hides it live; turning off "Esc stops" makes Esc do nothing while acting;
  Fast cursor shortens moves; Group status off removes the prefixes.
- [ ] **Step 8: Commit** `feat(extension): settings page`.

---

### Task 7: Notifications

**Files:**
- Modify: `extension/background.js`, `extension/options.js`

**Interfaces:**
- Consumes: `notificationText` (Task 2), `settings.notifyDone|notifyStopped|sound` (Task 6),
  `notifyFor(kind)` stub (Task 4).
- Produces: message `{ type: "pointer:test-notification" }` handled by the worker.

- [ ] **Step 1: Implement `notifyFor(kind: "done"|"stopped")`**: return unless the matching setting
  is on and `chrome.permissions.contains({ permissions: ["notifications"] })`; return when the human
  is watching (`presence.tabId` is the active tab of the last-focused normal window and that window
  is focused). Otherwise `chrome.notifications.create("pointer-" + kind, { type: "basic",
  iconUrl: "icons/icon128.png", title, message, silent: !settings.sound })` with text from
  `notificationText`. `chrome.notifications.onClicked` for `pointer-*` focuses `presence.tabId` and
  its window, then clears the notification. Guard every `chrome.notifications` use with
  `chrome.notifications?.` (the API is absent until the permission is granted).
- [ ] **Step 2: Settings page.** Turning on either notification switch calls
  `chrome.permissions.request({ permissions: ["notifications"] })` inside the click handler; if
  refused, the switch stays off and a line explains it. Test button sends
  `pointer:test-notification`; the worker shows title `Pointer notifications work`, message
  `You'll see this when an agent finishes or needs you.` (ignores the watching check).
- [ ] **Step 3: Manual checks:** with notifications on, switch to another tab, run
  `pointer say --done "x"` → one notification; clicking it brings the agent's tab forward. Run
  `pointer click …` and wait 90 s → no notification. Stop from the popup while in another tab →
  `… is waiting for you`. While looking at the agent's tab → no notification.
- [ ] **Step 4: Run** `npm test` — expected PASS.
- [ ] **Step 5: Commit** `feat(extension): notify when the agent finishes or needs you`.

---

### Task 8: Enforce the blocklist

**Files:**
- Modify: `extension/background.js` (`resolveTab` ~line 302, `tabs.open` ~1328, `tabs.select` ~1320,
  `page.navigate` ~1384, `tabs.list` ~1306, `tabs.onUpdated` ~877)

**Interfaces:**
- Consumes: `isBlockedUrl` (Task 1), `settings.blockedSites` (Task 6).
- Produces: `assertSiteAllowed(url: string): void` (throws the exact refusal text from Global
  Constraints) and `assertNotExtensionPage(url: string): void` (throws
  `Pointer cannot act on extension pages.` for `chrome-extension://` URLs).

- [ ] **Step 1: Implement** both asserts. Call `assertSiteAllowed` on the target URL in `tabs.open`
  and `page.navigate`, on the tab's URL in `tabs.select`, and on `tab.url` at the end of
  `resolveTab` (so every tab command is covered). Call `assertNotExtensionPage` in `resolveTab` and
  `tabs.select`.
- [ ] **Step 2: Listing.** In `tabs.list`, a blocked tab keeps its `tabId` but returns `url: ""`,
  `title: "(blocked site)"`.
- [ ] **Step 3: Landing on a blocked page.** In the `tabs.onUpdated` `complete` listener, when a
  marked tab's URL is blocked, send `pointer:hide` and a `mode: "off"` view to it.
- [ ] **Step 4: Manual checks:** block `example.com` in settings; `pointer open example.com` →
  refused with the exact text; open it yourself and `pointer tab select <id>` → refused; `pointer
  tabs` shows `(blocked site)`; `pointer open example.org` still works.
- [ ] **Step 5: Run** `npm test` — expected PASS.
- [ ] **Step 6: Commit** `feat(extension): keep agents off blocked sites`.

---

### Task 9: Docs

**Files:**
- Modify: `README.md` ("You can watch" bullets near the top, "How an agent uses it" `say` note,
  new short "Settings" section before "Troubleshooting", "Security and privacy" bullets),
  `skills/pointer/SKILL.md` (if Task 3 left anything).

- [ ] **Step 1:** Describe the control bar and its four states, the ⌛/✋/✅ group titles, the
  settings page (how to open it), notifications (off by default, Chrome asks once), and the blocked
  sites list. Keep the README's voice: short sentences, plain words.
- [ ] **Step 2: Run** `npm test` — expected PASS.
- [ ] **Step 3: Commit** `docs: control bar, settings and blocked sites`.

---

## Final check (with the human)

The extension behaviour can only be fully seen in a real Chrome. After Task 9, ask the human to load
the unpacked extension from this branch and run one real agent task (e.g. the README's signup demo),
then walk the spec's states table and the manual checks 5.1–5.7, 7.3 and 8.4 together.
