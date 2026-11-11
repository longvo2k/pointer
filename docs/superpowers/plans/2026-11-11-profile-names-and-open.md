# Profiles by Name, and Opening a Closed Profile: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents see every Chrome profile by name and email, and `browser_use { profile }` switches to it, opening Chrome in that profile first when it is closed.

**Architecture:** A new pure-ish module `lib/profiles.mjs` reads Chrome's `Local State`, finds which profile folder holds a Pointer instance id, matches a human query to a profile, and builds launch commands. The hub records each connection's profile folder on `hello`, serves a new `ext.profiles` RPC, and extends `ext.use` with `profile` (wait for or launch, then pin). `lib/tools.mjs` and the CLI format and call these.

**Tech Stack:** Node.js ESM, `node:test`, `ws`, Chrome MV3 extension.

**Spec:** `docs/superpowers/specs/2026-11-11-profile-names-and-open-design.md`

## Global Constraints

- Google Chrome stable only. User data dir: macOS `~/Library/Application Support/Google/Chrome`, Windows `%LOCALAPPDATA%\Google\Chrome\User Data`, Linux `~/.config/google-chrome`. `POINTER_CHROME_DIR` overrides.
- Profiles come from `Local State` → `profile.info_cache` (`name`, `user_name` = email, may be empty). Running = folder listed in `profile.last_active_profiles`.
- Never open a tab or window to identify a profile. Never launch Chrome into a profile Chrome is running.
- Launch with `spawn(command, args, { shell: false, detached: true, stdio: "ignore" })`; the folder comes only from `Local State` keys.
- macOS: `open -g -na "Google Chrome" --args --profile-directory=<folder>`. Linux: `google-chrome --profile-directory=<folder>`. Windows: `chrome.exe --profile-directory=<folder>` from standard install paths.
- Waits: launched profile 20 s; running-but-not-connected profile 35 s. On timeout the pin stays where it was.
- Chrome Web Store id: `jckadbekhgkcnjkjcoaecjjkpkkgamjl` (`STORE_EXTENSION_ID` in `lib/hub.mjs`).
- The profile is the unit: two connections in one profile are listed once; `profile` picks the latest `hello`.
- Switch only when the human asks: tool descriptions keep saying so.
- Copy (verbatim from spec):
  - "Opened <name> and switched to it."
  - "Opened <name>, but Pointer did not connect within 20 s. Ask the human to check that Pointer is turned on in that profile."
  - "<name> is open in Chrome, but Pointer isn't connected there. Ask the human to check that Pointer is turned on in that profile."
  - "Pointer isn't installed in <name>. Ask the human to add it there first."
- If `Local State` is missing or unreadable, `ext.list`, `ext.use { id }`, and `browsers_list` behave as today plus one line saying why names are missing.

## Review Focus

1. Two `browser_use` calls for the same closed profile at once: Chrome is launched once, both calls resolve to the same pin. (Task 3 test "concurrent opens launch once")
2. `last_active_profiles` lists a profile after Chrome crashed: the hub waits 35 s, never launches, and explains. (Task 3 test "a running profile is never launched")
3. Instance id found in two profile folders (a copied profile): connection shows as unknown profile, still usable by id. (Task 1 test "an id in two folders matches neither")
4. Empty or whitespace `profile`, or a name that is a prefix of two profiles: error listing the candidates, no launch. (Task 1 test "ambiguous and empty queries")
5. Profile names with non-ASCII characters and quotes ("Café 'Work'"): listed, matched case-insensitively, passed to `spawn` as one argument. (Task 1 tests "matches names case-insensitively" and "launch arguments")

---

### Task 1: `lib/profiles.mjs` (read, identify, match, launch args)

**Files:**
- Create: `lib/profiles.mjs`
- Test: `test/profiles.test.mjs` (fixtures built in `os.tmpdir()` with `fs.mkdtempSync`)

**Interfaces:**
- Produces:
  - `chromeUserDataDir({ platform = process.platform, env = process.env, home = os.homedir() } = {}) -> string`
  - `readProfiles(userDataDir) -> { profiles: Array<{ dir, name, email, running }>, error: string|null }`. `error` is a one-line reason when `Local State` is missing or not JSON; `profiles` is then `[]`.
  - `profileOfInstance(userDataDir, dirs: string[], extensionIds: string[], instanceId: string) -> string|null`. Scans `<dir>/Local Extension Settings/<extId>/` files ending `.log` or `.ldb` for the instance id bytes. Exactly one matching folder → that folder; else `null`.
  - `hasPointer(userDataDir, dir, extensionIds: string[]) -> boolean` (folder `Local Extension Settings/<extId>` exists for any id).
  - `matchProfile(query: string, entries: Array<{ dir, name, email }>) -> { match } | { error, candidates: Array<entry> }`. Case-insensitive, trimmed. Order: exact name, exact email, exact dir, then unique prefix of any of the three. Empty query → error.
  - `launchCommand(dir, { platform = process.platform, env = process.env, exists = fs.existsSync } = {}) -> { command: string, args: string[] }`. Throws "Google Chrome was not found" on Windows when no path exists.
  - `launchChrome(dir) -> void` (spawns `launchCommand`, `shell: false`, `detached: true`, `stdio: "ignore"`, `unref()`).

