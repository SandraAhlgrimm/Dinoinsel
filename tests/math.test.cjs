const test = require("node:test");
const assert = require("node:assert/strict");
const { C } = require("./core-model.cjs");
const fixtures = require("./fixtures/math-saves.cjs");

function enter(progress, text) {
  return [...text].reduce((state, digit) => C.editMathInput(state, digit), C.editMathInput(progress, "Clear"));
}

function solve(progress) {
  return C.answerMath(enter(progress, String(C.mathResult(progress.math.pending))));
}

test("10,000 generated tasks have exactly four small tasks per five, safe bounds and both operators", () => {
  let small = 0, large = 0;
  const operators = new Set(), largeOperators = new Set();
  for (let id = 1; id <= 10000; id++) {
    const task = C.generateMathTask(id, C.PLAYABLE[id % 6].id);
    const numbers = [task.a, task.b, C.mathResult(task)];
    assert.ok(numbers.every(n => Number.isInteger(n) && n >= 0 && n <= 100));
    assert.ok(["+", "-"].includes(task.operator));
    operators.add(task.operator);
    if (id % 5) {
      assert.ok(numbers.every(n => n <= 20));
      small++;
    } else {
      assert.ok(numbers.some(n => n > 20), "the fifth task genuinely exceeds 20");
      largeOperators.add(task.operator);
      large++;
      assert.equal(small, large * 4, "every completed block has an exact 80/20 split");
    }
    assert.deepEqual(task, C.generateMathTask(id, task.dinoId), "pure generation is reproducible");
  }
  assert.equal(small, 8000);
  assert.equal(large, 2000);
  assert.deepEqual([...operators].sort(), ["+", "-"]);
  assert.deepEqual([...largeOperators].sort(), ["+", "-"]);
});

test("scheduling counts only active play and preserves its input", () => {
  const progress = C.emptyProgress(), before = structuredClone(progress);
  for (const label of ["home", "pause", "help", "scores", "background"]) {
    assert.equal(C.scheduleMath(progress, { seconds: 9000, meal: true, active: false }), progress, label);
  }
  const advanced = C.scheduleMath(progress, { seconds: 89.9, active: true });
  assert.equal(advanced.math.pending, null);
  assert.equal(advanced.math.activeSeconds, 89.9);
  const due = C.scheduleMath(advanced, { seconds: .1, active: true });
  assert.equal(due.math.pending.id, 1);
  assert.equal(due.math.activeSeconds, 90);
  assert.deepEqual(progress, before);
  assert.equal(C.scheduleMath(due, { seconds: 999, meal: true, active: true }), due);
});

test("the fourth player meal triggers a task without changing any food or strength reward", () => {
  const world = new C.World(), prey = world.npcs[0];
  world.npcs = [prey];
  for (let meal = 1; meal <= 4; meal++) {
    Object.assign(prey, { x: world.player.x + 50, y: world.player.y, hiddenUntil: 0, scale: .5 });
    world.eatCooldown = 0;
    const scale = world.playerScale();
    assert.equal(world.eat().ok, true);
    assert.equal(world.player.meals, meal);
    assert.equal(world.playerStrength(), meal + 1);
    assert.ok(world.playerScale() > scale);
    assert.equal(Boolean(world.progress.math.pending), meal === 4);
  }
  assert.equal(world.progress.math.pending.dinoId, "trex");
  assert.equal(world.progress.stats.mathSolved, 0);
  assert.equal(C.localScores(world.progress).total, 4);
  assert.equal(world.eat().reason, "math-pending");
  assert.equal(world.push().reason, "math-pending");
});

test("time and meal triggers share one task, and only explicit completion resets the interval", () => {
  const almost = fixtures.nearMeal();
  almost.math.activeSeconds = 89.9;
  const due = C.scheduleMath(almost, { meal: true, seconds: .1, active: true });
  assert.equal(due.math.issued, 1);
  assert.equal(C.finishMath(due), due);
  const correct = solve(due).progress;
  assert.equal(correct.math.activeSeconds, 90);
  assert.equal(correct.math.mealsSince, 4);
  assert.equal(C.scheduleMath(correct, { manual: true, active: true, seconds: 90 }), correct);
  const continued = C.finishMath(correct);
  assert.deepEqual(continued.math, { issued: 1, mealsSince: 0, activeSeconds: 0, pending: null });
  assert.equal(C.finishMath(continued), continued);
});

test("manual practice cannot replace a pending question or evade its solution", () => {
  const task = fixtures.pending();
  assert.equal(task.math.issued, 1);
  assert.equal(C.scheduleMath(task, { manual: true }, "trike"), task);
  assert.equal(C.finishMath(task), task);
  const next = C.scheduleMath(C.finishMath(solve(task).progress), { manual: true }, "trike");
  assert.equal(next.math.pending.id, 2);
  assert.equal(next.math.pending.dinoId, "trike");
});

