<img src="extension/icons/icon128.png" width="96" height="96" alt="" align="right">

# Pointer

[![CI](https://github.com/longvo2k/pointer/actions/workflows/ci.yml/badge.svg)](https://github.com/longvo2k/pointer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![No telemetry](https://img.shields.io/badge/telemetry-none-brightgreen.svg)
![Runtime deps: 1](https://img.shields.io/badge/runtime%20deps-1-brightgreen.svg)
[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/jckadbekhgkcnjkjcoaecjjkpkkgamjl?label=chrome%20web%20store)](https://chromewebstore.google.com/detail/pointer/jckadbekhgkcnjkjcoaecjjkpkkgamjl)

Let any agent drive your real Chrome tab, with a pointer you can watch.

![An agent drives a real Chrome tab from the CLI: it checks the connection, opens a page, picks the Scale plan, types a work email, creates the workspace, and copies the invite link, with Pointer's cursor and action labels visible](https://github.com/user-attachments/assets/d8feced1-c207-49d5-ad37-394b98d47b14)

Agents often need a page that is already open in your browser, signed in as you. Pointer lets them
use your own Chrome through a small local hub and an extension, and shows every move on screen.

- **Works with any agent.** One MCP server for Claude Code, Cursor, OpenCode and Codex, plus a CLI.
- **You can watch.** A cursor slides to each target with a label like `click · Sign Up`. Each agent
  gets its own colour and tab group.
- **You stay where you are.** The agent works in background tabs and never steals your focus.
- **You can stop it.** Press `Esc` or `Alt+Shift+S`, click in its tab, or use the Stop button. It
  must ask you before it goes on.
- **Real input.** Clicks and keys go through `chrome.debugger`, so pages react as they would to a person.
- **Few tokens.** Every action reports only what changed on screen. A six-step Wikipedia task used
  about 2,400 tokens of tool output.

## Install

**Easiest: let your agent do it.** Paste this into Claude Code, Codex, Cursor, OpenCode, or any
agent that can run shell commands:

```text
Set up Pointer (https://github.com/longvo2k/pointer) so you can drive my Chrome. Follow its README.

1. Install the command. If Node 18+ is installed, run `npm install -g @longvo2k/pointer`.
   Otherwise read https://raw.githubusercontent.com/longvo2k/pointer/main/install.sh, then run it
   with POINTER_NO_OPEN=1. Ask me before it changes my shell's PATH.
2. Run `pointer setup --no-open` and use the MCP config it prints to add Pointer as an MCP server
   in this agent (for Claude Code: `claude mcp add pointer -- <command and args it prints>`).
3. If this agent reads Agent Skills (SKILL.md), link the `skills/pointer` folder of the install
   into your skills folder (for Claude Code: ~/.claude/skills/pointer).
4. Open https://chromewebstore.google.com/detail/pointer/jckadbekhgkcnjkjcoaecjjkpkkgamjl in my
   Chrome and ask me to click "Add to Chrome". Wait until I say it is done.
5. Run `pointer status` and check it says "Extension: connected". If not, read
   https://github.com/longvo2k/pointer/blob/main/docs/troubleshooting.md and tell me what you need.
6. Tell me what you set up, and whether I need to restart this session to load Pointer's tools.
```

**By hand:**

1. Add the extension from the [Chrome Web Store](https://chromewebstore.google.com/detail/pointer/jckadbekhgkcnjkjcoaecjjkpkkgamjl).
2. Install the command: `npm install -g @longvo2k/pointer` (Node 18+), or
   `curl -fsSL https://raw.githubusercontent.com/longvo2k/pointer/main/install.sh | POINTER_NO_OPEN=1 bash`.
3. Connect your agent. For Claude Code: `claude mcp add pointer -- pointer-mcp`. For other agents,
   run `pointer setup`, which prints the config with your paths.
4. Check it: `pointer status` should say "Extension: connected".

The [install guide](docs/install.md) covers the installer, other MCP clients, the agent skill,
loading the extension unpacked, uninstalling, and working from a checkout.

## How the agent uses it

Look once, then act by ref and read what changed:

```
snapshot  →  click e31  →  fill e40 "ada@example.com"
```

```
clicked button "Code" → https://github.com/microsoft/vscode
changes in view:
+ button "Clone with HTTPS" [ref=e286]
+ link "Download ZIP" [ref=e292]
```

| Job | Tools |
|---|---|
| Browsers | `browser_status`, `browsers_list`, `browser_use` |
| Tabs | `tabs_list`, `tab_open`, `tab_select`, `tab_close`, `tab_focus` |
| Read | `snapshot`, `find`, `read_text`, `screenshot`, `wait_for` |
| Act | `click`, `hover`, `fill`, `press`, `scroll`, `navigate`, `upload`, `dialog` |
| Check | `verify`, `viewport`, `layout`, `console`, `network` |
| Talk to you | `say`, `stop`, `resume` |

The same tools work from the shell: `pointer open example.com`, `pointer snap`, `pointer click e14`.
Run `pointer help` for the list.

With several Chrome profiles, `pointer browsers` lists them by name and email, and
`pointer use Work` switches, opening the profile if it is closed.

The [usage guide](docs/usage.md) covers every tool, the CLI, profiles, what Pointer draws on the
page, the settings (including the Classic and Sketch looks) and environment variables.

## Examples

Real runs: OpenCode with a DeepSeek model drives Pointer in Chrome.

<details>
<summary><b>Test a flow</b>: sign up, pick a plan, check the invite link</summary>

*"Test the signup flow — pick the Scale plan, use ada@example.com and team Lovelace Labs, create the
workspace, and check the invite link is shown. Report pass/fail per step."*

![OpenCode tests a signup flow with Pointer: picks a plan, fills the form, creates the workspace, and reports pass or fail for each step](https://github.com/user-attachments/assets/4033e3a7-6afb-40f6-b13d-bb74a2a9d435)

</details>

<details>
<summary><b>Debug a broken page</b>: find why Reports stays empty</summary>

*"Users say the Reports page stays empty after clicking Load reports. Find the root cause from the
console and network."*

![OpenCode debugs an empty Reports page with Pointer: clicks Load reports, reads the console and network, and finds a 500 from the API plus missing error handling](https://github.com/user-attachments/assets/b23db6a5-e85f-4adf-bf2e-6bff89c2f2f8)

</details>

<details>
<summary><b>Research and summarize</b>: a Wikipedia article in three bullets</summary>

*"On Wikipedia, search for Model Context Protocol, open the article, and give me a 3-bullet summary."*

![OpenCode researches the Model Context Protocol on Wikipedia with Pointer: searches, opens the article, and writes a three-bullet summary](https://github.com/user-attachments/assets/83338eb9-762a-496e-a6e9-c126ce573ffd)

</details>

## Security and privacy

- **No outside servers.** Pointer talks only to `127.0.0.1`. No accounts, analytics or telemetry.
- **No code execution tool.** No `eval`, and no tool runs JavaScript you pass in.
- **Web pages cannot reach it.** The hub refuses cross-site requests, DNS rebinding, and pages
  pretending to be the extension.
- **Blocked sites.** List sites like your bank in the settings, and agents cannot open or read them.
- **One runtime dependency** (`ws`), and plain source you can read.

Page text and screenshots go to the agent you connected, and from there to its AI provider.
See [SECURITY.md](SECURITY.md) and [PRIVACY.md](PRIVACY.md).

<details>
<summary>Check it yourself from a checkout</summary>

```bash
grep -rnE "https?://[A-Za-z0-9]" bin lib extension | grep -v 127.0.0.1 | grep -v w3.org/2000/svg  # outside URLs: none
grep -rnE "\beval\(|new Function" bin lib extension                  # dynamic code: none
npm ls --omit=dev --all                                               # dependencies: ws only
```

`w3.org/2000/svg` is the SVG namespace for the cursor icon, not a request. CI runs the same checks
on every push.

</details>

## Help

Something not working? See [troubleshooting](docs/troubleshooting.md). To contribute, see
[CONTRIBUTING.md](CONTRIBUTING.md) and run `npm test` before sending a change.

## License

MIT. See [LICENSE](LICENSE). The Sketch look ships two fonts under the SIL Open Font License 1.1:
[Caveat](https://github.com/googlefonts/caveat) and Patrick Hand by Patrick Wagesreiter (licences in
`extension/fonts/`).

Pointer was written from scratch. Its approach was inspired by
[ofershap/real-browser-mcp](https://github.com/ofershap/real-browser-mcp).
