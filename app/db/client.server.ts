import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as fs from "node:fs/promises";
import * as path from "path";
import { jobs } from "./schema";

const DB_PATH = process.env.NODE_ENV === "production" 
  ? "/data/audiobook-archive.db" 
  : "./data/audiobook-archive.db";

async function ensureDirectories() {
  const dir = path.dirname(DB_PATH);
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(path.join(dir, "staging"), { recursive: true });
}

await ensureDirectories();

const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");

export const db = drizzle(sqlite);

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
