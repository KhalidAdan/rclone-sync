# Task 16: Use Environment Variables for rclone Configuration

## Problem

The rclone remote name and bucket are hardcoded in multiple files:
- `app/lib/archiver.server.ts` - uses `"remote:khld-audiobooks"`
- `app/lib/jobWatcher.server.ts` - uses `"remote:khld-audiobooks:"`
- `app/routes/_layout.archive.tsx` - uses `"remote:khld-audiobooks:"`

This makes it difficult to:
- Switch between different B2 buckets
- Change the remote name without code changes
- Configure differently for dev vs prod

## Solution

Use environment variables to configure:
- `RCLONE_REMOTE` - the remote name (e.g., "remote")
- `RCLONE_BUCKET` - the bucket name (e.g., "khld-audiobooks")

Then construct the fs path dynamically in code.

## Implementation

1. Add environment variables to:
   - `.env` for local development
   - Docker container for production
   - deployment docs

2. Update code to read env vars:
   ```ts
   const RCLONE_REMOTE = process.env.RCLONE_REMOTE || "remote";
   const RCLONE_BUCKET = process.env.RCLONE_BUCKET || "khld-audiobooks";
   const fsPath = `${RCLONE_REMOTE}:${RCLONE_BUCKET}`;
   ```

3. Files to modify:
   - `app/lib/archiver.server.ts`
   - `app/lib/jobWatcher.server.ts`
   - `app/routes/_layout.archive.tsx`

## References

- Task 15: Fix Verification Fails with B2 Application Keys
- PRD: Configuration Management section
