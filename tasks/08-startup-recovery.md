# Task 8: Startup Recovery

## Description

Create startup recovery module in `app/lib/startup.server.ts`.

## Implementation

Create `app/lib/startup.server.ts` with:

- `recoverOrphanedJobs()` - Called on server startup:
  - Queries all ARCHIVING jobs, checks if rclone job still running
  - If still running, re-attaches watcher
  - If finished while server was down, processes result
  - If unknown, marks as ARCHIVE_FAILED
  - Starts first QUEUED job if nothing is ARCHIVING
  - Cleans up staging dirs for COMPLETED jobs
