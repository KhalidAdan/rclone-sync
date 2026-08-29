import { useEffect, useRef } from "react";

/** Serialized job row as it arrives over the SSE stream / loaders. */
export interface StreamedJob {
  id: string;
  filename: string;
  sizeBytes: number;
  destinationPath: string;
  status: string;
  rcloneJobId: number | null;
  error: string | null;
  retryCount: number;
  downloadedAt: string | null;
  origin: string;
  archivedAs: string | null;
  m4bSizeBytes: number | null;
  title: string | null;
  author: string | null;
  narrator: string | null;
  durationSec: number | null;
  chapters: string | null;
  coverAt: string | null;
  metaProbedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Chapter {
  title: string;
  startSec: number;
}

export function parseChapters(job: Pick<StreamedJob, "chapters">): Chapter[] {
  if (!job.chapters) return [];
  try {
    const parsed = JSON.parse(job.chapters);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Display title: embedded metadata, else the filename cleaned up. */
export function bookTitle(job: Pick<StreamedJob, "title" | "filename">): string {
  return job.title || job.filename.replace(/\.(aax|m4b)$/i, "");
}

export function formatDuration(sec: number | null | undefined): string {
  if (!sec || sec <= 0) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export interface StatsFrame {
  jobId: string;
  bytesTransferred: number;
  totalBytes: number;
  speed: number;
  eta: number;
}

interface JobStreamHandlers {
  onJob?: (job: StreamedJob) => void;
  onStats?: (stats: StatsFrame) => void;
}

/**
 * Subscribe to /api/events for the lifetime of the component. Handlers are
 * kept in a ref so consumers can pass fresh closures without resubscribing.
 * EventSource auto-reconnects on drops (server sends `retry: 3000`).
 */
export function useJobStream(handlers: JobStreamHandlers) {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data);
        if (event.type === "job") ref.current.onJob?.(event.job);
        else if (event.type === "stats") ref.current.onStats?.(event);
      } catch {
        // malformed frame — ignore
      }
    };
    return () => es.close();
  }, []);
}
