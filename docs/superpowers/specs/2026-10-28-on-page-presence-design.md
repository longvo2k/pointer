# On-page presence and settings

Date: 2026-10-28 · Status: draft for approval

## Why

Pointer works, but it does not *feel* as trustworthy as Claude in Chrome. A study of Claude in Chrome
v1.0.102 (the public Web Store package, read but never run) showed that much of that trust comes
from presence: a person can always tell, at a glance, that an agent has a tab, what it is doing,
whether it needs them, and how to stop it. Claude in Chrome does this with a glow around the tab, a
floating Stop button, a "Claude is active in this tab group" pill, ⌛/🔔/✅ in the tab-group title,
notifications when a task ends or needs permission, and a settings page.

Pointer already has strong parts of this: the cursor with action labels (`click · Sign up`),
`say` captions, background tabs, and four ways to stop (Esc, a click, the popup, Alt+Shift+S). What
it lacks is a steady signal for the whole time an agent holds a tab, a clear "needs you" and "done",
and a place where the human can see and change how Pointer behaves.

Success: someone watching Pointer work can always answer "is an agent here, what is it doing, does
it need me, how do I stop it" without opening a terminal, and can set Pointer up the way they like.

## Goals

1. A **control bar** at the bottom of the agent's tab while an agent works there: who is working,
   the step, what it is doing, and a Stop button. It grows out of today's `say` caption.
2. A thin, steady **edge** around the agent's tab.
3. Four visible **states**: acting, thinking, stopped (needs you), done.
4. The state in the **tab-group title**: `⌛ Claude Code`, `✋ Claude Code`, `✅ Claude Code`.
5. **Notifications** when the agent finishes or is stopped and waiting, only when the human is not
   looking at the agent's tab.
6. A **settings page** (`options.html`) with sections Connection, On the page, Notifications,
   Stopping, Sites, Privacy.
7. A **site blocklist**: sites agents can never open, read, or act on.
8. None of the presence UI appears in the agent's screenshots.

## Non-goals

