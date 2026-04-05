# Task 24: Stale Job Cleanup Timer

## Problem

- PRD specifies 7-day cleanup for stale jobs
- No automatic way to mark abandoned jobs
- Staging directories can accumulate orphaned files

## Solution

Add periodic cleanup timer that marks old non-terminal jobs as ABANDONED.

## Steps

1. Create `app/lib/cleanup.server.ts`:
   - Import db, jobs, config, logger
   - Define TERMINAL_STATUSES = ["COMPLETED", "UPLOAD_FAILED", "ABANDONED"]
   - Export startCleanupTimer() function
   - Use setInterval to run every 6 hours
   - Query for jobs where updatedAt > ABANDONED_JOB_DAYS and status not in terminal
   - For each stale job:
     - Update status to ABANDONED
     - Set error JSON with phase and message
     - Clean staging directory with fsp.rm
   - Log summary of abandoned jobs

2. Integrate into startup:
   - Call startCleanupTimer() in server boot
   - Store timer ID for cleanup on shutdown

3. Config already has abandonedJobDays from task 17

## Files to Create
- `app/lib/cleanup.server.ts`

## Files to Modify
- `app/lib/startup.server.ts` or server entry

## Dependencies
- None (uses built-in setInterval)

## References
- PRD Section 6d: Stale job cleanup (ABANDONED)