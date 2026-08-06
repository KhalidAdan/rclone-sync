import { db } from "../db/client.server";
import { jobEvents } from "../db/schema";
import type { JobEventType } from "./types";

export async function logJobEvent(
  jobId: string,
  eventType: JobEventType,
  message: string,
) {
  await db.insert(jobEvents).values({
    jobId,
    eventType,
    message,
    timestamp: new Date().toISOString(),
  });
}
