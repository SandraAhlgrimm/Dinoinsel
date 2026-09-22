import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { nickname } from "../../src/crypto.js";
import { StoreUnavailable } from "../../src/errors.js";
import { MAX_COUNTER, MAX_PLAYERS, MAX_STATE_BYTES } from "../../src/model.js";
import type { Room } from "../../src/model.js";
import { decodeRoom, encodeRoom } from "../../src/table-store.js";

function maximumRoom(): Room {
  const room: Room = {
    id: randomUUID(), label: "Ä".repeat(40), inviteHash: "a".repeat(64),
    createdAt: "2026-09-21T00:00:00.000Z", updatedAt: "2026-09-21T00:00:00.000Z", players: [],
  };
  for (let index = 0; index < MAX_PLAYERS; index++) {
    const id = randomUUID();
    room.players.push({
      id, nickname: nickname(id, room.players), tokenHash: "b".repeat(64), meals: MAX_COUNTER, mathSolved: MAX_COUNTER,
    });
  }
  return room;
}

test("a full room at maximum scores fits below the Azure Table 64-KiB string-property limit", () => {
  const room = maximumRoom();
  const encoded = encodeRoom(room);
  assert.ok(Buffer.byteLength(encoded.state, "utf16le") < MAX_STATE_BYTES);
  assert.ok(MAX_STATE_BYTES < 64 * 1024);
  assert.deepEqual(decodeRoom(encoded.state, room.id), room);
});

test("malformed persisted state fails closed rather than returning or silently resetting a room", () => {
  const room = maximumRoom();
  for (const state of [
    "not json", null, "x".repeat(MAX_STATE_BYTES), JSON.stringify({ ...room, id: randomUUID() }),
    JSON.stringify({ ...room, players: [...room.players, room.players[0]] }),
    JSON.stringify({ ...room, players: [{ ...room.players[0], meals: -1 }] }),
    JSON.stringify({ ...room, players: [{ ...room.players[0], tokenHash: "plaintext" }] }),
    JSON.stringify({ ...room, updatedAt: "not-a-date" }),
  ]) {
    assert.throws(() => decodeRoom(state, room.id), StoreUnavailable);
  }
});
