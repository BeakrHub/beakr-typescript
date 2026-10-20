import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Beakr, CAPABILITIES_TTL_MS, Capabilities, forgetCapabilities } from "../src/index.js";
import { client, json, mockFetch } from "./helpers.js";

// Root cause guarded: a self-hosted installation serves only part of the
// documented contract and answers a bare 404 for the rest, so a client offered
// organization, integration and embedded-mode calls that could only fail with
// "Not Found". The server's own public OpenAPI document lists what it serves;
// these tests pin how the SDK reads and caches it (as the Python SDK does).

const DOC = "https://api.example.test/v1/public/openapi.json";

/** A box's document: projects and the contract document, no integrations or org admin. */
const BOX_DOCUMENT = {
  openapi: "3.1.0",
  paths: {
    "/v1/projects": { get: {}, post: {} },
    "/v1/projects/{project_id}": { get: {}, patch: {}, delete: {} },
    "/v1/public/openapi.json": { get: {} },
  },
};

beforeEach(() => forgetCapabilities());
afterEach(() => {
  forgetCapabilities();
  vi.restoreAllMocks();
});

describe("Capabilities", () => {
  it("does not serve a documented operation missing from the server's document", () => {
    const caps = new Capabilities(BOX_DOCUMENT);
    expect(caps.documented).toBe(true);
    expect(caps.serves("GET", "/v1/projects")).toBe(true);
    expect(caps.serves("GET", "/v1/projects/9f1c2a7e-0000-4000-8000-000000000000")).toBe(true);
    expect(caps.serves("get", "/v1/projects/?limit=5")).toBe(true);
    expect(caps.serves("GET", "/v1/integrations")).toBe(false);
    expect(caps.serves("POST", "/v1/organizations/{org_id}/members")).toBe(false);
    expect(caps.serves("GET", "/v1/organizations/o1/external-users/u1")).toBe(false);
    // A method the server does not serve on a path it does.
    expect(caps.serves("PUT", "/v1/projects/p1/knowledge-profile")).toBe(false);
    expect(
      caps.unserved([
        ["GET", "/v1/projects"],
        ["GET", "/v1/integrations"],
      ]),
    ).toEqual([["GET", "/v1/integrations"]]);
  });

  it("assumes a route outside the contract is served", () => {
    // The document describes only the documented contract, so it cannot say
    // anything about another route.
    expect(new Capabilities(BOX_DOCUMENT).serves("GET", "/v1/some/unlisted/route")).toBe(true);
  });

  it("serves everything when the server has no document", () => {
    for (const caps of [Capabilities.unknown(), new Capabilities({ openapi: "3.1.0" })]) {
      expect(caps.documented).toBe(false);
      expect(caps.serves("GET", "/v1/integrations")).toBe(true);
    }
  });
});

describe("meta.capabilities", () => {
  it("fetches the document once per base URL, without the credential", async () => {
    const { fetch, calls } = mockFetch([json(BOX_DOCUMENT), json({ paths: {} }), json(BOX_DOCUMENT)]);
    const { beakr } = client(fetch);
    const [first, second] = await Promise.all([beakr.meta.capabilities(), beakr.meta.capabilities()]);
    expect(await beakr.meta.capabilities()).toBe(first);
    expect(second).toBe(first);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(DOC);
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(first.serves("GET", "/v1/integrations")).toBe(false);

    const other = new Beakr({ apiKey: "bk_live_test", baseUrl: "https://box.test", fetch });
    expect((await other.meta.capabilities()).serves("GET", "/v1/integrations")).toBe(true);
    expect(calls[1]!.url).toBe("https://box.test/v1/public/openapi.json");

    await beakr.meta.capabilities({ refresh: true });
    expect(calls).toHaveLength(3);
  });

  it("caches a server without the document as serving everything", async () => {
    const { fetch, calls } = mockFetch([json({ detail: "Not Found" }, 404)]);
    const { beakr } = client(fetch);
    expect((await beakr.meta.capabilities()).serves("GET", "/v1/integrations")).toBe(true);
    expect((await beakr.meta.capabilities()).serves("GET", "/v1/integrations")).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("treats an unreachable server as serving everything", async () => {
    const refused = () => new TypeError("fetch failed");
    const { fetch } = mockFetch([refused(), refused(), refused(), refused(), refused()]);
    const { beakr } = client(fetch);
    expect((await beakr.meta.capabilities()).serves("GET", "/v1/integrations")).toBe(true);
  });

  it("reads the document again once its TTL has passed", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { fetch, calls } = mockFetch([json(BOX_DOCUMENT), json(BOX_DOCUMENT)]);
    const { beakr } = client(fetch);
    await beakr.meta.capabilities();
    now += CAPABILITIES_TTL_MS - 1;
    await beakr.meta.capabilities();
    expect(calls).toHaveLength(1);
    now += 2;
    await beakr.meta.capabilities();
    expect(calls).toHaveLength(2);
  });
});
