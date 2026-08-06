import { desc, eq, sql, inArray, isNull, or, and } from "drizzle-orm";
import React, { useState, useEffect, useRef } from "react";
import { Form, useActionData, useRevalidator, useSearchParams } from "react-router";
import { JobHistory } from "../components/JobHistory";
import { useJobStream, type StatsFrame } from "../lib/useJobStream";
import { db } from "../db/client.server";
import { jobs, jobEvents } from "../db/schema";
import { getStats } from "../lib/rclone.server";

type StatusMeta = {
  label: string;
  badgeClass: string;
  borderClass: string;
  pulse?: boolean;
};

const statusMeta: Record<string, StatusMeta> = {
  UPLOADING:      { label: "Uploading",       badgeClass: "bg-blue-100 text-blue-700",     borderClass: "border-l-blue-400" },
  STAGED:         { label: "Staged",          badgeClass: "bg-yellow-100 text-yellow-700", borderClass: "border-l-yellow-400" },
  DECODING:       { label: "Decoding",        badgeClass: "bg-cyan-100 text-cyan-700",     borderClass: "border-l-cyan-400", pulse: true },
  DECODED:        { label: "Decoded",         badgeClass: "bg-teal-100 text-teal-700",     borderClass: "border-l-teal-400" },
  QUEUED:         { label: "Queued",          badgeClass: "bg-orange-100 text-orange-700", borderClass: "border-l-orange-400" },
  ARCHIVING:      { label: "Archiving",       badgeClass: "bg-purple-100 text-purple-700", borderClass: "border-l-purple-500", pulse: true },
  VERIFYING:      { label: "Verifying",       badgeClass: "bg-indigo-100 text-indigo-700", borderClass: "border-l-indigo-400", pulse: true },
  COMPLETED:      { label: "Completed",       badgeClass: "bg-green-100 text-green-700",   borderClass: "border-l-green-500" },
  RESTORING:      { label: "Restoring",       badgeClass: "bg-sky-100 text-sky-700",       borderClass: "border-l-sky-400", pulse: true },
  RESTORE_QUEUED: { label: "Migration queued",badgeClass: "bg-sky-100 text-sky-600",       borderClass: "border-l-sky-300" },
  UPLOAD_FAILED:  { label: "Upload failed",   badgeClass: "bg-red-100 text-red-700",       borderClass: "border-l-red-500" },
  DECODE_FAILED:  { label: "Decode failed",   badgeClass: "bg-red-100 text-red-700",       borderClass: "border-l-red-500" },
  ARCHIVE_FAILED: { label: "Archive failed",  badgeClass: "bg-red-100 text-red-700",       borderClass: "border-l-red-500" },
  VERIFY_FAILED:  { label: "Verify failed",   badgeClass: "bg-red-100 text-red-700",       borderClass: "border-l-red-500" },
  RESTORE_FAILED: { label: "Restore failed",  badgeClass: "bg-red-100 text-red-700",       borderClass: "border-l-red-500" },
  ABANDONED:      { label: "Abandoned",       badgeClass: "bg-gray-100 text-gray-500",     borderClass: "border-l-gray-300" },
};

const fallbackMeta: StatusMeta = {
  label: "Unknown",
  badgeClass: "bg-gray-100 text-gray-500",
  borderClass: "border-l-gray-300",
};

const statusOrder: Record<string, number> = {
  COMPLETED: 1,
  VERIFYING: 2,
  ARCHIVING: 3,
  QUEUED: 4,
  DECODED: 5,
  DECODING: 6,
  STAGED: 7,
  UPLOADING: 8,
  RESTORING: 9,
  RESTORE_QUEUED: 10,
  VERIFY_FAILED: 11,
  ARCHIVE_FAILED: 12,
  DECODE_FAILED: 13,
  UPLOAD_FAILED: 14,
  RESTORE_FAILED: 15,
  ABANDONED: 16,
};

