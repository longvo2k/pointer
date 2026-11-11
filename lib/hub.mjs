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
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { timed } from "./debug.mjs";
import { chromeUserDataDir, readProfiles, profileOfInstance, hasPointer, matchProfile, launchChrome } from "./profiles.mjs";

const DEFAULT_PORT = Number(process.env.POINTER_PORT || 8790);
const MAX_BODY = 1024 * 1024;
/** Pointer on the Chrome Web Store. */
export const STORE_EXTENSION_ID = "jckadbekhgkcnjkjcoaecjjkpkkgamjl";
const EXTENSION_DIR = fileURLToPath(new URL("../extension", import.meta.url));

/** The id Chrome gives an unpacked extension: a hash of its folder path. */
export function unpackedExtensionId(dir) {
  const hex = createHash("sha256").update(dir).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

/**
 * The extension ids allowed on /ext: the store build, this install's own
 * folder loaded unpacked, and any listed in POINTER_EXTENSION_IDS.
 */
export function defaultExtensionIds() {
  const dirs = new Set([EXTENSION_DIR]);
  try {
    dirs.add(realpathSync(EXTENSION_DIR));
  } catch {}
  const extra = String(process.env.POINTER_EXTENSION_IDS || "")
    .split(/[\s,]+/)
    .filter((id) => /^[a-p]{32}$/.test(id));
  return [STORE_EXTENSION_ID, ...[...dirs].map(unpackedExtensionId), ...extra];
}

/**
 * How long the hub waits for a command. verify, and actions that carry
 * expect, keep checking for up to their own timeout on top of the usual work,
 * so they get that time added instead of being cut off mid-check.
 */
export function rpcTimeout(method, params = {}) {
  const checks = method === "page.verify" ? params : params?.expect;
  if (!checks) return 30000;
  const n = Number(checks.timeout ?? 5000);
  return 30000 + (Number.isFinite(n) ? Math.min(Math.max(n, 0), 30000) : 5000);
}

export class Hub {
  constructor({
    port = DEFAULT_PORT,
    log = () => {},
    followIdleMs,
    extensionIds,
    previewTimeoutMs = 2000,
    chromeDir = chromeUserDataDir(),
    launch = launchChrome,
    launchWaitMs = 20000,
    runningWaitMs = 35000,
  } = {}) {
    this.port = port;
    this.log = log;
    this.extensionIds = new Set(extensionIds || defaultExtensionIds());
    this.rejectedExtension = null; // last unknown extension id, so status can explain
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
    this.previewTimeoutMs = previewTimeoutMs; // how long browsers_list waits for each browser's tabs
    // Chrome profiles: where Chrome keeps them, how to open one, and how long to wait for Pointer there.
    this.chromeDir = chromeDir;
    this.launch = launch;
    this.launchWaitMs = launchWaitMs;
    this.runningWaitMs = runningWaitMs;
    this.seenExtensionIds = new Set(); // Pointer builds that said hello, for "installed in this profile"
    this.profileWaiters = []; // { dir, resolve }: someone waits for Pointer to connect in that profile
    this.opening = new Map(); // profile folder -> the switch already under way, so Chrome opens once
  }

  async start() {
    this.server = http.createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({
      server: this.server,
      path: "/ext",
      // Only Pointer's own extension may connect. A web page cannot forge a
      // chrome-extension:// Origin, and any other extension could (even one with
      // no permissions), so the id must be one we know.
      verifyClient: ({ req }) => {
        const id = extensionIdOf(req.headers.origin);
        const ok = this.isLocalHost(req) && id != null && this.extensionIds.has(id);
        if (!ok) {
          if (id) this.rejectedExtension = id;
          this.log(
            `rejected /ext connection (origin ${req.headers.origin || "none"})` +
              (id ? `. If this is your copy of Pointer, set POINTER_EXTENSION_IDS=${id}` : "")
          );
        }
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
          entry.lastFocusedAt = Math.max(entry.lastFocusedAt || 0, clampTime(msg.at) || Date.now());
          return;
        }
        if (msg.event === "hello") {
          entry.instanceId = msg.instanceId || null;
          entry.name = msg.name || entry.name;
          entry.build = msg.build || null;
          entry.version = msg.version || null;
          entry.lastFocusedAt = Math.max(entry.lastFocusedAt || 0, clampTime(msg.lastFocusedAt));
          entry.extensionId = /^[a-p]{32}$/.test(msg.extensionId || "") ? msg.extensionId : null;
          entry.helloAt = Date.now();
          if (entry.extensionId) this.seenExtensionIds.add(entry.extensionId);
          entry.profileDir = this.profileDirOf(entry);
          if (entry.profileDir) {
            for (const w of this.profileWaiters.filter((w) => w.dir === entry.profileDir)) w.resolve(entry);
          }
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
          this.announceRoles();
          return;
        }
        if (msg.event === "use") {
          // The human chose this profile in its popup. Only a browser that said
          // hello can take over.
          if (!entry.instanceId) return;
          this.activeId = entry.id;
          this.pinned = true;
          this.log(`active browser pinned to ${entry.id.slice(0, 8)} from its popup`);
          this.announceRoles();
          return;
        }
        if (msg.event === "stop") {
          this.lastStop = { reason: msg.reason, at: Date.now() };
          this.log(`human stop: ${msg.reason}`);
          return;
        }
        const waiter = this.pending.get(msg.id);
        // Only the connection the request went to may answer it.
        if (!waiter || waiter.connId !== connId) return;
        this.pending.delete(msg.id);
        clearTimeout(waiter.timer);
        if (msg.ok) waiter.resolve(msg.result);
        else {
          const err = new Error(msg.error || "Extension error");
          // Step timings the extension sends back when the caller asked for debug.
          if (Array.isArray(msg.trace)) err.trace = msg.trace.slice(0, 200).map(String);
          waiter.reject(err);
        }
      });

      ws.on("close", () => {
        this.extensions.delete(connId);
        if (this.activeId === connId) {
          // The profile the pin named is gone: follow focus again rather than
          // claim a pin to a browser nobody chose.
          if (this.pinned) this.log("pinned browser left; following focus again");
          this.pinned = false;
          const next = [...this.extensions.values()].sort(
            (a, b) => b.connectedAt - a.connectedAt
          )[0];
          this.activeId = next?.id ?? null;
          if (next) this.log(`active browser fell back to ${next.id.slice(0, 8)}`);
        }
        this.log(`extension disconnected (${connId.slice(0, 8)})`);
        this.announceRoles();
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
      return json(200, this.health());
    }

    if (req.method === "POST" && req.url === "/rpc") {
      // Require JSON so a browser would have to send a CORS preflight, which
      // this server never approves. Blocks text/plain form-style POSTs.
      if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) {
        return json(415, { ok: false, error: "Content-Type must be application/json" });
      }
      const tooLarge = (close) => {
        res.writeHead(413, { "content-type": "application/json", ...(close ? { connection: "close" } : {}) });
        res.end(JSON.stringify({ ok: false, error: "Request too large" }));
      };
      if (Number(req.headers["content-length"]) > MAX_BODY) {
        tooLarge(false);
        req.resume(); // discard the rest without buffering it
        return;
      }
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > MAX_BODY) {
          tooLarge(true);
          req.destroy(); // no length given up front: stop reading here
          return;
        }
      }
      let payload;
      try {
        payload = JSON.parse(body || "{}");
      } catch {
        return json(400, { ok: false, error: "Invalid JSON" });
      }
      try {
        // Browser selection is a hub concern; the extension never sees these.
        if (payload.method === "ext.list") {
          const list = payload.params?.tabs ? await this.listWithTabs() : this.listExtensions();
          return json(200, { ok: true, result: list });
        }
        if (payload.method === "ext.profiles") {
          return json(200, { ok: true, result: await this.listProfiles({ tabs: Boolean(payload.params?.tabs) }) });
        }
        if (payload.method === "ext.use" && payload.params?.profile != null && payload.params.profile !== "auto") {
          return json(200, { ok: true, result: await this.useProfile(String(payload.params.profile)) });
        }
        if (payload.method === "ext.use") {
          const want = String(payload.params?.id || payload.params?.profile || "");
          if (want === "auto") {
            this.pinned = false;
            this.followFocus({ force: true });
            this.log("following the focused profile");
            this.announceRoles();
            return json(200, { ok: true, result: { active: this.activeId, pinned: false } });
          }
          if (!want) return json(200, { ok: false, error: 'Pass a browser id, or "auto"' });
          // Only browsers that said hello; a short prefix must name exactly one.
          const matches = [...this.extensions.values()].filter(
            (e) => e.instanceId && (e.id === want || e.id.startsWith(want))
          );
          if (matches.length > 1) return json(200, { ok: false, error: `${want} matches more than one browser; use more characters` });
          const match = matches[0];
          if (!match) return json(200, { ok: false, error: `No browser matching ${want}` });
          this.activeId = match.id;
          this.pinned = true;
          this.log(`active browser pinned to ${match.id.slice(0, 8)}`);
          this.announceRoles();
          return json(200, { ok: true, result: { active: match.id, pinned: true } });
        }
        if (payload.method === "ext.reloadAll") {
          const n = this.broadcast("ext.reload", {});
          return json(200, { ok: true, result: { reloading: n } });
        }
        const result = await this.call(payload.method, payload.params || {}, rpcTimeout(payload.method, payload.params));
        return json(200, { ok: true, result });
      } catch (err) {
        return json(200, { ok: false, error: errorMessage(err), ...(err?.trace ? { trace: err.trace } : {}) });
      }
    }

    json(404, { ok: false, error: "Not found" });
  }

  health() {
    return {
      ok: true,
      extension: Boolean(this.activeId),
      browsers: this.extensions.size,
      agent: this.agentName,
      port: this.port,
      rejectedExtension: this.rejectedExtension,
    };
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
      profileDir: e.profileDir || null,
    }));
  }

  /** Agents work in this browser from now on, until the human or an agent picks another. */
  pinTo(entry) {
    this.activeId = entry.id;
    this.pinned = true;
    this.log(`active browser pinned to ${entry.id.slice(0, 8)}`);
    this.announceRoles();
  }

  /** The newest connection in this profile folder, if Pointer is connected there. */
  connectionIn(dir) {
    return [...this.extensions.values()]
      .filter((e) => e.instanceId && e.profileDir === dir)
      .sort((a, b) => (b.helloAt || 0) - (a.helloAt || 0))[0];
  }

  /** Resolves with the first connection that says hello from this profile, or null after ms. */
  waitForProfile(dir, ms) {
    return new Promise((resolve) => {
      const waiter = { dir };
      const done = (entry) => {
        clearTimeout(timer);
        this.profileWaiters = this.profileWaiters.filter((w) => w !== waiter);
        resolve(entry);
      };
      waiter.resolve = done;
      const timer = setTimeout(() => done(null), ms);
      timer.unref?.();
      this.profileWaiters.push(waiter);
    });
  }

  /**
   * Switch to a profile the human named: pin it if Pointer is connected there;
   * if Chrome runs it but Pointer has not reconnected yet, wait (never open a
   * second window); if it is closed, open Chrome in it and wait for Pointer.
   * A query that names no profile may still be a connection id.
   */
  async useProfile(query) {
    const { profiles, error } = readProfiles(this.chromeDir);
    const found = matchProfile(query, profiles);
    if (!found.match) {
      const q = String(query).trim();
      const conns = q ? [...this.extensions.values()].filter((e) => e.instanceId && e.id.startsWith(q)) : [];
      if (conns.length === 1) {
        this.pinTo(conns[0]);
        return { active: conns[0].id, pinned: true, profile: null, opened: false };
      }
      if (error) throw new Error(`${error} Use a browser id from browsers_list instead.`);
      const names = found.candidates.map((c) => c.name).join(", ");
      throw new Error(`${found.error}${names ? ` Profiles: ${names}.` : ""}`);
    }
    const { dir, name, email, running } = found.match;
    const profile = { dir, name, email };
    const open = this.connectionIn(dir);
    if (open) {
      this.pinTo(open);
      return { active: open.id, pinned: true, profile, opened: false };
    }
    if (!hasPointer(this.chromeDir, dir, this.knownExtensionIds())) {
      throw new Error(`Pointer isn't installed in ${name}. Ask the human to add it there first.`);
    }
    if (this.opening.has(dir)) return this.opening.get(dir);
    const attempt = (async () => {
      if (running) {
        const entry = await this.waitForProfile(dir, this.runningWaitMs);
        if (!entry) {
          throw new Error(
            `${name} is open in Chrome, but Pointer isn't connected there. Ask the human to check that Pointer is turned on in that profile.`
          );
        }
        this.pinTo(entry);
        return { active: entry.id, pinned: true, profile, opened: false };
      }
      const waiting = this.waitForProfile(dir, this.launchWaitMs);
      this.log(`opening Chrome profile ${dir}`);
      this.launch(dir);
      const entry = await waiting;
      if (!entry) {
        throw new Error(
          `Opened ${name}, but Pointer did not connect within 20 s. Ask the human to check that Pointer is turned on in that profile.`
        );
      }
      this.pinTo(entry);
      return { active: entry.id, pinned: true, profile, opened: true };
    })().finally(() => this.opening.delete(dir));
    this.opening.set(dir, attempt);
    return attempt;
  }

  /** Pointer builds to look for in a profile's folder. */
  knownExtensionIds() {
    return [...new Set([STORE_EXTENSION_ID, ...this.extensionIds, ...this.seenExtensionIds])];
  }

  /** The Chrome profile folder this connection runs in, or null when it can't be told. */
  profileDirOf(entry) {
    if (!entry.instanceId) return null;
    try {
      const { profiles } = readProfiles(this.chromeDir);
      const ids = entry.extensionId ? [entry.extensionId] : this.knownExtensionIds();
      return profileOfInstance(this.chromeDir, profiles.map((p) => p.dir), ids, entry.instanceId);
    } catch {
      return null;
    }
  }

  /**
   * Every Chrome profile on this computer with the connections in it (latest
   * hello first), plus connections that match no profile. With tabs, each
   * connection carries the same tab preview as ext.list.
   */
  async listProfiles({ tabs = false } = {}) {
    const browsers = tabs ? await this.listWithTabs() : this.listExtensions();
    const { profiles, error } = readProfiles(this.chromeDir);
    const ids = this.knownExtensionIds();
    const helloAt = (id) => this.extensions.get(id)?.helloAt || 0;
    const dirs = new Set(profiles.map((p) => p.dir));
    return {
      profiles: profiles.map((p) => ({
        ...p,
        installed: hasPointer(this.chromeDir, p.dir, ids),
        connections: browsers
          .filter((b) => b.instanceId && b.profileDir === p.dir)
          .sort((a, b) => helloAt(b.id) - helloAt(a.id))
          .map((b) => b.id),
      })),
      unknown: browsers.filter((b) => b.instanceId && !dirs.has(b.profileDir)),
      browsers,
      error,
    };
  }

  /**
   * listExtensions, plus a short preview of each browser's tabs so an agent
   * can tell the profiles apart. Asks every browser at once; one that does
   * not answer in time is listed with tabsError.
   */
  async listWithTabs() {
    const list = this.listExtensions();
    await Promise.all(
      list.map(async (b) => {
        const entry = this.extensions.get(b.id);
        if (!entry?.instanceId) return;
        try {
          // Straight to that browser: no agent label, no follow-focus, no idle clock.
          const tabs = await this.sendTo(entry, "tabs.list", {}, this.previewTimeoutMs);
          const all = Array.isArray(tabs) ? tabs : [];
          b.tabCount = all.length;
          b.tabs = all.slice(0, 3).map((t) => ({ title: String(t.title || ""), url: String(t.url || "") }));
        } catch (err) {
          b.tabsError = /Timed out/.test(err?.message) ? "did not answer in time" : errorMessage(err);
        }
      })
    );
    return list;
  }

  /**
   * Tell each browser whether agents work in it and whether the hub is
   * pinned, so its popup can offer "use this profile". Sent only on change.
   */
  announceRoles() {
    const browsers = [...this.extensions.values()].filter((e) => e.instanceId).length;
    for (const entry of this.extensions.values()) {
      if (!entry.instanceId || entry.ws.readyState !== 1) continue;
      const role = { event: "hub", active: entry.id === this.activeId, pinned: this.pinned, browsers };
      const key = JSON.stringify(role);
      if (entry.lastRole === key) continue;
      entry.lastRole = key;
      entry.ws.send(key);
    }
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
    this.announceRoles();
  }

  call(method, params = {}, timeout = 30000) {
    return timed(`hub → extension ${method}`, this.send(method, params, timeout));
  }

  send(method, params, timeout) {
    if (method === "ext.rename" && params.name) this.agentName = String(params.name);
    this.followFocus();
    this.lastCallAt = Date.now();
    const entry = this.requireExtension();
    return this.sendTo(entry, method, { focusWindow: this.focusWindow, agent: this.agentName, ...params }, timeout);
  }

  /** Send one command to one browser and wait for its answer. */
  sendTo(entry, method, params, timeout) {
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

/** The extension id in a chrome-extension:// Origin, or null. */
function extensionIdOf(origin) {
  const m = /^chrome-extension:\/\/([a-p]{32})$/.exec(String(origin || ""));
  return m ? m[1] : null;
}

/** A timestamp from the extension, never later than now. */
function clampTime(at) {
  const n = Number(at);
  return Number.isFinite(n) && n > 0 ? Math.min(n, Date.now()) : 0;
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
