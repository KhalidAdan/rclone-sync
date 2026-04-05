# Task 22: Request Size Limits

## Problem

- Audiobooks can be large (500MB–2GB)
- No upper bound on upload size
- Malformed request could fill the disk

## Solution

Add MAX_UPLOAD_SIZE check before streaming to disk.

## Steps

1. Add to `app/lib/env.server.ts`:
   ```ts
   MAX_UPLOAD_SIZE: z.coerce.number().int().positive().default(4 * 1024 * 1024 * 1024), // 4 GB
   ```

2. Add to `app/lib/config.server.ts`:
   ```ts
   maxUploadSize: process.env.MAX_UPLOAD_SIZE,
   ```

3. In upload route action:
   - Check `Content-Length` header before streaming
   - If exceeds config.maxUploadSize, reject with 413 status:
     ```ts
     if (Number(request.headers.get("content-length")) > config.maxUploadSize) {
       return new Response("File too large", { status: 413 });
     }
     ```
   - Do this check early, before any file I/O

## Files to Modify
- `app/lib/env.server.ts` (if adding env var)
- `app/lib/config.server.ts` (if adding derived value)
- Upload route action (likely `app/routes/_layout._index.tsx`)

## References
- PRD Section 6b: Request Size Limits