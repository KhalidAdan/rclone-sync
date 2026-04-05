import { useLoaderData, Form } from "react-router";
import type { Route } from "./+types/_layout.jobs";
import { db } from "../db/client.server";
import { jobs } from "../db/schema";
import { getStats } from "../lib/rclone.server";
import { eq, desc } from "drizzle-orm";

export async function loader() {
  const allJobs = await db.select().from(jobs).orderBy(desc(jobs.updatedAt));

  const archiving = allJobs.find((j) => j.status === "ARCHIVING");
  let liveProgress = null;

  if (archiving) {
    try {
      const stats = await getStats();
      liveProgress = {
        jobId: archiving.id,
        bytesTransferred: stats.bytes ?? 0,
        speed: stats.speed ?? 0,
        eta: stats.eta ?? 0,
      };
    } catch {
      // rclone might be down
    }
  }

  return { jobs: allJobs, liveProgress };
}

export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData();
  const intent = formData.get("intent");
  const jobId = formData.get("jobId") as string;

  if (intent === "retry") {
    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    if (job) {
      await db
        .update(jobs)
        .set({
          status: "STAGED",
          retryCount: job.retryCount + 1,
          error: null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(jobs.id, jobId));

      const { startOrQueueArchive } = await import("../lib/archiver.server");
      await startOrQueueArchive(jobId);
    }
  }

  if (intent === "abandon") {
    await db
      .update(jobs)
      .set({
        status: "ABANDONED",
        updatedAt: new Date().toISOString(),
      })
      .where(eq(jobs.id, jobId));
  }

  return { success: true };
}

const statusColors: Record<string, string> = {
  UPLOADING: "bg-blue-100 text-blue-800",
  STAGED: "bg-yellow-100 text-yellow-800",
  QUEUED: "bg-orange-100 text-orange-800",
  ARCHIVING: "bg-purple-100 text-purple-800",
  VERIFYING: "bg-indigo-100 text-indigo-800",
  COMPLETED: "bg-green-100 text-green-800",
  UPLOAD_FAILED: "bg-red-100 text-red-800",
  ARCHIVE_FAILED: "bg-red-100 text-red-800",
  VERIFY_FAILED: "bg-red-100 text-red-800",
  ABANDONED: "bg-gray-100 text-gray-800",
};

export default function Jobs({ loaderData }: Route.ComponentProps) {
  const { jobs: allJobs, liveProgress } = loaderData;

  const hasActiveJob = allJobs.some(
    (j) =>
      j.status === "ARCHIVING" ||
      j.status === "VERIFYING" ||
      j.status === "QUEUED"
  );

  return (
    <>
      {hasActiveJob && <meta httpEquiv="refresh" content="3" />}
      <div className="max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold mb-6">Job Queue</h1>

        {liveProgress && (
          <div className="bg-purple-50 border border-purple-200 rounded-lg p-4 mb-6">
            <div className="flex items-center justify-between mb-2">
              <span className="font-medium">Transferring...</span>
              <span className="text-sm text-gray-600">
                {((liveProgress.bytesTransferred / 1024 / 1024) || 0).toFixed(1)} MB
                {" "}•{" "}
                {((liveProgress.speed || 0) / 1024 / 1024).toFixed(1)} MB/s
              </span>
            </div>
            <div className="w-full bg-purple-200 rounded-full h-2">
              <div
                className="bg-purple-600 h-2 rounded-full animate-pulse"
                style={{ width: "100%" }}
              />
            </div>
          </div>
        )}

        {allJobs.length === 0 ? (
          <p className="text-gray-500">No jobs yet.</p>
        ) : (
          <div className="space-y-3">
            {allJobs.map((job) => {
              const error = job.error ? JSON.parse(job.error) : null;

              return (
                <div
                  key={job.id}
                  className="bg-white border rounded-lg p-4 shadow-sm"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{job.filename}</span>
                        <span
                          className={`px-2 py-0.5 text-xs rounded-full ${
                            statusColors[job.status] || "bg-gray-100"
                          }`}
                        >
                          {job.status}
                        </span>
                      </div>
                      <div className="text-sm text-gray-500 mt-1">
                        {(job.sizeBytes / 1024 / 1024).toFixed(2)} MB
                        {job.destinationPath && ` → ${job.destinationPath}`}
                      </div>
                      {error && (
                        <div className="mt-2 text-sm text-red-600">
                          {error.phase}: {error.message}
                        </div>
                      )}
                    </div>
                    <div className="text-sm text-gray-400">
                      {new Date(job.updatedAt).toLocaleString()}
                    </div>
                  </div>

                  {(job.status === "ARCHIVE_FAILED" || job.status === "VERIFY_FAILED") && (
                    <div className="mt-3 flex gap-2">
                      <Form method="post">
                        <input type="hidden" name="jobId" value={job.id} />
                        <button
                          type="submit"
                          name="intent"
                          value="retry"
                          className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
                        >
                          Retry
                        </button>
                      </Form>
                      <Form method="post">
                        <input type="hidden" name="jobId" value={job.id} />
                        <button
                          type="submit"
                          name="intent"
                          value="abandon"
                          className="px-3 py-1 text-sm text-gray-600 border rounded hover:bg-gray-50"
                        >
                          Abandon
                        </button>
                      </Form>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
