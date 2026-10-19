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
  constructor({ port = DEFAULT_PORT, log = () => {} } = {}) {
    this.port = port;
    this.log = log;
    this.extensions = new Map(); // connId -> { id, ws, instanceId, name, connectedAt }
    this.activeId = null;
    this.pending = new Map();
    this.nextId = 1;
    this.lastStop = null;
    this.agentName = process.env.POINTER_AGENT || "agent";
    this.focusWindow = process.env.POINTER_FOCUS_WINDOW !== "0";
  }

  async start() {
    this.server = http.createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ server: this.server, path: "/ext" });

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
        if (msg.event === "hello") {
          entry.instanceId = msg.instanceId || null;
          entry.name = msg.name || entry.name;
          entry.build = msg.build || null;
          this.log(
            `extension hello (v${msg.version}, ${entry.instanceId || "no id"}, build ${entry.build || "unknown"})`
          );
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

  async handleHttp(req, res) {
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

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
          const match = [...this.extensions.values()].find(
            (e) => e.id === want || e.id.startsWith(want)
          );
          if (!match) return json(200, { ok: false, error: `No browser matching ${want}` });
          this.activeId = match.id;
          this.log(`active browser set to ${match.id.slice(0, 8)}`);
          return json(200, { ok: true, result: { active: match.id } });
        }
        if (payload.method === "ext.reloadAll") {
          const n = this.broadcast("ext.reload", {});
          return json(200, { ok: true, result: { reloading: n } });
        }
        const result = await this.call(payload.method, payload.params || {});
        return json(200, { ok: true, result });
      } catch (err) {
        return json(200, { ok: false, error: err?.message || String(err) });
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
      active: e.id === this.activeId,
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

  call(method, params = {}, timeout = 30000) {
    if (method === "ext.rename" && params.name) this.agentName = String(params.name);
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
    this.wss?.close();
    await new Promise((r) => this.server?.close(r));
  }
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
