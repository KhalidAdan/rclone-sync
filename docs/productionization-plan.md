# Productionization Plan: Audiobook Archive App

---

## 1. Configuration Management

### Problem

Hardcoded values scattered across the codebase: `./data/staging`, `./data/audiobook-archive.db`, `http://localhost:5572`, the rclone remote name `audiobooks:`, etc. The current OS-conditional DB path is fragile and doesn't generalize.

### Solution: Two files — `env.server.ts` for validation, `config.server.ts` for derived values

This uses the same Zod-validated env pattern from [rom-manager](https://github.com/KhalidAdan/rom-manager/blob/main/app/lib/env.server.ts). Environment variables are parsed and validated at import time — if anything is missing or wrong, the app crashes immediately with a clear error. The global `ProcessEnv` augmentation gives you typed `process.env` access everywhere without importing config.

#### Step 1: `env.server.ts` — validate and type the environment

```ts
// app/lib/env.server.ts
import { ZodError, z } from "zod";

let envVariables = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]),

  // Core paths
  DATA_DIR: z.string().min(1),

  // rclone RC daemon
  RCLONE_URL: z.string().url().default("http://localhost:5572"),
  RCLONE_REMOTE: z.string().default("audiobooks:"),

  // Tuning (all optional with sensible defaults)
  DB_FILENAME: z.string().default("audiobook-archive.db"),
  JOB_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  UI_REFRESH_INTERVAL_SEC: z.coerce.number().int().positive().default(3),
  ABANDONED_JOB_DAYS: z.coerce.number().int().positive().default(7),
  MAX_RETRIES: z.coerce.number().int().nonnegative().default(3),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  PORT: z.coerce.number().int().positive().default(3001),
});

try {
  envVariables.parse(process.env);
} catch (e) {
  if (e instanceof ZodError) {
    console.error("Missing or invalid environment variables:", e.errors);
  } else {
    console.error("An unknown error occurred while parsing env variables:", e);
  }
  throw e;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace NodeJS {
    interface ProcessEnv extends z.infer<typeof envVariables> {}
  }
}
```

This file must be imported early — ideally as a side-effect import at the top of your server entry point:

```ts
// app/entry.server.tsx (or wherever your server boots)
import "@/lib/env.server";
```

#### Step 2: `config.server.ts` — derived values and helpers

With the env validated and typed, `config.server.ts` derives paths and exposes a clean object. No fallback logic needed — Zod defaults handle that in `env.server.ts`.

```ts
// app/lib/config.server.ts
import "@/lib/env.server"; // ensure env is validated before we read it
import path from "node:path";
import fsp from "node:fs/promises";

export const config = {
  // Paths — all derived from DATA_DIR
  dataDir: process.env.DATA_DIR,
  dbPath: path.join(process.env.DATA_DIR, process.env.DB_FILENAME),
  stagingDir: path.join(process.env.DATA_DIR, "staging"),

  // rclone RC daemon
  rcloneUrl: process.env.RCLONE_URL,
  rcloneRemote: process.env.RCLONE_REMOTE,

  // Tuning
  jobPollIntervalMs: process.env.JOB_POLL_INTERVAL_MS,
  uiRefreshIntervalSec: process.env.UI_REFRESH_INTERVAL_SEC,
  abandonedJobDays: process.env.ABANDONED_JOB_DAYS,
  maxRetries: process.env.MAX_RETRIES,
  logLevel: process.env.LOG_LEVEL,

  // Server
  port: process.env.PORT,
} as const;

/** Call on boot, after env validation. Ensures dirs exist and rclone is up. */
export async function validateConfig() {
  await fsp.mkdir(config.stagingDir, { recursive: true });

  try {
    const res = await fetch(`${config.rcloneUrl}/core/version`, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`rclone returned ${res.status}`);
  } catch (err) {
    throw new Error(
      `Cannot reach rclone at ${config.rcloneUrl}. Is "rclone rcd" running?\n${err}`,
    );
  }
}
```

Then everywhere in the codebase, replace hardcoded values:

```ts
// Before
const stagingDir = `/data/staging/${id}`;
await fetch("http://localhost:5572/operations/copyfile", ...);

// After
import { config } from "@/lib/config.server";
const stagingDir = path.join(config.stagingDir, id);
await fetch(`${config.rcloneUrl}/operations/copyfile`, ...);
```

### .env files

```env
# .env.development (checked into repo)
NODE_ENV=development
DATA_DIR=./data
LOG_LEVEL=debug

# .env.production (on the homelab, NOT in repo)
NODE_ENV=production
DATA_DIR=/data
LOG_LEVEL=info
```

`RCLONE_URL`, `RCLONE_REMOTE`, `DB_FILENAME`, and all tuning vars use Zod defaults and only need to appear in `.env` if you're overriding them.

---

## 2. OS-Aware Paths

### Problem

The current `process.env.NODE_ENV === "production" ? "/data/..." : "./data/..."` pattern hardcodes the assumption that prod = Linux and dev = Windows. It breaks if you test in prod mode locally, run dev mode on Linux, or deploy to a different path.

### Solution

Already solved by the env + config split above. `DATA_DIR` is a required env var — Zod enforces it's set in every environment. Your `.env.development` sets `DATA_DIR=./data`, your `.env.production` sets `DATA_DIR=/data`, and there's no OS-sniffing logic anywhere. `path.join()` handles separators automatically.

One thing to audit: make sure you're never string-concatenating paths with `/`. Grep for these patterns and fix them:

```bash
# Find hardcoded forward-slash path joins
grep -rn "'/data/" app/
grep -rn '`/data/' app/
grep -rn "staging/" app/lib/
```

Every instance should become `path.join(config.stagingDir, id)` or similar.

---

## 3. Logging with LOG_LEVEL

### Problem

`console.log` scattered everywhere, no way to control verbosity, no structured output for production.

### Solution: Lightweight logger module

You don't need pino or winston for a single-user homelab app. A thin wrapper around `console` with level filtering and structured context is enough. If you outgrow it, swap the internals for pino — call sites stay the same.

```ts
// app/lib/logger.server.ts
import { config } from "@/lib/config.server";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

const currentLevel: Level = config.logLevel;

function shouldLog(level: Level): boolean {
  return LEVELS[level] >= LEVELS[currentLevel];
}

function formatMessage(
  level: Level,
  msg: string,
  ctx?: Record<string, unknown>,
): string {
  const timestamp = new Date().toISOString();
  const base = `${timestamp} [${level.toUpperCase()}] ${msg}`;
  if (!ctx || Object.keys(ctx).length === 0) return base;
  return `${base} ${JSON.stringify(ctx)}`;
}

export const logger = {
  debug(msg: string, ctx?: Record<string, unknown>) {
    if (shouldLog("debug")) console.debug(formatMessage("debug", msg, ctx));
  },
  info(msg: string, ctx?: Record<string, unknown>) {
    if (shouldLog("info")) console.info(formatMessage("info", msg, ctx));
  },
  warn(msg: string, ctx?: Record<string, unknown>) {
    if (shouldLog("warn")) console.warn(formatMessage("warn", msg, ctx));
  },
  error(msg: string, ctx?: Record<string, unknown>) {
    if (shouldLog("error")) console.error(formatMessage("error", msg, ctx));
  },
};
```

Usage throughout the codebase:

```ts
import { logger } from "@/lib/logger.server";

// In archiver.server.ts
logger.info("Starting archive job", { jobId: id, filename: job.filename });
logger.debug("rclone copyfile request", { srcFs, dstFs, dstRemote });

// In jobWatcher.server.ts
logger.info("Job completed", { jobId: id, durationMs: elapsed });
logger.error("Archive failed", { jobId: id, rcloneError: status.error });

// In startup.server.ts
logger.warn("Orphaned ARCHIVING job found", {
  jobId: job.id,
  rcloneJobId: job.rcloneJobId,
});
```

### Where to add logging

| Module                 | Level | What to log                                                |
| ---------------------- | ----- | ---------------------------------------------------------- |
| `config.server.ts`     | info  | Resolved config values on startup (redact keys)            |
| `archiver.server.ts`   | info  | Job started, queued; debug: rclone request/response bodies |
| `jobWatcher.server.ts` | info  | Job completed/failed; debug: each poll tick                |
| `startup.server.ts`    | warn  | Orphaned jobs recovered; info: startup complete            |
| Route actions          | info  | Upload received (filename, size); error: upload failures   |
| `rclone.server.ts`     | debug | Every rclone RC call and response status                   |

---

## 4. UI Updates for Job State Transitions

### Problem

The PRD specifies `<meta httpEquiv="refresh">` polling, but the app currently only logs state changes — the user sees nothing in the UI.

### Solution

Three sub-tasks: make the loader return the right data, render state transitions visibly, and ensure polling runs.

### 4a. Jobs loader: merge live rclone stats

```ts
// app/routes/_layout.jobs.tsx — loader
import { desc } from "drizzle-orm";
import { db } from "@/db/client.server";
import { jobs } from "@/db/schema";
import { config } from "@/lib/config.server";

export async function loader() {
  const allJobs = await db.select().from(jobs).orderBy(desc(jobs.updatedAt));

  const archivingJob = allJobs.find((j) => j.status === "ARCHIVING");
  let liveProgress = null;

  if (archivingJob) {
    try {
      const res = await fetch(`${config.rcloneUrl}/core/stats`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(3000),
      });
      const stats = await res.json();
      liveProgress = {
        jobId: archivingJob.id,
        bytesTransferred: stats.bytes ?? 0,
        totalBytes: archivingJob.sizeBytes,
        speed: stats.speed ?? 0,
        eta: stats.eta ?? 0,
        percentage:
          archivingJob.sizeBytes > 0
            ? Math.round(((stats.bytes ?? 0) / archivingJob.sizeBytes) * 100)
            : 0,
      };
    } catch {
      // rclone might be between jobs — show status without live stats
    }
  }

  return { jobs: allJobs, liveProgress };
}
```

### 4b. Job status component with visual state

Each job renders its current state with clear visual feedback. Active states get a pulse animation, failures get retry buttons.

```tsx
// app/components/JobCard.tsx

