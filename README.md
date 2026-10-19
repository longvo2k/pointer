# Pointer

Drive the human's real Chrome tab from any agent, with a pointer they can watch.

- **Any agent** — one MCP server for Claude Code / Cursor / OpenCode / Codex, plus a plain CLI for shell-first agents.
- **Your browser, your logins** — a Chrome extension drives the tab you already have open. No separate Chromium profile, no re-login, no bot fingerprint.
- **Visible intent** — before a click lands, the cursor slides to the target with a label ("click · Sign Up") and a ripple. You always know what it is doing.
- **Agent tab group** — every tab the agent drives is moved into a Chrome tab group named after the agent (e.g. **Claude**), so agent tabs are obvious at a glance. The tab title carries the same badge.
- **Trusted input** — clicks and keys go through CDP (`chrome.debugger`), not synthetic DOM events, so React handlers and pointer checks behave.
- **Human override** — `Esc` or a real click on the page stops the agent, and the next tool call tells the agent to ask first.
- **No focus stealing** — only `tab_open` and `tab_focus` bring a tab forward. Snapshot, click, fill,
  scroll, read, and screenshot keep working while you are in another tab or window, and the agent's
  tab is marked in its title (e.g. `Claude · PAVE Inspect`) so you can find it at a glance.

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

## Install

One command:

```bash
curl -fsSL https://raw.githubusercontent.com/longvo2k/pointer/main/install.sh | bash
```

It clones into `~/.pointer`, installs dependencies, links `pointer` and `pointer-mcp` into
`~/.local/bin`, and opens `chrome://extensions` with the extension folder revealed. Re-run it any
time to update. Set `POINTER_DIR` to install elsewhere, or `POINTER_NO_OPEN=1` to skip opening Chrome.

Then load the extension once — Chrome does not let a page install an unpacked extension for you:

1. `chrome://extensions` → **Developer mode** → **Load unpacked**
2. choose `~/.pointer/extension`

The toolbar badge shows **on** when it is connected. Check the wiring:

```bash
pointer status
pointer open news.ycombinator.com
pointer snap
```

`pointer setup` reopens the extension page, copies the folder path, and prints an MCP config with
your actual paths.

<details>
<summary>From a checkout (development)</summary>

```bash
git clone https://github.com/longvo2k/pointer && cd pointer
npm install
node bin/pointer.mjs setup
```

Then use `node bin/pointer.mjs …` in place of `pointer …` below.

</details>

### Several Chrome windows, or an updated extension

If more than one Chrome profile has Pointer loaded, the hub keeps the first one it saw and leaves the
others connected but idle. That is deliberate — silently switching browsers would send clicks to a
different session. Check and choose explicitly:

```bash
pointer browsers
pointer use 3f9c1a2b
```

Each line shows a short connection id, the build, and whether it is active.

When you edit the extension, Chrome may keep serving the old copy of an unpacked extension even after
a restart (this is easy to spot: the toolbar works, but the change is not there). Click **Reload** on
`chrome://extensions`, or remove it and **Load unpacked** again. On Chrome 137+ a reloaded unpacked
extension can be disabled as an "unsupported developer extension"; loading a copy from a new folder
gets a fresh id and avoids that. `pointer reload` asks every connected extension to reload itself
(useful once the new build is already running).

## Use from an agent

### MCP (Claude Code, Cursor, OpenCode, …)

```json
{
  "mcpServers": {
    "pointer": {
      "command": "node",
      "args": ["/Users/you/.pointer/bin/mcp.mjs"]
    }
  }
}
```

Run `pointer setup` to print this snippet with your real path, or with Claude Code:

```bash
claude mcp add pointer -- node ~/.pointer/bin/mcp.mjs
```

Tools: `browser_status`, `tabs_list`, `tab_open`, `tab_focus`, `snapshot`, `click`, `fill`, `press`,
`scroll`, `read_text`, `wait_for`, `screenshot`, `stop`.

The intended loop is the cheap one:

```
snapshot  →  click e12  →  snapshot
```

`snapshot` returns compact text with refs (`- button "Try PAVE" [ref=e12]`) instead of a DOM dump.
Refs reset on navigation, so re-snapshot after the page changes.

### CLI (shell agents)

```bash
pointer open https://paveinspect.com/
pointer snap
pointer click e14
pointer fill e9 "hello" --json
pointer shot out.png
pointer browsers
pointer use 3f9c1a2b
```

## What it deliberately does not do

- **No iframes / shadow DOM refs yet.** Snapshot covers the top frame and open shadow roots are not traversed.
- **No focus stealing.** `tab_open` and `tab_focus` bring a tab forward by design. Every other action
  runs in the agent's tab even when you are working elsewhere; the tab title carries the agent badge.
- **No `eval` tool.** Arbitrary JS in a logged-in tab is the fastest way to turn a bug into an incident.
- **One active browser at a time.** If several Chrome profiles run the extension, the hub keeps the
  first one active instead of silently switching; `pointer browsers` lists them and `pointer use <id>`
  chooses another. (Multiple agents sharing tabs is still the next step.)

## Skill for agents

[`skills/pointer`](skills/pointer) is an Agent Skill (Claude Code, OpenCode, any SKILL.md-compatible
harness) that teaches an agent when to use Pointer and, more importantly, when to stop: confirm
before irreversible actions, never handle credentials, and treat Escape or a real click as a hard
stop rather than a retry.

```bash
ln -s "$PWD/skills/pointer" ~/.claude/skills/pointer
```

Start a new session so the skill appears in the agent's skill list. The bundled
`skills/pointer/scripts/pointer` wrapper resolves the checkout from its own location, so the same
skill works linked from a skills directory, copied into a project, or run from the repo.

## Files

```
extension/   manifest, service worker (bridge + trusted input), content script (snapshot + overlay)
lib/hub.mjs  ws/http hub, request routing, stop events
lib/tools.mjs  tool definitions and formatting (shared by MCP + CLI)
bin/pointer.mjs  CLI + hub launcher
bin/mcp.mjs      MCP stdio server
skills/pointer/   agent skill (SKILL.md + wrapper that finds the checkout)
```

## Env

| Variable | Default | Meaning |
|---|---|---|
| `POINTER_PORT` | `8790` | hub port (extension connects here) |
| `POINTER_FOCUS_WINDOW` | `1` | raise the OS window for `tab_open` / `tab_focus` (other actions never steal focus) |
| `POINTER_AGENT` | `agent` | name shown in status and the tab-title badge (`Claude · PAVE Inspect`) |
