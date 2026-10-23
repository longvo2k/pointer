/**
 * The hub: one local process that
 *   - accepts the Chrome extension over WebSocket (/ext)
 *   - exposes a tiny HTTP JSON-RPC API (/rpc) for the CLI
 *   - is reused by the MCP server in bin/mcp.mjs
 *
 * Keeping the socket in a long-lived process (rather than inside each agent
 * run) is what lets several agents share one browser.
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";

const DEFAULT_PORT = Number(process.env.POINTER_PORT || 8790);

export class Hub {
  constructor({ port = DEFAULT_PORT, log = () => {}, followIdleMs } = {}) {
    this.port = port;
    this.log = log;
    this.extensions = new Map(); // connId -> { id, ws, instanceId, name, connectedAt }
    this.activeId = null;
    this.pending = new Map();
    this.nextId = 1;
    this.lastStop = null;
    this.agentName = process.env.POINTER_AGENT || "agent";
    this.focusWindow = process.env.POINTER_FOCUS_WINDOW !== "0";
    // Follow the Chrome profile the human is using, but only between tasks:
    // after this long without agent calls, the next call re-picks the browser.
    this.followIdleMs = followIdleMs ?? Number(process.env.POINTER_FOLLOW_IDLE_MS || 120000);
    this.pinned = false; // `pointer use <id>` pins; `pointer use auto` follows again
    this.lastCallAt = 0;
  }

  async start() {
    this.server = http.createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({
      server: this.server,
      path: "/ext",
      // Only a Chrome extension may connect. A web page can open a WebSocket to
      // localhost too, but it cannot forge a chrome-extension:// Origin.
      verifyClient: ({ req }) => {
        const ok = this.isLocalHost(req) && isExtensionOrigin(req.headers.origin);
        if (!ok) this.log(`rejected /ext connection (origin ${req.headers.origin || "none"})`);
        return ok;
      },
    });

    this.wss.on("connection", (ws) => {
      const connId = randomUUID();
      const entry = {
        id: connId,
        ws,
        instanceId: null,
        name: "pointer-extension",
        connectedAt: Date.now(),
      };
      this.extensions.set(connId, entry);
      // The extension says hello right after connecting. A socket that stays
      // silent is a leftover and must not hold the "active" slot.
      setTimeout(() => {
        if (this.extensions.get(connId) && !entry.instanceId) {
          this.log(`closing silent connection ${connId.slice(0, 8)}`);
          try {
            ws.close(4001, "no hello");
          } catch {}
        }
      }, 10000).unref?.();
      // First browser wins. Silently switching on reconnect would send clicks
      // to a different Chrome than the one the agent was working in.
      if (!this.activeId) this.activeId = connId;
      this.log(
        `extension connected (${connId.slice(0, 8)})` +
          (this.activeId === connId ? " — active" : " — background")
      );

      ws.on("message", (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.event === "ping") return; // keeps the extension's worker alive
        if (msg.event === "focus") {
          entry.lastFocusedAt = Math.max(entry.lastFocusedAt || 0, Number(msg.at) || Date.now());
          return;
        }
        if (msg.event === "hello") {
          entry.instanceId = msg.instanceId || null;
          entry.name = msg.name || entry.name;
          entry.build = msg.build || null;
          entry.version = msg.version || null;
          entry.lastFocusedAt = Math.max(entry.lastFocusedAt || 0, Number(msg.lastFocusedAt) || 0);
          this.log(
            `extension hello (v${msg.version}, ${entry.instanceId || "no id"}, build ${entry.build || "unknown"})`
          );
          // One connection per browser: a newer hello from the same profile
          // replaces older sockets, and inherits "active" if one of them had it.
          if (entry.instanceId) {
            for (const other of [...this.extensions.values()]) {
              if (other === entry || other.instanceId !== entry.instanceId) continue;
              if (this.activeId === other.id) this.activeId = entry.id;
              this.extensions.delete(other.id);
              try {
                other.ws.close(4000, "replaced by a newer connection");
              } catch {}
              this.log(`closed duplicate connection ${other.id.slice(0, 8)}`);
            }
          }
          // A connection that never said hello should not stay in charge.
          const active = this.extensions.get(this.activeId);
          if (!active || !active.instanceId) this.activeId = entry.id;
          return;
        }
        if (msg.event === "stop") {
          this.lastStop = { reason: msg.reason, at: Date.now() };
          this.log(`human stop: ${msg.reason}`);
          return;
        }
        const waiter = this.pending.get(msg.id);
        if (!waiter) return;
        this.pending.delete(msg.id);
        clearTimeout(waiter.timer);
        if (msg.ok) waiter.resolve(msg.result);
        else waiter.reject(new Error(msg.error || "Extension error"));
      });

      ws.on("close", () => {
        this.extensions.delete(connId);
        if (this.activeId === connId) {
          const next = [...this.extensions.values()].sort(
            (a, b) => b.connectedAt - a.connectedAt
          )[0];
          this.activeId = next?.id ?? null;
          if (next) this.log(`active browser fell back to ${next.id.slice(0, 8)}`);
        }
        this.log(`extension disconnected (${connId.slice(0, 8)})`);
        for (const [id, waiter] of this.pending) {
          if (waiter.connId !== connId) continue;
          clearTimeout(waiter.timer);
          waiter.reject(new Error("Extension disconnected"));
          this.pending.delete(id);
        }
      });
    });

    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, "127.0.0.1", resolve);
    });
    this.log(`hub listening on http://127.0.0.1:${this.port}`);
    return this;
  }

  /** Reject DNS-rebinding requests: the Host must name this machine. */
  isLocalHost(req) {
    const host = String(req.headers.host || "").toLowerCase();
    return host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`;
  }

  async handleHttp(req, res) {
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    // The CLI and MCP server call from Node, which sends no Origin header.
    // Anything with an Origin is a web page (or extension) and gets no access.
    if (!this.isLocalHost(req) || req.headers.origin) {
      return json(403, { ok: false, error: "Forbidden" });
    }

    if (req.method === "GET" && req.url === "/health") {
      return json(200, {
        ok: true,
        extension: Boolean(this.activeId),
        browsers: this.extensions.size,
        agent: this.agentName,
        port: this.port,
      });
    }

    if (req.method === "POST" && req.url === "/rpc") {
      // Require JSON so a browser would have to send a CORS preflight, which
      // this server never approves. Blocks text/plain form-style POSTs.
      if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) {
        return json(415, { ok: false, error: "Content-Type must be application/json" });
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      let payload;
      try {
        payload = JSON.parse(body || "{}");
      } catch {
        return json(400, { ok: false, error: "Invalid JSON" });
      }
      try {
        // Browser selection is a hub concern; the extension never sees these.
        if (payload.method === "ext.list") {
          return json(200, { ok: true, result: this.listExtensions() });
        }
        if (payload.method === "ext.use") {
          const want = String(payload.params?.id || "");
          if (want === "auto") {
            this.pinned = false;
            this.followFocus({ force: true });
            this.log("following the focused profile");
            return json(200, { ok: true, result: { active: this.activeId, pinned: false } });
          }
          const match = [...this.extensions.values()].find(
            (e) => e.id === want || e.id.startsWith(want)
          );
          if (!match) return json(200, { ok: false, error: `No browser matching ${want}` });
          this.activeId = match.id;
          this.pinned = true;
          this.log(`active browser pinned to ${match.id.slice(0, 8)}`);
          return json(200, { ok: true, result: { active: match.id, pinned: true } });
        }
        if (payload.method === "ext.reloadAll") {
          const n = this.broadcast("ext.reload", {});
          return json(200, { ok: true, result: { reloading: n } });
        }
        const result = await this.call(payload.method, payload.params || {});
        return json(200, { ok: true, result });
      } catch (err) {
        return json(200, { ok: false, error: errorMessage(err) });
      }
    }

    json(404, { ok: false, error: "Not found" });
  }

  listExtensions() {
    return [...this.extensions.values()].map((e) => ({
      id: e.id,
      instanceId: e.instanceId,
      name: e.name,
      build: e.build || null,
      version: e.version || null,
      // Chrome can keep running an old service worker after the files change:
      // the manifest says one version, the running script another.
      stale: Boolean(e.version && e.build && e.version !== e.build),
      active: e.id === this.activeId,
      pinned: e.id === this.activeId && this.pinned,
      lastFocusedAt: e.lastFocusedAt || 0,
      connectedAt: e.connectedAt,
    }));
  }

  broadcast(method, params = {}) {
    let count = 0;
    for (const entry of this.extensions.values()) {
      if (entry.ws.readyState !== 1) continue;
      entry.ws.send(JSON.stringify({ id: `b${this.nextId++}`, method, params }));
      count++;
    }
    return count;
  }

  requireExtension() {
    const entry = this.extensions.get(this.activeId);
    if (!entry) {
      throw new Error(
        "Chrome extension is not connected. Load pointer/extension at chrome://extensions and keep Chrome open."
      );
    }
    return entry;
  }

  /**
   * Move to the profile the human focused most recently. Only between tasks
   * (idle long enough) or when forced: switching mid-task would strand the
   * agent's tabs and refs in the other profile.
   */
  followFocus({ force = false } = {}) {
    if (this.pinned) return;
    const current = this.extensions.get(this.activeId);
    const idle = Date.now() - this.lastCallAt >= this.followIdleMs;
    if (!force && current && !idle) return;
    const best = [...this.extensions.values()]
      .filter((e) => e.instanceId && e.ws.readyState === 1)
      .sort((a, b) => (b.lastFocusedAt || 0) - (a.lastFocusedAt || 0))[0];
    if (!best || best.id === this.activeId) return;
    if (current && (best.lastFocusedAt || 0) <= (current.lastFocusedAt || 0)) return;
    this.log(`following focus: ${current ? current.id.slice(0, 8) : "none"} → ${best.id.slice(0, 8)}`);
    this.activeId = best.id;
  }

  call(method, params = {}, timeout = 30000) {
    if (method === "ext.rename" && params.name) this.agentName = String(params.name);
    this.followFocus();
    this.lastCallAt = Date.now();
    const entry = this.requireExtension();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out after ${timeout}ms: ${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, connId: entry.id });
      entry.ws.send(JSON.stringify({ id, method, params: { focusWindow: this.focusWindow, agent: this.agentName, ...params } }));
    });
  }

  async stop() {
    for (const entry of this.extensions.values()) {
      try {
        entry.ws.terminate();
      } catch {}
    }
    this.wss?.close();
    await new Promise((r) => this.server?.close(r));
  }
}

function isExtensionOrigin(origin) {
  return /^chrome-extension:\/\/[a-p]{32}$/.test(String(origin || ""));
}

/** The message of an error, and nothing else: no stack, no object dump. */
function errorMessage(err) {
  return err instanceof Error ? String(err.message) : "Request failed";
}

export async function health(port = DEFAULT_PORT) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(800),
    });
    return await res.json();
  } catch {
    return null;
  }
}
