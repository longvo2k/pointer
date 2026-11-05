// Verification: which captured request proves an action reached the server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRequestSpec, matchRequest, combine } from "../extension/verify.js";

const POST = { method: "POST", path: "/api/items" };
const entry = (o) => ({ id: "1", method: "POST", url: "https://a.com/api/items", at: 100, ...o });

test("a request spec is an optional method and a piece of the URL", () => {
  assert.deepEqual(parseRequestSpec("post /api/items"), { method: "POST", path: "/api/items" });
  assert.deepEqual(parseRequestSpec("/x"), { method: null, path: "/x" });
  assert.deepEqual(parseRequestSpec("  GET   /search?q=1 "), { method: "GET", path: "/search?q=1" });
  assert.throws(() => parseRequestSpec("  "));
});

test("a matching 2xx request after the action passes", () => {
  const r = matchRequest([entry({ status: 201 })], POST, { since: 50 });
  assert.equal(r.state, "pass");
  assert.equal(r.entry.status, 201);
});

test("a request sent before the action never counts", () => {
  const r = matchRequest([entry({ status: 201, at: 100 })], POST, { since: 150 });
  assert.equal(r.state, "pending");
  assert.equal(r.reason, "no matching request");
});

test("a wrong status or a network error fails", () => {
  assert.equal(matchRequest([entry({ status: 422 })], POST, { since: 0 }).state, "fail");
  assert.equal(matchRequest([entry({ status: 422 })], POST, { since: 0 }).entry.status, 422);
  assert.equal(matchRequest([entry({ failed: "net::ERR_FAILED" })], POST, { since: 0 }).state, "fail");
});

test("a request still in flight is pending with its own reason", () => {
  const r = matchRequest([entry({})], POST, { since: 0 });
  assert.equal(r.state, "pending");
  assert.equal(r.reason, "no response yet");
});

test("the method must match when given; any method when not", () => {
  assert.equal(matchRequest([entry({ method: "GET", status: 200 })], POST, { since: 0 }).state, "pending");
  assert.equal(matchRequest([entry({ method: "GET", status: 200 })], { method: null, path: "/api/items" }, { since: 0 }).state, "pass");
});

test("an expected status replaces the 2xx rule", () => {
  assert.equal(matchRequest([entry({ status: 422 })], POST, { since: 0, status: 422 }).state, "pass");
  assert.equal(matchRequest([entry({ status: 200 })], POST, { since: 0, status: 201 }).state, "fail");
});

test("the most recent match decides", () => {
  const list = [entry({ id: "1", status: 500, at: 10 }), entry({ id: "2", status: 200, at: 20 })];
  assert.equal(matchRequest(list, POST, { since: 0 }).state, "pass");
  assert.equal(matchRequest(list, POST, { since: 0 }).entry.id, "2");
});

test("results combine: any fail fails, any pending waits, else pass", () => {
  assert.equal(combine([{ state: "pass" }, { state: "pending" }]), "pending");
  assert.equal(combine([{ state: "pending" }, { state: "fail" }]), "fail");
  assert.equal(combine([{ state: "pass" }, { state: "pass" }]), "pass");
});
