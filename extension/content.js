/**
 * Pointer content script.
 *
 * Two jobs:
 *   1. Find things (snapshot -> refs, locate -> viewport coordinates)
 *   2. Draw the cursor the human watches (arrow, glow, intent label, ripple)
 *
 * It never performs the action itself. Input is dispatched by the service worker
 * through chrome.debugger so events stay trusted (React-heavy sites ignore
 * synthetic clicks; CDP ones they cannot distinguish).
 */

(() => {
  if (window.__pointerLoaded) return;
  window.__pointerLoaded = true;

  // ---------------------------------------------------------------- overlay ---
  const HOST_ID = "__pointer-host";

  function ensureOverlay() {
    let host = document.getElementById(HOST_ID);
    if (host) return host.shadowRoot;

    host = document.createElement("div");
    host.id = HOST_ID;
    host.setAttribute("aria-hidden", "true");
    host.style.cssText =
      "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .glow, .arrow, .ripple, .label, .target {
          position: fixed; pointer-events: none; box-sizing: border-box;
        }
        .glow {
          width: 54px; height: 54px; margin: -27px 0 0 -27px; border-radius: 50%;
          background: radial-gradient(circle, rgba(37,99,235,.45) 0%, rgba(37,99,235,.18) 45%, rgba(37,99,235,0) 72%);
          opacity: 0; transition: opacity 160ms ease;
        }
        .arrow {
          width: 20px; height: 20px; margin: -2px 0 0 -2px;
          filter: drop-shadow(0 1px 2px rgba(0,0,0,.35)); opacity: 0;
          transition: opacity 160ms ease;
        }
        .ripple {
          width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%;
          border: 2px solid rgba(37,99,235,.85); background: rgba(37,99,235,.18);
          animation: ptr-ripple 460ms cubic-bezier(.2,.7,.3,1) forwards;
        }
        @keyframes ptr-ripple {
          from { transform: scale(.5); opacity: 1; }
          to   { transform: scale(3.4); opacity: 0; }
        }
        .label {
          max-width: 320px; margin: 13px 0 0 24px; padding: 5px 9px;
          border-radius: 7px; background: #111827; color: #f9fafb;
          font: 500 11.5px/1.25 ui-sans-serif, -apple-system, "Segoe UI", sans-serif;
          letter-spacing: .01em; white-space: nowrap; overflow: hidden;
          text-overflow: ellipsis; opacity: 0; transform: translateY(2px);
          transition: opacity 140ms ease, transform 140ms ease;
          box-shadow: 0 4px 14px rgba(0,0,0,.28);
        }
        .label b { color: #93c5fd; font-weight: 600; }
        .label.on { opacity: 1; transform: translateY(0); }
        .target {
          border: 2px dashed rgba(37,99,235,.85); border-radius: 4px;
          background: rgba(37,99,235,.06); opacity: 0;
          transition: opacity 120ms ease; pointer-events: none;
        }
      </style>
      <div class="glow"></div>
      <svg class="arrow" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
        <path d="M3 2 L3 17 L7.6 12.9 L11 18.6 L14 17 L10.7 11.4 L17 11.4 Z"
              fill="#111827" stroke="#ffffff" stroke-width="1.4" stroke-linejoin="round"/>
      </svg>
      <div class="ripple" style="display:none"></div>
      <div class="label"></div>
      <div class="target"></div>
    `;
    (document.documentElement || document.body).appendChild(host);
    return root;
  }

  const ui = {
    root: null,
    glow: null,
    arrow: null,
    ripple: null,
    label: null,
    target: null,
    x: 0,
    y: 0,
    shown: false,
  };

  function initOverlay() {
    const root = ensureOverlay();
    ui.root = root;
    ui.glow = root.querySelector(".glow");
    ui.arrow = root.querySelector(".arrow");
    ui.ripple = root.querySelector(".ripple");
    ui.label = root.querySelector(".label");
    ui.target = root.querySelector(".target");
    if (!ui.shown) {
      ui.x = Math.round(window.innerWidth / 2);
      ui.y = Math.round(window.innerHeight / 2);
      paint();
    }
  }

  function paint() {
    for (const el of [ui.glow, ui.arrow]) {
      if (!el) continue;
      el.style.left = ui.x + "px";
      el.style.top = ui.y + "px";
    }
    if (ui.label) {
      ui.label.style.left = ui.x + "px";
      ui.label.style.top = ui.y + "px";
    }
  }

  function show() {
    if (!ui.glow) return;
    ui.shown = true;
    ui.glow.style.opacity = "1";
    ui.arrow.style.opacity = "1";
  }

  function hide() {
    if (!ui.glow) return;
    ui.shown = false;
    ui.glow.style.opacity = "0";
    ui.arrow.style.opacity = "0";
    if (ui.label) ui.label.classList.remove("on");
    if (ui.target) ui.target.style.opacity = "0";
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Ease the pointer to (x, y); resolves when it arrives. */
  function move(x, y, { duration = 420 } = {}) {
    initOverlay();
    show();

    // rAF is throttled or stopped in hidden/occluded windows. The action must
    // not wait for an animation nobody can see.
    if (document.visibilityState === "hidden") {
      ui.x = x;
      ui.y = y;
      paint();
      return Promise.resolve();
    }

    const from = { x: ui.x, y: ui.y };
    const dist = Math.hypot(x - from.x, y - from.y);
    const ms = Math.max(120, Math.min(duration, 120 + dist * 0.55));
    const start = performance.now();

    return new Promise((resolve) => {
      let settled = false;
      const finish = (snap) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (snap) {
          ui.x = x;
          ui.y = y;
          paint();
        }
        resolve();
      };
      // Hard stop for occluded windows where frames stop arriving.
      const timer = setTimeout(() => finish(true), ms + 400);

      function step(now) {
        const t = Math.min(1, (now - start) / ms);
        const e = 1 - Math.pow(1 - t, 3); // easeOutCubic
        ui.x = from.x + (x - from.x) * e;
        ui.y = from.y + (y - from.y) * e;
        paint();
        if (t < 1) requestAnimationFrame(step);
        else finish(false);
      }
      requestAnimationFrame(step);
    });
  }

  function say(action, target) {
    initOverlay();
    if (!ui.label) return;
    const esc = (s) => String(s || "").replace(/[<>&]/g, "");
    ui.label.innerHTML = `<b>${esc(action)}</b>${target ? " · " + esc(target) : ""}`;
    ui.label.classList.add("on");

    // Keep the tag on screen: flip it to the left of the pointer when it would
    // run past the right edge, and lift it above the pointer near the bottom.
    const pad = 8;
    const w = ui.label.offsetWidth;
    const h = ui.label.offsetHeight;
    let left = ui.x + 24;
    let top = ui.y + 13;
    if (left + w > window.innerWidth - pad) left = Math.max(pad, ui.x - w - 24);
    if (top + h > window.innerHeight - pad) top = Math.max(pad, ui.y - h - 13);
    ui.label.style.marginLeft = left - ui.x + "px";
    ui.label.style.marginTop = top - ui.y + "px";

    clearTimeout(say._t);
    say._t = setTimeout(() => ui.label && ui.label.classList.remove("on"), 1800);
  }

  function ripple() {
    initOverlay();
    if (!ui.ripple) return;
    const clone = ui.ripple.cloneNode(true);
    clone.style.display = "block";
    clone.style.left = ui.x + "px";
    clone.style.top = ui.y + "px";
    ui.root.appendChild(clone);
    clone.addEventListener("animationend", () => clone.remove());
  }

  function outline(rect) {
    initOverlay();
    if (!ui.target || !rect) return;
    Object.assign(ui.target.style, {
      left: rect.x + "px",
      top: rect.y + "px",
      width: rect.width + "px",
      height: rect.height + "px",
      opacity: "1",
    });
    clearTimeout(outline._t);
    outline._t = setTimeout(() => ui.target && (ui.target.style.opacity = "0"), 900);
  }

  // ------------------------------------------------------------- elements ---
  const ROLE_BY_TAG = {
    A: "link",
    BUTTON: "button",
    SELECT: "combobox",
    TEXTAREA: "textbox",
    SUMMARY: "disclosure",
    OPTION: "option",
    H1: "heading",
    H2: "heading",
    H3: "heading",
  };

  const INPUT_ROLE = {
    text: "textbox", email: "textbox", search: "searchbox", tel: "textbox",
    url: "textbox", password: "textbox", number: "spinbutton",
    checkbox: "checkbox", radio: "radio", range: "slider",
    submit: "button", reset: "button", button: "button", file: "button",
  };

  function roleOf(el) {
    const explicit = el.getAttribute && el.getAttribute("role");
    if (explicit) return explicit;
    if (el.tagName === "INPUT") return INPUT_ROLE[(el.type || "text").toLowerCase()] || "textbox";
    return ROLE_BY_TAG[el.tagName] || null;
  }

  const CANDIDATE =
    'a[href],button,input,select,textarea,summary,label[for],[role],[contenteditable=""],[contenteditable="true"],[onclick],[tabindex]:not([tabindex="-1"])';

  function isVisible(el) {
    if (!el.getClientRects().length) return false;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) < 0.05) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 1 && r.height >= 1;
  }

  function nameOf(el) {
    const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const aria = el.getAttribute && el.getAttribute("aria-label");
    if (aria) return clean(aria);

    const labelledby = el.getAttribute && el.getAttribute("aria-labelledby");
    if (labelledby) {
      const text = labelledby
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.innerText)
        .filter(Boolean)
        .join(" ");
      if (clean(text)) return clean(text);
    }

    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab) return clean(lab.innerText);
    }
    const wrap = el.closest && el.closest("label");
    if (wrap) return clean(wrap.innerText);

    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      if (el.placeholder) return clean(el.placeholder);
      if (el.type === "submit" || el.type === "button") return clean(el.value);
    }
    if (el.tagName === "IMG") return clean(el.alt) || clean(el.title);
    return clean(el.innerText || el.value || el.getAttribute?.("title") || el.getAttribute?.("alt"));
  }

  const ACTIONABLE = new Set(["button", "link", "checkbox", "radio", "textbox", "searchbox", "combobox",
    "switch", "tab", "menuitem", "slider", "spinbutton", "option", "disclosure"]);

  function isInteractive(el, role) {
    if (ACTIONABLE.has(role)) return true;
    if (el.hasAttribute && (el.hasAttribute("onclick") || el.isContentEditable)) return true;
    if (el.tagName === "LABEL") return true;
    const c = getComputedStyle(el).cursor;
    return c === "pointer" && !!(nameOf(el) || "").length;
  }

  // Refs are stable for the life of the document: an element keeps its ref
  // across snapshots, so the agent can act on a ref it saw earlier and the
  // change report can tell "same element, new state" from "new element".
  const DOC_ID = Math.random().toString(36).slice(2);
  const refOf = new WeakMap(); // element -> ref
  const refs = new Map(); // ref -> element
  let nextRef = 0;

  function refFor(el) {
    let ref = refOf.get(el);
    if (!ref) {
      ref = "e" + ++nextRef;
      refOf.set(el, ref);
      refs.set(ref, el);
      el.setAttribute("data-pointer-ref", ref);
    }
    return ref;
  }

  function pruneRefs() {
    for (const [ref, el] of refs) if (!el.isConnected) refs.delete(ref);
  }

  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG"]);
  const CONTROL =
    "a[href],button,input,select,textarea,summary,label,[role=button],[role=link],[role=tab]," +
    "[role=menuitem],[role=option],[role=checkbox],[role=radio],[role=switch],[role=combobox]";

  // Status messages ("Saved", "Invite link copied", form errors) are not
  // clickable, but an agent needs them to know an action worked.
  const LIVE = '[role="status"],[role="alert"],[aria-live]:not([aria-live="off"])';

  /** { role, name } for an element worth listing, or null. */
  function describe(el) {
    // tagName is lowercase for SVG elements, so compare in upper case.
    const tag = el.tagName.toUpperCase();
    if (SKIP_TAGS.has(tag)) return null;
    if (!isVisible(el)) return null;
    if (el.matches(LIVE)) {
      const text = (el.innerText || "").replace(/\s+/g, " ").trim();
      if (!text) return null;
      return { role: el.getAttribute("role") === "alert" ? "alert" : "status", name: text.slice(0, 160) };
    }

    // Every element with pointer affordance, plus the semantic candidates.
    // A plain div-based tab has no role and no tag we can key on, but the page
    // still says cursor:pointer, which is the best signal available.
    let role = roleOf(el);
    // A label whose control is hidden is the control the human sees: the usual
    // styled "Upload" button wraps a display:none file input.
    if (!role && tag === "LABEL" && el.control && !isVisible(el.control)) {
      return { role: "button", name: nameOf(el).slice(0, 120) };
    }
    if (!role) {
      if (getComputedStyle(el).cursor !== "pointer") return null;
      // Skip wrappers whose real control is listed separately.
      if (el.querySelector("input,select,textarea,button,a[href],[role]")) return null;
      // Skip pieces of a control that is already listed (the spans inside a
      // link), and elements that only inherited the cursor from their parent:
      // the outermost pointer element stands for the whole thing.
      const parent = el.parentElement;
      if (parent?.closest(CONTROL)) return null;
      if (parent && getComputedStyle(parent).cursor === "pointer") return null;
      if (tag === "LABEL") return null;
      if (!nameOf(el)) return null;
      role = "clickable";
    }
    if (!isInteractive(el, role)) return null;
    // A heading or image inside a link only repeats the link's line.
    if (!ACTIONABLE.has(role) && el.parentElement?.closest(CONTROL)) return null;
    return { role, name: nameOf(el).slice(0, 120) };
  }

  /** Where an element sits relative to the viewport. */
  function placeOf(el) {
    const r = el.getBoundingClientRect();
    if (r.bottom <= 0) return "above";
    if (r.top >= window.innerHeight) return "below";
    if (r.right <= 0 || r.left >= window.innerWidth) return "aside";
    return "in";
  }

  function lineFor(el, { role, name }, ref, hrefs) {
    let line = `- ${role}`;
    if (name) line += ` "${name}"`;
    line += ` [ref=${ref}]`;

    // Link targets are ~45% of a snapshot and rarely needed to act; opt in.
    if (hrefs && el.tagName === "A" && el.href) {
      try {
        const u = new URL(el.href);
        const where = u.origin === location.origin ? "" : u.host;
        line += ` href="${(where + u.pathname + u.search).slice(0, 80) || "/"}"`;
      } catch {}
    }
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      const v = el.type === "password" ? "" : (el.value || "").slice(0, 60);
      if (v) line += ` value="${v.replace(/"/g, "'")}"`;
      if (el.placeholder && !name) line += ` placeholder="${el.placeholder.slice(0, 60)}"`;
    }
    if (el.type === "checkbox" || el.type === "radio") line += el.checked ? " checked" : "";
    // Custom widgets (a div with role="radio", a tab, a toggle button) carry
    // their state in ARIA; without it a change report misses the selection.
    else if (el.getAttribute("aria-checked") === "true") line += " checked";
    if (el.getAttribute("aria-selected") === "true") line += " selected";
    if (el.getAttribute("aria-pressed") === "true") line += " pressed";
    if (el.disabled || el.getAttribute("aria-disabled") === "true") line += " disabled";
    if ((el.type === "file" && el.tagName === "INPUT") || el.control?.type === "file") line += " upload";
    if (el.getAttribute("aria-expanded") === "true") line += " expanded";
    return line;
  }

  /**
   * Walk the page once. With scope "viewport", only on-screen elements get a
   * line; the rest are counted so the agent knows there is more.
   */
  function collect({ scope = "viewport", hrefs = false } = {}) {
    pruneRefs();
    const items = [];
    let above = 0;
    let below = 0;
    let scanned = 0;
    for (const el of document.querySelectorAll("body *")) {
      if (++scanned > 12000) break;
      const d = describe(el);
      if (!d) continue;
      const where = placeOf(el);
      if (scope === "viewport" && where !== "in") {
        if (where === "above") above++;
        else below++;
        continue;
      }
      const ref = refFor(el);
      items.push({ el, ref, where, role: d.role, name: d.name, line: lineFor(el, d, ref, hrefs) });
    }
    return { items, above, below };
  }

  function joinCapped(lines, maxChars, more) {
    const out = [];
    let size = 0;
    for (let i = 0; i < lines.length; i++) {
      size += lines[i].length + 1;
      if (size > maxChars) {
        out.push(`... ${lines.length - i} more not shown${more ? ` (${more})` : ""}`);
        break;
      }
      out.push(lines[i]);
    }
    return out.join("\n");
  }

  function snapshot({ scope = "viewport", hrefs = false, maxChars = 9000 } = {}) {
    initOverlay();
    const { items, above, below } = collect({ scope, hrefs });
    const head = [`url: ${location.href}`, `title: ${document.title}`];
    if (scope === "viewport" && (above || below)) {
      const range = document.documentElement.scrollHeight - window.innerHeight;
      const pct = range > 0 ? Math.round((window.scrollY / range) * 100) : 0;
      head.push(
        `view: ${pct}% down · ${above} elements above, ${below} below ` +
          `(scroll, find, or snapshot scope "all")`
      );
    }
    const body = joinCapped(items.map((i) => i.line), maxChars, `use find or scope "all"`);
    return `${head.join("\n")}\n${body || "(no interactive elements in view)"}`;
  }

  /** Search every interactive element on the page, on screen or not. */
  function findElements({ query = "", limit = 8 } = {}) {
    const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) throw new Error("find needs a query, e.g. \"sign up button\"");
    const q = words.join(" ");
    const { items } = collect({ scope: "all", hrefs: true });
    const scored = [];
    for (const it of items) {
      const name = it.name.toLowerCase();
      const hay = `${it.role} ${name} ${it.el.placeholder || ""} ${it.el.getAttribute("href") || ""}`.toLowerCase();
      const hits = words.filter((w) => hay.includes(w)).length;
      if (!hits) continue;
      const score = hits * 4 + (name === q ? 3 : 0) + (name.startsWith(q) ? 1 : 0) + (it.where === "in" ? 1 : 0);
      scored.push({ it, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, Math.max(1, Math.min(limit, 30)));
    if (!top.length) return `no element matches "${query}"`;
    const lines = top.map(({ it }) => it.line + (it.where === "in" ? "" : ` (${it.where})`));
    if (scored.length > top.length) lines.push(`... ${scored.length - top.length} weaker matches`);
    return lines.join("\n");
  }

  // ---------------------------------------------------------- change report ---
  // Before an action the worker takes a baseline of what is on screen; after
  // it, the agent gets only the difference instead of a whole new snapshot.
  let baseline = null;

  function viewLines() {
    const map = new Map();
    for (const it of collect({ scope: "viewport" }).items) map.set(it.ref, it.line);
    return map;
  }

  const CHANGE_LIMIT = 30;

  function changes({ docId, addedOnly = false, limit = CHANGE_LIMIT } = {}) {
    if (docId && docId !== DOC_ID) {
      // A new document: there is nothing to diff against.
      baseline = { lines: viewLines() };
      return { navigated: true, snapshot: snapshot({ scope: "viewport" }) };
    }
    const now = viewLines();
    const before = baseline?.lines || new Map();
    const added = [];
    const removed = [];
    const changed = [];
    for (const [ref, line] of now) {
      if (!before.has(ref)) added.push(line);
      else if (before.get(ref) !== line) changed.push(line);
    }
    if (!addedOnly) for (const [ref, line] of before) if (!now.has(ref)) removed.push(line);
    baseline = { lines: now };

    const total = added.length + removed.length + changed.length;
    // A big change (new route, modal over everything) reads better as a view.
    if (!addedOnly && total > limit) {
      return { replaced: true, url: location.href, snapshot: snapshot({ scope: "viewport" }) };
    }
    return {
      url: location.href,
      title: document.title,
      added: added.slice(0, limit * 2),
      removed,
      changed,
      more: Math.max(0, added.length - limit * 2),
    };
  }

  function findByRef(ref) {
    if (!ref) return null;
    const el = refs.get(ref);
    if (el?.isConnected) return el;
    return document.querySelector(`[data-pointer-ref="${CSS.escape(String(ref))}"]`);
  }

  function find(selector) {
    if (!selector) return null;
    try {
      return document.querySelector(selector);
    } catch {
      return null;
    }
  }

  function center(el) {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
    };
  }

  function resolve(params) {
    const el = params.ref ? findByRef(params.ref) : find(params.selector);
    if (!el) {
      throw new Error(
        params.ref
          ? `Unknown ref ${params.ref}. Take a fresh snapshot — refs reset on navigation.`
          : `No element matches selector "${params.selector}".`
      );
    }
    return el;
  }

  /** The <input type=file> an upload button or label stands for. */
  function fileInputFor(el) {
    const isFile = (n) => n?.tagName === "INPUT" && n.type === "file";
    if (!el) return document.querySelector("input[type=file]");
    if (isFile(el)) return el;
    if (el.tagName === "LABEL" && isFile(el.control)) return el.control;
    const inside = el.querySelector?.("input[type=file]");
    if (inside) return inside;
    // Styled upload buttons usually sit next to a hidden input.
    let n = el.parentElement;
    for (let i = 0; i < 4 && n; i++, n = n.parentElement) {
      const near = n.querySelector("input[type=file]");
      if (near) return near;
    }
    return null;
  }

  function scrollIntoView(el) {
    const r = el.getBoundingClientRect();
    const pad = 80;
    if (r.top < pad || r.bottom > window.innerHeight - pad) {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    }
  }

  function readableText({ maxChars = 7000 } = {}) {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll("script,style,noscript,template,svg,iframe").forEach((n) => n.remove());
    const text = (clone.innerText || "")
      .replace(/[ \t]+/g, " ")
      .replace(/ ?\n ?/g, "\n") // lines holding only spaces cost tokens too
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return text.length > maxChars ? text.slice(0, maxChars) + "\n... truncated" : text;
  }

  async function waitFor({ text, selector, ref, ms }, timeout = 10000) {
    if (ms) {
      await sleep(Math.min(ms, 30000));
      return { ok: true, waited: ms };
    }
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (text && document.body.innerText.includes(text)) return { ok: true };
      if (selector && document.querySelector(selector)) return { ok: true };
      if (ref && findByRef(ref)) return { ok: true };
      await sleep(120);
    }
    return { ok: false, error: `Timed out waiting for ${text || selector || ref}` };
  }

  // ------------------------------------------------------------ tab badge ---
  // Chrome can't style a tab title, so mark the agent's tab with a text
  // prefix. The human can find the tab the agent is using without the agent
  // stealing focus. An observer keeps the prefix if the page rewrites its
  // title (SPAs do this constantly).
  let badgeLabel = null;
  let badgeBase = null;
  let badgeObserver = null;

  function badgePrefix() {
    return `${badgeLabel} · `;
  }

  function paintBadge() {
    if (!badgeLabel) return;
    const want = badgePrefix() + badgeBase;
    if (document.title !== want) document.title = want;
  }

  function watchTitle() {
    if (badgeObserver) return;
    const target = document.head || document.documentElement;
    if (!target) return;
    badgeObserver = new MutationObserver(() => {
      if (!badgeLabel) return;
      if (document.title.startsWith(badgePrefix())) return;
      // The page wrote a new title; keep it as the base and re-prefix.
      badgeBase = document.title || location.hostname || "page";
      paintBadge();
    });
    badgeObserver.observe(target, { childList: true, subtree: true, characterData: true });
  }

  function setBadge(label) {
    const next = String(label || "").trim() || "agent";
    // An empty title would become "Agent · ", which the browser trims to
    // "Agent ·"; that no longer matches the prefix and got prefixed again.
    if (!badgeLabel) badgeBase = document.title || location.hostname || "page";
    badgeLabel = next;
    paintBadge();
    watchTitle();
  }

  function clearBadge() {
    if (!badgeLabel) return;
    badgeLabel = null;
    badgeObserver?.disconnect();
    badgeObserver = null;
    if (badgeBase != null) document.title = badgeBase;
    badgeBase = null;
  }

  // ----------------------------------------------------------- human guard ---
  let agentWindowUntil = 0;

  // MV3 service workers are evicted after ~30s idle, which drops the hub socket.
  // While a tab has been driven recently, poke the worker often enough to keep
  // the session alive; otherwise stay quiet.
  let lastAgentActivity = 0;
  const keepalive = setInterval(() => {
    if (Date.now() - lastAgentActivity > 5 * 60 * 1000) return;
    toWorker({ type: "pointer:keepalive" });
  }, 20000);

  /**
   * Message the service worker. After the extension is reloaded, scripts left
   * in open tabs are orphaned and chrome.runtime throws "Extension context
   * invalidated" synchronously; stop quietly instead of logging an error.
   */
  function toWorker(msg) {
    try {
      if (!chrome.runtime?.id) throw new Error("orphaned");
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch {
      clearInterval(keepalive);
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !String(msg.type || "").startsWith("pointer:")) return;
    lastAgentActivity = Date.now();
    (async () => {
      try {
        switch (msg.type) {
          case "pointer:agent-window":
            // Trusted input dispatched by the extension is indistinguishable from
            // a human click, so mark the window in which takeover is ignored.
            agentWindowUntil = Date.now() + (msg.params?.ms || 1500);
            return sendResponse({ ok: true });
          case "pointer:ping":
            return sendResponse({ ok: true });
          case "pointer:mark": {
            const p = msg.params || {};
            if (p.off) {
              clearBadge();
              return sendResponse({ ok: true });
            }
            setBadge(p.label);
            return sendResponse({ ok: true, title: document.title });
          }
          case "pointer:snapshot":
            return sendResponse({ ok: true, text: snapshot(msg.params || {}) });
          case "pointer:file-input": {
            const p = msg.params || {};
            const el = p.ref || p.selector ? resolve(p) : null;
            const input = fileInputFor(el);
            if (!input) {
              if (!el) throw new Error("This page has no file input. Pass the ref of the upload button.");
              // Many sites create the file input only when their button is
              // clicked; the worker clicks it and catches the file picker.
              scrollIntoView(el);
              return sendResponse({ ok: true, chooser: true, name: nameOf(el).slice(0, 80) || "upload button", ...center(el) });
            }
            document.querySelectorAll("[data-pointer-upload]").forEach((n) => n.removeAttribute("data-pointer-upload"));
            input.setAttribute("data-pointer-upload", "1");
            // Point at what the human sees: styled upload buttons hide the input.
            const anchor = [el, input].find((n) => n && isVisible(n));
            if (anchor) scrollIntoView(anchor);
            return sendResponse({
              ok: true,
              multiple: input.multiple,
              accept: input.accept || "",
              name: (anchor ? nameOf(anchor) : nameOf(input)).slice(0, 80) || "file input",
              ...(anchor ? center(anchor) : {}),
            });
          }
          case "pointer:find":
            return sendResponse({ ok: true, text: findElements(msg.params || {}) });
          case "pointer:baseline":
            baseline = { lines: viewLines() };
            return sendResponse({ ok: true, docId: DOC_ID });
          case "pointer:changes":
            return sendResponse({ ok: true, ...changes(msg.params || {}) });
          case "pointer:locate": {
            const el = resolve(msg.params || {});
            scrollIntoView(el);
            await sleep(60);
            const { x, y, rect } = center(el);
            return sendResponse({
              ok: true, x, y, rect, role: roleOf(el), name: nameOf(el).slice(0, 80),
              inputType: el.tagName === "INPUT" ? el.type : null,
            });
          }
          case "pointer:move": {
            await move(msg.params.x, msg.params.y, msg.params);
            if (msg.params.label) say(msg.params.action || "moving", msg.params.label);
            return sendResponse({ ok: true });
          }
          case "pointer:act": {
            const p = msg.params || {};
            await move(p.x, p.y, p);
            if (p.rect) outline(p.rect);
            say(p.action || "act", p.label);
            if (p.click) {
              ripple();
              await sleep(120);
            }
            return sendResponse({ ok: true });
          }
          case "pointer:hide":
            hide();
            return sendResponse({ ok: true });
          case "pointer:text":
            return sendResponse({ ok: true, text: readableText(msg.params || {}) });
          case "pointer:scroll": {
            const p = msg.params || {};
            const amount = p.amount ?? 600;
            if (p.ref) {
              const el = findByRef(p.ref);
              el?.scrollIntoView({ block: "center", behavior: "instant" });
            } else {
              // "instant": pages with smooth scrolling animate, and in a
              // background tab that animation stalls, so nothing would move.
              const dx = p.direction === "left" ? -amount : p.direction === "right" ? amount : 0;
              const dy = p.direction === "up" ? -amount : dx ? 0 : amount;
              window.scrollBy({ left: dx, top: dy, behavior: "instant" });
            }
            say(`scroll ${p.direction || "down"}`, "");
            return sendResponse({ ok: true, y: Math.round(window.scrollY) });
          }
          case "pointer:wait":
            return sendResponse(await waitFor(msg.params || {}));
          // Page-event fallbacks, used when Chrome blocks debugger input on
          // this page. These events are untrusted, so some sites ignore them.
          case "pointer:domclick": {
            const el = resolve(msg.params || {});
            const r = el.getBoundingClientRect();
            const at = {
              bubbles: true, cancelable: true, composed: true, view: window, button: 0,
              clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
            };
            const ptr = { ...at, pointerId: 1, pointerType: "mouse", isPrimary: true };
            el.dispatchEvent(new PointerEvent("pointerdown", ptr));
            el.dispatchEvent(new MouseEvent("mousedown", at));
            el.focus?.({ preventScroll: true });
            el.dispatchEvent(new PointerEvent("pointerup", ptr));
            el.dispatchEvent(new MouseEvent("mouseup", at));
            sendResponse({ ok: true });
            // Click after replying: an alert() here would block the reply.
            setTimeout(() => el.click(), 0);
            return;
          }
          case "pointer:dompress": {
            const parts = String(msg.params?.key || "Enter").split("+");
            const key = parts.pop();
            const target = document.activeElement || document.body;
            const init = {
              key, bubbles: true, cancelable: true, composed: true,
              code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
              ctrlKey: parts.includes("Control"), metaKey: parts.includes("Meta"),
              altKey: parts.includes("Alt"), shiftKey: parts.includes("Shift"),
            };
            const proceed = target.dispatchEvent(new KeyboardEvent("keydown", init));
            sendResponse({ ok: true });
            setTimeout(() => {
              // A synthetic Enter does not submit a form by itself.
              if (proceed && key === "Enter" && target.form && target.tagName !== "TEXTAREA") {
                target.form.requestSubmit ? target.form.requestSubmit() : target.form.submit();
              }
              target.dispatchEvent(new KeyboardEvent("keyup", init));
            }, 0);
            return;
          }
          case "pointer:domfill": {
            const p = msg.params || {};
            const el = p.ref ? findByRef(p.ref) : find(p.selector);
            if (!el) throw new Error("Field not found");
            el.focus();
            if (el.isContentEditable) {
              el.textContent = p.text ?? "";
            } else {
              const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement : HTMLInputElement;
              const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set;
              if (setter) setter.call(el, p.text ?? "");
              else el.value = p.text ?? "";
            }
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return sendResponse({ ok: true });
          }
          case "pointer:viewport":
            return sendResponse({ ok: true, width: innerWidth, height: innerHeight, dpr: devicePixelRatio });
          default:
            return sendResponse({ ok: false, error: `Unknown content command ${msg.type}` });
        }
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true; // async
  });

  // Escape stops the agent; a real (trusted) pointer press means the human took over.
  // Both count only in a tab the agent is driving, while the human can see it:
  // this script runs on every page, and Escape in an unrelated tab (leaving a
  // YouTube fullscreen, closing a Facebook popup) must not stop the agent.
  const humanCanSeeAgentTab = () => Boolean(badgeLabel) && document.visibilityState === "visible";

  window.addEventListener(
    "keydown",
    (e) => {
      // The agent's own `press Escape` is trusted too; ignore it like its clicks.
      if (e.key === "Escape" && e.isTrusted && humanCanSeeAgentTab() && Date.now() >= agentWindowUntil) {
        toWorker({ type: "pointer:stop", reason: "escape" });
        hide();
      }
    },
    true
  );
  window.addEventListener(
    "pointerdown",
    (e) => {
      if (!e.isTrusted || !ui.shown || !humanCanSeeAgentTab()) return;
      if (Date.now() < agentWindowUntil) return; // it was the agent's own click
      toWorker({ type: "pointer:stop", reason: "takeover" });
      hide();
    },
    true
  );

  // Probe so the service worker can tell whether it needs to inject us.
  chrome.runtime
    .sendMessage({ type: "pointer:hello", url: location.href })
    .catch(() => {});
})();
