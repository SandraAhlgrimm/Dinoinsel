import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { after, before, test } from "node:test";
import { StoreConflict, StoreUnavailable } from "../../src/errors.js";
import { HttpApi } from "../../src/http.js";
import { matchRoute } from "../../src/routes.js";
import { GameService } from "../../src/service.js";
import { AzureTableStore } from "../../src/table-store.js";
import { errorCode, identity } from "../support/fixtures.js";
import { startAzurite } from "../../tools/azurite.mjs";
import { startLocalServer } from "../../tools/http-server.mjs";

const location = `.local/integration-${process.pid}-${randomBytes(5).toString("hex")}`;
let emulator: Awaited<ReturnType<typeof startAzurite>>;
let store: AzureTableStore;
let service: GameService;

before(async () => {
  emulator = await startAzurite({ location });
  store = new AzureTableStore(emulator.client);
  service = new GameService(store);
});

after(async () => {
  try {
    if (emulator) await emulator.stop();
  } finally {
    await rm(location, { recursive: true, force: true });
  }
});

test("real Table Storage round-trip and read-after-restart retain only hashed credentials", async () => {
  const created = await service.createRoom();
  const player = identity();
  await service.join({ ...player, inviteCode: created.inviteCode });
  const member = { roomId: created.room.id, playerId: player.playerId };
  await service.progress({ ...member, meals: 7, mathSolved: 9 }, player.playerToken);
  const entity = await emulator.client.getEntity<{ state: string }>(member.roomId, "room");
  assert.ok(!entity.state.includes(player.playerToken));
  assert.ok(!entity.state.includes(created.inviteCode));
  const restarted = new GameService(new AzureTableStore(emulator.client));
  assert.equal((await restarted.leaderboard(member, player.playerToken)).you.total, 16);
  const retry = await restarted.join({ ...player, inviteCode: created.inviteCode });
  assert.deepEqual(retry.score, { meals: 7, mathSolved: 9, total: 16 });
});

test("real Azure ETags reject stale replacements, duplicate creates, and stale deletes", async () => {
  const created = await service.createRoom();
  const original = await store.read(created.room.id);
  assert.ok(original);
  await assert.rejects(store.create(original.room), StoreConflict);
  await store.replace({ ...original.room, label: "Neue Runde" }, original.etag);
  await assert.rejects(store.replace(original.room, original.etag), StoreConflict);
  await assert.rejects(store.remove(original.room.id, original.etag), StoreConflict);
  await assert.rejects(store.replace(original.room, "*"), StoreUnavailable);
  assert.equal((await store.read(created.room.id))?.room.label, "Neue Runde");
});

test("real concurrent updates across independent service instances preserve both maxima", async () => {
  const created = await service.createRoom();
  const player = identity();
  await service.join({ ...player, inviteCode: created.inviteCode });
  const member = { roomId: created.room.id, playerId: player.playerId };
  const workers = Array.from({ length: 8 }, () => new GameService(new AzureTableStore(emulator.client)));
  await Promise.all(workers.map((worker, index) => worker.progress({
    ...member, meals: index % 2 === 0 ? 50 : 0, mathSolved: index % 2 === 1 ? 70 : 0,
  }, player.playerToken)));
  const { you } = await service.leaderboard(member, player.playerToken);
  assert.deepEqual({ meals: you.meals, mathSolved: you.mathSolved, total: you.total }, { meals: 50, mathSolved: 70, total: 120 });
});

test("real simultaneous joins cannot exceed the room cap or overwrite another member", async () => {
  const created = await service.createRoom();
  for (let index = 0; index < 49; index++) {
    await service.join({ ...identity(), inviteCode: created.inviteCode });
  }
  const results = await Promise.allSettled([identity(), identity()].map((player) => (
    new GameService(new AzureTableStore(emulator.client)).join({ ...player, inviteCode: created.inviteCode })
  )));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const failed = results.find((result) => result.status === "rejected");
  assert.ok(failed?.status === "rejected");
  assert.ok(errorCode("ROOM_FULL")(failed.reason));
  assert.equal((await service.inspectRoom(created.room.id)).playerCount, 50);
});

