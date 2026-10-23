<img src="extension/icons/icon128.png" width="96" height="96" alt="" align="right">

# Pointer

[![CI](https://github.com/longvo2k/pointer/actions/workflows/ci.yml/badge.svg)](https://github.com/longvo2k/pointer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![No telemetry](https://img.shields.io/badge/telemetry-none-brightgreen.svg)
![Runtime deps: 1](https://img.shields.io/badge/runtime%20deps-1-brightgreen.svg)

Let any agent drive your real Chrome tab, with a pointer you can watch.

![An agent drives a real Chrome tab from the CLI: it checks the connection, opens a page, picks the Scale plan, types a work email, creates the workspace, and copies the invite link, with Pointer's cursor and action labels visible](https://github.com/user-attachments/assets/d8feced1-c207-49d5-ad37-394b98d47b14)

<sub>Left: the CLI. Right: the page, with Pointer's cursor and action labels drawn by the extension.</sub>

An agent often needs a page that is already open in your browser, with your session. A second
profile means another login, and a headless browser cannot reach the page at all. Pointer uses a
local hub and a Chrome extension to act in your own Chrome, and draws each move on screen.

- **Any agent.** One MCP server for Claude Code, Cursor, OpenCode, and Codex, plus a plain CLI for
  shell agents.
- **You can watch.** Before a click lands, the cursor slides to the target with a label
  (`click · Sign Up`) and a ripple. Agent tabs sit in a tab group named after the agent.
- **You stay where you are.** The agent works in background tabs and never pulls you away from your
  tab, window, or profile. With several Chrome profiles, a new task starts in the one you are using.
- **You can stop it.** `Esc` or a real click in the agent's tab stops it, and the next tool call
  tells it to ask before going on.
- **Real input.** Clicks and keys go through `chrome.debugger`, so React handlers and pointer checks
  behave as they do for a person.
- **Small token bill.** Snapshots list what is on screen, and every action reports only what changed.
  A six-step Wikipedia task used about 2,400 tokens of tool output.

## Examples

Each clip is a real run: OpenCode with a DeepSeek model drives Pointer in Chrome, and the left pane
shows its tool calls and the summary it wrote at the end. Quiet stretches while the model thinks are
shortened.

**Test a flow.** *"Test the signup flow — pick the Scale plan, use ada@example.com and team Lovelace
Labs, create the workspace, and check the invite link is shown. Report pass/fail per step."*

![OpenCode tests a signup flow with Pointer: picks a plan, fills the form, creates the workspace, and reports pass or fail for each step](https://github.com/user-attachments/assets/4033e3a7-6afb-40f6-b13d-bb74a2a9d435)

**Debug a broken page.** *"Users say the Reports page stays empty after clicking Load reports. Find
the root cause from the console and network."*

![OpenCode debugs an empty Reports page with Pointer: clicks Load reports, reads the console and network, and finds a 500 from the API plus missing error handling](https://github.com/user-attachments/assets/b23db6a5-e85f-4adf-bf2e-6bff89c2f2f8)

**Research and summarize.** *"On Wikipedia, search for Model Context Protocol, open the article, and
give me a 3-bullet summary."*

![OpenCode researches the Model Context Protocol on Wikipedia with Pointer: searches, opens the article, and writes a three-bullet summary](https://github.com/user-attachments/assets/83338eb9-762a-496e-a6e9-c126ce573ffd)

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/longvo2k/pointer/main/install.sh | bash
```

This installs the latest release into `~/.pointer`, installs its one dependency, links `pointer`
and `pointer-mcp` into `~/.local/bin`, and opens `chrome://extensions` with the extension folder
revealed. It asks before adding `~/.local/bin` to your shell's `PATH`. Run it again to update. Set
`POINTER_DIR` to install elsewhere, `POINTER_REF` to pick a version, or `POINTER_NO_OPEN=1` to skip
opening Chrome.

Prefer to read it first? The installer is about 100 lines:

```bash
curl -fsSL https://raw.githubusercontent.com/longvo2k/pointer/main/install.sh -o install.sh
less install.sh
bash install.sh
```

Then load the extension once (Chrome does not let a script install an unpacked extension):

1. `chrome://extensions` → turn on **Developer mode** → **Load unpacked**
2. choose `~/.pointer/extension`

The toolbar badge reads `on` once it connects. Check it:

```bash
pointer status
pointer open news.ycombinator.com
pointer snap
```

`pointer setup` reopens the extension page, copies the folder path, and prints an MCP config with
your real paths.

<details>
<summary>Uninstall</summary>

1. `chrome://extensions` → Pointer → **Remove**
2. `pkill -f "pointer.mjs serve"` to stop the hub
3. `rm -rf ~/.pointer ~/.local/bin/pointer ~/.local/bin/pointer-mcp`
4. Remove the `# Added by Pointer installer` lines from your shell file, if you let it add them.
5. Remove `pointer` from your agent's MCP config (`claude mcp remove pointer` for Claude Code).

</details>

<details>
<summary>From a checkout (development)</summary>

```bash
git clone https://github.com/longvo2k/pointer && cd pointer
npm install
node bin/pointer.mjs setup
```

Use `node bin/pointer.mjs …` wherever this README says `pointer …`.

</details>

## Connect your agent

Claude Code:

```bash
claude mcp add pointer -- node ~/.pointer/bin/mcp.mjs
```

Cursor and most other MCP clients:

```json
{
  "mcpServers": {
    "pointer": { "command": "node", "args": ["/Users/you/.pointer/bin/mcp.mjs"] }
  }
}
```

OpenCode 2.x nests servers under `mcp.servers`, or run
`opencode mcp add pointer -- node ~/.pointer/bin/mcp.mjs`:

```json
{
  "mcp": {
    "servers": {
      "pointer": { "type": "local", "command": ["node", "/Users/you/.pointer/bin/mcp.mjs"] }
    }
  }
}
```

The MCP server starts the hub when it needs it.

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
| Tabs | `browser_status`, `tabs_list`, `tab_open`, `tab_select`, `tab_close`, `tab_focus` |
| Read | `snapshot`, `find`, `read_text`, `screenshot`, `wait_for` |
| Act | `click`, `fill`, `press`, `scroll`, `upload`, `dialog` |
| Debug | `console`, `network` |
| Stop | `stop` |

A few that need explaining:

- `tab_open` opens a background tab. `tab_select` switches the agent's working tab without bringing it
  forward. Only `tab_focus` brings a tab to the front. `tab_close` closes only tabs the agent opened or
  used.
- `find "sign up"` searches the whole page, on screen or not, and returns a few matching refs.
- `dialog` answers an `alert`, `confirm`, or `prompt`. A click that opens one returns right away and
  says so instead of hanging.
- `upload` attaches local files: to a file input, a styled button over a hidden one, or a button that
  opens the file picker itself (the picker is intercepted, so no system dialog appears).
- `console` and `network` read the tab's errors and requests. Capture starts on the first call
  (`reload: true` captures a page load), because turning it on makes the debugger easier for anti-bot
  scripts to notice.

### CLI

```bash
pointer open https://example.com      # background tab; --focus to bring it forward
pointer snap                          # --all for the whole page, --hrefs for link targets
pointer find "sign up"
pointer click e14
pointer fill e9 "hello"
pointer dialog dismiss
pointer upload e4 ~/resume.pdf
pointer console errors --reload
pointer network api --failed
pointer shot out.png
pointer close --all                   # close the agent's tabs
```

Add `--json` to any command for machine-readable output. `pointer help` lists everything.

## Several Chrome profiles

If Pointer is loaded in more than one profile (work and personal, say), a new task starts in the
profile you focused last. A task that is already running stays in its profile even if you switch,
so its tabs and refs keep working. A task counts as new after 2 minutes without agent calls
(`POINTER_FOLLOW_IDLE_MS`).

```bash
pointer browsers         # each profile: build, last focus, which one is active
pointer use 3f9c1a2b     # pin one profile
pointer use auto         # follow the profile you use again
```

## Troubleshooting

**The change is not there after editing the extension.** Chrome can keep running an old copy of an
unpacked extension even after Reload: the card shows the new version while the old code runs.
`pointer browsers` flags this as `⚠ stale`. Click **Remove** on `chrome://extensions`, then **Load
unpacked** again. On Chrome 137+ a reloaded unpacked extension can also be disabled as an
"unsupported developer extension"; loading it again fixes that too.

**Hub changes are not picked up.** The hub reloads when it restarts. Stop it with
`pkill -f "pointer.mjs serve"`; the next Pointer command starts the new one.

**"WebSocket connection … ERR_CONNECTION_REFUSED" on the extension's Errors page.** The extension
tried to reach the hub while it was not running. It keeps retrying and connects once any agent or
`pointer` command starts the hub. Chrome groups the repeats into one entry; **Clear all** removes it.

**A result says "sent as page events".** Password managers such as 1Password put their own frame
into some pages, and Chrome then refuses debugger input on that tab. Pointer falls back to page
events for click, fill, and press. Most sites accept them; file upload has no fallback.

**The agent stopped and asks before continuing.** You pressed `Esc` or clicked in the agent's tab
while it was on screen. That is the stop signal, by design. `Esc` in your other tabs does not count.

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
 your tab  ── overlay: pointer, label, ripple, target outline
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

## Security and privacy

Pointer drives your logged-in browser, so it should be easy to check. In short:

- **No outside servers.** The code only talks to `127.0.0.1`. No accounts, analytics, or telemetry.
- **No code execution tool.** There is no `eval` and no tool that runs JavaScript you pass in.
- **Web pages cannot reach it.** The hub refuses cross-site requests, DNS rebinding, and pages
  pretending to be the extension. Tests cover each rule.
- **One runtime dependency** (`ws`), no install scripts, and plain, unminified source you can read.
- **Your agent sees what it reads.** Page text and screenshots go to the agent you connected, and
  from there to its AI model provider. See [PRIVACY.md](PRIVACY.md).

Check it yourself from a checkout:

```bash
grep -rnE "https?://[A-Za-z0-9]" bin lib extension | grep -v 127.0.0.1 | grep -v w3.org/2000/svg  # outside URLs: none
grep -rnE "\beval\(|new Function" bin lib extension                  # dynamic code: none
npm ls --omit=dev --all                                               # dependencies: ws only
```

(`w3.org/2000/svg` is the SVG namespace for the cursor icon, not a request.) CI runs the same checks
plus the test suite on every push. [SECURITY.md](SECURITY.md) explains each
Chrome permission, what Pointer does and does not protect against, and how to report a problem
privately.

### Limits

- Snapshots cover the top frame. They do not reach into iframes or open shadow roots yet.
- One browser is active at a time, and one agent at a time. Several agents sharing tabs is the next
  step.
- Chrome and other Chromium browsers only. Firefox and Safari do not offer `chrome.debugger` to
  extensions.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `POINTER_AGENT` | `agent` | name in status, the tab group, and the title badge (`Claude · Example`) |
| `POINTER_FOLLOW_IDLE_MS` | `120000` | idle time after which a new task follows the Chrome profile you focused last |
| `POINTER_FOCUS_WINDOW` | `1` | also raise the OS window when `tab_focus` or `open --focus` brings a tab forward |
| `POINTER_PORT` | `8790` | hub port. The extension always connects to 8790, so change `DEFAULT_PORT` in `extension/background.js` to match |

## Skill for agents

[`skills/pointer`](skills/pointer) is an Agent Skill for Claude Code, OpenCode, or any harness that
reads `SKILL.md`. It covers when to use Pointer and when to stop: confirm before irreversible
actions, never handle credentials, close your tabs when done, and treat `Esc` or a real click as a
hard stop rather than a retry.

```bash
ln -s "$PWD/skills/pointer" ~/.claude/skills/pointer
```

Start a new session so the skill shows up. The bundled `skills/pointer/scripts/pointer` wrapper
finds the checkout from its own location, so the skill works linked, copied into a project, or run
from the repo.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Run `npm test` before sending a change.

## License

MIT. See [LICENSE](LICENSE).

## Acknowledgements

Pointer was written from scratch. Its approach, a Chrome extension that drives your own tab over
`chrome.debugger` with a pointer you can watch, was inspired by
[ofershap/real-browser-mcp](https://github.com/ofershap/real-browser-mcp). If you want a different
take on the same problem, start there.
