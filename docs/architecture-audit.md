# Architecture Audit

_Audit date: 2026-08-06, against the working tree (uncommitted changes included).
Severity: 🔴 breaks correctness/production, 🟠 will bite soon, 🟡 smell/debt._

## A. Deployment & process-lifecycle (the big ones)

### A1 🔴 Crash recovery and config validation are dead code
`recoverOrphanedJobs()` ([startup.server.ts](../app/lib/startup.server.ts)) and
`validateConfig()` ([config.server.ts:29](../app/lib/config.server.ts)) are
exported but **never called from anywhere**. Consequences:

- Any restart strands jobs in `UPLOADING` / `DECODING` / `ARCHIVING` /
  `VERIFYING` forever — the `watchJob` `setInterval` lives only in process
  memory.
- The app never fails fast when rclone is unreachable; you find out on first
  upload.
- The jobs-page loader side effect (A2) exists as a partial workaround.

**Fix:** call both once at server boot. React Router v7 gives you a clean spot:
a module-scope call in a `.server` module imported by `root.tsx`, or better, a
custom `entry.server.tsx` / server entry that awaits
`validateConfig().then(recoverOrphanedJobs)` before accepting traffic. Also
note the recovery logic itself has a hole: recovered `ARCHIVING` jobs whose
rclone job already finished successfully are set to `VERIFYING` but nothing
then runs verification — they'd strand there.

### A2 🔴 GET loader mutates state and can skip the decode step
[_layout.jobs.tsx:117-120](../app/routes/_layout.jobs.tsx) — the jobs page
loader calls `startOrQueueArchive(stagedJobs[0].id)`. Two problems:

1. A GET that mutates: every page view / 3-second revalidation is a potential
   state transition. Prefetching or a second tab can race the real pipeline.
2. It's *wrong* for what STAGED now means. Since the decode step was added,
   `STAGED` = "uploaded, not yet decoded". Kicking a stale STAGED job straight
   to archive skips decode entirely: the AAX gets archived, verify passes,
   `COMPLETED` — and no M4B ever exists, so downloads silently skip the book.

**Fix:** delete the side effect; A1's recovery is the correct owner of "resume
stale jobs" (and it should route STAGED jobs through `processJob`, not
`startOrQueueArchive`).

### A3 🔴 Dockerfile cannot run this app
- **No ffmpeg** in the runtime image (`node:20-alpine`) → every decode fails.
  (Already on your TODO.)
- `CMD npm run db:push` needs `drizzle-kit`, `drizzle.config.ts`, and
  `app/db/schema.ts` — only the two package dirs are copied; the config and
  schema aren't in the image, and drizzle-kit's transitive deps/bin links
  aren't either.
- `EXPOSE 3001` but `react-router-serve` defaults to PORT 3000; nothing sets
  `PORT` in the image.

**Fix:** `apk add --no-cache ffmpeg`; run migrations with plain
`drizzle-orm/migrator` at app startup (drop drizzle-kit from the image
entirely — you already ship `drizzle/*.sql`); set `ENV PORT=3001`; add a
`HEALTHCHECK` that hits a route which also pings rclone.

