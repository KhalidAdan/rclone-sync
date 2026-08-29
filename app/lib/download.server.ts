import { fromReadableStream, toReadableStream } from "@culvert/stream";
import { createZip } from "@culvert/zip";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { spawn } from "node:child_process";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import { db, type Job } from "../db/client.server";
import { jobs } from "../db/schema";
import { config } from "./config.server";
import { listFiles } from "./rclone.server";
import { m4bNameOf } from "./types";
import { logger } from "./logger.server";

export const m4bNameFor = (job: Job) => m4bNameOf(job.filename);
export const m4bPathFor = (job: Job) =>
  path.join(config.stagingDir, job.id, m4bNameFor(job));

/** Remote path of the archived M4B, relative to the crypt remote root. */
export const m4bRemotePathFor = (job: Job) =>
  `${job.destinationPath}${m4bNameFor(job)}`;

async function localM4bSize(job: Job): Promise<number | null> {
  try {
    const stat = await fs.stat(m4bPathFor(job));
    return stat.size;
  } catch {
    return null;
  }
}

/**
 * Stream bytes of a file on the crypt remote by spawning `rclone cat`.
 * Range semantics via --offset/--count; the process is killed when the
 * consumer goes away. One spawn per request is fine for a single-user app —
 * the alternative (rclone rcd --rc-serve) needs daemon flags we can't
 * assume.
 */
function streamRemoteM4b(
  job: Job,
  offset: number,
  count: number | null,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const target = `${config.rcloneRemote}/${m4bRemotePathFor(job)}`;
  const args = ["cat", target];
  if (offset > 0) args.push("--offset", String(offset));
  if (count !== null) args.push("--count", String(count));

  logger.info("[download.streamRemoteM4b] Spawning:", { jobId: job.id, offset, count });
  const child = spawn("rclone", args, { stdio: ["ignore", "pipe", "pipe"] });

  let stderrTail = "";
  child.stderr.on("data", (d) => {
    stderrTail = (stderrTail + d.toString()).slice(-1000);
  });
  child.on("close", (code) => {
    if (code !== 0 && !signal.aborted) {
      logger.error("[download.streamRemoteM4b] rclone cat exited non-zero:", {
        jobId: job.id,
        code,
        stderr: stderrTail,
      });
    }
  });

  signal.addEventListener("abort", () => child.kill());

  return Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
}

/**
 * Exact M4B size, needed for Content-Length/Range. Usually already on the
 * row (set at decode or reconcile); fetched from the remote listing and
 * cached back onto the row for older entries.
 */
async function ensureM4bSize(job: Job): Promise<number | null> {
  if (job.m4bSizeBytes) return job.m4bSizeBytes;

  try {
    const dir = job.destinationPath.replace(/\/+$/, "");
    const { list } = await listFiles(config.rcloneRemote, dir);
    const entry = list.find((e) => !e.IsDir && e.Name === m4bNameFor(job));
    if (!entry) return null;
    await db
      .update(jobs)
      .set({ m4bSizeBytes: entry.Size, updatedAt: new Date().toISOString() })
      .where(eq(jobs.id, job.id));
    return entry.Size;
  } catch (err) {
    logger.error("[download.ensureM4bSize] Lookup failed:", { jobId: job.id, error: String(err) });
    return null;
  }
}

function hasRemoteM4b(job: Job): boolean {
  return job.archivedAs === "m4b";
}

/**
 * Serve a job's M4B with full HTTP Range support, preferring the local
 * staging copy (pre-completion) and falling back to the crypt remote.
 * `disposition: "inline"` streams for the player; `"attachment"` downloads.
 */
