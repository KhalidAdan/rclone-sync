# Task 31: Config Module Tests

## Problem

- No tests for env var parsing
- No tests for defaults
- No tests for path resolution across OS

## Solution

Write unit tests for config.server.ts.

## Tests to Write

1. Env var parsing:
   - Test that valid env vars parse without error
   - Test that missing required vars (DATA_DIR) throw
   - Test that invalid values (invalid URL) throw

2. Defaults:
   - Test RCLONE_URL defaults to http://localhost:5572
   - Test LOG_LEVEL defaults to info
   - Test PORT defaults to 3001

3. Path resolution:
   - Test dbPath is DATA_DIR + DB_FILENAME
   - Test stagingDir is DATA_DIR + "staging"
   - Test path.join works on Windows (backslashes) and Unix

## Files to Create
- `tests/lib/config.test.ts`

## Dependencies
- Vitest (verify in package.json)
- Task 17 (config module must exist)
- Task 28 (test db helper)
- Task 27 (VFS helper if testing paths)

## References
- PRD Section 5f: What to test - config.server.ts