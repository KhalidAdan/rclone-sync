import { channel, type Source } from "@culvert/stream";
import { eq } from "drizzle-orm";
import { db, type Job } from "../db/client.server";
import { jobs } from "../db/schema";
import { getStats } from "./rclone.server";
import { logger } from "./logger.server";

/**
 * Server-push events for the UI. One SSE connection per browser tab; the
 * pipeline publishes on every job transition (via the logJobEvent choke
 * point) and a lazy ticker streams rclone transfer stats while an archive
 * is running.
 */
export type JobPushEvent =
  | { type: "job"; job: Job }
  | {
      type: "stats";
      jobId: string;
      bytesTransferred: number;
      totalBytes: number;
      speed: number;
      eta: number;
    }
  | { type: "ping" };

type Subscriber = { push: (e: JobPushEvent) => void };

const subscribers = new Set<Subscriber>();

/**
 * A culvert channel() bridges the imperative publish side to a pull-based
 * Source the SSE route can pipe into the Response. channel() holds at most
 * one value in flight, so each subscriber serializes its writes on a
 * promise chain — a slow consumer backs up its own chain, never the
 * publisher or other subscribers.
 */
export function subscribeToJobEvents(signal: AbortSignal): Source<JobPushEvent> {
  const [writer, source] = channel<JobPushEvent>();
  let chain: Promise<void> = Promise.resolve();
  let closed = false;

  const sub: Subscriber = {
    push(e) {
      if (closed) return;
      chain = chain.then(() => writer.write(e)).catch(() => {});
    },
  };

  subscribers.add(sub);
  ensureTicker();
  logger.debug("[events.subscribe] Subscriber added", { count: subscribers.size });

  signal.addEventListener("abort", () => {
    closed = true;
    subscribers.delete(sub);
    chain.then(() => writer.close()).catch(() => {});
    logger.debug("[events.subscribe] Subscriber removed", { count: subscribers.size });
  });

  return source;
}

function broadcast(e: JobPushEvent) {
  for (const sub of subscribers) sub.push(e);
}

/** Push the current row for a job to every connected client. */
export async function publishJobUpdate(jobId: string) {
  if (subscribers.size === 0) return;
  try {
    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    if (job) broadcast({ type: "job", job });
  } catch (err) {
    logger.error("[events.publishJobUpdate] Failed:", { jobId, error: String(err) });
  }
}

// ---------------------------------------------------------------------------
// Stats ticker — runs only while there are subscribers. Every tick it looks
// for the active archive and pushes scoped rclone transfer stats; every
// third tick it pushes a heartbeat so proxies keep the SSE socket open.
// ---------------------------------------------------------------------------

const TICK_MS = 2_000;
let tickerRunning = false;

function ensureTicker() {
  if (tickerRunning) return;
  tickerRunning = true;

  let tickCount = 0;
  const tick = async () => {
    if (subscribers.size === 0) {
      tickerRunning = false;
      return;
    }

    try {
      const [archiving] = await db
        .select()
        .from(jobs)
        .where(eq(jobs.status, "ARCHIVING"))
        .limit(1);

      if (archiving?.rcloneJobId) {
        const stats = await getStats(`job/${archiving.rcloneJobId}`);
        broadcast({
          type: "stats",
          jobId: archiving.id,
          bytesTransferred: stats.bytes,
          totalBytes: archiving.sizeBytes,
          speed: stats.speed,
          eta: stats.eta,
        });
      }
    } catch {
      // rclone unreachable — job-level errors are handled by the watcher.
    }

    if (++tickCount % 3 === 0) broadcast({ type: "ping" });
    setTimeout(tick, TICK_MS);
  };

  setTimeout(tick, TICK_MS);
}
