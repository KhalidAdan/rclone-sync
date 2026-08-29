import { spawn } from "node:child_process";
import { logger } from "./logger.server";

export async function decodeAax(
  inputPath: string,
  outputPath: string,
  activationBytes: string
): Promise<void> {
  logger.info("[decoder.decodeAax] Starting decode", {
    inputPath,
    outputPath,
  });

  return new Promise((resolve, reject) => {
    // -nostdin: never prompt (no TTY in server context)
    // -y: overwrite partial output left behind by a failed/interrupted decode
    const args = [
      "-nostdin",
      "-y",
      "-activation_bytes",
      activationBytes,
      "-i",
      inputPath,
      "-c",
      "copy",
      // moov atom up front: the archived M4B streams instantly via
      // ranged reads instead of needing the whole file first.
      "-movflags",
      "+faststart",
      outputPath,
    ];

    const ffmpeg = spawn("ffmpeg", args);
    let stderr = "";

    ffmpeg.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        logger.info("[decoder.decodeAax] Decode completed successfully", {
          inputPath,
          outputPath,
        });
        resolve();
      } else {
        const errorMsg = stderr.slice(-2000);
        logger.error("[decoder.decodeAax] Decode failed", {
          inputPath,
          exitCode: code,
          stderr: errorMsg,
        });
        reject(new Error(`FFmpeg exited with code ${code}: ${errorMsg}`));
      }
    });

    ffmpeg.on("error", (err) => {
      logger.error("[decoder.decodeAax] FFmpeg spawn error", {
        inputPath,
        error: err.message,
      });
      reject(new Error(`Failed to spawn FFmpeg: ${err.message}`));
    });
  });
}
