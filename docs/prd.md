# PRD: Audiobook Archive Web App

## Problem

Uploading audiobooks to the encrypted Backblaze B2 archive currently requires SSH and rclone CLI commands. The goal is a drag-and-drop web UI running on a homelab server, accessible from any Tailscale device, that handles: receive file → stage to disk → encrypt via rclone → upload to B2.

---

## Key Architectural Decisions

### 1. Don't Talk to B2 Directly — Use rclone

The B2 Native API requires `Content-Length` on every call (no chunked transfer encoding), manual multipart splitting for large files, and SHA-1 checksums per part. You'd also need to reimplement rclone's NaCl SecretBox encryption and AES-SIV filename encryption.

Instead, we use **`rclone rcd`** — the rclone remote control daemon — which exposes an HTTP API on `localhost:5572`. We POST JSON to endpoints like `operations/copyfile` and rclone handles encryption, chunking, checksumming, retries, and the B2 protocol. The existing `rclone.conf` with the `audiobooks:` crypt remote works unchanged.

### 2. React Router v7 as the Full-Stack Framework

One process serves everything: the UI, the route actions (upload handling, rclone orchestration), and the data loaders. No separate Express/Node backend. Route components receive `loaderData` and `actionData` as props via `Route.ComponentProps`.

### 3. `@remix-run/form-data-parser` for Streaming Uploads

Streams multipart file uploads directly to disk as they arrive in the request body. The file never buffers entirely in server memory. Built on the web Streams API and the standard `Request` object, so it slots directly into React Router route actions.

### 4. `<meta httpEquiv="refresh">` for Progress Polling

No `useEffect`, no SSE. React 19 hoists `<meta>` tags rendered anywhere in the component tree into `<head>`. When a job is active, the jobs page renders `<meta httpEquiv="refresh" content="3" />` and the browser reloads every 3 seconds, re-running the loader. When all jobs finish, the tag unmounts and reloading stops.

### 5. SQLite + Drizzle for Job State

One table, one file. SQLite lives at `/data/audiobook-archive.db`. Drizzle ORM provides typed queries. No manifest JSON files scattered across the staging directory.

### 6. Auto-Archive After Staging

Upload completes → archive starts immediately. No manual trigger. The user can inspect job state on the `/jobs` page.

### 7. No Concurrent Archives

One rclone archive job at a time. If a job is already running, newly staged files queue up. The server-side watcher picks up the next queued job when the current one finishes.

---

## System Architecture

```
Browser (any Tailscale device)          Homelab Server
┌─────────────────────┐     ┌──────────────────────────────────────┐
│                     │     │                                      │
│  React Router app   │────▶│  React Router server (:3001)         │
│  drag & drop UI     │     │                                      │
│  job status page    │     │    Route actions:                     │
│  file browser       │     │      /         → stream to staging,  │
│                     │     │                   auto-start archive │
│                     │     │                                      │
│                     │     │    Route loaders:                     │
│                     │     │      /         → list staged/queued  │
│                     │     │      /archive  → rclone ops/list     │
│                     │     │      /jobs     → query SQLite        │
│                     │     │                                      │
│                     │     │    Server-side background:            │
│                     │     │      watchJob() → poll rclone,       │
│                     │     │        update DB, cleanup staging,   │
│                     │     │        start next queued job         │
│                     │     │                                      │
│                     │     │  SQLite: /data/audiobook-archive.db  │
│                     │     │                                      │
│                     │     │  rclone rcd (:5572, localhost only)   │
│                     │     │    ├─ operations/copyfile             │
│                     │     │    ├─ operations/list                 │
│                     │     │    ├─ core/stats                      │
│                     │     │    └─ job/status                      │
│                     │     │         ↓                             │
│                     │     │    encrypt → upload to B2             │
└─────────────────────┘     └──────────────────────────────────────┘
```

Two processes on the homelab:

1. **React Router server** — serves the UI, handles route actions and loaders. Exposed on the Tailscale IP.
2. **`rclone rcd`** — preconfigured with existing `rclone.conf`. Listens on `localhost:5572` only. Not network-exposed. Runs with `--rc-no-auth` since it's localhost-only.

---

## Database Schema

One table. Drizzle ORM.

```ts
// ~/db/schema.ts
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(), // UUID
  filename: text("filename").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  destinationPath: text("destination_path").notNull().default(""),
  status: text("status", {
    enum: [
      "UPLOADING",
      "STAGED",
      "QUEUED",
      "ARCHIVING",
      "VERIFYING",
      "COMPLETED",
      "UPLOAD_FAILED",
      "ARCHIVE_FAILED",
      "VERIFY_FAILED",
      "ABANDONED",
    ],
  }).notNull(),
  rcloneJobId: integer("rclone_job_id"),
  error: text("error"), // JSON string: { phase, message, rcloneError }
  retryCount: integer("retry_count").notNull().default(0),
  createdAt: text("created_at").notNull(), // ISO 8601
  updatedAt: text("updated_at").notNull(), // ISO 8601
});
```

