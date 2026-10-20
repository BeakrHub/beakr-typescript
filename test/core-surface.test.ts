/**
 * The published SDK is the documented core only (2026-10-12): the public
 * `Beakr` and `src/index.ts` expose nothing for routes that are reachable but
 * unlisted, and the package carries no code for them at all (2026-10-13; the
 * Beakr CLI keeps its own private client for the few it calls).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as sdk from "../src/index.js";
import { Beakr } from "../src/index.js";
import { client, json, mockFetch } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const path = (url: string) => url.replace("https://api.example.test", "");

const CORE_RESOURCES = [
  "api",
  "conversations",
  "endUserTokens",
  "engine",
  "externalUsers",
  "files",
  "integrations",
  "interviews",
  "jobs",
  "knowledge",
  "labels",
  "me",
  "members",
  "meta",
  "org",
  "projects",
  "runs",
  "uploads",
];

describe("the public surface", () => {
  it("has only the core resources", () => {
    const beakr = new Beakr({ apiKey: "bk_live_x", baseUrl: "https://api.example.test" });
    const resources = Object.keys(beakr).filter((key) => key !== "transport").sort();
    expect(resources).toEqual(CORE_RESOURCES);
  });

  it("has no methods for unlisted routes on core resources", () => {
    const beakr = new Beakr({ apiKey: "bk_live_x", baseUrl: "https://api.example.test" }) as unknown as Record<
      string,
      Record<string, unknown>
    >;
    const absent: [string, string][] = [
      ["projects", "trash"],
      ["projects", "restore"],
      ["conversations", "freshness"],
      ["conversations", "getSettings"],
      ["integrations", "sync"],
      ["integrations", "coverage"],
      ["runs", "thread"],
      ["org", "audit"],
      ["org", "credentials"],
      ["org", "policy"],
      ["org", "scim"],
      ["org", "retention"],
      ["org", "oauthClients"],
    ];
    const present = absent.filter(([resource, member]) => beakr[resource]?.[member] !== undefined);
    expect(present).toEqual([]);
  });

  it("has no internal layer to export", () => {
    const index = readFileSync(resolve(here, "../src/index.ts"), "utf8");
    expect(index).not.toMatch(/internal\//);
    expect(existsSync(resolve(here, "../src/internal"))).toBe(false);
    const exported = Object.keys(sdk);
    for (const name of ["InternalBeakr", "verifyWebhookSignature", "EVENT_TYPES", "CLI_SCOPES", "ImportTimeoutError"]) {
      expect(exported).not.toContain(name);
    }
  });
});

describe("integrations tools", () => {
  it("lists the read-only tools with filters", async () => {
    const { fetch, calls } = mockFetch([json({ data: [{ name: "slack_search" }], next_cursor: null, has_more: false })]);
    const { beakr } = client(fetch);
    const page = await beakr.integrations.tools({ provider: "slack", connectorId: "c1", limit: 10 });
    expect(page.data[0]?.name).toBe("slack_search");
    expect(calls[0]!.method).toBe("GET");
    expect(path(calls[0]!.url)).toBe("/v1/integrations/tools?provider=slack&connector_id=c1&limit=10");
  });

  it("calls one tool with its arguments and the chosen connection", async () => {
    const { fetch, calls } = mockFetch([
      json({ tool: "slack_search", provider: "slack", connector_ids: ["c1"], content: "3 hits", is_error: false, sources: [] }),
    ]);
    const { beakr } = client(fetch);
    const result = await beakr.integrations.callTool("slack_search", { query: "assay" }, { connectorId: "c1" });
    expect(result.content).toBe("3 hits");
    expect(calls[0]!.method).toBe("POST");
    expect(path(calls[0]!.url)).toBe("/v1/integrations/tools/slack_search/call");
    expect(calls[0]!.body).toEqual({ arguments: { query: "assay" }, connector_id: "c1" });
  });

  it("sends no connection when none is chosen", async () => {
    const { fetch, calls } = mockFetch([json({ tool: "t", provider: "p", connector_ids: [], content: "", is_error: false, sources: [] })]);
    const { beakr } = client(fetch);
    await beakr.integrations.callTool("t");
    expect(calls[0]!.body).toEqual({ arguments: {} });
  });
});

describe("interviews", () => {
  it("creates an interview and its link in one call", async () => {
    const { fetch, calls } = mockFetch([
      json({ link_id: "l1", sendable_id: "s1", url: "https://x/l1", expires_at: "2026-11-01T00:00:00Z", result_url: "/r" }, 201),
    ]);
    const { beakr } = client(fetch);
    const link = await beakr.interviews.createLink("Onboarding", {
      goal: "How the team runs assays",
      questions: ["Which instruments?"],
      recipient: { name: "Ada", email: "ada@example.com" },
    });
    expect(link.link_id).toBe("l1");
    expect(calls[0]!.method).toBe("POST");
    expect(path(calls[0]!.url)).toBe("/v1/interview/links");
    expect(calls[0]!.body).toEqual({
      title: "Onboarding",
      goal: "How the team runs assays",
      questions: ["Which instruments?"],
      recipient: { name: "Ada", email: "ada@example.com" },
    });
  });

  it("reads a link's result", async () => {
    const { fetch, calls } = mockFetch([json({ status: "completed", summary: {}, transcript: [] })]);
    const { beakr } = client(fetch);
    const result = await beakr.interviews.linkResult("l/1");
    expect(result.status).toBe("completed");
    expect(calls[0]!.method).toBe("GET");
    expect(path(calls[0]!.url)).toBe("/v1/interview/sendables/links/l%2F1/result");
  });

  it("sends a finished interview to projects", async () => {
    const { fetch, calls } = mockFetch([json({ sent: 2 })]);
    const { beakr } = client(fetch);
    await beakr.interviews.sendToProjects("l1", ["p1", "p2"]);
    expect(calls[0]!.method).toBe("POST");
    expect(path(calls[0]!.url)).toBe("/v1/interview/sendables/links/l1/knowledge");
    expect(calls[0]!.body).toEqual({ project_ids: ["p1", "p2"] });
  });

  it("revokes a link", async () => {
    const { fetch, calls } = mockFetch([new Response(null, { status: 204 })]);
    const { beakr } = client(fetch);
    await beakr.interviews.revokeLink("l1");
    expect(calls[0]!.method).toBe("POST");
    expect(path(calls[0]!.url)).toBe("/v1/interview/sendables/links/l1/revoke");
  });
});

describe("end-user tokens", () => {
  it("mints with snake_case fields and no idempotency key (a retry mints another)", async () => {
    const { fetch, calls } = mockFetch([
      json({ token: "bk_at_x", token_id: "t1", expires_at: "z", subject: "user-42", scopes: ["kb:read"], project_ids: ["p1"] }, 201),
    ]);
    const { beakr } = client(fetch);
    const minted = await beakr.endUserTokens.mint({
      subject: "user-42",
      scopes: ["kb:read"],
      projectIds: ["p1"],
      ttlSeconds: 900,
    });
    expect(minted.token_id).toBe("t1");
    expect(calls[0]!.method).toBe("POST");
    expect(path(calls[0]!.url)).toBe("/v1/auth/end-user-tokens");
    expect(calls[0]!.body).toEqual({ subject: "user-42", scopes: ["kb:read"], project_ids: ["p1"], ttl_seconds: 900 });
    expect(calls[0]!.headers["idempotency-key"]).toBeUndefined();
  });

  it("lists by subject", async () => {
    const { fetch, calls } = mockFetch([json({ data: [], next_cursor: null, has_more: false })]);
    const { beakr } = client(fetch);
    await beakr.endUserTokens.list({ subject: "user-42" });
    expect(path(calls[0]!.url)).toBe("/v1/auth/end-user-tokens?subject=user-42");
  });

  it("revokes", async () => {
    const { fetch, calls } = mockFetch([new Response(null, { status: 204 })]);
    const { beakr } = client(fetch);
    await beakr.endUserTokens.revoke("t1");
    expect(calls[0]!.method).toBe("DELETE");
    expect(path(calls[0]!.url)).toBe("/v1/auth/end-user-tokens/t1");
  });
});

describe("external users and labels", () => {
  it("creates an external user in the given org", async () => {
    const { fetch, calls } = mockFetch([json({ id: "u1", external_id: "acme-42", created: true }, 201)]);
    const { beakr } = client(fetch);
    await beakr.externalUsers.create({ external_id: "acme-42", name: "Ada" }, "o1");
    expect(calls[0]!.method).toBe("POST");
    expect(path(calls[0]!.url)).toBe("/v1/organizations/o1/external-users");
    expect(calls[0]!.body).toEqual({ external_id: "acme-42", name: "Ada" });
  });

  it("attaches a label to a project", async () => {
    const { fetch, calls } = mockFetch([json({ project_id: "p1", role: "viewer" }, 201)]);
    const { beakr } = client(fetch);
    await beakr.labels.attachProject("lb1", { project_id: "p1" });
    expect(path(calls[0]!.url)).toBe("/v1/labels/lb1/projects");
    expect(calls[0]!.body).toEqual({ project_id: "p1" });
  });
});
