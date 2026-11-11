# Installing Pointer

The [README](../README.md#install) has the quick version. This page has every option.

## Set it up by hand

### 1. Add the extension

Get it from the [Chrome Web Store](https://chromewebstore.google.com/detail/pointer/jckadbekhgkcnjkjcoaecjjkpkkgamjl). Chrome keeps it up to date.

### 2. Install the command

With the installer:

```bash
curl -fsSL https://raw.githubusercontent.com/longvo2k/pointer/main/install.sh | POINTER_NO_OPEN=1 bash
```

This installs the latest release into `~/.pointer`, installs its one dependency, and links `pointer`
and `pointer-mcp` into `~/.local/bin`. It asks before adding `~/.local/bin` to your shell's `PATH`.
Run it again to update. Set `POINTER_DIR` to install elsewhere or `POINTER_REF` to pick a version.
(`POINTER_NO_OPEN=1` skips opening `chrome://extensions`, which is only needed for the unpacked copy
below.)

Prefer to read it first? The installer is about 100 lines:

```bash
curl -fsSL https://raw.githubusercontent.com/longvo2k/pointer/main/install.sh -o install.sh
less install.sh
POINTER_NO_OPEN=1 bash install.sh
```

Or install from npm, if you already use Node 18 or newer:

```bash
npm install -g @longvo2k/pointer
```

Each npm release and each Web Store version is built by this repo's
[release workflow](../.github/workflows/release.yml) from the same commit. The npm package carries a
[provenance](https://docs.npmjs.com/generating-provenance-statements) record that links it to that
commit. `npm install -g @longvo2k/pointer` again updates it. A new extension version reaches you
once the Web Store has reviewed it, which can take a day or so after the npm release.

The toolbar badge reads `on` once the extension connects. Check it:

```bash
pointer status
pointer open news.ycombinator.com
pointer snap
```

`pointer setup` prints an MCP config with your real paths.

<details>
<summary>Load the extension unpacked instead</summary>

To run the extension from the files on disk, for example to try a change before it is in the store:

1. `chrome://extensions` → turn on **Developer mode** → **Load unpacked**
2. choose `~/.pointer/extension` (with npm, the folder `pointer setup` prints)

Remove the Web Store copy first, so only one Pointer runs. `pointer setup` opens the extension page
and copies the folder path. An unpacked copy does not update itself: after updating Pointer, reload it
at `chrome://extensions`.

</details>

<details>
<summary>Uninstall</summary>

1. Right-click the Pointer icon in the toolbar → **Remove from Chrome** (or `chrome://extensions` → Pointer → **Remove**)
2. `pkill -f "pointer.mjs serve"` to stop the hub
3. `rm -rf ~/.pointer ~/.local/bin/pointer ~/.local/bin/pointer-mcp`
   (or `npm uninstall -g @longvo2k/pointer` if you installed from npm)
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

Use `node bin/pointer.mjs …` wherever these docs say `pointer …`. Load `extension/` unpacked (see
[Load the extension unpacked](#load-the-extension-unpacked-instead)) to run your changes; remove the Web Store copy first.

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

Installed from npm? Use `pointer-mcp` as the command instead, for example
`claude mcp add pointer -- pointer-mcp`. `pointer setup` prints the config with your real paths.

The MCP server starts the hub when it needs it.

## Skill for agents

[`skills/pointer`](../skills/pointer) is an Agent Skill for Claude Code, OpenCode, or any harness that
reads `SKILL.md`. It covers when to use Pointer and when to stop: confirm before irreversible
actions, never handle credentials, close your tabs when done, and treat `Esc` or a real click as a
hard stop rather than a retry.

```bash
ln -s "$PWD/skills/pointer" ~/.claude/skills/pointer
```

Not using a checkout? Each [GitHub release](https://github.com/longvo2k/pointer/releases) has a
`pointer-skill-<version>.zip`; unzip it into your skills folder. The skill works with Pointer
installed from npm or the installer, and walks the agent through setup if it is missing.

Start a new session so the skill shows up. The bundled `skills/pointer/scripts/pointer` wrapper
finds the checkout from its own location, so the skill works linked, copied into a project, or run
from the repo.

### Pick Pointer for a task: `/pointer`

With several browser tools installed, the agent may reach for another one. Type `/pointer` and the
task to have Pointer do it:

```text
/pointer sign up on example.com with my work email
```

In Claude Code this comes from the skill. Agents that use Pointer through MCP get the same command
as an MCP prompt named `pointer` (Claude Code lists it as `/mcp__pointer__pointer`, VS Code as
`/mcp.pointer.pointer`). A bare `/pointer` checks the connection and asks what to do.
