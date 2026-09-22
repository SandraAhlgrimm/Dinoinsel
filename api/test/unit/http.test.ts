import assert from "node:assert/strict";
import { test } from "node:test";
import functions from "@azure/functions";
import type { HttpRequestInit, HttpResponseInit } from "@azure/functions";
import { HttpApi } from "../../src/http.js";
import { MAX_BODY_BYTES } from "../../src/model.js";
import type { RoomStore } from "../../src/model.js";
import { RateLimiter } from "../../src/rate-limit.js";
import { ROUTES, matchRoute } from "../../src/routes.js";
import { GameService } from "../../src/service.js";
import { StoreUnavailable } from "../../src/errors.js";
import { fixture, identity } from "../support/fixtures.js";
import { MemoryStore } from "../support/memory-store.js";

const ORIGIN = "https://dinoinsel.example";
const noLog = () => {};
const { HttpRequest, HttpResponse } = functions;

function request(path: string, method = "GET", input?: unknown, headers: Record<string, string> = {}, params?: Record<string, string>) {
  const init: HttpRequestInit = {
    url: `http://127.0.0.1/api/${path}`,
    method,
    headers: { origin: ORIGIN, ...headers },
    ...(params === undefined ? {} : { params }),
  };
  if (input !== undefined) {
    init.body = { string: JSON.stringify(input) };
    init.headers = { ...init.headers, "content-type": "application/json" };
  }
  return new HttpRequest(init);
}

function status(response: HttpResponseInit, expected: number) {
  assert.equal(response.status, expected);
  return response;
}

function responseBody(response: HttpResponseInit): unknown {
  return response.jsonBody as unknown;
}

test("all adult endpoints are function-key protected in the production registration descriptors", () => {
  assert.ok(ROUTES.length >= 9);
  for (const route of ROUTES) {
    assert.equal(route.authLevel, route.route.startsWith("admin/") ? "function" : "anonymous");
  }
  assert.equal(matchRoute("/api/admin/rooms", "POST")?.route.action, "createRoom");
  assert.equal(matchRoute("/api/admin/rooms", "GET"), undefined);
  assert.equal(matchRoute("/api/not-a-route", "GET"), undefined);
  assert.equal(matchRoute("/api/admin/rooms/a/invite", "DELETE"), undefined);
});

test("HTTP contract: join, submit, leaderboard, and 204 own deletion", async () => {
  const { service, created, player, member } = await fixture();
  const api = new HttpApi(service, new Set([ORIGIN]));
  const auth = { authorization: `Bearer ${player.playerToken}` };
  const join = status(await api.handle("join", request("rooms/join", "POST", {
    ...player, inviteCode: created.inviteCode,
  }), noLog), 200);
  assert.deepEqual(Object.keys(join.jsonBody as object).sort(), ["player", "room", "score"]);
  const submit = status(await api.handle("progress", request("progress", "POST", {
    ...member, meals: 4, mathSolved: 5,
  }, auth), noLog), 200);
  assert.deepEqual(submit.jsonBody.score, { meals: 4, mathSolved: 5, total: 9 });
  const query = new URLSearchParams(member).toString();
  const board = status(await api.handle("leaderboard", request(`leaderboard?${query}`, "GET", undefined, auth), noLog), 200);
  assert.equal(board.jsonBody.you.playerId, player.playerId);
  assert.equal(board.jsonBody.you.total, 9);
  const deleted = status(await api.handle("deleteProfile", request(`profile?${query}`, "DELETE", undefined, auth), noLog), 204);
  assert.equal(deleted.jsonBody, undefined);
  assert.equal(deleted.body, undefined);
  status(await api.handle("leaderboard", request(`leaderboard?${query}`, "GET", undefined, auth), noLog), 401);
});

test("a key-authenticated handler allows an omitted create body and returns the fixed contract", async () => {
  const api = new HttpApi(new GameService(new MemoryStore()), new Set([ORIGIN]));
  const created = status(await api.handle("createRoom", request("admin/rooms", "POST"), noLog), 201);
  assert.equal(created.jsonBody.room.label, "Unsere Dino-Runde");
  assert.equal(typeof created.jsonBody.inviteCode, "string");
});

