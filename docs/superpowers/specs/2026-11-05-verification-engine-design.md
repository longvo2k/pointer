# Verification engine

Date: 2026-11-05. Status: draft for approval.

## Why

Today `click`, `fill` and `press` report that the input landed and what changed on screen. That proves
the click happened, not that the task worked. An agent that clicks Save, sees "no change in view" or a
spinner, and says "saved" is guessing. The human wants an action to come back with proof of its
outcome: the expected text showed up, the server accepted the request, the page moved where it
should. And when it did not, the result should say so plainly and show what happened instead.

## Goals

- An agent can state what should be true after an action, and get **verified** or **NOT verified**
  back, with evidence for each check.
- Checks cover the three cheap levels of proof: what the page shows (text, element, field value),
  what the server said (a matching request and its status), and where the page is (URL).
- A failed check shows what was there instead: error and alert messages on the page, the request's
  status and the start of its error body.
- One call can both act and verify (`expect` on the action), so the agent cannot forget to check.

## Non-goals

- Reloading or revisiting pages to prove that data persisted. The agent can do that itself with
  `navigate reload` then `verify`. Pointer never reloads on its own: a reload can resubmit a form.
- Recorded timelines, saved screenshots and replay. That is the next feature (Test Replay & Evidence).
- Running page JavaScript or arbitrary expressions. Pointer has no such tool, and this keeps it so.

## Anti-goals

- Turning on network capture silently on every action. It makes the debugger easier for anti-bot
  scripts to spot. Capture starts only when a check asks for a request.
- A pass that is not earned: a request check must never pass on a request that started before the action.

## Design

### A new tool: `verify`

All the checks given must pass. Pointer re-checks every 150 ms until they all pass, a check fails for
good (a request came back with the wrong status), or `timeout` runs out.

| Argument | Passes when |
|---|---|
| `text` | the visible page text contains it (case and spacing ignored) |
| `gone` | the visible page text no longer contains it (e.g. "Saving…", "Unsaved changes") |
| `selector` | an element matching the CSS selector exists and is visible |
| `field` + `equals` | the input, textarea or select with this ref or selector holds exactly this value |
| `url` | the tab's URL contains it |
| `request` | a request since the last action matches, e.g. `"POST /api/items"` or `"/api/items"`, and finished with `status` (default: any 2xx) |
| `status` | the status code `request` must end with (100-599); only with `request` |
| `timeout` | ms to keep checking, default 5000, 0-30000 |
| `screenshot` | attach a PNG of the tab to the result (default false) |

At least one check is required. `request` matching: the optional method must equal (any case); the
rest is a substring of the URL (with secret query values hidden, like everywhere else).

### `expect` on `click`, `fill` and `press`

`expect` takes the same object as `verify`. The action runs as today; then Pointer runs the checks and
adds the verification block under the action's report. If `expect` has a `request`, network capture
starts **before** the action, so the request is caught. A failed expectation does not turn the action
into an error: the input landed, and the report says both things.

### "Since the last action"

The worker remembers, per tab, when the last `click`, `fill` or `press` started. A `request` check only
counts requests sent after that moment. On a standalone `verify` with `request` while network capture
was off at that action, the check fails with: "network capture was off when the last action ran; pass
expect: { request } on the action, or call network first." It never waits out the timeout in that case.

### What the agent reads

```
verified (3 checks, 0.6s):
✓ text "Item saved" — "Item saved successfully"
✓ request POST /api/items — POST 201 example.com/api/items (142ms)
✓ url "/items/" — example.com/items/42
```

```
NOT verified (2 of 3 checks failed after 5.0s):
✗ text "Item saved" — not on the page
  messages on the page: "Name is required"
✗ request POST /api/items — POST 422 example.com/api/items: {"error":"name is required"}
✓ url "/items/new" — example.com/items/new
```

- Text evidence: the line of page text that matched, cut to 120 characters.
- Failure evidence for page checks: up to 3 visible messages from `[role=alert]`, `[aria-live]`,
  `[aria-invalid=true]` fields' descriptions, and elements whose class contains `error`, `invalid` or
  `toast`; each cut to 120 characters.
- Request failure evidence: the status (or the network error) and the first 200 characters of a text
  body. No body for 2xx.
- `field` evidence shows the value found. Values of password fields are never shown (`••••`).

### Where the code goes

- `lib/tools.mjs`: the `verify` schema, `expect` on three schemas, argument checking
  (`resolveChecks`), and the text the agent reads (`formatVerification`).
- `extension/verify.js` (new, pure): request matching and combining check results; unit tested.
- `extension/content.js`: `pointer:check` reads text, gone, selector and field in one pass and
  collects the page's messages on failure.
- `extension/background.js`: `page.verify`, the poll loop, the per-tab "last action" mark, starting
  network capture for `expect.request`, and running `expect` after `page.act`, `page.fill`, `page.press`.
- `bin/pointer.mjs`: `pointer verify [--text ..] [--gone ..] [--request ..] [--url ..] [--timeout ms]`.
- `skills/pointer/SKILL.md` and README: when to use `expect` (any action whose outcome matters:
  saves, submits, deletes, sign-ins) and how to read the result.

### Edge cases

- The page navigates while checking: the content script goes away; that round counts as "not yet"
  and checking continues on the new page.
- A dialog opens: checking stops and the result says a dialog is waiting.
- The tab is on a blocked site: refused like every other command.
- The human stopped the agent: `verify` only reads, so it still answers; `expect` never runs because
  the action is refused first.
- Another extension's frame blocks the debugger: `request` checks fail with the existing explanation;
  page checks still work.

## Left to the builder

Exact wording of messages, the CLI flag names, and how the poll loop is split between worker and page.

## Verification ledger

| # | Acceptance criterion | Verification method | Status | Evidence |
|---|---|---|---|---|
| AC1 | `verify` with `text` passes when the text is on the page and shows the matching line | unit test + browser check | | |
| AC2 | `verify` fails after `timeout` when a check never passes, listing messages on the page | unit test + browser check | | |
| AC3 | `gone`, `selector`, `field`+`equals` and `url` each pass and fail correctly | unit test + browser check | | |
| AC4 | `request` passes on a matching 2xx request sent after the last action, never on an earlier one | unit test + browser check | | |
| AC5 | `request` fails early on a wrong status, showing the status and the start of the body | unit test + browser check | | |
| AC6 | `expect` on `click`/`fill`/`press` starts network capture before acting when it has a `request`, and appends the verification block | unit test + browser check | | |
| AC7 | A failed `expect` does not make the action an error | unit test | | |
| AC8 | Network capture stays off unless a check asks for a request | unit test | | |
| AC9 | Bad arguments are refused with a clear message (no checks, `equals` without `field`, `status` without `request`, timeout out of range) | unit test | | |
| AC10 | Password field values never appear in evidence | unit test | | |
| AC11 | `pointer verify` CLI works and the skill/README document `verify` and `expect` | manual review + CLI run | | |
| AC12 | The full test suite passes | `npm test` | | |
