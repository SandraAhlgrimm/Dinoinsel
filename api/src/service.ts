import { randomInt, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { equalHash, inviteHash, newInvite, nickname, tokenHash } from "./crypto.js";
import { ApiError, StoreConflict } from "./errors.js";
import { MAX_CAS_ATTEMPTS, MAX_PLAYERS, publicRoom, scoreOf } from "./model.js";
import type { LeaderboardEntry, Player, Room, RoomStore, VersionedRoom } from "./model.js";
import { counter, invitation, memberInput, objectInput, playerToken, roomLabel, uuid } from "./validation.js";

type Mutation<T> =
  | { kind: "unchanged"; result: T }
  | { kind: "replace"; room: Room; result: T }
  | { kind: "delete"; result: T };

export interface ServiceOptions {
  now?: () => Date;
  retryDelay?: (attempt: number) => Promise<void>;
}

export class GameService {
  private readonly now: () => Date;
  private readonly retryDelay: (attempt: number) => Promise<void>;

  constructor(private readonly store: RoomStore, options: ServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.retryDelay = options.retryDelay ?? ((attempt) => delay(randomInt(5, Math.min(160, 10 * 2 ** attempt) + 1)));
  }

  async createRoom(input: unknown = {}) {
    const body = objectInput(input, [], ["label"]);
    const label = roomLabel(body.label);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const id = randomUUID();
      const inviteCode = newInvite(id);
      const timestamp = this.now().toISOString();
      const room: Room = {
        id, label, inviteHash: inviteHash(inviteCode), createdAt: timestamp, updatedAt: timestamp, players: [],
      };
      try {
        await this.store.create(room);
        return { room: publicRoom(room), inviteCode };
      } catch (error) {
        if (!(error instanceof StoreConflict)) throw error;
      }
    }
    throw new ApiError("BUSY");
  }

  async join(input: unknown) {
    const body = objectInput(input, ["inviteCode", "playerId", "playerToken"]);
    const invite = invitation(body.inviteCode);
    const playerId = uuid(body.playerId);
    const token = playerToken(body.playerToken);
    const hash = tokenHash(invite.roomId, playerId, token);

    return this.mutate(invite.roomId, (stored) => {
      const room = stored?.room;
      if (!room || !equalHash(room.inviteHash, inviteHash(invite.code))) {
        throw new ApiError("INVALID_INVITE");
      }
      const existing = room.players.find((player) => player.id === playerId);
      if (existing) {
        if (!equalHash(existing.tokenHash, hash)) throw new ApiError("IDENTITY_CONFLICT");
        return { kind: "unchanged", result: this.joinResult(room, existing) };
      }
      if (room.players.length >= MAX_PLAYERS) throw new ApiError("ROOM_FULL");
      const player: Player = { id: playerId, nickname: nickname(playerId, room.players), tokenHash: hash, meals: 0, mathSolved: 0 };
      room.players.push(player);
      this.touch(room);
      return { kind: "replace", room, result: this.joinResult(room, player) };
    });
  }

  async leaderboard(input: unknown, rawToken: unknown) {
    const { roomId, playerId } = memberInput(input);
    const token = playerToken(rawToken, true);
    const room = (await this.store.read(roomId))?.room;
    this.authorize(room, playerId, token);
    if (!room) throw new ApiError("UNAUTHORIZED");

    const entries: LeaderboardEntry[] = [...room.players]
      .sort((left, right) => {
        const scoreDifference = (right.meals + right.mathSolved) - (left.meals + left.mathSolved);
        return scoreDifference || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
      })
      .map((player, index) => ({
        playerId: player.id, nickname: player.nickname, ...scoreOf(player), rank: index + 1,
      }));
    const you = entries.find((entry) => entry.playerId === playerId);
    if (!you) throw new ApiError("UNAUTHORIZED");
    return { entries, you, updatedAt: room.updatedAt };
  }

  async progress(input: unknown, rawToken: unknown) {
    const body = objectInput(input, ["roomId", "playerId", "meals", "mathSolved"]);
    const roomId = uuid(body.roomId);
    const playerId = uuid(body.playerId);
    const token = playerToken(rawToken, true);
    const meals = counter(body.meals);
    const mathSolved = counter(body.mathSolved);

    return this.mutate(roomId, (stored) => {
      const room = stored?.room;
      const player = this.authorize(room, playerId, token);
      if (!room) throw new ApiError("UNAUTHORIZED");
      const nextMeals = Math.max(player.meals, meals);
      const nextMath = Math.max(player.mathSolved, mathSolved);
      if (player.meals === nextMeals && player.mathSolved === nextMath) {
        return { kind: "unchanged", result: { score: scoreOf(player), updatedAt: room.updatedAt } };
      }
      player.meals = nextMeals;
      player.mathSolved = nextMath;
      this.touch(room);
      return { kind: "replace", room, result: { score: scoreOf(player), updatedAt: room.updatedAt } };
    });
  }

  async deleteProfile(input: unknown, rawToken: unknown): Promise<void> {
    const { roomId, playerId } = memberInput(input);
    const token = playerToken(rawToken, true);
    return this.mutate(roomId, (stored) => {
      const room = stored?.room;
      this.authorize(room, playerId, token);
      if (!room) throw new ApiError("UNAUTHORIZED");
      room.players = room.players.filter((player) => player.id !== playerId);
      this.touch(room);
      return { kind: "replace", room, result: undefined };
    });
  }

  async inspectRoom(rawId: unknown) {
    const room = (await this.store.read(uuid(rawId)))?.room;
    if (!room) throw new ApiError("NOT_FOUND");
    return {
      room: publicRoom(room),
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
      inviteActive: room.inviteHash !== null,
      playerCount: room.players.length,
      players: room.players.map((player) => ({ id: player.id, nickname: player.nickname })),
    };
  }

  async changeInvite(rawId: unknown, input: unknown) {
    const roomId = uuid(rawId);
    const body = objectInput(input, ["action"]);
    if (body.action !== "rotate" && body.action !== "revoke") throw new ApiError("INVALID_INPUT");
    const inviteCode = body.action === "rotate" ? newInvite(roomId) : undefined;

    return this.mutate(roomId, (stored) => {
      const room = stored?.room;
      if (!room) throw new ApiError("NOT_FOUND");
      room.inviteHash = inviteCode === undefined ? null : inviteHash(inviteCode);
      this.touch(room);
      const result = inviteCode === undefined
        ? { room: publicRoom(room), inviteRevoked: true as const }
        : { room: publicRoom(room), inviteCode };
      return { kind: "replace", room, result };
    });
  }

  async deleteRoom(rawId: unknown): Promise<void> {
    return this.mutate(uuid(rawId), (stored) => (
      stored ? { kind: "delete", result: undefined } : { kind: "unchanged", result: undefined }
    ));
  }

  async adminDeleteProfile(rawRoomId: unknown, rawPlayerId: unknown): Promise<void> {
    const roomId = uuid(rawRoomId);
    const playerId = uuid(rawPlayerId);
    return this.mutate(roomId, (stored) => {
      const room = stored?.room;
      if (!room) throw new ApiError("NOT_FOUND");
      if (!room.players.some((player) => player.id === playerId)) {
        return { kind: "unchanged", result: undefined };
      }
      room.players = room.players.filter((player) => player.id !== playerId);
      this.touch(room);
      return { kind: "replace", room, result: undefined };
    });
  }

  private authorize(room: Room | undefined, playerId: string, token: string): Player {
    const player = room?.players.find((candidate) => candidate.id === playerId);
    const submitted = tokenHash(room?.id ?? "", playerId, token);
    const matches = equalHash(player?.tokenHash ?? null, submitted);
    if (!player || !matches) throw new ApiError("UNAUTHORIZED");
    return player;
  }

  private joinResult(room: Room, player: Player) {
    return { room: publicRoom(room), player: { id: player.id, nickname: player.nickname }, score: scoreOf(player) };
  }

  private touch(room: Room): void {
    room.updatedAt = new Date(Math.max(this.now().getTime(), Date.parse(room.updatedAt) + 1)).toISOString();
  }

  private async mutate<T>(
    roomId: string,
    mutation: (stored: VersionedRoom | undefined) => Mutation<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const stored = await this.store.read(roomId);
      const operation = mutation(stored);
      if (operation.kind === "unchanged") return operation.result;
      if (!stored) throw new ApiError("NOT_FOUND");
      try {
        if (operation.kind === "delete") {
          await this.store.remove(roomId, stored.etag);
        } else {
          await this.store.replace(operation.room, stored.etag);
        }
        return operation.result;
      } catch (error) {
        if (!(error instanceof StoreConflict)) throw error;
        if (attempt === MAX_CAS_ATTEMPTS - 1) throw new ApiError("BUSY");
        await this.retryDelay(attempt);
      }
    }
    throw new ApiError("BUSY");
  }
}
