#!/usr/bin/env node
/**
 * MCP stdio server for Pointer.
 *
 * Add to Claude Code / Cursor / OpenCode:
 *   { "command": "node", "args": ["/absolute/path/to/pointer/bin/mcp.mjs"] }
 *
 * It talks to the same local hub as the CLI, so a shell-based agent and an MCP
 * agent can drive the same browser.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { health } from "../lib/hub.mjs";
import { TOOLS, callTool } from "../lib/tools.mjs";

const PORT = Number(process.env.POINTER_PORT || 8790);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureHub() {
  const up = await health(PORT);
  if (up) return;
  const entry = fileURLToPath(new URL("./pointer.mjs", import.meta.url));
  const child = spawn(process.execPath, [entry, "serve", "--quiet"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, POINTER_PORT: String(PORT) },
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    if (await health(PORT)) return;
  }
  throw new Error(`Hub did not start on port ${PORT}`);
}

async function rpc(method, params = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(body.error);
  return body.result;
}

const hub = { port: PORT, call: rpc };

function reply(id, result, error) {
  if (id === undefined || id === null) return; // notification
  const payload = error
    ? { jsonrpc: "2.0", id, error: { code: -32000, message: String(error.message || error) } }
    : { jsonrpc: "2.0", id, result };
  process.stdout.write(JSON.stringify(payload) + "\n");
}

async function handle(msg) {
  if (!msg || msg.jsonrpc !== "2.0") return;
  const { id, method, params } = msg;

  if (method === "initialize") {
    return reply(id, {
      protocolVersion: params?.protocolVersion || "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "pointer", title: "Pointer", version: "0.2.13" },
      instructions:
        "Drives the human's real Chrome tab with a visible pointer. Snapshot first, act by ref. " +
        "The human can stop you with Escape or by clicking; respect that and ask before resuming.",
    });
  }

  if (method === "notifications/initialized") return;
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") return reply(id, { tools: TOOLS });
  if (method === "resources/list") return reply(id, { resources: [] });
  if (method === "prompts/list") return reply(id, { prompts: [] });

  if (method === "tools/call") {
    const name = params?.name;
    const toolArgs = params?.arguments || {};
    try {
      const out = await callTool(hub, name, toolArgs);
      const content = [];
      if (out.image) content.push({ type: "image", data: out.image.data, mimeType: out.image.mimeType });
      if (out.text) content.push({ type: "text", text: out.text });
      return reply(id, { content, isError: false });
    } catch (err) {
      return reply(id, {
        content: [{ type: "text", text: err?.message || String(err) }],
        isError: true,
      });
    }
  }

  reply(id, null, new Error(`Method not found: ${method}`));
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg).catch((err) => reply(msg?.id, null, err));
  }
});

await ensureHub().catch((err) => {
  // Surface it on the first tool call rather than dying at startup.
  process.stderr.write(`[pointer] ${err.message}\n`);
});
