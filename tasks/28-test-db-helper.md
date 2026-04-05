# Task 28: Test DB Helper - In-Memory SQLite

## Problem

- Tests share DB state with each other
- No clean isolation between tests
- Cleanup is manual and error-prone

## Solution

Create helper that provides fresh in-memory SQLite per test.

## Steps

1. Install dependency (likely already installed):
   ```bash
   npm install better-sqlite3 drizzle-orm
   ```

2. Create `tests/helpers/db.ts`:
   ```ts
   import { drizzle } from "drizzle-orm/better-sqlite3";
   import Database from "better-sqlite3";
   import { migrate } from "drizzle-orm/better-sqlite3/migrator";
   import * as schema from "@/db/schema";
   
   export function createTestDb() {
     const sqlite = new Database(":memory:");
     const db = drizzle(sqlite, { schema });
     migrate(db, { migrationsFolder: "./drizzle" });
     return { db, close: () => sqlite.close() };
   }
   ```

3. Use in tests:
   ```ts
   let testDb: ReturnType<typeof createTestDb>;
   
   beforeEach(() => {
     testDb = createTestDb();
   });
   
   afterEach(() => {
     testDb.close();
   });
   ```

## Files to Create
- `tests/helpers/db.ts`

## Dependencies
- better-sqlite3 (verify already in package.json)
- drizzle-orm (verify already in package.json)

## References
- PRD Section 5b: In-memory SQLite for test isolation