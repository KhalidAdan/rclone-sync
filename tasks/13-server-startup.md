# Task 13: Server Startup Integration

## Description

Wire up database migrations and startup recovery to the React Router server.

## Implementation

- Add Drizzle migrations (create tables if not exist)
- Call `recoverOrphanedJobs()` from server entry point
- Ensure `/data` and `/data/staging` directories exist
- Verify rclone RC is reachable on startup and log warning if not

May require updates to:
- `app/entry.server.tsx` or new server entry
- Vite config for server initialization