- Asking before each new site, a "plan first" mode, or pausing on a domain change (Claude in
  Chrome's permission model). Tagged "later" on the settings page; its own project.
- Reliability work found in the same study (auto-reattach, coordinate clicks, more click types,
  background-tab input pumping, screenshot sizing). Separate project.
- Admin-managed policy (`managed_schema.json`), syncing settings across devices, a side panel.
- Showing presence inside iframes.

## Anti-goals (failure even if it works)

- The presence UI blocks clicks on the page or covers the site's own controls for long.
- The agent sees the presence UI in a screenshot, or can read or change the settings.
- A web page can change Pointer's settings, fake the Stop button, or hide the bar.
- Notification spam: more than one notification per state change, or notifications while the human
  is already watching the tab.
- Any stop path becomes weaker than today. A stop must still hold until the agent calls `resume`.
- Existing users get a Chrome "re-approve this extension" prompt after the update.

## Constraints

- Plain, unminified JavaScript, no framework, no new runtime dependency (README promise).
- MV3 service worker that Chrome can evict; state must survive eviction (Pointer already saves
  state to `chrome.storage.session`).
- The extension is published to the Chrome Web Store. Adding a permission that has a warning
  disables the extension for existing users until they approve it. `notifications` has a warning,
  so it must be an **optional permission** requested from the settings page.
- Pointer talks only to `127.0.0.1`; no outside servers.
- Works the same for MCP agents and for shell agents using the `pointer` CLI.

## Approaches considered

1. **The extension decides the state (chosen).** Every agent command already passes through
   `dispatch()` in `extension/background.js`. It records activity and drives the bar, the group
   title, and notifications. Settings live in `chrome.storage` and the blocklist is enforced in the
   extension, so neither the hub nor an agent can get around it. "Done" comes from an explicit
   `done` on `say`, else from 60 s of silence. Trade-off: without `done`, "done" is a timeout guess.
2. **The hub decides the state.** The hub tracks agent sessions and sends state to the extension.
   Rejected: agents keep their MCP process alive for a whole session and the CLI starts a new
   process for every command, so the hub cannot tell when a task ends either. It would also split
   state and settings across two places.
3. **Explicit "start task" / "end task" tools.** Rejected: exact only if every agent remembers to
   call them, which is not reliable across Claude Code, Codex, Cursor, OpenCode and DeepSeek models.
   `done` on `say` gets most of the benefit as an optional hint.

The human picked approach 1.

## Design

### States

State is kept per agent (Pointer has one agent name at a time, `agentName`) and shown on the
agent's current tab (`lastTabId`).

| State | Enters when | Bar | Edge | Group title |
|---|---|---|---|---|
| idle | no agent activity yet, or after done is dismissed | hidden | none | plain name |
| acting | an action command starts (any command except read-only status calls) | agent name, step, text, **Stop** | blue | `⌛ name` |
| thinking | ~2 s with no command after acting | "Thinking…" + last action, **Stop** | blue | `⌛ name` |
| stopped | the human stops the agent (any path) | amber: "name is waiting for you. Reply in its chat to let it continue." + **Got it** | amber | `✋ name` |
| done | explicit: `say` with `done: true`, `tab_close` with `all: true`, the agent's `stop` · guessed: 60 s with no command (see below) | collapses to a chip: "✅ name finished here · N actions" + ✕ (guessed: "No activity from name for a minute") | none | explicit `✅ name` · guessed keeps `⌛ name` |

- **Bar text while acting:** the current `say` text if there is one; otherwise a short description
  of the action from the command itself (`click "Create workspace"`, `fill "Work email"`,
  `open example.com`). Step counter is the `say` `step` when given. Sensitive values are never
  shown: `fill` shows the field name, never the typed text.
- **Thinking** is decided in the content script from the time of the last update, so it needs no
  timer in the service worker.
- **Done after silence:** the service worker stores `lastActivityAt` in session storage and checks
  it on the existing 30 s keepalive alarm, so done appears 60–90 s after the last command and
  survives worker eviction.
- **Leaving done:** any new action returns to acting. ✕ on the chip, or 10 minutes passing, returns
  to idle and removes the ✅ prefix.
- **Stopped** replaces today's behaviour on stop: today `stopAgent()` ungroups the agent's tabs and
  removes the title badges. Instead the group and badges stay, the group title becomes `✋ name`,
  and the bar turns amber. `resume` returns to acting on the next command. **Got it** only hides
  the bar; it never resumes (only the agent's `resume` does, after the human agrees).

#### Explicit and guessed done

Done has two kinds, and the state machine keeps them apart:

- **Explicit done:** `say` with `done: true`, `tab_close` with `all: true`, or the agent's own
  `stop` tool. The agent said it is finished.
- **Guessed done (quiet):** 60 s with no command. The agent may still be working (a long think, a
  build). The chip reads "No activity from name for a minute" instead of "finished", the group title
  keeps `⌛`, the stop paths stay live, and no notification is sent.

#### When a stop is accepted

- **Esc and a click in the agent's tab** stop the agent in acting, thinking and guessed done, the
  same as today while the tab is marked. They do nothing in stopped (already stopped: no repeat
  stop) and after explicit done (the agent is finished, so Esc can close a site's own popup).
- **The popup Stop button and the keyboard shortcut** always set the stop, as today. If no agent
  is acting, thinking or quiet, the stop is recorded silently: no amber bar and no notification.

#### When the marks end

- **Explicit done:** the chip and `✅ name` stay on the agent's tab until ✕, the next action, or 10
  minutes; then the group and badges are removed (today's `unmarkTabs()`). `tab_close all` closes
  the agent's own tabs as today; if a human tab the agent worked in remains, the chip sits there,
  otherwise only the notification shows. The agent's `stop` tool keeps today's immediate cleanup.
- **Stopped and never resumed:** **Got it** hides the bar and the edge. The `✋ name` group title and
  badges stay until `resume`, or for 30 minutes, after which they are removed. The stop itself
  keeps holding until `resume`, as today.

### Control bar and edge (content script)

- Built in the existing closed shadow root overlay (`ensureOverlay()` in `extension/content.js`),
  which already keeps page CSS and scripts out.
- The bar replaces the caption element: a `say` caption becomes the bar's text instead of a
  separate box. `say` keeps its current options (`step`, `ref` outline, `seconds`, `clear`).
- The bar is the only part of the overlay with `pointer-events: auto`. Its buttons act only on
  `event.isTrusted` clicks. The Stop button sends the same `pointer:stop` message as Esc, with
  reason `bar`. A click on the bar must not also count as a "takeover" click on the page.
- The bar moves out of the way: if the cursor or the element being acted on is under the bar, the
  bar slides to the top of the viewport (today's caption already does this in `placeCaption()`).
- Edge: a 2 px inset line around the viewport, blue while acting or thinking, amber when stopped.
  No animation (the mockup's pulsing was rejected for something calmer); respects
  `prefers-reduced-motion` anyway.
- Shown only while the tab is visible. In a hidden tab nothing is drawn; state is applied when the
  tab becomes visible (`visibilitychange`).

### Hidden from screenshots

`page.screenshot` already hides the caption around the capture. This is widened to the whole
presence UI: bar, edge, cursor, label, ripple and outline. `caption: true` on `screenshot` keeps its
meaning and also keeps the presence UI in the image.

### Tab-group title

`⌛ `, `✋ ` or `✅ ` is put in front of the agent's name in the group title. Code that finds the
agent's group by title (after the worker is evicted) must ignore the prefix.

### Notifications

- `notifications` becomes an `optional_permissions` entry. The settings page asks Chrome for it
  when the human turns a notification switch on; until then no notification is sent and the
  switches show as off.
- Sent on entering **explicit done** and **stopped**, at most once per entry, and only when the agent's tab
  is not the active tab of the focused window (or Chrome is not focused).
- Text: "Claude Code finished" / "N actions on example.com", and "Claude Code is waiting for you" /
  "You stopped it on example.com. Reply in its chat to continue."
- Clicking the notification brings the agent's tab and window to the front.
- "Play a sound" sets the notification's `silent` flag to false; the sound is the operating
  system's.

### Settings page

- `extension/options.html` + `extension/options.js`, same look and code style as `popup.html`
  (light and dark, same colour tokens). Opened from a gear in the popup and from Chrome's
  "Options" menu (`options_ui` with `open_in_tab: true`).
- Stored in `chrome.storage.local` under one `pointerSettings` key, with defaults applied in one
  place. The service worker and content scripts read it and listen to `chrome.storage.onChanged`.
  No agent command reads or writes settings.

| Section | Setting | Default |
|---|---|---|
| Connection | hub status and address, agent name and its tab count, "Show tabs" (focuses the agent's tab) | read-only |
| On the page | Control bar | on |
| | Edge around the tab | on |
| | Cursor speed: Watchable / Fast (Fast: shorter cursor moves, no wait for the overlay before input) | Watchable |
| | Action labels next to the cursor | on |
| | Status in the tab-group title | on |
| Notifications | When the agent finishes | off until permission granted |
| | When the agent is stopped and waiting | off until permission granted |
| | Play a sound | off |
| | Test (sends a sample notification) | — |
| Stopping | Keyboard shortcut (shows the current one; "Change" opens `chrome://extensions/shortcuts`) | Alt+Shift+S |
| | Esc in the agent's tab stops it | on |
| | A click of yours in the agent's tab stops it | on |
| Sites | Blocked sites list (add, remove) | empty |
| Privacy | Plain statement of what is hidden from agents and that there are no outside servers | read-only |

The popup Stop button and the keyboard shortcut cannot be turned off, so there is always a way to
stop. Turning the control bar off also removes its Stop button; the edge, cursor, and other stop
paths remain.

### Site blocklist

- Patterns like Claude in Chrome's: matched against host and path, case-insensitive, `*` matches any
  run of characters, a leading `http://`, `https://` or `www.` is ignored, a bare domain means the
  whole domain (`example.com` = `example.com/*`), and `*.example.com` covers subdomains.
- Checked in the service worker:
  - before `tabs.open`, `page.navigate` and `tab_select` with the target URL;
  - before every command on a tab, against that tab's current URL (so a click that lands on a
    blocked site stops the agent there);
  - when the agent's tab finishes a navigation to a blocked URL, which also clears that tab's
    presence UI.
- Refused commands fail with: "This site is blocked in Pointer's settings. Ask the human to do this
  step." The agent is not stopped; it can carry on elsewhere.
- `tabs_list` still lists a blocked tab but without its URL and title (`"(blocked site)"`).

### `done` for agents

- `say` gains `done: boolean`. With `done: true`, `text` becomes optional; the text, if given, is
  shown on the done chip. The CLI gets `pointer say --done ["text"]`.
- The tool description and `skills/pointer/SKILL.md` ask agents to finish with `say` `done: true`
  (or `tab_close all`) when a task is complete.

### Code layout and tests

- New `extension/presence.js` (ES module imported by the service worker): the state machine and the
  blocklist matcher as pure functions with no `chrome.*` calls, so `node --test` can cover them
  from `test/presence.test.mjs`.
- `background.js`: record activity in `dispatch()`, push state to the tab, group-title prefixes,
  notifications, blocklist checks, stop keeps the group.
- `content.js`: bar, edge, states, settings-aware Esc/click stop and cursor speed, hide-all for
  screenshots.
- `lib/tools.mjs` and `bin/pointer.mjs`: `done` on `say`.
- `manifest.json`: `options_ui`, `optional_permissions: ["notifications"]`.
- README ("How an agent uses it", a short "Settings" section), SKILL.md, and the popup (gear
  link).

## Decided by the human

- Option C of three looks: one control bar plus a thin edge, not a pulsing glow or a corner badge.
- The four states and the group-title prefixes as mocked up.
- The settings page with all six sections, including the Sites blocklist.
- The extension decides the state (approach 1).
- A guessed done (60 s of silence) never sends a notification; it only shows the quiet chip. Only
  explicit done and stopped notify.

## Calls made by Claude (please check)

- Stop now keeps the agent's tab group and badges (shown as ✋) instead of ungrouping them.
- The edge does not pulse.
- Timings: thinking after ~2 s, done after 60–90 s of silence, the done chip clears after 10
  minutes.
- Notifications are an optional permission and off until the human turns them on.
- The blocklist blocks reading as well as acting, and refuses rather than stops.
- Settings are per Chrome profile (`storage.local`), not synced.

- Esc and a click stop the agent in acting, thinking and guessed done, but not when already stopped
  or after explicit done. The popup and the shortcut always stop.
- After explicit done, marks clear after ✕, the next action, or 10 minutes. After a stop that is
  never resumed, marks clear after 30 minutes while the stop keeps holding.
- Commands on `chrome-extension://` tabs are refused, so an agent cannot reach the settings page.
- The presence UI is ignored by Pointer's own "is something covering this element" check.

## Left to the builder

- Exact wording of action descriptions in the bar and of notification text, within the rules above.
- How the bar and the existing caption code are merged in `content.js`.
- Visual details within the mockups (spacing, colours from the existing palette).
