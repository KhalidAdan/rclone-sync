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
  rcloneUser: process.env.RCLONE_USER,
  rclonePass: process.env.RCLONE_PASS,

  activationBytes: process.env.ACTIVATION_BYTES,

  logLevel: process.env.LOG_LEVEL,
  port: process.env.PORT,
  // Note: process.env values are strings at runtime regardless of the zod
  // schema's coercion (the parsed copy is discarded) — Number() handles both.
  uiRefreshIntervalSec: Number(process.env.UI_REFRESH_INTERVAL_SEC ?? 3) || 3,
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
    const headers: Record<string, string> = {};
    if (config.rcloneUser && config.rclonePass) {
      const token = Buffer.from(`${config.rcloneUser}:${config.rclonePass}`).toString("base64");
      headers["Authorization"] = `Basic ${token}`;
    }
    const res = await fetch(`${config.rcloneUrl}/core/version`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`rclone returned ${res.status}`);
  } catch (err) {
    throw new Error(
      `Cannot reach rclone at ${config.rcloneUrl}. Is "rclone rcd" running?\n${err}`,
    );
  }
}