test("wrong and empty answers never penalize progress; hints persist without awarding points", () => {
  const original = fixtures.pending(), before = structuredClone(original);
  const empty = C.answerMath(original);
  assert.equal(empty.status, "empty");
  assert.equal(empty.progress, original);
  const wrong = C.answerMath(enter(original, "999"));
  assert.equal(wrong.status, "incorrect");
  assert.equal(wrong.progress.math.pending.attempts, 1);
  assert.equal(wrong.progress.math.pending.lastAttempt, 999);
  assert.equal(wrong.progress.math.pending.input, "");
  assert.deepEqual(wrong.progress.stats, original.stats);
  let hinted = C.revealMathHint(C.revealMathHint(wrong.progress));
  hinted = C.revealMathHint(hinted);
  assert.equal(hinted.math.pending.hintLevel, 2);
  assert.equal(hinted.stats.mathSolved, 0);
  assert.match(C.mathHint(hinted.math.pending, 1), /Starte bei/);
  assert.ok(C.mathHint(hinted.math.pending, 2).includes("Deine Antwort ist " + C.mathResult(hinted.math.pending)));
  assert.deepEqual(C.validateProgress(hinted), hinted);
  assert.deepEqual(original, before, "answer checking and hint updates are pure");
});

test("guided hints explain ten crossing for addition and subtraction, including zero", () => {
  assert.match(C.mathHint({ a: 8, b: 7, operator: "+" }, 2), /8 \+ 2 = 10.*10 \+ 5 = 15/);
  assert.match(C.mathHint({ a: 15, b: 7, operator: "-" }, 2), /15 - 5 = 10.*10 - 2 = 8/);
  assert.match(C.mathHint({ a: 10, b: 0, operator: "-" }, 2), /10 - 0 = 10/);
  assert.match(C.mathHint({ a: 28, b: 32, operator: "+" }, 1), /3 Zehner und 2 Einer/);
});

test("digits, zero, backspace and clear are bounded and invalid input fails explicitly", () => {
  let progress = fixtures.pending();
  progress = C.editMathInput(progress, "0");
  assert.equal(progress.math.pending.input, "0");
  progress = C.editMathInput(progress, "5");
  assert.equal(progress.math.pending.input, "5");
  progress = enter(progress, "1234");
  assert.equal(progress.math.pending.input, "123");
  progress = C.editMathInput(progress, "Backspace");
  assert.equal(progress.math.pending.input, "12");
  assert.equal(C.editMathInput(progress, "Clear").math.pending.input, "");
  for (const invalid of ["-1", "a", " ", 0, null]) assert.throws(() => C.editMathInput(progress, invalid), /Eingabe/);
});

test("a correct answer credits exactly one point to the task's original dino, not a switched dino", () => {
  const world = new C.World(fixtures.pending());
  const beforeScale = world.playerScale(), beforeStrength = world.playerStrength();
  world.choose("trike");
  const entered = enter(world.progress, String(C.mathResult(world.progress.math.pending)));
  const before = structuredClone(entered);
  const correct = C.answerMath(entered);
  assert.equal(correct.status, "correct");
  assert.deepEqual(entered, before);
  assert.equal(correct.progress.dinos.trex.mathSolved, 1);
  assert.equal(correct.progress.dinos.trike.mathSolved, 0);
  assert.equal(correct.progress.stats.mathSolved, 1);
  assert.equal(correct.progress.stats.meals, 0);
  assert.equal(C.localScores(correct.progress).total, 1);
  assert.equal(C.answerMath(correct.progress).status, "already-completed");
  assert.equal(C.answerMath(correct.progress).progress, correct.progress);
  assert.equal(C.editMathInput(correct.progress, "9"), correct.progress);
  assert.equal(world.playerScale(), beforeScale);
  assert.equal(world.playerStrength(), beforeStrength);
});

test("world simulation, NPCs, physics, effects and cooldowns freeze for pending and completed tasks", () => {
  const world = new C.World();
  world.update(.05, { x: 1, y: 0 });
  world.practiceMath();
  const state = () => structuredClone({
    player: world.player, npcs: world.npcs, food: world.food, obstacles: world.obstacles,
    effects: world.effects, time: world.time, eatCooldown: world.eatCooldown, pushCooldown: world.pushCooldown
  });
  const paused = state();
  for (let frame = 0; frame < 2000; frame++) world.update(.05, { x: 1, y: -1 });
  assert.deepEqual(state(), paused);
  for (const digit of String(C.mathResult(world.progress.math.pending))) world.editMath(digit);
  assert.equal(world.answerMath(), "correct");
  for (let frame = 0; frame < 2000; frame++) world.update(.05, { x: -1, y: 1 });
  assert.deepEqual(state(), paused);
  assert.equal(world.finishMath(), true);
  world.update(.05, { x: 1, y: 0 });
  assert.ok(world.time > paused.time);
  assert.ok(world.player.x > paused.player.x);
});

