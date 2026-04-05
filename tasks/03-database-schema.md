# Task 3: Database Schema

## Description

Create the Drizzle ORM schema for the jobs table in `app/db/schema.ts`.

## Implementation

Create `app/db/schema.ts` with the following columns:

- `id` (text, primary key) - UUID
- `filename` (text, not null) - Original filename
- `sizeBytes` (integer, not null) - File size in bytes
- `destinationPath` (text, not null, default "") - Destination path in archive
- `status` (text, not null) - One of: UPLOADING, STAGED, QUEUED, ARCHIVING, VERIFYING, COMPLETED, UPLOAD_FAILED, ARCHIVE_FAILED, VERIFY_FAILED, ABANDONED
- `rcloneJobId` (integer) - rclone async job ID
- `error` (text) - JSON string with error details
- `retryCount` (integer, default 0) - Number of retry attempts
- `createdAt` (text, not null) - ISO 8601 timestamp
- `updatedAt` (text, not null) - ISO 8601 timestamp
