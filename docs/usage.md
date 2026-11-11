# Using Pointer

The full reference: every tool, the CLI, profiles, the overlay, settings and configuration.

## How an agent uses it

The loop is short: look once, then act and read what changed.

```
snapshot  →  click e31  →  fill e40 "ada@example.com"
```

`snapshot` lists the interactive elements on screen, one per line, and counts the rest:

```
url: https://github.com/microsoft/vscode
view: 0% down · 0 elements above, 183 below (scroll, find, or snapshot scope "all")
- button "Platform" [ref=e3]
- link "Issues 5k+ (5k+)" [ref=e16]
- button "Code" [ref=e31]
```

Each action answers with what changed on screen, so the agent rarely needs another snapshot:

```
clicked button "Code" → https://github.com/microsoft/vscode
changes in view:
+ button "Clone with HTTPS" [ref=e286]
+ link "Download ZIP" [ref=e292]
~ button "Code" [ref=e31] expanded
```

Refs stay valid until the page navigates. If the action loads a new page, the report is the new
view. Status and error messages the page announces (`role="status"`, `role="alert"`, `aria-live`)
show up too, so the agent sees "Saved" or "Pick a plan to continue" without another look.

| Job | Tools |
|---|---|
| Browsers | `browser_status`, `browsers_list`, `browser_use` |
| Tabs | `tabs_list`, `tab_open`, `tab_select`, `tab_close`, `tab_focus` |
| Read | `snapshot`, `find`, `read_text`, `screenshot`, `wait_for` |
| Screen size and layout | `viewport`, `layout` |
| Act | `click`, `hover`, `fill`, `press`, `scroll`, `navigate`, `upload`, `dialog` |
| Verify | `verify`, and `expect` on `click`, `fill`, `press` |
| Debug | `console`, `network` |
| Narrate, mark done | `say` |
| Stop | `stop`, `resume` |

## What each tool does

A few that need explaining:

- `tab_open` opens a background tab. `tab_select` switches the agent's working tab without bringing it
  forward. Only `tab_focus` (or `tab_open` with `focus: true`) brings a tab to the front, which
  interrupts you, so agents use it only when you ask to watch. `tab_close` closes only tabs the agent
  opened, including tabs its clicks opened (`target="_blank"` links, popups); your own tabs stay open
  even if the agent worked in them.
- A tab opened by the agent's click opens in the background: Pointer gives you back the tab and
  window you were on, puts the new tab in the agent's group, and `click` reports `opened tab <id>`.
- `click`, `hover`, and `fill` check that nothing covers the element first. If a popup or its
  backdrop is in the way, they do nothing and say what covers it and which ref closes it, instead of
  clicking the popup. `snapshot` and `find` flag such a popup at the top of their output.
- `hover` moves the pointer onto an element without clicking, to open hover menus and tooltips, and
  reports what appeared.
- `navigate` goes back, forward, or reloads the agent's tab and returns the new view.
- `find "sign up"` searches the whole page, on screen or not, and returns a few matching refs.
- `dialog` answers an `alert`, `confirm`, or `prompt`. A click that opens one returns right away and
  says so instead of hanging.
- `upload` attaches local files: to a file input, a styled button over a hidden one, or a button that
  opens the file picker itself (the picker is intercepted, so no system dialog appears). It refuses
  hidden files and anything that looks like a key or credential (`id_rsa`, `.env`, `*.pem`).
- `tab_open` opens only `http`, `https`, and `about:blank`.
- `viewport mobile` (or `tablet`, `desktop`, a width and height) emulates that screen in the agent's
  tab, with touch for phones and tablets, so the agent can check a responsive layout and take
  screenshots at each size. Your window and tabs keep their size. `viewport reset` undoes it.
- `layout` measures the page for bugs a screenshot hides, in exact pixels: a page wider than the
  screen (and the element that causes it), clipped text, clickable elements covering each other, tap
  targets under 24px (or 44px on touch), text squeezed against or spilling out of its box, and uneven
  gaps between repeated items. Run it after `viewport mobile`, `tablet`, and `desktop`.
