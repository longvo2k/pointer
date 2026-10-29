// The /pointer command an MCP client shows: the human picks Pointer for a task.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PROMPTS, getPrompt } from "../lib/prompts.mjs";

test("the pointer prompt is listed with an optional task", () => {
  const p = PROMPTS.find((x) => x.name === "pointer");
  assert.ok(p, "pointer prompt listed");
  assert.deepEqual(p.arguments.map((a) => [a.name, a.required]), [["task", false]]);
});

test("a task becomes a request to do it with Pointer, not another browser tool", () => {
  const { messages } = getPrompt("pointer", { task: "sign up on example.com" });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
  const text = messages[0].content.text;
  assert.match(text, /sign up on example\.com/);
  assert.match(text, /Pointer/);
  assert.match(text, /not another browser tool/i);
});

test("without a task, it checks the connection and asks what to do", () => {
  for (const args of [undefined, {}, { task: "   " }]) {
    const text = getPrompt("pointer", args).messages[0].content.text;
    assert.match(text, /browser_status/);
    assert.match(text, /ask/i);
  }
});

test("an unknown prompt is an error", () => {
  assert.throws(() => getPrompt("nope", {}), /Unknown prompt: nope/);
});
