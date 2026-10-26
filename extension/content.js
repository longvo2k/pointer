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
  // The host is kept here, never looked up by id: a page could plant a decoy
  // element or style it away. A random tag, a closed shadow root and
  // !important inline styles keep page CSS and scripts out of it.
  let overlayHost = null;
  let overlayRoot = null;

  function ensureOverlay() {
    if (overlayHost) {
      if (!overlayHost.isConnected) (document.documentElement || document.body).appendChild(overlayHost);
      return overlayRoot;
    }
    const host = document.createElement("pointer-" + Math.random().toString(36).slice(2, 10));
    host.setAttribute("aria-hidden", "true");
    for (const [prop, value] of Object.entries({
      all: "initial", display: "block", position: "fixed", inset: "0", "pointer-events": "none",
      "z-index": "2147483647", visibility: "visible", opacity: "1",
    })) host.style.setProperty(prop, value, "important");
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .glow, .arrow, .ripple, .label, .target, .caption, .spot {
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
        /* A dark card with a light ring reads on light and dark pages alike. */
        .caption {
          left: 50%; bottom: 20px; width: max-content; max-width: min(760px, calc(100vw - 32px));
          display: flex; align-items: baseline; gap: 10px; padding: 10px 16px;
          border-radius: 12px; background: rgba(17,24,39,.94); color: #f9fafb;
          font: 500 15px/1.45 ui-sans-serif, -apple-system, "Segoe UI", sans-serif;
          box-shadow: 0 8px 28px rgba(0,0,0,.32), 0 0 0 1px rgba(255,255,255,.14);
          opacity: 0; transform: translate(-50%, 6px);
          transition: opacity 180ms ease, transform 180ms ease;
        }
        .caption.on { opacity: 1; transform: translate(-50%, 0); }
        .caption.top { top: 20px; bottom: auto; }
        .caption .step {
          flex: none; padding: 1px 8px; border-radius: 999px; background: #2563eb; color: #fff;
          font-size: 12.5px; font-weight: 600; letter-spacing: .02em;
        }
        .caption .step:empty { display: none; }
        .caption .text {
          overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical;
          -webkit-line-clamp: 4; overflow: hidden;
        }
        .spot {
          border: 2px solid rgba(37,99,235,.95); border-radius: 6px;
          box-shadow: 0 0 0 4px rgba(37,99,235,.22); opacity: 0; transition: opacity 160ms ease;
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
      <div class="spot"></div>
      <div class="caption"><span class="step"></span><span class="text"></span></div>
    `;
    (document.documentElement || document.body).appendChild(host);
    overlayHost = host;
    overlayRoot = root;
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
    clearCaption();
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
      placeCaption();
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
        placeCaption();
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

  // --------------------------------------------------------------- caption ---
  // Narration for a human watching the tab: a card at the bottom (or the top,
  // when the pointer or the outlined element sits under it) plus an outline
  // that follows the element it describes.
  const caption = { on: false, timer: 0, spotEl: null, frame: 0 };

  function captionParts() {
    initOverlay();
    return { box: ui.root.querySelector(".caption"), spot: ui.root.querySelector(".spot") };
  }

  function showCaption({ text, step, until, ref, selector }) {
    const target = ref || selector ? resolve({ ref, selector }) : null;
    const { box } = captionParts();
    box.querySelector(".step").textContent = step || "";
    box.querySelector(".text").textContent = text || "";
    box.style.visibility = "";
    box.style.transition = document.visibilityState === "hidden" ? "none" : "";
    box.classList.add("on");
    caption.on = true;
    clearTimeout(caption.timer);
    if (until) caption.timer = setTimeout(clearCaption, Math.max(0, until - Date.now()));
    trackSpot(target);
    if (target) scrollIntoView(target);
    placeSpot();
    placeCaption();
    return target ? `${roleOf(target) || "element"} "${oneLine(nameOf(target), 60)}"` : null;
  }

  function clearCaption() {
    clearTimeout(caption.timer);
    trackSpot(null);
    if (!caption.on) return false;
    caption.on = false;
    const { box } = captionParts();
    // Hidden tabs freeze CSS fades, so a screenshot would catch it half gone.
    box.style.transition = document.visibilityState === "hidden" ? "none" : "";
    box.classList.remove("on", "top");
    return true;
  }

  /** Hide or restore the caption without clearing it, e.g. around a screenshot. */
  function captionVisible(on) {
    if (!caption.on) return;
    const { box, spot } = captionParts();
    box.style.visibility = on ? "" : "hidden";
    spot.style.visibility = on ? "" : "hidden";
  }

  const onViewChange = () => {
    if (caption.frame) return;
    caption.frame = requestAnimationFrame(() => {
      caption.frame = 0;
      placeSpot();
      placeCaption();
    });
  };

  function trackSpot(el) {
    const had = caption.spotEl;
    caption.spotEl = el;
    if (el && !had) {
      window.addEventListener("scroll", onViewChange, { capture: true, passive: true });
      window.addEventListener("resize", onViewChange, { passive: true });
    } else if (!el && had) {
      window.removeEventListener("scroll", onViewChange, { capture: true });
      window.removeEventListener("resize", onViewChange);
    }
    if (!el && ui.root) {
      const spot = ui.root.querySelector(".spot");
      spot.style.opacity = "0";
      spot.style.visibility = "";
    }
  }

  function placeSpot() {
    const el = caption.spotEl;
    if (!el || !ui.root) return;
    const spot = ui.root.querySelector(".spot");
    if (!el.isConnected) {
      spot.style.opacity = "0";
      return;
    }
    const r = el.getBoundingClientRect();
    const pad = 4;
    Object.assign(spot.style, {
      left: r.left - pad + "px",
      top: r.top - pad + "px",
      width: r.width + pad * 2 + "px",
      height: r.height + pad * 2 + "px",
      opacity: "1",
    });
  }

  /** Move the card to the top when it would hide the pointer or the outlined element. */
  function placeCaption() {
    if (!caption.on || !ui.root) return;
    const box = ui.root.querySelector(".caption");
    const band = window.innerHeight - 20 - box.offsetHeight - 12;
    const spot = caption.spotEl?.isConnected ? caption.spotEl.getBoundingClientRect() : null;
    const under = (ui.shown && ui.y > band) || (spot && spot.bottom > band && spot.top < window.innerHeight);
    box.classList.toggle("top", Boolean(under));
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
    // Chrome 121+: also catches a transparent or hidden ancestor.
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) < 0.05) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 1 && r.height >= 1;
  }

  /**
   * Page text on one line. Snapshot lines are parsed by an agent, so a page
   * must not be able to start a new line or close a quote and forge an
   * element or a ref.
   */
  function oneLine(s, max = 160) {
    return String(s ?? "")
      .replace(/[\s\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
      .trim()
      .replace(/"/g, "'")
      .slice(0, max);
  }

  const SECRET_AUTOCOMPLETE = /(^|\s)(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp\S*)(\s|$)/i;
  const SECRET_WORDS = new Set(["password", "passwd", "pass", "passcode", "pwd", "otp", "totp", "pin", "cvv", "cvc", "csc"]);
  const SECRET_PHRASE = /onetime|cardnumber|ccnumber|securitycode/;

  /** True when a field's name or id says it holds a secret ("userPassword", "otp_code"). */
  function secretName(text) {
    const words = String(text).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/);
    return words.some((w) => SECRET_WORDS.has(w)) || SECRET_PHRASE.test(words.join(""));
  }

  /** Fields whose value must never reach the agent. */
  function isSensitive(el) {
    if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") return false;
    if (el.type === "password") return true;
    if (SECRET_AUTOCOMPLETE.test(el.getAttribute("autocomplete") || "")) return true;
    return secretName(`${el.name || ""} ${el.id || ""}`);
  }

  /** Secret-looking query values and the #fragment (OAuth tokens) removed. */
  const SECRET_PARAM =
    /(^|[_.-])(access_?token|id_?token|refresh_?token|token|secret|code|api_?key|key|auth|session(_?id)?|sid|sig(nature)?|password|passwd|pass|otp|jwt|ticket|credentials?)$/i;
  function safeUrl(href) {
    try {
      const u = new URL(href);
      u.hash = "";
      for (const k of [...u.searchParams.keys()]) if (SECRET_PARAM.test(k)) u.searchParams.set(k, "redacted");
      return u.href.replace(/=redacted/g, "=…");
    } catch {
      return String(href || "").split("#")[0];
    }
  }

  function nameOf(el) {
    const clean = (s) => oneLine(s, 400);
    const aria = el.getAttribute && el.getAttribute("aria-label");
    if (aria && aria.trim()) return clean(aria);

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
      if (el.type === "submit" || el.type === "button" || el.type === "reset") return clean(el.value);
      // Never the field's own value: it may be a password or other secret.
      return clean(el.getAttribute("title"));
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
      const text = oneLine(el.innerText, 160);
      if (!text) return null;
      return { role: el.getAttribute("role") === "alert" ? "alert" : "status", name: text };
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
    let line = `- ${oneLine(role, 40)}`;
    if (name) line += ` "${oneLine(name, 160)}"`;
    line += ` [ref=${ref}]`;

    // Link targets are ~45% of a snapshot and rarely needed to act; opt in.
    if (hrefs && el.tagName === "A" && el.href) {
      try {
        const u = new URL(safeUrl(el.href));
        const where = u.origin === location.origin ? "" : u.host;
        line += ` href="${oneLine(where + u.pathname + u.search, 80) || "/"}"`;
      } catch {}
    }
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      if (isSensitive(el)) {
        if (el.value) line += " value=(hidden)";
      } else {
        const v = oneLine(el.value, 60);
        if (v) line += ` value="${v}"`;
      }
      const ph = oneLine(el.placeholder, 60);
      if (ph && !name) line += ` placeholder="${ph}"`;
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
    let truncated = false;
    for (const el of document.querySelectorAll("body *")) {
      if (++scanned > 12000) {
        truncated = true;
        break;
      }
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
    return { items, above, below, truncated };
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
    try {
      initOverlay();
    } catch {} // the cursor is a nicety; the snapshot must still work
    const { items, above, below, truncated } = collect({ scope, hrefs });
    const head = [`url: ${safeUrl(location.href)}`, `title: ${oneLine(document.title, 200)}`];
    if (truncated) head.push("note: very large page, only the first 12000 elements were scanned");
    const blocked = blockingNote(items);
    if (blocked) head.push(blocked);
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
    const blocked = blockingNote(items);
    if (blocked) lines.unshift(blocked);
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
      return { replaced: true, url: safeUrl(location.href), snapshot: snapshot({ scope: "viewport" }) };
    }
    return {
      url: safeUrl(location.href),
      title: oneLine(document.title, 200),
      added: added.slice(0, limit * 2),
      removed: removed.slice(0, limit * 2),
      changed: changed.slice(0, limit * 2),
      more: Math.max(0, added.length - limit * 2),
    };
  }

  function findByRef(ref) {
    if (!ref) return null;
    const el = refs.get(ref);
    return el?.isConnected ? el : null;
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

  // --------------------------------------------------------------- blockers ---
  // A popup (newsletter modal, cookie wall, chat widget) can sit over the
  // element the agent wants. A trusted click at that spot lands on the popup,
  // so check what is really on top before clicking.
  const MODAL = 'dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"]';
  const CLOSE_WORDS =
    /^(close|dismiss|not now|no,? thanks?|no thank you|maybe later|later|skip|cancel|continue without|x|×|✕|✖|╳)(?![a-z])/i;

  /** The outermost fixed or sticky box around n: a layer floating over the page. */
  function layerOf(n) {
    let layer = null;
    for (; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      const p = getComputedStyle(n).position;
      if (p === "fixed" || p === "sticky") layer = n;
    }
    return layer;
  }

  /**
   * What hides el at (x, y), or null when a click there reaches el. Only a
   * dialog or a floating layer counts: a transparent input laid over a styled
   * box in the same component still gets the click the agent meant.
   */
  function coverAt(el, x, y) {
    const hit = document.elementFromPoint(x, y);
    if (!hit || hit === el || el.contains(hit) || hit.contains(el)) return null;
    if (hit.tagName === "LABEL" && hit.control === el) return null;
    if (el.tagName === "LABEL" && el.control === hit) return null;
    const modal = hit.closest(MODAL);
    if (modal && !modal.contains(el)) return modal;
    const layer = layerOf(hit);
    if (layer && !layer.contains(el)) return layer;
    return null;
  }

  const onScreen = (x, y) => x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight;

  /** A point a click on el would really reach: the center, or another spot when only part of el is covered. */
  function clickPoint(el) {
    const { x, y } = center(el);
    if (!onScreen(x, y)) return { x, y };
    const cover = coverAt(el, x, y);
    if (!cover) return { x, y };
    const r = el.getBoundingClientRect();
    const spots = [[0.5, 0.2], [0.5, 0.8], [0.2, 0.5], [0.8, 0.5], [0.15, 0.2], [0.85, 0.2], [0.15, 0.8], [0.85, 0.8]];
    for (const [fx, fy] of spots) {
      const px = Math.round(r.left + r.width * fx);
      const py = Math.round(r.top + r.height * fy);
      if (onScreen(px, py) && !coverAt(el, px, py)) return { x: px, y: py };
    }
    return { x, y, cover };
  }

  function boxName(box) {
    const aria = box.getAttribute("aria-label");
    if (aria?.trim()) return oneLine(aria, 60);
    const by = box.getAttribute("aria-labelledby");
    const labelled = by && by.split(/\s+/).map((id) => document.getElementById(id)?.innerText).filter(Boolean).join(" ");
    if (labelled?.trim()) return oneLine(labelled, 60);
    const heading = [...box.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]")].find(isVisible);
    if (heading?.innerText.trim()) return oneLine(heading.innerText, 60);
    return oneLine(box.innerText, 60);
  }

  /**
   * Describe what covers the page and how to close it: { what, close }. A
   * backdrop is often a sibling of its dialog, so name the open dialog then.
   */
  function blockerInfo(cover) {
    let box = cover.matches(MODAL) ? cover : cover.querySelector(MODAL);
    if (!box && !cover.querySelector(CANDIDATE)) {
      box = [...document.querySelectorAll(MODAL)].filter(isVisible).pop() || null;
    }
    box = box || cover;
    const kind = box.matches(MODAL) ? (box.getAttribute("role") === "alertdialog" ? "alertdialog" : "dialog") : "popup";
    const name = boxName(box);
    const what = `${kind}${name ? ` "${name}"` : ""} [ref=${refFor(box)}]`;
    let close = null;
    for (const scope of new Set([box, cover])) {
      for (const n of scope.querySelectorAll(CANDIDATE)) {
        const d = describe(n);
        if (!d || !ACTIONABLE.has(d.role)) continue;
        const label = `${d.name} ${n.getAttribute("title") || ""} ${n.className?.baseVal ?? n.className ?? ""}`;
        if (CLOSE_WORDS.test(d.name.trim()) || /\b(close|dismiss)\b/i.test(label)) {
          close = `${refFor(n)}${d.name ? ` "${oneLine(d.name, 40)}"` : ""}`;
          break;
        }
      }
      if (close) break;
    }
    const how = close ? `close it first: click ${close} (or press Escape)` : "close it first (press Escape, or snapshot to find its close button)";
    return { what, how };
  }

  /** One note for the top of a snapshot when a popup covers what is in view. */
  function blockingNote(items) {
    const counts = new Map();
    let checked = 0;
    for (const it of items) {
      if (it.where !== "in") continue;
      if (++checked > 300) break;
      const { x, y } = center(it.el);
      if (!onScreen(x, y)) continue;
      const cover = coverAt(it.el, x, y);
      if (cover) counts.set(cover, (counts.get(cover) || 0) + 1);
    }
    let top = null;
    let n = 0;
    for (const [cover, k] of counts) if (k > n) [top, n] = [cover, k];
    if (!top || (n < 3 && n * 2 < checked)) return null;
    const { what, how } = blockerInfo(top);
    return `blocked: ${what} covers ${n} element${n === 1 ? "" : "s"} in view; clicks there land on it. To use the page behind it, ${how}.`;
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
    // innerText of the live body skips what is not rendered (display:none,
    // scripts, templates). A detached clone would include hidden text, which
    // a page could use to address the agent behind the human's back.
    const text = (document.body?.innerText || "")
      .replace(/[ \t]+/g, " ")
      .replace(/ ?\n ?/g, "\n") // lines holding only spaces cost tokens too
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return text.length > maxChars ? text.slice(0, maxChars) + "\n... truncated" : text;
  }

  async function waitFor({ text, selector, ref, ms }, timeout = 10000) {
    if (ms) {
      const waited = Math.min(Number(ms) || 0, 30000);
      await sleep(waited);
      return { ok: true, waited };
    }
    if (selector) {
      try {
        document.querySelector(selector);
      } catch {
        return { ok: false, error: `Invalid CSS selector "${selector}"` };
      }
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

  // ----------------------------------------------------------------- layout ---
  // Measure the page for layout bugs a screenshot hides: overflow, clipped
  // text, overlaps, small tap targets, tight padding, uneven gaps. Fixed code,
  // no page scripts: it only reads sizes and computed styles.

  const px = (n) => `${Math.round(n)}px`;
  const size = (w, h) => `${Math.round(w)}x${Math.round(h)}px`;

  /** Fixed or sticky (itself or an ancestor): it moves with scrolling, so overlaps are expected. */
  function pinned(el) {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const p = getComputedStyle(n).position;
      if (p === "fixed" || p === "sticky") return true;
    }
    return false;
  }

  /** Bounding box of the element's text only (not images, video or empty boxes). */
  function textBox(el) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let box = null;
    let count = 0;
    for (let n = walker.nextNode(); n && count < 300; n = walker.nextNode()) {
      if (!n.textContent.trim()) continue;
      const parent = n.parentElement;
      if (!parent || !isVisible(parent)) continue;
      // Text inside a scroller or clipping box only shows within that box.
      let clip = null;
      for (let a = parent; a && a !== el; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (cs.overflowX !== "visible" || cs.overflowY !== "visible") clip = a.getBoundingClientRect();
      }
      range.selectNodeContents(n);
      for (let r of range.getClientRects()) {
        if (clip) {
          r = { left: Math.max(r.left, clip.left), right: Math.min(r.right, clip.right), top: Math.max(r.top, clip.top), bottom: Math.min(r.bottom, clip.bottom) };
          r.width = r.right - r.left;
          r.height = r.bottom - r.top;
        }
        if (r.width <= 0 || r.height <= 0) continue;
        count++;
        box = box
          ? { left: Math.min(box.left, r.left), top: Math.min(box.top, r.top), right: Math.max(box.right, r.right), bottom: Math.max(box.bottom, r.bottom) }
          : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      }
    }
    return box;
  }
  const LAYOUT_SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "BR", "WBR"]);

  /** A short handle for any element: role and name if it has one, else tag.class "text". */
  function labelOf(el) {
    const d = describe(el);
    const ref = refFor(el);
    if (d) return `${oneLine(d.role, 30)}${d.name ? ` "${oneLine(d.name, 40)}"` : ""} [ref=${ref}]`;
    const cls = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/)[0] : "";
    const text = oneLine(el.innerText || el.getAttribute?.("aria-label") || "", 30);
    return `${el.tagName.toLowerCase()}${cls}${text ? ` "${text}${(el.innerText || "").length > 30 ? "…" : ""}"` : ""} [ref=${ref}]`;
  }

  /** The nearest ancestor that clips or scrolls horizontally (it contains overflow). */
  function clipsX(el) {
    for (let n = el.parentElement; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      const o = getComputedStyle(n).overflowX;
      if (o !== "visible") return n;
    }
    return null;
  }

  /** A box the eye reads as a box: its own background, a border all round, or a shadow. */
  function hasBoundary(el, cs) {
    const bg = cs.backgroundColor;
    const solid = bg && bg !== "transparent" && !/rgba\([^)]*,\s*0\)$/.test(bg);
    const parentBg = el.parentElement ? getComputedStyle(el.parentElement).backgroundColor : "";
    const ownBg = solid && bg !== parentBg;
    const border = ["Top", "Right", "Bottom", "Left"].every((s) => parseFloat(cs[`border${s}Width`]) > 0 && cs[`border${s}Style`] !== "none");
    return ownBg || border || (cs.boxShadow && cs.boxShadow !== "none");
  }

  function isInteractiveEl(el) {
    const d = describe(el);
    return Boolean(d && ACTIONABLE.has(d.role));
  }

  /** Links inside running text are exempt from target size rules (WCAG 2.5.8). */
  function inlineInText(el) {
    if (el.tagName !== "A") return false;
    const parent = el.parentElement;
    if (!parent || getComputedStyle(el).display !== "inline") return false;
    const text = (parent.innerText || "").replace(/\s+/g, " ").trim();
    return text.length > (el.innerText || "").trim().length + 20;
  }

  function layoutReport({ scope = "all", limit = 40 } = {}) {
    const W = document.documentElement.clientWidth;
    const H = window.innerHeight;
    const touch = navigator.maxTouchPoints > 0 || matchMedia("(pointer: coarse)").matches;
    const issues = []; // { level: "!" | "~", kind, text }
    const add = (level, kind, text) => issues.push({ level, kind, text });
    const inScope = (r) => scope !== "viewport" || (r.bottom > 0 && r.top < H);

    const els = [];
    let scanned = 0;
    for (const el of document.body.querySelectorAll("*")) {
      if (++scanned > 8000) break;
      if (LAYOUT_SKIP.has(el.tagName.toUpperCase()) || el === overlayHost) continue;
      if (!isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      if (!inScope(r)) continue;
      if (r.right <= 0 || r.bottom + scrollY <= 0) continue; // parked off-page, like a skip link
      els.push({ el, r, cs: getComputedStyle(el) });
    }
    const truncated = scanned > 8000;

    // 1. Page wider than the screen: the element that sticks out of a parent that fits.
    const pageW = document.documentElement.scrollWidth;
    if (pageW > W + 1) {
      const culprits = [];
      for (const { el, r, cs } of els) {
        if (cs.position === "fixed") continue;
        if (r.right <= W + 1 && r.left >= -1) continue;
        if (clipsX(el)) continue;
        const pr = el.parentElement?.getBoundingClientRect();
        if (pr && pr.right > W + 1 && el.parentElement !== document.body) continue;
        culprits.push(`${labelOf(el)} sticks out by ${px(Math.max(r.right - W, -r.left))}`);
        if (culprits.length >= 4) break;
      }
      add("!", "overflow", `page is ${px(pageW - W)} wider than the screen (${px(pageW)} vs ${px(W)})` +
        (culprits.length ? `: ${culprits.join("; ")}` : ""));
    }

    // 2. Text cut off by its box, or hidden in a horizontal scroller.
    for (const { el, cs } of els) {
      const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!ownText) continue;
      const overX = el.scrollWidth - el.clientWidth;
      const overY = el.scrollHeight - el.clientHeight;
      if (overX > 1 && cs.overflowX === "hidden") {
        add("!", "clipped", `text clipped: ${labelOf(el)} needs ${px(el.scrollWidth)}, has ${px(el.clientWidth)}` +
          (cs.textOverflow === "ellipsis" ? " (shown with …)" : ""));
      } else if (overX > 1 && (cs.overflowX === "auto" || cs.overflowX === "scroll")) {
        add("~", "clipped", `text scrolls sideways: ${labelOf(el)} shows ${px(el.clientWidth)} of ${px(el.scrollWidth)}`);
      } else if (overY > 2 && cs.overflowY === "hidden" && !/^-?webkit-box$/.test(cs.display)) {
        add("!", "clipped", `text clipped: ${labelOf(el)} needs ${px(el.scrollHeight)} tall, has ${px(el.clientHeight)}`);
      }
    }

    // 3. Clickable elements covering each other.
    const targets = els.filter(({ el }) => isInteractiveEl(el));
    const fixedish = new Set(targets.filter(({ el }) => pinned(el)).map(({ el }) => el));
    for (let i = 0; i < targets.length; i++) {
      for (let j = i + 1; j < targets.length; j++) {
        const a = targets[i], b = targets[j];
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        if (fixedish.has(a.el) !== fixedish.has(b.el)) continue; // a sticky header over scrolled content
        const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (w <= 4 || h <= 4) continue;
        const cx = Math.max(a.r.left, b.r.left) + w / 2;
        const cy = Math.max(a.r.top, b.r.top) + h / 2;
        const top = cy >= 0 && cy < H ? document.elementFromPoint(cx, cy) : null;
        const [over, under] = top && (b.el === top || b.el.contains(top)) ? [b, a] : [a, b];
        add("!", "overlap", `overlap: ${labelOf(over.el)} covers ${labelOf(under.el)} by ${size(w, h)}`);
      }
    }

    // 4. Tap targets (WCAG 2.5.8: 24px minimum; 44px recommended on touch screens).
    // A target under 24px still passes when a 24px square on its center touches no other target.
    const spaced = (t) => {
      const cx = (t.r.left + t.r.right) / 2;
      const cy = (t.r.top + t.r.bottom) / 2;
      const sq = { left: cx - 12, right: cx + 12, top: cy - 12, bottom: cy + 12 };
      return !targets.some((o) => o !== t && !o.el.contains(t.el) && !t.el.contains(o.el) &&
        o.r.left < sq.right && o.r.right > sq.left && o.r.top < sq.bottom && o.r.bottom > sq.top);
    };
    const smallOnTouch = [];
    for (const t of targets) {
      const { el, r } = t;
      if (inlineInText(el) || el.tagName === "LABEL") continue;
      const small = Math.min(r.width, r.height);
      if (small < 24 && !spaced(t)) add("!", "target", `tap target too small and crowded: ${labelOf(el)} is ${size(r.width, r.height)} (minimum 24x24, or 24px of space)`);
      else if (touch && small < 44) smallOnTouch.push(`${labelOf(el)} ${size(r.width, r.height)}`);
    }
    if (smallOnTouch.length) {
      const shown = smallOnTouch.slice().sort((a, b) => parseInt(a.match(/x(\d+)px$/)?.[1] || 0) - parseInt(b.match(/x(\d+)px$/)?.[1] || 0)).slice(0, 6);
      add("~", "target", `${smallOnTouch.length} tap targets under 44x44px on touch, smallest first: ${shown.join("; ")}` +
        (smallOnTouch.length > shown.length ? `; and ${smallOnTouch.length - shown.length} more` : ""));
    }

    // 5. Text squeezed against, or sticking out of, a visible box.
    for (const { el, r, cs } of els) {
      if (r.width < 100 || r.height < 32 || r.width >= W - 2) continue; // full-width bars are edge to edge on purpose
      if (!/^(block|flex|grid|flow-root|inline-block|list-item|inline-flex|inline-grid)$/.test(cs.display)) continue;
      if (!hasBoundary(el, cs) || el === document.body || el === document.documentElement) continue;
      if (cs.overflowX !== "visible" && el.scrollWidth > el.clientWidth + 1) continue; // a scroller, reported above
      const c = textBox(el);
      if (!c) continue;
      const inset = { left: c.left - r.left, right: r.right - c.right, top: c.top - r.top, bottom: r.bottom - c.bottom };
      const worst = Object.entries(inset).sort((x, y) => x[1] - y[1])[0];
      if (worst[1] < -1) add("!", "padding", `content sticks out of ${labelOf(el)} on the ${worst[0]} by ${px(-worst[1])}`);
      else if (worst[1] < 6 && /^(block|flex|grid|flow-root|list-item)$/.test(cs.display)) {
        add("~", "padding", `tight padding: content of ${labelOf(el)} is ${px(worst[1])} from the ${worst[0]} edge`);
      }
    }

    // 6. Uneven gaps between siblings in a row or a column.
    const seen = new Set();
    for (const { el } of els) {
      const parent = el.parentElement;
      if (!parent || seen.has(parent)) continue;
      seen.add(parent);
      if (/^(P|CODE|PRE|SPAN|A|LABEL|H[1-6]|STRONG|EM|B|I)$/.test(parent.tagName)) continue; // running text
      const all = [...parent.children].filter((k) => !LAYOUT_SKIP.has(k.tagName.toUpperCase()) && isVisible(k) &&
        !/^(absolute|fixed)$/.test(getComputedStyle(k).position));
      // Only repeated items (cards, list items, buttons in a row): same tag and class.
      const kindOf = (k) => `${k.tagName}.${typeof k.className === "string" ? k.className.trim() : ""}`;
      const counts = new Map();
      for (const k of all) counts.set(kindOf(k), (counts.get(kindOf(k)) || 0) + 1);
      const [kind, n] = [...counts].sort((a, b) => b[1] - a[1])[0] || [];
      if (!kind || n < 3) continue;
      const gaps = { across: [], down: [] };
      for (let i = 1; i < all.length; i++) {
        // Only neighbours that are both repeated items.
        if (kindOf(all[i - 1]) !== kind || kindOf(all[i]) !== kind) continue;
        const a = all[i - 1].getBoundingClientRect(), b = all[i].getBoundingClientRect();
        if (Math.abs(a.top - b.top) < 2 && b.left >= a.right - 1) gaps.across.push(b.left - a.right);
        else if (Math.abs(a.left - b.left) < 2 && b.top >= a.bottom - 1) gaps.down.push(b.top - a.bottom);
      }
      for (const [dir, list] of Object.entries(gaps)) {
        if (list.length < 2) continue;
        const spread = Math.max(...list) - Math.min(...list);
        if (spread > 4) {
          add("~", "spacing", `uneven gaps ${dir} in ${labelOf(parent)}: ${list.map((g) => Math.round(g)).join(", ")}px`);
        }
      }
    }

    const order = { overflow: 0, overlap: 1, clipped: 2, padding: 3, target: 4, spacing: 5 };
    issues.sort((a, b) => (a.level === b.level ? 0 : a.level === "!" ? -1 : 1) || order[a.kind] - order[b.kind]);
    const shown = issues.slice(0, Math.max(1, Math.min(Number(limit) || 40, 200)));
    const head = `layout at ${W}x${H}${touch ? " (touch)" : ""}, ${scope === "viewport" ? "on screen" : "whole page"}: ` +
      (issues.length ? `${issues.filter((i) => i.level === "!").length} problems, ${issues.filter((i) => i.level === "~").length} warnings` : "no problems found");
    const lines = shown.map((i) => `${i.level} ${i.text}`);
    if (issues.length > shown.length) lines.push(`... ${issues.length - shown.length} more`);
    if (truncated) lines.push("note: very large page, only the first 8000 elements were checked");
    return [head, ...lines].join("\n");
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

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender?.id !== chrome.runtime.id) return; // only Pointer's own worker
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
            if (!el.getClientRects().length) {
              throw new Error("That element is hidden (not rendered). Take a fresh snapshot and pick a visible one.");
            }
            scrollIntoView(el);
            await sleep(60);
            const { rect } = center(el);
            if (rect.width < 1 || rect.height < 1) {
              throw new Error("That element has no size on screen, so there is nothing to click. Pick another ref.");
            }
            const { x, y, cover } = clickPoint(el);
            if (cover) {
              const { what, how } = blockerInfo(cover);
              const name = oneLine(nameOf(el), 40);
              throw new Error(
                `${refFor(el)}${name ? ` "${name}"` : ""} is covered by ${what}, so the input would land on it. ` +
                  `Nothing was done; ${how}.`
              );
            }
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
          case "pointer:caption": {
            const p = msg.params || {};
            if (p.off) return sendResponse({ ok: true, cleared: clearCaption() });
            return sendResponse({ ok: true, target: showCaption(p) });
          }
          case "pointer:caption-visible":
            captionVisible(Boolean(msg.params?.on));
            return sendResponse({ ok: true });
          case "pointer:layout":
            return sendResponse({ ok: true, text: layoutReport(msg.params || {}) });
          case "pointer:text":
            return sendResponse({ ok: true, text: readableText(msg.params || {}) });
          case "pointer:scroll": {
            const p = msg.params || {};
            const amount = p.amount ?? 600;
            if (p.ref) {
              const el = findByRef(p.ref);
              if (!el) throw new Error(`Unknown ref ${p.ref}. Take a fresh snapshot — refs reset on navigation.`);
              el.scrollIntoView({ block: "center", behavior: "instant" });
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
          case "pointer:domhover": {
            // Script hover handlers run; CSS :hover does not, page events cannot set it.
            const el = resolve(msg.params || {});
            const r = el.getBoundingClientRect();
            const at = {
              bubbles: true, cancelable: true, composed: true, view: window,
              clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
            };
            const ptr = { ...at, pointerId: 1, pointerType: "mouse", isPrimary: true };
            el.dispatchEvent(new PointerEvent("pointerover", ptr));
            el.dispatchEvent(new PointerEvent("pointerenter", { ...ptr, bubbles: false }));
            el.dispatchEvent(new MouseEvent("mouseover", at));
            el.dispatchEvent(new MouseEvent("mouseenter", { ...at, bubbles: false }));
            el.dispatchEvent(new PointerEvent("pointermove", ptr));
            el.dispatchEvent(new MouseEvent("mousemove", at));
            return sendResponse({ ok: true });
          }
          case "pointer:dompress": {
            const parts = String(msg.params?.key || "Enter").split("+");
            const key = parts.pop();
            const target = document.activeElement || document.body;
            const init = {
              key, bubbles: true, cancelable: true, composed: true,
              code: /^[0-9]$/.test(key) ? `Digit${key}` : /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key,
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
              const proto =
                el.tagName === "TEXTAREA" ? HTMLTextAreaElement : el.tagName === "SELECT" ? HTMLSelectElement : HTMLInputElement;
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
