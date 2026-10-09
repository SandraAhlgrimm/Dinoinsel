import { loadConfig } from "./config.js";
import { HttpApi } from "./http.js";
import { GameService } from "./service.js";
import { AzureTableStore, createTableClient } from "./table-store.js";

let runtime: HttpApi | undefined;

export function getRuntime(): HttpApi {
  if (!runtime) {
    const config = loadConfig(process.env);
    runtime = new HttpApi(new GameService(new AzureTableStore(createTableClient(config.storage))), config.allowedOrigins);
  }
  return runtime;
}
