import "@/lib/env.server";
import path from "node:path";
import fsp from "node:fs/promises";

export const config = {
  dataDir: process.env.DATA_DIR,
  dbPath: path.join(process.env.DATA_DIR, process.env.DB_FILENAME),
  stagingDir: path.isAbsolute(process.env.STAGING_DIR)
    ? process.env.STAGING_DIR
    : path.join(process.env.DATA_DIR, process.env.STAGING_DIR),

  rcloneUrl: process.env.RCLONE_URL,
  rcloneRemote: process.env.RCLONE_REMOTE,

  logLevel: process.env.LOG_LEVEL,
  port: process.env.PORT,
} as const;

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
