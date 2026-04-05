import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { jobs } from "./schema";
import { config } from "../lib/config.server";

async function ensureDirectories() {
  const dir = path.dirname(config.dbPath);
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(config.stagingDir, { recursive: true });
}

await ensureDirectories();

const sqlite = new Database(config.dbPath);
sqlite.pragma("journal_mode = WAL");

export const db = drizzle(sqlite);

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
