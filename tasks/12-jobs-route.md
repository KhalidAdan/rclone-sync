# Task 12: Jobs Route

## Description

Create the jobs queue page with progress display in `app/routes/_layout.jobs.tsx`.

## Implementation

Create `app/routes/_layout.jobs.tsx`:

**Loader**:
- Queries all jobs from DB, ordered by updatedAt DESC
- Merges live rclone stats for ARCHIVING job via `core/stats`
- Returns { jobs, liveProgress }

**UI**:
- Renders job list with status indicators
- Shows progress bars for ARCHIVING/VERIFYING jobs
- Displays error messages for failed jobs
- Retry buttons for ARCHIVE_FAILED and VERIFY_FAILED states
- Uses `<meta httpEquiv="refresh" content="3">` when active jobs exist (React 19 hoists to head)
