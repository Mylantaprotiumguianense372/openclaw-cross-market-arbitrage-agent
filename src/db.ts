import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import type { Logger } from "./logger.js";
import type { AppConfig } from "./config.js";

interface SignalsTable {
  id: string;
  event_key: string;
  long_venue: string;
  short_venue: string;
  target_edge: number;
  net_edge: number;
  size: number;
  created_at: Date;
  status: "pending" | "approved" | "rejected";
}

interface FillsTable {
  id: string;
  signal_id: string;
  status: string;
  filled_size: number;
  pnl: number | null;
  created_at: Date;
}

interface Database {
  signals: SignalsTable;
  fills: FillsTable;
}

export type Db = Kysely<Database>;

export function createDb(config: AppConfig, logger: Logger): Db {
  const { host, port, user, password, database } = config.postgres;
  const dialect = new PostgresDialect({
    pool: new Pool({
      host,
      port,
      user,
      password,
      database,
      max: 10,
      idleTimeoutMillis: 10_000,
    }),
  });

  logger.info({ host, database }, "Connected to Postgres");
  return new Kysely<Database>({ dialect });
}