const STATUS_DISPLAY: Record<
  string,
  { label: string; color: string; animate?: boolean }
> = {
  UPLOADING: { label: "Uploading…", color: "text-blue-600", animate: true },
  STAGED: { label: "Staged", color: "text-gray-600" },
  QUEUED: { label: "Queued", color: "text-yellow-600" },
  ARCHIVING: { label: "Archiving…", color: "text-blue-600", animate: true },
  VERIFYING: { label: "Verifying…", color: "text-blue-600", animate: true },
  COMPLETED: { label: "Complete", color: "text-green-600" },
  UPLOAD_FAILED: { label: "Upload Failed", color: "text-red-600" },
  ARCHIVE_FAILED: { label: "Archive Failed", color: "text-red-600" },
  VERIFY_FAILED: { label: "Verify Failed", color: "text-red-600" },
  ABANDONED: { label: "Abandoned", color: "text-gray-400" },
};

function isRetryable(status: string): boolean {
  return ["ARCHIVE_FAILED", "VERIFY_FAILED"].includes(status);
}
```

### 4c. Auto-refresh when jobs are active

Render the meta refresh tag when there's active work. The browser handles polling automatically — no client-side JS required.

```tsx
export default function Jobs({ loaderData }: Route.ComponentProps) {
  const { jobs, liveProgress } = loaderData;

  const hasActiveWork = jobs.some((j) =>
    ["UPLOADING", "STAGED", "QUEUED", "ARCHIVING", "VERIFYING"].includes(
      j.status,
    ),
  );

  return (
    <>
      {hasActiveWork && (
        <meta
          httpEquiv="refresh"
          content={String(config.uiRefreshIntervalSec)}
        />
      )}
      <h1>Jobs</h1>
      {jobs.map((job) => (
        <JobCard
          key={job.id}
          job={job}
          progress={liveProgress?.jobId === job.id ? liveProgress : null}
        />
      ))}
    </>
  );
}
```

### 4d. Redirect to jobs after upload

When the upload action completes, redirect so the user immediately sees their job:

```ts
// In the upload route action, after successful insert:
import { redirect } from "react-router";
return redirect("/jobs");
```

---

## 5. Testing with `@platformatic/vfs`

### Problem

The app does heavy filesystem work — streaming uploads to staging, reading files for archive, cleaning up staging dirs. Testing against the real filesystem is slow, fragile, and leaves artifacts. Traditional mocking with `vi.mock("node:fs")` is tedious and doesn't cover the module loader.

### Approach

Use `@platformatic/vfs` (the userland package available on Node.js 22+ today, which will become `node:vfs` once the core PR lands). Its overlay mode intercepts only the paths you virtualize — everything else falls through to the real FS. You can mount a virtual `/data/staging/` without affecting Vitest, Drizzle, or anything else.

```bash
npm install --save-dev @platformatic/vfs
```

### Test structure

```
tests/
  lib/
    archiver.test.ts        ← archive orchestration (queue logic, state transitions)
    jobWatcher.test.ts      ← watcher polling, completion handling, next-queued
    config.test.ts          ← env var parsing, path resolution
    logger.test.ts          ← level filtering
  routes/
    upload.test.ts          ← action: file staging, DB insert, redirect
    jobs.test.ts            ← loader: job list, live progress merging
  helpers/
    vfs.ts                  ← shared VFS setup/teardown
    db.ts                   ← in-memory SQLite for tests
    rclone-mock.ts          ← mock rclone RC server
