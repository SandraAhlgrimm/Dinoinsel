import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { MAX_CAS_ATTEMPTS, MAX_COUNTER, MAX_PLAYERS } from "../../src/model.js";
import { GameService } from "../../src/service.js";
import { isToken, UUID_PATTERN } from "../../src/validation.js";
import { errorCode, fixture, identity } from "../support/fixtures.js";
import { MemoryStore } from "../support/memory-store.js";

test("room creation uses the German default, high-entropy invitations, and hash-only persistence", async () => {
  const { created, store, player, joined } = await fixture();
  assert.equal(created.room.label, "Unsere Dino-Runde");
  assert.match(created.room.id, UUID_PATTERN);
  assert.equal(created.inviteCode.length, 80);
  assert.equal(created.inviteCode.slice(0, 36), created.room.id);
  assert.ok(isToken(created.inviteCode.slice(37)));
  assert.match(joined.player.nickname, /^[A-Za-z ]+-[0-9A-F]{6}$/);
  const stored = await store.read(created.room.id);
  assert.ok(stored);
  assert.match(stored.room.inviteHash ?? "", /^[0-9a-f]{64}$/);
  assert.match(stored.room.players[0]?.tokenHash ?? "", /^[0-9a-f]{64}$/);
  const raw = JSON.stringify(stored);
  assert.ok(!raw.includes(created.inviteCode));
  assert.ok(!raw.includes(player.playerToken));
});

test("adult labels are short, normalized, and reject markup, control characters and unknown properties", async () => {
  const service = new GameService(new MemoryStore());
  assert.equal((await service.createRoom({ label: "  Grüne Dinos  " })).room.label, "Grüne Dinos");
  for (const label of ["", " ".repeat(10), "x".repeat(41), "<script>", "Runde\nZwei", 1, null]) {
    await assert.rejects(service.createRoom({ label }), errorCode("INVALID_INPUT"));
  }
  for (const body of [null, [], { name: "Name" }, { label: "Runde", players: [] }]) {
    await assert.rejects(service.createRoom(body), errorCode("INVALID_INPUT"));
  }
});

test("join retries preserve nickname, scores and ETag; conflicting tokens cannot take over", async () => {
  const { service, store, member, player, created, joined } = await fixture();
  await service.progress({ ...member, meals: 8, mathSolved: 13 }, player.playerToken);
  const before = await store.read(member.roomId);
  const again = await service.join({ ...player, inviteCode: created.inviteCode });
  assert.deepEqual(again.player, joined.player);
  assert.deepEqual(again.score, { meals: 8, mathSolved: 13, total: 21 });
  assert.equal((await store.read(member.roomId))?.etag, before?.etag);
  await assert.rejects(
    service.join({ ...player, playerToken: identity().playerToken, inviteCode: created.inviteCode }),
    errorCode("IDENTITY_CONFLICT"),
  );
  assert.deepEqual((await service.leaderboard(member, player.playerToken)).you.total, 21);
});

test("identities are case-normalized UUIDs, never free-form names", async () => {
  const { service, created, player } = await fixture();
  const again = await service.join({ ...player, playerId: player.playerId.toUpperCase(), inviteCode: created.inviteCode });
  assert.equal(again.player.id, player.playerId);
  for (const body of [
    { ...identity(), playerId: "Anna", inviteCode: created.inviteCode },
    { ...identity(), nickname: "Anna", inviteCode: created.inviteCode },
    { ...identity(), name: "Anna", inviteCode: created.inviteCode },
    { ...identity(), playerToken: "not-a-token", inviteCode: created.inviteCode },
    { ...identity(), playerToken: "A".repeat(42) + "B", inviteCode: created.inviteCode },
  ]) {
    await assert.rejects(service.join(body), errorCode("INVALID_INPUT"));
  }
});

test("malformed, mismatched and unknown invitations have the same safe error", async () => {
  const { service, created } = await fixture();
  const otherRoom = await service.createRoom();
  const guesses: unknown[] = [
    undefined, "", 123, "x".repeat(80),
    `${randomUUID()}.${created.inviteCode.slice(37)}`,
    `${otherRoom.room.id}.${created.inviteCode.slice(37)}`,
  ];
  for (const inviteCode of guesses) {
    await assert.rejects(service.join({ ...identity(), inviteCode }), errorCode("INVALID_INVITE"));
  }
});

