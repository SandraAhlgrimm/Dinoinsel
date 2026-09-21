import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.argv[2] || "");
const api = "https://dinoinsel-test.azurewebsites.net";
const localOrigin = "https://dino-insel.invalid";
const chrome = process.env.DINO_CHROME
  || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
await access(chrome);
assert.ok(root.endsWith(path.join("android", "build", "policy-checks")));
const profile = path.join(root, "browser-profile");
await rm(profile, { recursive: true, force: true });
await mkdir(profile, { recursive: true });

const browser = spawn(chrome, [
  "--headless=new", "--remote-debugging-pipe", "--no-first-run",
  "--no-default-browser-check", "--disable-background-networking",
  "--disable-component-update", "--disable-sync", "--disable-default-apps",
  "--disable-extensions", "--disable-breakpad", "--disable-crash-reporter",
  "--metrics-recording-only", "--password-store=basic", "--use-mock-keychain",
  "--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication,Translate",
  "--no-proxy-server", "--host-resolver-rules=MAP * 127.0.0.1",
  "--user-data-dir=" + profile, "--disk-cache-dir=" + path.join(profile, "cache"),
  "about:blank"
], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], env: process.env });

let sequence = 0;
let received = Buffer.alloc(0);
let stderr = "";
const pending = new Map();
const listeners = new Set();
const closingSessions = new Set();
const failures = [];
const intercepted = [];
const checks = [];
let exited = false;

browser.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-12000); });
browser.on("error", error => failures.push(String(error)));
browser.on("exit", () => {
  exited = true;
  for (const item of pending.values()) {
    clearTimeout(item.timer);
    item.reject(new Error("Chrome exited before CDP completed: " + stderr));
  }
  pending.clear();
});
browser.stdio[4].on("data", chunk => {
  received = Buffer.concat([received, chunk]);
  let end;
  while ((end = received.indexOf(0)) !== -1) {
    const packet = received.subarray(0, end).toString();
    received = received.subarray(end + 1);
    if (!packet) continue;
    const message = JSON.parse(packet);
    if (message.id && pending.has(message.id)) {
      const item = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.error) item.reject(new Error(JSON.stringify(message.error)));
      else item.resolve(message.result || {});
    } else if (message.method) {
      for (const listener of listeners) {
        Promise.resolve(listener(message)).catch(error => {
          // A late favicon response can race deliberate teardown of its old page.
          if (closingSessions.has(message.sessionId)
              && /Session with given id not found|Target closed/.test(String(error))) return;
          failures.push(String(error));
        });
      }
    }
  }
});

function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("CDP timed out: " + method + "\n" + stderr));
    }, 25000);
    pending.set(id, { resolve, reject, timer });
    browser.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + "\0");
  });
}

async function evaluate(sessionId, expression) {
  const response = await send("Runtime.evaluate", {
    expression, awaitPromise: true, returnByValue: true, userGesture: true
  }, sessionId);
  assert.equal(response.exceptionDetails, undefined, JSON.stringify(response.exceptionDetails));
  return response.result.value;
}

