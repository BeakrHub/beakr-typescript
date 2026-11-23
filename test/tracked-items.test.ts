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
});
