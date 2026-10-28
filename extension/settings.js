/**
 * The human's settings, stored in chrome.storage.local under one key.
 * Only the settings page writes them; no agent command can read or change them.
 * Pure: no chrome.* calls, so node can test it.
 */
import { normalizeSitePattern } from "./sites.js";

export const SETTINGS_KEY = "pointerSettings";

export const DEFAULT_SETTINGS = Object.freeze({
  bar: true,
  edge: true,
  cursorSpeed: "watchable",
  labels: true,
  groupStatus: true,
  notifyDone: false,
  notifyStopped: false,
  sound: false,
  escStops: true,
  clickStops: true,
  blockedSites: Object.freeze([]),
});

const CURSOR_SPEEDS = new Set(["watchable", "fast"]);

/** Stored settings with every missing or malformed value replaced by its default. */
export function withDefaults(stored) {
  const src = stored && typeof stored === "object" ? stored : {};
  const out = {};
  for (const [key, def] of Object.entries(DEFAULT_SETTINGS)) {
    if (typeof def === "boolean") out[key] = typeof src[key] === "boolean" ? src[key] : def;
  }
  out.cursorSpeed = CURSOR_SPEEDS.has(src.cursorSpeed) ? src.cursorSpeed : DEFAULT_SETTINGS.cursorSpeed;
  const sites = [];
  for (const raw of Array.isArray(src.blockedSites) ? src.blockedSites : []) {
    if (typeof raw !== "string") continue;
    try {
      const p = normalizeSitePattern(raw);
      if (!sites.includes(p)) sites.push(p);
    } catch {
      // Not a site pattern; drop it.
    }
  }
  out.blockedSites = sites;
  return out;
}
