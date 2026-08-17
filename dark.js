// Mimecast Dark — content script
// Runs at document_start. Reads the per-hostname enabled flag from
// browser.storage.local (unset counts as enabled) and injects/removes an
// inversion-based dark style live, including in response to the toggle.
//
// Also neutralizes colored top bars: invert()+hue-rotate() roughly preserves
// hue, so a saturated brand-color header renders as a light, clashing color
// under the global invert. We detect header-shaped elements with a saturated
// background (or a gradient background-image), mark them with
// [data-mcd-bar], and give them a near-white background / near-black text in
// the injected stylesheet — both of which land as near-black / near-white
// once the global invert runs over them.
//
// To avoid a blue-flash-then-dark flicker on every page load, bars detected
// during a live scan are also remembered per hostname as tag+class
// "signatures" in browser.storage.local. On the next load those signatures
// are turned into plain CSS selectors and baked into the injected style
// element up front — so previously-seen bars render dark from first paint,
// before the live scan even runs. Because framework-appended classes (e.g.
// Angular's `ng-star-inserted`) land on the element AFTER it is first
// painted, each signature also contributes a "prefix" selector (tag + its
// first two classes, since class-attribute order is insertion order) so the
// bar matches during that transitional state too, not just once fully
// settled.
//
// A synchronous localStorage mirror of the enabled flag + cached bar CSS
// lets the very first paint be styled correctly even before the async
// browser.storage.local round trip resolves.

