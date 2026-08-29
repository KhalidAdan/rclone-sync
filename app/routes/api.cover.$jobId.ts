import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import { Readable } from "node:stream";
import { coverPathFor } from "../lib/metadata.server";

/** Embedded cover art extracted from the M4B. 404 → client placeholder. */
export async function loader({ params }: { params: { jobId: string } }) {
  // jobId is a UUID path segment; coverPathFor joins it under covers/.
  if (!/^[0-9a-f-]{36}$/i.test(params.jobId)) {
    return new Response(null, { status: 400 });
  }

  const coverPath = coverPathFor(params.jobId);
  let size: number;
  try {
    size = (await fs.stat(coverPath)).size;
  } catch {
    return new Response(null, { status: 404 });
  }

  return new Response(
    Readable.toWeb(fsSync.createReadStream(coverPath)) as ReadableStream<Uint8Array>,
    {
      headers: {
        "Content-Type": "image/jpeg",
        "Content-Length": String(size),
        "Cache-Control": "public, max-age=86400",
      },
    },
  );
}
