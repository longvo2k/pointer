import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const mod = new URL("../lib/debug.mjs", import.meta.url).href;
const run = (env) =>
  execFileSync(
    process.execPath,
    ["--input-type=module", "-e", `const { timed } = await import(${JSON.stringify(mod)}); await timed("rpc page.act", Promise.resolve(1)); await timed("rpc page.fill", Promise.reject(new Error("nope"))).catch(() => {});`],
    { env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );

test("POINTER_DEBUG=<file> logs how long each step took", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "pointer-")), "debug.log");
  run({ POINTER_DEBUG: file });
  const log = readFileSync(file, "utf8");
  assert.match(log, /rpc page\.act \d+ms\n/);
  assert.match(log, /rpc page\.fill \d+ms failed: nope/);
});

test("without POINTER_DEBUG nothing is logged", () => {
  const out = run({ POINTER_DEBUG: "" });
  assert.equal(out, "");
});
