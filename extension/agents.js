/**
 * Agents as people see them: a friendly name and one colour each.
 * Pure: no chrome.* calls, so node can test it.
 */

/**
 * group: the Chrome tab-group colour. edge: the tab edge and glow. strong: fills
 * with white text (≥ 4.5:1). light: text on the dark label. soft: highlighter
 * and chip fills under dark text. Red, yellow and grey are never agent colours:
 * red is Stop, amber is "stopped", grey looks switched off.
 */
export const PALETTE = Object.freeze({
  claude: Object.freeze({ group: "orange", edge: "#d97757", strong: "#b4532f", light: "#f4b49a", soft: "#fde0d2" }),
  codex: Object.freeze({ group: "green", edge: "#10a37f", strong: "#0b7a5e", light: "#6ee7b7", soft: "#c9f5e4" }),
  cursor: Object.freeze({ group: "cyan", edge: "#06b6d4", strong: "#0e7490", light: "#67e8f9", soft: "#c8f3fb" }),
  blue: Object.freeze({ group: "blue", edge: "#3b82f6", strong: "#1d4ed8", light: "#93c5fd", soft: "#dbe8fe" }),
  pink: Object.freeze({ group: "pink", edge: "#ec4899", strong: "#be185d", light: "#f9a8d4", soft: "#fbd5e8" }),
  purple: Object.freeze({ group: "purple", edge: "#8b5cf6", strong: "#6d28d9", light: "#c4b5fd", soft: "#e4dcfd" }),
});

const KNOWN = [
  [/claude/i, "claude", "Claude"],
  [/codex/i, "codex", "Codex"],
  [/cursor/i, "cursor", "Cursor"],
];
const SPARE = ["blue", "pink", "purple"];

const clean = (name) => String(name ?? "").trim() || "agent";

/** "claude-code" → "Claude"; any other name as given ("agent" when empty). */
export function agentLabel(name) {
  const n = clean(name);
  for (const [re, , label] of KNOWN) if (re.test(n)) return label;
  return n;
}

/** The agent's colours. Known agents have their own; any other name always gets the same spare one. */
export function agentColour(name) {
  const n = clean(name);
  for (const [re, key] of KNOWN) if (re.test(n)) return { key, ...PALETTE[key] };
  let h = 0;
  for (const ch of n) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  const key = SPARE[h % SPARE.length];
  return { key, ...PALETTE[key] };
}
