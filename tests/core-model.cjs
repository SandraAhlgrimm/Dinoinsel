const fs = require("node:fs");
const path = require("node:path");

const gamePath = path.resolve(__dirname, "../game/index.html");
const html = fs.readFileSync(gamePath, "utf8");
const source = html.match(/<script id="dino-core">([\s\S]*?)<\/script>/);
if (!source) throw new Error("The shipping DinoCore script is missing.");
const exported = { exports: {} };
new Function("module", source[1])(exported);

module.exports = { C: exported.exports, gamePath };