async function openFixture(mode) {
  const html = await readFile(path.join(root, mode + ".html"), "utf8");
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const listener = async message => {
    if (message.sessionId !== sessionId || message.method !== "Fetch.requestPaused") return;
    const { requestId, request } = message.params;
    if (request.url === localOrigin + "/") {
      await send("Fetch.fulfillRequest", {
        requestId, responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
        body: Buffer.from(html).toString("base64")
      }, sessionId);
      return;
    }
    if (request.url === localOrigin + "/favicon.ico") {
      await send("Fetch.fulfillRequest", { requestId, responseCode: 404, body: "" }, sessionId);
      return;
    }
    intercepted.push({ mode, url: request.url, method: request.method, headers: request.headers });
    const headers = [
      { name: "Content-Type", value: "application/json" },
      { name: "Access-Control-Allow-Origin", value: localOrigin },
      { name: "Access-Control-Allow-Methods", value: "GET, POST, DELETE, OPTIONS" },
      { name: "Access-Control-Allow-Headers", value: "Authorization, Content-Type" },
      { name: "Cache-Control", value: "no-store" }
    ];
    let responseCode = 200;
    const route = new URL(request.url);
    if (route.pathname === "/api/redirect-other") {
      responseCode = 302;
      headers.push({ name: "Location", value: "https://unrelated.invalid/api/leak" });
    } else if (route.pathname === "/api/redirect-path") {
      responseCode = 302;
      headers.push({ name: "Location", value: api + "/not-api/leak" });
    } else if (route.pathname === "/api/redirect-same-api") {
      responseCode = 302;
      headers.push({ name: "Location", value: api + "/api/followed" });
    } else if (route.pathname === "/api/cors-rejected") {
      headers[1].value = "https://unrelated.invalid";
    }
    if (request.method === "OPTIONS") responseCode = 200;
    const lower = Object.fromEntries(
      Object.entries(request.headers).map(([key, value]) => [key.toLowerCase(), value]));
    const payload = {
      ok: true, method: request.method, authorization: lower.authorization || "",
      contentType: lower["content-type"] || "", cookie: lower.cookie || "",
      origin: lower.origin || "", body: request.postData || ""
    };
    await send("Fetch.fulfillRequest", {
      requestId, responseCode, responseHeaders: headers,
      body: Buffer.from(JSON.stringify(payload)).toString("base64")
    }, sessionId);
  };
  listeners.add(listener);
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await send("Network.enable", {}, sessionId);
  await send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sessionId);
  await send("Page.navigate", { url: localOrigin + "/" }, sessionId);
  let loaded = false;
  for (let attempt = 0; attempt < 80 && !loaded; attempt++) {
    loaded = await evaluate(sessionId, "window.fixtureLoaded === true");
    if (!loaded) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(loaded, "Bundled inline script must run under the hashed native CSP.");
  assert.equal(await evaluate(sessionId, "location.origin"), localOrigin);
  return { targetId, sessionId, listener };
}

async function closeFixture(fixture) {
  closingSessions.add(fixture.sessionId);
  listeners.delete(fixture.listener);
  await send("Target.closeTarget", { targetId: fixture.targetId });
}

function checked(name) {
  checks.push(name);
  console.log("Browser policy passed: " + name);
}

