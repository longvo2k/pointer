/** Tool surface shared by the MCP server and the CLI. */

import { existsSync, statSync } from "node:fs";
import path from "node:path";

export const TOOLS = [
  {
    name: "browser_status",
    description: "Check whether the Chrome extension is connected, and which browser/profile it is driving.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "tabs_list",
    description: "List open tabs with their tabId, title and URL. The agent's working tab is marked [agent].",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "tab_open",
    description:
      "Open a URL in a new background tab in the agent's tab group and wait for it to load. " +
      "The human stays on whatever tab or window they are using. Pass focus: true only when the human asks to watch.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL, or a bare domain like example.com" },
        focus: { type: "boolean", description: "Bring the new tab to the front (default false)" },
      },
      required: ["url"],
    },
  },
  {
    name: "tab_select",
    description:
      "Make an existing tab the one you work in, without bringing it forward. Use this to switch tabs; " +
      "the human stays where they are.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number" } },
      required: ["tabId"],
    },
  },
  {
    name: "tab_close",
    description:
      "Close a tab you opened or worked in (default: your current tab), or all of them with all: true. " +
      "Clean up when the task is done. Never closes the human's other tabs.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number" }, all: { type: "boolean" } },
    },
  },
  {
    name: "tab_focus",
    description:
      "Bring a tab to the front of the human's window. Only when the human asks to watch; to switch tabs use tab_select.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        focusWindow: { type: "boolean", description: "Also raise the OS window (default true)" },
      },
      required: ["tabId"],
    },
  },
  {
    name: "snapshot",
    description:
      "List the interactive elements on screen as compact text, each with a ref (e1, e2...). " +
      "Refs stay valid until the page navigates. Elements off screen are counted, not listed: scroll, use find, " +
      "or pass scope \"all\". click/fill/press/scroll already report what changed, so you rarely need to snapshot after them.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["viewport", "all"], description: "viewport (default) or the whole page" },
        hrefs: { type: "boolean", description: "Include link targets (default false)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "find",
    description:
      "Search the whole page (on screen or not) for interactive elements matching words, e.g. \"sign up button\" " +
      "or \"email\". Returns a few lines with refs, cheaper than a full snapshot. Off-screen matches are marked; click scrolls to them.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", description: "Max results, default 8" },
      },
      required: ["query"],
    },
  },
  {
    name: "click",
    description:
      "Click an element by ref or CSS selector. The pointer moves to it in the agent's tab, then a trusted click is dispatched. " +
      "Does not bring the tab to the front. Returns what changed on screen (+ added, - removed, ~ changed), " +
      "or the new view if the page navigated.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Ref from the latest snapshot, e.g. e3" },
        selector: { type: "string", description: "CSS selector, if you have no ref" },
      },
    },
  },
  {
    name: "fill",
    description: "Click a field, clear it, and type text using trusted input. Optionally submit with Enter. Returns what changed on screen.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        selector: { type: "string" },
        text: { type: "string" },
        submit: { type: "boolean", description: "Press Enter after typing" },
      },
      required: ["text"],
    },
  },
  {
    name: "press",
    description: "Press a key or chord in the focused page (Enter, Tab, Escape, Control+a, ...).",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
  {
    name: "scroll",
    description: "Scroll the page, or bring an element into view by ref. Returns the elements that came into view.",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        amount: { type: "number", description: "Pixels, default 600" },
        ref: { type: "string", description: "Scroll this element into view instead" },
      },
    },
  },
  {
    name: "read_text",
    description: "Read the visible text of the page (no HTML), truncated to a token-safe length.",
    inputSchema: {
      type: "object",
      properties: { maxChars: { type: "number" } },
    },
  },
  {
    name: "wait_for",
    description: "Wait for text to appear, a selector to exist, or a fixed number of milliseconds.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        selector: { type: "string" },
        ms: { type: "number" },
      },
    },
  },
  {
    name: "screenshot",
    description:
      "Capture the agent's tab as a PNG, even when it is in the background. Includes the pointer overlay.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "viewport",
    description:
      "Emulate a screen size in the agent's tab to test responsive layouts: preset mobile (375x812), tablet " +
      "(768x1024) or desktop (1440x900), or a custom width and height. Only the agent's tab changes; the human's " +
      "window and tabs keep their size. Returns the new view. Pass preset \"reset\" when done.",
    inputSchema: {
      type: "object",
      properties: {
        preset: { type: "string", enum: ["mobile", "tablet", "desktop", "reset"] },
        width: { type: "number", description: "CSS pixels, 200-4000 (use with height instead of a preset)" },
        height: { type: "number", description: "CSS pixels, 200-4000" },
        mobile: {
          type: "boolean",
          description: "Behave like a phone or tablet: touch input and mobile viewport rules. Default: true for mobile and tablet, false otherwise",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "dialog",
    description:
      "Accept or dismiss an alert/confirm/prompt the page opened. click, fill and press report when one opens. " +
      "Confirm with the human before accepting anything destructive.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["accept", "dismiss"] },
        text: { type: "string", description: "Answer for a prompt() dialog" },
      },
      required: ["action"],
    },
  },
  {
    name: "upload",
    description:
      "Attach local files to a file input. Pass the ref of the upload button, label, or input (styled buttons work); " +
      "with no ref, the page's first file input. Only upload files the human named.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        selector: { type: "string" },
        paths: { type: "array", items: { type: "string" }, description: "Local file paths" },
      },
      required: ["paths"],
    },
  },
  {
    name: "console",
    description:
      "Read the tab's console messages and uncaught errors. Capture starts on the first call (off before, to keep the " +
      "browser's normal fingerprint); pass reload: true to capture a page load.",
    inputSchema: {
      type: "object",
      properties: {
        level: { type: "string", enum: ["errors", "warnings", "all"], description: "Default warnings (errors + warnings)" },
        limit: { type: "number", description: "Most recent N, default 30" },
        reload: { type: "boolean", description: "Reload the tab after starting capture" },
        clear: { type: "boolean", description: "Clear the buffer after reading" },
      },
    },
  },
  {
    name: "network",
    description:
      "List the tab's network requests (fetch/XHR, documents, and failures by default). Capture starts on the first call; " +
      "pass reload: true to capture a page load. Pass body: <id> to read one response body.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Only URLs containing this text" },
        failed: { type: "boolean", description: "Only failed requests and HTTP errors" },
        all: { type: "boolean", description: "Include images, scripts, styles, fonts" },
        limit: { type: "number", description: "Most recent N, default 30" },
        body: { type: "string", description: "Request id to read the response body of" },
        reload: { type: "boolean" },
        clear: { type: "boolean" },
      },
    },
  },
  {
    name: "stop",
    description: "Stop acting and hide the pointer. The human can do the same with Escape or by clicking.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

/** Normalize a bare domain into a URL the browser will accept. */
export function normalizeUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("A URL is required");
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("about:")) return raw;
  return "https://" + raw.replace(/^\/+/, "");
}

