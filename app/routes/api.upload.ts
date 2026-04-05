import { parseFormData } from "@remix-run/form-data-parser";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { db } from "../db/client.server";
import { jobs, jobEvents } from "../db/schema";
import { config } from "../lib/config.server";
import { startOrQueueArchive } from "../lib/archiver.server";

const MAX_UPLOAD_SIZE = 1.5 * 1024 * 1024 * 1024; // 1.5GB
const PROGRESS_LOG_INTERVAL = 250 * 1024 * 1024; // 250MB

async function logJobEvent(
  jobId: string,
  eventType: "created" | "queued" | "archiving" | "verifying" | "completed" | "failed" | "abandoned",
  message: string
) {
  const now = new Date().toISOString();
  await db.insert(jobEvents).values({
    jobId,
    eventType,
    message,
    timestamp: now,
  });
}

export async function action({ request }: { request: Request }) {
  const now = new Date().toISOString();
  let uploadedFile: { jobId: string; filename: string; sizeBytes: number } | null = null;

  const formData = await request.formData();
  const destinationPath = (formData.get("destinationPath") as string) || "";

  try {
    await parseFormData(
      request,
      { maxFileSize: MAX_UPLOAD_SIZE },
      async (fileUpload) => {
        if (fileUpload.fieldName === "file") {
          const id = randomUUID();
          const filename = fileUpload.name;

          await db.insert(jobs).values({
            id,
            filename,
            sizeBytes: 0,
            destinationPath,
            status: "UPLOADING",
            createdAt: now,
            updatedAt: now,
          });

          await logJobEvent(id, "created", `Upload started: ${filename}`);

          const jobStagingDir = path.join(config.stagingDir, id);
          await fs.mkdir(jobStagingDir, { recursive: true });

          const dest = path.join(jobStagingDir, filename);
          const writable = fsSync.createWriteStream(dest);
          const reader = fileUpload.stream().getReader();
          let bytesWritten = 0;

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              await new Promise<void>((resolve, reject) => {
                writable.write(value, (err) => (err ? reject(err) : resolve()));
              });

              bytesWritten += value.length;

              if (bytesWritten % PROGRESS_LOG_INTERVAL < value.length) {
                await logJobEvent(
                  id,
                  "created",
                  `Uploading: ${(bytesWritten / 1024 / 1024).toFixed(1)} MB`
                );
              }
            }
          } finally {
            writable.end();
          }

          const sizeBytes = (await fs.stat(dest)).size;
          const timestamp = new Date().toISOString();

          await db
            .update(jobs)
            .set({
              status: "STAGED",
              sizeBytes,
              updatedAt: timestamp,
            })
            .where(eq(jobs.id, id));

          await logJobEvent(
            id,
            "created",
            `File staged: ${filename} (${(sizeBytes / 1024 / 1024).toFixed(2)} MB)`
          );

          uploadedFile = { jobId: id, filename, sizeBytes };

          await startOrQueueArchive(id);
        }
      }
    );

    if (!uploadedFile) {
      return Response.json({ error: "No file provided" }, { status: 400 });
    }

    return Response.json(uploadedFile);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: "Upload failed", details: message }, { status: 500 });
  }
}
