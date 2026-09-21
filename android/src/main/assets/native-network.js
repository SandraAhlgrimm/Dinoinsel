(function () {
  "use strict";
  const origin = __DINO_ALLOWED_ORIGIN_JSON__;
  const browserFetch = typeof window.fetch === "function" ? window.fetch.bind(window) : null;
  const BrowserRequest = window.Request;
  const BrowserURL = window.URL;
  const allowedMethods = new Set(["GET", "POST", "DELETE", "OPTIONS"]);

  function blocked() {
    return new TypeError("Dinoinsel: Diese Netzwerkverbindung ist nicht freigegeben.");
  }

  function allowed(request) {
    if (!origin || !allowedMethods.has(request.method)) return false;
    try {
      const url = new BrowserURL(request.url);
      const path = decodeURIComponent(url.pathname);
      return url.protocol === "https:" && url.origin === origin
        && !url.username && !url.password && !url.hash
        && url.pathname.startsWith("/api/") && path.startsWith("/api/")
        && !/%(?:2f|5c|25)/i.test(url.pathname)
        && !/[\\\u0000-\u001f\u007f-\u009f]/.test(path)
        && !path.includes("//")
        && !path.split("/").some(part => part === "." || part === "..");
    } catch (error) {
      return false;
    }
  }

  function restrictedFetch(input, options) {
    try {
      const request = new BrowserRequest(input, options);
      if (!browserFetch || !allowed(request)) return Promise.reject(blocked());
      // WebView interception does not observe every redirect; Fetch must reject them.
      return browserFetch(new BrowserRequest(request, {
        redirect: "error",
        mode: "cors",
        credentials: "omit",
        referrerPolicy: "no-referrer"
      }));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function lock(target, name, value) {
    Object.defineProperty(target, name, {
      value: value,
      writable: false,
      configurable: false
    });
  }

  lock(window, "fetch", restrictedFetch);
  // Fetch is the sole API transport: these alternatives cannot enforce redirect:error.
  for (const name of [
    "XMLHttpRequest", "WebSocket", "EventSource", "Worker", "SharedWorker",
    "WebTransport", "RTCPeerConnection", "webkitRTCPeerConnection"
  ]) {
    lock(window, name, function () { throw blocked(); });
  }
  lock(navigator, "sendBeacon", function () { return false; });
})();