Note: `QUEUED` is new — when auto-archive fires but another job is already `ARCHIVING`, the new job enters `QUEUED` and waits.

---

## Upload Flow

### Phase 1: Browser → Server (stream to staging)

The browser sends the file via `multipart/form-data`. The route action streams it to disk, inserts a DB row, and auto-starts the archive (or queues it).

**Route: `/` action**

```ts
import * as fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { FileUpload } from "@remix-run/form-data-parser";
import { parseFormData } from "@remix-run/form-data-parser";
import { db } from "~/db/client.server";
import { jobs } from "~/db/schema";
import { startOrQueueArchive } from "~/lib/archiver.server";

export async function action({ request }: Route.ActionArgs) {
  const id = randomUUID();
  const stagingDir = `/data/staging/${id}`;
  await fsp.mkdir(stagingDir, { recursive: true });

  const now = new Date().toISOString();
  let filename = "";
  let sizeBytes = 0;

  try {
    const formData = await parseFormData(
      request,
      async (fileUpload: FileUpload) => {
        if (fileUpload.fieldName === "file") {
          filename = fileUpload.name;
          const dest = `${stagingDir}/${fileUpload.name}`;
          await fsp.writeFile(dest, await fileUpload.bytes());
          sizeBytes = (await fsp.stat(dest)).size;
          return dest;
        }
      },
    );

    const destinationPath = (formData.get("destinationPath") as string) || "";

    await db.insert(jobs).values({
      id,
      filename,
      sizeBytes,
      destinationPath,
      status: "STAGED",
      createdAt: now,
      updatedAt: now,
    });

    // Auto-archive: start immediately or queue if something is already running
    await startOrQueueArchive(id);

    return { id, filename, sizeBytes, destinationPath };
  } catch (err) {
    await db.insert(jobs).values({
      id,
      filename: filename || "unknown",
      sizeBytes,
      destinationPath: "",
      status: "UPLOAD_FAILED",
      error: JSON.stringify({ phase: "UPLOADING", message: String(err) }),
      createdAt: now,
      updatedAt: now,
    });
    throw err;
  }
}
```

### Phase 2: Archive Orchestration

The archiver checks if anything is currently `ARCHIVING`. If not, it starts the job. If yes, it queues.

```ts
// ~/lib/archiver.server.ts
import { eq } from "drizzle-orm";
import { db } from "~/db/client.server";
import { jobs } from "~/db/schema";
import { watchJob } from "~/lib/jobWatcher.server";

export async function startOrQueueArchive(id: string) {
  const active = await db
    .select()
    .from(jobs)
    .where(eq(jobs.status, "ARCHIVING"))
    .limit(1);

  if (active.length > 0) {
    await db
      .update(jobs)
      .set({ status: "QUEUED", updatedAt: new Date().toISOString() })
      .where(eq(jobs.id, id));
    return;
  }

  await startArchiveJob(id);
}

export async function startArchiveJob(id: string) {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  if (!job) return;

  const res = await fetch("http://localhost:5572/operations/copyfile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      srcFs: `/data/staging/${id}/`,
      srcRemote: job.filename,
      dstFs: "audiobooks:",
      dstRemote: `${job.destinationPath}${job.filename}`,
      _async: true,
    }),
  });

  const { jobid } = await res.json();

  await db
    .update(jobs)
    .set({
      status: "ARCHIVING",
      rcloneJobId: jobid,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(jobs.id, id));

  watchJob(id, jobid);
}
```

### Phase 3: Server-Side Job Watcher

Runs independently of any client. On completion, starts the next queued job.

