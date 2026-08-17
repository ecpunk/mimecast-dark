// Mimecast Dark — background script (non-persistent)
// Toggles the per-hostname dark-mode flag on browser-action click and keeps
// the toolbar badge ("ON"/"OFF") in sync with the active tab's mimecast.com
// hostname. Empty badge everywhere else.
//
// Also relays debug telemetry reports to a local collector. The content
// script (dark.js) only ever sends a "mcd-debug-report" message when its
// MCD_DEBUG flag is on — false in every committed/normal build — so this
// listener is inert in production. It exists so an https content script
// (which can't fetch a plain-http cross-origin URL itself) can hand the
// report to the background script instead, which isn't bound by the page's
// mixed-content restrictions. The debug xpi's manifest adds the collector's
// host permission; the normal manifest does not, so the fetch below simply
// has nothing to reach in a non-debug install.

(function () {
  "use strict";

  var DEBUG_COLLECTOR_URL = "http://192.168.1.150:8199/";

  browser.runtime.onMessage.addListener(function (message) {
    if (!message || message.type !== "mcd-debug-report") {
      return;
    }
    return fetch(DEBUG_COLLECTOR_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message.payload)
    }).then(function () {
      return true;
    }).catch(function () {
      return false;
    });
  });

  function hostnameFromUrl(url) {
    try {
      var host = new URL(url).hostname;
      return host || null;
    } catch (e) {
      return null;
    }
  }

  function isMimecastHost(hostname) {
    return !!hostname && /(^|\.)mimecast\.com$/.test(hostname);
  }

  function isEnabled(value) {
    return value === undefined || value === true;
  }

  function setBadgeForTab(tab) {
    if (!tab || !tab.url) {
      return;
    }
    var hostname = hostnameFromUrl(tab.url);
    if (!isMimecastHost(hostname)) {
      browser.browserAction.setBadgeText({ text: "", tabId: tab.id });
      return;
    }
    browser.storage.local.get(hostname).then(function (result) {
      var text = isEnabled(result[hostname]) ? "ON" : "OFF";
      browser.browserAction.setBadgeText({ text: text, tabId: tab.id });
    });
  }

  browser.browserAction.onClicked.addListener(function (tab) {
    var hostname = hostnameFromUrl(tab.url);
    if (!isMimecastHost(hostname)) {
      return;
    }
    browser.storage.local.get(hostname).then(function (result) {
      var nextEnabled = !isEnabled(result[hostname]);
      var update = {};
      update[hostname] = nextEnabled;
      return browser.storage.local.set(update);
    }).then(function () {
      setBadgeForTab(tab);
    });
  });

  browser.tabs.onActivated.addListener(function (activeInfo) {
    browser.tabs.get(activeInfo.tabId).then(setBadgeForTab);
  });

  browser.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
    if (changeInfo.status === "complete") {
      setBadgeForTab(tab);
    }
  });
})();