```

### 5a. VFS helper for staging directory tests

```ts
// tests/helpers/vfs.ts
import { create } from "@platformatic/vfs";

export function createTestVfs() {
  const vfs = create({ overlay: true });

  // Pre-create the staging root so mkdir({ recursive: true }) works
  vfs.mkdirSync("/data/staging", { recursive: true });
  vfs.mount("/data/staging");

  return {
    vfs,
    /** Write a fake audiobook file into staging */
    stageFile(
      jobId: string,
      filename: string,
      content: string | Buffer = "fake audio data",
    ) {
      const dir = `/data/staging/${jobId}`;
      vfs.mkdirSync(dir, { recursive: true });
      vfs.writeFileSync(`${dir}/${filename}`, content);
    },
    /** Assert staging dir was cleaned up */
    assertCleaned(jobId: string): boolean {
      try {
        vfs.readdirSync(`/data/staging/${jobId}`);
        return false; // dir still exists
      } catch {
        return true; // ENOENT — cleaned up
      }
    },
    teardown() {
      vfs.unmount();
    },
  };
}
```

### 5b. In-memory SQLite for test isolation

Each test gets a fresh database. No cleanup, no shared state.

```ts
// tests/helpers/db.ts
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

### 5c. Mock rclone RC server

Don't call the real rclone in tests. Stand up a tiny HTTP server that simulates the RC API.

