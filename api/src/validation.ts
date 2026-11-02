import { ApiError } from "./errors.js";
import { DEFAULT_ROOM_LABEL, MAX_COUNTER } from "./model.js";

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const HASH_PATTERN = /^[0-9a-f]{64}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const LABEL_PATTERN = /^[\p{L}\p{N} .!_-]{1,40}$/u;

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function objectInput(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (
    !isObject(value) ||
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    throw new ApiError("INVALID_INPUT");
  }
  return value;
}

export function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new ApiError("INVALID_INPUT");
  }
  return value.toLowerCase();
}

export function isToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    TOKEN_PATTERN.test(value) &&
    Buffer.from(value, "base64url").toString("base64url") === value
  );
}

export function playerToken(value: unknown, authorization = false): string {
  if (!isToken(value)) {
    throw new ApiError(authorization ? "UNAUTHORIZED" : "INVALID_INPUT");
  }
  return value;
}

export function bearerToken(header: string | null): string {
  const match = header?.match(/^Bearer ([A-Za-z0-9_-]{43})$/i);
  return playerToken(match?.[1], true);
}

export function counter(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_COUNTER) {
    throw new ApiError("INVALID_INPUT");
  }
  return value;
}

export function roomLabel(value: unknown = DEFAULT_ROOM_LABEL): string {
  if (typeof value !== "string" || value.length > 80) {
    throw new ApiError("INVALID_INPUT");
  }
  const label = value.trim().normalize("NFC");
  if (!LABEL_PATTERN.test(label) || label.length > 40) {
    throw new ApiError("INVALID_INPUT");
  }
  return label;
}

export function invitation(value: unknown): { roomId: string; code: string } {
  if (typeof value !== "string" || value.length !== 80) {
    throw new ApiError("INVALID_INVITE");
  }
  const roomId = value.slice(0, 36);
  const token = value.slice(37);
  if (!UUID_PATTERN.test(roomId) || roomId !== roomId.toLowerCase() || value[36] !== "." || !isToken(token)) {
    throw new ApiError("INVALID_INVITE");
  }
  return { roomId, code: value };
}

export function memberInput(input: unknown): { roomId: string; playerId: string } {
  const body = objectInput(input, ["roomId", "playerId"]);
  return { roomId: uuid(body.roomId), playerId: uuid(body.playerId) };
}

export function memberQuery(query: URLSearchParams): { roomId: string; playerId: string } {
  if (
    [...query.keys()].some((key) => key !== "roomId" && key !== "playerId") ||
    query.getAll("roomId").length !== 1 ||
    query.getAll("playerId").length !== 1
  ) {
    throw new ApiError("INVALID_INPUT");
  }
  return memberInput({ roomId: query.get("roomId"), playerId: query.get("playerId") });
}