test("real room/profile deletion persists and a deleted entity cannot be recreated by update", async () => {
  const created = await service.createRoom();
  const player = identity();
  await service.join({ ...player, inviteCode: created.inviteCode });
  const member = { roomId: created.room.id, playerId: player.playerId };
  await service.deleteProfile(member, player.playerToken);
  assert.equal((await store.read(member.roomId))?.room.players.length, 0);
  await assert.rejects(service.leaderboard(member, player.playerToken), errorCode("UNAUTHORIZED"));
  const beforeDelete = await store.read(member.roomId);
  assert.ok(beforeDelete);
  await service.deleteRoom(member.roomId);
  assert.equal(await store.read(member.roomId), undefined);
  await assert.rejects(store.replace(beforeDelete.room, beforeDelete.etag), StoreConflict);
  assert.equal(await store.read(member.roomId), undefined);
});

test("missing rows are distinguished from a missing table and malformed storage", async () => {
  assert.equal(await store.read(randomUUID()), undefined);
  const id = randomUUID();
  await emulator.client.createEntity({ partitionKey: id, rowKey: "room", schemaVersion: 99, state: "{}" });
  await assert.rejects(store.read(id), StoreUnavailable);
  const another = await startAzurite({ location: `${location}/missing-table`, tableName: "MissingTable" });
  try {
    await another.client.deleteTable();
    await assert.rejects(new AzureTableStore(another.client).read(randomUUID()), StoreUnavailable);
  } finally {
    await another.stop();
  }
});

test("loopback HTTP smoke test exercises the fixed contract and CORS against real Azurite", async () => {
  const origin = "http://localhost:4173";
  const key = randomBytes(32).toString("base64url");
  const logs: string[] = [];
  const server = await startLocalServer(new HttpApi(service, new Set([origin])), matchRoute, {
    adminKey: key, log: (message) => logs.push(message),
  });
  const call = (path: string, init: RequestInit = {}) => fetch(`${server.origin}/api/${path}`, {
    ...init, headers: { origin, ...init.headers }, signal: AbortSignal.timeout(10_000),
  });
  try {
    assert.equal((await call("admin/rooms", { method: "POST" })).status, 401);
    assert.equal((await call("admin/rooms", {
      method: "OPTIONS", headers: { "access-control-request-method": "POST", "access-control-request-headers": "x-functions-key,content-type" },
    })).status, 204);
    const create = await call("admin/rooms", {
      method: "POST", headers: { "x-functions-key": key, "content-type": "application/json" },
      body: JSON.stringify({ label: "Test-Runde" }),
    });
    assert.equal(create.status, 201);
    const created = await create.json() as { room: { id: string; label: string }; inviteCode: string };
    const player = identity();
    const join = await call("rooms/join", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...player, inviteCode: created.inviteCode }),
    });
    assert.equal(join.status, 200);
    assert.equal(join.headers.get("access-control-allow-origin"), origin);
    assert.equal(join.headers.get("access-control-allow-credentials"), null);
    const member = { roomId: created.room.id, playerId: player.playerId };
    const progress = await call("progress", {
      method: "POST",
      headers: { authorization: `Bearer ${player.playerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ ...member, meals: 3, mathSolved: 8 }),
    });
    assert.equal(progress.status, 200);
    assert.equal((await progress.json() as { score: { total: number } }).score.total, 11);
    const query = new URLSearchParams(member);
    const board = await call(`leaderboard?${query}`, { headers: { authorization: `Bearer ${player.playerToken}` } });
    assert.equal(board.status, 200);
    const payload = await board.json() as { entries: unknown[]; you: { total: number; rank: number } };
    assert.equal(payload.entries.length, 1);
    assert.equal(payload.you.total, 11);
    assert.equal(payload.you.rank, 1);
    const deleted = await call(`profile?${query}`, { method: "DELETE", headers: { authorization: `Bearer ${player.playerToken}` } });
    assert.equal(deleted.status, 204);
    assert.equal(await deleted.text(), "");
    assert.equal((await call(`leaderboard?${query}`, { headers: { authorization: `Bearer ${player.playerToken}` } })).status, 401);
    assert.deepEqual(logs, []);
  } finally {
    await server.stop();
  }
});
