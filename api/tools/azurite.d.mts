import type { TableClient } from "@azure/data-tables";

export function startAzurite(options: { location: string; tableName?: string }): Promise<{
  client: TableClient;
  port: number;
  pid: number | undefined;
  stop(): Promise<void>;
}>;
