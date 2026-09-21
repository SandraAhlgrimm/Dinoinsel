const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");
const { browserOptions } = require("./browser-support.cjs");
const { C, gamePath } = require("./core-model.cjs");
const fixtures = require("./fixtures/math-saves.cjs");

const output = path.resolve(__dirname, "../dist");
const errors = [], externalRequests = [];
const snapshot = page => page.evaluate(() => window.dinoApp.snapshot());
const back = page => page.evaluate(() => window.dinoApp.handleBack());
const nativePause = page => page.evaluate(() => window.dinoApp.pause());

async function frozen(page) {
  const before = await snapshot(page);
  await page.waitForTimeout(180);
  const after = await snapshot(page);
  for (const key of ["x", "y", "time", "npcs", "math"]) assert.deepEqual(after[key], before[key], key + " must freeze");
}

async function mathLayout(page, width, height) {
  const layout = await page.evaluate(() => {
    const panel = document.querySelector("#math-modal .modal").getBoundingClientRect();
    return {
      left: panel.left, right: panel.right, top: panel.top, bottom: panel.bottom,
      overflow: document.documentElement.scrollWidth > window.innerWidth,
      targets: [...document.querySelectorAll("#math-keypad button")].map(button => {
        const box = button.getBoundingClientRect();
        return { width: box.width, height: box.height, right: box.right, bottom: box.bottom };
      })
    };
  });
  assert.equal(layout.overflow, false);
  assert.ok(layout.left >= 0 && layout.right <= width && layout.top >= 0 && layout.bottom <= height, JSON.stringify(layout));
  assert.ok(layout.targets.every(target => target.width >= 48 && target.height >= 48 && target.right <= width && target.bottom <= height), JSON.stringify(layout));
}

async function touchAnswer(page, answer) {
  await page.locator("#math-clear-button").tap();
  for (const digit of String(answer)) await page.locator(`[data-digit="${digit}"]`).tap();
  await page.locator("#math-check-button").tap();
}

