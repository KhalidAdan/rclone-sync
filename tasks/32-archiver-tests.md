# Task 32: Archiver Module Tests

## Problem

- No tests for start vs queue logic
- No tests for retry behavior
- Critical code path has no coverage

## Solution

Write unit tests for archiver.server.ts using test helpers.

## Tests to Write

1. Happy path - STAGED → ARCHIVING:
   - Insert STAGED job
   - Call startOrQueueArchive
   - Verify status changed to ARCHIVING
   - Verify rclone job ID set

2. Queue logic - second job gets QUEUED:
   - Insert ARCHIVING job (simulating active work)
   - Insert STAGED job
   - Call startOrQueueArchive on STAGED job
   - Verify second job status is QUEUED

3. Retry behavior:
   - Insert job with ARCHIVE_FAILED status
   - Call retry function
   - Verify retryCount increments
   - Verify status goes back to STAGED or ARCHIVING

4. Staging cleanup:
   - After successful archive, verify staging dir removed

## Files to Create
- `tests/lib/archiver.test.ts`

## Dependencies
- Vitest
- Task 28 (test db helper)
- Task 29 (rclone mock)
- Task 30 (DI refactor must be done first)

## References
- PRD Section 5f: What to test - archiver.server.ts