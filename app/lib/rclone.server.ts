import "@/lib/env.server";
import { config } from "./config.server";
import { logger } from "./logger.server";

function getHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.rcloneUser && config.rclonePass) {
    const token = Buffer.from(`${config.rcloneUser}:${config.rclonePass}`).toString("base64");
    headers["Authorization"] = `Basic ${token}`;
  }
  return headers;
}

async function rcloneJson(path: string, body: object): Promise<any> {
  const res = await fetch(`${config.rcloneUrl}${path}`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    logger.error(`[rclone] ${path} HTTP error:`, { status: res.status, text: text.slice(0, 500) });
    throw new Error(`rclone ${path} returned ${res.status}: ${text.slice(0, 500)}`);
  }

  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    const text = await res.text();
    logger.error(`[rclone] ${path} non-JSON response:`, { contentType, text: text.slice(0, 200) });
    throw new Error(`rclone ${path}: expected JSON but got ${contentType}`);
  }

  return res.json();
}

export interface RcloneJobStatus {
  finished: boolean;
  success?: boolean;
  error?: string;
}

export interface RcloneStats {
  bytes: number;
  speed: number;
  eta: number;
}

export interface RcloneListEntry {
  /** Path relative to the listed root (differs from Name when recursing). */
  Path: string;
  Name: string;
  Size: number;
  ModTime: string;
  IsDir: boolean;
}

export async function copyFile(
  srcFs: string,
  srcRemote: string,
  dstFs: string,
  dstRemote: string,
): Promise<{ jobid: number }> {
  logger.debug("[rclone.copyFile] Request:", { srcFs, srcRemote, dstFs, dstRemote });

  const data = await rcloneJson("/operations/copyfile", {
    srcFs,
    srcRemote,
    dstFs,
    dstRemote,
    // Async jobs get a dedicated stats group "job/<jobid>" — see getStats().
    _async: true,
  });
  logger.debug("[rclone.copyFile] Response:", data);

  if (data.error) {
    logger.error("[rclone.copyFile] Error:", { error: data.error });
    throw new Error(data.error);
  }
  if (typeof data.jobid !== "number") {
    throw new Error(`rclone copyfile returned no jobid: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return { jobid: data.jobid };
}

export async function listFiles(
  fs: string,
  remote: string,
  opts?: { recurse?: boolean },
): Promise<{ list: RcloneListEntry[] }> {
  logger.debug("[rclone.listFiles] Request:", { fs, remote, opts });
  const data = await rcloneJson("/operations/list", {
    fs,
    remote,
    ...(opts?.recurse ? { opt: { recurse: true } } : {}),
  });
  logger.debug("[rclone.listFiles] Response:", { count: data.list?.length });
  return { list: data.list || [] };
}

/** Permanently delete a single file from the remote. */
export async function deleteFile(fs: string, remote: string): Promise<void> {
  logger.info("[rclone.deleteFile] Request:", { fs, remote });
  const data = await rcloneJson("/operations/deletefile", { fs, remote });
  if (data.error) {
    throw new Error(data.error);
  }
}

export async function getJobStatus(jobid: number): Promise<RcloneJobStatus> {
  logger.debug("[rclone.getJobStatus] Request:", { jobid });
  const data = await rcloneJson("/job/status", { jobid });
  logger.debug("[rclone.getJobStatus] Response:", data);

  return {
    finished: data.finished ?? false,
    success: data.success,
    // rclone reports the *job's* failure message in `error` with HTTP 200.
    error: data.error || undefined,
  };
}

/**
 * Transfer stats. Pass a group (e.g. `job/<rcloneJobId>`) to scope the numbers
 * to a single transfer — the global stats are cumulative since daemon start
 * and useless for per-job progress.
 */
export async function getStats(group?: string): Promise<RcloneStats> {
  logger.debug("[rclone.getStats] Request", { group });
  const data = await rcloneJson("/core/stats", group ? { group } : {});
  return {
    bytes: data.bytes ?? 0,
    speed: data.speed ?? 0,
    eta: data.eta ?? 0,
  };
}
