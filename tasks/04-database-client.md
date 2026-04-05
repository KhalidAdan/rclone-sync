# Task 4: Database Client

## Description

Create the Drizzle SQLite client in `app/db/client.server.ts`.

## Implementation

Create `app/db/client.server.ts` that:
- Connects to SQLite at `/data/audiobook-archive.db`
- Exports the typed `db` instance for queries
- Ensures the `/data` and `/data/staging` directories exist on startup
