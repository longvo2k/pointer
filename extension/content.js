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

  function isInteractive(el, role) {
    if (["button", "link", "checkbox", "radio", "textbox", "searchbox", "combobox",
         "switch", "tab", "menuitem", "slider", "spinbutton", "option", "disclosure"].includes(role)) return true;
    if (el.hasAttribute && (el.hasAttribute("onclick") || el.isContentEditable)) return true;
    if (el.tagName === "LABEL") return true;
    const c = getComputedStyle(el).cursor;
    return c === "pointer" && !!(nameOf(el) || "").length;
  }

  const refs = new Map();

  function clearRefs() {
    document.querySelectorAll("[data-pointer-ref]").forEach((el) => {
      el.removeAttribute("data-pointer-ref");
    });
    refs.clear();
  }

  function snapshot({ maxChars = 9000 } = {}) {
    initOverlay();
    clearRefs();

    const seen = new Set();
    const lines = [];
    let n = 0;
    let scanned = 0;

    // Every element with pointer affordance, plus the semantic candidates.
    // A plain div-based tab has no role and no tag we can key on, but the page
    // still says cursor:pointer, which is the best signal available.
    for (const el of document.querySelectorAll("body *")) {
      if (++scanned > 12000) break;
      if (seen.has(el)) continue;
      const tag = el.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEMPLATE" || tag === "SVG") continue;
      if (!isVisible(el)) continue;

      let role = roleOf(el);
      if (!role) {
        const style = getComputedStyle(el);
        if (style.cursor !== "pointer") continue;
        // Skip wrappers whose real control is listed separately.
        if (el.querySelector("input,select,textarea,button,a[href],[role]")) continue;
        if (tag === "LABEL") continue;
        if (!nameOf(el)) continue;
        role = "clickable";
      }
      if (!isInteractive(el, role)) continue;

      const name = nameOf(el).slice(0, 120);
      const n2 = ++n;
      const ref = "e" + n2;
      el.setAttribute("data-pointer-ref", ref);
      refs.set(ref, el);
      if (role === "heading") continue; // context only, not actionable

      let line = `- ${role}`;
      if (name) line += ` "${name}"`;
      line += ` [ref=${ref}]`;

      if (el.tagName === "A" && el.href) {
        try {
          const u = new URL(el.href);
          line += ` href="${(u.pathname + u.search).slice(0, 80) || "/"}"`;
        } catch {}
      }
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        const v = el.type === "password" ? "" : (el.value || "").slice(0, 60);
        if (v) line += ` value="${v.replace(/"/g, "'")}"`;
        if (el.placeholder && !name) line += ` placeholder="${el.placeholder.slice(0, 60)}"`;
      }
      if (el.type === "checkbox" || el.type === "radio") line += el.checked ? " checked" : "";
      if (el.disabled || el.getAttribute("aria-disabled") === "true") line += " disabled";
      if (el.getAttribute("aria-expanded") === "true") line += " expanded";

      lines.push(line);
      if (lines.join("\n").length > maxChars) {
        lines.push(`... truncated at ${n} elements`);
        break;
      }
    }

    const head = [`url: ${location.href}`, `title: ${document.title}`];
    const body = lines.join("\n");
    return `${head.join("\n")}\n${body || "(no interactive elements found)"}`;
  }

  function findByRef(ref) {
    if (!ref) return null;
    if (refs.has(ref)) return refs.get(ref);
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

  function scrollIntoView(el) {
    const r = el.getBoundingClientRect();
    const pad = 80;
    if (r.top < pad || r.bottom > window.innerHeight - pad) {
      el.scrollIntoView({ block: "center", inline: "center" });
    }
  }

  function readableText({ maxChars = 7000 } = {}) {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll("script,style,noscript,template,svg,iframe").forEach((n) => n.remove());
    const text = (clone.innerText || "")
      .replace(/[ \t]+/g, " ")
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
      badgeBase = document.title;
      paintBadge();
    });
    badgeObserver.observe(target, { childList: true, subtree: true, characterData: true });
  }

  function setBadge(label) {
    const next = String(label || "").trim() || "agent";
    if (!badgeLabel) badgeBase = document.title;
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
  setInterval(() => {
    if (Date.now() - lastAgentActivity > 5 * 60 * 1000) return;
    chrome.runtime.sendMessage({ type: "pointer:keepalive" }).catch(() => {});
  }, 20000);

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
          case "pointer:locate": {
            const el = resolve(msg.params || {});
            scrollIntoView(el);
            await sleep(60);
            const { x, y, rect } = center(el);
            return sendResponse({ ok: true, x, y, rect, role: roleOf(el), name: nameOf(el).slice(0, 80) });
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
              el?.scrollIntoView({ block: "center" });
            } else if (p.direction === "up") window.scrollBy(0, -amount);
            else if (p.direction === "left") window.scrollBy(-amount, 0);
            else if (p.direction === "right") window.scrollBy(amount, 0);
            else window.scrollBy(0, amount);
            say(`scroll ${p.direction || "down"}`, "");
            return sendResponse({ ok: true, y: Math.round(window.scrollY) });
          }
          case "pointer:wait":
            return sendResponse(await waitFor(msg.params || {}));
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
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && e.isTrusted) {
        chrome.runtime.sendMessage({ type: "pointer:stop", reason: "escape" }).catch(() => {});
        hide();
      }
    },
    true
  );
  window.addEventListener(
    "pointerdown",
    (e) => {
      if (!e.isTrusted || !ui.shown) return;
      if (Date.now() < agentWindowUntil) return; // it was the agent's own click
      chrome.runtime.sendMessage({ type: "pointer:stop", reason: "takeover" }).catch(() => {});
      hide();
    },
    true
  );

  // Probe so the service worker can tell whether it needs to inject us.
  chrome.runtime
    .sendMessage({ type: "pointer:hello", url: location.href })
    .catch(() => {});
})();