```ts
// ~/lib/jobWatcher.server.ts
import { eq, asc } from "drizzle-orm";
import { db } from "~/db/client.server";
import { jobs } from "~/db/schema";
import { startArchiveJob } from "~/lib/archiver.server";

export function watchJob(id: string, rcloneJobId: number) {
  const interval = setInterval(async () => {
    try {
      const res = await fetch("http://localhost:5572/job/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobid: rcloneJobId }),
      });
      const status = await res.json();

      if (!status.finished) return;
      clearInterval(interval);

      if (status.success) {
        await db
          .update(jobs)
          .set({ status: "VERIFYING", updatedAt: new Date().toISOString() })
          .where(eq(jobs.id, id));

        const verified = await verifyArchive(id);

        if (verified) {
          await db
            .update(jobs)
            .set({ status: "COMPLETED", updatedAt: new Date().toISOString() })
            .where(eq(jobs.id, id));
          await cleanupStaging(id);
        } else {
          await db
            .update(jobs)
            .set({
              status: "VERIFY_FAILED",
              error: JSON.stringify({
                phase: "VERIFYING",
                message: "File not found in remote after successful rclone job",
              }),
              updatedAt: new Date().toISOString(),
            })
            .where(eq(jobs.id, id));
        }
      } else {
        await db
          .update(jobs)
          .set({
            status: "ARCHIVE_FAILED",
            error: JSON.stringify({
              phase: "ARCHIVING",
              message: status.error,
            }),
            updatedAt: new Date().toISOString(),
          })
          .where(eq(jobs.id, id));
      }

      // Start next queued job
      await startNextQueued();
    } catch (err) {
      clearInterval(interval);
      await db
        .update(jobs)
        .set({
          status: "ARCHIVE_FAILED",
          error: JSON.stringify({ phase: "ARCHIVING", message: String(err) }),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(jobs.id, id));
      await startNextQueued();
    }
  }, 5000);
}

async function startNextQueued() {
  const [next] = await db
    .select()
    .from(jobs)
    .where(eq(jobs.status, "QUEUED"))
    .orderBy(asc(jobs.createdAt))
    .limit(1);

  if (next) {
    await startArchiveJob(next.id);
  }
}

async function verifyArchive(id: string): Promise<boolean> {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  if (!job) return false;

  const res = await fetch("http://localhost:5572/operations/list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fs: "audiobooks:", remote: job.destinationPath }),
  });
  const { list } = await res.json();
  return list.some((entry: any) => entry.Name === job.filename);
}

async function cleanupStaging(id: string) {
  const fsp = await import("node:fs/promises");
  await fsp.rm(`/data/staging/${id}`, { recursive: true, force: true });
}
```

### Phase 4: Progress Display

```tsx
// app/routes/_layout.jobs.tsx

export async function loader() {
  const allJobs = await db.select().from(jobs).orderBy(desc(jobs.updatedAt));

  // Merge live rclone stats for the active job
  const archiving = allJobs.find((j) => j.status === "ARCHIVING");
  let liveProgress = null;

  if (archiving) {
    try {
      const statsRes = await fetch("http://localhost:5572/core/stats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const stats = await statsRes.json();
      liveProgress = {
        jobId: archiving.id,
        bytesTransferred: stats.bytes ?? 0,
        speed: stats.speed ?? 0,
        eta: stats.eta ?? 0,
      };
    } catch {
      // rclone might be down — just show status without live stats
    }
  }

  return { jobs: allJobs, liveProgress };
}

export default function Jobs({ loaderData }: Route.ComponentProps) {
  const { jobs, liveProgress } = loaderData;
  const hasActiveJob = jobs.some(
    (j) =>
      j.status === "ARCHIVING" ||
      j.status === "VERIFYING" ||
      j.status === "QUEUED",
  );

  return (
    <>
      {hasActiveJob && <meta httpEquiv="refresh" content="3" />}
      {/* render job list with progress bars, retry buttons for failed jobs */}
    </>
  );
}
```

---

## State Machine

```
  ┌──────────┐
  │ UPLOADING │ ← browser streaming to server (transient, only in DB on failure)
  └────┬──────┘
       │ file written to disk
       ▼
  ┌──────────┐     nothing running     ┌───────────┐
  │  STAGED  │ ───────────────────────▶│ ARCHIVING │
  └────┬──────┘                        └──┬─────┬──┘
       │ something already archiving      │     │
       ▼                                  │     │ rclone fails
  ┌──────────┐                           │     ▼
  │  QUEUED  │                           │  ┌──────────────┐
  └────┬──────┘                          │  │ARCHIVE_FAILED│──retry──▶ ARCHIVING
       │ previous job finishes            │  └──────────────┘
       └──────────────────────────────▶ ARCHIVING
                                         │
                                         │ rclone succeeds
                                         ▼
                                    ┌───────────┐
                                    │ VERIFYING │
                                    └──┬─────┬──┘
                                       │     │ not found in remote
                                       │     ▼
                                       │  ┌──────────────┐
                                       │  │ VERIFY_FAILED│──retry──▶ ARCHIVING
                                       │  └──────────────┘
                                       │ confirmed
                                       ▼
                                  ┌───────────┐
                                  │ COMPLETED │ staging deleted
                                  └───────────┘

  Terminal error states: UPLOAD_FAILED, ABANDONED
```

### Transition Rules

