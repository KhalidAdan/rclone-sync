# Task 17: env.server.ts - Zod-validated environment with ProcessEnv types

## Problem

Hardcoded values scattered across codebase:
- `./data/staging`, `./data/audiobook-archive.db`
- `http://localhost:5572`, `audiobooks:`
- No validation at startup

## Solution

Single `env.server.ts` with Zod validation + ProcessEnv augmentation. Use `process.env` directly throughout codebase (fully typed).

## Steps

1. Install zod:
   ```bash
   npm install zod
   ```

2. Create `app/lib/env.server.ts`:
   ```ts
   import { ZodError, z } from "zod";

   const envSchema = z.object({
     NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
     DATA_DIR: z.string().min(1),
     RCLONE_URL: z.string().url().default("http://localhost:5572"),
     RCLONE_REMOTE: z.string().default("audiobooks:"),
     DB_FILENAME: z.string().default("audiobook-archive.db"),
     PORT: z.coerce.number().int().positive().default(3001),
     LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
   });

   try {
     envSchema.parse(process.env);
   } catch (e) {
     if (e instanceof ZodError) {
       console.error("Missing or invalid environment variables:", e.errors);
     } else {
       console.error("An unknown error occurred while parsing env variables:", e);
     }
     throw e;
   }

   declare global {
     namespace NodeJS {
       interface ProcessEnv extends z.infer<typeof envSchema> {}
     }
   }
   ```

3. Add side-effect import early in server entry (e.g., `app/entry.server.tsx`):
   ```ts
   import "@/lib/env.server";
   ```

4. Usage in codebase (fully typed):
   ```ts
   import path from "node:path";

   const stagingDir = path.join(process.env.DATA_DIR!, "staging");
   const dbPath = path.join(process.env.DATA_DIR!, process.env.DB_FILENAME!);
   ```

## Files to Create
- `app/lib/env.server.ts`

## Files to Modify
- `app/entry.server.tsx` (or wherever server boots)
- Any file using hardcoded paths/URLs

## Dependencies
- zod

## References
- PRD Section 1: Configuration Management