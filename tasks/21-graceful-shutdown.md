# Task 21: Graceful Shutdown Handler

## Problem

- No handling for SIGTERM/SIGINT signals
- Active watchers don't clean up properly
- Jobs left in undefined state on process exit

## Solution

Add graceful shutdown handler that lets active work complete before exit.

## Steps

1. Create `app/lib/shutdown.server.ts`:
   - Import logger from `@/lib/logger.server`
   - Export isShuttingDown variable (initially false)
   - Export isShutdown() function
   - Implement setupGracefulShutdown(cleanup) that:
     - Sets isShuttingDown flag on signal
     - Logs shutdown message
     - Calls cleanup function (close DB, clear timers)
     - Exits with code 0

2. Integrate into startup/server boot:
   - Import setupGracefulShutdown
   - Provide cleanup function that:
     - Closes DB connection
     - Clears jobWatcher interval
     - Optionally marks ARCHIVING jobs as needing recovery

3. Test graceful shutdown:
   - Send SIGTERM/SIGINT to process
   - Verify cleanup runs before exit

## Files to Create
- `app/lib/shutdown.server.ts`

## Files to Modify
- `app/lib/startup.server.ts` or server entry point

## Dependencies
- None (uses built-in process signals)

## References
- PRD Section 6a: Graceful Shutdown