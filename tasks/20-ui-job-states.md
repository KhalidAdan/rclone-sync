# Task 20: UI Updates for Job State Transitions

## Problem

- PRD specifies `<meta httpEquiv="refresh">` polling - janky, causes page flicker
- App only logs state changes server-side
- User sees nothing in UI during archive operations
- No traceable history of job events

## Solution

Use React Router's `useRevalidator` for smooth polling, show live progress, and track job history in relational table.

## Steps

### 4a: Add `job_events` table to schema

1. Update `app/db/schema.ts`:
   - Add `jobEvents` table with columns: `id` (PK), `jobId` (FK), `eventType`, `message`, `timestamp`

### 4b: Add refresh interval to config

1. Update `app/lib/config.server.ts`:
   - Add `uiRefreshIntervalSec` from env (default 3 seconds)

### 4c: Replace meta refresh with useRevalidator

1. In `app/routes/_layout.jobs.tsx`:
   - Import `useRevalidator` from react-router and `useEffect` from react
   - Add `useEffect` + `setInterval` to call `revalidator.revalidate()` every N seconds when active jobs exist
   - Remove `<meta httpEquiv="refresh">`

### 4d: Enhance live progress display

1. In jobs route loader:
   - Fetch rclone stats (already done)
   - Include `totalBytes` from job for percentage calculation

2. In jobs route component:
   - Show bytes transferred / total bytes
   - Show speed (KB/s or MB/s)
   - Show ETA
   - Show percentage with progress bar

### 4e: Log history events in archiver

1. Update `app/lib/archiver.server.ts`:
   - Add helper to insert job events
   - Log "queued" event when job is queued
   - Log "archiving" event when copy starts

### 4f: Log history events in job watcher

1. Update `app/lib/jobWatcher.server.ts`:
   - Add helper to insert job events
   - Log "verifying" event when archive copy completes
   - Log "completed" event when verification succeeds
   - Log "failed" event when archive or verification fails

### 4g: Log created event on upload

1. Update `app/routes/_layout._index.tsx`:
   - Import `jobEvents` from schema
   - Insert "created" event when file is uploaded
   - Insert "failed" event if upload fails

### 4h: Create JobTimeline component (inlined)

1. In `app/routes/_layout.jobs.tsx`:
   - Query all job events ordered by timestamp
   - Add "Show details" / "Hide details" toggle per job
   - Latest job expanded by default
   - Render vertical timeline with icons per event type

### 4i: Redirect after upload

1. In `app/routes/_layout._index.tsx`:
   - Return `redirect("/jobs")` after successful upload
   - User immediately sees job status with history

## Files Modified

- `app/db/schema.ts` - added job_events table
- `app/lib/config.server.ts` - added uiRefreshIntervalSec
- `app/routes/_layout.jobs.tsx` - useRevalidator + timeline + progress
- `app/routes/_layout._index.tsx` - redirect to jobs + log events
- `app/lib/archiver.server.ts` - log queued/archiving events
- `app/lib/jobWatcher.server.ts` - log verifying/completed/failed events

## Dependencies

- `@heroicons/react` (existing)
- tailwind classes (existing)
- DB migration for job_events table

## Event Types

| Event     | Icon                              | Description                    |
|-----------|-----------------------------------|--------------------------------|
| created   | CloudArrowUpIcon                  | File uploaded                  |
| queued    | ClockIcon                         | Waiting for rclone             |
| archiving | ArrowRightOnRectangleIcon        | Copy in progress              |
| verifying | ClipboardDocumentCheckIcon       | Verifying archive             |
| completed | CheckCircleIcon                  | Job done                      |
| failed    | XCircleIcon                       | Job failed                    |
| retried   | ArrowPathIcon                    | Job retried                   |
