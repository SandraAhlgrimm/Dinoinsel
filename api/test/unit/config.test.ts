import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../../src/config.js";
import { ConfigurationError } from "../../src/errors.js";
import { RateLimiter } from "../../src/rate-limit.js";
import { errorCode } from "../support/fixtures.js";

const cloud = {
  STORAGE_MODE: "managed-identity",
  TABLE_ENDPOINT: "https://dinoexample.table.core.windows.net",
  TABLE_NAME: "Dinoinsel",
  ALLOWED_ORIGINS: "https://example.github.io",
};

test("production defaults to managed identity and explicit HTTPS origin allowlisting", () => {
  const config = loadConfig(cloud);
  assert.equal(config.storage.mode, "managed-identity");
  assert.deepEqual([...config.allowedOrigins], ["https://example.github.io"]);
  assert.equal(loadConfig({ ...cloud, STORAGE_MODE: undefined }).storage.mode, "managed-identity");
});

test("wildcards, malformed origins, paths, credentials and insecure production origins fail closed", () => {
  for (const ALLOWED_ORIGINS of [
    "", "*", "https://*.github.io", "null", "https://example.github.io/dinoinsel",
    "https://example.github.io/", "https://name:password@example.github.io",
    "http://example.github.io", "http://localhost:4173", "https://example.github.io?query=yes",
  ]) {
    assert.throws(() => loadConfig({ ...cloud, ALLOWED_ORIGINS }), ConfigurationError);
  }
});

test("only the documented HTTP loopback origins are accepted in explicit emulator mode", () => {
  const local = { STORAGE_MODE: "azurite", ALLOWED_ORIGINS: "http://localhost:4173,http://127.0.0.1:4173" };
  assert.equal(loadConfig(local).storage.mode, "azurite");
  assert.throws(() => loadConfig({ ...local, ALLOWED_ORIGINS: "http://localhost:9000" }), ConfigurationError);
  assert.throws(() => loadConfig({ ...local, ALLOWED_ORIGINS: "http://192.168.1.1:4173" }), ConfigurationError);
  assert.throws(() => loadConfig({ ...local, WEBSITE_INSTANCE_ID: "azure-host" }), ConfigurationError);
  assert.throws(() => loadConfig({ ...local, WEBSITE_HOSTNAME: "app.azurewebsites.net" }), ConfigurationError);
});

test("production endpoints cannot include a SAS, password, untrusted hostname or downgrade", () => {
  for (const TABLE_ENDPOINT of [
    "", "http://dinoexample.table.core.windows.net", "https://evil.example",
    "https://dinoexample.table.core.windows.net?sig=SECRET",
    "https://dinoexample.table.core.windows.net/table",
    "https://user:password@dinoexample.table.core.windows.net",
  ]) {
    assert.throws(() => loadConfig({ ...cloud, TABLE_ENDPOINT }), ConfigurationError);
  }
  assert.throws(() => loadConfig({ ...cloud, TABLE_NAME: "invalid-table" }), ConfigurationError);
  assert.throws(() => loadConfig({ ...cloud, MANAGED_IDENTITY_CLIENT_ID: "not-a-uuid" }), ConfigurationError);
  assert.throws(() => loadConfig({ ...cloud, STORAGE_MODE: "shared-key" }), ConfigurationError);
});

test("rate buckets expire, remain bounded, and do not evict active buckets to bypass limits", () => {
  let now = 0;
  const limiter = new RateLimiter(() => now, 2);
  limiter.take("one", 1);
  assert.throws(() => limiter.take("one", 1), errorCode("RATE_LIMITED"));
  limiter.take("two", 1);
  assert.throws(() => limiter.take("three", 1), errorCode("RATE_LIMITED"));
  now = 60_000;
  limiter.take("three", 1);
  limiter.take("one", 1);
  assert.throws(() => limiter.take("one", 1), errorCode("RATE_LIMITED"));
});
