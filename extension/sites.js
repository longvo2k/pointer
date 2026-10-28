/**
 * Blocked sites: the human lists sites agents may never open, read, or act on.
 *
 * A pattern is a host and a path, like "mybank.com/*" or "github.com/myorg/*".
 * Matching ignores case, the scheme, a leading "www.", ports and user names,
 * and `*` matches any run of characters. Pure: no chrome.* calls, so node can test it.
 */

/** Turn what the human typed into a canonical pattern, or throw saying why it is not one. */
export function normalizeSitePattern(input) {
  let s = String(input ?? "").trim().toLowerCase();
  if (!s) throw new Error("Type a site, like example.com or example.com/admin/*");
  const scheme = /^([a-z][a-z0-9+.-]*):\/*/.exec(s);
  if (scheme) {
    if (scheme[1] !== "http" && scheme[1] !== "https") throw new Error("Only web sites (http or https) can be blocked.");
    s = s.slice(scheme[0].length);
  }
  s = s.replace(/^www\./, "");
  const slash = s.indexOf("/");
  const host = (slash < 0 ? s : s.slice(0, slash)).replace(/:\d+$/, "");
  const path = slash < 0 ? "/*" : s.slice(slash);
  if (!/^[a-z0-9*][a-z0-9*.-]*$/.test(host)) throw new Error("That does not look like a site name.");
  return host + path;
}

const escape = (text) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
const glob = (text, star) => text.split("*").map(escape).join(star);

/**
 * A blocked domain also covers its subdomains (mybank.com blocks login.mybank.com),
 * and a blocked folder covers the folder itself (github.com/myorg/* blocks github.com/myorg).
 */
function patternRegExp(pattern) {
  const slash = pattern.indexOf("/");
  const host = slash < 0 ? pattern : pattern.slice(0, slash);
  const path = slash < 0 ? "/*" : pattern.slice(slash);
  const hostRe = `(?:[^/]*\\.)?${glob(host, "[^/]*")}`;
  const pathRe = path.endsWith("/*") ? `${glob(path.slice(0, -2), ".*")}(?:/.*)?` : glob(path, ".*");
  return new RegExp(`^${hostRe}${pathRe}$`, "i");
}

/** True when the URL is a web page covered by one of the patterns. */
export function isBlockedUrl(url, patterns) {
  if (!patterns?.length) return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  // "mybank.com." is the same site as "mybank.com".
  const host = u.hostname.replace(/\.$/, "").replace(/^www\./, "");
  const target = (host + u.pathname).toLowerCase();
  return patterns.some((p) => patternRegExp(p).test(target));
}
