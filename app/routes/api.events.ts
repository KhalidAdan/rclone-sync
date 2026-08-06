import { toReadableStream } from "@culvert/stream";
import { subscribeToJobEvents } from "../lib/events.server";

/**
 * Server-Sent Events stream of job updates. One frame per pipeline
 * transition ({type:"job"}) plus live rclone transfer stats while an
 * archive runs ({type:"stats"}) and keep-alive pings.
 */
export async function loader({ request }: { request: Request }) {
  const source = subscribeToJobEvents(request.signal);
  const encoder = new TextEncoder();

  async function* sse(): AsyncIterable<Uint8Array> {
    yield encoder.encode(`retry: 3000\n\n`);
    for await (const event of source) {
      yield encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
    }
  }

  return new Response(toReadableStream(sse()), {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
