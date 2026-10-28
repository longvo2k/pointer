// Blocked sites: patterns the human types, and which URLs they cover.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSitePattern, isBlockedUrl } from "../extension/sites.js";

test("patterns are normalised", () => {
  assert.equal(normalizeSitePattern("https://www.MyBank.com"), "mybank.com/*");
  assert.equal(normalizeSitePattern("admin.example.com/*"), "admin.example.com/*");
  assert.equal(normalizeSitePattern("  github.com/MyOrg/*  "), "github.com/myorg/*");
  assert.equal(normalizeSitePattern("*.mybank.com"), "*.mybank.com/*");
  for (const bad of ["", "   ", "http://", "chrome://settings", "file:///etc"]) {
    assert.throws(() => normalizeSitePattern(bad), undefined, `should refuse ${JSON.stringify(bad)}`);
  }
});

test("a blocked domain covers its pages, not look-alikes", () => {
  const p = ["mybank.com/*"];
  assert.equal(isBlockedUrl("https://www.mybank.com/login", p), true);
  assert.equal(isBlockedUrl("https://MyBank.com:8443/", p), true);
  assert.equal(isBlockedUrl("https://user@mybank.com/", p), true);
  assert.equal(isBlockedUrl("https://mybank.com.evil.io/", p), false);
  assert.equal(isBlockedUrl("https://mybank.com@evil.io/", p), false);
  assert.equal(isBlockedUrl("https://notmybank.com/", p), false);
});

test("subdomain and path patterns", () => {
  assert.equal(isBlockedUrl("https://a.b.mybank.com/x", ["*.mybank.com/*"]), true);
  assert.equal(isBlockedUrl("https://github.com/myorg/repo", ["github.com/myorg/*"]), true);
  assert.equal(isBlockedUrl("https://github.com/MyOrg/Repo", ["github.com/myorg/*"]), true);
  assert.equal(isBlockedUrl("https://github.com/other", ["github.com/myorg/*"]), false);
});

test("non-web URLs and empty lists are never blocked", () => {
  assert.equal(isBlockedUrl("about:blank", ["*"]), false);
  assert.equal(isBlockedUrl("not a url", ["*"]), false);
  assert.equal(isBlockedUrl("https://mybank.com/", []), false);
});
