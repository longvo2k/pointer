# Verification Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent state what must be true after an action and get "verified" / "NOT verified" back with evidence, via a `verify` tool and `expect` on `click`/`fill`/`press`.

**Architecture:** The MCP layer (`lib/tools.mjs`) validates checks and formats the result. The service worker (`extension/background.js`) runs a poll loop: page checks go to the content script (`pointer:check`), URL and request checks are evaluated in the worker by pure functions in the new `extension/verify.js`. A per-tab "last action" timestamp scopes request checks.

**Tech Stack:** Node ESM, `node --test`, Chrome MV3 service worker (ES module), classic content script, Chrome DevTools Protocol via `chrome.debugger`.

**Spec:** `docs/superpowers/specs/2026-11-05-verification-engine-design.md`

## Global Constraints

- Poll every 150 ms; `timeout` default 5000, allowed 0-30000.
- `status` 100-599, only with `request`; default pass is any 2xx.
- Text matching ignores case and collapses whitespace; evidence lines cut to 120 chars.
- Request failure body: first 200 chars, text bodies only, never for 2xx.
- Up to 3 page messages on failure, each cut to 120 chars.
- Password field values are shown as `••••`.
- Network capture starts only when a check has `request`. Pointer never reloads on its own.
- URLs shown to the agent go through `safeUrl`/`shortUrl`.
- No tool that runs arbitrary JavaScript (existing test enforces the name rule).

## Review Focus

- A request sent just before the action (e.g. a polling XHR to the same URL) must not pass the check → test in Task 1 (`since` excludes earlier requests).
- The page navigates mid-check (content script gone) → the round is "pending", not a crash → test in Task 3 (sendMessage rejects once, then passes).
- A request that is still in flight at timeout → fails with "no response yet", not "no matching request" → test in Task 1.
- `expect` given on an action that opens a dialog → no checks run, result says a dialog is waiting → test in Task 3.
- `verify` with only `screenshot: true` and no checks → refused (AC9) → test in Task 2.

---

### Task 1: Pure request and result logic (`extension/verify.js`)

**Files:**
- Create: `extension/verify.js`
- Test: `test/verify.test.mjs`

**Interfaces:**
- Produces:
  - `parseRequestSpec(text: string) -> { method: string|null, path: string }` — `"POST /api/items"` → `{method:"POST", path:"/api/items"}`; `"/api/items"` → `{method:null, path:"/api/items"}`. Throws on empty.
  - `matchRequest(entries: Entry[], spec: {method, path}, { since: number, status?: number }) -> { state: "pass"|"fail"|"pending", entry?: Entry, reason?: string }` where `Entry = { id, method, url, status?, failed?, ms?, at }`. Only entries with `at >= since` count. Picks the most recent match. Pass when status equals `status` (or 2xx when unset). Fail when a finished match has another status or `failed`. Pending when a match has no status yet (reason `"no response yet"`) or no match exists (reason `"no matching request"`).
  - `combine(results: {state}[]) -> "pass"|"fail"|"pending"` — fail if any fail, else pending if any pending, else pass.

- [ ] **Step 1: Write failing tests** in `test/verify.test.mjs`:
  - `parseRequestSpec("post /api/items")` → `{method:"POST", path:"/api/items"}`; `parseRequestSpec("/x")` → `{method:null, path:"/x"}`; `parseRequestSpec("  ")` throws.
  - `matchRequest` with `[{method:"POST",url:"https://a.com/api/items",status:201,at:100}]`, spec POST `/api/items`, `since:50` → `state:"pass"`.
  - Same entry with `since:150` → `state:"pending"`, `reason:"no matching request"`.
  - Status 422 → `state:"fail"`, `entry.status===422`.
  - `failed:"net::ERR_FAILED"` → `fail`.
  - No status yet → `pending`, `reason:"no response yet"`.
  - Method mismatch (GET vs POST) → `pending`.
  - `status:422` option with a 422 entry → `pass`.
  - Two matches, older 500 and newer 200 → `pass` (most recent wins).
  - `combine([{state:"pass"},{state:"pending"}])==="pending"`; with a fail → `"fail"`; all pass → `"pass"`.
- [ ] **Step 2:** `node --test test/verify.test.mjs` → FAIL (module not found).
- [ ] **Step 3:** Implement `extension/verify.js` (ES module, no chrome APIs).
- [ ] **Step 4:** `node --test test/verify.test.mjs` → PASS.
- [ ] **Step 5:** Commit `feat: request matching for verification`.

