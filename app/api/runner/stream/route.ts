import { addClient } from "@/lib/runner";

export const dynamic = "force-dynamic";

// Server-Sent Events: replay history, then push new alerts as they land.
export async function GET() {
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream({
    start(controller) {
      const send = (line: string) => controller.enqueue(encoder.encode(line));
      send("retry: 2000\n\n");
      cleanup = addClient(send);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
