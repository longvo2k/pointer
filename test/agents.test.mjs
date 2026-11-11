// Agents: the name people see, and one colour per agent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { agentLabel, agentColour, PALETTE } from "../extension/agents.js";

test("known agents get their colour and name", () => {
  assert.equal(agentLabel("claude-code"), "Claude");
  assert.deepEqual(agentColour("claude-code"), { key: "claude", ...PALETTE.claude });
  assert.equal(agentColour("claude-code").group, "orange");
  assert.equal(agentLabel("codex-mcp-client"), "Codex");
  assert.equal(agentColour("codex-mcp-client").group, "green");
  assert.equal(agentLabel("Cursor-VSCode"), "Cursor");
  assert.equal(agentColour("Cursor-VSCode").group, "cyan");
});

test("other names hash to a spare colour", () => {
  assert.equal(agentLabel("abc"), "abc");
  assert.equal(agentColour("abc").key, "blue");
  assert.deepEqual(agentColour("abc"), agentColour("abc"));
  for (const name of ["opencode", "goose", "my-bot", "x"]) {
    assert.ok(["blue", "pink", "purple"].includes(agentColour(name).key), name);
  }
});

test("odd names", () => {
  assert.equal(agentLabel(""), "agent");
  assert.equal(agentLabel(undefined), "agent");
  assert.deepEqual(agentColour(""), agentColour("agent"));
  assert.equal(agentLabel("  my agent  "), "my agent");
});

test("the palette matches the spec", () => {
  assert.deepEqual(PALETTE.claude, { group: "orange", edge: "#d97757", strong: "#b4532f", light: "#f4b49a", soft: "#fde0d2" });
  assert.deepEqual(PALETTE.codex, { group: "green", edge: "#10a37f", strong: "#0b7a5e", light: "#6ee7b7", soft: "#c9f5e4" });
  assert.deepEqual(PALETTE.cursor, { group: "cyan", edge: "#06b6d4", strong: "#0e7490", light: "#67e8f9", soft: "#c8f3fb" });
  assert.deepEqual(PALETTE.blue, { group: "blue", edge: "#3b82f6", strong: "#1d4ed8", light: "#93c5fd", soft: "#dbe8fe" });
  assert.deepEqual(PALETTE.pink, { group: "pink", edge: "#ec4899", strong: "#be185d", light: "#f9a8d4", soft: "#fbd5e8" });
  assert.deepEqual(PALETTE.purple, { group: "purple", edge: "#8b5cf6", strong: "#6d28d9", light: "#c4b5fd", soft: "#e4dcfd" });
});

test("a very long name stays itself and gets a spare colour", () => {
  const name = "x".repeat(500);
  assert.equal(agentLabel(name), name);
  assert.ok(["blue", "pink", "purple"].includes(agentColour(name).key));
});
