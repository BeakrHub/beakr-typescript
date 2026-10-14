// Every public list pages the same way: {data, next_cursor, has_more} (spec W1.2, W6.2).
// Root cause guarded: list helpers read one response, so a list longer than one
// page silently lost its later pages once the engine paged every list.
import { describe, expect, it } from "vitest";
import { Beakr } from "../src/index.js";

function pagedFetch(seen: URL[]) {
  return async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    seen.push(url);
    const cursor = url.searchParams.get("cursor");
    const body = cursor
      ? { data: [{ id: "b" }], next_cursor: null, has_more: false }
      : { data: [{ id: "a" }], next_cursor: "c1", has_more: true };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

describe("pagination", () => {
  it("paginate walks any public list to its last page", async () => {
    const seen: URL[] = [];
    const beakr = new Beakr({
      apiKey: "bk_test_x",
      baseUrl: "https://api.test",
      fetch: pagedFetch(seen),
    });
    const ids: unknown[] = [];
    for await (const item of beakr.paginate(
      "/v1/labels",
      { include_archived: true },
      { pageSize: 1 },
    )) {
      ids.push(item["id"]);
    }
    expect(ids).toEqual(["a", "b"]);
    expect(seen[0]!.searchParams.get("limit")).toBe("1");
    expect(seen[0]!.searchParams.get("include_archived")).toBe("true");
    expect(seen[1]!.searchParams.get("cursor")).toBe("c1");
  });

  it("generated list operations have an All iterator that follows the cursor", async () => {
    const seen: URL[] = [];
    const beakr = new Beakr({
      apiKey: "bk_test_x",
      baseUrl: "https://api.test",
      fetch: pagedFetch(seen),
    });
    const ids: unknown[] = [];
    for await (const label of beakr.api.labels.listLabelsAll())
      ids.push((label as { id: string }).id);
    expect(ids).toEqual(["a", "b"]);
  });


});
