# Task 6: Archiver Module

## Description

Create the archiver module in `app/lib/archiver.server.ts`.

## Implementation

Create `app/lib/archiver.server.ts` with:

- `startOrQueueArchive(id)` - Checks if any job is ARCHIVING, queues if needed, or starts archive
- `startArchiveJob(id)` - Initiates rclone copyfile operation, updates DB to ARCHIVING, starts job watcher

Uses `db` from `~/db/client.server` and `jobs` from `~/db/schema`.
