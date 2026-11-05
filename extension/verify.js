// Verification helpers with no Chrome APIs, so they can be tested in node.

/** "POST /api/items" -> { method: "POST", path: "/api/items" }; "/api/items" -> any method. */
export function parseRequestSpec(text) {
  const raw = String(text ?? "").trim();
  if (!raw) throw new Error('request needs a URL piece, e.g. "POST /api/items" or "/api/items".');
  const m = /^([a-z]+)\s+(\S.*)$/i.exec(raw);
  if (m) return { method: m[1].toUpperCase(), path: m[2].trim() };
  return { method: null, path: raw };
}

/**
 * Find the request that proves (or disproves) the check. Only requests sent at
 * or after `since` count, so traffic from before the action cannot pass it.
 * The most recent match decides.
 */
export function matchRequest(entries, spec, { since = 0, status } = {}) {
  const matches = (entries || []).filter(
    (e) => e.at >= since && (!spec.method || String(e.method).toUpperCase() === spec.method) && String(e.url).includes(spec.path)
  );
  const entry = matches[matches.length - 1];
  if (!entry) return { state: "pending", reason: "no matching request" };
  if (entry.failed) return { state: "fail", entry };
  if (entry.status == null) return { state: "pending", entry, reason: "no response yet" };
  const ok = status != null ? entry.status === status : entry.status >= 200 && entry.status < 300;
  return { state: ok ? "pass" : "fail", entry };
}

/** All checks together: any fail fails, any pending keeps waiting, else pass. */
export function combine(results) {
  if (results.some((r) => r.state === "fail")) return "fail";
  if (results.some((r) => r.state === "pending")) return "pending";
  return "pass";
}