test("reload preserves the question, attempts, digits and hints and cannot bypass a pending task", () => {
  let progress = C.answerMath(enter(fixtures.pending(), "999")).progress;
  progress = C.revealMathHint(C.editMathInput(progress, "1"));
  const world = new C.World(JSON.parse(JSON.stringify(progress)));
  assert.deepEqual(world.progress.math, progress.math);
  world.choose("anky");
  assert.deepEqual(world.progress.math, progress.math);
  const saved = world.save();
  const restarted = new C.World(saved);
  assert.equal(restarted.progress.math.pending.dinoId, "trex");
  assert.equal(restarted.finishMath(), false);
  assert.equal(restarted.eat().reason, "math-pending");
  assert.equal(restarted.push().reason, "math-pending");
});

test("a completed but not dismissed task survives repeated restarts without duplicate credit", () => {
  let progress = solve(fixtures.pending()).progress;
  for (let restart = 0; restart < 20; restart++) {
    const world = new C.World(JSON.parse(JSON.stringify(progress)));
    assert.equal(world.progress.math.pending.completed, true);
    assert.equal(world.progress.math.pending.credited, true);
    assert.equal(world.answerMath(), "already-completed");
    assert.equal(world.progress.stats.mathSolved, 1);
    progress = world.save();
  }
  const world = new C.World(progress);
  assert.equal(world.finishMath(), true);
  assert.equal(world.progress.stats.mathSolved, 1);
  world.practiceMath();
  assert.equal(world.progress.math.pending.id, 2);
});

test("1.0 and phase-one saves migrate all old progress and initialize the maths interval once", () => {
  const old = fixtures.legacy(), before = structuredClone(old);
  old.cleared = ["tree-0"];
  old.stats.trees = 1;
  const migrated = C.validateProgress(old);
  assert.equal(migrated.version, 2);
  assert.equal(migrated.selected, "trike");
  assert.equal(migrated.dinos.trike.meals, 12);
  assert.equal(migrated.dinos.trex.meals, 7);
  assert.deepEqual(migrated.position, before.position);
  assert.deepEqual(migrated.cleared, ["tree-0"]);
  assert.deepEqual(migrated.math, C.emptyMath());
  assert.equal(C.localScores(migrated).total, 19);
  const phaseOne = { ...structuredClone(migrated), version: 1 };
  delete phaseOne.math;
  assert.deepEqual(C.validateProgress(phaseOne), migrated);
  assert.deepEqual(C.validateProgress(migrated), migrated);
  assert.equal(old.version, 1);
  assert.equal(old.math, undefined);
});

test("invalid or missing maths save state is rejected rather than silently dropping a task", () => {
  const changes = [
    p => { delete p.math; },
    p => { delete p.dinos.trex.mathSolved; },
    p => { p.math.pending = null; },
    p => { p.math.pending.a++; },
    p => { p.math.pending.operator = "*"; },
    p => { p.math.pending.dinoId = "missing"; },
    p => { p.math.pending.credited = true; },
    p => { p.math.pending.completed = true; p.math.pending.credited = true; },
    p => { p.math.pending.attempts = -1; },
    p => { p.math.pending.lastAttempt = 12; },
    p => { p.math.pending.input = "-1"; },
    p => { p.math.pending.hintLevel = 3; },
    p => { p.math.activeSeconds = Infinity; },
    p => { p.math.mealsSince = 5; },
    p => { p.math.issued = 2; },
    p => { p.stats.mathSolved = 1; }
  ];
  for (const change of changes) {
    const progress = fixtures.pending();
    change(progress);
    assert.throws(() => C.validateProgress(progress));
  }
  const missing = C.emptyProgress();
  missing.math.activeSeconds = 90;
  assert.throws(() => C.validateProgress(missing), /Mathepause fehlt/);
});

test("invalid generator and scheduler arguments fail explicitly", () => {
  for (const id of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => C.generateMathTask(id, "trex"));
  assert.throws(() => C.generateMathTask(1, "compy"));
  assert.throws(() => C.scheduleMath(C.emptyProgress(), { seconds: -1, active: true }));
  assert.throws(() => C.scheduleMath(C.emptyProgress(), { seconds: NaN, active: true }));
  assert.throws(() => C.scheduleMath(C.emptyProgress(), { active: "yes" }));
  assert.throws(() => C.scheduleMath(C.emptyProgress(), { manual: true }, "compy"));
});