const pageSizeOptions = [20, 30, 40, 50];

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const limit = Math.max(20, Math.min(50, parseInt(url.searchParams.get("limit") || "20", 10)));
  const offset = (page - 1) * limit;

  const [countResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(jobs);
  const totalCount = countResult?.count ?? 0;
  const totalPages = Math.ceil(totalCount / limit);

  const pageJobs = await db
    .select()
    .from(jobs)
    .orderBy(
      sql`CASE ${jobs.status}
        WHEN 'COMPLETED' THEN 1
        WHEN 'VERIFYING' THEN 2
        WHEN 'ARCHIVING' THEN 3
        WHEN 'QUEUED' THEN 4
        WHEN 'DECODED' THEN 5
        WHEN 'DECODING' THEN 6
        WHEN 'STAGED' THEN 7
        WHEN 'UPLOADING' THEN 8
        WHEN 'RESTORING' THEN 9
        WHEN 'RESTORE_QUEUED' THEN 10
        WHEN 'VERIFY_FAILED' THEN 11
        WHEN 'ARCHIVE_FAILED' THEN 12
        WHEN 'DECODE_FAILED' THEN 13
        WHEN 'UPLOAD_FAILED' THEN 14
        WHEN 'RESTORE_FAILED' THEN 15
        WHEN 'ABANDONED' THEN 16
        ELSE 17 END`,
      desc(jobs.updatedAt)
    )
    .limit(limit)
    .offset(offset);

  const jobIds = pageJobs.map(j => j.id);
  let jobEventsForPage: typeof jobEvents.$inferSelect[] = [];

  if (jobIds.length > 0) {
    jobEventsForPage = await db
      .select()
      .from(jobEvents)
      .where(inArray(jobEvents.jobId, jobIds));
  }

  const jobsWithEvents = pageJobs.map(job => ({
    ...job,
    events: jobEventsForPage.filter(e => e.jobId === job.id),
  }));

  const [downloadableCountResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(jobs)
    .where(
      and(
        isNull(jobs.downloadedAt),
        or(
          eq(jobs.status, "DECODED"),
          eq(jobs.status, "QUEUED"),
          eq(jobs.status, "ARCHIVING"),
          eq(jobs.status, "VERIFYING"),
          eq(jobs.status, "COMPLETED")
        )
      )
    );
  const downloadableCount = downloadableCountResult?.count ?? 0;

  // Legacy AAX-only books in B2 — migration candidates (including books
  // whose earlier restore attempt failed).
  const [aaxCandidateResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(jobs)
    .where(
      or(
        and(eq(jobs.status, "COMPLETED"), eq(jobs.archivedAs, "aax")),
        eq(jobs.status, "RESTORE_FAILED")
      )
    );
  const aaxCandidateCount = aaxCandidateResult?.count ?? 0;

  const archiving = jobsWithEvents.find((j) => j.status === "ARCHIVING");
  let liveProgress = null;

  if (archiving && archiving.rcloneJobId) {
    try {
      // Scope stats to this transfer — global stats are cumulative since
      // rclone started and produce nonsense percentages.
      const stats = await getStats(`job/${archiving.rcloneJobId}`);
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
    jobs: jobsWithEvents,
    liveProgress,
    page,
    totalPages,
    totalCount,
    limit,
    hasPrev: page > 1,
    hasNext: page < totalPages,
    downloadableCount,
    aaxCandidateCount,
  };
}

export async function action({ request }: { request: Request }) {
  const formData = await request.formData();
  const intent = formData.get("intent");
  const jobId = formData.get("jobId") as string;

  if (intent === "reconcile") {
    const { reconcileWithRemote } = await import("../lib/reconcile.server");
    try {
      const result = await reconcileWithRemote();
      return {
        success: true,
        message: `Synced with B2: ${result.scanned} files scanned, ${result.imported} adopted, ${result.updated} updated, ${result.aaxCandidates} legacy AAX to migrate.`,
      };
    } catch (err) {
      return {
        success: false,
        message: `Sync failed — is rclone running? (${err instanceof Error ? err.message : String(err)})`,
      };
    }
  }

  if (intent === "migrate") {
    const { enqueueMigration } = await import("../lib/migration.server");
    const ok = await enqueueMigration(jobId);
    return ok
      ? { success: true, message: "Queued for migration." }
      : { success: false, message: "Job is not eligible for migration." };
  }

  if (intent === "migrate-all") {
    const { enqueueAllMigrations } = await import("../lib/migration.server");
    const queued = await enqueueAllMigrations();
    return {
      success: true,
      message: `Queued ${queued} book${queued === 1 ? "" : "s"} for AAX → M4B migration. They run one at a time; watch progress here.`,
    };
  }

  if (intent === "retry") {
    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    if (job) {
      // Re-enter the state machine at the failed step. The step functions
      // set the correct status themselves — no fake intermediate state.
      await db
        .update(jobs)
        .set({ retryCount: job.retryCount + 1, error: null, updatedAt: new Date().toISOString() })
        .where(eq(jobs.id, jobId));

      if (job.status === "DECODE_FAILED") {
        const { processJob } = await import("../lib/pipeline.server");
        processJob(jobId).catch((err) => console.error("Retry decode error:", err));
      } else if (job.status === "RESTORE_FAILED") {
        const { enqueueMigration } = await import("../lib/migration.server");
        await enqueueMigration(jobId);
      } else {
        const { startOrQueueArchive } = await import("../lib/archiver.server");
        await startOrQueueArchive(jobId);
      }
    }
    return { success: true };
  }

  if (intent === "abandon") {
    await db
      .update(jobs)
      .set({ status: "ABANDONED", updatedAt: new Date().toISOString() })
      .where(eq(jobs.id, jobId));
    return { success: true };
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

type PlayerBook = { id: string; title: string };

function PlayerBar({ book, onClose }: { book: PlayerBook; onClose: () => void }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const lastSavedRef = useRef(0);
  const storageKey = `playpos:${book.id}`;

  return (
    <div className="fixed bottom-0 inset-x-0 z-40 border-t border-gray-200 bg-white/95 backdrop-blur shadow-[0_-4px_16px_rgba(0,0,0,0.08)]">
      <div className="max-w-4xl mx-auto flex items-center gap-3 px-4 py-3">
        <span className="text-sm font-medium text-gray-800 truncate max-w-[16rem]" title={book.title}>
          {book.title}
        </span>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- audiobook stream, no caption track exists */}
        <audio
          ref={audioRef}
          controls
          autoPlay
          preload="metadata"
          src={`/api/stream/${book.id}`}
          className="flex-1 h-10"
          onLoadedMetadata={() => {
            const saved = Number(localStorage.getItem(storageKey) || 0);
            if (audioRef.current && saved > 5) {
              audioRef.current.currentTime = saved;
            }
          }}
          onTimeUpdate={() => {
            const t = audioRef.current?.currentTime ?? 0;
            if (Math.abs(t - lastSavedRef.current) >= 5) {
              lastSavedRef.current = t;
              localStorage.setItem(storageKey, String(Math.floor(t)));
            }
          }}
        />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close player"
          className="shrink-0 rounded-full p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
        >
          <svg aria-hidden="true" className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export default function Jobs({ loaderData }: { loaderData: Awaited<ReturnType<typeof loader>> }) {
  const { jobs: allJobs, liveProgress, page, totalPages, totalCount, limit, hasPrev, hasNext, downloadableCount, aaxCandidateCount } = loaderData;
  const actionData = useActionData<typeof action>();
  const revalidator = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();

  const [expandedStates, setExpandedStates] = useState<Set<string>>(new Set(Object.keys(statusOrder)));
  const [expandedJobs, setExpandedJobs] = useState<Set<string>>(new Set());
  const [playing, setPlaying] = useState<PlayerBook | null>(null);

  const hasActiveJob = allJobs.some((j) =>
    ["UPLOADING", "STAGED", "DECODING", "QUEUED", "ARCHIVING", "VERIFYING", "RESTORING", "RESTORE_QUEUED"].includes(j.status)
  );

  // Server pushes transitions over SSE; revalidate (debounced) so the table
  // reflects them without blind polling. Transfer stats update the progress
  // bar directly — no loader round-trip.
  const [liveStats, setLiveStats] = useState<StatsFrame | null>(null);
  const revalidateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useJobStream({
    onJob: () => {
      if (revalidateTimer.current) return;
      revalidateTimer.current = setTimeout(() => {
        revalidateTimer.current = null;
        revalidator.revalidate();
      }, 300);
    },
    onStats: (stats) => setLiveStats(stats),
  });
  useEffect(() => {
    return () => {
      if (revalidateTimer.current) clearTimeout(revalidateTimer.current);
    };
  }, []);

  // Drop stale stats once nothing is archiving anymore.
  const hasArchivingJob = allJobs.some((j) => j.status === "ARCHIVING");
  useEffect(() => {
    if (!hasArchivingJob) setLiveStats(null);
  }, [hasArchivingJob]);

  const displayProgress = liveStats
    ? {
        bytesTransferred: liveStats.bytesTransferred,
        totalBytes: liveStats.totalBytes,
        speed: liveStats.speed,
        eta: liveStats.eta,
        percentage:
          liveStats.totalBytes > 0
            ? Math.min(100, Math.round((liveStats.bytesTransferred / liveStats.totalBytes) * 100))
            : 0,
      }
    : liveProgress;

  // A book is downloadable/playable when its M4B exists somewhere: local
  // staging (post-decode, pre-cleanup) or verified in B2.
  const hasM4b = (job: typeof allJobs[0]) =>
    ["DECODED", "QUEUED", "ARCHIVING", "VERIFYING"].includes(job.status) ||
    (job.status === "COMPLETED" && job.archivedAs === "m4b");

  const isMigratable = (job: typeof allJobs[0]) =>
    job.status === "COMPLETED" && job.archivedAs === "aax";

  const m4bTitle = (filename: string) => filename.replace(/\.(aax|m4b)$/i, "");

  const toggleJobExpanded = (jobId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const newExpanded = new Set(expandedJobs);
    if (newExpanded.has(jobId)) {
      newExpanded.delete(jobId);
    } else {
      newExpanded.add(jobId);
    }
    setExpandedJobs(newExpanded);
  };

  const toggleStateGroup = (state: string) => {
    const newExpanded = new Set(expandedStates);
    if (newExpanded.has(state)) {
      newExpanded.delete(state);
    } else {
      newExpanded.add(state);
    }
    setExpandedStates(newExpanded);
  };

  const handleLimitChange = (newLimit: number) => {
    const params = new URLSearchParams(searchParams);
    params.set("limit", String(newLimit));
    params.set("page", "1");
    setSearchParams(params);
  };

  const jobsByState = allJobs.reduce((acc, job) => {
    if (!acc[job.status]) acc[job.status] = [];
    acc[job.status].push(job);
    return acc;
  }, {} as Record<string, typeof allJobs>);

  const sortedStates = Object.keys(jobsByState).sort((a, b) =>
    (statusOrder[a] || 99) - (statusOrder[b] || 99)
  );

  return (
    <div className={`max-w-4xl mx-auto space-y-6 ${playing ? "pb-24" : ""}`}>
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-gray-900">Jobs</h1>
        <div className="flex items-center gap-3">
          {hasActiveJob && (
            <span className="inline-flex items-center gap-1.5 text-xs text-gray-500">
              <span className="relative flex size-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-75" />
                <span className="relative inline-flex size-2 rounded-full bg-purple-500" />
              </span>
              Live
            </span>
          )}
          {downloadableCount > 0 && (
            <a
              href="/api/download-all"
              className="text-xs font-medium text-gray-500 hover:text-gray-700"
              title="Bulk ZIP export of everything not yet downloaded"
            >
              Export all ({downloadableCount})
            </a>
          )}
          {aaxCandidateCount > 0 && (
            <Form method="post" className="inline">
              <button
                type="submit"
                name="intent"
                value="migrate-all"
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-sky-600 hover:bg-sky-700 text-white transition-colors"
                title="Re-encode legacy AAX archives to M4B, one at a time"
              >
                Migrate {aaxCandidateCount} legacy AAX
              </button>
            </Form>
          )}
          <Form method="post" className="inline">
            <button
              type="submit"
              name="intent"
              value="reconcile"
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors"
              title="Scan B2 and adopt books uploaded outside this app"
            >
              Sync with B2
            </button>
          </Form>
        </div>
      </div>

      {actionData?.message && (
        <div
          className={`rounded-lg border px-4 py-3 text-sm ${
            actionData.success
              ? "border-green-200 bg-green-50 text-green-800"
              : "border-red-200 bg-red-50 text-red-800"
          }`}
        >
          {actionData.message}
        </div>
      )}

      {displayProgress && (
        <div className="rounded-xl border border-purple-200 bg-purple-50 p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-medium text-purple-900">Archiving in progress</p>
            <p className="text-xs text-purple-600 tabular-nums">
              {formatBytes(displayProgress.bytesTransferred)} / {formatBytes(displayProgress.totalBytes)}
              {" · "}
              {formatSpeed(displayProgress.speed)}
              {" · "}
              ETA {formatEta(displayProgress.eta)}
            </p>
          </div>
          <div className="h-1.5 w-full rounded-full bg-purple-200">
            <div
              className="h-1.5 rounded-full bg-purple-600 transition-all duration-700"
              style={{ width: `${displayProgress.percentage}%` }}
            />
          </div>
          <p className="mt-1.5 text-right text-xs text-purple-500">{displayProgress.percentage}%</p>
        </div>
      )}

      {allJobs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 py-12 text-center">
          <p className="text-sm text-gray-400">
            No jobs yet. Upload a file to get started, or Sync with B2 to adopt an existing archive.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {sortedStates.map(state => {
            const jobsInState = jobsByState[state];
            const meta = statusMeta[state] ?? fallbackMeta;
            const isExpanded = expandedStates.has(state);

            return (
              <div key={state} className="rounded-xl border border-gray-200 overflow-hidden">
                <button
                  type="button"
                  onClick={() => toggleStateGroup(state)}
                  className="w-full flex items-center justify-between p-4 bg-gray-50 hover:bg-gray-100 transition-colors border-b border-gray-200"
                >
                  <div className="flex items-center gap-3">
                    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${meta.badgeClass}`}>
                      {meta.pulse && (
                        <span className="relative flex size-1.5">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-current opacity-60" />
                          <span className="relative inline-flex size-1.5 rounded-full bg-current" />
                        </span>
                      )}
                      {meta.label}
                    </span>
                    <span className="text-sm text-gray-500">{jobsInState.length} jobs</span>
                  </div>
                  <svg
                    aria-hidden="true"
                    className={`size-4 text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {isExpanded && (
                  <table className="w-full">
                    <thead className="bg-gray-50 border-b border-gray-100">
                      <tr>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-400">Filename</th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-400">Size</th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-400">Destination</th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-400">Updated</th>
                        <th className="w-40 px-4 py-2 text-right text-xs font-medium text-gray-400">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {jobsInState.map((job) => {
                        let error: { phase?: string; message?: string } | null = null;
                        if (job.error) {
                          try {
                            error = JSON.parse(job.error);
                          } catch {
                            error = { phase: job.status, message: job.error };
                          }
                        }
                        const isRetryable = ["ARCHIVE_FAILED", "VERIFY_FAILED", "DECODE_FAILED", "RESTORE_FAILED"].includes(job.status);

                        return (
                          <React.Fragment key={job.id}>
                            <tr className="hover:bg-gray-50">
                              <td className="px-4 py-3">
                                <div className="flex flex-col">
                                  <button
                                    type="button"
                                    onClick={(e) => toggleJobExpanded(job.id, e)}
                                    className="flex items-center gap-2 text-left hover:text-gray-600"
                                  >
                                    <svg
                                      aria-hidden="true"
                                      className={`size-3 text-gray-400 transition-transform ${expandedJobs.has(job.id) ? 'rotate-90' : ''}`}
                                      fill="none"
                                      viewBox="0 0 24 24"
                                      stroke="currentColor"
                                      strokeWidth={2}
                                    >
                                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                                    </svg>
                                    <span className="text-sm font-medium text-gray-900 truncate max-w-xs">{job.filename}</span>
                                    {job.origin === "imported" && (
                                      <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-400" title="Adopted from B2 by Sync">
                                        imported
                                      </span>
                                    )}
                                    {isMigratable(job) && (
                                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-600" title="Archived as AAX — migrate to M4B to enable streaming">
                                        aax
                                      </span>
                                    )}
                                  </button>
                                  {error && (
                                    <span className="text-xs text-red-500 ml-5">{error.phase}: {error.message}</span>
                                  )}
                                </div>
                              </td>
                              <td className="px-4 py-3 text-sm text-gray-500">{formatBytes(job.sizeBytes)}</td>
                              <td className="px-4 py-3 text-sm text-gray-500 truncate max-w-xs">{job.destinationPath || '-'}</td>
                              <td className="px-4 py-3 text-sm text-gray-400 tabular-nums">
                                {new Date(job.updatedAt).toLocaleString([], {
                                  month: 'short',
                                  day: 'numeric',
                                  hour: '2-digit',
                                  minute: '2-digit'
                                })}
                              </td>
                              <td className="px-4 py-3 text-right">
                                <div className="inline-flex items-center gap-3">
                                  {hasM4b(job) && (
                                    <>
                                      <button
                                        type="button"
                                        onClick={() => setPlaying({ id: job.id, title: m4bTitle(job.filename) })}
                                        className="text-xs font-medium text-teal-600 hover:text-teal-800"
                                      >
                                        Play
                                      </button>
                                      <a
                                        href={`/api/download/${job.id}`}
                                        className="text-xs font-medium text-gray-500 hover:text-gray-700"
                                      >
                                        Download
                                      </a>
                                    </>
                                  )}
                                  {isMigratable(job) && (
                                    <Form method="post" className="inline">
                                      <input type="hidden" name="jobId" value={job.id} />
                                      <button
                                        type="submit"
                                        name="intent"
                                        value="migrate"
                                        className="text-xs font-medium text-sky-600 hover:text-sky-800"
                                      >
                                        Migrate
                                      </button>
                                    </Form>
                                  )}
                                  {isRetryable && (
                                    <Form method="post" className="inline">
                                      <input type="hidden" name="jobId" value={job.id} />
                                      <button
                                        type="submit"
                                        name="intent"
                                        value="retry"
                                        className="text-xs font-medium text-blue-600 hover:text-blue-800"
                                      >
                                        Retry
                                      </button>
                                    </Form>
                                  )}
                                </div>
                              </td>
                            </tr>
                            {expandedJobs.has(job.id) && (
                              <tr>
                                <td colSpan={5} className="px-4 py-3 bg-gray-50">
                                  <JobHistory events={job.events} />
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            );
          })}
        </div>
      )}

      {totalCount > 0 && (
        <div className="flex items-center justify-between pt-4 border-t border-gray-200">
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-500">
              Showing {((page - 1) * limit) + 1}–{Math.min(page * limit, totalCount)} of {totalCount} jobs
            </span>
            <select
              value={limit}
              onChange={(e) => handleLimitChange(Number(e.target.value))}
              className="px-2 py-1 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500 focus:border-transparent"
            >
              {pageSizeOptions.map(size => (
                <option key={size} value={size}>{size}/page</option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <a
              href={`/jobs?page=${page - 1}&limit=${limit}`}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg border ${
                hasPrev
                  ? "border-gray-300 text-gray-700 hover:bg-gray-50"
                  : "border-gray-100 text-gray-300 pointer-events-none"
              }`}
            >
              ← Previous
            </a>
            <span className="px-3 py-1.5 text-xs text-gray-400">
              Page {page} of {totalPages}
            </span>
            <a
              href={`/jobs?page=${page + 1}&limit=${limit}`}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg border ${
                hasNext
                  ? "border-gray-300 text-gray-700 hover:bg-gray-50"
                  : "border-gray-100 text-gray-300 pointer-events-none"
              }`}
            >
              Next →
            </a>
          </div>
        </div>
      )}

      {playing && <PlayerBar book={playing} onClose={() => setPlaying(null)} />}
    </div>
  );
}
