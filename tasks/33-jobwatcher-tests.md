# Task 33: JobWatcher Module Tests

## Problem

- No tests for poll → complete transition
- No tests for poll → fail transition
- No tests for starting next queued job

## Solution

Write unit tests for jobWatcher.server.ts.

## Tests to Write

1. Poll → complete transition:
   - Mock rclone to return finished: true, success: true
   - Insert ARCHIVING job
   - Run watcher poll
   - Verify status changed to VERIFYING or COMPLETED
   - Verify staging cleaned up

2. Poll → fail transition:
   - Mock rclone to return finished: true, success: false
   - Insert ARCHIVING job
   - Run watcher poll
   - Verify status changed to ARCHIVE_FAILED
   - Verify error recorded

3. Start next queued:
   - Insert ARCHIVING job that completes
   - Insert QUEUED job
   - Run watcher poll (after active completes)
   - Verify QUEUED job status changed to ARCHIVING

4. Orphan recovery (optional):
   - Insert ARCHIVING job with stale rcloneJobId
   - Run startup recovery
   - Verify job marked as ARCHIVE_FAILED

## Files to Create
- `tests/lib/jobWatcher.test.ts`

## Dependencies
- Vitest
- Task 28 (test db helper)
- Task 29 (rclone mock)
- Task 30 (DI refactor)

## References
- PRD Section 5f: What to test - jobWatcher.server.ts