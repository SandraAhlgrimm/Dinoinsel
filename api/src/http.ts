import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { digest } from "./crypto.js";
import { ApiError, ConfigurationError, safeError, StoreUnavailable } from "./errors.js";
import { MAX_BODY_BYTES } from "./model.js";
import { RATE_LIMITS, RateLimiter } from "./rate-limit.js";
import { ROUTES } from "./routes.js";
import type { Action } from "./routes.js";
import type { GameService } from "./service.js";
import { bearerToken, isObject, memberQuery } from "./validation.js";

export type SafeLog = (message: string) => void;
const ALLOWED_HEADERS = ["authorization", "content-type", "x-functions-key"] as const;

export function responseHeaders(): Record<string, string> {
  return {
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
    Vary: "Origin",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  };
}

export function failureResponse(
  error: unknown,
  log: SafeLog,
  headers: Record<string, string> = responseHeaders(),
): HttpResponseInit {
  const safe = safeError(error);
  if (safe.status === 503) {
    const category = error instanceof StoreUnavailable ? "storage"
      : error instanceof ConfigurationError ? "configuration"
        : error instanceof ApiError ? "contention" : "unexpected";
    log(`Dinoinsel API failure: ${category}; ${safe.code}`);
  }
  if (safe.status === 401) headers["WWW-Authenticate"] = 'Bearer realm="Dinoinsel"';
  if (safe.status === 429 || safe.status === 503) headers["Retry-After"] = safe.status === 429 ? "60" : "5";
  return {
    status: safe.status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
    jsonBody: { error: { code: safe.code, message: safe.message } },
  };
}

async function jsonInput(request: HttpRequest, optional = false): Promise<unknown> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
    throw new ApiError("INVALID_INPUT");
  }
  if (request.headers.has("content-encoding")) throw new ApiError("INVALID_INPUT");
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      for (;;) {
        const { done, value }: ReadableStreamReadResult<unknown> = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) throw new ApiError("INVALID_INPUT");
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) {
          await reader.cancel();
          throw new ApiError("INVALID_INPUT");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  if (size === 0 && optional) return {};
  const contentType = request.headers.get("content-type")?.toLowerCase();
  if (!contentType || !/^application\/json(?:\s*;\s*charset=utf-8)?$/.test(contentType)) {
    throw new ApiError("INVALID_INPUT");
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))) as unknown;
  } catch {
    throw new ApiError("INVALID_INPUT");
  }
}

export class HttpApi {
  constructor(
    private readonly service: GameService,
    private readonly allowedOrigins: ReadonlySet<string>,
    private readonly limiter = new RateLimiter(),
  ) {}

  async handle(action: Action, request: HttpRequest, log: SafeLog): Promise<HttpResponseInit> {
    const headers = responseHeaders();
    try {
      this.cors(request, headers);
      this.limiter.take("global", RATE_LIMITS.global);
      const route = ROUTES.find((candidate) => candidate.action === action);
      if (!route || request.method !== route.method) throw new ApiError("INVALID_INPUT");
      if (route.authLevel === "function") this.limiter.take("admin", RATE_LIMITS.admin);
      if (action === "join") this.limiter.take("join", RATE_LIMITS.join);

      let result: unknown;
      let status = 200;
      switch (action) {
        case "createRoom":
          result = await this.service.createRoom(await jsonInput(request, true));
          status = 201;
          break;
        case "inspectRoom":
          result = await this.service.inspectRoom(request.params.roomId);
          break;
        case "deleteRoom":
          await this.service.deleteRoom(request.params.roomId);
          status = 204;
          break;
        case "changeInvite":
          result = await this.service.changeInvite(request.params.roomId, await jsonInput(request));
          break;
        case "adminDeleteProfile":
          await this.service.adminDeleteProfile(request.params.roomId, request.params.playerId);
          status = 204;
          break;
        case "join":
          result = await this.service.join(await jsonInput(request));
          break;
        case "leaderboard": {
          const input = memberQuery(request.query);
          const token = bearerToken(request.headers.get("authorization"));
          this.identityLimit(input, token);
          result = await this.service.leaderboard(input, token);
          break;
        }
        case "progress": {
          const input = await jsonInput(request);
          const token = bearerToken(request.headers.get("authorization"));
          this.identityLimit(input, token);
          result = await this.service.progress(input, token);
          break;
        }
        case "deleteProfile": {
          const input = memberQuery(request.query);
          const token = bearerToken(request.headers.get("authorization"));
          this.identityLimit(input, token);
          await this.service.deleteProfile(input, token);
          status = 204;
          break;
        }
      }
      return status === 204
        ? { status, headers }
        : { status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" }, jsonBody: result };
    } catch (error) {
      return failureResponse(error, log, headers);
    }
  }

  preflight(route: string, request: HttpRequest, log: SafeLog): HttpResponseInit {
    const headers = responseHeaders();
    headers.Vary = "Origin, Access-Control-Request-Method, Access-Control-Request-Headers";
    try {
      this.cors(request, headers);
      this.limiter.take("global", RATE_LIMITS.global);
      const method = request.headers.get("access-control-request-method");
      const requestedHeaders = request.headers.get("access-control-request-headers")?.split(",").map((value) => value.trim().toLowerCase()) ?? [];
      const methods = ROUTES.filter((candidate) => candidate.route === route).map((candidate) => candidate.method);
      if (
        request.method !== "OPTIONS" ||
        !request.headers.has("origin") ||
        !methods.some((allowed) => allowed === method) ||
        requestedHeaders.some((header) => !ALLOWED_HEADERS.some((allowed) => allowed === header))
      ) {
        throw new ApiError("ORIGIN_NOT_ALLOWED");
      }
      headers["Access-Control-Allow-Methods"] = [...methods, "OPTIONS"].join(", ");
      headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type, X-Functions-Key";
      headers["Access-Control-Max-Age"] = "300";
      return { status: 204, headers };
    } catch (error) {
      return failureResponse(error, log, headers);
    }
  }

  private cors(request: HttpRequest, headers: Record<string, string>): void {
    const origin = request.headers.get("origin");
    if (origin === null) return;
    if (!this.allowedOrigins.has(origin)) throw new ApiError("ORIGIN_NOT_ALLOWED");
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Expose-Headers"] = "Retry-After";
  }

  private identityLimit(input: unknown, token: string): void {
    if (!isObject(input) || typeof input.roomId !== "string" || typeof input.playerId !== "string") {
      throw new ApiError("INVALID_INPUT");
    }
    const key = digest(`${input.roomId.toLowerCase()}\0${input.playerId.toLowerCase()}\0${token}`);
    this.limiter.take(`identity:${key}`, RATE_LIMITS.identity);
  }
}
