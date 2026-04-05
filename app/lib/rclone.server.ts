const RCLONE_URL = "http://localhost:5572";

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
  console.log("[rclone.copyFile] Request:", { srcFs, srcRemote, dstFs, dstRemote });
  
  const res = await fetch(`${RCLONE_URL}/operations/copyfile`, {
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
  console.log("[rclone.copyFile] Response:", data);
  
  if (data.error) {
    console.error("[rclone.copyFile] Error:", data.error);
    throw new Error(data.error);
  }
  return { jobid: data.jobid };
}

export async function listFiles(
  fs: string,
  remote: string
): Promise<{ list: RcloneListEntry[] }> {
  console.log("[rclone.listFiles] Request:", { fs, remote });
  
  const res = await fetch(`${RCLONE_URL}/operations/list`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fs, remote }),
  });
  
  const data = await res.json();
  console.log("[rclone.listFiles] Response:", data);
  
  return { list: data.list || [] };
}

export async function getJobStatus(jobid: number): Promise<RcloneJobStatus> {
  console.log("[rclone.getJobStatus] Request:", { jobid });
  
  const res = await fetch(`${RCLONE_URL}/job/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobid }),
  });
  
  const data = await res.json();
  console.log("[rclone.getJobStatus] Response:", data);
  
  return {
    finished: data.finished ?? false,
    success: data.success,
    error: data.error,
  };
}

export async function getStats(): Promise<RcloneStats> {
  console.log("[rclone.getStats] Request");
  
  const res = await fetch(`${RCLONE_URL}/core/stats`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  
  const data = await res.json();
  console.log("[rclone.getStats] Response:", data);
  
  return data;
}
