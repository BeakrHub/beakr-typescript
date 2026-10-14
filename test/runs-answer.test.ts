import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/index.js";
import { client, json, mockFetch } from "./helpers.js";

// Root cause (proof run): the Python SDK's runs.answer takes the question as a
// string and the TypeScript one took only {question}; and an empty question
// was sent, costing a round trip to learn it was a 422.
describe("runs.answer", () => {
  it("takes the question as a plain string, like the Python SDK", async () => {
    const { fetch, calls } = mockFetch([
      json({ run_id: "r1", thread_id: "t1" }, 202),
      new Response('data: {"type":"stream_complete"}\n\n', { headers: { "content-type": "text/event-stream" } }),
      json({ id: "r1", status: "completed", answer: { text: "Five minutes.", sources: [] } }),
    ]);
    const { beakr } = client(fetch);
    const answer = await beakr.runs.answer("How long is a lease?", { projectId: "p1" });
    expect(answer.text).toBe("Five minutes.");
    const sent = calls[0]!.body as Record<string, unknown>;
    expect(sent["message"]).toBe("How long is a lease?");
    expect(sent["home_project_id"]).toBe("p1");
  });

  it("refuses an empty question without sending a request", async () => {
    const { fetch, calls } = mockFetch([]);
    const { beakr } = client(fetch);
    await expect(beakr.runs.answer("   ")).rejects.toBeInstanceOf(ValidationError);
    await expect(beakr.runs.answer({ question: "" })).rejects.toBeInstanceOf(ValidationError);
    expect(calls).toHaveLength(0);
  });
});
