import { ZodError, z } from "zod";
import { logger } from "./logger.server";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  DATA_DIR: z.string().min(1),
  STAGING_DIR: z.string().default("staging"),
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
    logger.error("Missing or invalid environment variables:", { issues: e.issues });
  } else {
    logger.error(
      "An unknown error occurred while parsing env variables:",
      { error: String(e) },
    );
  }
  throw e;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace NodeJS {
    interface ProcessEnv extends z.infer<typeof envSchema> {}
  }
}
