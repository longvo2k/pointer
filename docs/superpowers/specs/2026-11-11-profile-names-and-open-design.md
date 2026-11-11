# Profiles by name, and opening a closed profile

Date: 2026-11-11 · Status: approved 2026-11-11 · Follows: 2026-11-05-mcp-browser-picking-design.md

## Why

People use several Chrome profiles (work, personal, a client). When they tell an agent "check my
browsers" or "do this in my work profile", the agent cannot tell which profile is which:

- `browsers_list` shows each connected profile as a random id (`3f9a1c2e`) and its first 3 tabs. No
  profile name, no email. The agent guesses from the tabs.
- A profile with no window open is not connected, so the agent does not know it exists and cannot
  open it.

## Goals

1. The agent sees every Chrome profile on this computer by the name the human gave it in Chrome,
   with its Google account email, whether it is open, and whether Pointer is installed in it.
2. When the human asks for a profile that is not open, the agent opens it with no extra step
   (decided: open automatically, do not ask first), waits for Pointer to connect there, and
   switches to it.
3. The human and the agent can name a profile the way people do: "Work", the email, or part of
   either.

## Non-goals

- Chrome Beta, Canary, Dev, Chromium, Edge, Brave. Google Chrome (stable) only for now.
- Creating profiles, signing in, or installing Pointer into a profile.
- Switching without the human asking. The rule from 2026-11-05 stays: an agent switches profile only
  when the human asks.

## Anti-goals (a failure even if it works)

- Opening tabs or windows in a profile just to find out which one it is. That pulls the human away
  from what they are doing, which Pointer promises not to do.
- Running a shell with text from a file or an agent. Profile folders are passed as one argument
  to `spawn`, never through a shell.
- Showing any profile data other than name, email and folder (no history, no cookies, no other
  extensions).

## Approaches considered

- **A. Read Chrome's own profile list, match by Pointer's stored id, open with
  `--profile-directory` (chosen).** No new permission, no setup, covers closed profiles. Costs the
  most work and needs a path per OS.
- B. The human names each profile in Pointer's popup. Simple, but only covers open profiles and needs
  setup per profile.
- C. Read the signed-in email with Chrome's identity permission. A new permission prompt, signed-in
  profiles only, and still cannot open a closed profile.

The human picked A.

## How it works

### 1. The profile list (hub, new `lib/profiles.mjs`)

Chrome keeps every profile in `<user data dir>/Local State`, JSON, under `profile.info_cache`:
the folder (`Default`, `Profile 4`) maps to `name` (what the human called it), `user_name` (email,
may be empty) and `gaia_name`. Checked on the author's Mac: 7 profiles, all with name and email.

User data dir, Google Chrome stable:

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Google/Chrome` |
| Windows | `%LOCALAPPDATA%\Google\Chrome\User Data` |
| Linux | `~/.config/google-chrome` |

`POINTER_CHROME_DIR` overrides it (tests, unusual installs). The file is read fresh on every
`browsers_list` and `browser_use`; it is small. If it is missing or unreadable, everything falls back
to today's behaviour (ids and tabs) and `browsers_list` says why in one line.

### 2. Which open profile is which

Pointer already saves a random `pointerInstanceId` in `chrome.storage.local` and sends it in
`hello`. Chrome stores that value in plain text in
`<profile folder>/Local Extension Settings/<extension id>/` (LevelDB `.log`, later `.ldb`). Checked on
the author's Mac: the key is found in exactly the 3 profiles that have Pointer.

- `hello` gains `extensionId: chrome.runtime.id`, so the hub looks only in Pointer's own folder
  (the store build and an unpacked dev build have different ids).
- On each `hello`, the hub scans that folder in every profile for the instance id and records the
  profile folder on the connection. A match in more than one profile (a copied profile) or none
  leaves it "unknown profile"; the connection still works as today.
- "Pointer installed" for a closed profile = the profile has a `Local Extension Settings/<id>`
  folder for any extension id Pointer has reported, or for the Chrome Web Store id
  `jckadbekhgkcnjkjcoaecjjkpkkgamjl`.

**The profile is the unit, not the connection** (builder-check finding; author's call). One profile
can have two Pointer connections, for example the store build and an unpacked dev build both turned
on. `browsers_list` shows the profile once ("2 Pointer builds connected"), it counts as one open
profile, and `browser_use { profile }` picks the connection that said `hello` most recently, the
same rule the hub already uses for duplicate connections. `browser_use { id }` still picks an exact
connection. When the hub opens a profile, the first `hello` from any build in it counts.

The scan reads files only, never writes, and reads at most the few files in one extension's folder
per profile.

### 3. `browsers_list` shows every profile

```
7 Chrome profiles, 2 open with Pointer. Mode: pinned to Work.

→ Work            you@company.com      open · active · pinned · 12 tabs, e.g. …
  Personal        you@gmail.com        open · 4 tabs, e.g. …
  Client X        x@client.com         closed · Pointer installed
  Old test                             closed · Pointer not installed
  (unknown)       3f9a1c2e             open · profile not found in Chrome's list

