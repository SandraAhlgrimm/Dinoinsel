import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { loadConfig } from "../dist/config.js";

try {
  const path = process.argv[2];
  if (!path || isAbsolute(path) || relative(process.cwd(), resolve(path)).startsWith("..")) {
    throw new Error("Use a parameter file inside api/.");
  }
  const file = JSON.parse(await readFile(path, "utf8"));
  const parameters = file.parameters;
  const appName = parameters?.appName?.value;
  const origins = parameters?.gameOrigins?.value;
  const maximum = parameters?.maximumInstanceCount?.value ?? 1;
  if (
    typeof appName !== "string" || !/^[a-z][a-z0-9-]{1,58}[a-z0-9]$/.test(appName) ||
    !Array.isArray(origins) || !origins.every((origin) => typeof origin === "string") ||
    /replace|placeholder|your-account/i.test(JSON.stringify([appName, origins])) ||
    !Number.isInteger(maximum) || maximum < 1 || maximum > 10
  ) {
    throw new Error("Replace the example placeholders and use exact HTTPS origins and a scale ceiling of 1–10.");
  }
  loadConfig({
    STORAGE_MODE: "managed-identity", TABLE_NAME: "Dinoinsel",
    TABLE_ENDPOINT: "https://configurationcheck.table.core.windows.net",
    ALLOWED_ORIGINS: origins.join(","),
  });
  console.log("Local parameter checks passed. No Azure connection, resource creation, or regional availability check was performed.");
} catch {
  console.error("Parameter check failed. Replace placeholders, use a valid lowercase app name and exact HTTPS origins (no path, slash, wildcard, credentials or query).");
  process.exitCode = 1;
}
