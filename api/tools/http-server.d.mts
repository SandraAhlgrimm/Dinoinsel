import type { HttpApi } from "../src/http.js";
import type { matchRoute } from "../src/routes.js";

export function startLocalServer(
  api: HttpApi,
  matcher: typeof matchRoute,
  options: { adminKey: string; port?: number; log?: (message: string) => void },
): Promise<{ origin: string; stop(): Promise<void> }>;
