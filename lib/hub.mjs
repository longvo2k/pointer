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
    this.extensions = new Map(); // connId -> { id, ws, instanceId, name, connectedAt, lastFocusedAt }
    this.activeId = null;
    this.activePinned = false;
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
        lastFocusedAt: 0,
        lastFocusedWindowId: null,
      };
      this.extensions.set(connId, entry);
      // Keep the active browser stable for actions already in progress.
      // tab_open follows focus separately; a reconnect must not move other calls.
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
          entry.lastFocusedAt = Math.max(
            entry.lastFocusedAt || 0,
            Number(msg.lastFocusedAt) || 0
          );
          if (Number.isInteger(msg.lastFocusedWindowId)) {
            entry.lastFocusedWindowId = msg.lastFocusedWindowId;
          }
          this.log(
            `extension hello (v${msg.version}, ${entry.instanceId || "no id"}, build ${entry.build || "unknown"})`
          );
          return;
        }
        if (msg.event === "focus") {
          entry.lastFocusedAt = Math.max(
            entry.lastFocusedAt || 0,
            Number(msg.at) || Date.now()
          );
          if (Number.isInteger(msg.windowId)) entry.lastFocusedWindowId = msg.windowId;
          this.log(`browser focus (${connId.slice(0, 8)})`);
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
          if (this.activePinned) {
            this.activePinned = false;
            this.log("pinned browser disconnected; following focus again");
          }
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
        activePinned: this.activePinned,
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
          if (!want) return json(200, { ok: false, error: "Pass a browser id or auto" });

          if (want === "auto") {
            this.activePinned = false;
            const entry = await this.chooseOpenEntry();
            if (!entry) return json(200, { ok: false, error: "No browser connected" });
            this.activeId = entry.id;
            this.log(`active browser follows focus (${entry.id.slice(0, 8)})`);
            return json(200, { ok: true, result: { active: entry.id, pinned: false } });
          }

          const match = [...this.extensions.values()].find(
            (e) => e.id === want || e.id.startsWith(want)
          );
          if (!match) return json(200, { ok: false, error: `No browser matching ${want}` });
          this.activeId = match.id;
          this.activePinned = true;
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
      pinned: e.id === this.activeId && this.activePinned,
      lastFocusedAt: e.lastFocusedAt || 0,
      lastFocusedWindowId: e.lastFocusedWindowId ?? null,
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
   * Pick the Chrome instance that should receive a new tab. The profile the
   * human focused most recently wins, even if Chrome has since lost focus to
   * the terminal running this command. A pinned browser overrides that choice.
   */
  async chooseOpenEntry() {
    const entries = [...this.extensions.values()].filter((e) => e.ws.readyState === 1);
    if (!entries.length) return null;
    if (this.activePinned) return this.extensions.get(this.activeId) || null;

    if (entries.length > 1) {
      await Promise.all(
        entries.map(async (entry) => {
          try {
            const state = await this.request(entry, "ext.focus", {}, 1200);
            if (state && Number.isFinite(state.at)) {
              entry.lastFocusedAt = Math.max(entry.lastFocusedAt || 0, state.at);
            }
            if (state && Number.isInteger(state.windowId)) {
              entry.lastFocusedWindowId = state.windowId;
            }
          } catch {}
        })
      );
    }

    const best = entries.reduce((a, b) =>
      (b.lastFocusedAt || 0) > (a.lastFocusedAt || 0) ? b : a
    );
    if ((best.lastFocusedAt || 0) > 0) return best;
    return this.extensions.get(this.activeId) || entries[0];
  }

  request(entry, method, params = {}, timeout = 30000) {
    if (!entry || entry.ws.readyState !== 1) {
      return Promise.reject(new Error("Extension disconnected"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out after ${timeout}ms: ${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, connId: entry.id });
      entry.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  sendTo(entry, method, params = {}, timeout = 30000) {
    return this.request(
      entry,
      method,
      { focusWindow: this.focusWindow, agent: this.agentName, ...params },
      timeout
    );
  }

  async call(method, params = {}, timeout = 30000) {
    if (method === "ext.rename" && params.name) this.agentName = String(params.name);

    let entry;
    if (method === "tabs.open") {
      entry = await this.chooseOpenEntry();
      if (!entry) entry = this.requireExtension();
      if (entry.id !== this.activeId) {
        this.activeId = entry.id;
        this.log(`active browser set to ${entry.id.slice(0, 8)} for tab_open`);
      }
    } else {
      entry = this.requireExtension();
    }

    return this.sendTo(entry, method, params, timeout);
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
