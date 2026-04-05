import { useEffect, useState, useCallback, useRef } from "react";
import { useRevalidator } from "react-router";
import { desc } from "drizzle-orm";
import { db } from "../db/client.server";
import { jobs } from "../db/schema";
import { config } from "../lib/config.server";
import { FileCard, type CardJob } from "../components/FileCard";
import { DropZone } from "../components/DropZone";

export async function loader() {
  const recentJobs = await db
    .select()
    .from(jobs)
    .orderBy(desc(jobs.createdAt))
    .limit(50);

  return { recentJobs, refreshInterval: config.uiRefreshIntervalSec };
}

type QueueItem = {
  localId: string;
  file: File;
  status: "pending" | "uploading" | "done" | "error";
  uploadPercent: number;
  jobId?: string;
  error?: string;
};

export default function Upload({ loaderData }: { loaderData: Awaited<ReturnType<typeof loader>> }) {
  const { recentJobs, refreshInterval } = loaderData;
  const revalidator = useRevalidator();

  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [destinationPath, setDestinationPath] = useState("");
  const destinationPathRef = useRef("");

  const hasActiveJob = recentJobs.some((j) =>
    ["UPLOADING", "STAGED", "QUEUED", "ARCHIVING", "VERIFYING"].includes(j.status)
  );

  useEffect(() => {
    if (!hasActiveJob) return;
    const interval = setInterval(() => revalidator.revalidate(), refreshInterval * 1000);
    return () => clearInterval(interval);
  }, [hasActiveJob, refreshInterval, revalidator]);

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
    formData.append("destinationPath", destinationPathRef.current);

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
              item.localId === localId ? { ...item, status: "done", jobId } : item
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

    xhr.open("POST", "/api/upload");
    xhr.send(formData);
  }, []);

  useEffect(() => {
    if (queue.length === 0) return;
    const uploading = queue.find((item) => item.status === "uploading");
    if (uploading) return;
    const pending = queue.find((item) => item.status === "pending");
    if (pending) {
      destinationPathRef.current = destinationPath;
      uploadNext(queue);
    }
  }, [queue, destinationPath, uploadNext]);

  const completedCount = queue.filter((q) => q.status === "done").length;
  const failedCount = queue.filter((q) => q.status === "error").length;
  const activeCount = queue.filter((q) => q.status === "pending" || q.status === "uploading").length;

  const serverJobMap = new Map(recentJobs.map((j) => [j.id, j]));

  const mergedJobs: CardJob[] = queue
    .filter((q) => q.status !== "done")
    .map((q) => ({
      localId: q.localId,
      filename: q.file.name,
      sizeBytes: q.file.size,
      stage: q.status === "uploading" ? "UPLOADING" : q.status === "error" ? "UPLOAD_FAILED" : "PENDING",
      uploadPercent: q.uploadPercent,
      error: q.error,
    }));

  queue
    .filter((q) => q.status === "done" && q.jobId)
    .forEach((q) => {
      const serverJob = serverJobMap.get(q.jobId!);
      mergedJobs.push({
        localId: q.localId,
        filename: q.file.name,
        sizeBytes: q.file.size,
        stage: serverJob?.status || "STAGED",
        uploadPercent: 100,
      });
    });

  recentJobs.forEach((j) => {
    const inQueue = queue.some((q) => q.jobId === j.id);
    if (!inQueue) {
      mergedJobs.push({
        localId: j.id,
        filename: j.filename,
        sizeBytes: j.sizeBytes,
        stage: j.status,
        uploadPercent: 100,
      });
    }
  });

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
              Upload → Stage → Archive → Verify
            </p>
          </div>
          <div style={{ display: "flex", gap: 16, fontSize: 12 }}>
            {activeCount > 0 && (
              <span style={{ color: "var(--ring-active)" }}>
                {activeCount} active
              </span>
            )}
            <span style={{ color: "var(--ring-done)" }}>
              {completedCount} done
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
            placeholder="Destination path (e.g., Fiction/Fantasy/)"
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

        {mergedJobs.length > 0 && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
              gap: 12,
              marginTop: 24,
            }}
          >
            {mergedJobs.map((job) => (
              <FileCard key={job.localId} job={job} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
