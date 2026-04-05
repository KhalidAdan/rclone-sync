import { desc, eq } from "drizzle-orm";
import { useEffect } from "react";
import { Form, useRevalidator } from "react-router";
import { JobHistory } from "../components/JobHistory";
import { db } from "../db/client.server";
import { jobs } from "../db/schema";
import { config } from "../lib/config.server";
import { getStats } from "../lib/rclone.server";
import type { Route } from "./+types/_layout.jobs";

type StatusMeta = {
  label: string;
  badgeClass: string;
  borderClass: string;
  pulse?: boolean;
};

const statusMeta: Record<string, StatusMeta> = {
  UPLOADING:     { label: "Uploading",      badgeClass: "bg-blue-100 text-blue-700",   borderClass: "border-l-blue-400" },
  STAGED:        { label: "Staged",         badgeClass: "bg-yellow-100 text-yellow-700", borderClass: "border-l-yellow-400" },
  QUEUED:        { label: "Queued",         badgeClass: "bg-orange-100 text-orange-700", borderClass: "border-l-orange-400" },
  ARCHIVING:     { label: "Archiving",      badgeClass: "bg-purple-100 text-purple-700", borderClass: "border-l-purple-500", pulse: true },
  VERIFYING:     { label: "Verifying",      badgeClass: "bg-indigo-100 text-indigo-700", borderClass: "border-l-indigo-400", pulse: true },
  COMPLETED:     { label: "Completed",      badgeClass: "bg-green-100 text-green-700",  borderClass: "border-l-green-500" },
  UPLOAD_FAILED: { label: "Upload failed",  badgeClass: "bg-red-100 text-red-700",     borderClass: "border-l-red-500" },
  ARCHIVE_FAILED:{ label: "Archive failed", badgeClass: "bg-red-100 text-red-700",     borderClass: "border-l-red-500" },
  VERIFY_FAILED: { label: "Verify failed",  badgeClass: "bg-red-100 text-red-700",     borderClass: "border-l-red-500" },
  ABANDONED:     { label: "Abandoned",      badgeClass: "bg-gray-100 text-gray-500",   borderClass: "border-l-gray-300" },
};

const fallbackMeta: StatusMeta = {
  label: "Unknown",
  badgeClass: "bg-gray-100 text-gray-500",
  borderClass: "border-l-gray-300",
};

