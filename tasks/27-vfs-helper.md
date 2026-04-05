# Task 27: VFS Test Helper

## Problem

- Testing filesystem operations against real FS is slow/fragile
- Leaves artifacts in project directory
- Mocking node:fs is tedious

## Solution

Create test helper using @platformatic/vfs for virtual filesystem.

## Steps

1. Install dependency:
   ```bash
   npm install --save-dev @platformatic/vfs
   ```

2. Create `tests/helpers/vfs.ts`:
   ```ts
   import { create } from "@platformatic/vfs";
   
   export function createTestVfs() {
     const vfs = create({ overlay: true });
     vfs.mkdirSync("/data/staging", { recursive: true });
     vfs.mount("/data/staging");
   
     return {
       vfs,
       stageFile(jobId: string, filename: string, content: string | Buffer = "fake audio data") {
         const dir = `/data/staging/${jobId}`;
         vfs.mkdirSync(dir, { recursive: true });
         vfs.writeFileSync(`${dir}/${filename}`, content);
       },
       assertCleaned(jobId: string): boolean {
         try {
           vfs.readdirSync(`/data/staging/${jobId}`);
           return false;
         } catch {
           return true;
         }
       },
       teardown() {
         vfs.unmount();
       },
     };
   }
   ```

3. Use in tests:
   ```ts
   const testVfs = createTestVfs();
   // ... run tests
   testVfs.teardown();
   ```

## Files to Create
- `tests/helpers/vfs.ts`

## Dependencies
- @platformatic/vfs

## References
- PRD Section 5a: VFS helper for staging directory tests