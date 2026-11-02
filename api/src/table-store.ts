import { TableClient } from "@azure/data-tables";
import { ManagedIdentityCredential } from "@azure/identity";
import type { ApiConfig } from "./config.js";
import { StoreConflict, StoreUnavailable } from "./errors.js";
import { MAX_COUNTER, MAX_PLAYERS, MAX_STATE_BYTES } from "./model.js";
import type { Player, Room, RoomStore, VersionedRoom } from "./model.js";
import { HASH_PATTERN, isObject, UUID_PATTERN } from "./validation.js";

const ROW_KEY = "room";
const SCHEMA_VERSION = 1;
const REQUEST_TIMEOUT_MS = 3_000;

function isStoredPlayer(value: unknown): value is Player {
  return isObject(value)
    && typeof value.id === "string" && UUID_PATTERN.test(value.id) && value.id === value.id.toLowerCase()
    && typeof value.nickname === "string" && /^[A-Za-zÄÖÜäöüß ]{3,40}-[0-9A-F]{6}$/.test(value.nickname)
    && typeof value.tokenHash === "string" && HASH_PATTERN.test(value.tokenHash)
    && typeof value.meals === "number" && Number.isSafeInteger(value.meals) && value.meals >= 0 && value.meals <= MAX_COUNTER
    && typeof value.mathSolved === "number" && Number.isSafeInteger(value.mathSolved) && value.mathSolved >= 0 && value.mathSolved <= MAX_COUNTER;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

export function decodeRoom(state: unknown, roomId: string): Room {
  if (typeof state !== "string" || Buffer.byteLength(state, "utf16le") > MAX_STATE_BYTES) {
    throw new StoreUnavailable();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(state);
  } catch {
    throw new StoreUnavailable();
  }
  if (
    !isObject(parsed) ||
    parsed.id !== roomId ||
    !UUID_PATTERN.test(roomId) ||
    typeof parsed.label !== "string" || !/^[\p{L}\p{N} .!_-]{1,40}$/u.test(parsed.label) ||
    !(parsed.inviteHash === null || (typeof parsed.inviteHash === "string" && HASH_PATTERN.test(parsed.inviteHash))) ||
    !isTimestamp(parsed.createdAt) || !isTimestamp(parsed.updatedAt) ||
    !Array.isArray(parsed.players) || parsed.players.length > MAX_PLAYERS ||
    !parsed.players.every(isStoredPlayer) ||
    new Set(parsed.players.map((player) => player.id)).size !== parsed.players.length ||
    new Set(parsed.players.map((player) => player.nickname)).size !== parsed.players.length
  ) {
    throw new StoreUnavailable();
  }
  return {
    id: roomId,
    label: parsed.label,
    inviteHash: parsed.inviteHash,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    players: parsed.players,
  };
}

export function encodeRoom(room: Room) {
  const state = JSON.stringify(room);
  if (Buffer.byteLength(state, "utf16le") > MAX_STATE_BYTES) throw new StoreUnavailable();
  return { partitionKey: room.id, rowKey: ROW_KEY, schemaVersion: SCHEMA_VERSION, state };
}

function tableErrorCode(error: unknown): unknown {
  if (!isObject(error)) return undefined;
  return isObject(error.details) ? error.details.errorCode ?? error.code : error.code;
}

function isMissingEntity(error: unknown): boolean {
  return isObject(error) && error.statusCode === 404 && tableErrorCode(error) === "ResourceNotFound";
}

function storageFailure(error: unknown): StoreConflict | StoreUnavailable {
  if (
    isMissingEntity(error) ||
    (isObject(error) && (error.statusCode === 412 || (error.statusCode === 409 && tableErrorCode(error) === "EntityAlreadyExists")))
  ) {
    return new StoreConflict();
  }
  return new StoreUnavailable();
}

export class AzureTableStore implements RoomStore {
  constructor(private readonly client: TableClient) {}

  async read(roomId: string): Promise<VersionedRoom | undefined> {
    try {
      const entity = await this.client.getEntity<{ state: unknown; schemaVersion: unknown }>(
        roomId, ROW_KEY, { abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
      );
      if (entity.schemaVersion !== SCHEMA_VERSION || !entity.etag) throw new StoreUnavailable();
      return { room: decodeRoom(entity.state, roomId), etag: entity.etag };
    } catch (error) {
      if (isMissingEntity(error)) return undefined;
      throw new StoreUnavailable();
    }
  }

  async create(room: Room): Promise<void> {
    try {
      await this.client.createEntity(encodeRoom(room), { abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      throw storageFailure(error);
    }
  }

  async replace(room: Room, etag: string): Promise<void> {
    if (!etag || etag === "*") throw new StoreUnavailable();
    try {
      await this.client.updateEntity(encodeRoom(room), "Replace", {
        etag, abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw storageFailure(error);
    }
  }

  async remove(roomId: string, etag: string): Promise<void> {
    if (!etag || etag === "*") throw new StoreUnavailable();
    try {
      await this.client.deleteEntity(roomId, ROW_KEY, {
        etag, abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw storageFailure(error);
    }
  }
}

export function createTableClient(storage: ApiConfig["storage"]): TableClient {
  const options = { retryOptions: { maxRetries: 2, retryDelayInMs: 200, maxRetryDelayInMs: 1_000 } };
  if (storage.mode === "azurite") {
    return TableClient.fromConnectionString("UseDevelopmentStorage=true", storage.tableName, options);
  }
  const identity = storage.clientId === undefined
    ? new ManagedIdentityCredential()
    : new ManagedIdentityCredential({ clientId: storage.clientId });
  return new TableClient(storage.endpoint, storage.tableName, identity, options);
}
