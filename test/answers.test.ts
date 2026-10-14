import { describe, expect, it } from "vitest";
import { RunFailedError, RunNeedsInputError, TextStream, publicSource, sourceWhere } from "../src/index.js";
import { client, json, mockFetch } from "./helpers.js";

const sse = (events: Record<string, unknown>[]) =>
  new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

const delta = (text: string, thinking = false) => ({
  type: "content_delta",
  data: { delta: text, is_thinking: thinking },
});

const upload = {
  key: "rag:a1",
  type: "rag",
  title: "lease.md",
  artifact_id: "8c03c92e-d904-43be-b055-d364a606df74",
  file_name: "lease.md",
  quote: "The lease lasts 300 seconds.",
};

describe("runs.answer", () => {
  // Every integrator used to hand-parse content_delta events, skip thinking and
  // render the {{key}} tokens; the helper does it once, with numbered sources.
  it("returns the final text with [n] citations and their source records", async () => {
    const { fetch, calls } = mockFetch([
      json({ run_id: 42, thread_id: "t1" }),
      sse([
        delta("Planning...", true),
        delta("Lasts 300 s{{rag:"),
        { type: "sources", data: { sources: [{ key: "rag:a1", type: "rag", title: "lease.md" }] } },
        { type: "sources", data: { sources: [upload] } },
        delta("a1}}."),
        {
          type: "stream_complete",
          data: { status: "completed", final_text: "Lasts 300 s{{rag:a1}}, renewed{{rag:b2}}{{rag:a1}}." },
        },
      ]),
      json({ run_id: "42", thread_id: "t1", status: "completed" }),
    ]);
    const { beakr } = client(fetch);
    const answer = await beakr.runs.answer({ question: "How long?", projectId: "p1" });
    expect(answer.run_id).toBe("42");
    expect(answer.text).toBe("Lasts 300 s[1], renewed[2][1].");
    expect(answer.sources.map((s) => s.citation_key)).toEqual(["rag:a1", "rag:b2"]);
    expect(answer.sources[0]).toMatchObject({
      name: "lease.md",
      filename: "lease.md",
      location: { file_id: upload.artifact_id },
      evidence: { excerpt: "The lease lasts 300 seconds." },
    });
    expect(calls[0]!.body).toMatchObject({ message: "How long?", home_project_id: "p1" });
    expect(new URL(calls[1]!.url).pathname).toBe("/v1/runs/42/events");
  });

  it("falls back to the visible deltas when there is no final text", async () => {
    const { fetch } = mockFetch([
      json({ run_id: "r1" }),
      sse([delta("hidden", true), delta("Hello "), delta("world"), { type: "stream_complete", data: { status: "completed" } }]),
      json({ run_id: "r1", status: "completed" }),
    ]);
    const answer = await client(fetch).beakr.runs.answer({ question: "q" });
    expect(answer).toEqual({ text: "Hello world", sources: [], run_id: "r1" });
  });

  it("throws RunFailedError when the run fails", async () => {
    const { fetch } = mockFetch([
      json({ run_id: "r1" }),
      sse([{ type: "error", data: { message: "model unavailable" } }, { type: "stream_complete", data: { status: "error" } }]),
      json({ run_id: "r1", status: "error" }),
    ]);
    const error = await client(fetch).beakr.runs.answer({ question: "q" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RunFailedError);
    expect((error as RunFailedError).message).toContain("model unavailable");
  });

  // GET /v1/runs `answer` is the single source of truth for a completed run;
  // the stream only adds what the engine's record leaves out (the file id).
  it("returns the engine's rendered answer, completed with the streamed file id", async () => {
    const engineRecord = {
      source_ref: "beakr-source:v1:key:x",
      citation_key: "rag:a1",
      name: "lease.md",
      filename: "lease.md",
      source_kind: "rag",
      location: { display_path: "lease.md" },
      evidence: { excerpt: "Engine excerpt" },
    };
    const { fetch } = mockFetch([
      json({ run_id: "r1", thread_id: "t1" }),
      sse([{ type: "sources", data: { sources: [upload] } }, { type: "stream_complete", data: { status: "completed" } }]),
      json({
        run_id: "r1",
        status: "completed",
        answer: { text: "Engine-rendered.[1]", raw_text: "Engine-rendered.{{rag:a1}}", sources: [engineRecord] },
      }),
    ]);
    const answer = await client(fetch).beakr.runs.answer({ question: "q" });
    expect(answer.text).toBe("Engine-rendered.[1]");
    expect(answer.sources[0]).toMatchObject({
      provider: "upload",
      location: { display_path: "lease.md", file_id: upload.artifact_id },
      evidence: { excerpt: "Engine excerpt" },
    });
  });

  // Dogfood row 9: an out-of-scope question parked the run on an ask-user
  // decision with no answer text, and the helper returned an empty answer.
  it("throws RunNeedsInputError with the run's question when the run parks", async () => {
    const question = { text: "Are you authorized?", options: ["Yes", "No"], context: null };
    const { fetch, calls } = mockFetch([
      json({ run_id: "r1", thread_id: "t1" }),
      sse([
        { type: "stream_complete", thread_id: "t1", data: { status: "interrupted", interrupt_kind: "decision" } },
      ]),
      json({ run_id: "r1", status: "interrupted", question }),
    ]);
    const error = await client(fetch).beakr.runs.answer({ question: "Customer B's codename?" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RunNeedsInputError);
    expect(error).toBeInstanceOf(RunFailedError);
    const parked = error as RunNeedsInputError;
    expect(parked.question).toEqual(question);
    expect(parked.threadId).toBe("t1");
    expect(parked.interruptKind).toBe("decision");
    expect(parked.message).toContain("Are you authorized?");
    expect(new URL(calls[2]!.url).pathname).toBe("/v1/runs/r1");
  });
});

describe("runs.streamText", () => {
  it("yields visible text with citations numbered across deltas", async () => {
    const { fetch } = mockFetch([
      sse([delta("thinking", true), delta("A{"), delta("{k1}} B{{k2"), delta("}} C{{k1}}"), { type: "stream_complete", data: {} }]),
    ]);
    const chunks: string[] = [];
    for await (const chunk of client(fetch).beakr.runs.streamText("r1")) chunks.push(chunk);
    expect(chunks.join("")).toBe("A[1] B[2] C[1]");
    expect(chunks.join("")).not.toContain("thinking");
  });

  it("releases an unclosed brace run that is too long to be a citation", () => {
    const stream = new TextStream();
    expect(stream.feed("{{" + "x".repeat(300))).toBe("{{" + "x".repeat(300));
  });
});

describe("publicSource", () => {
  // Regression: compact Knowledge records carry their passages as `excerpts`
  // (each with its token and place); publicSource dropped them and the new
  // location fields, so a Sources listing showed no excerpt or place.
  it("keeps where the passage sits and a compact record's excerpts", () => {
    const record = publicSource({
      name: "memo.pdf",
      citation_key: "artifact:v1-u1",
      provider: "upload",
      location: {
        file_id: "f1",
        display_path: "deals/acme/memo.pdf",
        unit_locator: "p. 7",
        upload_path: "acme/memo.pdf",
        internal_unit_id: "secret",
      },
      excerpts: [
        { citation_key: "artifact:v1-u1", unit_locator: "p. 7", text: "Rent is $5" },
        { citation_key: "artifact:v1-u2", text: "" },
        { citation_key: "artifact:v1-u3", unit_locator: "p. 9", text: "Term: 5y" },
      ],
      cited_passages: 3,
    });
    expect(record.location).toEqual({
      display_path: "deals/acme/memo.pdf",
      unit_locator: "p. 7",
      upload_path: "acme/memo.pdf",
      file_id: "f1",
    });
    expect(record.excerpts).toEqual([
      { citation_key: "artifact:v1-u1", unit_locator: "p. 7", text: "Rent is $5" },
      { citation_key: "artifact:v1-u3", unit_locator: "p. 9", text: "Term: 5y" },
    ]);
    expect(record.cited_passages).toBe(3);
  });

  it("keeps the public contract and says where a source lives", () => {
    const record = publicSource({
      source_ref: "beakr-source:v1:abc",
      key: "artifact:v1-u1",
      source_type: "artifact",
      source_title: "plan.md",
      section_id: "sec_description",
      stance: "support",
      file_name: "plan.md",
      origin: "upload",
      artifact_id: "f1",
      artifact_version_id: "internal-version",
      doc_sha256: "deadbeef",
      excerpt: "quoted",
      fidelity: "verbatim",
      source_moved: false,
    });
    expect(record).toEqual({
      source_ref: "beakr-source:v1:abc",
      citation_key: "artifact:v1-u1",
      name: "plan.md",
      filename: "plan.md",
      provider: "upload",
      source_kind: "artifact",
      stance: "support",
      location: { file_id: "f1" },
      evidence: { excerpt: "quoted", fidelity: "verbatim" },
      status: { changed_since_cited: false },
      section: { id: "sec_description" },
    });
    expect(sourceWhere(record)).toBe("plan.md · upload · file f1 (`beakr files download f1`)");
  });

  it("points a connector file at its original", () => {
    const record = publicSource({
      title: "Q3 plan",
      source_provider: "google_drive",
      web_view_url: "https://drive.example/q3",
      path: "Team/Plans/Q3 plan.pdf",
      artifact_id: "f2",
    });
    expect(sourceWhere(record)).toBe("Q3 plan.pdf · google_drive · https://drive.example/q3");
  });

  it("does not repeat a path that is only the filename", () => {
    const record = publicSource({ key: "rag:1", type: "rag", title: "guide.md", path: "guide.md", artifact_id: "f3" });
    expect(sourceWhere(record)).toBe("guide.md · upload · file f3 (`beakr files download f3`)");
  });
});

describe("knowledge.pages.sources", () => {
  it("returns every page source as a public source record", async () => {
    const { fetch, calls } = mockFetch([
      json({ data: [{ key: "artifact:a-u1", source_title: "a.md", artifact_id: "f1", meta: { origin: "upload" } }], next_cursor: "c2", has_more: true }),
      json({ data: [{ key: "artifact:b-u1", source_title: "b.md", web_view_url: "https://x/b" }], next_cursor: null, has_more: false }),
    ]);
    const sources = await client(fetch).beakr.knowledge.pages.sources("page-1");
    expect(sources.map((s) => s.citation_key)).toEqual(["artifact:a-u1", "artifact:b-u1"]);
    expect(sources[0]!.location).toEqual({ file_id: "f1" });
    expect(sources[1]!.location).toEqual({ url: "https://x/b" });
    expect(new URL(calls[0]!.url).pathname).toBe("/v1/knowledge/wiki/pages/page-1/sources");
    expect(new URL(calls[1]!.url).searchParams.get("cursor")).toBe("c2");
  });
});