- `say` shows a caption at the bottom of the agent's tab, so when an agent demos something you can
  follow along in the browser instead of the terminal. It can carry a step counter (`3/5`), outline
  the element it describes, and disappear after a few seconds. It stays across page loads, never
  blocks clicks, is left out of screenshots (unless asked) and `layout`, and `stop` hides it.
  `click`, `hover`, `fill`, `press`, and `scroll` take `say` too, to caption a step right before it.
  `say` with `done: true` (CLI: `pointer say --done "summary"`) tells you the task is finished: the
  bar becomes a ✅ mark and, if you turned it on, you get a notification.
- `verify` proves an outcome instead of assuming it. It checks that text is shown (`text`) or gone
  (`gone`), an element is visible (`selector`), a field holds a value (`field` + `equals`), the URL
  matches (`url`), or a request sent after the last action got the right status (`request`, `status`),
  and keeps checking until all pass or `timeout` (default 5s). `click`, `fill`, and `press` take the
  same checks as `expect`, so one call acts and proves the result:

  ```
  clicked button "Save" → https://example.com/items/42
  ...

  verified (2 checks, 0.4s):
  ✓ text "Item saved" — "Item saved successfully"
  ✓ request POST /api/items — POST 201 example.com/api/items (142ms)
  ```

  On failure it says `NOT verified` and shows what happened instead: error messages on the page, or
  the request's status and the start of the server's reply. Values of password and other secret
  fields are never shown. A `request` check turns on network capture before the action; Pointer
  never reloads a page on its own to check.
- `console` and `network` read the tab's errors and requests. Capture starts on the first call
  (`reload: true` captures a page load), because turning it on makes the debugger easier for anti-bot
  scripts to notice.

## CLI

```bash
pointer open https://example.com      # background tab; --focus brings it forward (interrupts you)
pointer snap                          # --all for the whole page, --hrefs for link targets
pointer find "sign up"
pointer click e14
pointer fill e9 "hello"
pointer hover e7                      # open a hover menu
pointer back                          # also: forward, nav reload
pointer verify --text "Saved" --url /items/   # --gone, --selector, --field e4 --equals x, --request "POST /api/items" --status 201, --timeout ms
pointer dialog dismiss
pointer upload e4 ~/resume.pdf
pointer console errors --reload
pointer network api --failed
pointer shot out.png
pointer viewport mobile                # also tablet, desktop, 390 844, reset
pointer layout                         # overflow, clipped text, overlaps, tap targets, spacing
pointer say "Play a premium story" --step 3/5 --ref e10   # caption for whoever watches the tab
pointer click e10 --say "The preview stops at 15 seconds"  # caption, then click
pointer say --clear
pointer close --all                   # close the agent's tabs
```

Add `--json` to any command for machine-readable output. `pointer help` lists everything.

## Several Chrome profiles

If Pointer is loaded in more than one profile (work and personal, say), a new task starts in the
profile you focused last. A task that is already running stays in its profile even if you switch,
so its tabs and refs keep working. A task counts as new after 2 minutes without agent calls
(`POINTER_FOLLOW_IDLE_MS`).

```bash
pointer browsers         # every Chrome profile by name and email, open or closed
pointer use Work         # switch to the profile named Work (its email or folder works too)
pointer use auto         # follow the profile you use again
```

Pointer reads the profile names and emails from Chrome's own `Local State` file on your computer,
so agents see "Work (you@company.com)" instead of a random id, including profiles that are closed.

Agents on MCP can do the same: `browsers_list` lists every profile with a few tabs of each open one,
and `browser_use { profile: "Work" }` switches (agents are told to switch only when you ask). If that
profile is closed, Pointer opens it in Chrome and waits up to 20 seconds for the extension to connect
there. If Chrome already has it open but Pointer has not reconnected yet, Pointer waits instead of
opening a second window. A profile without Pointer installed is never opened. `browser_status` names
the profile in use and says whether the hub is pinned. If it is pinned to another profile, the
Pointer popup in this one says so and offers **Use this profile**.

