import { describe, expect, it } from "vitest";
import { client, json, mockFetch } from "./helpers.js";

describe("conversation search and freshness", () => {
  it("searches with the given options", async () => {
    const { fetch, calls } = mockFetch([
      json({ data: [{ kind: "imported", id: "c1", title: "Pump", summary: null, href: "/v1/conversations/c1" }] }),
    ]);
    const { beakr } = client(fetch);
    const result = await beakr.conversations.search("which pump curve", {
      projectId: "p1",
      includeThreads: false,
      match: "any",
      limit: 5,
    });
    expect(result.data[0]!.kind).toBe("imported");
    expect(calls[0]!.url).toBe(
      "https://api.example.test/v1/conversations/search?q=which+pump+curve&project_id=p1&include_threads=false&match=any&limit=5",
    );
  });

  it("defaults to all words and includes Beakr chats", async () => {
    const { fetch, calls } = mockFetch([json({ data: [] })]);
    const { beakr } = client(fetch);
    await beakr.conversations.search("pump");
    expect(calls[0]!.url).toBe(
      "https://api.example.test/v1/conversations/search?q=pump&include_threads=true&match=all",
    );
  });

  it("sends what the session read with an import", async () => {
    const { fetch, calls } = mockFetch([json({ conversation_id: "c1", created: true })]);
    const { beakr } = client(fetch);
    await beakr.conversations.import({
      client: "codex",
      sessionId: "s1",
      messages: [{ role: "user", content: "hi" }],
      sourcesRead: [{ page_id: "p-1", revision: 3 }, { source_ref: "src_a", version: "v2" }],
    });
    expect((calls[0]!.body as { sources_read: unknown }).sources_read).toEqual([
      { page_id: "p-1", revision: 3 },
      { source_ref: "src_a", version: "v2" },
    ]);
  });
});
