---
name: pointer
description: Drive the user's real Chrome tab through the Pointer tool — click, type, scroll, read pages, and capture what is on screen with a visible pointer. Use this whenever the user asks you to do something in their browser or on a live website (fill a form, click through a flow, check a logged-in page, try a UI, grab a screenshot), says "use my browser", "drive my Chrome", "show me on screen", or names Pointer. Prefer it over headless scraping when the user needs to watch, when their existing logins matter, or when the page is behind auth. Not for chrome:// pages or purely static fetching.
---

# Pointer

Pointer drives the Chrome the human is already using, through an extension. When the agent's tab is
in front, every action is visible: the cursor slides to the target, labels what it is about to do
(`click · Sign Up`), ripples, and outlines the element. Input is dispatched as trusted events, so
React handlers and pointer checks behave like a real user.

If the human switches to another tab or window, the agent keeps working in its own tab without
stealing focus. The agent's tabs are placed in a Chrome tab group named after the agent (for example
**Claude**) and their titles carry the same badge (for example `Claude · PAVE Inspect`) so the human
can find them at a glance. `tab_open` opens tabs in the background; only `tab_focus` (or
`tab_open` with `focus: true`) brings a tab to the front.

That visibility is the point. The human is watching a real browser with real logins, real money, and
real messages in it. Work at a pace they can follow, and treat irreversible actions differently
from browsing.

## Running it

The loader prints this skill's base directory — for the default install,
`~/.claude/skills/pointer`. Use the path it reports, and work from there so the relative wrapper
resolves:

```bash
cd ~/.claude/skills/pointer
./scripts/pointer status
```

All examples below assume that directory. If you are in the Pointer checkout instead, the same
wrapper is at `skills/pointer/scripts/pointer`; if neither exists, call `node <repo>/bin/pointer.mjs`
directly.

The tab group and title badge use the hub's agent name. Set it before the hub starts if the default
`agent` is not recognizable:

```bash
POINTER_AGENT=Claude ./scripts/pointer serve
```

## 1. Check the wiring before the first action

```bash
./scripts/pointer status
```

Expected: `Extension: connected`. If not:

- Start the hub if needed: `./scripts/pointer serve` (any other command auto-starts it, but `serve`
  makes failures obvious).
- Ask the human to open `chrome://extensions`, enable **Pointer**, and keep Chrome open. The toolbar
  badge reads **on** when connected.
- If the extension is connected but calls fail, retry once — the service worker reconnects within
  about 30 seconds after an idle eviction.

If more than one Chrome profile has the extension loaded (a work profile and a personal one, say), a
new task starts in the profile the human focused last; a task in progress stays where it is. If the
human wants a specific profile, or actions land in the wrong one, check and choose explicitly:

```bash
./scripts/pointer browsers      # ids, builds, last focus, which one is active
./scripts/pointer use 3f9c1a2b  # pin; `use auto` follows the human again
```

After an extension update, `./scripts/pointer reload` asks the connected extension to reload from
disk (it must already be running the build that supports it); otherwise ask the human to reload it at
`chrome://extensions`.

Do not relaunch or replace their Chrome. The whole value here is their profile, their cookies, their
extensions.

## 2. The loop: snapshot once, then read the change reports

Everything is ref-driven. `snapshot` lists what is **on screen**, one line per actionable element,
and counts what is above or below:

```
url: https://github.com/microsoft/vscode
title: GitHub - microsoft/vscode
view: 0% down · 0 elements above, 183 below (scroll, find, or snapshot scope "all")
- button "Platform" [ref=e3]
- link "Issues 5k+ (5k+)" [ref=e16]
- button "Code" [ref=e31]
```

Refs stay valid until the page navigates, across snapshots and scrolls. Every `click`, `hover`, `fill`,
`press`, and `scroll` returns what changed on screen, so you rarely need a fresh snapshot:

```
clicked button "Code" → https://github.com/microsoft/vscode
changes in view:
+ button "Clone with HTTPS" [ref=e286]
+ link "Download ZIP" [ref=e292]
~ button "Code" [ref=e31] expanded
```

`+` appeared, `-` disappeared, `~` changed state. If the action loaded a new page or changed most of
the screen, the report is the new view instead. `scroll` lists what came into view. `no change in
view` means the action did nothing visible; check before repeating it.

1. `snapshot` once when you arrive on a page (or use `find` if you know what you want).
2. Act on a ref, and read the report.
3. Snapshot again only when the report is not enough.

To reach something off screen, use `find "words"` (it searches the whole page and marks off-screen
matches) and click the ref; the click scrolls to it. `snapshot` with `scope: "all"` lists the whole
page and `hrefs: true` adds link targets, but both cost more tokens.

Never guess a CSS selector when a ref exists.

