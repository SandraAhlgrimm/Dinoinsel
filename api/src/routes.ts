export const ROUTES = [
  { action: "createRoom", route: "admin/rooms", method: "POST", authLevel: "function" },
  { action: "inspectRoom", route: "admin/rooms/{roomId}", method: "GET", authLevel: "function" },
  { action: "deleteRoom", route: "admin/rooms/{roomId}", method: "DELETE", authLevel: "function" },
  { action: "changeInvite", route: "admin/rooms/{roomId}/invite", method: "POST", authLevel: "function" },
  { action: "adminDeleteProfile", route: "admin/rooms/{roomId}/profiles/{playerId}", method: "DELETE", authLevel: "function" },
  { action: "join", route: "rooms/join", method: "POST", authLevel: "anonymous" },
  { action: "leaderboard", route: "leaderboard", method: "GET", authLevel: "anonymous" },
  { action: "progress", route: "progress", method: "POST", authLevel: "anonymous" },
  { action: "deleteProfile", route: "profile", method: "DELETE", authLevel: "anonymous" },
] as const;

export type Action = typeof ROUTES[number]["action"];
export type Route = typeof ROUTES[number];

export function matchRoute(pathname: string, method: string): { route: Route; params: Record<string, string> } | undefined {
  for (const route of ROUTES) {
    if (route.method !== method && method !== "OPTIONS") continue;
    const keys = [...route.route.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? "");
    const pattern = `^/api/${route.route.replace(/\{\w+\}/g, "([^/]+)")}$`;
    const match = pathname.match(new RegExp(pattern));
    if (!match) continue;
    const params: Record<string, string> = {};
    keys.forEach((key, index) => { params[key] = match[index + 1] ?? ""; });
    return { route, params };
  }
  return undefined;
}
