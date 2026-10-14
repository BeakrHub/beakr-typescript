/**
 * Independent Codex review: generated public methods release an event stream
 * (binary exports are covered in output-export-formats.test.ts).
 */
import { describe, expect, it } from "vitest";
import { client, mockFetch } from "./helpers.js";

describe("generated event stream", () => {
  it.each(["consumer stops", "stream completes"])("releases the response when %s", async (ending) => {
    let cancelled = false;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        const type = ending === "stream completes" ? "stream_complete" : "progress";
        c.enqueue(new TextEncoder().encode(`id: 7\ndata: {"type":"${type}"}\n\n`));
      },
      cancel() { cancelled = true; },
    });
    const { fetch, calls } = mockFetch([new Response(body, { headers: { "content-type": "text/event-stream" } })]);
    const { beakr } = client(fetch);
    const stream = await beakr.api.runs.streamRunEvents({ path: { run_id: "r1" }, query: { last_event_id: "6" } });
    try {
      const first = await stream.next();
      expect(first.value?.event_id).toBe("7");
      expect(calls[0]!.url).toContain("last_event_id=6");
      if (ending === "consumer stops") await stream.return(undefined);
      else expect((await stream.next()).done).toBe(true);
      // Leaving an iterator must stop the HTTP body and release its reader.
      expect(cancelled).toBe(true);
      expect(body.locked).toBe(false);
    } finally {
      if (!cancelled) controller.close();
      await stream.return(undefined);
    }
  });

  it("makes the stream available without waiting for the server to close it", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        c.enqueue(new TextEncoder().encode('id: 1\nevent: progress\ndata: {"status":"running"}\n\n'));
      },
    });
    const { fetch } = mockFetch([new Response(body, { headers: { "content-type": "text/event-stream" } })]);
    const { beakr } = client(fetch);
    const pending = Promise.resolve(beakr.api.runs.streamRunEvents({ path: { run_id: "r1" } }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        pending.then(() => "available"),
        new Promise<string>((resolve) => { timer = setTimeout(() => resolve("waiting-for-eof"), 100); }),
      ]);
      expect(outcome).toBe("available");
    } finally {
      if (timer) clearTimeout(timer);
      controller.close();
      await pending;
    }
  });
});