```bash
./scripts/pointer snap
./scripts/pointer find "sign up"
./scripts/pointer click e14        # prints what changed
./scripts/pointer fill e6 "demo@example.com"
```

## 3. Pick the right operation

| You need | MCP tool | CLI |
|---|---|---|
| Is the extension connected? | `browser_status` | `status` |
| Open a page (background tab) | `tab_open` | `open <url>` |
| See or switch tabs (without disturbing the human) | `tabs_list`, `tab_select` | `tabs`, `select <tabId>` |
| Close your tabs when done (including tabs your clicks opened) | `tab_close` (`all: true`) | `close [tabId\|--all]` |
| Bring a tab forward (only if the human asks to watch) | `tab_focus` | `focus <tabId>` |
| What is on screen, with refs | `snapshot` (`scope`, `hrefs`) | `snap [--all] [--hrefs]` |
| Find an element anywhere on the page | `find` | `find <words>` |
| Click | `click` | `click <ref\|selector>` |
| Open a hover menu or tooltip | `hover` | `hover <ref\|selector>` |
| Replace a field's contents | `fill` (optionally `submit`) | `fill <ref> <text>` |
| Press Enter, Tab, Escape, Cmd/Ctrl+A | `press` | `press <key>` |
| Go back, forward, or reload | `navigate` (action) | `back`, `forward`, `nav reload` |
| Move down a long page / reveal an element | `scroll` (direction, amount, or ref) | `scroll [up\|down] [px]` |
| Read prose without HTML | `read_text` | `text` |
| Wait for text, a selector, or time | `wait_for` | `wait <text\|ms>` |
| Show the human the current state | `screenshot` | `shot <path.png>` |
| Check a responsive layout | `viewport` (mobile, tablet, desktop, reset, or width + height) | `viewport <preset\|W H>` |
| Find layout bugs in exact pixels | `layout` (`scope`) | `layout [--screen]` |
| Answer an alert / confirm / prompt | `dialog` (accept or dismiss, optional text) | `dialog accept\|dismiss [text]` |
| Attach files to an upload field | `upload` (ref, paths) | `upload [ref] <file...>` |
| Debug the page: console errors | `console` (level, reload) | `console [errors\|all] [--reload]` |
| Debug the page: requests, failures, bodies | `network` (filter, failed, body) | `network [text] [--failed] [--body id]` |
| Narrate a demo for a human watching the tab | `say` (text, step, ref, seconds, clear), or `say` on an action | `say "<text>" [--step 3/5] [--ref e10] [--for 5s]`, `--say "<text>"` on an action |
| Hide the pointer and stand down | `stop` | `stop` |
| Continue after the human stopped you (only once they agree) | `resume` | `resume` |

Notes that save a round trip:

- `fill` clicks the field, selects everything, and types — it replaces rather than appends.
  Add `submit: true` to press Enter afterwards.
- `hover` leaves the pointer on the element and reports what opened. Click a ref from that report
  next; a click on something else moves the pointer away and the menu may close.
- `navigate` back, forward, or reload returns the new view. Refs from before it are gone.
- `wait_for` is cheaper than polling with repeated snapshots after a click that loads data.
- `screenshot` captures the agent's tab, including the pointer label, even when the human is on
  another tab. Use it when layout or visual state matters; use `snapshot` when you need to act.
- `viewport` changes the screen size of your tab only, never the human's window. For a responsive
  check, go through `mobile`, `tablet`, `desktop`, taking a `screenshot` or reading the returned view
  at each, then `viewport reset`. Closing the tab also clears it.
- `layout` finds what screenshots hide: overflow and its cause, clipped text, overlapping targets,
  small tap targets, tight padding, uneven gaps. `!` lines are bugs, `~` lines are worth a look. Run it
  at each viewport size, fix, and run it again; refs in its output work with `scroll` and `click`.
- Actions do not bring the agent's tab to the front. If you need the human to watch, call
  `tab_focus` first; otherwise leave them where they are.
- A click on a `target="_blank"` link or a popup opener reports `opened tab <id>`. The tab opens in
  the background and is yours: `tab_select <id>` to work in it, and `tab_close` closes it.
- If `click`, `hover`, or `fill` fails with `is covered by dialog "..."`, nothing was clicked: a popup
  or its backdrop is over the element. Close it with the ref the error names (or `press Escape`),
  then retry. `snapshot` and `find` start with a `blocked:` line while such a popup is open. A
  newsletter or promo popup is fine to dismiss; say so in your report. Do not accept marketing or
  sign up to close one.
- When the human is watching the tab (a demo, a walkthrough, `open --focus`), narrate in the page,
  not only in chat: `say` with the step and what to look for, or `say` on the action itself
  (`click e10 --say "The preview stops at 15 seconds"`). Keep each caption to one or two short
  sentences, put a counter in `step` when there is a plan, pass `ref` to outline what you describe,
  and `say --clear` when the demo ends. Captions are left out of `screenshot` unless you pass
  `caption: true`. Do not caption routine work nobody is watching.
