import functions from "@azure/functions";
import { failureResponse } from "./http.js";
import { ROUTES } from "./routes.js";
import { getRuntime } from "./runtime.js";

const { app } = functions;

for (const route of ROUTES) {
  app.http(route.action, {
    methods: [route.method],
    route: route.route,
    authLevel: route.authLevel,
    handler: async (request, context) => {
      const log = (message: string) => context.error(message);
      try {
        return await getRuntime().handle(route.action, request, log);
      } catch (error) {
        return failureResponse(error, log);
      }
    },
  });
}

for (const [index, route] of [...new Set(ROUTES.map((candidate) => candidate.route))].entries()) {
  app.http(`preflight${index}`, {
    methods: ["OPTIONS"],
    route,
    authLevel: "anonymous",
    handler: (request, context) => {
      const log = (message: string) => context.error(message);
      try {
        return getRuntime().preflight(route, request, log);
      } catch (error) {
        return failureResponse(error, log);
      }
    },
  });
}
