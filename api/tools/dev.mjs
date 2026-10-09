import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { HttpApi } from "../dist/http.js";
import { matchRoute } from "../dist/routes.js";
import { GameService } from "../dist/service.js";
import { AzureTableStore } from "../dist/table-store.js";
import { startAzurite } from "./azurite.mjs";
import { startLocalServer } from "./http-server.mjs";

await mkdir(".local/dev", { recursive: true, mode: 0o700 });
let emulator;
let server;
let ownsKey = false;
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  try {
    try {
      if (server) await server.stop();
    } finally {
      try {
        if (emulator) await emulator.stop();
      } finally {
        if (ownsKey) await rm(".local/dev-admin-key", { force: true });
        ownsKey = false;
      }
    }
  } catch {
    console.error("Local shutdown needs attention; check the two processes started by this command.");
    code = 1;
  } finally {
    process.exitCode = code;
  }
}
process.once("SIGINT", () => { void stop(); });
process.once("SIGTERM", () => { void stop(); });

try {
  const key = randomBytes(32).toString("base64url");
  await writeFile(".local/dev-admin-key", key, { flag: "wx", mode: 0o600 });
  ownsKey = true;
  emulator = await startAzurite({ location: ".local/dev/azurite" });
  if (stopping) {
    await emulator.stop();
  } else {
    const api = new HttpApi(new GameService(new AzureTableStore(emulator.client)), new Set([
      "http://localhost:4173", "http://127.0.0.1:4173",
    ]));
    server = await startLocalServer(api, matchRoute, { port: 7071, adminKey: key, log: (message) => console.error(message) });
    if (stopping) {
      await server.stop();
    } else {
      console.log(`Dinoinsel local API: ${server.origin}`);
      console.log("Loopback only; no Azure connection. Game origin: http://localhost:4173 or http://127.0.0.1:4173.");
      console.log("In another terminal: npm run admin -- --local create");
      console.log("Ctrl+C stops both processes. Local emulator data stays in .local/dev/.");
    }
  }
} catch {
  console.error("Local startup failed. Check port 7071 and .local/dev-admin-key; never remove a key file while another local API is running.");
  await stop(1);
} finally {
  if (stopping && ownsKey) {
    await rm(".local/dev-admin-key", { force: true });
    ownsKey = false;
  }
}
