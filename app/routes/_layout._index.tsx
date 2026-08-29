import { useState, useCallback, useEffect, useRef } from "react";
import { desc, eq, and, sql } from "drizzle-orm";
import { Link } from "react-router";
import { MagnifyingGlassIcon } from "@heroicons/react/16/solid";
import { db } from "../db/client.server";
import { jobs } from "../db/schema";
import { FileCard, type CardJob } from "../components/FileCard";
import { DropZone } from "../components/DropZone";
import { BookGrid } from "../components/BookGrid";
import { Player } from "../components/Player";
import {
  useJobStream,
  bookTitle,
  type StreamedJob,
  type StatsFrame,
} from "../lib/useJobStream";

export async function loader() {
  // The whole shelf: every book with an M4B safe in B2.
  const books = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.status, "COMPLETED"), eq(jobs.archivedAs, "m4b")));

  // Recent pipeline activity for the active-cards strip.
  const recentJobs = await db
    .select()
    .from(jobs)
    .orderBy(desc(jobs.createdAt))
    .limit(50);

  const [aaxResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(jobs)
    .where(and(eq(jobs.status, "COMPLETED"), eq(jobs.archivedAs, "aax")));

  return { books, recentJobs, aaxCandidateCount: aaxResult?.count ?? 0 };
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

export default function Library({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { books, recentJobs, aaxCandidateCount } = loaderData;

  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [search, setSearch] = useState("");
  const [playing, setPlaying] = useState<StreamedJob | null>(null);
  const destinationPathRef = useRef("");

  // Live server state: seeded from the loader, kept fresh over SSE. Cards
  // and the shelf both derive from this map, so covers and titles pop in
  // as the metadata backfill works through the archive.
  const [serverJobs, setServerJobs] = useState<Map<string, StreamedJob>>(
    () =>
      new Map(
        [...(books as StreamedJob[]), ...(recentJobs as StreamedJob[])].map(
          (j) => [j.id, j],
        ),
      ),
  );
  const [archiveStats, setArchiveStats] = useState<StatsFrame | null>(null);
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
      prev.map((item) =>
        item.localId === localId ? { ...item, status: "uploading" } : item,
      ),
    );

    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) {
        const percent = Math.round((e.loaded / e.total) * 100);
        setQueue((prev) =>
          prev.map((item) =>
            item.localId === localId ? { ...item, uploadPercent: percent } : item,
          ),
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
                : item,
            ),
          );
        } catch {
          setQueue((prev) =>
            prev.map((item) =>
              item.localId === localId
                ? { ...item, status: "error", error: "Invalid response" }
                : item,
            ),
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
          prev.map((item) =>
            item.localId === localId ? { ...item, status: "error", error: msg } : item,
          ),
        );
      }
    });

    xhr.addEventListener("error", () => {
      setQueue((prev) =>
        prev.map((item) =>
          item.localId === localId
            ? { ...item, status: "error", error: "Network error" }
            : item,
        ),
      );
    });

    xhr.open(
      "POST",
      "/api/upload?destinationPath=" + encodeURIComponent(destinationPathRef.current),
    );
    xhr.send(formData);
  }, []);

  useEffect(() => {
    if (queue.length === 0) return;
    if (queue.some((item) => item.status === "uploading")) return;
    const pending = queue.find((item) => item.status === "pending");
    if (pending) uploadNext(queue);
  }, [queue, uploadNext]);

  // --- Active pipeline cards: local upload legs merged with server state ---

  const queuedJobIds = new Set(queue.map((q) => q.jobId).filter(Boolean));
  const uploadingLocalNames = new Set(
    queue
      .filter((q) => q.status === "uploading" || q.status === "pending")
      .map((q) => q.file.name),
  );

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
        stage:
          q.status === "uploading"
            ? "UPLOADING"
            : q.status === "done"
              ? "STAGED"
              : "PENDING",
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

  // Server jobs in flight that this tab isn't already showing (pre-refresh
  // uploads, migrations, another device). Books that finish while watching
  // leave the strip and appear on the shelf via the same map.
  const orphanCards: CardJob[] = [...serverJobs.values()]
    .filter(
      (j) =>
        (ACTIVE_STATUSES.includes(j.status) ||
          (seenLiveRef.current.has(j.id) && j.status.endsWith("_FAILED"))) &&
        !queuedJobIds.has(j.id) &&
        !(j.status === "UPLOADING" && uploadingLocalNames.has(j.filename)),
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

  // --- The shelf ---

  const shelf = [...serverJobs.values()]
    .filter((j) => j.status === "COMPLETED" && j.archivedAs === "m4b")
    .sort((a, b) => bookTitle(a).localeCompare(bookTitle(b)));

  const q = search.trim().toLowerCase();
  const visibleBooks = q
    ? shelf.filter((b) =>
        [b.title, b.author, b.narrator, b.filename]
          .filter(Boolean)
          .some((f) => f!.toLowerCase().includes(q)),
      )
    : shelf;

  return (
    <div className={playing ? "pb-32" : ""}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-balance text-gray-900">
            Library
          </h1>
          <p className="text-base text-gray-500 sm:text-sm">
            {shelf.length} books, encrypted in B2.
            {aaxCandidateCount > 0 && (
              <>
                {" "}
                <Link to="/jobs" className="text-teal-700 hover:text-teal-900">
                  {aaxCandidateCount} awaiting migration
                </Link>
              </>
            )}
          </p>
        </div>
        <div className="relative w-full max-w-xs">
          <MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 shrink-0 -translate-y-1/2 fill-gray-400" />
          <input
            type="search"
            name="search"
            aria-label="Search books"
            placeholder="Search title or author"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-md py-2 pr-3 pl-8 text-base text-gray-900 ring-1 ring-black/10 placeholder:text-gray-400 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-teal-600 sm:py-1.5 sm:text-sm"
          />
        </div>
      </div>

      <div className="mb-8">
        <DropZone onFiles={handleFiles} />
      </div>

      {allCards.length > 0 && (
        <div className="mb-10">
          <h2 className="mb-3 text-sm font-medium text-gray-500">In flight</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {allCards.map((job) => (
              <FileCard key={job.localId} job={job} />
            ))}
          </div>
        </div>
      )}

      {visibleBooks.length > 0 ? (
        <BookGrid books={visibleBooks} onPlay={setPlaying} />
      ) : shelf.length > 0 ? (
        <p className="py-12 text-center text-base text-gray-400 sm:text-sm">
          No books match “{search}”.
        </p>
      ) : (
        <p className="py-12 text-center text-base text-gray-400 sm:text-sm">
          Drop an AAX file above to archive your first book.
        </p>
      )}

      {playing && <Player book={playing} onClose={() => setPlaying(null)} />}
    </div>
  );
}
