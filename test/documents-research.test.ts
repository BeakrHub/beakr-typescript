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

it("rows sends the rows command with every map-walk argument named as the engine names it", async () => {
  const { fetch, calls } = mockFetch([json({ content: "rows", sources: {}, is_error: false })]);
  const { beakr } = client(fetch);
  await beakr.knowledge.rows("connections", {
    pageType: "matter",
    entity: "Stripe",
    to: "Acme",
    connectedTo: "Acme",
    groupBy: "relation",
    regex: true,
    view: "values",
    match: "similar",
    afterCard: "c1",
    scope: "Platform",
  });
  expect(calls[0]!.body).toEqual({
    command: "rows",
    table: "connections",
    page_type: "matter",
    entity: "Stripe",
    to: "Acme",
    connected_to: "Acme",
    group_by: "relation",
    regex: true,
    view: "values",
    match: "similar",
    after_card: "c1",
    scope: "Platform",
  });
});

it("rows reads facts as of a date and by field id", async () => {
  const { fetch, calls } = mockFetch([json({ content: "rows", sources: {}, is_error: false })]);
  const { beakr } = client(fetch);
  await beakr.knowledge.rows("facts", { asOf: "2026-01-31", fieldId: "facts:abc" });
  expect(calls[0]!.body).toEqual({ command: "rows", table: "facts", as_of: "2026-01-31", field_id: "facts:abc" });
});

it("query sends one SELECT as sql, with a cursor", async () => {
  const { fetch, calls } = mockFetch([json({ content: "rows", sources: {}, is_error: false })]);
  const { beakr } = client(fetch);
  await beakr.knowledge.query(
    { sql: "SELECT value, COUNT(*) AS n FROM facts WHERE field = 'Status' GROUP BY value" },
    { scope: "Contracts", cursor: "abc" },
  );
  expect(calls[0]!.body).toEqual({
    command: "query",
    sql: "SELECT value, COUNT(*) AS n FROM facts WHERE field = 'Status' GROUP BY value",
    cursor: "abc",
    scope: "Contracts",
  });
});

it("query sends a structured spec as the query command", async () => {
  const { fetch, calls } = mockFetch([json({ content: "rows", sources: {}, is_error: false })]);
  const { beakr } = client(fetch);
  await beakr.knowledge.query(
    {
      from: { table: "facts", as: "f" },
      where: { and: [{ entity_type: "agreement" }, { not: { value: "Delaware", op: "contains" } }] },
      join: [{ table: "connections", as: "c", on: "same_card", with: "f" }],
      group_by: ["value"],
      aggregate: [{ fn: "count" }, { fn: "count_distinct", of: "entity" }],
      order_by: [{ by: "count", dir: "desc" }],
      limit: 20,
    },
    { scope: "Contracts" },
  );
  expect(calls[0]!.body).toEqual({
    command: "query",
    spec: {
      from: { table: "facts", as: "f" },
      where: { and: [{ entity_type: "agreement" }, { not: { value: "Delaware", op: "contains" } }] },
      join: [{ table: "connections", as: "c", on: "same_card", with: "f" }],
      group_by: ["value"],
      aggregate: [{ fn: "count" }, { fn: "count_distinct", of: "entity" }],
      order_by: [{ by: "count", dir: "desc" }],
      limit: 20,
    },
    scope: "Contracts",
  });
});
