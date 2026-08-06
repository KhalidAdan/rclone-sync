import { useState, useCallback, useEffect, useRef } from "react";
import { desc } from "drizzle-orm";
import { db } from "../db/client.server";
import { jobs } from "../db/schema";
import { FileCard, type CardJob } from "../components/FileCard";
import { DropZone } from "../components/DropZone";
import {
  useJobStream,
  type StreamedJob,
  type StatsFrame,
} from "../lib/useJobStream";

export async function loader() {
  const recentJobs = await db
    .select()
    .from(jobs)
    .orderBy(desc(jobs.createdAt))
    .limit(50);

  return { recentJobs };
}

type QueueItem = {
  localId: string;
  file: File;
  status: "pending" | "uploading" | "done" | "error";
  uploadPercent: number;
  jobId?: string;
  error?: string;
};

const ACTIVE_STATUSES = [
  "UPLOADING",
  "STAGED",
  "DECODING",
  "DECODED",
  "QUEUED",
  "ARCHIVING",
  "VERIFYING",
  "RESTORE_QUEUED",
  "RESTORING",
];

function parseJobError(job: StreamedJob): string | undefined {
  if (!job.error) return undefined;
  try {
    return JSON.parse(job.error).message;
  } catch {
    return job.error;
  }
}

export default function Upload({ loaderData }: { loaderData: Awaited<ReturnType<typeof loader>> }) {
  const { recentJobs } = loaderData;

  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [destinationPath, setDestinationPath] = useState("");
  const destinationPathRef = useRef("");

  // Live server state: seeded from the loader, kept fresh by the SSE
  // stream. This is what lets a card follow its book all the way to
  // "Safe in B2" instead of lying "done" at upload-received.
  const [serverJobs, setServerJobs] = useState<Map<string, StreamedJob>>(
    () => new Map(recentJobs.map((j) => [j.id, j as StreamedJob])),
  );
  const [archiveStats, setArchiveStats] = useState<StatsFrame | null>(null);
  // Jobs that transitioned while this page was open: keep their cards
  // around even after they finish or fail, so the story completes on
  // screen instead of the card vanishing mid-watch.
  const seenLiveRef = useRef<Set<string>>(new Set());

  useJobStream({
    onJob: (job) => {
      seenLiveRef.current.add(job.id);
      setServerJobs((prev) => {
        const next = new Map(prev);
        next.set(job.id, job);
        return next;
      });
    },
    onStats: (stats) => setArchiveStats(stats),
  });

  const handleFiles = useCallback((files: File[]) => {
    const newItems: QueueItem[] = files.map((file) => ({
      localId: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      file,
      status: "pending",
      uploadPercent: 0,
    }));
    setQueue((prev) => [...newItems, ...prev]);
  }, []);

  const uploadNext = useCallback(async (currentQueue: QueueItem[]) => {
    const pending = currentQueue.find((item) => item.status === "pending");
    if (!pending) return;

    const xhr = new XMLHttpRequest();
    const formData = new FormData();
    formData.append("file", pending.file);

    const localId = pending.localId;
    setQueue((prev) =>
      prev.map((item) => (item.localId === localId ? { ...item, status: "uploading" } : item))
    );

    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) {
        const percent = Math.round((e.loaded / e.total) * 100);
        setQueue((prev) =>
          prev.map((item) => (item.localId === localId ? { ...item, uploadPercent: percent } : item))
        );
      }
    });

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const { jobId } = JSON.parse(xhr.responseText);
          setQueue((prev) =>
            prev.map((item) =>
              item.localId === localId
                ? { ...item, status: "done", uploadPercent: 100, jobId }
                : item
            )
          );
        } catch {
          setQueue((prev) =>
            prev.map((item) =>
              item.localId === localId ? { ...item, status: "error", error: "Invalid response" } : item
            )
          );
        }
      } else {
        let msg = "Upload failed";
        try {
          const { error } = JSON.parse(xhr.responseText);
          msg = error || msg;
        } catch {
          msg = xhr.statusText || msg;
        }
        setQueue((prev) =>
          prev.map((item) => (item.localId === localId ? { ...item, status: "error", error: msg } : item))
        );
      }
    });

    xhr.addEventListener("error", () => {
      setQueue((prev) =>
        prev.map((item) =>
          item.localId === localId ? { ...item, status: "error", error: "Network error" } : item
        )
      );
    });

    xhr.open("POST", "/api/upload?destinationPath=" + encodeURIComponent(destinationPathRef.current));
    xhr.send(formData);
  }, []);

  // Sequential upload driver: start the next pending upload whenever
  // nothing is currently uploading.
  useEffect(() => {
    if (queue.length === 0) return;
    if (queue.some((item) => item.status === "uploading")) return;
    const pending = queue.find((item) => item.status === "pending");
    if (pending) {
      destinationPathRef.current = destinationPath;
      uploadNext(queue);
    }
  }, [queue, destinationPath, uploadNext]);

  // --- Build the card list: local upload legs merged with server state ---

  const queuedJobIds = new Set(queue.map((q) => q.jobId).filter(Boolean));

  const cardJobs: CardJob[] = queue.map((q) => {
    const server = q.jobId ? serverJobs.get(q.jobId) : undefined;

    if (q.status === "error") {
      return {
        localId: q.localId,
        filename: q.file.name,
        sizeBytes: q.file.size,
        stage: "UPLOAD_FAILED",
        uploadPercent: q.uploadPercent,
        error: q.error,
      };
    }

    if (!server) {
      return {
        localId: q.localId,
        filename: q.file.name,
        sizeBytes: q.file.size,
        stage: q.status === "uploading" ? "UPLOADING" : q.status === "done" ? "STAGED" : "PENDING",
        uploadPercent: q.uploadPercent,
      };
    }

    return {
      localId: q.localId,
      filename: server.filename,
      sizeBytes: server.sizeBytes || q.file.size,
      stage: server.status,
      uploadPercent: 100,
      archivePercent:
        server.status === "ARCHIVING" &&
        archiveStats?.jobId === server.id &&
        archiveStats.totalBytes > 0
          ? (archiveStats.bytesTransferred / archiveStats.totalBytes) * 100
          : undefined,
      error: parseJobError(server),
    };
  });

  // Server jobs still in flight that this tab isn't already showing —
  // uploads from before a refresh, or another device. The pipeline
  // shouldn't disappear just because the page reloaded.
  const orphanCards: CardJob[] = [...serverJobs.values()]
    .filter(
      (j) =>
        (ACTIVE_STATUSES.includes(j.status) || seenLiveRef.current.has(j.id)) &&
        !queuedJobIds.has(j.id),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((j) => ({
      localId: j.id,
      filename: j.filename,
      sizeBytes: j.sizeBytes,
      stage: j.status,
      uploadPercent: 100,
      archivePercent:
        j.status === "ARCHIVING" &&
        archiveStats?.jobId === j.id &&
        archiveStats.totalBytes > 0
          ? (archiveStats.bytesTransferred / archiveStats.totalBytes) * 100
          : undefined,
      error: parseJobError(j),
    }));

  const allCards = [...cardJobs, ...orphanCards];

  const doneCount = allCards.filter((c) => c.stage === "COMPLETED").length;
  const failedCount = allCards.filter((c) => c.stage.endsWith("_FAILED")).length;
  const activeCount = allCards.length - doneCount - failedCount;

  const isUploading = queue.some((q) => q.status === "uploading");

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", fontFamily: "var(--font-sans)" }}>
      <div style={{ maxWidth: 960, margin: "0 auto", padding: "48px 24px" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 24 }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 600, color: "var(--text-primary)", letterSpacing: "-0.02em" }}>
              Audiobook Archive
            </h1>
            <p style={{ fontSize: 13, color: "var(--text-tertiary)", marginTop: 4 }}>
              Drop files below — they're safe once the ring closes
            </p>
          </div>
          <div style={{ display: "flex", gap: 16, fontSize: 12 }}>
            {activeCount > 0 && (
              <span style={{ color: "var(--ring-active)" }}>
                {activeCount} in flight
              </span>
            )}
            <span style={{ color: "var(--ring-done)" }}>
              {doneCount} safe
            </span>
            {failedCount > 0 && (
              <span style={{ color: "var(--ring-fail)" }}>
                {failedCount} failed
              </span>
            )}
          </div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <input
            type="text"
            placeholder="Destination folder (e.g. Fiction/Fantasy)"
            value={destinationPath}
            onChange={(e) => setDestinationPath(e.target.value)}
            disabled={isUploading}
            style={{
              width: "100%",
              padding: "10px 14px",
              borderRadius: 10,
              border: "1.5px solid var(--border-idle)",
              fontSize: 14,
              outline: "none",
              transition: "border-color 200ms",
              background: "var(--card-bg)",
              color: "var(--text-primary)",
            }}
          />
        </div>

        <DropZone onFiles={handleFiles} />

        {allCards.length > 0 && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
              gap: 12,
              marginTop: 24,
            }}
          >
            {allCards.map((job) => (
              <FileCard key={job.localId} job={job} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
