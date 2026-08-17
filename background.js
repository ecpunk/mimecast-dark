// Mimecast Dark — background script (non-persistent)
// Toggles the per-hostname dark-mode flag on browser-action click and keeps
// the toolbar badge ("ON"/"OFF") in sync with the active tab's mimecast.com
// hostname. Empty badge everywhere else.

(function () {
  "use strict";

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
