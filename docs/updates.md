# AAX Decoding Pipeline - Implementation Plan

## Architecture Overview

```
REQUEST 1: Upload                    REQUEST 2: Download
POST /api/upload                     GET /api/download-all
┌──────────────┐                     ┌──────────────────┐
│ Stream AAX   │                     │ Stream ZIP of all │
│ to staging   │                     │ undownloaded M4Bs │
│              │                     │ (store mode, no  │
│ Returns JSON │                     │  compression)    │
│ { jobId }    │                     │                  │
│              │                     │ Sets downloadedAt│
│ Triggers     │                     │ on each job      │
│ background   │                     └──────────────────┘
│ pipeline     │
└──────────────┘
       │
       ▼
  BACKGROUND PIPELINE (sequential, per job)
  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
  │ 1. Decode    │───▶│ 2. Archive   │───▶│ 3. Cleanup   │
  │ AAX → M4B   │    │ rclone AAX   │    │ delete AAX   │
  │ (FFmpeg)     │    │ to B2        │    │ from staging │
  │ -c copy      │    │              │    │              │
  │ (lossless)   │    │ (existing    │    │ M4B stays    │
  └──────────────┘    │  behavior)   │    │ until user   │
                      └──────────────┘    │ downloads    │
                                          └──────────────┘
```

## Status Flow

```
UPLOADING → STAGED → DECODING → DECODED → ARCHIVING → VERIFYING → COMPLETED
               │         │                     │            │
          UPLOAD_FAILED  DECODE_FAILED    ARCHIVE_FAILED  VERIFY_FAILED

Cleanup rules:
  - AAX deleted from staging when archive VERIFIED (after VERIFYING → COMPLETED)
  - M4B stays in staging until downloadedAt is set
  - Staging dir deleted when COMPLETED + downloadedAt is set
```

## Activation Bytes

Single env var: `ACTIVATION_BYTES=34033c09`

All AAX files from the same Audible account share the same activation bytes. The bytes are tied to the account, not individual files.

## Output Format

M4B with `-c copy` (lossless remux):
- Zero quality loss (bit-for-bit identical audio)
- Chapters preserved
- Cover art preserved
- All metadata preserved
- Faster than re-encoding to MP3

## Task Breakdown

### Task 1: Schema & Types
- Add statuses: `DECODING`, `DECODED`, `DECODE_FAILED`
- Add event types: `decoding`, `decoded`
- Add column: `downloadedAt` (nullable timestamp)
- Modified: `schema.ts`, `types.ts`

### Task 2: Environment & Config
- Add `ACTIVATION_BYTES` env var (required)
- Modified: `env.server.ts`, `config.server.ts`, `.env.example`

### Task 3: Decoder Module
- FFmpeg wrapper: `decodeAax(inputPath, outputPath, activationBytes)`
- Uses `ffmpeg -activation_bytes <bytes> -i <input> -c copy <output>`
- New file: `decoder.server.ts`

### Task 4: Pipeline Orchestrator
- `processJob(jobId)` - runs decode then archive sequentially
- New file: `pipeline.server.ts`

### Task 5: Refactor Upload Route
- Reject non-AAX files
- Extract staging logic
- Replace archive call with pipeline call
- Modified: `api.upload.ts`

### Task 6: Update Archiver
- Accept jobs in DECODED status
- Modified: `archiver.server.ts`

### Task 7: Update Job Watcher Cleanup
- Delete AAX after archive completes (keep M4B)
- Full cleanup only after both archive complete AND downloaded
- Modified: `jobWatcher.server.ts`

### Task 8: Update Startup Recovery
- Recover DECODING → DECODE_FAILED
- Recover DECODED → start archive
- Modified: `startup.server.ts`

### Task 9: Download All Endpoint
- GET /api/download-all
- Stream ZIP of all undownloaded M4Bs
- Set downloadedAt on each job after ZIP completes
- New file: `api.download-all.ts`
- Dependency: `archiver` npm package

### Task 10: Restrict DropZone
- Accept only .aax files
- Modified: `DropZone.tsx`

### Task 11: Jobs Page UI Updates
- Add status metadata for new statuses
- Make DECODE_FAILED retryable
- Add "Download All" button
- Modified: `_layout.jobs.tsx`, `_layout._index.tsx`

## Notes

- **No parallelism**: Jobs process strictly one at a time
- **FFmpeg**: Must be available on host (not in Docker by default)
- **Storage**: AAX deleted after archive, M4B stays until downloaded
