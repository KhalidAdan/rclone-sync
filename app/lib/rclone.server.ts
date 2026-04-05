import "@/lib/env.server";
import { config } from "./config.server";
import { logger } from "./logger.server";

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
  Name: string;
  Size: string;
  ModTime: string;
  IsDir: boolean;
}

export async function copyFile(
  srcFs: string,
  srcRemote: string,
  dstFs: string,
  dstRemote: string
): Promise<{ jobid: number }> {
  logger.debug("[rclone.copyFile] Request:", { srcFs, srcRemote, dstFs, dstRemote });
  
  const res = await fetch(`${config.rcloneUrl}/operations/copyfile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      srcFs,
      srcRemote,
      dstFs,
      dstRemote,
      _async: true,
    }),
  });
  
  const data = await res.json();
  logger.debug("[rclone.copyFile] Response:", data);
  
  if (data.error) {
    logger.error("[rclone.copyFile] Error:", { error: data.error });
    throw new Error(data.error);
  }
  return { jobid: data.jobid };
}

export async function listFiles(
  fs: string,
  remote: string
): Promise<{ list: RcloneListEntry[] }> {
  logger.debug("[rclone.listFiles] Request:", { fs, remote });
  
  const res = await fetch(`${config.rcloneUrl}/operations/list`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fs, remote }),
  });
  
  const data = await res.json();
  logger.debug("[rclone.listFiles] Response:", data);
  
  return { list: data.list || [] };
}

export async function getJobStatus(jobid: number): Promise<RcloneJobStatus> {
  logger.debug("[rclone.getJobStatus] Request:", { jobid });
  
  const res = await fetch(`${config.rcloneUrl}/job/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobid }),
  });
  
  const data = await res.json();
  logger.debug("[rclone.getJobStatus] Response:", data);
  
  return {
    finished: data.finished ?? false,
    success: data.success,
    error: data.error,
  };
}

export async function getStats(): Promise<RcloneStats> {
  logger.debug("[rclone.getStats] Request");
  
  const res = await fetch(`${config.rcloneUrl}/core/stats`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  
  const data = await res.json();
  logger.debug("[rclone.getStats] Response:", data);
  
  return data;
}