```ts
// tests/helpers/rclone-mock.ts
import { createServer } from "node:http";

interface RcloneMockOptions {
  /** Simulate copyfile taking N polls before finishing */
  pollsBeforeComplete?: number;
  /** Simulate a failure */
  shouldFail?: boolean;
}

export function createRcloneMock(opts: RcloneMockOptions = {}) {
  let jobIdCounter = 1;
  let pollCount = 0;
  const pollsNeeded = opts.pollsBeforeComplete ?? 2;

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const url = req.url ?? "";
      res.setHeader("Content-Type", "application/json");

      if (url === "/operations/copyfile") {
        const jobid = jobIdCounter++;
        pollCount = 0;
        res.end(JSON.stringify({ jobid }));
      } else if (url === "/job/status") {
        pollCount++;
        const finished = pollCount >= pollsNeeded;
        res.end(
          JSON.stringify({
            finished,
            success: finished && !opts.shouldFail,
            error: finished && opts.shouldFail ? "simulated rclone error" : "",
          }),
        );
      } else if (url === "/operations/list") {
        res.end(
          JSON.stringify({
            list: opts.shouldFail ? [] : [{ Name: "test.m4b", Size: 1024 }],
          }),
        );
      } else if (url === "/core/stats") {
        res.end(JSON.stringify({ bytes: 512, speed: 1024, eta: 5 }));
      } else if (url === "/core/version") {
        res.end(JSON.stringify({ version: "v1.65.0" }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "unknown endpoint" }));
      }
    });
  });

  return {
    start: () =>
      new Promise<number>((resolve) => {
        server.listen(0, () => {
          const addr = server.address();
          resolve(typeof addr === "object" ? addr!.port : 0);
        });
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    server,
  };
}
```