### A4 🔴 Phantom dependency: `@heroicons/react`
[JobHistory.tsx:9](../app/components/JobHistory.tsx) imports it, but it's not
in `package.json` — it resolves by accident from a stray `E:\CODE\node_modules\`
*above* the repo. Fresh clone and the Docker build both fail.
**Fix:** `npm i @heroicons/react` (or inline the 7 SVGs and drop the dep).
Related: `uuid` + `@types/uuid` are declared but unused (`node:crypto
randomUUID` is used instead) — remove them.

## B. Pipeline correctness

### B1 🔴 `ffmpeg` without `-y` makes decode retries always fail
[decoder.server.ts](../app/lib/decoder.server.ts) — ffmpeg writes the M4B
progressively; a failed/interrupted decode leaves a partial output file. On
retry, ffmpeg prompts "File exists. Overwrite?", gets EOF on stdin, and exits
non-zero. Every retry of `DECODE_FAILED` is doomed until someone deletes the
partial file by hand. **Fix:** add `-y` (and consider `-nostdin`).

### B2 🟠 Single-flight archive is check-then-act
[archiver.server.ts:22-38](../app/lib/archiver.server.ts) — `SELECT … WHERE
status='ARCHIVING'` then act. Two decodes finishing near-simultaneously both
see zero active and both start rclone copies. Same TOCTOU exists between the
watcher's `startNextQueued()` and a fresh upload. Practically rare
(single-user), but the invariant the whole design leans on is unenforced.
**Fix:** one `UPDATE jobs SET status='ARCHIVING' WHERE id=? AND NOT EXISTS
(SELECT 1 FROM jobs WHERE status='ARCHIVING')` in a transaction — claim first,
then call rclone; or an in-process promise-chain queue since this is a
single-process app.

### B3 🟠 Watcher: one transient error kills the job; ticks can overlap
[jobWatcher.server.ts:101-115](../app/lib/jobWatcher.server.ts)
- Any thrown error in the poll (rclone momentarily down, one network blip)
  marks the job `ARCHIVE_FAILED` — while the actual rclone copy may be
  happily proceeding to success.
- `setInterval` with an async body: if a tick takes > 5 s, ticks overlap. Two
  ticks can both observe `finished`, double-run verify/cleanup and
  `startNextQueued()` twice — which then violates single-flight (B2).

**Fix:** replace `setInterval` with a `setTimeout` loop (no overlap by
construction); tolerate N consecutive poll failures before failing the job;
add a max-age circuit breaker.

### B4 🟠 Retry semantics are muddled
[_layout.jobs.tsx:194-213](../app/routes/_layout.jobs.tsx) — every retry sets
status to `STAGED`, then branches. `STAGED` is false for archive retries (the
M4B exists, decode is done), and if `startOrQueueArchive` throws, the job
parks in `STAGED` where the A2 side effect will later archive it *without
decode being re-verified*. **Fix:** retries should re-enter the state machine
at the failed step (`DECODE_FAILED → DECODING`, `ARCHIVE_FAILED/VERIFY_FAILED
→ QUEUED`), and the transition should be encoded in one place (see D1).

### B5 🟠 Upload aborts leave permanent zombies
[api.upload.ts](../app/routes/api.upload.ts) — on abort the partial file is
unlinked (good) but the job row stays `UPLOADING` forever (recovery is dead,
and even the recovery module doesn't handle `UPLOADING`/`STAGED`). The empty
staging dir also remains. **Fix:** mark `UPLOAD_FAILED` in the catch; have
recovery sweep `UPLOADING` rows older than a threshold.

### B6 🟡 Verification is name-only
`verifyArchive` checks the filename appears in a listing. rclone already did
checksum verification during copy, so this mostly guards against "wrong
destination" — but it can't catch truncation and it double-lists on every
job. Consider `operations/stat` (one call, exact file) and comparing size;
long-term `operations/hashsum` for a real integrity check.

## C. Streaming & the download endpoints

### C1 🔴 `download-selected` buffers whole ZIPs in memory and deletes files before the client has them
[api.download-selected.ts](../app/routes/api.download-selected.ts):
- `archive.on("data", chunk => controller.enqueue(chunk))` with no reader
  attached yet → the **entire multi-GB ZIP** accumulates in the stream queue
  before the Response is even constructed (`await finalize`/`close` completes
  first). This is an OOM machine.
- It waits on archiver's `close` event, which is not a documented archiver
  completion event (`end`/`finish` are) — works by luck of Node stream
  destroy semantics.
- `resolveStream(controller as any)` resolves a promise nobody consumes, with
  the wrong type. Dead confusion.
- `downloadedAt` is set and `cleanupFull` runs **before** the response begins
  streaming — a failed download destroys the only local copy of the M4B while
  recording it as delivered. `download-all` gets these exact semantics right
  with `onSuccessfulDrain`; this endpoint contradicts it.

**Fix (and culvert win):** delete ~70 lines. Make `download-selected` share
`download-all`'s implementation: one `zipOfJobs(jobs: Job[])` helper using
`createZip` + `onSuccessfulDrain`, with `download-all` = `zipOfJobs(all ready)`.
Drop the npm `archiver` + `@types/archiver` dependencies entirely.

### C2 🟠 `download-all` deflates already-compressed audio
[api.download-all.ts:89-100](../app/routes/api.download-all.ts) — culvert's
`createZip` defaults to `deflate`; your own design doc (updates.md) says
"store mode, no compression". M4B/AAC won't shrink; you pay CPU and latency
for nothing. **Fix:** `compression: "store"` per entry.

### C3 🟡 Upload stream ignores client aborts mid-pipe
The culvert upload pipe handles errors well, but doesn't wire
`request.signal`. `abortable(fromReadableStream(source), request.signal)`
gives deterministic teardown on disconnect instead of relying on the
ReadableStream erroring. (Also pairs with fixing B5.)

## D. Code organization & smells

### D1 🟡 The state machine exists only as string writes scattered across 6 files
Every transition is an ad-hoc `db.update(jobs).set({status: …})` plus a
hand-rolled `logJobEvent` — which is **copy-pasted in four files**
(api.upload, pipeline, archiver, jobWatcher) with the event-type union
retyped each time (`types.ts` already exports `JobEventType` — unused there).
There is no guard against illegal transitions (see A2/B4 for the resulting
bugs). **Fix:** one `transition(jobId, from[], to, message)` function in a
`jobs.server.ts` that (a) validates the edge, (b) writes status + event in one
transaction, (c) is the only code allowed to touch `jobs.status`.

### D2 🟡 `jobEvents.jobId` has no index and no FK
Every jobs-page load does `WHERE job_id IN (…)` over a full scan; events for
deleted jobs would orphan. Add an index (and `references(() => jobs.id)`).

### D3 🟡 Status-order duplication
The CASE expression in the jobs loader and the `statusOrder` object encode
the same ranking twice ([_layout.jobs.tsx:40-54, 82-96](../app/routes/_layout.jobs.tsx)).
Generate the SQL from the object.

### D4 🟡 Env/config drift
- `UI_REFRESH_INTERVAL_SEC` is read in config but absent from the Zod schema.
- The `ProcessEnv` augmentation claims `PORT: number` — `process.env` values
  are always strings; the type lies (z.coerce transforms the *parsed copy*,
  which is thrown away).
- `db/client.server.ts` runs `mkdir` + opens SQLite at import time (top-level
  await), duplicating `validateConfig`'s mkdir. Import-time side effects make
  build/typegen and tests touch the real filesystem.
**Fix:** parse once into an exported `env` object (`export const env =
envSchema.parse(process.env)`) and have config consume that instead of the
global type augmentation; keep import side effects to the db handle only.

### D5 🟡 Path handling trusts client input
- `filename` from the multipart part goes into `path.join(stagingDir, id,
  filename)` — a name like `..\evil.aax` escapes staging on Windows. Use
  `path.basename`.
- `destinationPath` is raw query text: `Fiction/Fantasy` (no trailing slash)
  silently produces `Fiction/FantasyBook.aax` in B2, and `../` walks up the
  remote. Normalize (strip leading slashes, collapse `..`, ensure exactly one
  trailing `/`).
- Bonus: verify (B6) then looks in the *directory* `destinationPath` and
  won't find the mis-joined file → confusing `VERIFY_FAILED`.

### D6 🟡 `JSON.parse(job.error)` un-guarded in render
[_layout.jobs.tsx:475](../app/routes/_layout.jobs.tsx) — one malformed error
string (e.g. hand-edited row, legacy format) 500s the whole jobs page. Wrap
it, or store structured error columns.

### D7 🟡 Dead/misleading bits
- `RcloneListEntry.Size: string` — rclone returns a number; `parseInt` happens
  to survive it. Type it `number`, drop the parse.
- `getStats()` return isn't validated; `data.error` isn't checked in
  `getJobStatus` (rclone errors surface as `success:false` with `error`, but
  a 404 job id returns an error body your code reads as `finished:false`
  forever → immortal watcher).
- `ACTIVATION_BYTES` is logged in cleartext at decode start; treat like a
  credential.
- `uploadProgress` logs progress as `created` events — event-type soup
  (`created` used for start, progress, staged, abort).
- Upload page loads 50 recent jobs and uses them only for a banner count.

## E. Where culvert should carry more weight

Today culvert is used in exactly two places (upload pipe, download-all zip) —
both good. The gaps:

1. **C1**: replace npm `archiver` with `createZip` (delete a dependency, fix
   an OOM bug, unify semantics). Highest-leverage, ~1 hour.
2. **SSE progress channel**: `channel()` + `toReadableStream` is a purpose-
   built fit for a `/api/events` SSE endpoint — the watcher/pipeline pushes
   `ChannelWriter.write(event)`, the route pipes it to the response. This
   kills the 3-second full-loader polling and is the foundation of the UX fix
   (see product-review.md).
3. **`abortable`** on the upload pipe (C3).
4. **Future — streaming playback**: `openZip`/`ZipSeekable`'s random-access
   pattern is the right mental model for Range-request streaming of M4Bs out
   of B2 via rclone; and an `@culvert/cipher` package (chunked AES-GCM
   `Transform<Uint8Array, Uint8Array>`) would let the app do end-to-end
   encryption in the pipe instead of trusting rclone's crypt layer — a
   flagship real-world culvert use case. (culvert's zip README explicitly
   refuses ZIP-native encryption — a standalone cipher transform is the
   composable answer.)

## F. Suggested fix order

| Order | Items | Effort | Outcome |
|---|---|---|---|
| 1 | A4, B1, C2 | minutes | builds anywhere; retries work; downloads fast |
| 2 | A1, A2, B5 | ~half day | restarts stop eating jobs; loaders pure |
| 3 | C1 (+drop archiver dep) | ~1 h | OOM fixed, one zip path, culvert-only |
| 4 | D1 (transition fn) + B4 | ~half day | state machine enforced, retries sane |
| 5 | B2, B3 | ~half day | single-flight + watcher robust |
| 6 | A3 Dockerfile | ~1 h | actually deployable |
| 7 | D2–D7 cleanup batch | ~half day | debt paid |

After 1–6 this is honestly deployable for personal production use.