try {
  await send("Browser.getVersion");
  const offline = await openFixture("offline");
  const offlineResult = await evaluate(offline.sessionId, `(async function () {
    const result = { blocked: false, xhrBlocked: false };
    try { await fetch(${JSON.stringify(api + "/api/echo")}); }
    catch (error) { result.blocked = true; }
    try { new XMLHttpRequest(); } catch (error) { result.xhrBlocked = true; }
    localStorage.setItem("native-policy-fixture", "retained");
    result.beaconBlocked = navigator.sendBeacon(${JSON.stringify(api + "/api/echo")}, "x") === false;
    return result;
  })()`);
  assert.deepEqual(offlineResult, { blocked: true, xhrBlocked: true, beaconBlocked: true });
  assert.equal(intercepted.filter(entry => entry.mode === "offline" && entry.url.startsWith(api)).length, 0);
  checked("empty config rejects fetch/XHR/beacon before any API request");
  await closeFixture(offline);

  const configured = await openFixture("configured");
  const sid = configured.sessionId;
  assert.equal(await evaluate(sid, "localStorage.getItem('native-policy-fixture')"), "retained");
  checked("unchanged secure local origin retains localStorage between documents");
  await send("Network.setCookie", {
    name: "fixture-cookie", value: "must-not-be-sent", url: api + "/", secure: true
  }, sid);

  for (const method of ["GET", "POST", "DELETE", "OPTIONS"]) {
    const response = await evaluate(sid, `(async function () {
      const options = {
        method: ${JSON.stringify(method)}, credentials: "include", redirect: "follow",
        headers: { Authorization: "Bearer fixture-only-token", "Content-Type": "application/json" }
      };
      if (options.method === "POST") options.body = JSON.stringify({ score: 7 });
      const result = await fetch(${JSON.stringify(api + "/api/echo")}, options);
      return result.json();
    })()`);
    assert.equal(response.method, method);
    assert.equal(response.authorization, "Bearer fixture-only-token");
    assert.equal(response.contentType, "application/json");
    assert.equal(response.cookie, "");
    assert.equal(response.origin, localOrigin);
    if (method === "POST") assert.equal(response.body, '{"score":7}');
    checked(method + " with bearer token, JSON and explicit CORS; cookies omitted");
  }

  const forbidden = [
    "http://dinoinsel-test.azurewebsites.net/api/echo",
    "https://unrelated.invalid/api/echo", api + "/not-api/echo", api + "/api",
    "https://dinoinsel-test.azurewebsites.net.evil.invalid/api/echo",
    api + ":444/api/echo", api + "/api/%2e%2e/private",
    api + "/api/%252e%252e/private", api + "/api/a%2fb",
    api + "/api//echo", "file:///api/echo", "data:text/plain,hello"
  ];
  for (const url of forbidden) {
    const prior = intercepted.length;
    const blocked = await evaluate(sid, `(async function () {
      try { await fetch(${JSON.stringify(url)}); return false; }
      catch (error) { return true; }
    })()`);
    assert.equal(blocked, true, url);
    assert.equal(intercepted.length, prior, "A forbidden URL reached the request interceptor: " + url);
  }
  checked("other origins/ports/schemes, non-API paths and path traversal are rejected");

  for (const route of ["redirect-other", "redirect-path", "redirect-same-api"]) {
    const before = intercepted.length;
    const blocked = await evaluate(sid, `(async function () {
      try {
        await fetch(${JSON.stringify(api + "/api/" + route)}, { redirect: "follow" });
        return false;
      } catch (error) { return true; }
    })()`);
    assert.equal(blocked, true, "Redirect must fail: " + route);
    const requests = intercepted.slice(before).filter(entry => entry.method !== "OPTIONS");
    assert.equal(requests.length, 1, "No redirected request may be sent: " + route);
    assert.equal(requests[0].url, api + "/api/" + route);
  }
  checked("redirect:error rejects unrelated-origin, non-API and same-API redirects");

  assert.equal(await evaluate(sid, `(async function () {
    try { await fetch(${JSON.stringify(api + "/api/cors-rejected")}); return false; }
    catch (error) { return true; }
  })()`), true);
  checked("the browser still enforces backend CORS rather than bypassing it");

  const guard = await evaluate(sid, `(async function () {
    const result = {};
    for (const name of ["XMLHttpRequest", "WebSocket", "EventSource", "Worker",
      "SharedWorker", "WebTransport", "RTCPeerConnection"]) {
      try { new window[name](${JSON.stringify(api + "/api/echo")}); result[name] = false; }
      catch (error) { result[name] = true; }
    }
    const descriptor = Object.getOwnPropertyDescriptor(window, "fetch");
    result.fetchLocked = descriptor.writable === false && descriptor.configurable === false;
    try { await fetch(${JSON.stringify(api + "/api/echo")}, { method: "PUT" }); result.putBlocked = false; }
    catch (error) { result.putBlocked = true; }
    const script = document.createElement("script");
    script.textContent = "window.injectedUntrustedScript = true";
    document.head.appendChild(script);
    result.untrustedScriptBlocked = window.injectedUntrustedScript !== true;
    return result;
  })()`);
  assert.ok(Object.values(guard).every(Boolean), JSON.stringify(guard));
  checked("alternate transports, unsupported methods and untrusted inline scripts are blocked");

  const beforeImage = intercepted.length;
  assert.equal(await evaluate(sid, `new Promise(resolve => {
    const image = new Image(); image.onload = () => resolve(false); image.onerror = () => resolve(true);
    image.src = ${JSON.stringify(api + "/api/pixel")};
    document.body.appendChild(image);
  })`), true);
  assert.equal(intercepted.length, beforeImage);
  checked("CSP forbids remote images even at the permitted API origin");
  assert.equal(failures.length, 0, failures.join("\n"));
  assert.ok(intercepted.every(entry =>
    entry.url.startsWith(api + "/api/") || entry.url === localOrigin + "/favicon.ico"));
  await closeFixture(configured);
  await writeFile(path.join(root, "browser-results.json"), JSON.stringify({
    result: "passed", checks, mockRequests: intercepted.length,
    liveApiRequests: 0, transport: "local CDP pipe; all page requests fulfilled in memory",
    androidDeviceTesting: false
  }, null, 2) + "\n");
} finally {
  if (!exited) {
    try { await send("Browser.close"); } catch (error) { /* Chrome may close its pipe first. */ }
    for (let count = 0; count < 100 && !exited; count++) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!exited) browser.kill("SIGTERM");
  }
  await rm(profile, { recursive: true, force: true });
}
