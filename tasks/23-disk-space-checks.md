# Task 23: Disk Space Checks

## Problem

- No check for available disk space before upload
- Full disk during streaming write causes failures
- Need headroom for staging + uploaded file

## Solution

Create disk server utility to check available space before accepting upload.

## Steps

1. Create `app/lib/disk.server.ts`:
   ```ts
   import { execSync } from "node:child_process";
   import os from "node:os";
   
   export function getAvailableDiskSpaceBytes(dir: string): number {
     if (os.platform() === "win32") {
       const drive = dir.charAt(0);
       const output = execSync(
         `powershell -Command "(Get-PSDrive ${drive}).Free"`,
         { encoding: "utf-8" },
       );
       return parseInt(output.trim(), 10);
     }
   
     const output = execSync(`df -B1 --output=avail "${dir}" | tail -1`, {
       encoding: "utf-8",
     });
     return parseInt(output.trim(), 10);
   }
   ```

2. In upload route action:
   - Before accepting upload, call `getAvailableDiskSpaceBytes(config.dataDir)`
   - Reject with 507 (Insufficient Storage) if space < `sizeBytes * 2`
   - Use `sizeBytes` from Content-Range header or probe upload stream

## Files to Create
- `app/lib/disk.server.ts`

## Files to Modify
- Upload route action

## References
- PRD Section 6c: Disk Space Checks