async function keyboardAnswer(page, answer) {
  await page.keyboard.press("Delete");
  await page.keyboard.type(String(answer));
  await page.keyboard.press("Enter");
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const server = http.createServer((request, response) => {
    if (request.url === "/favicon.ico") { response.writeHead(204); response.end(); return; }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(fs.readFileSync(gamePath));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  let browser;
  const contexts = [];
  try {
    browser = await chromium.launch(browserOptions());
    async function game({ save, width = 1280, height = 800, offline = false, failStorage = false } = {}) {
      const context = await browser.newContext({ viewport: { width, height }, hasTouch: true, isMobile: width === 1024, colorScheme: "light" });
      contexts.push(context);
      if (save) await context.addInitScript(data => {
        if (localStorage.getItem("dino-insel-v1") === null) localStorage.setItem("dino-insel-v1", JSON.stringify(data));
      }, save);
      if (failStorage) await context.addInitScript(() => {
        Storage.prototype.setItem = function () { throw new DOMException("Test storage is full", "QuotaExceededError"); };
      });
      if (offline) await context.setOffline(true);
      const page = await context.newPage();
      page.on("pageerror", error => errors.push(error.message));
      page.on("console", message => { if (!failStorage && message.type() === "error") errors.push(message.text()); });
      page.on("request", request => {
        if (!request.url().startsWith(url) && !request.url().startsWith("file:") && !request.url().startsWith("data:")) externalRequests.push(request.url());
      });
      await page.goto(offline ? pathToFileURL(gamePath).href : url);
      await page.waitForFunction(() => !!window.dinoApp);
      return { context, page };
    }

    const { page } = await game({ save: fixtures.nearMeal() });
    assert.equal(await page.locator("body > .modal-wrap").count(), 4, "dialogs must be independent siblings");
    await page.locator("#start-button").tap();
    await page.locator("#eat-button").tap();
    let state = await snapshot(page);
    assert.equal(state.mode, "math");
    assert.equal(state.strength, 5);
    assert.equal(state.scores.meals, 4);
    assert.equal(state.scores.mathSolved, 0);
    const taskId = state.math.pending.id;
    await mathLayout(page, 1280, 800);
    await frozen(page);
    assert.equal(await page.locator("#game").evaluate(element => element.inert), true);
    await page.locator("#math-pause-button").focus();
    await page.keyboard.press("Shift+Tab");
    assert.equal(await page.evaluate(() => document.activeElement.id), "math-check-button");
    await page.locator("#math-check-button").tap();
    assert.match(await page.locator("#math-feedback").innerText(), /erst deine Antwort/);
    assert.equal((await snapshot(page)).math.pending.attempts, 0);
    await touchAnswer(page, 999);
    state = await snapshot(page);
    assert.equal(state.math.pending.attempts, 1);
    assert.equal(state.scores.total, 4);
    assert.match(await page.locator("#math-feedback").innerText(), /kein Punkt verloren/);
    await page.locator("#math-hint-button").tap();
    await page.locator("#math-hint-button").tap();
    assert.equal((await snapshot(page)).math.pending.hintLevel, 2);
    assert.match(await page.locator("#math-hint").innerText(), /Deine Antwort ist/);
    await page.screenshot({ path: path.join(output, "Dinoinsel-Mathe-1280x800.png") });
    await page.locator('[data-digit="9"]').tap();
    await page.locator("#math-delete-button").tap();
    assert.equal((await snapshot(page)).math.pending.input, "");
    await page.locator('[data-digit="1"]').tap();
    await page.locator("#math-delete-button").focus();
    await page.keyboard.press("Enter");
    assert.equal((await snapshot(page)).math.pending.input, "", "Enter activates a focused keypad button accessibly");
    await page.locator('[data-digit="1"]').tap();
    const unanswered = (await snapshot(page)).math;

    await nativePause(page);
    assert.equal((await snapshot(page)).mode, "pause");
    await frozen(page);
    await page.locator("#help-button").tap();
    assert.equal((await snapshot(page)).mode, "help");
    await frozen(page);
    assert.equal(await back(page), true);
    await page.locator("#pause-scores-button").tap();
    assert.equal((await snapshot(page)).mode, "scores");
    assert.equal(await page.locator("#score-total").innerText(), "4");
    await frozen(page);
    assert.equal(await back(page), true);
    assert.equal((await snapshot(page)).mode, "pause");
    assert.equal(await back(page), true);
    assert.equal((await snapshot(page)).mode, "math");
    assert.deepEqual((await snapshot(page)).math, unanswered);
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    assert.equal((await snapshot(page)).mode, "pause");
    await page.locator("#resume-button").tap();
    assert.equal((await snapshot(page)).mode, "math");
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    assert.equal((await snapshot(page)).mode, "pause");
    await frozen(page);
    await page.evaluate(() => { delete document.hidden; });
    await page.locator("#change-button").tap();
    assert.equal((await snapshot(page)).mode, "home");
    assert.equal(await back(page), false, "only home permits the native shell to exit");
    await frozen(page);
    await page.locator('.dino-card[data-dino="trike"]').tap();
    await page.locator("#start-button").tap();
    state = await snapshot(page);
    assert.equal(state.mode, "math");
    assert.equal(state.species, "trike");
    assert.equal(state.math.pending.dinoId, "trex");
    assert.deepEqual(state.math, unanswered);
    await page.evaluate(() => {
      document.getElementById("start-button").click();
      document.getElementById("math-continue-button").click();
    });
    assert.equal((await snapshot(page)).mode, "math", "hidden controls cannot bypass a pending task");
    await page.reload();
    await page.waitForFunction(() => !!window.dinoApp);
    assert.equal((await snapshot(page)).mode, "home");
    assert.deepEqual((await snapshot(page)).math, unanswered);
    await page.locator("#start-button").tap();
    assert.equal((await snapshot(page)).math.pending.id, taskId);
    const firstAnswer = C.mathResult((await snapshot(page)).math.pending);
    await touchAnswer(page, firstAnswer);
    state = await snapshot(page);
    assert.equal(state.mode, "math");
    assert.equal(state.math.pending.completed, true);
    assert.equal(state.math.pending.credited, true);
    assert.equal(state.scores.total, 5);
    assert.equal(state.scores.rows.find(row => row.id === "trex").mathSolved, 1);
    assert.equal(state.scores.rows.find(row => row.id === "trike").mathSolved, 0);
    assert.equal(state.strength, 1, "maths never increases food strength");
    await frozen(page);
    await page.keyboard.press("Enter");
    assert.equal((await snapshot(page)).mode, "math", "an answer never auto-resumes movement");
    await page.reload();
    await page.waitForFunction(() => !!window.dinoApp);
    await page.locator("#start-button").tap();
    assert.equal((await snapshot(page)).mode, "math");
    assert.equal((await snapshot(page)).scores.total, 5);
    assert.equal(await page.locator("#math-keypad").isVisible(), false);
    await nativePause(page);
    await page.locator("#resume-button").tap();
    assert.equal((await snapshot(page)).math.pending.completed, true);
    await page.locator("#math-continue-button").tap();
    state = await snapshot(page);
    assert.equal(state.mode, "play");
    assert.equal(state.math.pending, null);
    assert.equal(state.math.mealsSince, 0);
    assert.deepEqual(state.input, { x: 0, y: 0, keys: [] });
    const resting = state;
    await page.waitForTimeout(180);
    assert.equal((await snapshot(page)).x, resting.x);
    assert.equal((await snapshot(page)).y, resting.y);
    await page.locator("#scores-button").tap();
    assert.equal(await page.locator("#score-maths").innerText(), "1");
    assert.equal(await page.locator("#score-total").innerText(), "5");
    await page.screenshot({ path: path.join(output, "Dinoinsel-Bestenliste.png") });
    console.log("PASS meal-triggered touch maths; hints/errors; pause/help/scores/native Back/home/switch/reload cannot skip; original-dino credit; completed restart and explicit continue");

    const { page: twoFinger, context: twoFingerContext } = await game({ save: fixtures.nearMeal(), width: 1024, height: 600 });
    await twoFinger.locator("#start-button").tap();
    const stick = await twoFinger.locator("#joystick").boundingBox();
    const eat = await twoFinger.locator("#eat-button").boundingBox();
    const center = { x: stick.x + stick.width / 2, y: stick.y + stick.height / 2 };
    const held = { id: 1, x: center.x + 30, y: center.y, radiusX: 4, radiusY: 4, force: 1 };
    const foodFinger = { id: 2, x: eat.x + eat.width / 2, y: eat.y + eat.height / 2, radiusX: 4, radiusY: 4, force: 1 };
    const touchSession = await twoFingerContext.newCDPSession(twoFinger);
    await touchSession.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...held, x: center.x }] });
    await touchSession.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [held] });
    await twoFinger.waitForTimeout(120);
    await touchSession.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [held, foodFinger] });
    assert.equal((await snapshot(twoFinger)).mode, "math");
    assert.deepEqual((await snapshot(twoFinger)).input, { x: 0, y: 0, keys: [] });
    await frozen(twoFinger);
    await touchSession.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [held] });
    await touchSession.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await touchAnswer(twoFinger, C.mathResult((await snapshot(twoFinger)).math.pending));
    await twoFinger.locator("#math-continue-button").tap();
    const touchStopped = await snapshot(twoFinger);
    await twoFinger.waitForTimeout(180);
    assert.equal((await snapshot(twoFinger)).x, touchStopped.x);
    assert.equal((await snapshot(twoFinger)).y, touchStopped.y);
    assert.deepEqual((await snapshot(twoFinger)).input, { x: 0, y: 0, keys: [] });
    console.log("PASS compulsory maths during real two-finger movement/eating releases pointer capture and cannot leave stuck movement");

    const { page: timed } = await game({ save: fixtures.nearTime(), width: 1024, height: 600 });
    await frozen(timed);
    await timed.locator("#home-scores-button").tap();
    await frozen(timed);
    await timed.locator("#close-scores-button").tap();
    await timed.locator("#start-button").tap();
    await timed.waitForTimeout(70);
    await nativePause(timed);
    const activeBeforeMenus = (await snapshot(timed)).math.activeSeconds;
    assert.ok(activeBeforeMenus > 88.7 && activeBeforeMenus < 90);
    await frozen(timed);
    await timed.locator("#help-button").tap();
    await frozen(timed);
    await timed.locator("#close-help-button").tap();
    await timed.locator("#change-button").tap();
    await frozen(timed);
    await timed.locator("#start-button").tap();
    await timed.keyboard.down("ArrowRight");
    await timed.waitForFunction(() => window.dinoApp.snapshot().mode === "math");
    await mathLayout(timed, 1024, 600);
    await frozen(timed);
    assert.deepEqual((await snapshot(timed)).input, { x: 0, y: 0, keys: [] });
    await timed.screenshot({ path: path.join(output, "Dinoinsel-Mathe-1024x600.png") });
    const timedTask = (await snapshot(timed)).math.pending;
    await timed.keyboard.press("9");
    await timed.keyboard.press("Backspace");
    assert.equal((await snapshot(timed)).math.pending.input, "");
    await keyboardAnswer(timed, C.mathResult(timedTask));
    assert.equal((await snapshot(timed)).scores.mathSolved, 1);
    await timed.locator("#math-continue-button").tap();
    const stopped = await snapshot(timed);
    const cdp = await timed.context().newCDPSession(timed);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, autoRepeat: true });
    await timed.waitForTimeout(120);
    assert.equal((await snapshot(timed)).x, stopped.x, "held movement cannot restart across a maths pause");
    await timed.keyboard.up("ArrowRight");
    await timed.keyboard.down("ArrowLeft");
    await timed.waitForTimeout(150);
    await timed.keyboard.up("ArrowLeft");
    assert.ok((await snapshot(timed)).x < stopped.x, "a fresh movement command works normally");
    console.log("PASS 1024x600 layout; active-time auto trigger; menu exclusion; keyboard digits/Enter/Backspace; zero stuck movement and fresh movement");

    const { page: manual } = await game();
    await manual.locator("#start-button").tap();
    await manual.locator("#pause-button").tap();
    await manual.locator("#practice-button").tap();
    const manualId = (await snapshot(manual)).math.pending.id;
    assert.equal(await back(manual), true);
    await manual.locator("#practice-button").tap();
    assert.equal((await snapshot(manual)).math.pending.id, manualId);
    for (let id = 1; id <= 5; id++) {
      const task = (await snapshot(manual)).math.pending;
      assert.equal(task.id, id);
      assert.equal(Math.max(task.a, task.b, C.mathResult(task)) > 20, id === 5);
      await keyboardAnswer(manual, C.mathResult(task));
      assert.equal((await snapshot(manual)).scores.mathSolved, id);
      await manual.locator("#math-continue-button").tap();
      if (id !== 5) {
        await manual.locator("#pause-button").tap();
        await manual.locator("#practice-button").tap();
      }
    }
    assert.equal((await snapshot(manual)).strength, 1);
    assert.equal((await snapshot(manual)).scores.meals, 0);
    assert.equal((await snapshot(manual)).scores.total, 5);
    console.log("PASS manual practice shares the mandatory task, persists five-task order and changes only maths points");

    const { page: legacy } = await game({ save: fixtures.legacy() });
    assert.equal((await snapshot(legacy)).strength, 13);
    await legacy.locator("#home-scores-button").tap();
    assert.equal(await legacy.locator("#score-total").innerText(), "19");
    assert.equal(await legacy.locator("#score-maths").innerText(), "0");
    await legacy.locator("#close-scores-button").tap();
    await legacy.locator("#start-button").tap();
    await nativePause(legacy);
    const migrated = await legacy.evaluate(() => JSON.parse(localStorage.getItem("dino-insel-v1")));
    assert.equal(migrated.version, 2);
    assert.equal(migrated.dinos.trex.meals, 7);
    assert.equal(migrated.dinos.trike.meals, 12);
    assert.equal(migrated.math.pending, null);
    console.log("PASS browser migration retains every old growth and local score");

    const { page: offline } = await game({ save: fixtures.pending(), offline: true });
    await offline.locator("#start-button").tap();
    assert.equal((await snapshot(offline)).mode, "math");
    await keyboardAnswer(offline, C.mathResult((await snapshot(offline)).math.pending));
    await offline.locator("#math-continue-button").tap();
    await offline.locator("#eat-button").tap();
    assert.equal((await snapshot(offline)).scores.total, 2);
    await offline.reload();
    await offline.waitForFunction(() => !!window.dinoApp);
    assert.equal((await snapshot(offline)).scores.total, 2);
    console.log("PASS completely offline bundled-file maths, play and relaunch with no network");

    const { page: failed } = await game({ failStorage: true, width: 1024, height: 600 });
    await failed.locator("#start-button").tap();
    await failed.locator("#pause-button").tap();
    await failed.locator("#practice-button").tap();
    assert.equal(await failed.locator("#math-save-note").isVisible(), true);
    assert.match(await failed.locator("#math-save-note").innerText(), /Speichern ist gerade nicht möglich/);
    assert.equal((await snapshot(failed)).saved, false);
    console.log("PASS maths storage failure is visible and never falsely reports saved progress");

    const diagnostic = await snapshot(page);
    await page.evaluate(() => {
      const copy = window.dinoApp.snapshot();
      copy.scores.rows[0].mathSolved = 99999;
      copy.math.issued = 99999;
      copy.npcs[0].x = -99999;
    });
    assert.deepEqual(await snapshot(page), diagnostic, "diagnostic snapshots cannot mutate the model");
    assert.deepEqual(externalRequests, [], "no external resources, API calls or telemetry");
    assert.deepEqual(errors, [], "no runtime errors");
    console.log("PASS read-only diagnostics and zero external requests/runtime errors throughout maths flows");
  } finally {
    for (const context of contexts) await context.close();
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