- Prefer MCP tools when they are registered. The CLI is the same bridge, so mixing them in one task
  is fine. `--json` on any CLI command returns machine-readable output.

## 4. Acting inside someone's real browser

The tool makes actions easy. Judgment is still yours.

- **Confirm before irreversible actions.** Purchases, sending messages or email, posting, deleting,
  booking, creating accounts. State what will happen, on which site, with which values, and wait for
  an explicit yes. A $15 inspection charge is still a charge.
- **Dialogs are decisions.** When a result says a `confirm` opened ("Delete everything?"), treat it
  like any irreversible action: tell the human what it says and wait for a yes before `dialog accept`.
- **Upload only files the human named.** Never pick files from their disk on your own, and say which
  file went to which site.
- **Never handle credentials.** Do not ask for passwords, one-time codes, or card numbers, and do not
  type them. Ask the human to complete that step in the tab, then continue.
- **Dismiss consent banners only when they block the task**, and say so in your report. Do not opt
  into marketing or data-sharing on their behalf.
- **Respect the stop signal.** If a tool returns `Stopped by the human`, every action stays refused
  until you call `resume`. Stop, summarize what happened, and ask how to proceed. Call `resume`
  (`./scripts/pointer resume`) only after the human says you may continue; never to get past a stop
  on your own.
- **Clean up.** Close the tabs you opened with `tab_close` (`all: true`) when the task is done (it never
  closes the human's own tabs), unless
  the human wants to keep them. Don't open a fresh tab to retry something that failed; fix the cause.
- **If a result carries the "sent as page events" note,** another extension (often a password
  manager) is blocking Chrome's input driver on that page. Check the change report; if nothing
  happened, ask the human to close that popup instead of retrying.
- **Stay in one tab unless the task needs another.** `tab_open` works in the background and never
  pulls the human away from what they are doing. Raise a tab with `tab_focus` (or `focus: true`)
  only when the human asks to watch. If they
  switch tabs, keep working in the agent's tab and let the title badge show which one it is.
- **Do not hide the pointer or rush the animation.** The human's ability to see the action coming is
  the safety mechanism, not an inconvenience.

## 5. Report what actually happened

After a task, give a short factual wrap-up:

- What you did, in order, with the site and the resulting URL.
- What is on screen now, including any values you entered (never echo secrets).
- Anything left for the human — a password prompt, a final confirm, a banner you dismissed.
- The screenshot path when you took one.

If a step failed, say which step and what the page shows now. Do not claim success from the absence
of an error.

## 6. Troubleshooting

| Symptom | Likely cause | Do this |
|---|---|---|
| `Chrome extension is not connected` | Extension disabled, or hub down | Start the hub (`./scripts/pointer serve`); ask the human to enable the extension |
| `Unknown ref e12` | Stale ref: the page changed, navigated, or you snapshotted again | `snap`, then act on the new ref |
| `Cannot reach this page` | `chrome://`, the Web Store, or a PDF viewer | These are blocked to extensions; ask for a normal http(s) URL |
| `Could not attach input driver` / `Another debugger is already attached` | DevTools is open on that tab | Ask the human to close DevTools for that tab, then retry once |
| `Stopped by the human` | Escape, the shortcut, the popup, or a real click | Stop and ask; `resume` only after they agree |
| `Timed out after 30000ms` | Slow navigation or the tab went away | `snap` to see current state before retrying |
| Badge says **on**, calls fail | Service worker restarted | Retry once; it reconnects in ~30s |

A Chrome banner saying the browser is being debugged is expected while trusted input is attached.
Mention it only if the human asks.

## 7. Known limits

- Refs cover the top frame. Iframes and shadow roots are not traversed; use `read_text` or ask.
- Extension pages, `chrome://` URLs, and the Chrome Web Store cannot be driven.
- One agent connection at a time. If another session is driving, coordinate rather than reconnect.
- No `eval` tool, by design: arbitrary JS in a logged-in tab turns a small mistake into an incident.
- The pointer is always on. That is the feature.

## 8. Worked example

Task: "Try the PAVE signup flow for me and stop before paying."

```bash
./scripts/pointer status                 # connected
./scripts/pointer open paveinspect.com   # background tab in the agent's group
./scripts/pointer snap                   # e3 = clickable "TRY PAVE"
./scripts/pointer click e3               # pointer moves, labels, clicks
./scripts/pointer snap                   # the form is now visible, refs changed
./scripts/pointer fill e6 "demo@example.com"
./scripts/pointer shot /tmp/pave-form.png
```

Then: report that the form is filled and visible, note the $15.00 total, and ask before submitting.
That last pause is the skill working, not the agent stalling.
