import { expect, it } from "vitest";
import { client, json, mockFetch } from "./helpers.js";

it("preserves document windows and project scope", async () => {
  const { fetch, calls } = mockFetch([json({ content: "window", sources: {}, is_error: false })]);
  const { beakr } = client(fetch);
  await beakr.knowledge.documents("read", { document: "memo", start_line: 21, end_line: 40 }, "project");
  expect(calls[0]!.url).toBe("https://api.example.test/v1/knowledge/documents");
  expect(calls[0]!.body).toEqual({ command: "read", arguments: { document: "memo", start_line: 21, end_line: 40 }, project_id: "project" });
});

it("keeps research limitations and unknown cost", async () => {
  const data = { text: "finding", citations: [], checked: "one file", not_checked: "others", stopped_early: true, cost_usd: null };
  const { fetch } = mockFetch([json(data)]);
  const { beakr } = client(fetch);
  expect(await beakr.knowledge.research("question")).toEqual(data);
});

