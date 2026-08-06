import {
  findDownloadableJobs,
  zipDownloadResponse,
} from "../lib/download.server";
import { logger } from "../lib/logger.server";

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const jobIds = url.searchParams.get("ids")?.split(",").filter(Boolean) ?? [];

  if (jobIds.length === 0) {
    return Response.json({ error: "No jobs selected" }, { status: 400 });
  }

  logger.info("[api/download-selected] Download requested:", {
    count: jobIds.length,
  });

  const validJobs = await findDownloadableJobs(jobIds);

  if (validJobs.length === 0) {
    return Response.json(
      { error: "No M4B files found on disk" },
      { status: 404 },
    );
  }

  return zipDownloadResponse(validJobs);
}
