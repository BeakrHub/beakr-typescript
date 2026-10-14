import { describe, expect, it } from "vitest";
import { KnowledgeCommandError } from "../src/index.js";
import { client, json, mockFetch } from "./helpers.js";

const path = (url: string) => url.replace("https://api.example.test", "");

describe("pagination", () => {
  it("follows next_cursor until has_more is false", async () => {
    const { fetch, calls } = mockFetch([
      json({ data: [{ id: "c1" }, { id: "c2" }], next_cursor: "cur_2", has_more: true }),
      json({ data: [{ id: "c3" }], next_cursor: null, has_more: false }),
    ]);
    const { beakr } = client(fetch);
    const ids: string[] = [];
    for await (const item of beakr.conversations.iter({ client: "codex" }, 2)) ids.push(String(item["id"]));
    expect(ids).toEqual(["c1", "c2", "c3"]);
    expect(path(calls[0]!.url)).toBe("/v1/conversations?client=codex&limit=2");
    expect(path(calls[1]!.url)).toBe("/v1/conversations?client=codex&limit=2&cursor=cur_2");
  });


});

describe("resources", () => {
  it("sends base_index on an incremental import", async () => {
    const { fetch, calls } = mockFetch([json({ conversation_id: "c", appended: 1 }, 201)]);
    const { beakr } = client(fetch);
    await beakr.conversations.import({
      client: "claude-code",
      sessionId: "s1",
      baseIndex: 12,
      messages: [{ role: "user", content: "Use the April calibration." }],
    });
    expect(calls[0]!.body).toEqual({
      client: "claude-code",
      session_id: "s1",
      base_index: 12,
      messages: [{ role: "user", content: "Use the April calibration." }],
    });
  });

  it("sends the text-hold and compound requests on an import", async () => {
    // C086: the engine keeps transcript text only by opt-in, so a session to be
    // compounded must ask for the hold (or the capture) on the import itself.
    const { fetch, calls } = mockFetch([json({ conversation_id: "c" }), json({ conversation_id: "c" })]);
    const { beakr } = client(fetch);
    await beakr.conversations.import({ client: "codex", sessionId: "s1", messages: [], holdText: true });
    await beakr.conversations.import({ client: "codex", sessionId: "s1", messages: [], compound: true });
    expect(calls[0]!.body).toEqual({ client: "codex", session_id: "s1", messages: [], hold_text: true });
    expect(calls[1]!.body).toEqual({ client: "codex", session_id: "s1", messages: [], compound: true });
  });

  it("resolves the org once for org-admin calls when none is configured", async () => {
    const { fetch, calls } = mockFetch([
      json({ id: "org_7" }),
      json({ data: [] }),
      json({ data: [] }),
    ]);
    const { beakr } = client(fetch);
    await beakr.members.list();
    await beakr.org.serviceAccounts.list();
    // Members and service accounts share one lookup.
    expect(calls.map((c) => path(c.url))).toEqual([
      "/v1/me/organization",
      "/v1/organizations/org_7/members",
      "/v1/organizations/org_7/service-accounts",
    ]);
  });

  it("maps service-account key options to the route's fields", async () => {
    const { fetch, calls } = mockFetch([json({ key: "bk_live_x" }, 201)]);
    const { beakr } = client(fetch, { orgId: "o" });
    await beakr.org.serviceAccounts.mintKey("sa1", { scopes: ["kb:read"], expiresInDays: 30, clientName: "ci" });
    expect(calls[0]!.body).toEqual({ scopes: ["kb:read"], expires_in_days: 30, client_name: "ci" });
  });

  it("records the SDK as a service-account key's client when none is given", async () => {
    // Every key records a client; the API refuses one without.
    const { fetch, calls } = mockFetch([json({ key: "bk_live_x" }, 201)]);
    const { beakr } = client(fetch, { orgId: "o" });
    await beakr.org.serviceAccounts.mintKey("sa1", { scopes: ["kb:read"] });
    expect(calls[0]!.body).toEqual({ scopes: ["kb:read"], client_name: "sdk-typescript" });
    await expect(
      beakr.org.serviceAccounts.mintKey("sa1", { scopes: ["kb:read"], clientName: "  " }),
    ).rejects.toThrow(/clientName/);
  });

  it("passes the member role as a query parameter", async () => {
    const { fetch, calls } = mockFetch([json({})]);
    const { beakr } = client(fetch, { orgId: "o" });
    await beakr.members.setRole("u1", "viewer");
    expect(calls[0]!.method).toBe("PATCH");
    expect(path(calls[0]!.url)).toBe("/v1/organizations/o/members/u1?new_role=viewer");
  });

  it("raises KnowledgeCommandError when the door refuses a command", async () => {
    const { fetch } = mockFetch([
      json({ content: [{ type: "text", text: "Page not found: Pumps" }], outcome: { status: "error" } }),
    ]);
    const { beakr } = client(fetch);
    const error = (await beakr.knowledge.command("cat", { page: "Pumps" }).catch((e: unknown) => e)) as KnowledgeCommandError;
    expect(error).toBeInstanceOf(KnowledgeCommandError);
    expect(error.message).toBe("Page not found: Pumps");
  });

  it("returns the refusal itself with check: false", async () => {
    const { fetch, calls } = mockFetch([json({ content: [], outcome: { status: "error" } })]);
    const { beakr } = client(fetch);
    const result = await beakr.knowledge.command("cat", { page: "x" }, { scope: "Lab", check: false });
    expect(result.outcome?.status).toBe("error");
    expect(calls[0]!.body).toEqual({ page: "x", command: "cat", scope: "Lab" });
  });


});

describe("run streaming", () => {
  it("parses server-sent events until stream_complete", async () => {
    const body = [
      "id: 1",
      'data: {"type":"text_delta","delta":"Hel"}',
      "",
      ": keepalive",
      "id: 2",
      'data: {"type":"text_delta","delta":"lo"}',
      "",
      'data: {"type":"stream_complete"}',
      "",
      'data: {"type":"never_reached"}',
      "",
    ].join("\n");
    const { fetch, calls } = mockFetch([
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    ]);
    const { beakr } = client(fetch);
    const events = [];
    for await (const event of beakr.runs.stream("r1", { lastEventId: "0" })) events.push(event);
    expect(events.map((e) => e.type)).toEqual(["text_delta", "text_delta", "stream_complete"]);
    expect(events[1]!.event_id).toBe("2");
    expect(calls[0]!.headers["accept"]).toBe("text/event-stream");
    expect(path(calls[0]!.url)).toBe("/v1/runs/r1/events?last_event_id=0");
  });
});
