# Task 34: Startup Module Tests

## Problem

- No tests for orphan recovery
- No verification that startup logic handles edge cases

## Solution

Write unit tests for startup.server.ts.

## Tests to Write

1. Orphan recovery - ARCHIVING:
   - Mock DB with ARCHIVING job (simulating crash)
   - Mock rclone to not find the job or return failure
   - Run startup
   - Verify job status changed to ARCHIVE_FAILED

2. Orphan recovery - QUEUED:
   - Mock DB with QUEUED job
   - Run startup
   - Verify job status changed to ARCHIVING (start next)

3. Clean startup (no orphans):
   - Mock DB with all COMPLETED jobs
   - Run startup
   - Verify no status changes

4. rclone unavailable at startup:
   - Mock rclone to be unreachable
   - Run validateConfig()
   - Verify it throws appropriate error

## Files to Create
- `tests/lib/startup.test.ts`

## Dependencies
- Vitest
- Task 28 (test db helper)
- Task 29 (rclone mock)

## References
- PRD Section 5f: What to test - startup.server.ts