test("tokens cannot read, submit, or delete another player or an unjoined room", async () => {
  const { service, created, player, member } = await fixture();
  const otherPlayer = identity();
  await service.join({ ...otherPlayer, inviteCode: created.inviteCode });
  const otherRoom = await service.createRoom();
  for (const target of [
    { ...member, playerId: otherPlayer.playerId },
    { ...member, roomId: otherRoom.room.id },
    { ...member, roomId: randomUUID() },
    { ...member, playerId: randomUUID() },
  ]) {
    await assert.rejects(service.leaderboard(target, player.playerToken), errorCode("UNAUTHORIZED"));
    await assert.rejects(service.progress({ ...target, meals: 999, mathSolved: 999 }, player.playerToken), errorCode("UNAUTHORIZED"));
    await assert.rejects(service.deleteProfile(target, player.playerToken), errorCode("UNAUTHORIZED"));
  }
  const newToken = identity().playerToken;
  await service.join({ ...player, playerToken: newToken, inviteCode: otherRoom.inviteCode });
  await assert.rejects(
    service.leaderboard({ ...member, roomId: otherRoom.room.id }, player.playerToken), errorCode("UNAUTHORIZED"),
  );
  assert.equal((await service.leaderboard(member, player.playerToken)).you.total, 0);
});

test("missing or malformed bearer credentials fail authentication", async () => {
  const { service, member } = await fixture();
  for (const token of [undefined, null, "", "password", "A".repeat(42) + "B"]) {
    await assert.rejects(service.leaderboard(member, token), errorCode("UNAUTHORIZED"));
    await assert.rejects(service.progress({ ...member, meals: 0, mathSolved: 0 }, token), errorCode("UNAUTHORIZED"));
    await assert.rejects(service.deleteProfile(member, token), errorCode("UNAUTHORIZED"));
  }
});

test("each meal and correctly solved maths problem is exactly one point", async () => {
  const { service, member, player } = await fixture();
  const result = await service.progress({ ...member, meals: 6, mathSolved: 17 }, player.playerToken);
  assert.deepEqual(result.score, { meals: 6, mathSolved: 17, total: 23 });
  assert.equal((await service.leaderboard(member, player.playerToken)).you.total, 23);
});

test("stale snapshots independently take counter maxima; replay does not write", async () => {
  const { service, store, member, player } = await fixture();
  await service.progress({ ...member, meals: 9, mathSolved: 2 }, player.playerToken);
  const merged = await service.progress({ ...member, meals: 3, mathSolved: 11 }, player.playerToken);
  assert.deepEqual(merged.score, { meals: 9, mathSolved: 11, total: 20 });
  const before = await store.read(member.roomId);
  const replay = await service.progress({ ...member, meals: 0, mathSolved: 0 }, player.playerToken);
  assert.deepEqual(replay, merged);
  assert.equal((await store.read(member.roomId))?.etag, before?.etag);
});

test("counters are bounded integers and raw scores / extraneous body fields are rejected", async () => {
  const { service, member, player } = await fixture();
  for (const value of [-1, 0.5, NaN, Infinity, MAX_COUNTER + 1, Number.MAX_SAFE_INTEGER + 1, "1", null, {}, true]) {
    await assert.rejects(
      service.progress({ ...member, meals: value, mathSolved: 0 }, player.playerToken), errorCode("INVALID_INPUT"),
    );
    await assert.rejects(
      service.progress({ ...member, meals: 0, mathSolved: value }, player.playerToken), errorCode("INVALID_INPUT"),
    );
  }
  for (const extra of [{ score: 999 }, { total: 999 }, { nickname: "Name" }]) {
    await assert.rejects(
      service.progress({ ...member, meals: 1, mathSolved: 1, ...extra }, player.playerToken), errorCode("INVALID_INPUT"),
    );
  }
  await assert.rejects(service.progress({ ...member, meals: 0 }, player.playerToken), errorCode("INVALID_INPUT"));
  const limit = await service.progress({ ...member, meals: MAX_COUNTER, mathSolved: MAX_COUNTER }, player.playerToken);
  assert.equal(limit.score.total, 2 * MAX_COUNTER);
});

