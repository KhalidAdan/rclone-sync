# Task 18: Hardcoded Path Audit and Fixes

## Problem

OS-aware path logic is fragile:
- `process.env.NODE_ENV === "production" ? "/data/..." : "./data/..."` assumes prod = Linux, dev = Windows
- Hardcoded forward-slash path joins like `'./data/staging'` scattered in code

## Solution

Audit and replace all hardcoded paths with config-based paths using `path.join()`.

## Steps

1. Run grep commands to find hardcoded paths:
   ```bash
   grep -rn "'/data/" app/
   grep -rn '`/data/' app/
   grep -rn "staging/" app/lib/
   ```

2. For each found instance:
   - Import `config` from `@/lib/config.server`
   - Replace with `path.join(config.stagingDir, id)` or similar
   - Ensure `import path from "node:path"` is present

3. Common replacements:
   - `./data/staging` → `config.stagingDir`
   - `./data/audiobook-archive.db` → `config.dbPath`
   - `/data/staging` → `config.stagingDir`
   - Any string concatenation with `/` → `path.join()`

4. Verify no path.join calls use hardcoded `/` as separator

## Files to Modify
- Likely candidates based on codebase scan:
  - `app/lib/archiver.server.ts`
  - `app/lib/jobWatcher.server.ts`
  - `app/routes/_index.tsx` (upload handler)
  - Any other files using staging/db paths

## References
- PRD Section 2: OS-Aware Paths
- Task 17: Config Module