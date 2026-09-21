const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const java = fs.readFileSync(path.join(__dirname, "../android/src/main/java/de/dinoinsel/game/MainActivity.java"), "utf8");

function script(name) {
  const expression = java.match(new RegExp(name + "\\s*=\\s*([\\s\\S]+?);\\n"))[1];
  return expression.match(/"(?:\\.|[^"\\])*"/g).map(value => JSON.parse(value)).join("");
}

function run(name, app) {
  const errors = [];
  const result = vm.runInNewContext(script(name), {
    window: { dinoApp: app },
    console: { error: (...args) => errors.push(args) }
  });
  return { result, errors };
}

test("the native pause hook calls the real game lifecycle entry point", () => {
  let calls = 0;
  const result = run("PAUSE_SCRIPT", { pause() { calls++; } });
  assert.equal(calls, 1);
  assert.deepEqual(result.errors, []);
});

test("only an explicit unhandled back action permits native activity exit", () => {
  assert.equal(run("BACK_SCRIPT", { handleBack: () => false }).result, false);
  assert.equal(run("BACK_SCRIPT", { handleBack: () => true }).result, true);
  assert.equal(run("BACK_SCRIPT", undefined).result, null);
  assert.equal(run("BACK_SCRIPT", {}).result, null);
});

test("not-yet-loaded lifecycle hooks are safe and genuine errors are logged", () => {
  assert.deepEqual(run("PAUSE_SCRIPT", undefined).errors, []);
  const pause = run("PAUSE_SCRIPT", { pause() { throw new Error("save failure"); } });
  assert.equal(pause.errors.length, 1);
  assert.match(pause.errors[0][0], /Speichern fehlgeschlagen/);
  const back = run("BACK_SCRIPT", { handleBack() { throw new Error("back failure"); } });
  assert.equal(back.result, null);
  assert.equal(back.errors.length, 1);
  assert.match(back.errors[0][0], /Zurueck-Aktion fehlgeschlagen/);
});
