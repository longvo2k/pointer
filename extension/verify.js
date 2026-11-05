// Verification helpers with no Chrome APIs, so they can be tested in node.

/** "POST /api/items" -> { method: "POST", path: "/api/items" }; "/api/items" -> any method. */
export function parseRequestSpec(text) {
  const raw = String(text ?? "").trim();
  if (!raw) throw new Error('request needs a URL piece, e.g. "POST /api/items" or "/api/items".');
  const m = /^([a-z]+)\s+(\S.*)$/i.exec(raw);
  if (m) return { method: m[1].toUpperCase(), path: m[2].trim() };
  return { method: null, path: raw };
}

const SECRET_PARAM =
  /(^|[_.-])(access_?token|id_?token|refresh_?token|token|secret|code|api_?key|key|auth|session(_?id)?|sid|sig(nature)?|password|passwd|pass|otp|jwt|ticket|credentials?)$/i;

/**
 * The URL as the agent is shown it: secret-looking query values and the
 * #fragment removed (same rule as lib/tools.mjs safeUrl). Checks match this,
 * so an agent cannot guess a hidden token one character at a time.
 */
export function visibleUrl(href) {
  try {
    const u = new URL(href);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (SECRET_PARAM.test(k)) u.searchParams.set(k, "redacted");
    return u.href.replace(/=redacted/g, "=…");
  } catch {
    return String(href ?? "").split("#")[0];
  }
}

/**
 * Find the request that proves (or disproves) the check. Only requests sent at
 * or after `since` count, so traffic from before the action cannot pass it.
 * The most recent finished match decides; one still in flight only counts
 * when nothing has answered yet.
 */
export function matchRequest(entries, spec, { since = 0, status } = {}) {
  const matches = (entries || []).filter(
    (e) => e.at >= since && (!spec.method || String(e.method).toUpperCase() === spec.method) && visibleUrl(e.url).includes(spec.path)
  );
  const finished = matches.filter((e) => e.failed || e.status != null);
  const entry = finished[finished.length - 1];
  if (!entry) {
    const waiting = matches[matches.length - 1];
    return waiting ? { state: "pending", entry: waiting, reason: "no response yet" } : { state: "pending", reason: "no matching request" };
  }
  if (entry.failed) return { state: "fail", entry };
  const ok = status != null ? entry.status === status : entry.status >= 200 && entry.status < 300;
  return { state: ok ? "pass" : "fail", entry };
}

/** All checks together: any fail fails, any pending keeps waiting, else pass. */
export function combine(results) {
  if (results.some((r) => r.state === "fail")) return "fail";
  if (results.some((r) => r.state === "pending")) return "pending";
  return "pass";
}
