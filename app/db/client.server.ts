import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { jobs, jobEvents, jobsRelations, jobEventsRelations } from "./schema";
import { config } from "../lib/config.server";
import { logger } from "../lib/logger.server";

async function ensureDirectories() {
  const dir = path.dirname(config.dbPath);
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(config.stagingDir, { recursive: true });
}

await ensureDirectories();

const sqlite = new Database(config.dbPath);
sqlite.pragma("journal_mode = WAL");

export const db = drizzle(sqlite, {
  schema: { jobs, jobEvents, jobsRelations, jobEventsRelations }
});

/**
 * Bring the schema up to date at boot so the container needs no drizzle-kit.
 * A database created by `drizzle-kit push` has tables but no migration
 * journal — running migrations there would fail on CREATE TABLE, so it's
 * skipped (push-managed DBs stay push-managed).
 */
function migrateAtBoot() {
  const tableExists = (name: string) =>
    sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(name) !== undefined;

  if (tableExists("jobs") && !tableExists("__drizzle_migrations")) {
    logger.info("[db] Schema managed by drizzle-kit push; skipping boot migrations");
    return;
  }

  const migrationsFolder = path.resolve("drizzle");
  if (!fsSync.existsSync(migrationsFolder)) {
    logger.warn("[db] No drizzle/ migrations folder found; skipping boot migrations");
    return;
  }

  migrate(db, { migrationsFolder });
  logger.info("[db] Migrations up to date");
}

migrateAtBoot();

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
