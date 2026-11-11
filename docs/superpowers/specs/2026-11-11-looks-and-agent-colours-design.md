# Looks (Classic and Sketch), agent colours, and a livelier edge

Date: 2026-11-11 · Status: approved 2026-11-11 · Demo: https://claude.ai/artifact/YXdHYqB8VGqPj9xusw2bNW

## Why

The human asked for a hand-drawn "Sketch" look as a theme option, an Impeccable pass on today's
look, a tab edge with shadow and motion while an agent drives, a colour per agent, and friendly
agent names ("claude-code" reads "Claude"). Each was agreed in the demo above.

## Goals

1. **Look setting.** Settings gains an Appearance section with **Look: Classic / Sketch**. Default
   Classic. It changes the popup, the settings page, and what Pointer draws on web pages (cursor,
   label, target, ripple, edge, bottom bar).
2. **Classic = today's look plus the audit fixes:**
   - Stop button: one red `#dc2626` with white text in both themes (was 3.8:1 in dark, now 4.8:1).
   - Selected segmented option: text `#1e1b2e` on the dark-mode accent (was 2.7:1, now 6.2:1).
   - Switches when off: outlined track (`#8b8b94`, ≥3.4:1) with a grey knob.
   - No text under 12px in the popup; muted grey `#6a6a73` in light mode so it passes on cards.
   - Gear, Reconnect and the site ✕ buttons at least 24×24px, with a hover background.
   - Settings menu highlights the current section; "General" is renamed "Connection".
   - Unselected segmented option gets a filled background and a divider.
3. **Sketch** as in the demo: hand-drawn borders (irregular `border-radius`), ink offset shadows,
   graph-paper background, highlighter tags, Caveat for headings, labels and buttons, Patrick Hand
   for small notes. Body text stays in the system font. Both looks keep the Classic size and
   contrast fixes.
4. **Edge while driving.**
   - Classic: inner glow that breathes (2.6 s) plus a light that runs round the border (3.2 s).
   - Sketch: a pencil line that "boils" (3 border shapes, stepped, 0.5 s) with an inner ink
     shadow and marching dashes.
   - Stopped: amber, no running light; Classic pulses slowly (1.8 s), Sketch boils slowly (1 s).
   - With `prefers-reduced-motion`, nothing moves and the glow stays.
5. **Agent colours.** Claude orange, Codex green, Cursor cyan; any other name gets blue, pink or
   purple from a stable hash of its name. The colour shows on the edge, glow, running light, target,
   ripple, label highlight, the bar's name tag, the popup tag and dot, and the Chrome tab group.
   Stopped stays amber for every agent. Red, yellow and grey are never agent colours.
6. **Friendly names.** A name containing "claude", "codex" or "cursor" (any case) shows as
   "Claude", "Codex", "Cursor" in the popup, bar, tab-group title and notifications. Other names show
   as given. The raw name is kept for everything else (the hub, logs, `browser_status`).

## Palette (from the demo, contrast checked)

| Key | Chrome group | Edge | Strong (white text) | Light (on dark label) | Soft (highlighter) |
|---|---|---|---|---|---|
| claude | orange | `#d97757` | `#b4532f` (4.98) | `#f4b49a` | `#fde0d2` |
| codex | green | `#10a37f` | `#0b7a5e` (5.30) | `#6ee7b7` | `#c9f5e4` |
| cursor | cyan | `#06b6d4` | `#0e7490` (5.36) | `#67e8f9` | `#c8f3fb` |
| blue | blue | `#3b82f6` | `#1d4ed8` (6.70) | `#93c5fd` | `#dbe8fe` |
| pink | pink | `#ec4899` | `#be185d` (6.04) | `#f9a8d4` | `#fbd5e8` |
| purple | purple | `#8b5cf6` | `#6d28d9` (7.10) | `#c4b5fd` | `#e4dcfd` |

Hash for other names: `h = (h * 31 + codePoint) >>> 0` over the name, index `h % 3` into
`[blue, pink, purple]` ("abc" → blue).

## Non-goals

