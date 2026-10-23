# Security

Pointer lets an agent act in your real, logged-in browser. That is a lot of trust, so this page says
what Pointer protects against, what it cannot protect against, and how to report a problem.

## Reporting a vulnerability

Please report privately through
[GitHub's private vulnerability reporting](https://github.com/longvo2k/pointer/security/advisories/new),
not in a public issue. Include what you found, how to reproduce it, and what an attacker could do with
it. I'll reply as soon as I can and credit you in the fix unless you'd rather not be named.

Only the latest release gets fixes.

## What Pointer defends against

- **Web pages reaching the hub.** The hub listens on `127.0.0.1` only. `/rpc` requires
  `application/json`, a localhost `Host` header, and no `Origin` header, which blocks cross-site
  requests and DNS rebinding. `/ext` accepts only a `chrome-extension://` origin, so a page cannot
  pose as the extension. These rules are covered by tests in [`test/hub.test.mjs`](test/hub.test.mjs).
- **Arbitrary code in your tabs.** There is no `eval` tool and no tool that runs JavaScript you
  supply. CI fails if dynamic code (`eval`, `new Function`) appears in the source.
- **Talking to outside servers.** The code makes no network requests except to `127.0.0.1`. CI fails
  if a non-local URL appears in the source.
- **Acting unseen.** Agent tabs are grouped and badged, the cursor is drawn for every action, and
  `Esc` or a real click in the agent's tab stops it.

## What it cannot defend against

- **The agent itself.** An agent connected to Pointer can do in your browser what you can do: read
  your pages, click, type, submit. Only connect agents you trust, and watch what they do on sites
  that matter.
- **Prompt injection.** A page can contain text written to steer an agent. Pointer shows the page as
  it is; deciding what to trust is the agent's job. The bundled skill tells agents to confirm
  irreversible actions and never handle credentials.
- **Other programs on your computer.** Any program running as your user can reach the hub on
  `127.0.0.1`, just as it can read your browser profile. Pointer does not add a boundary between
  programs that run as you.

## Permissions

The extension asks for these Chrome permissions, and needs each one:

| Permission | Why |
|---|---|
| `debugger` | Sends clicks and keys as real input, captures background tabs, handles dialogs and uploads. |
| `<all_urls>` (host access) | Reads the pages the agent works on and draws the cursor there. |
| `scripting` | Injects the snapshot and cursor script into a tab that loaded before the extension. |
| `tabs`, `tabGroups` | Opens, lists, and groups the agent's tabs. |
| `storage` | Remembers a random id for this browser and when its window was last focused. |
| `alarms` | Reconnects to the hub after Chrome puts the extension to sleep. |
