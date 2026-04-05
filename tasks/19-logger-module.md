# Task 19: Logger Module - logger.server.ts

## Problem

- `console.log` scattered everywhere
- No way to control verbosity
- No structured output for production

## Solution

Create lightweight logger wrapper with level filtering and structured context.

## Steps

1. Create `app/lib/logger.server.ts`:
   - Import `config` from `@/lib/config.server`
   - Define LEVELS const: { debug: 0, info: 1, warn: 2, error: 3 }
   - Implement shouldLog(level) to check against currentLevel
   - Implement formatMessage() with ISO timestamp, level, message, optional ctx JSON
   - Export logger object with debug/info/warn/error methods

2. Replace console.log/console.error calls throughout codebase:
   - `config.server.ts` - log resolved config on startup
   - `archiver.server.ts` - info: job started, queued; debug: rclone requests
   - `jobWatcher.server.ts` - info: job completed/failed; debug: poll ticks
   - `startup.server.ts` - warn: orphaned jobs, info: startup complete
   - Route actions - info: upload received, error: failures
   - `rclone.server.ts` - debug: every RC call

3. Ensure LOG_LEVEL is respected in all environments

## Files to Create
- `app/lib/logger.server.ts`

## Files to Modify
- Any file using console.log/error/warn/info

## References
- PRD Section 3: Logging with LOG_LEVEL