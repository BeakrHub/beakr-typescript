import { describe, expect, it } from "vitest";
import { client, json, mockFetch } from "./helpers.js";

// Root cause: the server reads a run's Knowledge toggle as off unless the scope
// asks for it (its scope resolver defaults `knowledge_graph` to false), and
// runs.start sent no toggle, so every run the SDK started answered "Knowledge
// is turned off for this message". Knowledge is on by default, with or without
// a project, and off only when asked.
describe("runs Knowledge toggle", () => {
  const stream = () =>
    new Response('data: {"type":"stream_complete"}\n\n', { headers: { "content-type": "text/event-stream" } });
  const done = () => json({ id: "r1", status: "completed", answer: { text: "Yes.", sources: [] } });

  it("turns Knowledge on by default", async () => {
    const { fetch, calls } = mockFetch([json({ run_id: "r1" }, 202)]);
    const { beakr } = client(fetch);
    await beakr.runs.start("hello");
    expect((calls[0]!.body as Record<string, unknown>)["scope"]).toEqual({ knowledge_graph: true });
  });

  it("keeps the project scope beside the toggle and turns Knowledge off when asked", async () => {
    const { fetch, calls } = mockFetch([json({ run_id: "r1" }, 202), json({ run_id: "r2" }, 202)]);
    const { beakr } = client(fetch);
    await beakr.runs.start("hello", { projectId: "p1" });
    await beakr.runs.start("hello", { projectId: "p1", knowledge: false });
    expect((calls[0]!.body as Record<string, unknown>)["scope"]).toEqual({
      knowledge_graph: true,
      projects: [{ id: "p1" }],
    });
    expect((calls[1]!.body as Record<string, unknown>)["scope"]).toEqual({
      knowledge_graph: false,
      projects: [{ id: "p1" }],
    });
  });

  it("passes the toggle from runs.answer to the run it starts", async () => {
    const { fetch, calls } = mockFetch([
      json({ run_id: "r1" }, 202),
      stream(),
      done(),
      json({ run_id: "r1" }, 202),
      stream(),
      done(),
    ]);
    const { beakr } = client(fetch);
    await beakr.runs.answer("How long is a lease?");
    await beakr.runs.answer({ question: "How long is a lease?", knowledge: false });
    const scopes = calls
      .filter((call) => call.method === "POST")
      .map((call) => (call.body as Record<string, unknown>)["scope"]);
    expect(scopes).toEqual([{ knowledge_graph: true }, { knowledge_graph: false }]);
  });
});