(function () {
  "use strict";

  var STYLE_ID = "mimecast-dark-style";
  var BAR_ATTR = "data-mcd-bar";
  var BAR_CACHE_LIMIT = 20;
  var MIRROR_ENABLED_KEY = "__mcd_enabled";
  var MIRROR_BARCSS_KEY = "__mcd_barcss";

  var BASE_CSS =
    "html { filter: invert(0.92) hue-rotate(180deg) !important; background: #fff !important; }\n" +
    "img, video, canvas, svg image, iframe, [style*=\"background-image\"] { filter: invert(1) hue-rotate(180deg) !important; }";

  var BAR_CSS =
    "[" + BAR_ATTR + "] { background-color: #f2f2f4 !important; background-image: none !important; }\n" +
    "[" + BAR_ATTR + "], [" + BAR_ATTR + "] * { color: #17171a !important; }";

  function isEnabled(value) {
    // Unset (undefined) defaults to enabled.
    return value === undefined || value === true;
  }

  // ---- localStorage mirror (sync, pre-paint) -----------------------------

  function readMirror(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function writeMirror(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (e) {
      // localStorage can throw (sandboxed frame, storage disabled, etc).
      // The mirror is a best-effort optimization — silently skip.
    }
  }

  // ---- selector cache (flicker-proof revisits) ---------------------------

  var hostname = location.hostname;
  var barsKey = "mcd-bars:" + hostname;
  var cachedSignatures = [];
  var cacheDirty = false;

  // Signature encoding: "tag|class1 class2 ...". Space-joined classes are
  // unambiguous to split back apart (class tokens can't contain whitespace),
  // unlike joining on "." which could collide with class names that contain
  // a literal dot.
  function computeSignature(el) {
    var tag = el.tagName.toLowerCase();
    var classes = [];
    if (el.classList && el.classList.length) {
      for (var i = 0; i < el.classList.length; i++) {
        classes.push(el.classList[i]);
      }
    }
    if (classes.length === 0 && tag !== "header" && tag !== "nav") {
      // Bare, non-semantic elements (e.g. a plain <div>) are too generic to
      // cache as a global selector.
      return null;
    }
    return tag + "|" + classes.join(" ");
  }

  function parseSignature(sig) {
    var pipeIndex = sig.indexOf("|");
    if (pipeIndex === -1) {
      return null;
    }
    var tag = sig.slice(0, pipeIndex);
    var classesStr = sig.slice(pipeIndex + 1);
    var classes = classesStr.length ? classesStr.split(" ") : [];
    return { tag: tag, classes: classes };
  }

  function buildSelector(tag, classes, limitCount) {
    var use = classes;
    if (typeof limitCount === "number" && classes.length > limitCount) {
      use = classes.slice(0, limitCount);
    }
    var selector = tag;
    for (var i = 0; i < use.length; i++) {
      selector += "." + CSS.escape(use[i]);
    }
    return selector;
  }

  function buildCachedBarCss() {
    if (!cachedSignatures.length) {
      return "";
    }
    var seen = {};
    var selectors = [];
    cachedSignatures.forEach(function (sig) {
      var parsed = parseSignature(sig);
      if (!parsed) {
        return;
      }
      var full = buildSelector(parsed.tag, parsed.classes);
      if (!seen[full]) {
        seen[full] = true;
        selectors.push(full);
      }
      if (parsed.classes.length > 0) {
        // Prefix selector: matches before the framework finishes appending
        // its own classes (e.g. Angular Material's ng-star-inserted).
        var prefix = buildSelector(parsed.tag, parsed.classes, 2);
        if (!seen[prefix]) {
          seen[prefix] = true;
          selectors.push(prefix);
        }
      }
    });
    if (!selectors.length) {
      return "";
    }
    var rules = selectors.map(function (selector) {
      return (
        selector + " { background-color: #f2f2f4 !important; background-image: none !important; }\n" +
        selector + ", " + selector + " * { color: #17171a !important; }"
      );
    });
    return rules.join("\n");
  }

  function rememberSignature(el) {
    var sig = computeSignature(el);
    if (!sig || cachedSignatures.indexOf(sig) !== -1) {
      return;
    }
    cachedSignatures.push(sig);
    cacheDirty = true;
  }

  function persistCacheIfDirty() {
    if (!cacheDirty) {
      return;
    }
    cacheDirty = false;
    if (cachedSignatures.length > BAR_CACHE_LIMIT) {
      cachedSignatures = cachedSignatures.slice(-BAR_CACHE_LIMIT);
    }
    var update = {};
    update[barsKey] = cachedSignatures.slice();
    browser.storage.local.set(update);
    writeMirror(MIRROR_BARCSS_KEY, buildCachedBarCss());
  }

  // ---- style element -------------------------------------------------

  function buildStyleCss() {
    var cached = buildCachedBarCss();
    return cached ? BASE_CSS + "\n" + BAR_CSS + "\n" + cached : BASE_CSS + "\n" + BAR_CSS;
  }

  function ensureStyleWithCss(cssText) {
    var style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      var root = document.documentElement;
      if (!root) {
        return;
      }
      root.appendChild(style);
    }
    style.textContent = cssText;
  }

  function removeStyle() {
    var existing = document.getElementById(STYLE_ID);
    if (existing && existing.parentNode) {
      existing.parentNode.removeChild(existing);
    }
  }

  // ---- top-bar neutralizer -------------------------------------------

  function parseRgba(colorStr) {
    if (!colorStr) {
      return null;
    }
    var m = colorStr.match(/rgba?\(([^)]+)\)/i);
    if (!m) {
      return null;
    }
    var parts = m[1].split(",").map(function (s) {
      return parseFloat(s.trim());
    });
    if (parts.length < 3 || parts.some(isNaN)) {
      return null;
    }
    return {
      r: parts[0],
      g: parts[1],
      b: parts[2],
      a: parts.length > 3 ? parts[3] : 1
    };
  }

  function rgbToHsl(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    var max = Math.max(r, g, b);
    var min = Math.min(r, g, b);
    var h = 0;
    var s = 0;
    var l = (max + min) / 2;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r:
          h = (g - b) / d + (g < b ? 6 : 0);
          break;
        case g:
          h = (b - r) / d + 2;
          break;
        case b:
          h = (r - g) / d + 4;
          break;
      }
      h /= 6;
    }
    return { h: h, s: s, l: l };
  }

  function isColoredBar(el) {
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return false;
    }
    if (rect.height < 24 || rect.height > 160) {
      return false;
    }
    if (rect.width < 0.6 * window.innerWidth) {
      return false;
    }

    var style = window.getComputedStyle(el);
    var fixedOrSticky = style.position === "fixed" || style.position === "sticky";
    if (!fixedOrSticky && rect.top > 120) {
      return false;
    }

    // Actually visible: rendered in the flow (has an offsetParent) or
    // fixed/sticky positioned (which can have a null offsetParent while
    // still being on-screen).
    if (!fixedOrSticky && !el.offsetParent) {
      return false;
    }

    var bgImage = style.backgroundImage || "";
    if (bgImage.indexOf("gradient") !== -1) {
      // Gradient bars typically report a transparent background-color, so
      // skip the color check entirely and treat them as a match.
      return true;
    }

    var rgba = parseRgba(style.backgroundColor);
    if (!rgba || rgba.a < 0.1) {
      return false;
    }

    var hsl = rgbToHsl(rgba.r, rgba.g, rgba.b);
    return hsl.s > 0.2 && hsl.l > 0.08 && hsl.l < 0.92;
  }

  function scanForBars() {
    var root = document.body || document.documentElement;
    if (!root) {
      return;
    }

    var candidates = [];
    var all = root.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) {
      if (isColoredBar(all[i])) {
        candidates.push(all[i]);
      }
    }

    var candidateSet = new Set(candidates);

    var marked = document.querySelectorAll("[" + BAR_ATTR + "]");
    for (var j = 0; j < marked.length; j++) {
      if (!candidateSet.has(marked[j])) {
        marked[j].removeAttribute(BAR_ATTR);
      }
    }

    candidates.forEach(function (el) {
      el.setAttribute(BAR_ATTR, "");
      rememberSignature(el);
    });

    persistCacheIfDirty();
  }

  function clearBarMarks() {
    var marked = document.querySelectorAll("[" + BAR_ATTR + "]");
    for (var i = 0; i < marked.length; i++) {
      marked[i].removeAttribute(BAR_ATTR);
    }
  }

  var barObserver = null;
  var barRafId = null;
  var barWatcherActive = false;
  var barSafetyTimers = [];
  var barDomReadyHandler = null;
  var barLoadHandler = null;

  function scheduleScan() {
    if (barRafId !== null) {
      // A scan is already queued for the next frame.
      return;
    }
    barRafId = requestAnimationFrame(function () {
      barRafId = null;
      scanForBars();
    });
  }

  function startBarWatcher() {
    if (barWatcherActive) {
      return;
    }
    barWatcherActive = true;

    // No DOMContentLoaded gate: start scanning and observing immediately,
    // even before <body> exists. scanForBars() itself tolerates a null body.
    scanForBars();

    barObserver = new MutationObserver(function () {
      scheduleScan();
    });
    barObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style"]
    });

    function safetyScan() {
      if (!barWatcherActive) {
        return;
      }
      scanForBars();
    }

    barDomReadyHandler = safetyScan;
    barLoadHandler = safetyScan;
    document.addEventListener("DOMContentLoaded", barDomReadyHandler, { once: true });
    window.addEventListener("load", barLoadHandler, { once: true });

    barSafetyTimers.push(setTimeout(safetyScan, 250));
    barSafetyTimers.push(setTimeout(safetyScan, 1000));
    barSafetyTimers.push(setTimeout(safetyScan, 3000));
  }

  function stopBarWatcher() {
    barWatcherActive = false;
    if (barObserver) {
      barObserver.disconnect();
      barObserver = null;
    }
    if (barRafId !== null) {
      cancelAnimationFrame(barRafId);
      barRafId = null;
    }
    barSafetyTimers.forEach(function (id) {
      clearTimeout(id);
    });
    barSafetyTimers = [];
    if (barDomReadyHandler) {
      document.removeEventListener("DOMContentLoaded", barDomReadyHandler);
      barDomReadyHandler = null;
    }
    if (barLoadHandler) {
      window.removeEventListener("load", barLoadHandler);
      barLoadHandler = null;
    }
    clearBarMarks();
  }

  // ---- state wiring -----------------------------------------------------

  function applyState(enabled) {
    if (enabled) {
      ensureStyleWithCss(buildStyleCss());
      startBarWatcher();
    } else {
      stopBarWatcher();
      removeStyle();
    }
    writeMirror(MIRROR_ENABLED_KEY, String(enabled));
  }

  // 1. Synchronous optimistic pass: read the localStorage mirror BEFORE any
  //    async work, and paint immediately if it doesn't say disabled. This
  //    closes the first-paint gap that the async storage.local round trip
  //    would otherwise leave open.
  var mirrorEnabledStr = readMirror(MIRROR_ENABLED_KEY);
  var mirrorBarCss = readMirror(MIRROR_BARCSS_KEY) || "";
  var optimisticEnabled = mirrorEnabledStr !== "false";
  if (optimisticEnabled) {
    ensureStyleWithCss(BASE_CSS + "\n" + BAR_CSS + (mirrorBarCss ? "\n" + mirrorBarCss : ""));
    startBarWatcher();
  }

  // 2. Canonical async reconcile: browser.storage.local remains the source
  //    of truth. Once it resolves, correct the optimistic guess (including
  //    rebuilding the style from the real cache) and refresh both mirrors.
  browser.storage.local.get([hostname, barsKey]).then(function (result) {
    cachedSignatures = Array.isArray(result[barsKey]) ? result[barsKey] : [];
    applyState(isEnabled(result[hostname]));
  });

  browser.storage.onChanged.addListener(function (changes, areaName) {
    if (areaName !== "local") {
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(changes, hostname)) {
      return;
    }
    applyState(isEnabled(changes[hostname].newValue));
  });
})();
