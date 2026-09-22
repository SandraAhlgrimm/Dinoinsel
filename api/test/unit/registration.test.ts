import assert from "node:assert/strict";
import { test } from "node:test";
import functions from "@azure/functions";
import type { HttpFunctionOptions } from "@azure/functions";
import { ROUTES } from "../../src/routes.js";

test("the actual v4 entrypoint registers key-protected adult methods and anonymous OPTIONS", async () => {
  const registrations = new Map<string, HttpFunctionOptions>();
  const original = functions.app.http;
  functions.app.http = (name, options) => { registrations.set(name, options); };
  try {
    await import("../../src/functions.js");
  } finally {
    functions.app.http = original;
  }
  for (const route of ROUTES) {
    const actual = registrations.get(route.action);
    assert.ok(actual);
    assert.equal(actual.authLevel, route.authLevel);
    assert.equal(actual.route, route.route);
    assert.deepEqual(actual.methods, [route.method]);
    assert.equal(typeof actual.handler, "function");
  }
  const preflights = [...registrations.entries()].filter(([name]) => name.startsWith("preflight"));
  assert.equal(preflights.length, new Set(ROUTES.map((route) => route.route)).size);
  for (const [, registration] of preflights) {
    assert.deepEqual(registration.methods, ["OPTIONS"]);
    assert.equal(registration.authLevel, "anonymous");
  }
});
