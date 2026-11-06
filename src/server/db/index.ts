import { mkdirSync } from "node:fs";
import path from "node:path";

import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

import { env } from "../../env.js";
import * as schema from "./schema.ts";

// Keep one connection across dev hot reloads.
const globalForDb = globalThis as unknown as { client: Client | undefined };

function connect() {
  mkdirSync(path.dirname(env.DATABASE_PATH), { recursive: true });
  const client = createClient({ url: `file:${env.DATABASE_PATH}` });
  // The web app and `pnpm research` share this file, so wait on locks instead of failing. The wait
  // is set first so that switching to WAL waits too, such as while another process recovers the
  // file after a crash. WAL is stored in the file, so a failure here must not stop the app.
  client
    .executeMultiple("PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL;")
    .catch(() => undefined);
  return client;
}

export const client = globalForDb.client ?? connect();
if (env.NODE_ENV !== "production") globalForDb.client = client;

export const db = drizzle(client, { schema });
