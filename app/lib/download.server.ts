import { fromReadableStream, toReadableStream } from "@culvert/stream";
import { createZip } from "@culvert/zip";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import { db, type Job } from "../db/client.server";
import { jobs } from "../db/schema";
import { config } from "./config.server";
import { cleanupFull } from "./jobWatcher.server";
import { logger } from "./logger.server";

/** Statuses whose M4B has been decoded and is (still) present in staging. */
const READY_STATUSES = [
  "DECODED",
  "QUEUED",
  "ARCHIVING",
  "VERIFYING",
  "COMPLETED",
] as const;

export const m4bNameFor = (job: Job) => job.filename.replace(/\.aax$/i, ".m4b");
export const m4bPathFor = (job: Job) =>
  path.join(config.stagingDir, job.id, m4bNameFor(job));

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Jobs whose M4B is ready and not yet downloaded — optionally restricted to
 * specific ids — filtered to those whose M4B actually exists on disk.
 */
export async function findDownloadableJobs(ids?: string[]): Promise<Job[]> {
  const conditions = [
    isNull(jobs.downloadedAt),
    or(...READY_STATUSES.map((s) => eq(jobs.status, s))),
  ];
  if (ids && ids.length > 0) {
    conditions.push(inArray(jobs.id, ids));
  }

  const candidates = await db
    .select()
    .from(jobs)
    .where(and(...conditions));

  const valid: Job[] = [];
  for (const job of candidates) {
    if (await exists(m4bPathFor(job))) {
      valid.push(job);
    } else {
      logger.warn("[download.findDownloadableJobs] M4B not found, skipping:", {
        jobId: job.id,
        m4bPath: m4bPathFor(job),
      });
    }
  }
  return valid;
}

/**
 * Yield from `source`, then run `onComplete`. Critically, onComplete fires
 * *only* on natural completion. If the consumer terminates early (client
 * disconnect) or the source errors, the yield* throws and onComplete is
 * skipped. This is the right semantic for "mark as downloaded only if the
 * client actually got the whole archive."
 */
async function* onSuccessfulDrain<T>(
  source: AsyncIterable<T>,
  onComplete: () => Promise<void>,
): AsyncIterable<T> {
  yield* source;
  await onComplete();
}

/**
 * Stream a ZIP of the jobs' M4Bs. Entries are stored, not deflated — M4B
 * audio is already compressed. Jobs are marked downloaded (and completed
 * jobs cleaned up) only after the client drains the full archive.
 */
export function zipDownloadResponse(validJobs: Job[]): Response {
  const zip = createZip(async (archive) => {
    for (const job of validJobs) {
      await archive.addFile({
        name: m4bNameFor(job),
        compression: "store",
        source: fromReadableStream(
          Readable.toWeb(
            fsSync.createReadStream(m4bPathFor(job)),
          ) as ReadableStream<Uint8Array>,
        ),
      });
    }
  });

  const finalSource = onSuccessfulDrain(zip, async () => {
    const now = new Date().toISOString();
    await db
      .update(jobs)
      .set({ downloadedAt: now, updatedAt: now })
      .where(inArray(jobs.id, validJobs.map((j) => j.id)));

    for (const job of validJobs) {
      if (job.status === "COMPLETED") {
        await cleanupFull(job.id);
      }
    }
    logger.info("[download.zipDownloadResponse] Marked downloaded and cleaned up:", {
      count: validJobs.length,
    });
  });

  const dateStr = new Intl.DateTimeFormat("en-CA").format(new Date());

  return new Response(toReadableStream(finalSource), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="audiobooks-${dateStr}.zip"`,
    },
  });
}