test("allowed CORS preflights need no bearer token or admin key and never permit credentials", () => {
  const api = new HttpApi(new GameService(new MemoryStore()), new Set([ORIGIN]));
  for (const [route, method] of [["progress", "POST"], ["leaderboard", "GET"], ["admin/rooms", "POST"], ["profile", "DELETE"]]) {
    assert.ok(route && method);
    const response = api.preflight(route, request(route, "OPTIONS", undefined, {
      "access-control-request-method": method,
      "access-control-request-headers": "authorization, Content-Type",
    }), noLog);
    status(response, 204);
    const headers = new HttpResponse(response).headers;
    assert.equal(headers.get("access-control-allow-origin"), ORIGIN);
    assert.equal(headers.get("access-control-allow-credentials"), null);
    assert.equal(headers.get("access-control-allow-origin")?.includes("*"), false);
    assert.match(headers.get("vary") ?? "", /Origin/);
  }
});

test("unlisted origins, null origins, suffix lookalikes, wrong methods and extra preflight headers are denied", async () => {
  const api = new HttpApi(new GameService(new MemoryStore()), new Set([ORIGIN]));
  for (const origin of ["null", "https://evil.example", `${ORIGIN}.evil.example`, `${ORIGIN}/path`, "http://dinoinsel.example"]) {
    const response = await api.handle("createRoom", request("admin/rooms", "POST", {}, { origin }), noLog);
    status(response, 403);
    assert.equal(new HttpResponse(response).headers.get("access-control-allow-origin"), null);
    assert.deepEqual((response.jsonBody as { error: { code: string } }).error.code, "ORIGIN_NOT_ALLOWED");
  }
  for (const headers of [
    { "access-control-request-method": "PATCH" },
    { "access-control-request-method": "POST", "access-control-request-headers": "x-not-allowed" },
    { "access-control-request-method": "POST", "access-control-request-headers": "cookie" },
  ]) {
    status(api.preflight("progress", request("progress", "OPTIONS", undefined, headers), noLog), 403);
  }
});

test("non-browser requests work, while no-origin preflights are rejected", async () => {
  const api = new HttpApi(new GameService(new MemoryStore()), new Set([ORIGIN]));
  const created = await api.handle("createRoom", new HttpRequest({
    url: "http://127.0.0.1/api/admin/rooms", method: "POST",
  }), noLog);
  status(created, 201);
  assert.equal(new HttpResponse(created).headers.get("access-control-allow-origin"), null);
  status(api.preflight("progress", new HttpRequest({
    url: "http://127.0.0.1/api/progress", method: "OPTIONS",
    headers: { "access-control-request-method": "POST" },
  }), noLog), 403);
});

test("allowed-origin errors have safe JSON, no caching, and useful status headers", async () => {
  const { service, member } = await fixture();
  const api = new HttpApi(service, new Set([ORIGIN]));
  const response = await api.handle("leaderboard", request(`leaderboard?${new URLSearchParams(member)}`), noLog);
  status(response, 401);
  assert.deepEqual(Object.keys(response.jsonBody as object), ["error"]);
  assert.deepEqual(Object.keys(response.jsonBody.error as object).sort(), ["code", "message"]);
  assert.equal(response.jsonBody.error.code, "UNAUTHORIZED");
  const headers = new HttpResponse(response).headers;
  assert.equal(headers.get("access-control-allow-origin"), ORIGIN);
  assert.match(headers.get("cache-control") ?? "", /no-store/);
  assert.match(headers.get("www-authenticate") ?? "", /Bearer/);
  assert.equal(headers.get("set-cookie"), null);
});

test("authorization is only accepted as a canonical bearer header, never a query token or cookie", async () => {
  const { service, member, player } = await fixture();
  const api = new HttpApi(service, new Set([ORIGIN]));
  const query = new URLSearchParams(member).toString();
  for (const authorization of [player.playerToken, `Basic ${player.playerToken}`, "Bearer not-a-token", `Bearer ${player.playerToken}, other`]) {
    status(await api.handle("leaderboard", request(`leaderboard?${query}`, "GET", undefined, { authorization }), noLog), 401);
  }
  status(await api.handle("leaderboard", request(`leaderboard?${query}`, "GET", undefined, {
    cookie: `playerToken=${player.playerToken}`,
  }), noLog), 401);
  status(await api.handle("leaderboard", request(`leaderboard?${query}&token=${player.playerToken}`), noLog), 400);
});

test("duplicate, missing and unknown query parameters fail instead of being ambiguously interpreted", async () => {
  const { service, member, player } = await fixture();
  const api = new HttpApi(service, new Set([ORIGIN]));
  const auth = { authorization: `Bearer ${player.playerToken}` };
  for (const query of [
    "", `roomId=${member.roomId}`,
    `${new URLSearchParams(member)}&roomId=${member.roomId}`,
    `${new URLSearchParams(member)}&playerId=${member.playerId}`,
    `${new URLSearchParams(member)}&nickname=RealName`,
  ]) {
    status(await api.handle("leaderboard", request(`leaderboard?${query}`, "GET", undefined, auth), noLog), 400);
  }
});

