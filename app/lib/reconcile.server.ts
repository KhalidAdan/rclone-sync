import { randomUUID } from "node:crypto";
import { db, type Job } from "../db/client.server";
import { jobs, jobEvents } from "../db/schema";
import { eq } from "drizzle-orm";
import { listFiles } from "./rclone.server";
import { m4bNameOf } from "./types";
import { config } from "./config.server";
import { logger } from "./logger.server";

export interface ReconcileResult {
  scanned: number;
  imported: number;
  updated: number;
  aaxCandidates: number;
}

/**
 * Make SQLite reflect what is actually in B2. Scans the crypt remote
 * recursively and:
 *
 * - annotates known jobs with what the archive really holds
 *   (`archivedAs`: m4b vs legacy aax, plus the exact M4B size), and
 * - adopts remote files the app has never seen (uploaded via rclone CLI
 *   before this app existed) as `origin: "imported"` COMPLETED rows.
 *
 * A book present as both AAX and M4B becomes one row (M4B wins).
 * Read-only against the remote; safe to run repeatedly.
 */
export async function reconcileWithRemote(): Promise<ReconcileResult> {
  logger.info("[reconcile] Scanning remote:", { remote: config.rcloneRemote });
  const { list } = await listFiles(config.rcloneRemote, "", { recurse: true });

  const audioFiles = list.filter(
    (e) => !e.IsDir && /\.(aax|m4b)$/i.test(e.Name),
  );

  const allJobs = await db.select().from(jobs);
  const jobByRemotePath = new Map<string, Job>();
  for (const j of allJobs) {
    jobByRemotePath.set(j.destinationPath + j.filename, j);
    jobByRemotePath.set(j.destinationPath + m4bNameOf(j.filename), j);
  }

  // Group remote files by book (directory + m4b-normalized name) so an
  // AAX/M4B pair collapses into one logical entry.
  type BookEntry = {
    dir: string;
    aax?: { name: string; size: number; modTime: string };
    m4b?: { name: string; size: number; modTime: string };
  };
  const books = new Map<string, BookEntry>();

  for (const file of audioFiles) {
    const slash = file.Path.lastIndexOf("/");
    const dir = slash === -1 ? "" : file.Path.slice(0, slash + 1);
    const key = dir + m4bNameOf(file.Name).toLowerCase();
    const entry = books.get(key) ?? { dir };
    const info = { name: file.Name, size: file.Size, modTime: file.ModTime };
    if (file.Name.toLowerCase().endsWith(".aax")) entry.aax = info;
    else entry.m4b = info;
    books.set(key, entry);
  }

  let imported = 0;
  let updated = 0;
  let aaxCandidates = 0;
  const now = new Date().toISOString();
  const importEvents: (typeof jobEvents.$inferInsert)[] = [];

  for (const book of books.values()) {
    const archivedAs: "aax" | "m4b" = book.m4b ? "m4b" : "aax";
    if (archivedAs === "aax") aaxCandidates++;

    const matched =
      (book.aax && jobByRemotePath.get(book.dir + book.aax.name)) ||
      (book.m4b && jobByRemotePath.get(book.dir + book.m4b.name));

    if (matched) {
      // Never downgrade a job that already knows its M4B is archived.
      const nextArchivedAs =
        matched.archivedAs === "m4b" ? "m4b" : archivedAs;
      const nextM4bSize = book.m4b?.size ?? matched.m4bSizeBytes;
      if (
        matched.archivedAs !== nextArchivedAs ||
        matched.m4bSizeBytes !== nextM4bSize
      ) {
        await db
          .update(jobs)
          .set({
            archivedAs: nextArchivedAs,
            m4bSizeBytes: nextM4bSize,
            updatedAt: now,
          })
          .where(eq(jobs.id, matched.id));
        updated++;
      }
      continue;
    }

    // Unknown to the app — adopt it.
    const id = randomUUID();
    const filename = book.aax?.name ?? book.m4b!.name;
    await db.insert(jobs).values({
      id,
      filename,
      sizeBytes: book.aax?.size ?? book.m4b!.size,
      destinationPath: book.dir,
      status: "COMPLETED",
      origin: "imported",
      archivedAs,
      m4bSizeBytes: book.m4b?.size ?? null,
      createdAt: book.m4b?.modTime ?? book.aax?.modTime ?? now,
      updatedAt: now,
    });
    importEvents.push({
      jobId: id,
      eventType: "imported",
      message: `Adopted from B2 (${archivedAs.toUpperCase()}): ${book.dir}${filename}`,
      timestamp: now,
    });
    imported++;
  }

  if (importEvents.length > 0) {
    await db.insert(jobEvents).values(importEvents);
  }

  const result = {
    scanned: audioFiles.length,
    imported,
    updated,
    aaxCandidates,
  };
  logger.info("[reconcile] Done:", result);
  return result;
}