- [ ] **Step 1: Write failing tests** in `test/profiles.test.mjs`:
  - "user data dir per OS": darwin/home `/Users/a` → `/Users/a/Library/Application Support/Google/Chrome`; linux → `/home/a/.config/google-chrome`; win32 with `LOCALAPPDATA=C:\\L` → `C:\\L\\Google\\Chrome\\User Data`; `POINTER_CHROME_DIR=/x` wins on all.
  - "reads names, emails and which are running": fixture `Local State` with `Default` (name "Work", user_name "w@co.com"), `Profile 4` (name "Café 'Work'", user_name ""), `last_active_profiles: ["Default"]` → `[{dir:"Default",name:"Work",email:"w@co.com",running:true},{dir:"Profile 4",name:"Café 'Work'",email:"",running:false}]`.
  - "missing or broken Local State": no file → `profiles: []`, `error` matches `/Local State/`; file `"{"` → same.
  - "finds the profile that holds an instance id": write `abc-123` inside bytes of `Default/Local Extension Settings/<id>/000003.log` → `"Default"`; id absent everywhere → `null`.
  - "an id in two folders matches neither": same id in `Default` and `Profile 4` → `null`.
  - "hasPointer": folder present → `true`; absent → `false`.
  - "matches names case-insensitively": `"work"` → `Default`; `"w@co.com"` → `Default`; `"profile 4"` → `Profile 4`; `"café"` → `Profile 4`.
  - "ambiguous and empty queries": entries "Work" and "Workshop", query `"wor"` → `error` and both in `candidates`; exact `"work"` → `Work`; `"  "` → error.
  - "launch arguments": darwin `Profile 4` → `{ command: "open", args: ["-g","-na","Google Chrome","--args","--profile-directory=Profile 4"] }`; linux → `{ command: "google-chrome", args: ["--profile-directory=Profile 4"] }`; win32 with `exists` true for `%PROGRAMFILES%\Google\Chrome\Application\chrome.exe` → that command; win32 with nothing existing throws `/not found/`.

- [ ] **Step 2: Run** `node --test test/profiles.test.mjs` → FAIL (module not found).
- [ ] **Step 3: Implement `lib/profiles.mjs`** with the signatures above. Windows lookup order: `%PROGRAMFILES%`, `%PROGRAMFILES(X86)%`, `%LOCALAPPDATA%`, each + `\Google\Chrome\Application\chrome.exe`. Read files with `fs.readFileSync` and search with `Buffer.includes`.
- [ ] **Step 4: Run** `node --test test/profiles.test.mjs` → PASS.
- [ ] **Step 5: Commit** `git add lib/profiles.mjs test/profiles.test.mjs && git commit -m "feat: read and match Chrome profiles"`

### Task 2: Hub knows each connection's profile; `ext.profiles`; extension sends its id

**Files:**
- Modify: `lib/hub.mjs` (constructor, `hello` handler, `listExtensions`, `handleHttp` RPC routing)
- Modify: `extension/background.js` (`hello` payload, ~line 181)
- Test: `test/hub-profiles.test.mjs` (own port and own `Hub`, same fake-browser pattern as `test/hub.test.mjs`)

**Interfaces:**
- Consumes: Task 1 `readProfiles`, `profileOfInstance`, `hasPointer`, `chromeUserDataDir`, `launchChrome`.
- Produces:
  - `new Hub({ ..., chromeDir = chromeUserDataDir(), launch = launchChrome, launchWaitMs = 20000, runningWaitMs = 35000 })`
  - Connection entry gains `extensionId`, `profileDir` (string|null), `helloAt` (ms).
  - `listExtensions()` entries gain `profileDir`.
  - `hub.listProfiles({ tabs }) -> Promise<{ profiles: Array<{ dir, name, email, running, installed, connections: string[] }>, unknown: Array<listExtensions entry>, browsers: Array<listExtensions entry (+ tab preview when tabs)>, error: string|null }>`. `connections` are connection ids in that profile, latest `hello` first; `installed` = `hasPointer` with the store id, the allowlisted ids, and every `extensionId` seen in a `hello`.
  - RPC `ext.profiles` `{ tabs?: boolean }` → `listProfiles`.
  - Extension `hello` gains `extensionId: chrome.runtime.id`.

