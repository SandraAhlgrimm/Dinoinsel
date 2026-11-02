import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import functions from "@azure/functions";

const { HttpRequest, HttpResponse } = functions;
const hash = (value) => createHash("sha256").update(value).digest();

export async function startLocalServer(api, matchRoute, { adminKey, port = 0, log = () => {} }) {
  if (typeof adminKey !== "string" || adminKey.length < 32) throw new Error("A random local-only administration key is required.");
  const keyHash = hash(adminKey);
  const server = createServer({
    maxHeaderSize: 8_192,
    requestTimeout: 10_000,
    headersTimeout: 10_000,
    keepAliveTimeout: 1_000,
  }, async (incoming, outgoing) => {
    const localError = (status, code, message) => ({
      status,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      jsonBody: { error: { code, message } },
    });
    const send = async (init) => {
      const response = new HttpResponse(init);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    };
    try {
      if (!incoming.url || incoming.url.length > 2_048) {
        await send(localError(400, "INVALID_INPUT", "Bitte prüfe die Eingaben."));
        return;
      }
      const url = new URL(incoming.url, "http://127.0.0.1");
      const method = incoming.method ?? "";
      const matched = matchRoute(url.pathname, method);
      if (!matched) {
        await send(localError(404, "NOT_FOUND", "Diese Adresse gibt es nicht."));
        return;
      }
      if (method !== "OPTIONS" && matched.route.authLevel === "function") {
        const supplied = incoming.headers["x-functions-key"];
        if (typeof supplied !== "string" || !timingSafeEqual(hash(supplied), keyHash)) {
          await send(localError(401, "UNAUTHORIZED", "Der lokale Erwachsenen-Schlüssel fehlt oder ist ungültig."));
          return;
        }
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > 2_048) {
          await send(localError(400, "INVALID_INPUT", "Diese Anfrage ist zu groß."));
          return;
        }
        chunks.push(chunk);
      }
      const headers = {};
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (typeof value === "string") headers[key] = value;
        else if (Array.isArray(value)) headers[key] = value.join(", ");
      }
      const request = new HttpRequest({
        url: url.href, method, headers, params: matched.params,
        ...(chunks.length === 0 ? {} : { body: { bytes: Buffer.concat(chunks, size) } }),
      });
      const response = method === "OPTIONS"
        ? api.preflight(matched.route.route, request, log)
        : await api.handle(matched.route.action, request, log);
      await send(response);
    } catch {
      log("Dinoinsel local adapter failure.");
      if (!outgoing.headersSent) {
        await send(localError(503, "UNAVAILABLE", "Der lokale Testserver ist gerade nicht erreichbar."));
      } else {
        outgoing.end();
      }
    }
  });
  server.maxHeadersCount = 32;
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", accept);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The local API did not bind to loopback.");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    async stop() {
      await new Promise((accept, reject) => {
        server.close((error) => error ? reject(error) : accept());
        server.closeAllConnections();
      });
    },
  };
}