- The "handwritten body text" toggle from the demo. Not shipped.
- A per-agent colour picker. The mapping is fixed.
- Changing the toolbar badge colour.

## Anti-goals

- Loading anything from the web at run time. Fonts ship in the extension.
- Making Pointer detectable by web pages through `web_accessible_resources`. Fonts reach the page
  as bytes from the service worker, not by URL.
- Animations that cost CPU while the human isn't looking: they run only while the tab is visible.

## Approaches considered

- **A. One shared `extension/looks.css` for popup and settings; the overlay keeps its own styles in
  `content.js` (chosen, the human said to go ahead with the recommendation).** Fixes live in one
  place for the two extension pages. The overlay cannot use a page stylesheet, so it carries its own.
- B. Copy styles into each file. Simpler per file, but colours drift.
- C. Separate Sketch pages. Every change made twice.

## How it works (decided parts)

- **Setting:** `look: "classic" | "sketch"` in `extension/settings.js` (`DEFAULT_SETTINGS.look =
  "classic"`, anything else → `"classic"`).
- **Agent identity:** new pure module `extension/agents.js` exporting `agentLabel(name)` and
  `agentColour(name)` (palette above). Used by the service worker (tab-group colour and title,
  notifications, the view sent to pages) and the popup.
- **To the page:** `viewOf` adds `look`, `agentLabel` and `colour` (the palette entry) to the view
  the service worker already sends with `pointer:presence`. `content.js` sets `data-look` and CSS
  variables on its shadow root host. Before the first view it draws Classic in the default blue.
- **Fonts on the page:** only when Sketch is on, `content.js` asks the service worker for the font
  bytes once (`pointer:fonts`), registers them with `new FontFace(..., buffer)` and
  `document.fonts.add`, under names that cannot clash (`Pointer Caveat`, `Pointer Patrick`).
- **Running light:** needs a registered `<angle>` property; `@property` is ignored inside shadow
  roots, so `content.js` calls `CSS.registerProperty({ name: "--pointer-edge-a", ... })` once,
  guarded by try/catch. If that fails, the glow still breathes and the light is skipped.
- **Fonts on extension pages:** `extension/fonts/` holds `caveat.woff2`, `patrick-hand.woff2` and
  both `OFL.txt` licences; `looks.css` loads them with `@font-face`.

## Acceptance criteria and verification ledger

| # | Acceptance criterion | Verification method | Status | Evidence |
|---|---|---|---|---|
| T1 | Settings shows Appearance → Look; choosing Sketch or Classic saves at once and the popup, settings page and open agent tabs follow | Unit test (settings) + browser check in real Chrome | NOT VERIFIED | |
| T2 | Classic fixes meet the numbers in Goal 2, light and dark | Impeccable detector + contrast script + screenshots | NOT VERIFIED | |
| T3 | Sketch matches the demo in popup, settings and on the page, light and dark, with fonts loaded on a page with a strict CSP | Browser check (screenshots) incl. a CSP test page | NOT VERIFIED | |
| T4 | Edge animates as in Goal 4, stops moving with reduced motion, amber when stopped | Browser check (screenshots/GIF) with emulated reduced motion | NOT VERIFIED | |
| T5 | `agentColour` and `agentLabel` give the palette and names above, "abc" → blue, stable across calls | Unit test | NOT VERIFIED | |
| T6 | Tab group colour and title use the agent's colour and friendly name | Worker test (fake chrome) + browser check | NOT VERIFIED | |
| T7 | No `web_accessible_resources` added; manifest unchanged except files | Review + `manifest.json` diff | NOT VERIFIED | |
| T8 | All overlays checked: popup states (driving, stopped, offline, other profile), settings saved toast, notice, bar driving/stopped/done chip, label, target, in both looks and themes | Browser check list with screenshots | NOT VERIFIED | |
| T9 | Full suite passes | `npm test`, `npm run check` | NOT VERIFIED | |

## Left to the builder

- Exact Sketch CSS values beyond the demo, as long as it reads like the demo.
- How `looks.css` is split into token and component sections.