### Task 2: Tool layer (`lib/tools.mjs`)

**Files:**
- Modify: `lib/tools.mjs` (TOOLS array; `click`/`fill`/`press` cases; new `verify` case)
- Test: `test/tools.test.mjs`

**Interfaces:**
- Consumes: hub method `page.verify` (Task 3) returning `VerifyResult = { state: "pass"|"fail", elapsedMs, checks: [{ name, want, state, evidence?, messages?: string[] }], dialog?, dataUrl?, url }`; `page.act`/`page.fill`/`page.press` accept `expect` (a resolved checks object) and return `verification: VerifyResult` when given.
- Produces:
  - `resolveChecks(args) -> { text?, gone?, selector?, field?, equals?, url?, request?, status?, timeout: number, screenshot: boolean }`. Throws: no check given (`"Pass at least one check: text, gone, selector, field + equals, url or request."`), `equals` without `field` or the reverse, `status` without `request` or outside 100-599, `timeout` outside 0-30000. `field` ref has a leading `@` stripped.
  - `formatVerification(res: VerifyResult) -> string` — matches the spec's two examples exactly (header `verified (N checks, 0.6s):` / `NOT verified (F of N checks failed after 5.0s):`, then `✓`/`✗` lines `name "want" — evidence`, then indented `  messages on the page: "a", "b"` under a failed page check). With `dialog`, header becomes `NOT verified: a <type> dialog is waiting ("<message>")`.
  - `EXPECT_SCHEMA` constant shared by `verify` (spread into its properties) and the `expect` property of `click`, `fill`, `press`.

- [ ] **Step 1: Write failing tests:**
  - `verify` and `expect` are in the schemas: `TOOLS.find(t=>t.name==="verify")` exists; `click`, `fill`, `press` have `inputSchema.properties.expect`.
  - `resolveChecks({})` throws /at least one check/; `resolveChecks({screenshot:true})` throws; `resolveChecks({equals:"a"})` throws; `resolveChecks({status:201})` throws; `resolveChecks({request:"/x", status:99})` throws; `resolveChecks({text:"x", timeout:30001})` throws; `resolveChecks({text:"Saved"})` → `{text:"Saved", timeout:5000, screenshot:false}`.
  - `formatVerification` of a passing 3-check result equals the spec's first example; failing result equals the spec's second example.
  - `callTool(fakeHub,"verify",{text:"Saved"})` calls `page.verify` with `{text:"Saved",timeout:5000,screenshot:false}` and returns text starting `verified`.
  - `callTool(fakeHub,"verify",{text:"x",screenshot:true})` with `dataUrl` returns `image` and text.
  - `callTool(fakeHub,"click",{ref:"e1",expect:{text:"Saved"}})` passes `expect` to `page.act` and the text contains the action line followed by a blank line and `NOT verified` when the fake returns a failing verification; result has no `isError` (AC7).
  - `callTool(fakeHub,"click",{ref:"e1"})` sends no `expect` key.
- [ ] **Step 2:** `node --test test/tools.test.mjs` → FAIL.
- [ ] **Step 3:** Implement. `verify` tool description names when to use it and that `request` needs capture (or `expect` on the action). Action text appends `"\n\n" + formatVerification(res.verification)` when present; `verify` returns `{ text, image? }`.
- [ ] **Step 4:** `npm test` → all pass.
- [ ] **Step 5:** Commit `feat: verify tool and expect option`.

### Task 3: Worker and page (`background.js`, `content.js`)

**Files:**
- Modify: `extension/background.js` (capture `at` timestamp in `Network.requestWillBeSent`; `lastAction` map; `page.verify`; `expect` in `page.act`, `page.fill`, `page.press`)
- Modify: `extension/content.js` (new `pointer:check` message)
- Modify: `test/fake-chrome.mjs` (let a test supply `pointer:check` replies and `debugger.sendCommand` results)
- Test: `test/worker.test.mjs`

**Interfaces:**
- Consumes: `parseRequestSpec`, `matchRequest`, `combine` (Task 1); checks object from `resolveChecks` (Task 2).
- Produces: hub method `page.verify(checks) -> VerifyResult`; `expect` support on the three actions; content message `pointer:check({ text?, gone?, selector?, field? , equals? }) -> { checks: [{name, want, state:"pass"|"pending", evidence?}], messages: string[] }`.

