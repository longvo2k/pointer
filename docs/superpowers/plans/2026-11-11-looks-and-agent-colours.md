# Looks, Agent Colours and Edge: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Look setting (Classic / Sketch) across popup, settings and the on-page overlay, Classic audit fixes, a colour and friendly name per agent, and an animated tab edge.

**Architecture:** Pure helpers (`extension/agents.js`, `extension/settings.js`) decide names, colours and the look; the service worker passes them to pages inside the existing presence view. `extension/looks.css` styles both extension pages; `content.js` keeps its own shadow-root styles with a Sketch block and per-agent CSS variables. Fonts ship in `extension/fonts/` and reach web pages as bytes.

**Tech Stack:** Chrome MV3, plain CSS, Node `node:test` with the repo's fake chrome (`test/fake-chrome.mjs`).

**Spec:** `docs/superpowers/specs/2026-11-11-looks-and-agent-colours-design.md` · Demo for visual reference: `/private/tmp/claude-501/-Users-longvo-Developer-Personal-pointer/2d98e3e1-bc9e-45f5-81ab-5cd4fd41dc4e/scratchpad/pointer-sketch-demo.html`

## Global Constraints

- `look` is `"classic"` or `"sketch"`; default `"classic"`.
- Palette, hash and friendly names exactly as in the spec tables. Stopped is amber (`#d97706` edge, `#b45309` tag) for every agent.
- No `web_accessible_resources`. No network at run time.
- Every animation has a `prefers-reduced-motion: reduce` rule that stops movement and keeps the glow.
- Text ≥ 12px in the popup; contrast ≥ 4.5:1 for text, ≥ 3:1 for switch tracks and focus rings, in both looks and both themes.
- Font family names on web pages: `Pointer Caveat`, `Pointer Patrick`.

## Review Focus

1. A page with a strict CSP (`font-src 'none'`): Sketch fonts still load (bytes, not URLs) and nothing logs a CSP error. (Task 4 browser check "CSP page")
2. Switching Look while an agent is mid-task: open agent tabs restyle without reload and the edge keeps its state. (Task 4 browser check "live switch")
3. An empty or very long agent name: `agentLabel` returns "agent" / the name truncated where the group title already truncates; colour still stable. (Task 1 test "odd names")
4. `CSS.registerProperty` already registered (the content script runs twice after an extension reload): no exception, light still runs. (Task 4 code: try/catch; browser check after reload)
5. Dark-mode pages with the Sketch overlay: the paper bar and label stay readable (fixed colours). (Task 4 browser check on a dark page)

---

### Task 1: Pure helpers, setting, and the view

**Files:**
- Create: `extension/agents.js`
- Modify: `extension/settings.js` (add `look`), `extension/presence.js` (`viewOf`)
- Test: `test/agents.test.mjs` (create), `test/settings.test.mjs`, `test/presence.test.mjs`

**Interfaces:**
- Produces:
  - `agentLabel(name: string) -> string`
  - `agentColour(name: string) -> { key, group, edge, strong, light, soft }`
  - `PALETTE` (export) keyed `claude, codex, cursor, blue, pink, purple`
  - `DEFAULT_SETTINGS.look === "classic"`; `withDefaults({ look: "x" }).look === "classic"`
  - `viewOf(p, settings, agent)` result gains `look`, `agentLabel`, `colour` (the `agentColour` object)

- [ ] **Step 1: Write failing tests:** "known agents get their colour and name" (`claude-code` → `{key:"claude", group:"orange"}`, label `Claude`; `codex-mcp-client` → green/`Codex`; `Cursor-VSCode` → cyan/`Cursor`); "other names hash to a spare colour" (`abc` → blue, same answer twice; label `abc`); "odd names" (`""` → label `agent`, colour from `"agent"`); settings default test updated to include `look: "classic"` and bad value falls back; presence test: `viewOf(..., { look: "sketch" }, "claude-code")` has `look: "sketch"`, `agentLabel: "Claude"`, `colour.key: "claude"`.
- [ ] **Step 2: Run** `node --test test/agents.test.mjs test/settings.test.mjs test/presence.test.mjs` → FAIL.
- [ ] **Step 3: Implement** the three files.
- [ ] **Step 4: Run** the same command → PASS.
- [ ] **Step 5: Commit** `feat: agent colours, friendly names and the look setting`

### Task 2: Service worker uses colour and friendly name

**Files:**
- Modify: `extension/background.js` (`GROUP_COLOR` uses at ~lines 535, 573, 582 → `agentColour(agentName).group`; group title ~line 506 and notification text ~line 1682 → `agentLabel(agentName)`; new message `pointer:fonts` returning `{ caveat: base64, patrick: base64 }` read with `fetch(chrome.runtime.getURL("fonts/…"))`, cached in memory)
- Test: `test/worker.test.mjs`

