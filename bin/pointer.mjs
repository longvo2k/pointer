#!/usr/bin/env node
/**
 * Pointer CLI.
 *
 *   pointer serve            run the local hub (the extension connects to it)
 *   pointer status           is the extension connected?
 *   pointer open <url>       open a tab and bring it forward
 *   pointer tabs             list tabs
 *   pointer focus <tabId>
 *   pointer snap             interactive elements with refs
 *   pointer click <ref|css>
 *   pointer fill <ref|css> <text...>
 *   pointer press <key>
 *   pointer scroll [up|down] [px]
 *   pointer text             read the page as text
 *   pointer shot [path]      screenshot (saves PNG, prints path)
 *   pointer stop             hide the pointer and stop
 *
 * Any command except `serve` auto-starts the hub if it is not already running.
 */

import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Hub, health } from "../lib/hub.mjs";
import { TOOLS, callTool } from "../lib/tools.mjs";

const PORT = Number(process.env.POINTER_PORT || 8790);
const argv = process.argv.slice(2);
const jsonOut = argv.includes("--json");
const args = argv.filter((a) => a !== "--json");
const [cmd, ...rest] = args;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureHub() {
  const up = await health(PORT);
  if (up) return up;
  const entry = fileURLToPath(new URL("./pointer.mjs", import.meta.url));
  const child = spawn(process.execPath, [entry, "serve", "--quiet"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, POINTER_PORT: String(PORT) },
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    const h = await health(PORT);
    if (h) return h;
  }
  throw new Error("Could not start the local hub on port " + PORT);
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

async function tool(name, params) {
  const hub = { port: PORT, call: rpc };
  return callTool(hub, name, params);
}

function print(text) {
  if (jsonOut) console.log(JSON.stringify({ ok: true, result: text }, null, 2));
  else console.log(text);
}

function fail(err) {
  if (jsonOut) console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
  else console.error("✗ " + err.message);
  process.exitCode = 1;
}

async function main() {
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(usage());
    return;
  }

  if (cmd === "serve") {
    if (args.includes("--quiet")) {
      // Detached child: prove it is alive, then exit quietly.
      const hub = new Hub({ port: PORT, log: () => {} });
      await hub.start();
      process.on("SIGTERM", () => hub.stop().then(() => process.exit(0)));
      return;
    }
    const hub = new Hub({ port: PORT, log: (m) => console.log("[hub] " + m) });
    await hub.start();
    console.log(`pointer hub ready on http://127.0.0.1:${PORT}`);
    console.log("Load extension/ at chrome://extensions (Developer mode → Load unpacked).");
    const shutdown = async () => {
      await hub.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }

  await ensureHub();

  switch (cmd) {
    case "status":
      return print((await tool("browser_status")).text);
    case "browsers": {
      const list = await rpc("ext.list");
      if (!list.length) return print("No browser connected.");
      const now = Date.now();
      return print(
        list
          .map((b) => {
            const age = b.connectedAt ? `${Math.round((now - b.connectedAt) / 1000)}s` : "?";
            return (
              `${b.active ? "→" : " "} ${b.id.slice(0, 8)}  ` +
              `build ${b.build || "unknown"}  ` +
              `instance ${b.instanceId ? b.instanceId.slice(0, 8) : "?"}  ` +
              `connected ${age}`
            );
          })
          .join("\n")
      );
    }
    case "use": {
      if (!rest[0]) throw new Error("Usage: pointer use <browserId>");
      const res = await rpc("ext.use", { id: rest[0] });
      return print(`active browser ${res.active.slice(0, 8)}`);
    }
    case "reload":
      return print(`reloading ${(await rpc("ext.reloadAll")).reloading} extension(s)`);
    case "tabs":
      return print((await tool("tabs_list")).text);
    case "open":
      if (!rest[0]) throw new Error("Usage: pointer open <url>");
      return print((await tool("tab_open", { url: rest[0] })).text);
    case "focus":
      if (!rest[0]) throw new Error("Usage: pointer focus <tabId>");
      return print((await tool("tab_focus", { tabId: Number(rest[0]) })).text);
    case "snap":
    case "snapshot":
      return print((await tool("snapshot")).text);
    case "click": {
      if (!rest[0]) throw new Error("Usage: pointer click <ref|selector>");
      const target = /^@?e\d+$/.test(rest[0]) ? { ref: rest[0] } : { selector: rest[0] };
      return print((await tool("click", target)).text);
    }
    case "fill":
    case "type": {
      if (!rest[0]) throw new Error("Usage: pointer fill <ref|selector> <text>");
      const target = /^@?e\d+$/.test(rest[0]) ? { ref: rest[0] } : { selector: rest[0] };
      return print((await tool("fill", { ...target, text: rest.slice(1).join(" ") })).text);
    }
    case "press":
      return print((await tool("press", { key: rest.join(" ") || "Enter" })).text);
    case "scroll":
      return print(
        (await tool("scroll", { direction: rest[0] || "down", amount: rest[1] ? Number(rest[1]) : undefined })).text
      );
    case "text":
    case "read":
      return print((await tool("read_text")).text);
    case "wait":
      return print((await tool("wait_for", /^\d+$/.test(rest[0] || "") ? { ms: Number(rest[0]) } : { text: rest.join(" ") })).text);
    case "shot":
    case "screenshot": {
      const res = await tool("screenshot");
      const path = rest[0] || `pointer-${Date.now()}.png`;
      writeFileSync(path, Buffer.from(res.image.data, "base64"));
      return print(`saved ${path}`);
    }
    case "stop":
      return print((await tool("stop")).text);
    case "tools":
      return print(TOOLS.map((t) => `${t.name}\t${t.description.split(".")[0]}`).join("\n"));
    default:
      throw new Error(`Unknown command: ${cmd}\n\n${usage()}`);
  }
}

function usage() {
  return `pointer — visible browser control for any agent

  pointer serve                 run the hub (extension connects to it)
  pointer status                connection + tab state
  pointer browsers              list connected Chrome instances
  pointer use <id>              route actions to one Chrome instance
  pointer reload                reload every connected extension from disk
  pointer tabs                  list tabs
  pointer open <url>            open and focus a tab
  pointer focus <tabId>         bring a tab forward
  pointer snap                  interactive elements with refs
  pointer click <ref|selector>  move the pointer, then click
  pointer fill <ref|selector> <text>
  pointer press <key>
  pointer scroll [up|down] [px]
  pointer text                  page as readable text
  pointer shot [path]           screenshot (pointer included)
  pointer stop                  hide pointer, stop acting

  env: POINTER_PORT (8790), POINTER_FOCUS_WINDOW=0, POINTER_AGENT=<name>`;
}

main().catch(fail);
