# Task 7: Job Watcher

## Description

Create the job watcher module in `app/lib/jobWatcher.server.ts`.

## Implementation

Create `app/lib/jobWatcher.server.ts` with:

- `watchJob(id, rcloneJobId)` - Polls rclone job status every 5 seconds, updates DB on completion/failure, transitions to VERIFYING or ARCHIVE_FAILED
- `verifyArchive(id)` - Calls rclone operations/list to verify file exists in remote
- `cleanupStaging(id)` - Removes staging directory for completed job
- `startNextQueued()` - Finds oldest QUEUED job and starts it

Handles state transitions per the PRD state machine.
