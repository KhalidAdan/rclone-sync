import { and, asc, eq, or } from "drizzle-orm";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { db, type Job } from "../db/client.server";
import { jobs } from "../db/schema";
import { logJobEvent } from "./jobEvents.server";
import { copyFile, getJobStatus } from "./rclone.server";
import { verifyArchive, finishVerification } from "./jobWatcher.server";
import { processJob } from "./pipeline.server";
import { config } from "./config.server";
import { logger } from "./logger.server";

/**
 * Legacy AAX -> M4B migration. Books archived before the M4B-only decision
 * exist in B2 as AAX. Migration pulls the AAX back into staging
 * (RESTORING), then re-enters the normal pipeline: decode -> archive M4B ->
 * verify -> COMPLETED. finishVerification sees `archivedAs === "aax"` and
 * deletes the legacy remote AAX only after the M4B is verified present and
 * passes a size sanity check.
 *
 * One book restores at a time (bounded disk/bandwidth); the decode/archive
 * stages overlap with the next restore naturally via the existing queue.
 * Everything is resumable: state lives in the jobs table, and a book whose
 * M4B already reached B2 skips straight to verification + AAX cleanup.
 */

const RESTORE_POLL_MS = 5_000;
const MAX_RESTORE_POLL_ERRORS = 30;

export async function enqueueMigration(jobId: string): Promise<boolean> {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job) return false;

  const eligible =
    (job.status === "COMPLETED" && job.archivedAs === "aax") ||
    job.status === "RESTORE_FAILED";
  if (!eligible) {
    logger.warn("[migration.enqueue] Job not eligible:", { jobId, status: job.status, archivedAs: job.archivedAs });
    return false;
  }

  await db
    .update(jobs)
    .set({ status: "RESTORE_QUEUED", error: null, updatedAt: new Date().toISOString() })
    .where(eq(jobs.id, jobId));
  await logJobEvent(jobId, "restoring", "Queued for AAX → M4B migration");
  kickMigrationRunner();
  return true;
}

export async function enqueueAllMigrations(): Promise<number> {
  // Fresh candidates AND previously failed restores — "migrate all"
  // should always mean "get everything to M4B", including retries.
  const candidates = await db
    .select()
    .from(jobs)
    .where(
      or(
        and(eq(jobs.status, "COMPLETED"), eq(jobs.archivedAs, "aax")),
        eq(jobs.status, "RESTORE_FAILED"),
      ),
    );

  let queued = 0;
  const now = new Date().toISOString();
  for (const job of candidates) {
    await db
      .update(jobs)
      .set({ status: "RESTORE_QUEUED", error: null, updatedAt: now })
      .where(eq(jobs.id, job.id));
    await logJobEvent(job.id, "restoring", "Queued for AAX → M4B migration");
    queued++;
  }
  if (queued > 0) kickMigrationRunner();
  return queued;
}

let runnerActive = false;

/** Start the sequential migration worker if it isn't already running. */
export function kickMigrationRunner() {
  if (runnerActive) return;
  runnerActive = true;
  runLoop()
    .catch((err) => logger.error("[migration.runner] Loop crashed:", { error: String(err) }))
    .finally(() => {
      runnerActive = false;
    });
}

async function runLoop() {
  for (;;) {
    const [next] = await db
      .select()
      .from(jobs)
      .where(eq(jobs.status, "RESTORE_QUEUED"))
      .orderBy(asc(jobs.updatedAt))
      .limit(1);

    if (!next) break;

    const outcome = await migrateOne(next);
    if (outcome === "halt") {
      logger.warn(
        "[migration.runner] Halting queue on systemic error — remaining books stay RESTORE_QUEUED. " +
          "Fix the cause (B2 cap / rclone auth) and press Migrate again.",
      );
      break;
    }
  }
}

/**
 * Errors that will hit every book identically (B2 download cap, bad rclone
 * credentials, daemon down). Failing one book on these is misleading and
 * failing 200 is a stampede — the queue should pause instead.
 */
function isSystemicError(message: string): boolean {
  return /cap exceeded|download_cap|unauthorized|\b401\b|\b403\b|lost contact with rclone/i.test(
    message,
  );
}

async function migrateOne(job: Job): Promise<"continue" | "halt"> {
  logger.info("[migration.migrateOne] Starting:", { jobId: job.id, filename: job.filename });

  try {
    // Resume shortcut: if a previous run already pushed the M4B, don't
    // restore/decode again — verify and clean up the legacy AAX.
    const existing = await verifyArchive(job.id);
    if (existing) {
      logger.info("[migration.migrateOne] M4B already in remote, finishing:", { jobId: job.id });
      await db
        .update(jobs)
        .set({ status: "VERIFYING", updatedAt: new Date().toISOString() })
        .where(eq(jobs.id, job.id));
      await finishVerification(job.id);
      return "continue";
    }

    await db
      .update(jobs)
      .set({ status: "RESTORING", updatedAt: new Date().toISOString() })
      .where(eq(jobs.id, job.id));
    await logJobEvent(job.id, "restoring", `Restoring ${job.filename} from B2...`);

    const stagingDir = path.join(config.stagingDir, job.id);
    await fs.mkdir(stagingDir, { recursive: true });

    const { jobid } = await copyFile(
      config.rcloneRemote,
      `${job.destinationPath}${job.filename}`,
      stagingDir + path.sep,
      job.filename,
    );

    await waitForRcloneJob(jobid);
    logger.info("[migration.migrateOne] Restore complete, entering pipeline:", { jobId: job.id });

    // Normal pipeline from here: decode -> archive M4B -> verify. The
    // archive queue serializes uploads; the next restore may overlap.
    await processJob(job.id);
    return "continue";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[migration.migrateOne] Failed:", { jobId: job.id, error: message });

    if (isSystemicError(message)) {
      // Not this book's fault — put it back in the queue and pause the
      // whole run rather than failing every remaining book the same way.
      await db
        .update(jobs)
        .set({ status: "RESTORE_QUEUED", updatedAt: new Date().toISOString() })
        .where(eq(jobs.id, job.id));
      await logJobEvent(
        job.id,
        "restoring",
        `Migration paused (systemic error, will retry): ${message}`,
      );
      return "halt";
    }

    await db
      .update(jobs)
      .set({
        status: "RESTORE_FAILED",
        error: JSON.stringify({ phase: "RESTORING", message }),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(jobs.id, job.id));
    await logJobEvent(job.id, "failed", `Restore failed: ${message}`);
    return "continue";
  }
}

async function waitForRcloneJob(jobid: number): Promise<void> {
  let consecutiveErrors = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, RESTORE_POLL_MS));

    let status;
    try {
      status = await getJobStatus(jobid);
      consecutiveErrors = 0;
    } catch (err) {
      // Transient rclone unreachability — tolerate for a while.
      consecutiveErrors++;
      if (consecutiveErrors >= MAX_RESTORE_POLL_ERRORS) {
        throw new Error(`Lost contact with rclone during restore: ${String(err)}`);
      }
      continue;
    }

    if (status.finished) {
      if (status.success) return;
      throw new Error(status.error || "rclone copy failed");
    }
  }
}
