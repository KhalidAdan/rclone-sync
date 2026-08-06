# Feature Inventory

_Audit date: 2026-08-06. Reflects the working tree (uncommitted changes included)._

## What the app does today

A single-process React Router v7 app that receives Audible `.aax` files, decrypts
them to `.m4b`, archives the original AAX to an encrypted Backblaze B2 bucket via
`rclone rcd`, and lets you download the decrypted M4Bs. State lives in SQLite
(Drizzle). One archive transfer runs at a time; the rest queue.

### Upload & staging
- Drag-and-drop or file-picker upload of one or more `.aax` files (`DropZone`).
- Client-side `.aax` filter, plus server-side extension check.
- Sequential client uploads via XHR with per-file upload percentage.
- Server streams multipart body straight to `data/staging/<jobId>/<filename>`
  using `@culvert/stream` (`pipe` → `tap` progress observer → `writeTo`),
  never buffering the file in memory. 1.5 GB max per file.
- Job row created at `UPLOADING`, flips to `STAGED` with final byte count.
- Optional free-text "destination path" applied to the B2 remote path.

### Decode (AAX → M4B)
- Background pipeline (`processJob`) spawns `ffmpeg -activation_bytes … -c copy`
  to strip Audible DRM into an M4B in the same staging dir.
- Activation bytes come from `ACTIVATION_BYTES` env.
- Status transitions `DECODING → DECODED`; failures record `DECODE_FAILED`
  with the last 2000 chars of ffmpeg stderr.

### Archive to B2 (via rclone rcd)
- `operations/copyfile` (async) copies the **original AAX** from staging to the
  `audiobooks:` crypt remote (rclone handles encryption, chunking, retries).
- Single-flight: if a job is `ARCHIVING`, new jobs become `QUEUED`; a watcher
  starts the next queued job on completion.
- `watchJob` polls `job/status` every 5 s until the rclone job finishes.
- Verification: after copy success, `operations/list` on the destination dir
  confirms the filename exists → `COMPLETED`, else `VERIFY_FAILED`.
- Cleanup after completion: AAX deleted from staging (M4B kept until
  downloaded); if already downloaded, entire staging dir removed.

### Downloads (M4B retrieval)
- `/api/download-selected?ids=…` — ZIP of chosen jobs' M4Bs (npm `archiver`).
- `/api/download-all` — ZIP of every not-yet-downloaded M4B, streamed with
  `@culvert/zip` `createZip`; jobs marked `downloadedAt` only if the client
  drains the whole stream (`onSuccessfulDrain`).
- Downloaded + completed jobs get their staging dir cleaned up.

### Jobs page
- Paginated (20–50/page), grouped-by-status tables with expandable per-job
  event timelines (`job_events` audit trail: created/decoding/…/failed).
- Live-ish progress banner for the active archive using rclone `core/stats`.
- Retry action for `DECODE_FAILED` / `ARCHIVE_FAILED` / `VERIFY_FAILED`;
  abandon action exists in the backend (`ABANDONED` status).
- Batch download selection with select-all-downloadable.
- Auto-revalidates every `UI_REFRESH_INTERVAL_SEC` (default 3 s) while any
  job is active.

### Archive browser
- Read-only directory listing of the B2 crypt remote via rclone
  `operations/list`, with folder navigation, size and date formatting.

### Infrastructure
- Zod-validated env (`env.server.ts`) with typed `process.env`.
- Leveled JSON-ish logger with `LOG_LEVEL`.
- SQLite WAL mode; Drizzle migrations in `drizzle/`.
- Dockerfile (multi-stage) + `db:push` on container start. **(Broken — see
  audit: no ffmpeg, no drizzle config in image.)**
- Startup recovery module for orphaned jobs. **(Dead code — never invoked;
  see audit finding A1.)**

## Job state machine (as implemented)

```
UPLOADING → STAGED → DECODING → DECODED → (QUEUED →) ARCHIVING → VERIFYING → COMPLETED
     ↓          ↓         ↓                                ↓            ↓
UPLOAD_FAILED  (stuck)  DECODE_FAILED              ARCHIVE_FAILED  VERIFY_FAILED
                                                          ↘  retry → STAGED (!)
any failed state → ABANDONED (backend only)
```

Note: the retry path re-enters at `STAGED`, which is a lie about what will
happen next (see audit finding B6).

## What it does *not* do (relevant to the end goal)

- **The decoded M4B is never archived to B2.** Only the DRM'd AAX master is.
  M4Bs exist transiently in staging and are deleted after download. Streaming
  playback "from B2" is impossible with the current data layout.
- No playback, no metadata (title/author/cover), no chapters.
- No download/restore *from* B2 through the UI (archive browser is look-only).
- No auth (assumes Tailscale perimeter).
- No deletion, rename, or move of archived files.
