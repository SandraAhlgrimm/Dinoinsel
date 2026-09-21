const { C } = require("../core-model.cjs");

function nearMeal() {
  const progress = C.emptyProgress();
  progress.dinos.trex.meals = 3;
  progress.stats.meals = 3;
  progress.math.mealsSince = 3;
  return C.validateProgress(progress);
}

function nearTime() {
  const progress = C.emptyProgress();
  progress.math.activeSeconds = 88.7;
  return C.validateProgress(progress);
}

function pending() {
  return C.scheduleMath(C.emptyProgress(), { manual: true });
}

function legacy() {
  const progress = C.emptyProgress();
  progress.version = 1;
  progress.selected = "trike";
  progress.dinos.trex.meals = 7;
  progress.dinos.trike.meals = 12;
  progress.stats.meals = 19;
  delete progress.math;
  delete progress.stats.mathSolved;
  for (const dino of Object.values(progress.dinos)) delete dino.mathSolved;
  return progress;
}

module.exports = { nearMeal, nearTime, pending, legacy };