**Interfaces:**
- Consumes: Task 1 `agentLabel`, `agentColour`.
- Produces: runtime message `pointer:fonts` → `{ caveat: string, patrick: string }` (base64 woff2).

- [ ] **Step 1: Write failing tests** with the fake chrome: agent `claude-code` → tab group created with `color: "orange"` and title ending `Claude`; agent `abc` → `color: "blue"`, title ending `abc`; a "done" notification title is `Claude finished`.
- [ ] **Step 2: Run** `node --test test/worker.test.mjs` → FAIL.
- [ ] **Step 3: Implement.** Add the font files first: download `caveat.woff2` (Caveat 500–700, latin), `patrick-hand.woff2` (latin) and both `OFL.txt` (as `OFL-caveat.txt`, `OFL-patrick-hand.txt`) into `extension/fonts/`; mention them in `README.md` credits.
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** `feat: tab groups and notifications use the agent's colour and name`

### Task 3: `looks.css`, popup and settings page

**Files:**
- Create: `extension/looks.css`
- Modify: `extension/popup.html`, `extension/popup.js`, `extension/options.html`, `extension/options.js`
- Test: `test/settings.test.mjs` (nothing new), browser checks below

**Interfaces:**
- Consumes: Task 1 `look` setting, `agentLabel`, `agentColour`.
- Produces: `<html data-look="classic|sketch">` on both pages; CSS variables `--agent`, `--agent-strong` on the popup's agent row.

- [ ] **Step 1:** Move the shared tokens and component styles of `popup.html` and `options.html` into `looks.css`, then apply Classic fixes 1–7 from the spec and the Sketch block from the demo. Both pages read `look` from `chrome.storage.local` on load and on change, and set `data-look`.
- [ ] **Step 2:** Settings: add the Appearance section with a `role="radiogroup"` Look control (`name="look"`, values `classic`, `sketch`), nav link "Appearance", rename the nav link "General" to "Connection", and highlight the nav link of the section in view (IntersectionObserver).
- [ ] **Step 3:** Popup: agent row shows `agentLabel` with a dot and tag in the agent's colour (`popup.js` loads `agents.js` as a module).
- [ ] **Step 4: Browser check** (real Chrome, unpacked build from the worktree): screenshot popup driving / stopped / offline / other profile and settings (incl. "Saved" toast, notify note, site error), each in Classic and Sketch, light and dark. Run `impeccable detect` on both pages: no contrast or tiny-text findings.
- [ ] **Step 5: Commit** `feat: Classic and Sketch looks for the popup and settings`

### Task 4: On-page overlay: look, agent colour, edge animation, fonts

**Files:**
- Modify: `extension/content.js` (shadow-root `<style>`, `setPresence`, a `applyLook(view)` helper)

**Interfaces:**
- Consumes: view fields `look`, `agentLabel`, `colour` (Task 1); `pointer:fonts` (Task 2).

- [ ] **Step 1:** `applyLook(view)`: set `data-look` on the shadow container and `--agent`, `--agent-strong`, `--agent-light`, `--agent-soft` from `view.colour`; bar name uses `view.agentLabel`. Defaults (no view yet): classic, blue.
- [ ] **Step 2:** Styles: replace hard-coded blue in edge, target, ripple, label `b`, bar `.who`, arrow glow with the variables; add the Classic edge (glow + running light on `--pointer-edge-a`) and the Sketch block (paper label and bar, ink cursor, hand-drawn target, boiling edge, marching dashes), amber stopped rules, and reduced-motion rules, all as in the demo. Register `--pointer-edge-a` once with `CSS.registerProperty` in try/catch.
- [ ] **Step 3:** Fonts: when `view.look === "sketch"` and fonts are not yet added, ask `pointer:fonts`, decode, `document.fonts.add(new FontFace("Pointer Caveat", buf))` and the same for Patrick; ignore failures (system fallback).
- [ ] **Step 4: Browser check** on: a light page, a dark page, a page with CSP `default-src 'self'; font-src 'none'`. For Claude, Codex, Cursor and `abc`, Classic and Sketch: driving (edge animating, label, target), stopped (amber), done chip. Emulate reduced motion: no movement. Switch Look in settings mid-task: overlay restyles live. Reload the extension and repeat once (registerProperty twice). Screenshots/GIF saved as evidence; console has no errors from Pointer.
- [ ] **Step 5: Run** `npm test && npm run check` → PASS.
- [ ] **Step 6: Commit** `feat: overlay follows the look and the agent's colour, with an animated edge`

### Task 5: Ledger and docs

- [ ] **Step 1:** README: Look setting, agent colours, friendly names, font credits.
- [ ] **Step 2:** Fill the spec's ledger T1–T9 with test names, commands and screenshot paths.
- [ ] **Step 3: Run** `npm test && npm run check`; record counts.
- [ ] **Step 4: Commit** `docs: looks and agent colours`
