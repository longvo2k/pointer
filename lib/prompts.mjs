/**
 * MCP prompts. Clients show these as slash commands (Claude Code: /mcp__pointer__pointer,
 * VS Code: /mcp.pointer.pointer), so the human can pick Pointer for a task by name.
 */

export const PROMPTS = [
  {
    name: "pointer",
    title: "Pointer",
    description: "Do a task in your real Chrome with Pointer, with a visible pointer you can follow.",
    arguments: [
      {
        name: "task",
        description: "What to do in the browser, for example: sign up on example.com with my work email",
        required: false,
      },
    ],
  },
];

export function getPrompt(name, args = {}) {
  if (name !== "pointer") throw new Error(`Unknown prompt: ${name}`);
  const task = typeof args?.task === "string" ? args.task.trim() : "";
  const text = task
    ? "The human chose Pointer for this task. Do it in their real Chrome with Pointer's tools, " +
      "not another browser tool. Check browser_status first, snapshot, then act by ref.\n\n" +
      `Task: ${task}`
    : "The human chose Pointer. Check browser_status, report whether Chrome is connected, " +
      "and ask what they want done in their browser.";
  return {
    description: "Do a task in your real Chrome with Pointer",
    messages: [{ role: "user", content: { type: "text", text } }],
  };
}
