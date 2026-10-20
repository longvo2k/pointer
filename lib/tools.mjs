/** Tool surface shared by the MCP server and the CLI. */

export const TOOLS = [
  {
    name: "browser_status",
    description: "Check whether the Chrome extension is connected, and which browser/profile it is driving.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "tabs_list",
    description: "List open tabs with their tabId, title and URL. Use before switching tabs.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "tab_open",
    description: "Open a URL in a new tab, bring it to the front, and wait for it to load.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "URL, or a bare domain like example.com" } },
      required: ["url"],
    },
  },
  {
    name: "tab_focus",
    description: "Bring an existing tab to the front so the human can watch subsequent actions.",
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
      "Return the interactive elements of the current page as compact text, each with a stable ref (e1, e2...). " +
      "Refs reset on navigation — snapshot again after the page changes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "click",
    description:
      "Click an element by ref or CSS selector. The pointer moves to it in the agent's tab, then a trusted click is dispatched. " +
      "Does not bring the tab to the front if the human is working elsewhere; the tab title shows the agent badge.",
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
    description: "Click a field, clear it, and type text using trusted input. Optionally submit with Enter.",
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
    description: "Scroll the page, or bring an element into view by ref.",
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
          `Browser: ${active ? active.id.slice(0, 8) : "unknown"}`,
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
              `${t.active ? "→" : " "} [${t.tabId}] ${(t.title || "(untitled)").slice(0, 70)} — ${t.url.slice(0, 90)}`
          )
          .join("\n"),
      };
    }

    case "tab_open": {
      const res = await hub.call("tabs.open", { url: normalizeUrl(args.url) });
      return { text: `opened tab ${res.tabId}: ${res.url}` };
    }

    case "tab_focus": {
      const res = await hub.call("tabs.focus", {
        tabId: Number(args.tabId),
        focusWindow: args.focusWindow !== false,
      });
      return { text: `focused [${res.tabId}] ${res.title || ""} — ${res.url}` };
    }

    case "snapshot": {
      const res = await hub.call("page.snapshot", {});
      return { text: res.text };
    }

    case "click": {
      const res = await hub.call("page.act", { ...requireTarget(args), kind: "click" });
      return {
        text: `clicked ${res.target.role || "element"} "${res.target.name || ""}" → ${res.url}`,
      };
    }

    case "fill": {
      const res = await hub.call("page.fill", {
        ...requireTarget(args),
        text: String(args.text ?? ""),
        submit: Boolean(args.submit),
      });
      return { text: `typed into "${res.target}"${args.submit ? " and pressed Enter" : ""} → ${res.url}` };
    }

    case "press": {
      const res = await hub.call("page.press", { key: args.key || "Enter" });
      return { text: `pressed ${res.key} → ${res.url}` };
    }

    case "scroll": {
      const res = await hub.call("page.scroll", {
        direction: args.direction || "down",
        amount: args.amount,
        ref: args.ref,
      });
      return { text: `scrolled${res.y != null ? ` to y=${res.y}` : ""}` };
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

    case "stop": {
      await hub.call("page.hidePointer", {});
      return { text: "stopped" };
    }

    default:
      throw new Error(`Unknown tool ${name}`);
  }
}