### 5d. Example test: archive happy path

```ts
// tests/lib/archiver.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/db";
import { createTestVfs } from "../helpers/vfs";
import { createRcloneMock } from "../helpers/rclone-mock";
import { jobs } from "@/db/schema";

describe("startOrQueueArchive", () => {
  let testDb: ReturnType<typeof createTestDb>;
  let testVfs: ReturnType<typeof createTestVfs>;
  let rcloneMock: ReturnType<typeof createRcloneMock>;

  beforeEach(async () => {
    testDb = createTestDb();
    testVfs = createTestVfs();
    rcloneMock = createRcloneMock({ pollsBeforeComplete: 1 });
    const port = await rcloneMock.start();

    // Override config for this test
    process.env.RCLONE_URL = `http://localhost:${port}`;
    process.env.DATA_DIR = "/data";
  });

  afterEach(async () => {
    testVfs.teardown();
    testDb.close();
    await rcloneMock.close();
    delete process.env.RCLONE_URL;
    delete process.env.DATA_DIR;
  });

  it("transitions STAGED → ARCHIVING → VERIFYING → COMPLETED", async () => {
    const id = "test-job-001";
    testVfs.stageFile(id, "test.m4b");

    // Insert a STAGED job
    await testDb.db.insert(jobs).values({
      id,
      filename: "test.m4b",
      sizeBytes: 1024,
      destinationPath: "",
      status: "STAGED",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Start archive — inject testDb.db (see section 5e)
    // ... assert final status is COMPLETED
    // ... assert staging was cleaned up
    expect(testVfs.assertCleaned(id)).toBe(true);
  });

  it("queues a second job when one is already ARCHIVING", async () => {
    // Insert an ARCHIVING job
    await testDb.db.insert(jobs).values({
      id: "job-1",
      filename: "first.m4b",
      sizeBytes: 1024,
      destinationPath: "",
      status: "ARCHIVING",
      rcloneJobId: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Insert a STAGED job and try to archive it
    await testDb.db.insert(jobs).values({
      id: "job-2",
      filename: "second.m4b",
      sizeBytes: 2048,
      destinationPath: "",
      status: "STAGED",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // startOrQueueArchive("job-2", { db: testDb.db }) should set status to QUEUED
    const [queued] = await testDb.db
      .select()
      .from(jobs)
      .where(eq(jobs.id, "job-2"));
    expect(queued.status).toBe("QUEUED");
  });
});
```

### 5e. Making modules testable: dependency injection

The current code imports `db` and `config` as module-level singletons. For testing, you need to inject the test DB and config. Two approaches:

**Option A: Default parameter injection (cleanest for new code)**

```ts
// app/lib/archiver.server.ts
import { db as defaultDb } from "@/db/client.server";
import { config as defaultConfig } from "@/lib/config.server";

export async function startOrQueueArchive(
  id: string,
  deps = { db: defaultDb, config: defaultConfig },
) {
  const active = await deps.db
    .select()
    .from(jobs)
    .where(eq(jobs.status, "ARCHIVING"))
    .limit(1);
  // ...
}
```

In production code, the defaults are used. In tests, you pass the test DB:

```ts
await startOrQueueArchive("job-2", { db: testDb.db, config: testConfig });
```

**Option B: Module-level setter (less refactoring for existing code)**

```ts
let _db = defaultDb;
export function __setTestDb(db: typeof defaultDb) {
  _db = db;
}
```

Option A is recommended for anything you're touching anyway. Option B is pragmatic for code you don't want to refactor yet.

### 5f. What to test

| Module                 | Tests                                      | Key assertions                                                                |
| ---------------------- | ------------------------------------------ | ----------------------------------------------------------------------------- |
| `config.server.ts`     | env var parsing, defaults, path resolution | `DATA_DIR` override works; `path.join` produces valid paths on any OS         |
| `archiver.server.ts`   | start vs queue logic, retry behavior       | Second job gets QUEUED; retry increments `retryCount`                         |
| `jobWatcher.server.ts` | poll → complete, poll → fail, start next   | COMPLETED cleans staging; FAILED records error; next QUEUED starts            |
| `startup.server.ts`    | orphan recovery                            | ARCHIVING with dead rclone → ARCHIVE_FAILED; QUEUED starts                    |
| `logger.server.ts`     | level filtering                            | `LOG_LEVEL=warn` suppresses info/debug                                        |
| Upload action          | streaming, DB insert, redirect             | File lands in staging; job row created as STAGED; response redirects to /jobs |
| Jobs loader            | query + rclone stats merge                 | Returns jobs sorted by updatedAt; liveProgress populated for ARCHIVING job    |

---

## 6. Application Hardening

### 6a. Graceful shutdown

When the process receives SIGTERM/SIGINT, let active watchers clean up and mark jobs properly before exiting.

```ts
// app/lib/shutdown.server.ts
import { logger } from "@/lib/logger.server";

let isShuttingDown = false;

export function isShutdown() {
  return isShuttingDown;
}

export function setupGracefulShutdown(cleanup: () => Promise<void>) {
  const handler = async (signal: string) => {
    if (isShuttingDown) return; // prevent double-fire
    isShuttingDown = true;
    logger.info(`Received ${signal}, shutting down gracefully…`);

    try {
      await cleanup();
    } catch (err) {
      logger.error("Error during shutdown cleanup", { error: String(err) });
    }

    process.exit(0);
  };

  process.on("SIGTERM", () => handler("SIGTERM"));
  process.on("SIGINT", () => handler("SIGINT"));
}
```

The cleanup function should: close the SQLite connection, clear any `setInterval` watcher timers, and optionally mark any ARCHIVING jobs as needing recovery on next boot.

### 6b. Request size limits

Audiobooks can be large (500MB–2GB). Set an upper bound so a malformed request can't fill the disk.

```ts
const MAX_UPLOAD_SIZE = 4 * 1024 * 1024 * 1024; // 4 GB
```

Check `Content-Length` in the route action before streaming to disk. If it exceeds the limit, reject with a 413 immediately.

### 6c. Disk space checks

Before accepting an upload, check available disk space. A full disk during a streaming write is a bad time.

```ts
// app/lib/disk.server.ts
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

Reject uploads when free space is below `sizeBytes * 2` (need room for staging + headroom).

### 6d. Stale job cleanup (ABANDONED)

The PRD mentions a 7-day cleanup. Implement it as a periodic timer.

```ts
// app/lib/cleanup.server.ts
import { lt, and, notInArray, eq } from "drizzle-orm";
import { db } from "@/db/client.server";
import { jobs } from "@/db/schema";
import { config } from "@/lib/config.server";
import { logger } from "@/lib/logger.server";
import fsp from "node:fs/promises";
import path from "node:path";

const TERMINAL_STATUSES = ["COMPLETED", "UPLOAD_FAILED", "ABANDONED"];

export function startCleanupTimer() {
  // Run every 6 hours
  return setInterval(
    async () => {
      try {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - config.abandonedJobDays);

        const stale = await db
          .select()
          .from(jobs)
          .where(
            and(
              lt(jobs.updatedAt, cutoff.toISOString()),
              notInArray(jobs.status, TERMINAL_STATUSES),
            ),
          );

        for (const job of stale) {
          logger.warn("Abandoning stale job", {
            jobId: job.id,
            status: job.status,
            lastUpdate: job.updatedAt,
          });

          await db
            .update(jobs)
            .set({
              status: "ABANDONED",
              error: JSON.stringify({
                phase: job.status,
                message: `Stale for >${config.abandonedJobDays} days`,
              }),
              updatedAt: new Date().toISOString(),
            })
            .where(eq(jobs.id, job.id));

          // Clean staging if it exists
          const stagingPath = path.join(config.stagingDir, job.id);
          await fsp.rm(stagingPath, { recursive: true, force: true });
        }

        if (stale.length > 0) {
          logger.info(`Abandoned ${stale.length} stale jobs`);
        }
      } catch (err) {
        logger.error("Cleanup timer error", { error: String(err) });
      }
    },
    6 * 60 * 60 * 1000,
  );
}
```

### 6e. Error boundaries in the UI

Wrap the layout with a React Router error boundary so loader/action errors show a useful message.

```tsx
// app/routes/_layout.tsx
import { useRouteError } from "react-router";

export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <div className="p-8 max-w-lg mx-auto">
      <h1 className="text-xl font-bold text-red-600">Something went wrong</h1>
      <p className="mt-2 text-gray-700">
        {error instanceof Error
          ? error.message
          : "An unexpected error occurred."}
      </p>
      <a href="/" className="mt-4 inline-block text-blue-600 underline">
        Back to upload
      </a>
    </div>
  );
}
```

### 6f. Health check endpoint

Useful for monitoring and for Docker/systemd health checks.

```ts
// app/routes/health.tsx
import { db } from "@/db/client.server";
import { jobs } from "@/db/schema";
import { config } from "@/lib/config.server";

export async function loader() {
  const checks: Record<string, "ok" | "error"> = {};

  // DB check
  try {
    db.select().from(jobs).limit(1);
    checks.database = "ok";
  } catch {
    checks.database = "error";
  }

  // rclone check
  try {
    const res = await fetch(`${config.rcloneUrl}/core/version`, {
      method: "POST",
      signal: AbortSignal.timeout(3000),
    });
    checks.rclone = res.ok ? "ok" : "error";
  } catch {
    checks.rclone = "error";
  }

  const healthy = Object.values(checks).every((v) => v === "ok");

  return new Response(
    JSON.stringify({ status: healthy ? "healthy" : "degraded", checks }),
    {
      status: healthy ? 200 : 503,
      headers: { "Content-Type": "application/json" },
    },
  );
}
```

---

## Implementation Order

Recommended sequence — each step is independently deployable:

1. **Config module** (section 1 + 2) — unblocks everything else. Do the grep audit for hardcoded paths at the same time.
2. **Logger** (section 3) — quick win, immediately improves debuggability. Replace `console.log` calls as you touch files.
3. **UI updates** (section 4) — the loader, JobCard component, meta refresh, and post-upload redirect. Most visible improvement for the user.
4. **Hardening** (section 6) — graceful shutdown, disk checks, cleanup timer, error boundary, health endpoint.
5. **Tests** (section 5) — set up test infrastructure (VFS helper, test DB, rclone mock), then write tests for archiver and jobWatcher first since those are the riskiest code paths.

Steps 1–3 can probably be done in a single focused session. Steps 4–5 are ongoing as you add features.
