// Hand-written list helpers must send every filter and paging option the route
// takes, and offer an iterator that follows cursors.
// Root cause guarded (sandbox e2e 2026-10-25): projects.list() accepted only
// memberOnly and dropped limit/cursor, so an organization with more projects than
// one page silently got the first page; members, service accounts, integrations,
// proposals and threads had the same gap.
import { describe, expect, it } from "vitest";
import { Beakr } from "../src/index.js";

const ORG = "00000000-0000-4000-8000-000000000001";

function pagedFetch(seen: URL[]) {
  return async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    seen.push(url);
    if (url.pathname === "/v1/me/organization") {
      return new Response(JSON.stringify({ id: ORG }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
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

function client(seen: URL[]) {
  return new Beakr({ apiKey: "bk_test_x", baseUrl: "https://api.test", fetch: pagedFetch(seen) });
}

async function ids(items: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const item of items) out.push((item as { id: string }).id);
  return out;
}

describe("list helpers send their filters and paging", () => {
  it("projects.list sends every filter and the page options", async () => {
    const seen: URL[] = [];
    await client(seen).projects.list({
      memberOnly: true,
      ownerUserId: "u1",
      groupId: "g1",
      includeKnowledge: true,
      cursor: "c0",
      limit: 5,
    });
    const q = seen[0]!.searchParams;
    expect(q.get("member_only")).toBe("true");
    expect(q.get("owner_user_id")).toBe("u1");
    expect(q.get("group_id")).toBe("g1");
    expect(q.get("include_knowledge")).toBe("true");
    expect(q.get("cursor")).toBe("c0");
    expect(q.get("limit")).toBe("5");
  });

  it("projects.iter follows cursors to the last page", async () => {
    const seen: URL[] = [];
    expect(await ids(client(seen).projects.iter({ memberOnly: true }, 1))).toEqual(["a", "b"]);
    expect(seen[1]!.searchParams.get("cursor")).toBe("c1");
    expect(seen[1]!.searchParams.get("member_only")).toBe("true");
  });

  it("project members page and iterate", async () => {
    const seen: URL[] = [];
    const beakr = client(seen);
    await beakr.projects.members("p1", { cursor: "c0", limit: 2 });
    expect(seen[0]!.searchParams.get("cursor")).toBe("c0");
    expect(await ids(beakr.projects.iterMembers("p1"))).toEqual(["a", "b"]);
  });

  it("organization members and service accounts page and iterate", async () => {
    const seen: URL[] = [];
    const beakr = client(seen);
    await beakr.members.list(ORG, { limit: 3 });
    expect(seen.at(-1)!.searchParams.get("limit")).toBe("3");
    expect(await ids(beakr.members.iter(ORG))).toEqual(["a", "b"]);
    await beakr.org.serviceAccounts.list(ORG, { cursor: "c0" });
    expect(seen.at(-1)!.searchParams.get("cursor")).toBe("c0");
    expect(await ids(beakr.org.serviceAccounts.iter(ORG))).toEqual(["a", "b"]);
  });

  it("integrations page and iterate", async () => {
    const seen: URL[] = [];
    const beakr = client(seen);
    await beakr.integrations.list({ limit: 4 });
    expect(seen[0]!.searchParams.get("limit")).toBe("4");
    expect(await ids(beakr.integrations.iter())).toEqual(["a", "b"]);
  });

  it("proposals send every filter and iterate", async () => {
    const seen: URL[] = [];
    const beakr = client(seen);
    await beakr.knowledge.proposals.list({
      status: "pending",
      projectId: "p1",
      groupId: "g1",
      labelId: "l1",
      batchId: "b1",
      source: "capture",
      cursor: "c0",
      limit: 7,
    });
    const q = seen[0]!.searchParams;
    expect([q.get("project_id"), q.get("group_id"), q.get("label_id")]).toEqual(["p1", "g1", "l1"]);
    expect([q.get("batch_id"), q.get("source"), q.get("cursor"), q.get("limit")]).toEqual([
      "b1",
      "capture",
      "c0",
      "7",
    ]);
    expect(await ids(beakr.knowledge.proposals.iter({ projectId: "p1" }))).toEqual(["a", "b"]);
  });

  it("threads send their filters and iterate", async () => {
    const seen: URL[] = [];
    const beakr = client(seen);
    await beakr.runs.threads({ q: "plate", projectIds: ["p1", "p2"], notifications: "exclude", cursor: "c0" });
    const q = seen[0]!.searchParams;
    expect(q.get("q")).toBe("plate");
    expect(q.getAll("project_ids")).toEqual(["p1", "p2"]);
    expect(q.get("notifications")).toBe("exclude");
    expect(q.get("cursor")).toBe("c0");
    expect(await ids(beakr.runs.iterThreads({ q: "plate" }))).toEqual(["a", "b"]);
  });
});
