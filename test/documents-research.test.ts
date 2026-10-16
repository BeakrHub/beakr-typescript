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


it("documentsSearch sends the search command with its options and scope", async () => {
  const results = [{ source_ref: "beakr-source:v1:key:x.f1", passages: [] }];
  const { fetch, calls } = mockFetch([json({ content: "1 doc", sources: {}, results, is_error: false })]);
  const { beakr } = client(fetch);
  const found = await beakr.knowledge.documentsSearch("who indemnifies whom", {
    limit: 5,
    passages: 3,
    glob: "*.pdf",
    projectId: "Deals",
  });
  expect(found.results).toEqual(results);
  expect(calls[0]!.body).toEqual({
    command: "search",
    arguments: { query: "who indemnifies whom", limit: 5, passages: 3, glob: "*.pdf" },
    project_id: "Deals",
  });
});

it("downloadLink signs any reference in one request", async () => {
  const link = {
    url: "https://storage.test/k",
    expires_in: 120,
    filename: "memo.pdf",
    mime_type: "application/pdf",
    file: { id: "f1", version_id: "v1", title: "memo.pdf", display_path: "memo.pdf" },
  };
  const { fetch, calls } = mockFetch([json(link)]);
  const { beakr } = client(fetch);
  const signed = await beakr.files.downloadLink("beakr-source:v1:key:cmFnOjE.f1", { inline: true });
  expect(signed.url).toBe("https://storage.test/k");
  expect(new URL(calls[0]!.url).pathname).toBe("/v1/artifacts/download-url");
  expect(calls[0]!.body).toEqual({ reference: "beakr-source:v1:key:cmFnOjE.f1", inline: true });
});
