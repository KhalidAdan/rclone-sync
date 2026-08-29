import { eq } from "drizzle-orm";
import { db } from "../db/client.server";
import { jobs } from "../db/schema";
import { serveM4b } from "../lib/download.server";

/** Stream a book's M4B for the player (inline, Range-capable). */
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

  return serveM4b(job, request, "inline");
}