export const VIEWPORT_PRESETS = {
  mobile: { width: 375, height: 812, deviceScaleFactor: 3, mobile: true },
  tablet: { width: 768, height: 1024, deviceScaleFactor: 2, mobile: true },
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
};

/** Turn viewport tool arguments into a screen size to emulate, or { reset: true }. */
export function resolveViewport(args = {}) {
  const hasSize = args.width != null || args.height != null;
  if (args.preset === "reset") return { reset: true };
  if (args.preset != null) {
    if (hasSize) throw new Error("Pass a preset or a width and height, not both.");
    const preset = VIEWPORT_PRESETS[args.preset];
    if (!preset) throw new Error(`Unknown preset "${args.preset}". Use mobile, tablet, desktop, or reset.`);
    return { ...preset, label: args.preset, ...(args.mobile != null ? { mobile: Boolean(args.mobile) } : {}) };
  }
  if (!hasSize) throw new Error("Pass a preset (mobile, tablet, desktop, reset) or a width and height.");
  const size = (v, what) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 200 || n > 4000) throw new Error(`${what} must be a whole number from 200 to 4000.`);
    return n;
  };
  const width = size(args.width, "width");
  const height = size(args.height, "height");
  const mobile = Boolean(args.mobile);
  return { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile, label: "custom" };
}

/**
 * Turn an action's change report into a few lines, so the agent can see the
 * result without another snapshot.
 */
