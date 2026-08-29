import { spawn } from "node:child_process";
import { and, eq, isNull } from "drizzle-orm";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { db, type Job } from "../db/client.server";
import { jobs } from "../db/schema";
import { m4bPathFor, m4bRemotePathFor } from "./download.server";
import { config } from "./config.server";
import { logger } from "./logger.server";

/**
 * Book metadata extraction. Audible M4Bs carry rich tags (title, artist =
 * author, composer = narrator), chapter markers, and embedded cover art.
 * ffprobe reads them from the moov atom, which +faststart placed at the
 * front of every M4B we produced — so for books already archived, probing
 * the first ~24MB pulled from B2 is enough. Fresh books are probed at
 * decode time while the file is still local.
 */

export interface ProbeResult {
  title: string | null;
  author: string | null;
  narrator: string | null;
  durationSec: number | null;
  chapters: { title: string; startSec: number }[];
}

const REMOTE_PROBE_BYTES = 24 * 1024 * 1024;

export const coversDir = path.join(config.dataDir, "covers");
export const coverPathFor = (jobId: string) => path.join(coversDir, `${jobId}.jpg`);

function run(cmd: string, args: string[], timeoutMs = 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr = (stderr + d.toString()).slice(-2000)));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** `rclone cat --count N` writes to stdout — stream it into a file. */
function catRemoteToFile(target: string, count: number, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("rclone", ["cat", target, "--count", String(count)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 180_000);
    child.stderr.on("data", (d) => (stderr = (stderr + d.toString()).slice(-1000)));

    const write = fsSync.createWriteStream(outPath);
    child.stdout.pipe(write);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      write.end(() => {
        // rclone can exit non-zero when --count reaches past EOF even after
        // writing everything — judge success by bytes actually written.
        const size = fsSync.existsSync(outPath) ? fsSync.statSync(outPath).size : 0;
        if (code === 0 || size > 64 * 1024) resolve();
        else reject(new Error(`rclone cat failed (${code}, ${size}B): ${stderr}`));
      });
    });
  });
}

export async function probeM4bFile(filePath: string): Promise<ProbeResult | null> {
  const { code, stdout } = await run("ffprobe", [
    "-v", "quiet",
    "-print_format", "json",
    "-show_format",
    "-show_chapters",
    filePath,
  ]);
  if (code !== 0) return null;

  try {
    const data = JSON.parse(stdout);
    const tags = data.format?.tags ?? {};
    const chapters = (data.chapters ?? [])
      .map((c: any) => ({
        title: c.tags?.title ?? "",
        startSec: Math.max(0, Math.floor(Number(c.start_time ?? 0))),
      }))
      .filter((c: any) => c.title !== "");
    const duration = Number(data.format?.duration);

    return {
      title: tags.title ?? tags.album ?? null,
      author: tags.artist ?? tags.album_artist ?? null,
      narrator: tags.composer ?? null,
      durationSec: Number.isFinite(duration) ? Math.round(duration) : null,
      chapters,
    };
  } catch {
    return null;
  }
}

/** Extract the embedded cover (attached mjpeg picture) to covers/<id>.jpg. */
export async function extractCover(filePath: string, jobId: string): Promise<boolean> {
  await fs.mkdir(coversDir, { recursive: true });
  const out = coverPathFor(jobId);
  const { code } = await run("ffmpeg", [
    "-nostdin", "-y",
    "-i", filePath,
    "-map", "0:v:0",
    "-frames:v", "1",
    "-c:v", "mjpeg",
    "-q:v", "4",
    out,
  ]);
  if (code !== 0) {
    await fs.rm(out, { force: true }).catch(() => {});
    return false;
  }
  try {
    const stat = await fs.stat(out);
    if (stat.size < 100) throw new Error("empty cover");
    return true;
  } catch {
    await fs.rm(out, { force: true }).catch(() => {});
    return false;
  }
}

async function applyProbe(jobId: string, probe: ProbeResult | null, coverOk: boolean) {
  const now = new Date().toISOString();
  await db
    .update(jobs)
    .set({
      title: probe?.title ?? null,
      author: probe?.author ?? null,
      narrator: probe?.narrator ?? null,
      durationSec: probe?.durationSec ?? null,
      chapters: probe && probe.chapters.length > 0 ? JSON.stringify(probe.chapters) : null,
      coverAt: coverOk ? now : null,
      metaProbedAt: now,
      updatedAt: now,
    })
    .where(eq(jobs.id, jobId));

  const { publishJobUpdate } = await import("./events.server");
  publishJobUpdate(jobId);
}

/** Probe a local M4B (decode time — file complete on disk). */
export async function probeLocalAndApply(jobId: string, filePath: string) {
  try {
    const probe = await probeM4bFile(filePath);
    const coverOk = await extractCover(filePath, jobId);
    await applyProbe(jobId, probe, coverOk);
    logger.info("[metadata.probeLocal] Done:", {
      jobId,
      title: probe?.title,
      chapters: probe?.chapters.length ?? 0,
      coverOk,
    });
  } catch (err) {
    logger.error("[metadata.probeLocal] Failed:", { jobId, error: String(err) });
  }
}

/**
 * Probe a book whose only M4B lives in B2: pull the first chunk (moov +
 * usually the embedded cover) to a temp file, probe it, delete it.
 */
async function probeRemoteAndApply(job: Job) {
  const tmpDir = path.join(config.stagingDir, "_probe");
  await fs.mkdir(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, `${job.id}.partial.m4b`);

  try {
    const target = `${config.rcloneRemote}/${m4bRemotePathFor(job)}`;
    await catRemoteToFile(target, REMOTE_PROBE_BYTES, tmp);

    const probe = await probeM4bFile(tmp);
    const coverOk = await extractCover(tmp, job.id);
    await applyProbe(job.id, probe, coverOk);
    logger.info("[metadata.probeRemote] Done:", {
      jobId: job.id,
      title: probe?.title,
      coverOk,
    });
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

let backfillActive = false;

/**
 * Sequential backfill for archived books with no metadata yet. Kicked at
 * startup and after reconcile; safe to kick repeatedly.
 */
export function kickMetadataBackfill() {
  if (backfillActive) return;
  backfillActive = true;
  backfillLoop()
    .catch((err) => logger.error("[metadata.backfill] Loop crashed:", { error: String(err) }))
    .finally(() => {
      backfillActive = false;
    });
}

async function backfillLoop() {
  for (;;) {
    const [next] = await db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.status, "COMPLETED"),
          eq(jobs.archivedAs, "m4b"),
          isNull(jobs.metaProbedAt),
        ),
      )
      .limit(1);

    if (!next) break;

    try {
      // Prefer a local copy if one still exists (freshly completed).
      const local = m4bPathFor(next);
      const hasLocal = await fs
        .access(local)
        .then(() => true)
        .catch(() => false);

      if (hasLocal) {
        await probeLocalAndApply(next.id, local);
      } else {
        await probeRemoteAndApply(next);
      }
    } catch (err) {
      logger.error("[metadata.backfill] Probe failed:", { jobId: next.id, error: String(err) });
      // Stamp metaProbedAt so we don't spin on this book forever.
      await db
        .update(jobs)
        .set({ metaProbedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
        .where(eq(jobs.id, next.id));
    }
  }
  logger.info("[metadata.backfill] Backfill complete");
}
