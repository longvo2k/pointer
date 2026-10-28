#!/usr/bin/env node
// Set the version everywhere it is written down:
//   npm run release 0.2.22
// Then commit as "chore: release 0.2.22" and merge the PR. The Release
// workflow tags it and publishes to npm and the Chrome Web Store.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version || "")) {
  console.error("usage: npm run release <major.minor.patch>");
  process.exit(1);
}

function edit(file, pattern, replacement) {
  const before = readFileSync(file, "utf8");
  if (!pattern.test(before)) throw new Error(`No version found in ${file}`);
  writeFileSync(file, before.replace(pattern, replacement));
  console.log(`  ${file}`);
}

const current = JSON.parse(readFileSync("package.json", "utf8")).version;
if (current === version) {
  console.error(`Already at ${version}.`);
  process.exit(1);
}
console.log(`${current} → ${version}`);
// package.json and package-lock.json together, without a commit or tag.
execFileSync("npm", ["version", version, "--no-git-tag-version", "--allow-same-version"], { stdio: "ignore" });
console.log("  package.json, package-lock.json");
edit("extension/manifest.json", /("version":\s*")[^"]+(")/, `$1${version}$2`);
edit("extension/background.js", /^(const BUILD = ")[^"]+(";)/m, `$1${version}$2`);
edit("bin/mcp.mjs", /(serverInfo: \{[^}]*version: ")[^"]+(")/, `$1${version}$2`);