export function formatChanges(ch, { addedLabel = "changes in view" } = {}) {
  if (!ch) return "";
  if (ch.snapshot) {
    const why = ch.navigated ? "new page" : "page changed";
    return `\n${why}, current view:\n${ch.snapshot}`;
  }
  const strip = (line) => line.replace(/^- /, "");
  const lines = [
    ...ch.added.map((l) => "+ " + strip(l)),
    ...ch.removed.map((l) => "- " + strip(l)),
    ...ch.changed.map((l) => "~ " + strip(l)),
  ];
  if (ch.more) lines.push(`... ${ch.more} more`);
  if (!lines.length) return "\nno change in view";
  return `\n${addedLabel}:\n${lines.join("\n")}`;
}

const SYNTHETIC_NOTE =
  "\n(note: sent as page events because another extension's frame, often a password manager, blocks Chrome's " +
  "input driver on this page. Most sites accept them; if nothing happened, ask the human to close that popup.)";

function formatDialog(d) {
  if (!d) return "";
  const prompt = d.type === "prompt" && d.defaultPrompt ? ` (default "${d.defaultPrompt}")` : "";
  return (
    `\n${d.type} dialog opened: "${d.message}"${prompt}\n` +
    "The page is paused until it is answered. Ask the human if it matters, then call dialog accept or dismiss."
  );
}

const STATIC_TYPES = new Set(["Image", "Stylesheet", "Font", "Script", "Media", "Manifest", "Ping", "Other"]);

function kb(bytes) {
  if (bytes == null) return "";
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return (u.host + u.pathname + u.search).slice(0, 110);
  } catch {
    return String(url).slice(0, 110);
  }
}

function captureNote(res, what) {
  if (res.started && !res.reloaded) {
    return `Started capturing ${what} for this tab. Earlier activity was not recorded; act on the page or pass reload: true, then call again.`;
  }
  return "";
}

function requireTarget(args) {
  if (!args.ref && !args.selector) {
    throw new Error("Pass a ref from the latest snapshot (e.g. e3) or a CSS selector.");
  }
  const target = {};
  if (args.ref) target.ref = String(args.ref).replace(/^@/, "");
  if (args.selector) target.selector = args.selector;
  return target;
}

