import { ConfigurationError } from "./errors.js";
import { UUID_PATTERN } from "./validation.js";

export interface ApiConfig {
  allowedOrigins: ReadonlySet<string>;
  storage:
    | { mode: "azurite"; tableName: string }
    | { mode: "managed-identity"; tableName: string; endpoint: string; clientId?: string };
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): ApiConfig {
  const mode = env.STORAGE_MODE ?? "managed-identity";
  if (mode !== "managed-identity" && mode !== "azurite") throw new ConfigurationError();
  if (mode === "azurite" && (env.WEBSITE_INSTANCE_ID || env.WEBSITE_HOSTNAME)) throw new ConfigurationError();
  const tableName = env.TABLE_NAME ?? "Dinoinsel";
  if (!/^[A-Za-z][A-Za-z0-9]{2,62}$/.test(tableName)) throw new ConfigurationError();

  const origins = env.ALLOWED_ORIGINS?.split(",").map((origin) => origin.trim()) ?? [];
  if (origins.length === 0 || origins.length > 10) throw new ConfigurationError();
  for (const origin of origins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new ConfigurationError();
    }
    const local = mode === "azurite"
      && url.protocol === "http:"
      && ["localhost", "127.0.0.1"].includes(url.hostname)
      && url.port === "4173";
    if (
      origin.length > 255 ||
      origin !== url.origin ||
      origin.includes("*") ||
      (url.protocol !== "https:" && !local)
    ) {
      throw new ConfigurationError();
    }
  }
  const allowedOrigins = new Set(origins);
  if (mode === "azurite") return { allowedOrigins, storage: { mode, tableName } };

  let endpoint: URL;
  try {
    endpoint = new URL(env.TABLE_ENDPOINT ?? "");
  } catch {
    throw new ConfigurationError();
  }
  if (
    endpoint.protocol !== "https:" ||
    !/^[a-z0-9]{3,24}\.table\.core\.windows\.net$/.test(endpoint.hostname) ||
    endpoint.port !== "" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.pathname !== "/" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new ConfigurationError();
  }
  const clientId = env.MANAGED_IDENTITY_CLIENT_ID;
  if (clientId !== undefined && !UUID_PATTERN.test(clientId)) throw new ConfigurationError();
  return {
    allowedOrigins,
    storage: {
      mode,
      tableName,
      endpoint: endpoint.origin,
      ...(clientId === undefined ? {} : { clientId }),
    },
  };
}