- [ ] **Step 1: Write failing tests** in `test/hub-profiles.test.mjs` (fixture user data dir with `Local State` for `Default` "Work", `Profile 4` "Personal", `Profile 5` "Client X"; `Default` and `Profile 5` have `Local Extension Settings/<"a"*32>`; the fake browser writes its instance id into its profile's `000003.log` before saying `hello`, and sends `extensionId: "a".repeat(32)`):
  - "a connection is matched to its Chrome profile": browser in `Default` → `ext.profiles` shows Work with one connection; Personal has none and `installed: false`; Client X `installed: true`, none.
  - "a connection whose id is in no profile is listed as unknown": instance id written nowhere → appears in `unknown`, not in any profile.
  - "two builds in one profile are listed once, latest first": two browsers both writing ids into `Default` → Work has 2 connections, the later `hello` first.
  - "no Local State: ext.profiles says why and ext.list is unchanged": hub with `chromeDir` pointing at an empty dir → `error` matches `/Local State/`; `ext.list` returns the same fields as today plus `profileDir: null`.
- [ ] **Step 2: Run** `node --test test/hub-profiles.test.mjs` → FAIL.
- [ ] **Step 3: Implement** in `lib/hub.mjs`: on `hello` set `extensionId`, `helloAt = Date.now()`, and `profileDir = profileOfInstance(chromeDir, <all profile dirs>, [extensionId], instanceId)` (wrap in try/catch → `null`); add `listProfiles` and the `ext.profiles` route next to `ext.list`. In `extension/background.js` add `extensionId: chrome.runtime.id` to the `hello` object.
- [ ] **Step 4: Run** `node --test test/hub-profiles.test.mjs test/hub.test.mjs` → PASS (existing hub tests unchanged).
- [ ] **Step 5: Commit** `git commit -am "feat: hub matches each browser to its Chrome profile"` (add the new test file first).

### Task 3: `ext.use { profile }`: pin, wait, or launch

**Files:**
- Modify: `lib/hub.mjs` (`ext.use` route; new `useProfile`)
- Test: `test/hub-profiles.test.mjs`

**Interfaces:**
- Consumes: Task 1 `matchProfile`; Task 2 `listProfiles`, constructor `launch`, `launchWaitMs`, `runningWaitMs`.
- Produces: `hub.useProfile(query: string) -> Promise<{ active: string, pinned: true, profile: { dir, name, email }, opened: boolean }>`; RPC `ext.use` accepts `{ profile }` (and still `{ id }`). When `matchProfile` finds no profile, `useProfile` falls back to today's connection-id prefix match, so `pointer use <id>` keeps working. Errors are thrown with the spec copy; their message carries the candidate names when ambiguous.

- [ ] **Step 1: Write failing tests** (fake `launch` records its argument and, in some tests, starts a fake browser for that profile after 100 ms; `launchWaitMs: 400`, `runningWaitMs: 400`):
  - "pins an open profile by name, email or prefix": `{ profile: "work" }`, `{ profile: "w@co.com" }`, `{ profile: "Wo" }` → pinned to the Work connection, `opened: false`, `launch` never called.
  - "opens a closed profile and switches to it": `{ profile: "Client X" }` → `launch` called once with `"Profile 5"`; result `opened: true`, pinned to the new connection.
  - "concurrent opens launch once": two `useProfile("Client X")` at once → `launch` called once; both resolve to the same `active`.
  - "a closed profile without Pointer is not opened": `{ profile: "Personal" }` → rejects `/Pointer isn't installed in Personal. Ask the human to add it there first./`; `launch` not called.
  - "a launch that never connects": launcher does nothing → rejects `/Opened Client X, but Pointer did not connect within 20 s/`; the pin and active browser are unchanged.
  - "a running profile is never launched": `last_active_profiles` includes `Profile 5`, no browser connects → rejects `/Client X is open in Chrome, but Pointer isn't connected there/`; `launch` not called. Same fixture, browser connects after 100 ms → resolves `opened: false`.
  - "ambiguous names list the choices": add profile "Workshop", `{ profile: "wor" }` → rejects with both "Work" and "Workshop" in the message.
- [ ] **Step 2: Run** `node --test test/hub-profiles.test.mjs` → FAIL.
- [ ] **Step 3: Implement `useProfile`.** Keep one in-flight promise per profile folder (`this.opening: Map<dir, Promise>`) so concurrent calls share a launch. Waiting: resolve when a `hello` arrives whose `profileDir` is the target folder (a small waiter list checked in the `hello` handler), or reject on the timeout. Pin with the existing pin code and `announceRoles()`. The error message text in the spec uses "20 s" literally even when `launchWaitMs` is shorter in tests.
- [ ] **Step 4: Run** `node --test test/hub-profiles.test.mjs test/hub.test.mjs` → PASS.
- [ ] **Step 5: Commit** `git commit -am "feat: switch to a profile by name, opening it when closed"`

### Task 4: MCP tools and CLI

**Files:**
- Modify: `lib/tools.mjs` (`TOOLS` entries `browsers_list`, `browser_use`; `callTool` cases `browser_status`, `browsers_list`, `browser_use`; new `formatProfiles`)
- Modify: `bin/pointer.mjs` (`browsers` and `use` commands; usage text line `pointer use <name|email|folder|id>`)
- Test: `test/tools.test.mjs` (extend `pickingHub` to answer `ext.profiles` and `ext.use { profile }`)

**Interfaces:**
- Consumes: RPC `ext.profiles` (Task 2), `ext.use { profile }` (Task 3).
- Produces: `formatProfiles(result, now = Date.now()) -> string`, exported. Keeps `formatBrowsers` for the no-`Local State` fallback.

- [ ] **Step 1: Write failing tests:**
  - "browsers_list names every profile": result with Work (open, active, pinned, 2 tabs), Personal (open), Client X (closed, installed), Old test (closed, not installed), one unknown connection → text has, in this order, lines matching `/→ Work\s+w@co\.com\s+open · active · pinned/`, `/Personal .*open/`, `/Client X .*closed · Pointer installed/`, `/Old test .*closed · Pointer not installed/`, `/\(unknown\)\s+[0-9a-f]{8}\s+open · profile not found/`; a running profile with no connection shows `open · Pointer not connected`; a profile with 2 connections shows `2 Pointer builds connected`; ends with `browser_use { profile: "…" }`.
  - "browsers_list without Local State falls back": result with `error` → today's `formatBrowsers` text plus the error line.
  - "browser_use takes a profile": `{ profile: "Client X" }` with hub answer `opened: true` → text starts `Opened Client X and switched to it.`; `opened: false` → `/Switched to Client X/`; `{}` → rejects `/Pass profile/`.
  - "browser_status names the profile": `/Driving: Work \(w@co\.com\)/`.
  - Existing "browser_use says to switch only when the human asks…" still passes; also assert the `browser_use` description mentions that a closed profile is opened.
- [ ] **Step 2: Run** `node --test test/tools.test.mjs` → FAIL.
- [ ] **Step 3: Implement.** `browser_use` schema: properties `profile` (name, email, folder, or `"auto"`) and `id` (kept), neither required; with neither → error "Pass profile: a profile name or email from browsers_list, or \"auto\"." `profile: "auto"` → `ext.use { id: "auto" }`. Description adds: "If that profile is closed, Pointer opens it in Chrome first." CLI `browsers` prints `(await tool("browsers_list")).text`; `use <arg>` calls `tool("browser_use", arg === "auto" ? { profile: "auto" } : { profile: arg })`.
- [ ] **Step 4: Run** `npm test && npm run check` → all pass.
- [ ] **Step 5: Commit** `git commit -am "feat: browsers_list and browser_use speak profile names"`

### Task 5: Docs and runtime check

**Files:**
- Modify: `README.md` (multi-profile section: profile names, `browser_use { profile }`, auto-open), `PRIVACY.md` (profile names and emails are shown to agents; read from local Chrome files; nothing leaves the computer)
- Modify: `docs/superpowers/specs/2026-11-11-profile-names-and-open-design.md` (fill the verification ledger)

- [ ] **Step 1: Update README and PRIVACY** with the points above, in the files' existing voice.
- [ ] **Step 2: Runtime check on a real Mac** (isolated hub port, e.g. `POINTER_PORT=8799`, unpacked build loaded in 2 profiles): run `bin/mcp.mjs` over stdio; `browsers_list` shows real names and emails; quit one profile's windows; `browser_use { profile: "<that name>" }` opens it and the next `tabs_list` answers from it; ask for a profile without Pointer → refused, no window. Save the outputs as evidence.
- [ ] **Step 3: Fill the ledger** rows AC1–AC10, AC5b, AC5c with test names and runtime evidence.
- [ ] **Step 4: Run** `npm test && npm run check` → all pass; record counts.
- [ ] **Step 5: Commit** `git commit -am "docs: profile names, auto-open, and privacy note"`