export async function callTool(hub, name, args = {}) {
  switch (name) {
    case "browser_status": {
      const [health, status, browsers] = await Promise.all([
        fetch(`http://127.0.0.1:${hub.port}/health`, { signal: AbortSignal.timeout(800) })
          .then((r) => r.json())
          .catch(() => ({ extension: false })),
        hub.call("ext.status", {}).catch((err) => ({ error: err.message })),
        hub.call("ext.list", {}).catch(() => []),
      ]);
      if (!health.extension) {
        return {
          text:
            "Extension: not connected.\n" +
            "Open chrome://extensions, enable Pointer, and make sure the local hub is running (pointer serve).",
        };
      }
      const groups = (status.groups || [])
        .map((g) => `${g.title || "(untitled)"} (${g.color}, ${g.tabIds?.length ?? 0} tabs)`)
        .join(", ");
      const active = browsers.find((b) => b.active);
      return {
        text: [
          "Extension: connected",
          `Hub: http://127.0.0.1:${hub.port}`,
          `Browser: ${active ? active.id.slice(0, 8) : "unknown"}` +
            (active?.stale
              ? ` (stale: Chrome runs build ${active.build} but the files are v${active.version}; ask the human to Remove and Load unpacked)`
              : ""),
          `Connected browsers: ${browsers.length}`,
          `Agent label: ${status.agentName || "agent"}`,
          `Tab group: ${groups || "—"}`,
          `Tabs with input attached: ${(status.attached || []).length}`,
        ].join("\n"),
      };
    }

    case "tabs_list": {
      const tabs = await hub.call("tabs.list", {});
      if (!tabs.length) return { text: "(no browser tabs)" };
      return {
        text: tabs
          .map(
            (t) =>
              `${t.active ? "→" : " "} [${t.tabId}]${t.agent ? " [agent]" : ""} ${(t.title || "(untitled)").slice(0, 70)} — ${t.url.slice(0, 90)}`
          )
          .join("\n"),
      };
    }

    case "tab_open": {
      const res = await hub.call("tabs.open", { url: normalizeUrl(args.url), focus: args.focus === true });
      return { text: `opened tab ${res.tabId}${res.focused ? "" : " in the background"}: ${res.url}` };
    }

    case "tab_select": {
      const res = await hub.call("tabs.select", { tabId: Number(args.tabId) });
      return { text: `working in [${res.tabId}] ${res.title || ""} — ${res.url} (not brought forward)` };
    }

    case "tab_close": {
      const res = await hub.call("tabs.close", args.all ? { all: true } : args.tabId != null ? { tabId: Number(args.tabId) } : {});
      return { text: res.closed.length ? `closed ${res.closed.map((id) => `[${id}]`).join(" ")}` : "no agent tabs to close" };
    }

    case "tab_focus": {
      const res = await hub.call("tabs.focus", {
        tabId: Number(args.tabId),
        focusWindow: args.focusWindow !== false,
      });
      return { text: `focused [${res.tabId}] ${res.title || ""} — ${res.url}` };
    }

    case "snapshot": {
      const res = await hub.call("page.snapshot", {
        scope: args.scope === "all" ? "all" : "viewport",
        hrefs: Boolean(args.hrefs),
      });
      return { text: res.text };
    }

    case "find": {
      const res = await hub.call("page.find", { query: String(args.query || ""), limit: args.limit });
      return { text: res.text };
    }

    case "click": {
      const res = await hub.call("page.act", { ...requireTarget(args), kind: "click" });
      return {
        text:
          `clicked ${res.target.role || "element"} "${res.target.name || ""}" → ${res.url}` +
          (res.dialog ? formatDialog(res.dialog) : formatChanges(res.changes)) +
          (res.synthetic ? SYNTHETIC_NOTE : ""),
      };
    }

    case "fill": {
      const res = await hub.call("page.fill", {
        ...requireTarget(args),
        text: String(args.text ?? ""),
        submit: Boolean(args.submit),
      });
      return {
        text:
          `typed into "${res.target}"${args.submit ? " and pressed Enter" : ""} → ${res.url}` +
          (res.dialog ? formatDialog(res.dialog) : formatChanges(res.changes)) +
          (res.synthetic ? SYNTHETIC_NOTE : ""),
      };
    }

    case "press": {
      const res = await hub.call("page.press", { key: args.key || "Enter" });
      return {
        text:
          `pressed ${res.key} → ${res.url}` +
          (res.dialog ? formatDialog(res.dialog) : formatChanges(res.changes)) +
          (res.synthetic ? SYNTHETIC_NOTE : ""),
      };
    }

    case "scroll": {
      const res = await hub.call("page.scroll", {
        direction: args.direction || "down",
        amount: args.amount,
        ref: args.ref,
      });
      return {
        text:
          `scrolled${res.y != null ? ` to y=${res.y}` : ""}` +
          formatChanges(res.changes, { addedLabel: "now in view" }),
      };
    }

    case "read_text": {
      const res = await hub.call("page.text", { maxChars: args.maxChars });
      return { text: res.text };
    }

    case "wait_for": {
      const res = await hub.call("page.wait", {
        text: args.text,
        selector: args.selector,
        ms: args.ms,
      });
      return { text: res.ok ? "condition met" : res.error || "timed out" };
    }

    case "screenshot": {
      const res = await hub.call("page.screenshot", {});
      const base64 = String(res.dataUrl).replace(/^data:image\/\w+;base64,/, "");
      return { image: { mimeType: "image/png", data: base64 }, text: `screenshot of ${res.url}` };
    }

    case "viewport": {
      const spec = resolveViewport(args);
      const res = await hub.call("page.viewport", spec);
      if (spec.reset) return { text: `viewport reset to the window's size → ${res.url}\ncurrent view:\n${res.snapshot}` };
      const tags = [spec.label, ...(spec.mobile ? ["touch"] : [])].join(", ");
      return {
        text:
          `viewport ${spec.width}x${spec.height} (${tags}) → ${res.url}\n` +
          `current view:\n${res.snapshot}`,
      };
    }

    case "dialog": {
      if (args.action !== "accept" && args.action !== "dismiss") throw new Error('action must be "accept" or "dismiss"');
      const res = await hub.call("page.dialog", { action: args.action, text: args.text });
      const what = res.dialog ? `${res.dialog.type} "${res.dialog.message}"` : "dialog";
      return { text: `${args.action === "accept" ? "accepted" : "dismissed"} ${what} → ${res.url}` };
    }

    case "upload": {
      const list = Array.isArray(args.paths) ? args.paths : [args.paths].filter(Boolean);
      const files = list.map((f) => path.resolve(String(f).replace(/^~(?=$|\/)/, process.env.HOME || "~")));
      for (const f of files) {
        if (!existsSync(f) || !statSync(f).isFile()) throw new Error(`Not a file: ${f}`);
      }
      const target = {};
      if (args.ref) target.ref = String(args.ref).replace(/^@/, "");
      if (args.selector) target.selector = args.selector;
      const res = await hub.call("page.upload", { ...target, paths: files });
      return {
        text:
          `attached ${res.files} file${res.files === 1 ? "" : "s"} to "${res.target}"` +
          (res.accept ? ` (accepts ${res.accept})` : "") +
          ` → ${res.url}` +
          formatChanges(res.changes),
      };
    }

    case "console": {
      const res = await hub.call("page.console", { reload: Boolean(args.reload), clear: Boolean(args.clear) });
      const level = args.level || "warnings";
      const keep = level === "all" ? () => true : level === "errors" ? (e) => e.level === "error" : (e) => e.level === "error" || e.level === "warning";
      const rows = res.entries.filter(keep);
      const limit = Math.max(1, Math.min(Number(args.limit) || 30, 200));
      const shown = rows.slice(-limit).map((e) => `${e.level.padEnd(7)} ${String(e.text).replace(/\s+/g, " ").slice(0, 300)}`);
      const note = captureNote(res, "console messages");
      const noun = { all: "messages", errors: "errors", warnings: "errors and warnings" }[level];
      const head = `${rows.length} ${noun} on ${res.url}` + (rows.length > limit ? ` (last ${limit})` : "");
      return { text: [note, rows.length ? head : `no ${noun} yet on ${res.url}`, ...shown].filter(Boolean).join("\n") };
    }

    case "network": {
      const res = await hub.call("page.network", {
        reload: Boolean(args.reload),
        clear: Boolean(args.clear),
        body: args.body != null ? String(args.body) : undefined,
      });
      if (args.body != null) {
        const r = res.request;
        if (res.base64) return { text: `${r.method} ${r.status ?? ""} ${shortUrl(r.url)}\n(binary body, ${kb(r.size)})` };
        const body = String(res.body ?? "");
        return { text: `${r.method} ${r.status ?? ""} ${shortUrl(r.url)}\n${body.slice(0, 4000)}${body.length > 4000 ? `\n... ${body.length - 4000} more chars` : ""}` };
      }
      const bad = (r) => r.failed || (r.status ?? 0) >= 400;
      let rows = res.entries;
      if (!args.all) rows = rows.filter((r) => bad(r) || !STATIC_TYPES.has(r.type));
      if (args.failed) rows = rows.filter(bad);
      if (args.filter) rows = rows.filter((r) => r.url.includes(String(args.filter)));
      const limit = Math.max(1, Math.min(Number(args.limit) || 30, 200));
      const shown = rows.slice(-limit).map((r) => {
        const status = r.failed ? `ERR ${r.failed}` : r.status ?? "…";
        const extra = [r.type, kb(r.size), r.ms != null ? `${r.ms}ms` : ""].filter(Boolean).join(", ");
        return `${r.method} ${status} ${shortUrl(r.url)} (${extra}) [id=${r.id}]`;
      });
      const note = captureNote(res, "network requests");
      const head = `${rows.length} request${rows.length === 1 ? "" : "s"} on ${res.url}` + (rows.length > limit ? ` (last ${limit})` : "");
      return { text: [note, head, ...shown].filter(Boolean).join("\n") };
    }

    case "stop": {
      await hub.call("page.hidePointer", {});
      return { text: "stopped" };
    }

    default:
      throw new Error(`Unknown tool ${name}`);
  }
}
