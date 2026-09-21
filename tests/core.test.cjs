const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "../game/index.html"), "utf8");
const coreSource = html.match(/<script id="dino-core">([\s\S]*?)<\/script>/)[1];
const appSource = html.match(/<script id="dino-app">([\s\S]*?)<\/script>/)[1];
const exported = { exports: {} };
new Function("module", coreSource)(exported);
const C = exported.exports;

function advance(world, seconds, input = { x: 0, y: 0 }) {
  for (let elapsed = 0; elapsed < seconds - 1e-8; elapsed += .05) world.update(.05, input);
}

function moveNextTo(world, item) {
  world.player.x = item.x - 76;
  world.player.y = item.y;
}

test("both shipping scripts parse without build-time rewriting", () => {
  assert.doesNotThrow(() => new Function(coreSource));
  assert.doesNotThrow(() => new Function(appSource));
});

test("the game is self-contained and declares German text", () => {
  assert.match(html, /<html lang="de">/);
  assert.doesNotMatch(html, /<(script|link|img|iframe)[^>]+(?:src|href)=["']https?:/i);
  assert.doesNotMatch(appSource, /\b(fetch|XMLHttpRequest|WebSocket)\s*\(/);
  assert.match(html, /Dieser Vulkan bricht niemals aus\./);
  assert.match(html, /var\(--cp-accent\)/);
});

test("six named dinosaurs are selectable with both feeding modes", () => {
  assert.equal(C.PLAYABLE.length, 6);
  assert.equal(C.PLAYABLE.filter(s => s.diet === "meat").length, 2);
  assert.equal(C.PLAYABLE.filter(s => s.diet === "plants").length, 4);
  assert.ok(C.SPECIES.every(s => s.name && s.shape && s.diet));
  for (const s of C.PLAYABLE) {
    const world = new C.World();
    world.choose(s.id);
    assert.equal(world.player.speciesId, s.id);
    assert.equal(world.playerStrength(), 1);
  }
});

test("the seeded island has stable obstacle identities and free starting ground", () => {
  const a = new C.World(), b = new C.World();
  assert.equal(a.obstacles.length, 88);
  assert.equal(a.food.length, 48);
  assert.equal(a.npcs.length, 25);
  assert.deepEqual(a.obstacles, b.obstacles);
  assert.ok(a.canStand(a.player.x, a.player.y, a.playerRadius()));
  assert.ok(a.foodTarget().item, "a small first dinosaur is immediately reachable");
  a.choose("trike");
  assert.ok(a.foodTarget().item, "the first food bush is immediately reachable");
});

test("every carnivore meal makes the player strictly bigger and stronger", () => {
  const world = new C.World();
  const prey = world.npcs[0];
  world.npcs = [prey];
  for (let meal = 0; meal < 150; meal++) {
    const before = world.playerScale();
    prey.x = world.player.x + 60; prey.y = world.player.y;
    prey.hiddenUntil = 0; prey.scale = .5;
    world.eatCooldown = 0;
    assert.equal(world.eat().ok, true);
    assert.ok(world.playerScale() > before);
    assert.equal(world.playerStrength(), meal + 2);
  }
  assert.equal(world.progress.stats.meals, 150);
  assert.equal(world.progress.dinos.trex.meals, 150);
});

test("equal-sized and larger dinosaurs cannot be eaten", () => {
  const world = new C.World(), prey = world.npcs[0];
  world.npcs = [prey];
  for (const size of [1, 1.01, 2.2]) {
    prey.scale = size;
    assert.equal(world.eat().reason, "too-large");
    assert.equal(prey.hiddenUntil, 0);
    assert.equal(world.playerStrength(), 1);
  }
});

test("herbivores eat bushes, never other dinosaurs", () => {
  const world = new C.World();
  world.choose("brachio");
  const prey = world.npcs[0];
  assert.equal(world.eat().ok, true);
  assert.equal(world.food[0].hiddenUntil, 11);
  assert.equal(prey.hiddenUntil, 0);
  assert.equal(world.player.meals, 1);
  world.eatCooldown = 0;
  world.food.forEach(f => { f.hiddenUntil = 100; });
  assert.equal(world.eat().reason, "no-food");
  assert.equal(prey.hiddenUntil, 0);
});

test("carnivores cannot gain food from a bush or an already eaten dinosaur", () => {
  const world = new C.World();
  const result = world.eat();
  assert.equal(result.ok, true);
  const prey = world.npcs.find(n => n.id === result.id);
  assert.ok(prey.hiddenUntil > 0);
  world.eatCooldown = 0;
  assert.equal(world.eat().ok, false);
  assert.equal(world.food[0].hiddenUntil, 0);
  assert.equal(world.player.meals, 1);
});

test("action cooldowns prevent duplicate rewards", () => {
  const world = new C.World();
  assert.equal(world.eat().ok, true);
  assert.equal(world.eat().reason, "cooldown");
  assert.equal(world.player.meals, 1);
});

test("food and small dinosaurs return after being eaten", () => {
  const plantWorld = new C.World();
  plantWorld.choose("trike");
  plantWorld.npcs = [];
  plantWorld.eat();
  advance(plantWorld, 11.2);
  assert.equal(plantWorld.food[0].hiddenUntil, 0);
  const meatWorld = new C.World();
  const result = meatWorld.eat();
  meatWorld.npcs = meatWorld.npcs.filter(n => n.id === result.id);
  advance(meatWorld, 9.2);
  assert.equal(meatWorld.npcs[0].hiddenUntil, 0);
  assert.ok(meatWorld.npcs[0].scale < 1.31);
});

test("two gentle pushes topple the first tree and remove its collision", () => {
  const world = new C.World(), tree = world.obstacles[0];
  moveNextTo(world, tree);
  assert.equal(world.push().cleared, false);
  assert.equal(tree.hp, 1);
  assert.equal(world.push().reason, "cooldown");
  world.pushCooldown = 0;
  assert.equal(world.push().cleared, true);
  assert.ok(tree.cleared);
  assert.equal(world.progress.stats.trees, 1);
  assert.ok(world.progress.cleared.includes(tree.id));
  assert.ok(world.canStand(tree.x, tree.y, world.playerRadius()));
});

test("rocks require the displayed strength and can then be destroyed", () => {
  const world = new C.World(), rock = world.obstacles.find(o => o.kind === "rock");
  moveNextTo(world, rock);
  assert.equal(rock.required, 3);
  assert.equal(world.push().reason, "not-strong-enough");
  assert.equal(rock.hp, rock.maxHp);
  world.player.meals = 2;
  world.pushCooldown = 0;
  assert.equal(world.push().cleared, false);
  world.pushCooldown = 0;
  assert.equal(world.push().cleared, true);
  assert.equal(world.progress.stats.rocks, 1);
});

test("far-away obstacles cannot be broken", () => {
  const world = new C.World();
  assert.equal(world.push().reason, "no-obstacle");
  assert.equal(world.progress.cleared.length, 0);
});

test("walking is normalized so diagonal motion is not faster", () => {
  const straight = new C.World(), diagonal = new C.World();
  straight.obstacles = []; diagonal.obstacles = [];
  advance(straight, .5, { x: 1, y: 0 });
  advance(diagonal, .5, { x: 1, y: 1 });
  const origin = { x: C.MAP.startX, y: C.MAP.startY };
  assert.ok(Math.abs(C.distance(origin, straight.player) - 92) < .001);
  assert.ok(Math.abs(C.distance(origin, diagonal.player) - 92) < .001);
});

test("trees physically block walking until cleared", () => {
  const world = new C.World(), tree = world.obstacles[0];
  moveNextTo(world, tree);
  advance(world, 1, { x: 1, y: 0 });
  assert.ok(world.player.x <= tree.x - tree.radius - world.playerRadius());
  world.player.meals = 2;
  world.push();
  assert.equal(tree.cleared, true);
  advance(world, .7, { x: 1, y: 0 });
  assert.ok(world.player.x > tree.x);
});

test("water, coastline and the dormant volcano are solid boundaries", () => {
  assert.equal(C.terrainAllows(0, 0, 23), false);
  for (const pond of C.MAP.ponds) assert.equal(C.terrainAllows(pond.x, pond.y, 23), false);
  assert.equal(C.terrainAllows(C.MAP.volcano.x, C.MAP.volcano.y, 23), false);
  assert.equal(C.terrainAllows(C.MAP.startX, C.MAP.startY, 23), true);
});

test("growing next to a tree does not trap a gently moved joystick", () => {
  const world = new C.World(), tree = world.obstacles[0], prey = world.npcs[0];
  world.player.x = tree.x - tree.radius - world.playerRadius() - .1;
  world.player.y = tree.y;
  prey.x = world.player.x - 45; prey.y = world.player.y; prey.scale = .5;
  world.npcs = [prey];
  assert.ok(world.canStand(world.player.x, world.player.y, world.playerRadius()));
  assert.equal(world.eat().ok, true);
  assert.ok(world.canStand(world.player.x, world.player.y, world.playerRadius()));
  const before = world.player.x;
  for (let i = 0; i < 60; i++) world.update(1 / 60, { x: -.2, y: 0 });
  assert.ok(world.player.x < before - 25);
});

test("growth beside the water keeps the player safely on dry ground", () => {
  const world = new C.World(), pond = C.MAP.ponds[0], prey = world.npcs[0];
  world.obstacles = [];
  world.player.x = pond.x + pond.rx + world.playerRadius() + .1;
  world.player.y = pond.y;
  prey.x = world.player.x + 40; prey.y = world.player.y; prey.scale = .5;
  world.npcs = [prey];
  assert.equal(world.eat().ok, true);
  assert.ok(C.terrainAllows(world.player.x, world.player.y, world.playerRadius()));
});

test("other herbivores independently find and eat plants", () => {
  const world = new C.World(), npc = world.npcs.find(n => n.speciesId === "trike");
  world.obstacles = []; world.npcs = [npc];
  npc.x = C.MAP.startX; npc.y = C.MAP.startY; npc.hunger = 0;
  const food = world.food[0];
  food.x = npc.x + 10; food.y = npc.y; world.food = [food];
  const before = npc.scale;
  world.update(.05);
  assert.ok(food.hiddenUntil > 0);
  assert.ok(npc.scale > before);
  assert.ok(world.drainEvents().some(e => e.type === "npc-eat"));
  assert.equal(world.player.meals, 0);
});

test("other carnivores eat smaller NPCs but never the player", () => {
  const world = new C.World();
  const hunter = world.npcs.find(n => n.speciesId === "trex");
  const prey = world.npcs[0];
  world.obstacles = [];
  hunter.x = C.MAP.startX; hunter.y = C.MAP.startY; hunter.scale = 1.5; hunter.hunger = 0;
  prey.x = hunter.x + 10; prey.y = hunter.y; prey.scale = .5;
  world.npcs = [hunter, prey];
  world.update(.05);
  assert.ok(prey.hiddenUntil > 0);
  assert.equal(world.player.meals, 0);
  world.npcs = [hunter]; hunter.hunger = 0; hunter.target = null;
  assert.equal(world.findNpcMeal(hunter), null);
  advance(world, 10);
  assert.equal(world.player.speciesId, "trex");
  assert.equal(world.player.meals, 0);
  assert.equal(world.playerStrength(), 1);
});

test("individual growth, position and cleared obstacles survive a save/reload", () => {
  const world = new C.World();
  world.eat();
  world.choose("trike");
  world.eat();
  const tree = world.obstacles[0];
  moveNextTo(world, tree);
  world.push();
  const saved = world.save();
  assert.equal(saved.dinos.trex.meals, 1);
  assert.equal(saved.dinos.trike.meals, 1);
  const restored = new C.World(JSON.parse(JSON.stringify(saved)));
  assert.equal(restored.player.speciesId, "trike");
  assert.equal(restored.player.meals, 1);
  assert.equal(restored.player.x, saved.position.x);
  assert.equal(restored.obstacles[0].cleared, true);
  restored.choose("trex");
  assert.equal(restored.player.meals, 1);
  restored.choose("anky");
  assert.equal(restored.player.meals, 0);
});

test("invalid saves are rejected explicitly rather than treated as successes", () => {
  const changes = [
    d => { d.version = 99; },
    d => { d.selected = "unknown"; },
    d => { d.position.x = -1; },
    d => { d.dinos.trex.meals = -1; },
    d => { d.sound = "yes"; },
    d => { d.cleared = ["tree-0", "tree-0"]; },
    d => { d.stats.volcano = null; }
  ];
  changes.forEach(change => {
    const data = C.emptyProgress(); change(data);
    assert.throws(() => C.validateProgress(data));
  });
  const unknown = C.emptyProgress(); unknown.cleared = ["tree-900"];
  assert.throws(() => new C.World(unknown), /Unbekanntes Hindernis/);
  const nan = C.emptyProgress(); nan.position.y = NaN;
  assert.throws(() => C.validateProgress(nan), /Position/);
});

test("the volcano stays dormant through prolonged simulation and discovery", () => {
  const world = new C.World();
  world.player.x = C.MAP.volcano.x - 240;
  world.player.y = C.MAP.volcano.y;
  world.update(.05);
  assert.equal(world.progress.stats.volcano, true);
  assert.ok(world.drainEvents().some(e => e.type === "discover"));
  for (let i = 0; i < 6000; i++) {
    world.update(.05);
    assert.ok(world.drainEvents().every(e => !/erupt|lava|attack-player/.test(e.type)));
  }
  assert.equal(C.MAP.volcano.dormant, true);
  assert.ok(Object.isFrozen(C.MAP.volcano));
});

test("the optional discovery reward is awarded only once without ending play", () => {
  const world = new C.World();
  Object.assign(world.progress.stats, { meals: 3, trees: 2, rocks: 1, volcano: true });
  world.checkGoals(); world.checkGoals();
  assert.equal(world.drainEvents().filter(e => e.type === "achievement").length, 1);
  assert.match(world.mission(), /Entdecke weiter/);
  const previous = world.player.x;
  world.update(.05, { x: -1, y: 0 });
  assert.ok(world.player.x < previous);
});

test("invalid simulation inputs fail clearly", () => {
  const world = new C.World();
  assert.throws(() => world.update(-1), RangeError);
  assert.throws(() => world.update(10), RangeError);
  assert.throws(() => world.update(.1, { x: NaN, y: 0 }), TypeError);
  assert.throws(() => world.choose("compy"), /nicht gewählt/);
});

test("old progress migrates without changing growth, position or cleared obstacles", () => {
  const world = new C.World();
  world.eat();
  const old = world.save();
  for (const dino of Object.values(old.dinos)) delete dino.mathSolved;
  delete old.stats.mathSolved;
  const source = JSON.stringify(old);
  const migrated = C.validateProgress(old);
  assert.equal(JSON.stringify(old), source, "migration does not mutate the source");
  assert.equal(migrated.dinos.trex.meals, 1);
  assert.equal(migrated.dinos.trex.mathSolved, 0);
  assert.equal(migrated.stats.mathSolved, 0);
  assert.deepEqual(migrated.position, old.position);
  assert.deepEqual(migrated.cleared, old.cleared);
});

test("local scores have six real dinosaur rows, deterministic ties and exact totals", () => {
  const progress = C.emptyProgress();
  progress.dinos.trike.meals = 5;
  progress.dinos.raptor.meals = 5;
  const scores = C.localScores(progress);
  assert.equal(scores.rows.length, 6);
  assert.deepEqual(scores.rows.map(row => row.id), ["raptor", "trike", "trex", "stego", "brachio", "anky"]);
  assert.equal(scores.meals, 10);
  assert.equal(scores.mathSolved, 0);
  assert.equal(scores.total, 10);
  assert.match(html, /<script id="dino-config" type="application\/json">\{"leaderboardApiUrl":""\}<\/script>/);
});

test("invalid or inconsistent local scores are rejected", () => {
  const data = C.emptyProgress();
  data.dinos.trex.mathSolved = -1;
  assert.throws(() => C.validateProgress(data), /Dino-Punkte/);
  data.dinos.trex.mathSolved = 1;
  assert.throws(() => C.validateProgress(data), /Mathepunkte/);
});