Worker details:
- `lastAction: Map<tabId, { at: number, network: boolean }>` set at the start of `page.act` (click only), `page.fill`, `page.press`, after `startCapture(tab.id,"network")` when `params.expect?.request`.
- `runChecks(tab, checks, since)` loops every 150 ms until `combine` gives pass or fail, or `timeout`. Each round: `page(tab.id,"pointer:check", pageChecks)` (a rejection counts all page checks pending), URL check from `chrome.tabs.get`, request check from `matchRequest(captureFor(tab.id) entries, spec, {since, status})`. A request check when capture was off at that action fails at once with the spec's message. At the deadline, pending page checks become fail with `not on the page` (text/selector), `still on the page` (gone), or `value is "<v>"` (field); pending request becomes fail with its reason. On a failed request with a body, read `Network.getResponseBody` and attach the first 200 chars when not base64. A dialog appearing (`dialogs.get(tab.id)`) stops the loop and sets `dialog`. When `screenshot`, attach `dataUrl` using the same capture path as `page.screenshot`.
- In actions: after `collectChanges`, `if (params.expect) result.verification = await runChecks(tab, params.expect, mark.at)`; skipped when a dialog result returns early.

Content details (`pointer:check`): normalise with `s.toLowerCase().replace(/\s+/g," ").trim()` against `document.body.innerText`; evidence is the matching `innerText` line cut to 120; `selector` passes when an element matches and has a non-empty client rect and is not `visibility:hidden`; `field` resolves by ref (existing `findByRef`) or selector, compares `.value` exactly, shows `••••` for `type=password`. `messages`: visible text of `[role=alert]`, `[aria-live]`, `[class*=error]`, `[class*=invalid]`, `[class*=toast]`, deduped, max 3, each cut to 120.

- [ ] **Step 1: Write failing worker tests:**
  - `page.verify {text:"Saved"}` where the fake `pointer:check` replies pass → `state:"pass"`.
  - `page.verify {text:"Saved", timeout:300}` with pending replies → `state:"fail"`, check evidence `not on the page`, `messages` carried through.
  - First `pointer:check` rejects (navigation), second passes → `state:"pass"`.
  - `page.verify {request:"POST /api/items"}` with no prior action capture → `fail` with /network capture was off/ in well under the timeout.
  - `page.act {ref:"e1", expect:{request:"POST /api/items", timeout:1000}}`: assert `Network.enable` was sent before the `Input.dispatchMouseEvent` calls; then emit `Network.requestWillBeSent` + `responseReceived` 201 during the action → `verification.state==="pass"`.
  - A request emitted before the action with status 201, none after → `fail` (AC4).
  - 422 response with body `{"error":"name is required"}` → `fail` immediately, evidence contains `422` and the body.
  - `page.act` without `expect` never sends `Network.enable` (AC8).
- [ ] **Step 2:** `node --test test/worker.test.mjs` → FAIL.
- [ ] **Step 3:** Implement worker, extend fake-chrome, implement `pointer:check` in content.js.
- [ ] **Step 4:** `npm test` → all pass.
- [ ] **Step 5:** Commit `feat: run verification checks in the extension`.

### Task 4: CLI, skill and README

**Files:**
- Modify: `bin/pointer.mjs` (usage comment + `verify` case; `--text --gone --selector --url --request --status --timeout`)
- Modify: `skills/pointer/SKILL.md` (tool table row; a short "Prove the outcome" rule: pass `expect` on saves, submits, deletes, sign-ins; reload + `verify` for persistence)
- Modify: `README.md` (tools table row `Verify` → `verify`, `expect`; one short section with the passing example)

- [ ] **Step 1:** Implement the CLI case: build args from flags, call `tool("verify", args)`, print text.
- [ ] **Step 2:** `node bin/pointer.mjs verify` with no flags prints the "at least one check" error (hub may auto-start; error comes from `resolveChecks` before any hub call).
- [ ] **Step 3:** Update SKILL.md and README.
- [ ] **Step 4:** `npm test` → all pass.
- [ ] **Step 5:** Commit `docs: verify and expect in the skill, README and CLI`.

### Task 5: Runtime verification in Chrome

- [ ] **Step 1:** Serve a local test page (scratchpad) with a form that POSTs to a tiny Node server returning 201 or 422, shows "Item saved" or an `[role=alert]` "Name is required", and a password field.
- [ ] **Step 2:** Reload the unpacked extension from this worktree; run the hub from this worktree on a free port.
- [ ] **Step 3:** Exercise AC1-AC6 and AC10 through the CLI against that page; save outputs to the scratchpad.
- [ ] **Step 4:** Fill the ledger in the spec with evidence.
