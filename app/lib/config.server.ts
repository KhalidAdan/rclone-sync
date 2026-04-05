import "@/lib/env.server";
import path from "node:path";
import fsp from "node:fs/promises";
import { logger } from "./logger.server";

function resolveDataDir(dir: string): string {
  return path.resolve(dir);
}

export const config = {
  dataDir: resolveDataDir(process.env.DATA_DIR),
  dbPath: path.join(resolveDataDir(process.env.DATA_DIR), process.env.DB_FILENAME),
  stagingDir: path.isAbsolute(process.env.STAGING_DIR)
    ? process.env.STAGING_DIR
    : path.resolve(process.env.DATA_DIR, process.env.STAGING_DIR),

  rcloneUrl: process.env.RCLONE_URL,
  rcloneRemote: process.env.RCLONE_REMOTE,

  logLevel: process.env.LOG_LEVEL,
  port: process.env.PORT,
} as const;

export async function validateConfig() {
  await fsp.mkdir(config.stagingDir, { recursive: true });

  logger.info("[config.validateConfig] Resolved config:", {
    dataDir: config.dataDir,
    dbPath: config.dbPath,
    stagingDir: config.stagingDir,
    rcloneUrl: config.rcloneUrl,
    rcloneRemote: config.rcloneRemote,
    logLevel: config.logLevel,
    port: config.port,
  });

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
