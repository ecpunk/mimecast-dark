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
//
// Some pages render their top bar inside an open shadow root (a custom
// element like <mc-navbar> wrapping <header class="mc-header">), which
// neither document-level querySelectorAll nor a document-level stylesheet
// can reach. The scan descends into every open shadow root it finds and
// injects a duplicate of the bar-marking CSS directly into each one.

(function () {
  "use strict";

  // Debug telemetry instrumentation, off by default in every committed and
  // normally-built copy of this file. apps/mimecast-dark/build_debug.py
  // produces a separate dist/mimecast-dark-debug.xpi with this flag flipped
  // to true (and the collector host permission added to its manifest) for
  // live diagnosis; the checked-in source and normal build never send
  // anything anywhere.
  var MCD_DEBUG = false;

  var STYLE_ID = "mimecast-dark-style";
  var SHADOW_STYLE_ID = "mimecast-dark-shadow-style";
  var BAR_ATTR = "data-mcd-bar";
  var BAR_CACHE_LIMIT = 20;
  var MIRROR_ENABLED_KEY = "__mcd_enabled";
  var MIRROR_BARCSS_KEY = "__mcd_barcss";
  var lastKnownEnabled = null;

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
    refreshShadowStyles();
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

  // ---- shadow DOM piercing --------------------------------------------
  //
  // Some Mimecast pages (e.g. the /apps/ launcher) render their top bar
  // inside an open shadow root (a custom element like <mc-navbar> wrapping
  // <header class="mc-header">). Neither document.querySelectorAll nor a
  // stylesheet attached to the document can reach across that boundary, so
  // both the scan and the injected CSS have to be duplicated per shadow
  // root. getBoundingClientRect/getComputedStyle work the same regardless
  // of which side of the boundary an element is on, so isColoredBar()
  // itself needs no changes.

  var shadowRoots = new Set();
  var shadowObservers = new Map();

  function buildShadowCss() {
    var cached = buildCachedBarCss();
    return cached ? BAR_CSS + "\n" + cached : BAR_CSS;
  }

  function ensureShadowStyle(root) {
    var style = root.querySelector("#" + SHADOW_STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = SHADOW_STYLE_ID;
      root.appendChild(style);
    }
    style.textContent = buildShadowCss();
  }

  function refreshShadowStyles() {
    if (!shadowRoots.size) {
      return;
    }
    var css = buildShadowCss();
    shadowRoots.forEach(function (root) {
      var style = root.querySelector("#" + SHADOW_STYLE_ID);
      if (style) {
        style.textContent = css;
      }
    });
  }

  function handleShadowRootDiscovered(root) {
    if (shadowRoots.has(root)) {
      return;
    }
    shadowRoots.add(root);
    ensureShadowStyle(root);

    var observer = new MutationObserver(function () {
      scheduleScan();
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style"]
    });
    shadowObservers.set(root, observer);
  }

  // Recursively visits every element under `root` (a Document, Element, or
  // ShadowRoot), descending into any open shadow root it finds. Discovers
  // and wires up new shadow roots along the way.
  function walkAll(root, visit) {
    var all = root.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      visit(el);
      if (el.shadowRoot) {
        handleShadowRootDiscovered(el.shadowRoot);
        walkAll(el.shadowRoot, visit);
      }
    }
  }

  function unmarkStale(root, candidateSet) {
    var marked = root.querySelectorAll("[" + BAR_ATTR + "]");
    for (var i = 0; i < marked.length; i++) {
      if (!candidateSet.has(marked[i])) {
        marked[i].removeAttribute(BAR_ATTR);
      }
    }
  }

  function scanForBars() {
    var root = document.body || document.documentElement;
    if (!root) {
      return;
    }

    var candidates = [];
    walkAll(root, function (el) {
      if (isColoredBar(el)) {
        candidates.push(el);
      }
    });

    var candidateSet = new Set(candidates);

    unmarkStale(document, candidateSet);
    shadowRoots.forEach(function (sr) {
      unmarkStale(sr, candidateSet);
    });

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
    shadowRoots.forEach(function (sr) {
      var markedInShadow = sr.querySelectorAll("[" + BAR_ATTR + "]");
      for (var j = 0; j < markedInShadow.length; j++) {
        markedInShadow[j].removeAttribute(BAR_ATTR);
      }
    });
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

    shadowObservers.forEach(function (observer) {
      observer.disconnect();
    });
    shadowObservers.clear();
    shadowRoots.forEach(function (root) {
      var style = root.querySelector("#" + SHADOW_STYLE_ID);
      if (style && style.parentNode) {
        style.parentNode.removeChild(style);
      }
    });

    clearBarMarks();
    shadowRoots.clear();
  }

  // ---- debug telemetry (MCD_DEBUG only) ----------------------------------
  //
  // Diagnoses a specific failure mode: some launcher pages keep their brand
  // top bar its original color while the rest of the page goes dark. Two
  // hypotheses: (1) the bar or a wrapper has an inline background-image, so
  // our own media counter-invert rule `[style*="background-image"]`
  // re-inverts it back to original colors; (2) the bar lives inside shadow
  // DOM, which neither our stylesheet selectors nor querySelectorAll can
  // reach. This section gathers evidence for both without changing any
  // production behavior — isColoredBar() itself is untouched; the rejection
  // tracer below is a separate, diagnostic-only copy of its logic.

  function truncateStr(str, maxLen) {
    if (typeof str !== "string") {
      return "";
    }
    return str.length > maxLen ? str.slice(0, maxLen) : str;
  }

  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return { t: r.top, l: r.left, w: r.width, h: r.height };
  }

  // Mirrors isColoredBar()'s branches exactly, but returns a reason string
  // on failure (or null on a would-match) instead of a boolean. Kept as an
  // independent copy so debug instrumentation can never change production
  // detection behavior.
  function explainColoredBar(el) {
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return "zero-rect";
    }
    if (rect.height < 24 || rect.height > 160) {
      return "height-out-of-range";
    }
    if (rect.width < 0.6 * window.innerWidth) {
      return "width-too-narrow";
    }

    var style = window.getComputedStyle(el);
    var fixedOrSticky = style.position === "fixed" || style.position === "sticky";
    if (!fixedOrSticky && rect.top > 120) {
      return "top-too-far";
    }
    if (!fixedOrSticky && !el.offsetParent) {
      return "not-visible";
    }

    var bgImage = style.backgroundImage || "";
    if (bgImage.indexOf("gradient") !== -1) {
      return null; // would match
    }

    var rgba = parseRgba(style.backgroundColor);
    if (!rgba || rgba.a < 0.1) {
      return "no-usable-background-color";
    }

    var hsl = rgbToHsl(rgba.r, rgba.g, rgba.b);
    if (!(hsl.s > 0.2 && hsl.l > 0.08 && hsl.l < 0.92)) {
      return "hsl-out-of-colored-range";
    }
    return null; // would match
  }

  // Debug-only candidate net: broader than the production bar heuristic on
  // purpose (top<250, width>=0.4*innerWidth, no height/position/visibility
  // filter) so the report shows everything in play near the top of the
  // page, not just what the production heuristic already accepts.
  function collectDebugCandidates(root) {
    var out = [];
    var all = root.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var rect = el.getBoundingClientRect();
      if (rect.top < 250 && rect.width >= 0.4 * window.innerWidth) {
        out.push(el);
      }
    }
    return out;
  }

  function buildGeneratedSelectors() {
    var full = [];
    var prefix = [];
    var seenFull = {};
    var seenPrefix = {};
    cachedSignatures.forEach(function (sig) {
      var parsed = parseSignature(sig);
      if (!parsed) {
        return;
      }
      var f = buildSelector(parsed.tag, parsed.classes);
      if (!seenFull[f]) {
        seenFull[f] = true;
        full.push(f);
      }
      if (parsed.classes.length > 0) {
        var p = buildSelector(parsed.tag, parsed.classes, 2);
        if (!seenPrefix[p]) {
          seenPrefix[p] = true;
          prefix.push(p);
        }
      }
    });
    return { full: full, prefix: prefix };
  }

  function buildElementRecord(el, idx, combinedSelectors) {
    var style = window.getComputedStyle(el);
    var matched = [];
    combinedSelectors.forEach(function (selector) {
      try {
        if (el.matches(selector)) {
          matched.push(selector);
        }
      } catch (e) {
        // Malformed selector — skip.
      }
    });
    return {
      idx: idx,
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      class: el.getAttribute("class"),
      rect: rectOf(el),
      position: style.position,
      backgroundColor: style.backgroundColor,
      backgroundImage: truncateStr(style.backgroundImage || "", 200),
      styleAttr: truncateStr(el.getAttribute("style") || "", 300),
      hasBarAttr: el.hasAttribute(BAR_ATTR),
      matchedCachedSelectors: matched
    };
  }

  function findAllShadowHosts(root) {
    var hosts = [];
    var all = root.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) {
      if (all[i].shadowRoot) {
        hosts.push(all[i]);
      }
    }
    return hosts;
  }

  function dumpShadowHost(hostEl, depth, combinedSelectors) {
    var shadowRoot = hostEl.shadowRoot;
    var elementsInShadow = collectDebugCandidates(shadowRoot);
    var records = elementsInShadow.map(function (el, i) {
      return buildElementRecord(el, i, combinedSelectors);
    });

    var nested = [];
    if (depth < 2) {
      var nestedHosts = findAllShadowHosts(shadowRoot).filter(function (h) {
        return h.getBoundingClientRect().top < 250;
      });
      nested = nestedHosts.map(function (h) {
        return dumpShadowHost(h, depth + 1, combinedSelectors);
      });
    }

    return {
      tag: hostEl.tagName.toLowerCase(),
      class: hostEl.getAttribute("class"),
      rect: rectOf(hostEl),
      shadowElements: records,
      nestedShadowHosts: nested
    };
  }

  function buildShadowDomReport(combinedSelectors) {
    var allHosts = findAllShadowHosts(document);
    var topHosts = allHosts.filter(function (h) {
      return h.getBoundingClientRect().top < 250;
    });
    return {
      totalShadowHostCount: allHosts.length,
      hostsInTopStrip: topHosts.map(function (h) {
        return dumpShadowHost(h, 1, combinedSelectors);
      })
    };
  }

  function gatherDebugReport() {
    var generatedSelectors = buildGeneratedSelectors();
    var combinedSelectors = generatedSelectors.full.concat(generatedSelectors.prefix);

    var topStripEls = collectDebugCandidates(document);
    var topStripElements = topStripEls.map(function (el, i) {
      return buildElementRecord(el, i, combinedSelectors);
    });

    var counterInvertMatches = { bgImageStyle: [], img: [], iframe: [] };
    topStripEls.forEach(function (el, i) {
      try {
        if (el.matches('[style*="background-image"]')) {
          counterInvertMatches.bgImageStyle.push(i);
        }
      } catch (e) {
        // ignore
      }
      if (el.tagName === "IMG") {
        counterInvertMatches.img.push(i);
      }
      if (el.tagName === "IFRAME") {
        counterInvertMatches.iframe.push(i);
      }
    });

    var rejections = [];
    topStripEls.forEach(function (el, i) {
      var reason = explainColoredBar(el);
      if (reason) {
        rejections.push({ idx: i, reason: reason });
      }
    });

    return {
      capturedAt: Date.now(),
      href: location.href,
      hostname: hostname,
      enabled: lastKnownEnabled,
      styleElementPresent: !!document.getElementById(STYLE_ID),
      cachedSignatures: cachedSignatures.slice(),
      generatedSelectors: generatedSelectors,
      topStripElements: topStripElements,
      counterInvertMatches: counterInvertMatches,
      shadowDom: buildShadowDomReport(combinedSelectors),
      rejections: rejections
    };
  }

  function scheduleDebugCapture() {
    if (!MCD_DEBUG) {
      return;
    }

    function capture() {
      try {
        var report = gatherDebugReport();
        browser.runtime.sendMessage({ type: "mcd-debug-report", payload: report }).catch(function () {});
      } catch (e) {
        // Diagnostics must never break the page.
      }
    }

    window.addEventListener("load", capture, { once: true });
    setTimeout(capture, 2000);
    setTimeout(capture, 5000);
  }

  // ---- state wiring -----------------------------------------------------

  function applyState(enabled) {
    lastKnownEnabled = enabled;
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
  lastKnownEnabled = optimisticEnabled;
  if (optimisticEnabled) {
    ensureStyleWithCss(BASE_CSS + "\n" + BAR_CSS + (mirrorBarCss ? "\n" + mirrorBarCss : ""));
    startBarWatcher();
  }

  scheduleDebugCapture();

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