export async function serveM4b(
  job: Job,
  request: Request,
  disposition: "inline" | "attachment",
): Promise<Response> {
  const localSize = await localM4bSize(job);
  const remote = localSize === null;

  let totalSize: number | null = localSize;
  if (remote) {
    if (!hasRemoteM4b(job)) {
      return Response.json(
        { error: "No M4B available for this book yet" },
        { status: 404 },
      );
    }
    totalSize = await ensureM4bSize(job);
    if (totalSize === null) {
      return Response.json(
        { error: "M4B not found in archive — try Sync with B2" },
        { status: 404 },
      );
    }
  }

  // Single-range parsing: "bytes=start-end", "bytes=start-", "bytes=-suffix"
  const rangeHeader = request.headers.get("Range");
  let start = 0;
  let end = totalSize! - 1;
  let isPartial = false;

  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (!match || (match[1] === "" && match[2] === "")) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${totalSize}` },
      });
    }
    if (match[1] === "") {
      start = Math.max(0, totalSize! - Number(match[2]));
    } else {
      start = Number(match[1]);
      if (match[2] !== "") end = Math.min(Number(match[2]), totalSize! - 1);
    }
    if (start > end || start >= totalSize!) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${totalSize}` },
      });
    }
    isPartial = true;
  }

  const count = end - start + 1;
  const body = remote
    ? streamRemoteM4b(job, start, isPartial ? count : null, request.signal)
    : (Readable.toWeb(
        fsSync.createReadStream(m4bPathFor(job), { start, end }),
      ) as ReadableStream<Uint8Array>);

  const filename = m4bNameFor(job).replaceAll('"', "");
  const headers: Record<string, string> = {
    "Content-Type": "audio/mp4",
    "Accept-Ranges": "bytes",
    "Content-Length": String(count),
    "Content-Disposition": `${disposition}; filename="${filename}"`,
    "Cache-Control": "no-store",
  };
  if (isPartial) {
    headers["Content-Range"] = `bytes ${start}-${end}/${totalSize}`;
  }

  return new Response(body, { status: isPartial ? 206 : 200, headers });
}

// ---------------------------------------------------------------------------
// Bulk ZIP export — de-scoped escape hatch, no longer a primary flow.
// Sources each M4B from local staging when present, otherwise from B2.
// ---------------------------------------------------------------------------

const READY_STATUSES = [
  "DECODED",
  "QUEUED",
  "ARCHIVING",
  "VERIFYING",
  "COMPLETED",
] as const;

export async function findDownloadableJobs(): Promise<Job[]> {
  const candidates = await db
    .select()
    .from(jobs)
    .where(
      and(
        isNull(jobs.downloadedAt),
        or(...READY_STATUSES.map((s) => eq(jobs.status, s))),
      ),
    );

  const valid: Job[] = [];
  for (const job of candidates) {
    if ((await localM4bSize(job)) !== null || hasRemoteM4b(job)) {
      valid.push(job);
    }
  }
  return valid;
}

async function* onSuccessfulDrain<T>(
  source: AsyncIterable<T>,
  onComplete: () => Promise<void>,
): AsyncIterable<T> {
  yield* source;
  await onComplete();
}

export function zipDownloadResponse(
  validJobs: Job[],
  signal: AbortSignal,
): Response {
  const zip = createZip(async (archive) => {
    for (const job of validJobs) {
      const localSize = await localM4bSize(job);
      const source =
        localSize !== null
          ? fromReadableStream(
              Readable.toWeb(
                fsSync.createReadStream(m4bPathFor(job)),
              ) as ReadableStream<Uint8Array>,
            )
          : fromReadableStream(streamRemoteM4b(job, 0, null, signal));

      await archive.addFile({
        name: m4bNameFor(job),
        compression: "store",
        source,
      });
    }
  });

  // Mark downloaded only after the client drains the full archive.
  // (Retention no longer hangs off this — B2 is the source of truth.)
  const finalSource = onSuccessfulDrain(zip, async () => {
    const now = new Date().toISOString();
    await db
      .update(jobs)
      .set({ downloadedAt: now, updatedAt: now })
      .where(inArray(jobs.id, validJobs.map((j) => j.id)));
    logger.info("[download.zipDownloadResponse] Marked downloaded:", {
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
