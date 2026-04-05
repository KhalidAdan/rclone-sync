# Task 30: Dependency Injection for Testability

## Problem

- Modules import db and config as module-level singletons
- Tests can't inject test DB or mock config
- Makes testing archiver/jobWatcher difficult

## Solution

Refactor archiver and jobWatcher to accept deps via function parameters.

## Steps

1. Update `app/lib/archiver.server.ts`:
   - Import db and config as default values
   - Change function signature to accept optional deps object:
     ```ts
     export async function startOrQueueArchive(
       id: string,
       deps = { db: defaultDb, config: defaultConfig },
     ) {
       // use deps.db and deps.config instead of module-level
     }
     ```

2. Update `app/lib/jobWatcher.server.ts` similarly:
   - Accept deps with db and config defaults
   - Use deps.db, deps.config instead of imports

3. Update any other modules that need testing:
   - Check for modules that import db, config, or other singletons

4. Tests can now pass test instances:
   ```ts
   await startOrQueueArchive("job-2", { db: testDb.db, config: testConfig });
   ```

## Files to Modify
- `app/lib/archiver.server.ts`
- `app/lib/jobWatcher.server.ts`
- Other modules as needed

## References
- PRD Section 5e: Making modules testable: dependency injection