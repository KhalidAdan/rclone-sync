import {
  findDownloadableJobs,
  zipDownloadResponse,
} from "../lib/download.server";
import { logger } from "../lib/logger.server";

/** Bulk ZIP export of not-yet-downloaded books (escape hatch). */
export async function loader({ request }: { request: Request }) {
  logger.info("[api/download-all] Download all requested");

  const validJobs = await findDownloadableJobs();

  if (validJobs.length === 0) {
    return Response.json(
      { error: "No files ready for download" },
      { status: 404 },
    );
  }

  logger.info("[api/download-all] Streaming archive:", {
    count: validJobs.length,
  });

  return zipDownloadResponse(validJobs, request.signal);
}