| From             | To               | Trigger                    | Side Effects                                        |
| ---------------- | ---------------- | -------------------------- | --------------------------------------------------- |
| —                | `STAGED`         | File fully written to disk | Insert row, call `startOrQueueArchive`              |
| —                | `UPLOAD_FAILED`  | Disk write error           | Insert row with error                               |
| `STAGED`         | `ARCHIVING`      | No other job archiving     | Call rclone `operations/copyfile`, start `watchJob` |
| `STAGED`         | `QUEUED`         | Another job is archiving   | Wait                                                |
| `QUEUED`         | `ARCHIVING`      | Previous job finishes      | `startNextQueued()`                                 |
| `ARCHIVING`      | `VERIFYING`      | rclone reports success     | `operations/list` to confirm                        |
| `ARCHIVING`      | `ARCHIVE_FAILED` | rclone reports failure     | Record error                                        |
| `VERIFYING`      | `COMPLETED`      | File found in remote       | Delete staging dir                                  |
| `VERIFYING`      | `VERIFY_FAILED`  | File not in remote         | Record error                                        |
| `ARCHIVE_FAILED` | `ARCHIVING`      | User clicks retry          | Increment `retryCount`                              |
| `VERIFY_FAILED`  | `ARCHIVING`      | User clicks retry          | Re-archive from staging                             |
| Any non-terminal | `ABANDONED`      | >7 days stale              | Cleanup cron                                        |

---

## Startup Recovery

On server boot, query the DB and fix orphaned states:

```ts
// ~/lib/startup.server.ts
export async function recoverOrphanedJobs() {
  // ARCHIVING with no running rclone job → ARCHIVE_FAILED
  const archiving = await db
    .select()
    .from(jobs)
    .where(eq(jobs.status, "ARCHIVING"));
  for (const job of archiving) {
    try {
      const res = await fetch("http://localhost:5572/job/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobid: job.rcloneJobId }),
      });
      const status = await res.json();
      if (!status.finished) {
        // Still running — re-attach watcher
        watchJob(job.id, job.rcloneJobId!);
      } else {
        // Finished while we were down — process result
        // (same logic as watchJob completion)
      }
    } catch {
      await db
        .update(jobs)
        .set({
          status: "ARCHIVE_FAILED",
          error: JSON.stringify({
            phase: "RECOVERY",
            message: "Server restarted, rclone job state unknown",
          }),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(jobs.id, job.id));
    }
  }

  // QUEUED jobs — start the first one if nothing is ARCHIVING
  await startNextQueued();

  // COMPLETED with staging dir still present — clean up
  const completed = await db
    .select()
    .from(jobs)
    .where(eq(jobs.status, "COMPLETED"));
  for (const job of completed) {
    await cleanupStaging(job.id);
  }
}
```

---

## Route Structure

```
app/
  routes/
    _layout.tsx          ← shared nav (Upload / Archive / Jobs)
    _layout._index.tsx   ← Upload: drag-and-drop zone, destination path input
    _layout.archive.tsx  ← Browse: file tree of encrypted archive
    _layout.jobs.tsx     ← Job queue with progress, errors, retry buttons
  db/
    schema.ts            ← Drizzle schema (one table)
    client.server.ts     ← SQLite connection
  lib/
    archiver.server.ts   ← startOrQueueArchive, startArchiveJob
    jobWatcher.server.ts ← watchJob, startNextQueued, verifyArchive
    rclone.server.ts     ← fetch helpers for rclone RC API
    startup.server.ts    ← recoverOrphanedJobs
```

---

## rclone RC API Endpoints Used

| Endpoint              | Method | Purpose                                          |
| --------------------- | ------ | ------------------------------------------------ |
| `operations/copyfile` | POST   | Copy staged file → encrypted B2 remote           |
| `operations/list`     | POST   | List files/dirs in the archive (decrypted names) |
| `core/stats`          | POST   | Transfer speed, bytes transferred, ETA           |
| `job/status`          | POST   | Check if an async job is finished/errored        |

All calls go to `http://localhost:5572`. No auth needed (localhost-only, `--rc-no-auth`).

---

## Deployment

Two systemd services (or Docker Compose):

```bash
# rclone daemon
rclone rcd \
  --rc-addr localhost:5572 \
  --rc-no-auth \
  --config /path/to/rclone.conf

# React Router app (runs DB migrations on start, then recoverOrphanedJobs)
node build/server/index.js
```

Only the React Router port is reachable over Tailscale.

---

## Staging Directory

```
/data/staging/
  a1b2c3d4-xxxx/
    Going Postal.m4b       ← deleted on COMPLETED
  e5f6g7h8-xxxx/
    Night Watch.m4b
```

No manifest files — all state is in SQLite.

---

## Intentionally Excluded from v1

- **Auth**: Private Tailscale network.
- **Download/restore**: Stays CLI per existing plan.
- **Batch archive**: v1 processes the queue serially. Batch drag-and-drop queues them up automatically.
- **Deletion from archive**: Not exposed in UI. Use rclone CLI.
