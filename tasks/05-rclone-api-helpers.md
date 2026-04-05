# Task 5: rclone API Helpers

## Description

Create helper functions for the rclone RC API in `app/lib/rclone.server.ts`.

## Implementation

Create `app/lib/rclone.server.ts` with functions for:

- `copyFile(srcFs, srcRemote, dstFs, dstRemote)` - Returns jobid for async operation
- `listFiles(fs, remote)` - Lists files in a directory
- `getJobStatus(jobid)` - Gets async job status
- `getStats()` - Gets current transfer stats

All functions should POST JSON to `http://localhost:5572`.