export async function loader() {
  const allJobs = await db.query.jobs.findMany({
    with: { events: true },
    orderBy: [desc(jobs.updatedAt)],
  });

  const archiving = allJobs.find((j) => j.status === "ARCHIVING");
  let liveProgress = null;

  if (archiving) {
    try {
      const stats = await getStats();
      liveProgress = {
        jobId: archiving.id,
        bytesTransferred: stats.bytes ?? 0,
        totalBytes: archiving.sizeBytes,
        speed: stats.speed ?? 0,
        eta: stats.eta ?? 0,
        percentage:
          archiving.sizeBytes > 0
            ? Math.min(100, Math.round(((stats.bytes ?? 0) / archiving.sizeBytes) * 100))
            : 0,
      };
    } catch {
      // rclone might be down
    }
  }

  return {
    jobs: allJobs,
    liveProgress,
    refreshInterval: config.uiRefreshIntervalSec,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData();
  const intent = formData.get("intent");
  const jobId = formData.get("jobId") as string;

  if (intent === "retry") {
    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    if (job) {
      await db
        .update(jobs)
        .set({ status: "STAGED", retryCount: job.retryCount + 1, error: null, updatedAt: new Date().toISOString() })
        .where(eq(jobs.id, jobId));
      const { startOrQueueArchive } = await import("../lib/archiver.server");
      await startOrQueueArchive(jobId);
    }
  }

  if (intent === "abandon") {
    await db
      .update(jobs)
      .set({ status: "ABANDONED", updatedAt: new Date().toISOString() })
      .where(eq(jobs.id, jobId));
  }

  return { success: true };
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatSpeed(bps: number) {
  if (bps < 1024) return `${bps.toFixed(0)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / 1024 / 1024).toFixed(1)} MB/s`;
}

function formatEta(seconds: number) {
  if (!seconds || seconds < 0) return "--";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`;
}

export default function Jobs({ loaderData }: Route.ComponentProps) {
  const { jobs: allJobs, liveProgress, refreshInterval } = loaderData;
  const revalidator = useRevalidator();

  const hasActiveJob = allJobs.some((j) =>
    ["UPLOADING", "STAGED", "QUEUED", "ARCHIVING", "VERIFYING"].includes(j.status)
  );

  useEffect(() => {
    if (!hasActiveJob) return;
    const interval = setInterval(() => revalidator.revalidate(), refreshInterval * 1000);
    return () => clearInterval(interval);
  }, [hasActiveJob, refreshInterval, revalidator]);

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">Jobs</h1>
        {hasActiveJob && (
          <span className="inline-flex items-center gap-1.5 text-xs text-gray-500">
            <span className="relative flex size-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-75" />
              <span className="relative inline-flex size-2 rounded-full bg-purple-500" />
            </span>
            Live
          </span>
        )}
      </div>

      {liveProgress && (
        <div className="rounded-xl border border-purple-200 bg-purple-50 p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-medium text-purple-900">Archiving in progress</p>
            <p className="text-xs text-purple-600 tabular-nums">
              {formatBytes(liveProgress.bytesTransferred)} / {formatBytes(liveProgress.totalBytes)}
              {" · "}
              {formatSpeed(liveProgress.speed)}
              {" · "}
              ETA {formatEta(liveProgress.eta)}
            </p>
          </div>
          <div className="h-1.5 w-full rounded-full bg-purple-200">
            <div
              className="h-1.5 rounded-full bg-purple-600 transition-all duration-700"
              style={{ width: `${liveProgress.percentage}%` }}
            />
          </div>
          <p className="mt-1.5 text-right text-xs text-purple-500">{liveProgress.percentage}%</p>
        </div>
      )}

      {allJobs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 py-12 text-center">
          <p className="text-sm text-gray-400">No jobs yet. Upload a file to get started.</p>
        </div>
      ) : (
        <ul role="list" className="space-y-2">
          {allJobs.map((job, idx) => {
            const meta = statusMeta[job.status] ?? fallbackMeta;
            const error = job.error ? JSON.parse(job.error) : null;
            const isRetryable = job.status === "ARCHIVE_FAILED" || job.status === "VERIFY_FAILED";

            return (
              <li key={job.id}>
                <details
                  className={`group rounded-xl border border-gray-200 border-l-4 bg-white shadow-xs ${meta.borderClass}`}
                  open={idx === 0}
                >
                  <summary className="flex cursor-pointer items-start justify-between gap-4 p-4 [&::-webkit-details-marker]:hidden">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-medium text-gray-900">{job.filename}</p>
                        <span className={`shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${meta.badgeClass}`}>
                          {meta.pulse && (
                            <span className="relative flex size-1.5">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-current opacity-60" />
                              <span className="relative inline-flex size-1.5 rounded-full bg-current" />
                            </span>
                          )}
                          {meta.label}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-gray-400">
                        {formatBytes(job.sizeBytes)}
                        {job.destinationPath && (
                          <span className="text-gray-300"> · {job.destinationPath}</span>
                        )}
                      </p>
                      {error && (
                        <p className="mt-1 text-xs text-red-500">{error.phase}: {error.message}</p>
                      )}
                    </div>

                    <div className="flex shrink-0 items-center gap-3">
                      {isRetryable && (
                        <Form method="post">
                          <input type="hidden" name="jobId" value={job.id} />
                          <button
                            type="submit"
                            name="intent"
                            value="retry"
                            className="text-xs font-medium text-blue-600 hover:text-blue-800"
                            onClick={(e) => e.stopPropagation()}
                          >
                            Retry
                          </button>
                        </Form>
                      )}
                      <p className="text-xs text-gray-400 tabular-nums">
                        {new Date(job.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </p>
                      <svg
                        aria-hidden="true"
                        className="size-4 shrink-0 text-gray-400 transition-transform group-open:rotate-180"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                      </svg>
                    </div>
                  </summary>

                  <div className="border-t border-gray-100">
                    <JobHistory events={job.events} />
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
