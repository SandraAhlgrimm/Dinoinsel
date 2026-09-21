const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { chromium } = require("playwright");
const { browserOptions } = require("./browser-support.cjs");

const gamePath = path.resolve(__dirname, "../game/index.html");
const output = path.resolve(__dirname, "../dist");
const errors = [];
const externalRequests = [];

function watch(page) {
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  page.on("request", request => {
    if (!request.url().startsWith("http://127.0.0.1:") && !request.url().startsWith("file:") && !request.url().startsWith("data:")) externalRequests.push(request.url());
  });
}

async function snapshot(page) {
  return page.evaluate(() => window.dinoApp.snapshot());
}

async function ensureNoOverflow(page, checkStart = true) {
  const result = await page.evaluate(() => {
    const home = document.getElementById("home");
    const start = document.getElementById("start-button").getBoundingClientRect();
    return {
      overflow: home.scrollWidth > window.innerWidth + 1,
      startVisible: start.top >= 0 && start.bottom <= window.innerHeight + 1,
      width: window.innerWidth, height: window.innerHeight
    };
  });
  assert.equal(result.overflow, false, JSON.stringify(result));
  if (checkStart) assert.equal(result.startVisible, true, JSON.stringify(result));
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const server = http.createServer((request, response) => {
    if (request.url === "/favicon.ico") { response.writeHead(204); response.end(); return; }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(fs.readFileSync(gamePath));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  let browser;
  try {
    browser = await chromium.launch(browserOptions());
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, hasTouch: true, colorScheme: "light" });
    const page = await context.newPage();
    watch(page);
    await page.goto(url);
    await page.waitForFunction(() => !!window.dinoApp);
    assert.equal(await page.locator(".dino-card").count(), 6);
    assert.equal(await page.locator('.dino-card[aria-pressed="true"]').getAttribute("data-dino"), "trex");
    await ensureNoOverflow(page);
    assert.equal(await page.title(), "Dinoinsel");
    await page.locator("#home-scores-button").click();
    assert.equal((await snapshot(page)).mode, "scores");
    assert.equal(await page.locator("#score-rows tr").count(), 6);
    assert.equal(await page.locator("#score-total").innerText(), "0");
    assert.match(await page.locator("#scores-privacy").innerText(), /Nur auf diesem Gerät/);
    await page.keyboard.press("Escape");
    assert.equal((await snapshot(page)).mode, "home");
    await page.screenshot({ path: path.join(output, "Dino-Insel-Auswahl.png") });

    await page.locator('.dino-card[data-dino="trike"]').click();
    await page.locator("#start-button").click();
    assert.equal((await snapshot(page)).species, "trike");
    assert.equal((await snapshot(page)).mode, "play");
    await page.locator("#eat-button").click();
    assert.equal((await snapshot(page)).strength, 2);
    assert.ok((await snapshot(page)).scale > 1);
    await page.locator("#scores-button").click();
    const scoresPaused = await snapshot(page);
    await page.waitForTimeout(200);
    assert.equal((await snapshot(page)).time, scoresPaused.time);
    assert.equal(await page.locator("#score-total").innerText(), "1");
    assert.equal(await page.locator("#score-maths").innerText(), "0");
    assert.equal(await page.locator("#score-rows tr").first().getAttribute("data-dino"), "trike");
    await page.locator("#close-scores-button").click();
    assert.equal((await snapshot(page)).mode, "pause");
    await page.locator("#resume-button").click();

    const beforeMove = await snapshot(page);
    await page.keyboard.down("ArrowRight");
    await page.waitForTimeout(310);
    await page.keyboard.up("ArrowRight");
    assert.ok((await snapshot(page)).x > beforeMove.x + 25);
    await page.keyboard.down("ArrowDown");
    await page.waitForTimeout(330);
    await page.keyboard.up("ArrowDown");
    await page.locator("#push-button").click();
    assert.equal((await snapshot(page)).obstaclesCleared, 1);
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(output, "Dino-Insel-Spiel.png") });

    await page.locator("#pause-button").click();
    const paused = await snapshot(page);
    assert.equal(paused.mode, "pause");
    await page.waitForTimeout(300);
    assert.equal((await snapshot(page)).time, paused.time);
    await page.locator("#help-button").click();
    assert.equal((await snapshot(page)).mode, "help");
    assert.match(await page.locator("#help-modal").innerText(), /Niemand frisst deinen Dino/);
    await page.locator("#close-help-button").click();
    await page.locator("#resume-button").click();
    assert.equal((await snapshot(page)).mode, "play");
    await page.evaluate(() => window.dinoApp.pause());
    assert.equal((await snapshot(page)).mode, "pause");
    assert.equal(await page.evaluate(() => window.dinoApp.handleBack()), true);
    assert.equal((await snapshot(page)).mode, "play");

    await page.locator("#pause-button").click();
    await page.locator("#change-button").click();
    assert.equal((await snapshot(page)).mode, "home");
    assert.equal(await page.evaluate(() => window.dinoApp.handleBack()), false);
    await page.locator('.dino-card[data-dino="raptor"]').click();
    await page.locator("#start-button").click();
    assert.equal((await snapshot(page)).strength, 1);
    await page.locator("#pause-button").click();
    await page.locator("#change-button").click();
    await page.locator('.dino-card[data-dino="trike"]').click();
    await page.locator("#start-button").click();
    assert.equal((await snapshot(page)).strength, 2);
    await page.reload();
    await page.waitForFunction(() => !!window.dinoApp);
    assert.equal((await snapshot(page)).species, "trike");
    assert.equal((await snapshot(page)).strength, 2);
    assert.equal((await snapshot(page)).obstaclesCleared, 1);
    await page.locator("#start-button").click();
    await context.setOffline(true);
    const offline = await snapshot(page);
    await page.keyboard.down("ArrowLeft"); await page.waitForTimeout(180); await page.keyboard.up("ArrowLeft");
    assert.ok((await snapshot(page)).x < offline.x);
    await context.setOffline(false);
    await context.close();
    console.log("PASS tablet selection, feeding, growth, walking, tree destruction, pause/help/back, persistence and offline play");

    const touchContext = await browser.newContext({
      viewport: { width: 1024, height: 600 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true, colorScheme: "light"
    });
    const touchPage = await touchContext.newPage();
    watch(touchPage);
    await touchPage.goto(url);
    await touchPage.waitForFunction(() => !!window.dinoApp);
    await ensureNoOverflow(touchPage);
    await touchPage.locator("#start-button").tap();
    const stick = await touchPage.locator("#joystick").boundingBox();
    const eat = await touchPage.locator("#eat-button").boundingBox();
    const center = { x: stick.x + stick.width / 2, y: stick.y + stick.height / 2 };
    const cdp = await touchContext.newCDPSession(touchPage);
    const beforeTouch = await snapshot(touchPage);
    const held = { id: 1, x: center.x + 34, y: center.y, radiusX: 4, radiusY: 4, force: 1 };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...held, x: center.x }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [held] });
    await touchPage.waitForTimeout(180);
    const finger = { id: 2, x: eat.x + eat.width / 2, y: eat.y + eat.height / 2, radiusX: 4, radiusY: 4, force: 1 };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [held, finger] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [held] });
    await touchPage.waitForTimeout(80);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const afterTouch = await snapshot(touchPage);
    assert.ok(afterTouch.x > beforeTouch.x + 20);
    assert.equal(afterTouch.strength, 2, "the second finger can eat while the first operates the joystick");
    await touchPage.waitForTimeout(200);
    assert.ok(Math.abs((await snapshot(touchPage)).x - afterTouch.x) < 2, "releasing the stick stops motion");
    await touchPage.evaluate(() => window.dispatchEvent(new Event("blur")));
    assert.equal((await snapshot(touchPage)).mode, "pause");
    await touchContext.close();
    console.log("PASS 1024x600 tablet layout, real multi-touch movement+eating, release and focus-loss pause");

    const responsiveContext = await browser.newContext({ viewport: { width: 800, height: 1280 }, colorScheme: "dark" });
    const responsive = await responsiveContext.newPage();
    watch(responsive);
    await responsive.goto(url + "?clawpilotTheme=light");
    await responsive.waitForFunction(() => !!window.dinoApp);
    assert.equal(await responsive.locator("html").getAttribute("data-theme"), "light");
    await ensureNoOverflow(responsive);
    await responsive.setViewportSize({ width: 600, height: 960 });
    await ensureNoOverflow(responsive, false);
    await responsive.goto(url + "?clawpilotTheme=dark");
    await responsive.waitForFunction(() => !!window.dinoApp);
    assert.equal(await responsive.locator("html").getAttribute("data-theme"), "dark");
    await responsive.screenshot({ path: path.join(output, "Dino-Insel-Dunkel.png"), fullPage: true });
    await responsiveContext.close();
    console.log("PASS portrait layouts and explicit light/dark theme overrides");

    const localContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const localPage = await localContext.newPage();
    watch(localPage);
    await localContext.setOffline(true);
    await localPage.goto("file://" + gamePath);
    await localPage.waitForFunction(() => !!window.dinoApp);
    await localPage.locator("#start-button").click();
    await localPage.locator("#eat-button").click();
    assert.equal((await snapshot(localPage)).strength, 2);
    assert.equal((await snapshot(localPage)).volcanoDormant, true);
    await localContext.close();
    console.log("PASS completely offline bundled-file launch and carnivore growth");

    const corruptContext = await browser.newContext({ viewport: { width: 1024, height: 600 } });
    await corruptContext.addInitScript(() => localStorage.setItem("dino-insel-v1", "{broken save"));
    const corrupt = await corruptContext.newPage();
    corrupt.on("pageerror", error => errors.push(error.message));
    await corrupt.goto(url);
    await corrupt.waitForFunction(() => !!window.dinoApp);
    assert.match(await corrupt.locator("#save-warning").innerText(), /nicht überschrieben/);
    await corrupt.locator("#start-button").click();
    await corrupt.locator("#eat-button").click();
    assert.equal((await snapshot(corrupt)).strength, 2);
    assert.equal((await snapshot(corrupt)).saved, false);
    assert.equal(await corrupt.evaluate(() => localStorage.getItem("dino-insel-v1")), "{broken save");
    await corruptContext.close();

    const fullContext = await browser.newContext({ viewport: { width: 1024, height: 600 } });
    await fullContext.addInitScript(() => {
      Storage.prototype.setItem = function () { throw new DOMException("Test storage is full", "QuotaExceededError"); };
    });
    const full = await fullContext.newPage();
    full.on("pageerror", error => errors.push(error.message));
    await full.goto(url);
    await full.waitForFunction(() => !!window.dinoApp);
    await full.locator("#start-button").click();
    assert.equal((await snapshot(full)).saved, false);
    assert.match(await full.locator("#hint").innerText(), /Speichern nicht möglich/);
    await full.locator("#pause-button").click();
    assert.match(await full.locator("#pause-save-note").innerText(), /Speichern ist gerade nicht möglich/);
    await fullContext.close();
    console.log("PASS corrupt saves are preserved and storage failures are clearly reported");

    assert.deepEqual(externalRequests, [], "no external resource or telemetry requests");
    assert.deepEqual(errors, [], "no browser runtime errors");
    console.log("PASS no runtime errors or external requests");
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
