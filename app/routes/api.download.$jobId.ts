import { eq } from "drizzle-orm";
import { db } from "../db/client.server";
import { jobs } from "../db/schema";
import { serveM4b } from "../lib/download.server";

/** Download a single book's M4B (attachment, Range-capable = resumable). */
export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { jobId: string };
}) {
  const [job] = await db
    .select()
    .from(jobs)
    .where(eq(jobs.id, params.jobId))
    .limit(1);

  if (!job) {
    return Response.json({ error: "Job not found" }, { status: 404 });
  }

  return serveM4b(job, request, "attachment");
}