test("malformed JSON, unknown body fields, wrong types, invalid UTF-8, and non-JSON bodies fail safely", async () => {
  const api = new HttpApi(new GameService(new MemoryStore()), new Set([ORIGIN]));
  const requests = [
    new HttpRequest({ url: "http://127.0.0.1/api/admin/rooms", method: "POST", body: { string: "{" }, headers: { "content-type": "application/json" } }),
    new HttpRequest({ url: "http://127.0.0.1/api/admin/rooms", method: "POST", body: { string: "{}" }, headers: { "content-type": "text/plain" } }),
    new HttpRequest({ url: "http://127.0.0.1/api/admin/rooms", method: "POST", body: { bytes: new Uint8Array([0xff]) }, headers: { "content-type": "application/json" } }),
    new HttpRequest({ url: "http://127.0.0.1/api/admin/rooms", method: "POST", body: { string: "{}" }, headers: { "content-type": "application/json", "content-encoding": "gzip" } }),
    request("admin/rooms", "POST", []),
    request("admin/rooms", "POST", null),
    request("admin/rooms", "POST", { name: "No free text names" }),
  ];
  for (const input of requests) {
    const response = await api.handle("createRoom", input, noLog);
    status(response, 400);
    assert.equal(response.jsonBody.error.code, "INVALID_INPUT");
    assert.equal(JSON.stringify(responseBody(response)).includes("SyntaxError"), false);
  }
});

test("body limit is enforced with, without, and despite a false Content-Length", async () => {
  const api = new HttpApi(new GameService(new MemoryStore()), new Set([ORIGIN]));
  for (const headers of [{}, { "content-length": String(MAX_BODY_BYTES + 1) }, { "content-length": "1" }]) {
    const oversized = new HttpRequest({
      url: "http://127.0.0.1/api/admin/rooms", method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: { string: JSON.stringify({ label: "x".repeat(MAX_BODY_BYTES) }) },
    });
    status(await api.handle("createRoom", oversized, noLog), 400);
  }
});

test("wrong methods never dispatch a mutation", async () => {
  const api = new HttpApi(new GameService(new MemoryStore()), new Set([ORIGIN]));
  status(await api.handle("createRoom", request("admin/rooms", "GET"), noLog), 400);
});

test("unknown exceptions and storage failures only produce sanitized German errors and static log markers", async () => {
  const secret = "never-log-player-token-or-invite";
  for (const error of [new Error(`${secret}: stack body Authorization`), new StoreUnavailable()]) {
    const store: RoomStore = {
      read: async () => { throw error; },
      create: async () => { throw error; },
      replace: async () => { throw error; },
      remove: async () => { throw error; },
    };
    const logs: string[] = [];
    const api = new HttpApi(new GameService(store), new Set([ORIGIN]));
    const response = await api.handle("createRoom", request("admin/rooms", "POST", { label: "Runde" }), (message) => logs.push(message));
    status(response, 503);
    assert.equal(response.jsonBody.error.code, "UNAVAILABLE");
    assert.match(response.jsonBody.error.message as string, /Bestenliste/);
    assert.equal(logs.length, 1);
    assert.ok(!JSON.stringify([response, logs]).includes(secret));
    assert.ok(!JSON.stringify(logs).includes("Authorization"));
    assert.equal(new HttpResponse(response).headers.get("retry-after"), "5");
  }
});

test("join and per-identity rate limits return explicit 429 with Retry-After", async () => {
  const { service, created, member, player } = await fixture();
  const api = new HttpApi(service, new Set([ORIGIN]), new RateLimiter(() => 1000));
  for (let index = 0; index < 30; index++) {
    status(await api.handle("join", request("rooms/join", "POST", { ...player, inviteCode: created.inviteCode }), noLog), 200);
  }
  const throttledJoin = await api.handle("join", request("rooms/join", "POST", { ...identity(), inviteCode: created.inviteCode }), noLog);
  status(throttledJoin, 429);
  assert.equal(new HttpResponse(throttledJoin).headers.get("retry-after"), "60");
  const url = `leaderboard?${new URLSearchParams(member)}`;
  for (let index = 0; index < 60; index++) {
    status(await api.handle("leaderboard", request(url, "GET", undefined, { authorization: `Bearer ${player.playerToken}` }), noLog), 200);
  }
  status(await api.handle("leaderboard", request(url, "GET", undefined, { authorization: `Bearer ${player.playerToken}` }), noLog), 429);
});
