import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { ApiError } from "../../src/errors.js";
import type { ErrorCode } from "../../src/errors.js";
import { GameService } from "../../src/service.js";
import { MemoryStore } from "./memory-store.js";

export function identity() {
  return { playerId: randomUUID(), playerToken: randomBytes(32).toString("base64url") };
}

export function errorCode(code: ErrorCode) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, code);
    return true;
  };
}

export async function fixture() {
  const store = new MemoryStore();
  const service = new GameService(store);
  const created = await service.createRoom({});
  const player = identity();
  const joined = await service.join({ ...player, inviteCode: created.inviteCode });
  const member = { roomId: created.room.id, playerId: player.playerId };
  return { store, service, created, player, joined, member };
}
