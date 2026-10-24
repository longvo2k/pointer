#!/usr/bin/env node
/**
 * Pointer CLI.
 *
 *   pointer serve            run the local hub (the extension connects to it)
 *   pointer status           is the extension connected?
 *   pointer open <url>       open a background tab (--focus to bring it forward)
 *   pointer tabs             list tabs
 *   pointer focus <tabId>
 *   pointer snap [--all] [--hrefs]  on-screen elements with refs
 *   pointer find <words>     search the whole page for elements
 *   pointer click <ref|css>
 *   pointer hover <ref|css>  move the pointer onto an element without clicking
 *   pointer nav back|forward|reload  (also: pointer back, pointer forward)
 *   pointer fill <ref|css> <text...>
 *   pointer press <key>
 *   pointer scroll [up|down] [px]
 *   pointer text             read the page as text
 *   pointer shot [path]      screenshot (saves PNG, prints path)
 *   pointer viewport mobile  emulate a screen size (tablet, desktop, W H, reset)
 *   pointer layout           check spacing, overflow, overlaps, tap targets
 *   pointer stop             hide the pointer and stop
 *   pointer resume           continue after a human stop (ask first)
 *   pointer setup            show install paths and open chrome://extensions
 *
 * Any command except `setup` and `serve` auto-starts the hub if it is not already running.
 */

import { existsSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Hub, health } from "../lib/hub.mjs";
import { TOOLS, callTool } from "../lib/tools.mjs";

const PORT = Number(process.env.POINTER_PORT || 8790);
const ROOT = fileURLToPath(new URL("../", import.meta.url));
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

function openExternal(cmd, args, opts) {
  try {
    return spawnSync(cmd, args, { stdio: "ignore", ...opts }).status === 0;
  } catch {
    return false;
  }
}

/** Print the install layout and get the human to the extension folder. */
function setup(open) {
  const ext = path.join(ROOT, "extension");
  const mcp = path.join(ROOT, "bin", "mcp.mjs");

  console.log("Pointer install");
  console.log("  checkout   " + ROOT);
  console.log("  extension  " + ext);
  console.log("  MCP        node " + mcp);
  console.log("");

  if (!existsSync(ext)) {
    console.error("✗ extension/ is missing from this checkout");
    process.exitCode = 1;
    return;
  }

  let opened = false;
  let copied = false;

  if (open) {
    if (process.platform === "darwin") {
      const chrome = ["Google Chrome", "Google Chrome Beta", "Chromium", "Microsoft Edge"]
        .find((app) => openExternal("open", ["-Ra", app]));
      if (chrome) opened = openExternal("open", ["-a", chrome, "chrome://extensions"]);
      openExternal("open", ["-R", ext]);
      copied = openExternal("pbcopy", [], { input: ext });
    } else if (process.platform === "linux") {
      opened = openExternal("xdg-open", ["chrome://extensions"]);
      openExternal("xdg-open", [ext]);
    } else if (process.platform === "win32") {
      opened = openExternal("cmd", ["/c", "start", "", "chrome", "chrome://extensions"]);
      openExternal("explorer", [ext]);
    }
  }

  console.log("Load the Chrome extension (once):");
  console.log("  1. open chrome://extensions" + (opened ? " (opened for you)" : ""));
  console.log("  2. turn on Developer mode");
  console.log("  3. Load unpacked → choose the extension folder above");
  if (copied) console.log("     (path copied to clipboard)");
  console.log("");
  console.log("Check the wiring:");
  console.log("  pointer status");
  console.log("  pointer open news.ycombinator.com");
  console.log("");
  console.log("Connect an MCP agent (Claude Code, Cursor, OpenCode, …):");
  console.log(
    JSON.stringify(
      { mcpServers: { pointer: { command: process.execPath, args: [mcp] } } },
      null,
      2
    )
  );
  if (openExternal("which", ["claude"])) {
    console.log("");
    console.log("Or register it with Claude Code directly:");
    console.log(`  claude mcp add pointer -- ${process.execPath} ${mcp}`);
  }
}