`browsers_list` shows the agent the name and email of every Chrome profile, and the titles and
addresses of the first three tabs in every connected profile, not only the one it drives, so it can
tell them apart. Sites blocked in a profile's settings stay hidden there. Google Chrome only for
now: Beta, Canary, Chromium, Edge and Brave profiles are not listed (`POINTER_CHROME_DIR` points
Pointer at another user data folder).

## What you see, and settings

While an agent works in a tab, Pointer draws a thin line around it and a bar at the bottom:

| The bar shows | When | Tab group |
|---|---|---|
| The agent's name, its step, what it is doing, and **Stop** | it is acting | `⌛ name` |
| "Thinking…" and its last action | no command for a couple of seconds | `⌛ name` |
| "No activity from name for a minute" | no command for a minute (it may still be working) | `⌛ name` |
| "name is waiting for you" in amber | you stopped it; it must ask you before going on | `✋ name` |
| "✅ name finished here" | the agent said it is done | `✅ name` |

Each agent has its own colour on the line, the cursor, the bar and its Chrome tab group: Claude
orange, Codex green, Cursor cyan, and any other agent blue, pink or purple (the same one every
time, picked from its name). Known agents show by name, so `claude-code` reads "Claude". A stopped
agent is amber whatever its colour. While an agent works, the line glows and a light runs round it;
with your system's "reduce motion" on, it stays still.

None of this shows up in the agent's screenshots.

Open the settings from the gear in the Pointer popup, or right-click the toolbar icon and choose
**Options**. You can:

- pick a **Look**: Classic (clean and quiet) or Sketch (hand-drawn, with handwritten labels). It
  changes the popup, the settings page, and what Pointer draws on web pages;
- turn the bar, the line, the action labels, and the tab-group marks on or off, and pick a Fast cursor;
- get a notification when the agent finishes or is waiting for you (Chrome asks once; off until you
  turn it on, and only when you are looking at something else);
- choose whether `Esc` or a click in the agent's tab stops it (the popup and `Alt+Shift+S` always do);
- list **blocked sites**, like `mybank.com` (which also covers `login.mybank.com`) or
  `github.com/myorg/*`. Agents cannot open, read, or act on them; if a click or redirect lands on
  one, the agent is told only that it did, and `tabs_list` shows such tabs as "(blocked site)".

Agents cannot open or change the settings page.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `POINTER_AGENT` | `agent` | name in status, the tab group, and the title badge (`Claude · Example`) |
| `POINTER_FOLLOW_IDLE_MS` | `120000` | idle time after which a new task follows the Chrome profile you focused last |
| `POINTER_FOCUS_WINDOW` | `1` | also raise the OS window when `tab_focus` or `open --focus` brings a tab forward |
| `POINTER_EXTENSION_IDS` | — | extra extension ids the hub accepts, comma separated (a copy loaded from another folder) |
| `POINTER_PORT` | `8790` | hub port. The extension always connects to 8790, so change `DEFAULT_PORT` in `extension/background.js` to match |

## How it works

```
agent (MCP or CLI)
      │
      ▼
 local hub  (ws + http on 127.0.0.1:8790)
      │
      ▼
 Chrome extension  ── chrome.debugger (trusted input)
      │
      ▼
 your tab  ── overlay: pointer, label, ripple, target outline, caption
```

The code is split along the trust boundary:

- `extension/` is the only part that runs inside Chrome. The service worker owns the hub connection
  and the debugger session; the content script owns snapshots and the overlay.
- `lib/` holds the hub, which routes each call to the active browser and tab, and the tool layer
  shared by the CLI and the MCP server.
- `bin/` exposes those tools as the `pointer` CLI and an MCP stdio server.
- `skills/pointer/` is the agent-facing policy.

When adding behavior, keep that boundary: browser mechanics go in the extension, new tools and their
formatting in `lib/tools.mjs`, and agent guidance in the skill. The hub stays a router.

## Limits

- Snapshots cover the top frame. They do not reach into iframes or open shadow roots yet.
- One browser is active at a time, and one agent at a time. Several agents sharing tabs is the next
  step.
- Chrome and other Chromium browsers only. Firefox and Safari do not offer `chrome.debugger` to
  extensions.
