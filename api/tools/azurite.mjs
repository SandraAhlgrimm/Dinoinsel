import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AzureNamedKeyCredential, TableClient } from "@azure/data-tables";

async function availablePort() {
  const reservation = createServer();
  await new Promise((accept, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", accept);
  });
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("No loopback port available.");
  await new Promise((accept, reject) => reservation.close((error) => error ? reject(error) : accept()));
  return address.port;
}

export async function startAzurite({ location, tableName = "Dinoinsel" }) {
  if (isAbsolute(location) || relative(process.cwd(), resolve(location)).startsWith("..")) {
    throw new Error("Azurite data must remain inside the API workspace.");
  }
  await mkdir(location, { recursive: true, mode: 0o700 });
  await mkdir(".local/tmp", { recursive: true, mode: 0o700 });
  const port = await availablePort();
  const account = "dinoinsellocal";
  const key = randomBytes(64).toString("base64");
  const client = new TableClient(
    `http://127.0.0.1:${port}/${account}`,
    tableName,
    new AzureNamedKeyCredential(account, key),
    { allowInsecureConnection: true, retryOptions: { maxRetries: 0 } },
  );
  const child = spawn(process.execPath, [
    "node_modules/azurite/dist/src/table/main.js",
    "--tableHost", "127.0.0.1", "--tablePort", String(port),
    "--location", location, "--silent",
  ], {
    stdio: "ignore",
    env: { ...process.env, TMPDIR: resolve(".local/tmp"), AZURITE_ACCOUNTS: `${account}:${key}`, AZURE_LOG_LEVEL: "" },
  });
  let startError;
  child.on("error", () => { startError = new Error("Could not start the workspace-local Azurite process."); });
  const killOnExit = () => { if (child.exitCode === null) child.kill("SIGTERM"); };
  process.once("exit", killOnExit);
  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    process.removeListener("exit", killOnExit);
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((accept) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); }, 3_000);
      child.once("exit", () => { clearTimeout(timer); accept(); });
      child.kill("SIGTERM");
    });
  }
  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (startError || child.exitCode !== null) {
        throw startError ?? new Error("The workspace-local Azurite process exited before readiness.");
      }
      try {
        await client.createTable({ abortSignal: AbortSignal.timeout(1_000) });
        return { client, port, stop, pid: child.pid };
      } catch (error) {
        if (error?.statusCode === 409 && (error?.details?.errorCode ?? error?.code) === "TableAlreadyExists") {
          return { client, port, stop, pid: child.pid };
        }
        if (error?.statusCode === 400 || error?.statusCode === 403) {
          throw new Error("Local emulator configuration or authentication failed.");
        }
        await delay(100);
      }
    }
    throw new Error("The workspace-local Azurite process did not become responsive.");
  } catch (error) {
    await stop();
    throw error;
  }
}
