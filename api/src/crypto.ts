import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ApiError } from "./errors.js";
import type { Player } from "./model.js";

const ADJECTIVES = ["Flinker", "Mutiger", "Bunter", "Lustiger", "Netter", "Wacher", "Froher", "Sanfter"] as const;
const DINOS = ["Stego", "Rex", "Tricera", "Bronto", "Raptor", "Ankylo", "Iguanodon", "Diplodo"] as const;

export function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function tokenHash(roomId: string, playerId: string, token: string): string {
  return digest(`dinoinsel/player/v1\0${roomId}\0${playerId}\0${token}`);
}

export function inviteHash(code: string): string {
  return digest(`dinoinsel/invite/v1\0${code}`);
}

export function equalHash(left: string | null, right: string): boolean {
  const expected = Buffer.from(left ?? "0".repeat(64), "hex");
  const actual = Buffer.from(right, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual) && left !== null;
}

export function newInvite(roomId: string): string {
  return `${roomId}.${randomBytes(32).toString("base64url")}`;
}

export function nickname(playerId: string, existing: readonly Player[]): string {
  for (let attempt = 0; attempt <= existing.length; attempt++) {
    const seed = digest(`dinoinsel/nickname/v1\0${playerId}\0${attempt}`);
    const adjective = ADJECTIVES[Number.parseInt(seed.slice(0, 2), 16) % ADJECTIVES.length];
    const dino = DINOS[Number.parseInt(seed.slice(2, 4), 16) % DINOS.length];
    const name = `${adjective} ${dino}-${seed.slice(4, 10).toUpperCase()}`;
    if (!existing.some((player) => player.nickname === name)) {
      return name;
    }
  }
  throw new ApiError("BUSY");
}
