# Task 20: UI Updates for Job State Transitions

## Problem

- PRD specifies `<meta httpEquiv="refresh">` polling
- App currently only logs state changes
- User sees nothing in UI during archive operations
- No visual feedback for job status

## Solution

Update jobs route to show live progress with meta refresh polling.

## Steps

### 4a: Update jobs loader to merge live rclone stats

1. Modify `app/routes/_layout.jobs.tsx` loader:
   - Import `config` from `@/lib/config.server`
   - Find any ARCHIVING job
   - Fetch `POST ${config.rcloneUrl}/core/stats` with timeout
   - Merge liveProgress into return data with bytesTransferred, totalBytes, speed, eta, percentage

### 4b: Create JobCard component with visual state

1. Create or update `app/components/JobCard.tsx`:
   - Define STATUS_DISPLAY map with labels, colors, animate flags
   - Implement isRetryable() for ARCHIVE_FAILED/VERIFY_FAILED
   - Show status with appropriate color (blue for active, green for complete, red for failed)
   - Add pulse animation for active states
   - Show retry button for retryable statuses

### 4c: Auto-refresh when jobs are active

1. In jobs route component:
   - Check if any job has active status: UPLOADING, STAGED, QUEUED, ARCHIVING, VERIFYING
   - If active work exists, render `<meta httpEquiv="refresh" content={String(config.uiRefreshIntervalSec)} />`
   - Use config value from env (default 3 seconds)

### 4d: Redirect to jobs after upload

1. In upload route action:
   - After successful DB insert, return `redirect("/jobs")` instead of staying on upload page
   - User immediately sees their job status

## Files to Modify
- `app/routes/_layout.jobs.tsx` - loader and component
- `app/components/JobCard.tsx` - create or update
- Upload route action (likely `app/routes/_layout._index.tsx`)

## Dependencies
- tailwind classes (existing)

## References
- PRD Section 4: UI Updates for Job State Transitions