browser_use { profile: "Client X" } switches, and opens it first if it is closed.
```

Order: open, then closed with Pointer, then closed without. The tab preview stays as today.
`browser_status` names the active profile ("Driving: Work (you@company.com)").

### 4. `browser_use` takes a profile and opens it if needed

`browser_use { profile }` (new field) or `{ id }` (kept). `profile` matches, case-insensitive, in this
order: exact name, exact email, exact folder, then a unique prefix of any of them. More than one
match → error listing them. `"auto"` still means follow focus.

If the profile is open: pin to it, as today.

**Open in Chrome, but Pointer not connected yet** (builder-check finding). Right after the hub starts,
a profile that is already running can take up to ~30 s to reconnect (retry backoff, then the 30 s
keepalive alarm). Launching Chrome into it would open a second window in front of the human. So
(author's call): if `Local State` lists the profile in `profile.last_active_profiles` (Chrome is
running it), the hub never launches. It waits up to 35 s for that profile's `hello`, then pins. If
none arrives: "Client X is open in Chrome, but Pointer isn't connected there. Ask the human to check
that Pointer is turned on in that profile." `browsers_list` shows this state as
`open · Pointer not connected`.

If it is closed (not running) and Pointer is installed: the hub starts Chrome in that profile, waits up to 20 s
for a `hello` whose instance id maps to that folder, then pins to it. The result says "Opened Client
X and switched to it." On timeout: "Opened Client X, but Pointer did not connect within 20 s. Ask the
human to check that Pointer is turned on in that profile."

If it is closed and Pointer is not installed: do not open. Error: "Pointer isn't installed in Old
test. Ask the human to add it there first."

Launch commands (arguments as an array, no shell; the folder comes only from `Local State` keys):

| OS | Command |
|---|---|
| macOS | `open -g -na "Google Chrome" --args --profile-directory=<folder>` (`-g`: try not to take focus) |
| Windows | `<Chrome path>\chrome.exe --profile-directory=<folder>`, Chrome path from the standard install locations |
| Linux | `google-chrome --profile-directory=<folder>` |

A new Chrome window for a closed profile may still come to the front; Chrome decides. This is
accepted: the human asked for that profile.

The launcher is injected into the hub, so tests never start Chrome.

### 5. CLI

`pointer browsers` prints the same list. `pointer use <name|email|folder|id>` opens a closed profile
too. No new commands.

### 6. Privacy

Profile names and emails now appear in what agents read. `README.md` and `PRIVACY.md` say so. Nothing
leaves the computer: the hub reads local files and talks only to 127.0.0.1, as before.

## Acceptance criteria and verification ledger

| # | Acceptance criterion | Verification method | Status | Evidence |
|---|---|---|---|---|
| AC1 | `browsers_list` lists every profile in `Local State` with name, email, open/closed and Pointer installed or not | Unit test with a fixture `Local State` and fake profile folders + runtime check on a real Mac | VERIFIED | profiles.test "reads names, emails and which are running"; hub-profiles "a connection is matched to its Chrome profile"; real files on this Mac (isolated port 8799): all 7 profiles listed with name, email, open/closed, installed (`.superpowers/e2e-real-files.txt`) |
| AC2 | An open profile is matched to its Chrome name through Pointer's stored id, with no tab or window opened | Unit test (fixture LevelDB log with the id) + runtime check with 2 real profiles | VERIFIED | profiles.test "finds the profile that holds an instance id"; real files: the real Default instance id (store build 0.2.26, no extensionId) matched to Default; no tab or window opened |
| AC3 | `browser_use { profile: "Work" }` pins to an open profile by name, email, folder or unique prefix; ambiguous or unknown names give an error listing the choices | Integration test (hub + fake browsers + tool layer) | VERIFIED | hub-profiles "pins an open profile by name, email or prefix", "ambiguous names list the choices", "a name shared by two profiles picks the one with Pointer", "a name still shared after that lists email and folder"; real files: `browser_use Long` → Default |
| AC4 | `browser_use` on a closed profile with Pointer installed starts Chrome in it, waits for its `hello`, and pins to it; the result says so | Integration test with a fake launcher + runtime check opening a real closed profile | VERIFIED | hub-profiles "opens a closed profile and switches to it", "concurrent opens launch once"; real: `launchChrome("Profile 4")` opened Kai and its Pointer connected to the running hub after 3 s (browsers 1 → 2). The full switch through the new hub on port 8790 was not run: stopping the running hub was blocked |
| AC5 | Closed profile without Pointer: not opened, clear error | Integration test | VERIFIED | hub-profiles "a closed profile without Pointer is not opened"; real files: `browser_use Vo` refused |
| AC5b | A profile Chrome is running but Pointer hasn't reconnected to: never launched again; the hub waits for its `hello`, or explains after 35 s | Integration test (fixture `last_active_profiles`, fake launcher asserts no call) | VERIFIED | hub-profiles "a running profile is never launched", "a profile seen connected earlier is waited for, not opened again" |
| AC5c | A profile with two Pointer builds connected is listed once and `browser_use { profile }` picks the latest `hello` | Integration test | VERIFIED | hub-profiles "two builds in one profile are listed once, latest first" |
| AC6 | Pointer does not connect within 20 s: clear error, the pin stays where it was | Integration test with a fake launcher that never connects | VERIFIED | hub-profiles "a launch that never connects" (pin and active unchanged) |
| AC7 | `Local State` missing or broken: `browsers_list` and `browser_use { id }` work as today and say why names are missing | Unit test | VERIFIED | profiles.test "missing or broken Local State"; hub-profiles "no Local State…"; tools.test "browsers_list without Local State falls back" |
| AC8 | The launcher never uses a shell; the profile folder comes only from `Local State` | Unit test on the launch arguments + review | VERIFIED | profiles.test "launch arguments"; review: `spawn(..., { shell: false })`, folder only from Local State keys via matchProfile |
| AC9 | The switch rule stands: tool descriptions still say to switch only when the human asks | Test on tool descriptions | VERIFIED | tools.test "browser_use says to switch only when the human asks…" |
| AC10 | Existing CLI, MCP tools and the full suite still pass | `npm test`, `npm run check` | VERIFIED | `npm test` 180/180, `npm run check` clean |

## Left to the builder

- Exact wording of tool output and errors, within the examples above.
- How `lib/profiles.mjs` splits reading `Local State`, scanning folders and launching.
- Windows Chrome path lookup order.
