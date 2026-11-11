/**
 * The read trail: what a session read, and what it read before each write.
 * The Python SDK's tests/test_read_trail.py pins the same behaviour.
 */
import { describe, expect, it } from "vitest";
import { client, json, mockFetch } from "./helpers.js";

const PHARMA_A = { id: "pa", name: "Pharma A" };

function read(id: string) {
  return {
    id,
    session_id: "s1",
    at: "2026-11-11T03:00:00Z",
    op: "search",
    projects: [PHARMA_A],
    items: [{ kind: "page", id: "pg1", title: "Assay", project_id: "pa", service: null }],
    summary: "assay results",
    request_id: "r1",
    client: "sdk-typescript",
    agent: null,
    redacted: false,
  };
}

const writeTrail = {
  write: { kind: "proposal", id: "pr1", project: PHARMA_A, at: "2026-11-11T03:01:00Z" },
  session_id: "s1",
  recorded: true,
  cross_project: false,
  groups: [{ project: PHARMA_A, cross_project: false, external: false, reads: [read("r1")] }],
  reads_total: 1,
  truncated: false,
};

const path = (url: string) => new URL(url).pathname;

describe("sessions.trail", () => {
  it("reads the current session's trail without an id", async () => {
    const page = { data: [read("r2"), read("r1")], next_cursor: null, has_more: false };
    const { fetch, calls } = mockFetch([json({ id: "s1", status: "active" }), json(page)]);
    const { beakr } = client(fetch);
    expect(await beakr.sessions.trail(undefined, { limit: 50 })).toEqual(page);
    expect(path(calls[0]!.url)).toBe("/v1/sessions/current");
    expect(path(calls[1]!.url)).toBe("/v1/sessions/s1/trail");
    expect(new URL(calls[1]!.url).searchParams.get("limit")).toBe("50");
  });

  it("iterTrail follows the cursor", async () => {
    const { fetch } = mockFetch([
      json({ data: [read("r3")], next_cursor: "c2", has_more: true }),
      json({ data: [read("r2")], next_cursor: null, has_more: false }),
    ]);
    const { beakr } = client(fetch);
    const ids: string[] = [];
    for await (const r of beakr.sessions.iterTrail("s1")) ids.push(r.id);
    expect(ids).toEqual(["r3", "r2"]);
  });

  it("a started session reads its own trail with its own id", async () => {
    const { fetch, calls } = mockFetch([
      json({ id: "s1", status: "active" }, 201),
      json({ data: [], next_cursor: null, has_more: false }),
      json({ id: "s1", status: "ended" }),
    ]);
    const { beakr } = client(fetch);
    await beakr.sessions.within({}, async (s) => {
      await s.trail();
      expect(path(calls[1]!.url)).toBe("/v1/sessions/s1/trail");
      expect(calls[1]!.headers["x-beakr-session"]).toBe(s.agentSessionId);
    });
  });
});

describe("a write's trail", () => {
  it("by proposal, ingestion event or page revision", async () => {
    const { fetch, calls } = mockFetch([json(writeTrail), json(writeTrail), json(writeTrail)]);
    const { beakr } = client(fetch);
    const trail = await beakr.knowledge.proposals.trail("pr1");
    await beakr.knowledge.ingestionEventTrail("ev1");
    await beakr.knowledge.pages.revisionTrail("pg1", 3);
    expect(trail.groups?.[0]?.reads?.[0]?.op).toBe("search");
    expect(calls.map((c) => path(c.url))).toEqual([
      "/v1/knowledge/wiki/proposals/pr1/trail",
      "/v1/knowledge/wiki/ingestion-events/ev1/trail",
      "/v1/knowledge/wiki/pages/pg1/revisions/3/trail",
    ]);
  });

  it("retention is set on the active organization", async () => {
    const settings = { read_trail_retention_days: 30, available: true, can_change: true };
    const { fetch, calls } = mockFetch([json({ id: "org1" }), json(settings)]);
    const { beakr } = client(fetch);
    expect(await beakr.projectIsolation.setReadTrailRetention(30)).toEqual(settings);
    expect([calls[1]!.method, path(calls[1]!.url), calls[1]!.body]).toEqual([
      "PUT",
      "/v1/organizations/org1/read-trail",
      { read_trail_retention_days: 30 },
    ]);
  });
});
