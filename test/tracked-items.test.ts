/**
 * A source's tracked items (Python's `tests/test_tracked_items.py`):
 * `integrations.trackedItems` reads one page with its filters and
 * `integrations.iterTrackedItems` follows the cursor.
 */
import { describe, expect, it } from "vitest";
import { client, json, mockFetch } from "./helpers.js";

const path = (url: string) => new URL(url).pathname;
const query = (url: string) => Object.fromEntries(new URL(url).searchParams);
const counts = { total: 3, pending: 0, ingested: 2, skipped: 1, removed: 0 };
const skipped = {
  external_id: "conn:t1",
  title: "Lunch order",
  kind: "thread",
  state: "skipped",
  reason_code: "nothing_to_add",
  reason: "A lunch order; nothing for the project.",
};
const ingested = { ...skipped, external_id: "conn:t2", title: "Assay", state: "ingested", reason_code: null, reason: null };
const page = (data: object[], next: string | null) => ({
  data,
  next_cursor: next,
  has_more: next !== null,
  provider: "gmail",
  kind: "thread",
  counts,
  matched: data.length,
});

describe("tracked items", () => {
  it("reads one page, sending only the filters given", async () => {
    const { fetch, calls } = mockFetch([json(page([skipped], null)), json(page([skipped], null))]);
    const { beakr } = client(fetch);
    const first = await beakr.integrations.trackedItems("p1", "s1");
    expect(first.data[0]?.reason_code).toBe("nothing_to_add");
    expect(first.counts.skipped).toBe(1);
    await beakr.integrations.trackedItems("p1", "s1", {
      state: "skipped",
      reasonCode: "nothing_to_add",
      search: "lunch",
      since: "2026-11-23T10:00:00+00:00",
      cursor: "c2",
      limit: 10,
    });
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET"]);
    expect(path(calls[0]!.url)).toBe("/v1/projects/p1/sources/s1/tracked-items");
    expect(query(calls[0]!.url)).toEqual({});
    expect(query(calls[1]!.url)).toEqual({
      state: "skipped",
      reason_code: "nothing_to_add",
      search: "lunch",
      since: "2026-11-23T10:00:00+00:00",
      cursor: "c2",
      limit: "10",
    });
  });

  it("follows the cursor through every item, keeping the filters", async () => {
    const { fetch, calls } = mockFetch([json(page([skipped], "c2")), json(page([ingested], null))]);
    const { beakr } = client(fetch);
    const seen: string[] = [];
    for await (const item of beakr.integrations.iterTrackedItems("p1", "s1", { search: "a" })) {
      seen.push(item.external_id);
    }
    expect(seen).toEqual(["conn:t1", "conn:t2"]);
    expect(query(calls[0]!.url).search).toBe("a");
    expect(query(calls[1]!.url)).toMatchObject({ search: "a", cursor: "c2" });
  });

  it("encodes each id as one path segment", async () => {
    const { fetch, calls } = mockFetch([json(page([], null))]);
    const { beakr } = client(fetch);
    await beakr.integrations.trackedItems("p/1", "s/1");
    expect(path(calls[0]!.url)).toBe("/v1/projects/p%2F1/sources/s%2F1/tracked-items");
  });

  it("filters failed items by their state", async () => {
    const failed = { ...skipped, external_id: "conn:t3", state: "failed", reason_code: "compile_failed" };
    const { fetch, calls } = mockFetch([json(page([failed], null))]);
    const { beakr } = client(fetch);
    const first = await beakr.integrations.trackedItems("p1", "s1", { state: "failed" });
    expect(first.data[0]!.state).toBe("failed");
    expect(query(calls[0]!.url)).toEqual({ state: "failed" });
  });

  it("reads how a source's last history import ended", async () => {
    const ended = {
      provider: "gdrive:nango",
      supported: true,
      status: "idle",
      last_outcome: { in_knowledge: 492, skipped: 93, failed: 26, left: 0, state: "finished" },
    };
    const { fetch, calls } = mockFetch([json(ended)]);
    const { beakr } = client(fetch);
    const status = await beakr.integrations.historyImportStatus("p/1", "s1");
    expect(status.status).toBe("idle");
    expect(path(calls[0]!.url)).toBe("/v1/projects/p%2F1/sources/s1/history-import/status");
  });

  it("sends named items again in the mode asked, and every item as a dry run", async () => {
    const sent = { mode: "full", dry_run: false, requested: 2, in_knowledge_left: 0, over_cap: 0, not_found: [], sync: "started", sync_job_id: null };
    const { fetch, calls } = mockFetch([json(sent), json({ ...sent, dry_run: true, sync: "not_started" })]);
    const { beakr } = client(fetch);
    const first = await beakr.integrations.recompile("p1", "s1", { externalIds: ["conn:t1"], mode: "full" });
    expect(first.sync).toBe("started");
    expect(calls[0]!.method).toBe("POST");
    expect(path(calls[0]!.url)).toBe("/v1/projects/p1/sources/s1/recompile");
    expect(calls[0]!.body).toEqual({ mode: "full", dry_run: false, external_ids: ["conn:t1"] });
    await beakr.integrations.recompile("p1", "s1", { all: true, dryRun: true });
    expect(calls[1]!.body).toEqual({ mode: "retry", dry_run: true, all: true });
  });

  it("refuses a recompile that names neither items nor all, or both", () => {
    const { fetch } = mockFetch([]);
    const { beakr } = client(fetch);
    expect(() => beakr.integrations.recompile("p1", "s1", {})).toThrow(TypeError);
    expect(() => beakr.integrations.recompile("p1", "s1", { externalIds: ["x"], all: true })).toThrow(TypeError);
  });

  it("filters partial items by their state", async () => {
    const partial = { ...skipped, external_id: "conn:t4", state: "partial", reason_code: "compile_partial", unfinished_changes: 3 };
    const { fetch, calls } = mockFetch([json(page([partial], null))]);
    const { beakr } = client(fetch);
    const first = await beakr.integrations.trackedItems("p1", "s1", { state: "partial" });
    expect(first.data[0]!.unfinished_changes).toBe(3);
    expect(query(calls[0]!.url)).toEqual({ state: "partial" });
  });
});
