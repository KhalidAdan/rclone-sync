import { parseFormData } from "@remix-run/form-data-parser";
import { desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { Form, redirect, useNavigation } from "react-router";
import { db } from "../db/client.server";
import { jobEvents, jobs } from "../db/schema";
import { startOrQueueArchive } from "../lib/archiver.server";
import { config } from "../lib/config.server";
import type { Route } from "./+types/_layout._index";

const MAX_UPLOAD_SIZE = 1.5 * 1024 * 1024 * 1024; // 1.5GB

export async function loader() {
  const stagedJobs = await db
    .select()
    .from(jobs)
    .where(eq(jobs.status, "STAGED"))
    .orderBy(desc(jobs.createdAt));

  const queuedJobs = await db
    .select()
    .from(jobs)
    .where(eq(jobs.status, "QUEUED"))
    .orderBy(desc(jobs.createdAt));

  return { stagedJobs, queuedJobs };
}

export async function action({ request }: Route.ActionArgs) {
  const now = new Date().toISOString();
  const destinationPath = "";

  try {
    await parseFormData(
      request,
      { maxFileSize: MAX_UPLOAD_SIZE },
      async (fileUpload) => {
        if (fileUpload.fieldName === "file") {
          const id = randomUUID();
          const jobStagingDir = path.join(config.stagingDir, id);
          await fs.mkdir(jobStagingDir, { recursive: true });

          const filename = fileUpload.name;
          const dest = path.join(jobStagingDir, filename);
          const writable = fsSync.createWriteStream(dest);
          const reader = fileUpload.stream().getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              await new Promise<void>((resolve, reject) => {
                writable.write(value, (err) => err ? reject(err) : resolve());
              });
            }
          } finally {
            writable.end();
          }
          const sizeBytes = (await fs.stat(dest)).size;

          await db.insert(jobs).values({
            id,
            filename,
            sizeBytes,
            destinationPath,
            status: "STAGED",
            createdAt: now,
            updatedAt: now,
          });

          await db.insert(jobEvents).values({
            jobId: id,
            eventType: "created",
            message: `File uploaded: ${filename} (${(sizeBytes / 1024 / 1024).toFixed(2)} MB)`,
            timestamp: now,
          });

          await startOrQueueArchive(id);
        }
      },
    );

    return redirect("/jobs");
  } catch (err) {
    throw err;
  }
}

export default function Upload({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { stagedJobs, queuedJobs } = loaderData;
  const navigation = useNavigation();
  const isUploading = navigation.state === "submitting";

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Upload Audiobook</h1>

      <Form method="post" encType="multipart/form-data" className="space-y-4">
        <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center hover:border-gray-400 transition-colors">
          <input
            type="file"
            name="file"
            id="file"
            required
            className="block w-full text-sm text-gray-500
              file:mr-4 file:py-2 file:px-4
              file:rounded-full file:border-0
              file:text-sm file:font-semibold
              file:bg-blue-50 file:text-blue-700
              hover:file:bg-blue-100"
            multiple
          />
        </div>

        <div>
          <label
            htmlFor="destinationPath"
            className="block text-sm font-medium text-gray-700 mb-1"
          >
            Destination Path (optional)
          </label>
          <input
            type="text"
            name="destinationPath"
            id="destinationPath"
            placeholder="e.g., Fiction/Fantasy/"
            className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
          />
        </div>

        <button
          type="submit"
          disabled={isUploading}
          className="w-full bg-blue-600 text-white py-2 px-4 rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isUploading ? "Uploading..." : "Upload"}
        </button>
      </Form>

      {(stagedJobs.length > 0 || queuedJobs.length > 0) && (
        <div className="mt-8">
          <h2 className="text-lg font-semibold mb-4">Pending Files</h2>

          {stagedJobs.length > 0 && (
            <div className="mb-4">
              <h3 className="text-sm font-medium text-gray-500 mb-2">Staged</h3>
              <ul className="space-y-2">
                {stagedJobs.map((job) => (
                  <li
                    key={job.id}
                    className="bg-white p-3 rounded-md shadow-sm border"
                  >
                    <div className="font-medium">{job.filename}</div>
                    <div className="text-sm text-gray-500">
                      {(job.sizeBytes / 1024 / 1024).toFixed(2)} MB
                      {job.destinationPath && ` → ${job.destinationPath}`}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {queuedJobs.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-gray-500 mb-2">Queued</h3>
              <ul className="space-y-2">
                {queuedJobs.map((job) => (
                  <li
                    key={job.id}
                    className="bg-white p-3 rounded-md shadow-sm border"
                  >
                    <div className="font-medium">{job.filename}</div>
                    <div className="text-sm text-gray-500">
                      {(job.sizeBytes / 1024 / 1024).toFixed(2)} MB
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