test("simultaneous independent counter updates are not lost", async () => {
  const { service, member, player } = await fixture();
  await Promise.all(Array.from({ length: 12 }, (_, index) => service.progress({
    ...member, meals: index % 2 === 0 ? 30 : 0, mathSolved: index % 2 === 1 ? 40 : 0,
  }, player.playerToken)));
  const { you } = await service.leaderboard(member, player.playerToken);
  assert.equal(you.meals, 30);
  assert.equal(you.mathSolved, 40);
  assert.equal(you.total, 70);
});

test("concurrent joins to one room preserve every member", async () => {
  const { service, created } = await fixture();
  const players = Array.from({ length: 10 }, identity);
  await Promise.all(players.map((player) => service.join({ ...player, inviteCode: created.inviteCode })));
  const inspected = await service.inspectRoom(created.room.id);
  assert.equal(inspected.playerCount, 11);
  assert.equal(new Set(inspected.players.map((player) => player.nickname)).size, 11);
});

test("rank ties use ascending canonical UUID, never locale, nickname or arrival order", async () => {
  const service = new GameService(new MemoryStore());
  const room = await service.createRoom();
  const players = [3, 2, 1].map((number) => ({
    ...identity(), playerId: `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
  }));
  for (const player of players) {
    await service.join({ ...player, inviteCode: room.inviteCode });
    await service.progress({ roomId: room.room.id, playerId: player.playerId, meals: 1, mathSolved: 1 }, player.playerToken);
  }
  const first = players[0];
  assert.ok(first);
  const board = await service.leaderboard({ roomId: room.room.id, playerId: first.playerId }, first.playerToken);
  assert.deepEqual(board.entries.map((entry) => entry.playerId), players.map((player) => player.playerId).reverse());
  assert.deepEqual(board.entries.map((entry) => entry.rank), [1, 2, 3]);
  assert.deepEqual(board.you, board.entries[2]);
  assert.ok(!JSON.stringify(board).includes("tokenHash"));
  assert.ok(!JSON.stringify(board).includes("inviteHash"));
});

test("the 50-player cap is atomic, permits idempotent rejoin, and frees a slot on deletion", async () => {
  const { service, created, member, player } = await fixture();
  for (let index = 1; index < MAX_PLAYERS - 1; index++) {
    await service.join({ ...identity(), inviteCode: created.inviteCode });
  }
  const last = await Promise.allSettled([identity(), identity()].map((candidate) => (
    service.join({ ...candidate, inviteCode: created.inviteCode })
  )));
  assert.equal(last.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = last.find((result) => result.status === "rejected");
  assert.ok(rejected?.status === "rejected");
  assert.ok(errorCode("ROOM_FULL")(rejected.reason));
  assert.equal((await service.inspectRoom(member.roomId)).playerCount, MAX_PLAYERS);
  await service.join({ ...player, inviteCode: created.inviteCode });
  await service.deleteProfile(member, player.playerToken);
  await service.join({ ...identity(), inviteCode: created.inviteCode });
  assert.equal((await service.inspectRoom(member.roomId)).playerCount, MAX_PLAYERS);
});

test("profile deletion removes exactly the authenticated profile and revokes its token", async () => {
  const { service, created, member, player } = await fixture();
  const other = identity();
  await service.join({ ...other, inviteCode: created.inviteCode });
  const otherMember = { roomId: member.roomId, playerId: other.playerId };
  await service.progress({ ...otherMember, meals: 2, mathSolved: 3 }, other.playerToken);
  await service.deleteProfile(member, player.playerToken);
  await assert.rejects(service.leaderboard(member, player.playerToken), errorCode("UNAUTHORIZED"));
  await assert.rejects(service.deleteProfile(member, player.playerToken), errorCode("UNAUTHORIZED"));
  const board = await service.leaderboard(otherMember, other.playerToken);
  assert.equal(board.entries.length, 1);
  assert.equal(board.you.total, 5);
});

test("room deletion is atomic and idempotent; stale updates cannot resurrect it", async () => {
  const { service, store, member, player, created } = await fixture();
  store.beforeReplace = () => service.deleteRoom(member.roomId);
  await assert.rejects(
    service.progress({ ...member, meals: 10, mathSolved: 10 }, player.playerToken), errorCode("UNAUTHORIZED"),
  );
  assert.equal(await store.read(member.roomId), undefined);
  await service.deleteRoom(member.roomId);
  await assert.rejects(service.join({ ...player, inviteCode: created.inviteCode }), errorCode("INVALID_INVITE"));
  await assert.rejects(service.inspectRoom(member.roomId), errorCode("NOT_FOUND"));
});

test("a revoked invitation stops joins, not existing members; rotation never resets progress", async () => {
  const { service, created, member, player } = await fixture();
  await service.progress({ ...member, meals: 7, mathSolved: 8 }, player.playerToken);
  assert.deepEqual(await service.changeInvite(member.roomId, { action: "revoke" }), {
    room: created.room, inviteRevoked: true,
  });
  await assert.rejects(service.join({ ...player, inviteCode: created.inviteCode }), errorCode("INVALID_INVITE"));
  assert.equal((await service.leaderboard(member, player.playerToken)).you.total, 15);
  const rotated = await service.changeInvite(member.roomId, { action: "rotate" });
  assert.ok("inviteCode" in rotated);
  assert.notEqual(rotated.inviteCode, created.inviteCode);
  assert.equal((await service.join({ ...player, inviteCode: rotated.inviteCode })).score.total, 15);
  await assert.rejects(service.join({ ...identity(), inviteCode: created.inviteCode }), errorCode("INVALID_INVITE"));
  await assert.rejects(service.changeInvite(member.roomId, { action: "unknown" }), errorCode("INVALID_INPUT"));
});

test("invite rotation racing a join cannot admit the old invitation after rotation", async () => {
  const { service, store, created, member } = await fixture();
  store.beforeReplace = async () => { await service.changeInvite(member.roomId, { action: "rotate" }); };
  await assert.rejects(service.join({ ...identity(), inviteCode: created.inviteCode }), errorCode("INVALID_INVITE"));
  assert.equal((await service.inspectRoom(member.roomId)).playerCount, 1);
});

test("adult removal works without a lost player's token and leaves other profiles intact", async () => {
  const { service, member, player, created } = await fixture();
  const other = identity();
  await service.join({ ...other, inviteCode: created.inviteCode });
  await service.adminDeleteProfile(member.roomId, player.playerId);
  await service.adminDeleteProfile(member.roomId, player.playerId);
  await assert.rejects(service.leaderboard(member, player.playerToken), errorCode("UNAUTHORIZED"));
  assert.equal((await service.inspectRoom(member.roomId)).players[0]?.id, other.playerId);
});

test("optimistic concurrency has a bounded retry budget and an explicit retryable error", async () => {
  const { store, member, player } = await fixture();
  const service = new GameService(store, { retryDelay: async () => {} });
  const initialAttempts = store.replaceAttempts;
  store.failNextReplaces = MAX_CAS_ATTEMPTS;
  await assert.rejects(
    service.progress({ ...member, meals: 5, mathSolved: 6 }, player.playerToken), errorCode("BUSY"),
  );
  assert.equal(store.replaceAttempts - initialAttempts, MAX_CAS_ATTEMPTS);
  assert.equal((await service.leaderboard(member, player.playerToken)).you.total, 0);
});

test("there is no silent time-based reset or undocumented automatic expiry", async () => {
  const { store, member, player } = await fixture();
  const future = new GameService(store, { now: () => new Date("2030-01-01T00:00:00.000Z") });
  await future.progress({ ...member, meals: 10, mathSolved: 20 }, player.playerToken);
  assert.equal((await future.leaderboard(member, player.playerToken)).you.total, 30);
});
