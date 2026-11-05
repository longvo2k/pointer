# MCP: list and pick the connected browser

Date: 2026-11-05 · Status: approved 2026-11-05 (items 1–4 of the issue) · Issue: #37

## Why

With several Chrome profiles connected, an MCP agent cannot see them or switch between them. The
CLI can (`pointer browsers`, `pointer use <id>`). When the hub is pinned, clicking the Pointer icon
in another window does nothing, and `browser_status` does not say why.

## Changes

1. **Hub, `ext.list` with `{ tabs: true }`**: also asks each connected browser for its tabs (2 s
   timeout per browser, in parallel) and adds `tabCount` and `tabs` (first 3: title and URL) to
   each entry. A browser that does not answer gets `tabsError` instead. The preview call goes
   straight to that browser's socket: it does not change the active browser, the idle clock, or
   the other profile's agent label. Without `tabs`, `ext.list` is unchanged.
2. **New MCP tool `browsers_list`** (no arguments): one block per browser with the short id,
   active/pinned marks, build (and stale warning), connected age, focused age, and the tab preview.
   Ends with the mode line and how to switch.
3. **New MCP tool `browser_use`** `{ id }`: an id or prefix pins that browser, `"auto"` follows
   focus again. Its description says to switch only when the human asks, and to tell them which
   profile is now in use. Unknown id → error listing the ids that exist.
4. **`browser_status`** gains `Mode: pinned` or `Mode: following focus`, and
   `Other browsers: <ids>` when there are any. When pinned with 2+ browsers it adds: "Pinned: focus
   changes in other profiles are ignored. If the human wants another profile, find it with
   browsers_list and switch with browser_use."

5. **Hub → extension role event**: whenever the active browser or the pin changes (hello, close,
   `ext.use`, follow-focus, popup choice), the hub sends every connection
   `{ event: "hub", active, pinned, browsers }`. The extension keeps it in memory and reports it in
   `pointer:status`.
6. **Popup prompt** (issue item 4): when this profile is connected but the hub is pinned to
   another one, the popup shows "Pointer is pinned to another profile. Agents work there, not
   here." with a **Use this profile** button. The button sends `{ event: "use" }` over this
   profile's socket; the hub pins to that connection (the human chose it) and logs it. The
   button is the human's own action, so it is not an agent switching silently.

## Verification ledger

| # | Acceptance criterion | Verification method | Status | Evidence |
|---|---|---|---|---|
| AC1 | With 2+ browsers connected, an agent can find the intended profile (by its tabs) and switch to it with MCP tools alone | Integration test (real hub + fake browsers + MCP tool layer) + runtime check over MCP stdio | VERIFIED | hub.test "ext.list with tabs previews…"; tools.test "browsers_list shows each profile…", "browser_use pins…"; runtime: real hub + `bin/mcp.mjs` over stdio, 3 fake browsers, pinned via CLI → `browsers_list` showed Kai's tabs → `browser_use` → next `tabs_list` answered from Kai |
| AC2 | `browser_status` makes clear when pinning is why focus changes are ignored | Unit/integration test + runtime check | VERIFIED | tools.test "browser_status says the hub is pinned…" / "…following focus has no pin hint"; runtime output shows `Mode: pinned`, `Other browsers`, hint line |
| AC3 | Switching is never silent: `browser_use` description says switch only on the human's request; no other tool switches | Test on tool descriptions + manual review | VERIFIED | tools.test "browser_use says to switch only when the human asks…"; review: only `browser_use` calls `ext.use` |
| AC4 | Tab previews do not change the active browser or the other profile's state | Integration test | VERIFIED | hub.test asserts activeId, lastCallAt unchanged and no `agent` param on the preview; `tabs.list` is in presence NOT_ACTIVITY |
| AC6 | Clicking the Pointer icon in a profile while the hub is pinned elsewhere explains it and offers "Use this profile", which pins the hub there | Hub integration test + worker test (fake chrome) + popup render check in a browser | VERIFIED | hub.test "the human picking a profile in its popup pins the hub there", "…never said hello cannot take the hub"; worker.test "the popup learns…"; browser check: notice shows, click sends `pointer:use-here` and notice hides |
| AC7 | Popup prompt is readable in light and dark, at popup width, keyboard reachable | Browser check + Impeccable audit | VERIFIED | Chrome render of popup harness: light text 16:1-ish, button 16.4:1; dark notice 13.9:1, button 14.4:1; 300px, no overflow; button keyboard-focusable with accent outline. Impeccable detector: no findings in the new notice |
| AC5 | Existing CLI `pointer browsers` / `pointer use` and the full suite still work | `npm test`, `npm run check`, CLI run | VERIFIED | `npm test` 104/104 pass; `npm run check` clean; CLI `pointer use` run in the runtime check |