async function main() {
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(usage());
    return;
  }

  if (cmd === "setup") {
    setup(!args.includes("--no-open"));
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
    console.log("Run `pointer setup` to open chrome://extensions and show the extension folder.");
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
              `connected ${age}` +
              (b.lastFocusedAt ? `  focused ${Math.round((now - b.lastFocusedAt) / 1000)}s ago` : "") +
              (b.pinned ? "  (pinned)" : "") +
              (b.stale ? `  ⚠ stale: files are v${b.version}, Chrome runs ${b.build}. Remove + Load unpacked.` : "")
            );
          })
          .join("\n")
      );
    }
    case "use": {
      if (!rest[0]) throw new Error("Usage: pointer use <browserId>");
      const res = await rpc("ext.use", { id: rest[0] });
      return print(
        res.pinned
          ? `pinned to ${res.active.slice(0, 8)} (pointer use auto to follow the profile you use)`
          : `following the profile you use${res.active ? ` (now ${res.active.slice(0, 8)})` : ""}`
      );
    }
    case "reload":
      return print(`reloading ${(await rpc("ext.reloadAll")).reloading} extension(s)`);
    case "tabs":
      return print((await tool("tabs_list")).text);
    case "open": {
      const url = rest.find((a) => a !== "--focus");
      if (!url) throw new Error("Usage: pointer open <url> [--focus]");
      return print((await tool("tab_open", { url, focus: rest.includes("--focus") })).text);
    }
    case "select":
      if (!rest[0]) throw new Error("Usage: pointer select <tabId>");
      return print((await tool("tab_select", { tabId: Number(rest[0]) })).text);
    case "close":
      return print(
        (await tool("tab_close", rest[0] === "--all" ? { all: true } : rest[0] ? { tabId: Number(rest[0]) } : {})).text
      );
    case "focus":
      if (!rest[0]) throw new Error("Usage: pointer focus <tabId>");
      return print((await tool("tab_focus", { tabId: Number(rest[0]) })).text);
    case "snap":
    case "snapshot":
      return print(
        (await tool("snapshot", { scope: rest.includes("--all") ? "all" : "viewport", hrefs: rest.includes("--hrefs") })).text
      );
    case "find":
      if (!rest.length) throw new Error("Usage: pointer find <words>");
      return print((await tool("find", { query: rest.join(" ") })).text);
    case "click": {
      if (!rest[0]) throw new Error("Usage: pointer click <ref|selector>");
      const target = /^@?e\d+$/.test(rest[0]) ? { ref: rest[0] } : { selector: rest[0] };
      return print((await tool("click", target)).text);
    }
    case "hover": {
      if (!rest[0]) throw new Error("Usage: pointer hover <ref|selector>");
      const target = /^@?e\d+$/.test(rest[0]) ? { ref: rest[0] } : { selector: rest[0] };
      return print((await tool("hover", target)).text);
    }
    case "back":
    case "forward":
      return print((await tool("navigate", { action: cmd })).text);
    case "nav":
    case "navigate":
      if (!["back", "forward", "reload"].includes(rest[0])) throw new Error("Usage: pointer nav back|forward|reload");
      return print((await tool("navigate", { action: rest[0] })).text);
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
    case "viewport": {
      const words = rest.filter((a) => !a.startsWith("--"));
      const mobile = rest.includes("--mobile") ? true : rest.includes("--no-mobile") ? false : undefined;
      if (!words.length) throw new Error("Usage: pointer viewport mobile|tablet|desktop|reset | <width> <height> [--mobile]");
      const args = /^\d+$/.test(words[0])
        ? { width: Number(words[0]), height: Number(words[1]) }
        : { preset: words[0] };
      return print((await tool("viewport", { ...args, ...(mobile != null ? { mobile } : {}) })).text);
    }
    case "layout":
      return print((await tool("layout", { scope: rest.includes("--screen") ? "viewport" : "all" })).text);
    case "dialog": {
      const action = rest[0];
      if (action !== "accept" && action !== "dismiss") throw new Error("Usage: pointer dialog accept|dismiss [prompt text]");
      return print((await tool("dialog", { action, text: rest.length > 1 ? rest.slice(1).join(" ") : undefined })).text);
    }
    case "upload": {
      const hasRef = /^@?e\d+$/.test(rest[0] || "");
      const paths = hasRef ? rest.slice(1) : rest;
      if (!paths.length) throw new Error("Usage: pointer upload [ref] <file...>");
      return print((await tool("upload", { ...(hasRef ? { ref: rest[0] } : {}), paths })).text);
    }
    case "console": {
      const level = ["errors", "warnings", "all"].find((l) => rest.includes(l));
      return print((await tool("console", { level, reload: rest.includes("--reload"), clear: rest.includes("--clear") })).text);
    }
    case "network":
    case "net": {
      const opt = (name) => {
        const i = rest.indexOf(name);
        return i >= 0 ? rest[i + 1] : undefined;
      };
      const flags = new Set(["--failed", "--all", "--reload", "--clear"]);
      const filter = rest.find((a, i) => !a.startsWith("--") && rest[i - 1] !== "--body" && !flags.has(a));
      return print(
        (
          await tool("network", {
            filter,
            failed: rest.includes("--failed"),
            all: rest.includes("--all"),
            reload: rest.includes("--reload"),
            clear: rest.includes("--clear"),
            body: opt("--body"),
          })
        ).text
      );
    }
    case "stop":
      return print((await tool("stop")).text);
    case "resume":
      return print((await tool("resume")).text);
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
  pointer use <id>|auto         pin one Chrome profile, or follow the one you use
  pointer reload                reload every connected extension from disk
  pointer tabs                  list tabs
  pointer open <url> [--focus]  open a background tab (--focus raises it)
  pointer select <tabId>        work in a tab without bringing it forward
  pointer close [tabId|--all]   close the agent's tab(s)
  pointer focus <tabId>         bring a tab forward
  pointer snap [--all] [--hrefs] on-screen elements with refs
  pointer find <words>          search the whole page for elements
  pointer click <ref|selector>  move the pointer, then click
  pointer hover <ref|selector>  move the pointer onto it, no click (hover menus, tooltips)
  pointer fill <ref|selector> <text>
  pointer nav back|forward|reload  history and page reload (back, forward work alone too)
  pointer press <key>
  pointer scroll [up|down] [px]
  pointer text                  page as readable text
  pointer shot [path]           screenshot (pointer included)
  pointer viewport <preset|W H> emulate mobile, tablet, desktop, or W H [--mobile]; reset when done
  pointer layout [--screen]     find overflow, clipped text, overlaps, small targets, tight padding, uneven gaps
  pointer dialog accept|dismiss [text]  answer an alert/confirm/prompt
  pointer upload [ref] <file...>       attach files to a file input
  pointer console [errors|warnings|all] [--reload]
  pointer network [filter] [--failed] [--all] [--reload] [--body <id>]
  pointer stop                  hide pointer, stop acting
  pointer resume                continue after the human stopped the agent (ask them first)
  pointer setup [--no-open]     show install paths, open chrome://extensions

  env: POINTER_PORT (8790), POINTER_FOCUS_WINDOW=0, POINTER_AGENT=<name>`;
}

main().catch(fail);
