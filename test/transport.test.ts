import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APIConnectionError,
  AuthenticationError,
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  ServerError,
  ValidationError,
} from "../src/index.js";
import { Transport } from "../src/core.js";
import { replaysIdempotencyKey } from "../src/replay.js";
import { client, json, mockFetch } from "./helpers.js";

const envelope = (code: string, message: string, extra: Record<string, unknown> = {}) => ({
  detail: message,
  error: { code, message, request_id: "req_123", ...extra },
});

describe("requests", () => {
  it("sends the credential and attribution headers", async () => {
    const { fetch, calls } = mockFetch([json({ id: "u1" })]);
    const { beakr } = client(fetch, { clientName: "my-tool", agent: "claude-code", orgId: "org_9" });
    await beakr.me.get();
    expect(calls[0]!.url).toBe("https://api.example.test/v1/me");
    expect(calls[0]!.headers["authorization"]).toBe("Bearer bk_live_test");
    expect(calls[0]!.headers["x-beakr-client"]).toBe("my-tool");
    expect(calls[0]!.headers["x-beakr-agent"]).toBe("claude-code");
    expect(calls[0]!.headers["x-org-id"]).toBe("org_9");
  });

  it("omits the credential on anonymous calls", async () => {
    const { fetch, calls } = mockFetch([json({ openapi: "3.1.0" })]);
    const transport = new Transport({ apiKey: "k", baseUrl: "https://api.example.test", fetch, sleep: async () => {} });
    await transport.request({ method: "GET", path: "/v1/public/openapi.json", authenticated: false });
    expect(calls[0]!.headers["authorization"]).toBeUndefined();
  });

  it("rejects with no credential configured", async () => {
    const { fetch, calls } = mockFetch([]);
    // An empty key is not replaced by BEAKR_API_KEY: only an omitted one is.
    const { beakr } = client(fetch, { apiKey: "" });
    const error = await beakr.me.get().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect((error as AuthenticationError).code).toBe("no_credential");
    expect(calls).toHaveLength(0);
  });

  it("drops undefined query values and encodes the rest", async () => {
    const { fetch, calls } = mockFetch([json({ data: [], next_cursor: null, has_more: false })]);
    const { beakr } = client(fetch);
    await beakr.conversations.list({ q: "pump calibration", limit: 5 });
    expect(calls[0]!.url).toBe("https://api.example.test/v1/conversations?q=pump+calibration&limit=5");
  });
});

describe("base URL", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const target = async (options: Record<string, unknown> = {}) => {
    const { fetch, calls } = mockFetch([json({ id: "u1" })]);
    const { Beakr } = await import("../src/index.js");
    await new Beakr({ apiKey: "bk_live_test", fetch, ...options }).me.get();
    return new URL(calls[0]!.url).origin;
  };

  // A dev key with only BEAKR_API_URL set (the CLI's and Python SDK's name)
  // used to be sent to production: the TS client read BEAKR_BASE_URL alone.
  it("reads BEAKR_API_URL when BEAKR_BASE_URL is unset", async () => {
    vi.stubEnv("BEAKR_BASE_URL", "");
    vi.stubEnv("BEAKR_API_URL", "http://127.0.0.1:8075");
    expect(await target()).toBe("http://127.0.0.1:8075");
  });

  it("prefers the option, then BEAKR_BASE_URL, over BEAKR_API_URL", async () => {
    vi.stubEnv("BEAKR_API_URL", "http://127.0.0.1:8075");
    vi.stubEnv("BEAKR_BASE_URL", "http://localhost:9000");
    expect(await target()).toBe("http://localhost:9000");
    expect(await target({ baseUrl: "https://api.example.test" })).toBe("https://api.example.test");
  });

  it("names the host in a connection error", async () => {
    const { fetch } = mockFetch([new TypeError("fetch failed")]);
    const { beakr } = client(fetch, { maxRetries: 0 });
    const error = (await beakr.projects.get("p1").catch((e: unknown) => e)) as APIConnectionError;
    expect(error).toBeInstanceOf(APIConnectionError);
    expect(error.message).toContain("https://api.example.test");
    expect(error.baseUrl).toBe("https://api.example.test");
  });
});

describe("error mapping", () => {
  it.each([
    [400, ValidationError, "bad_request"],
    [401, AuthenticationError, "unauthorized"],
    [404, NotFoundError, "not_found"],
    [409, ConflictError, "conflict"],
    [422, ValidationError, "validation_error"],
    [500, ServerError, "internal_error"],
  ])("maps %i to %s", async (status, type, code) => {
    const { fetch } = mockFetch([json(envelope(code, "nope"), status)]);
    const { beakr } = client(fetch, { maxRetries: 0 });
    const error = await beakr.projects.get("p1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(type);
    expect(error).toMatchObject({
      status,
      code,
      requestId: "req_123",
      message: "nope (called https://api.example.test)",
      baseUrl: "https://api.example.test",
    });
  });

  it("carries the required scope on insufficient_scope", async () => {
    const { fetch } = mockFetch([
      json(envelope("insufficient_scope", "This credential lacks the 'projects:admin' scope.", { required_scope: "projects:admin" }), 403),
    ]);
    const { beakr } = client(fetch);
    const error = (await beakr.projects.create({ name: "x" }).catch((e: unknown) => e)) as PermissionDeniedError;
    expect(error).toBeInstanceOf(PermissionDeniedError);
    expect(error.code).toBe("insufficient_scope");
    expect(error.requiredScope).toBe("projects:admin");
  });

  it("falls back to detail and the X-Request-ID header for legacy bodies", async () => {
    const { fetch } = mockFetch([json({ detail: "Project not found" }, 404, { "x-request-id": "hdr_1" })]);
    const { beakr } = client(fetch);
    const error = (await beakr.projects.get("p").catch((e: unknown) => e)) as NotFoundError;
    expect(error.message).toBe("Project not found (called https://api.example.test)");
    expect(error.code).toBe("not_found");
    expect(error.requestId).toBe("hdr_1");
  });

  it("reads FastAPI validation lists into one message", async () => {
    const { fetch } = mockFetch([
      json({ detail: [{ loc: ["body", "name"], msg: "Field required" }] }, 422),
    ]);
    const { beakr } = client(fetch);
    const error = await beakr.projects.create({ name: "" }).catch((e: unknown) => e);
    expect((error as ValidationError).message).toBe("name: Field required (called https://api.example.test)");
  });

  it("exposes the base index a refused incremental import must resend from", async () => {
    const { fetch } = mockFetch([
      json({ detail: { code: "base_index_conflict", expected_base_index: 7 } }, 409),
    ]);
    const { beakr } = client(fetch);
    const error = (await beakr.conversations
      .import({ client: "codex", sessionId: "s1", messages: [], baseIndex: 9 })
      .catch((e: unknown) => e)) as ConflictError;
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.expectedBaseIndex).toBe(7);
  });
});

describe("retries", () => {
  it("retries a 429 after Retry-After seconds, for any method", async () => {
    const { fetch, calls } = mockFetch([
      json(envelope("rate_limited", "slow down"), 429, { "retry-after": "3" }),
      json({ id: "p1" }, 201),
    ]);
    const { beakr, sleeps } = client(fetch);
    await expect(beakr.projects.create({ name: "x" })).resolves.toEqual({ id: "p1" });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([3000]);
  });

  it("gives up after maxRetries and surfaces the RateLimitError", async () => {
    const limited = () => json(envelope("rate_limited", "slow"), 429, { "retry-after": "1" });
    const { fetch, calls } = mockFetch([limited(), limited(), limited()]);
    const { beakr } = client(fetch, { maxRetries: 2 });
    const error = (await beakr.me.get().catch((e: unknown) => e)) as RateLimitError;
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.retryAfter).toBe(1);
    expect(calls).toHaveLength(3);
  });

  it("does not wait out a Retry-After longer than 60 seconds", async () => {
    const { fetch, calls } = mockFetch([json(envelope("rate_limited", "later"), 429, { "retry-after": "600" })]);
    const { beakr, sleeps } = client(fetch);
    await expect(beakr.me.get()).rejects.toBeInstanceOf(RateLimitError);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("never retries other 4xx", async () => {
    const { fetch, calls } = mockFetch([json(envelope("forbidden", "no"), 403)]);
    const { beakr } = client(fetch);
    await expect(beakr.me.get()).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(calls).toHaveLength(1);
  });

  it("retries a 503 on a GET with backoff", async () => {
    const { fetch, calls } = mockFetch([json({}, 503), json({ id: "u" })]);
    const { beakr, sleeps } = client(fetch);
    await expect(beakr.me.get()).resolves.toEqual({ id: "u" });
    expect(calls).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(250);
    expect(sleeps[0]).toBeLessThanOrEqual(500);
  });

  // Root cause guarded (SPEC-440): the SDK refused to resend any create after a
  // 5xx, citing a replay guarantee the engine does give (W1.2). A keyed create
  // resent with the same key and body returns the first result.
  for (const status of [500, 502, 503, 504]) {
    it(`retries a keyed create after an ambiguous ${status}, with the same key and body`, async () => {
      const { fetch, calls } = mockFetch([json({}, status), json({ id: "p1" }, 201)]);
      const { beakr, sleeps } = client(fetch);
      await expect(beakr.projects.create({ name: "x" })).resolves.toEqual({ id: "p1" });
      expect(calls).toHaveLength(2);
      expect(calls[0]!.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
      expect(calls[1]!.headers["idempotency-key"]).toBe(calls[0]!.headers["idempotency-key"]);
      expect(calls[1]!.body).toEqual(calls[0]!.body);
      expect(sleeps).toHaveLength(1);
    });
  }

  it("retries a keyed create after a lost connection", async () => {
    const { fetch, calls } = mockFetch([new TypeError("fetch failed"), json({ id: "p1" }, 201)]);
    const transport = new Transport({ apiKey: "k", baseUrl: "https://api.example.test", fetch, sleep: async () => {} });
    await transport.request({ method: "POST", path: "/v1/projects/p1/members", body: {}, idempotent: true });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers["idempotency-key"]).toBe(calls[0]!.headers["idempotency-key"]);
  });

  it("honors Retry-After on a keyed create's 503", async () => {
    const { fetch } = mockFetch([json({}, 503, { "retry-after": "4" }), json({ id: "p1" }, 201)]);
    const { beakr, sleeps } = client(fetch);
    await beakr.projects.create({ name: "x" });
    expect(sleeps).toEqual([4000]);
  });

  it("waits out an earlier attempt that still holds the key (409 idempotency_in_progress)", async () => {
    const { fetch, calls } = mockFetch([
      json({}, 504),
      json({ detail: { code: "idempotency_in_progress", message: "retry" } }, 409, { "retry-after": "1" }),
      json({ id: "p1" }, 201),
    ]);
    const { beakr, sleeps } = client(fetch);
    await expect(beakr.projects.create({ name: "x" })).resolves.toEqual({ id: "p1" });
    expect(calls).toHaveLength(3);
    expect(sleeps[1]).toBe(1000);
  });

  it("does not retry other conflicts on a keyed create", async () => {
    const { fetch, calls } = mockFetch([json(envelope("idempotency_key_reused", "different body"), 409)]);
    const { beakr } = client(fetch);
    await expect(beakr.projects.create({ name: "x" })).rejects.toBeInstanceOf(ConflictError);
    expect(calls).toHaveLength(1);
  });

  for (const path of [
    "/v1/skills/s1/proposals/p1/accept",
    "/v1/webhook-endpoints/w1/rotate-secret",
    "/v1/knowledge/wiki/command",
    "/v1/auth/token/refresh",
  ]) {
    it(`does not resend a POST the engine does not replay (${path}) after a 503`, async () => {
      const { fetch, calls } = mockFetch([json({}, 503)]);
      const transport = new Transport({ apiKey: "k", baseUrl: "https://api.example.test", fetch, sleep: async () => {} });
      await expect(transport.request({ method: "POST", path, body: {}, idempotent: true })).rejects.toBeInstanceOf(
        ServerError,
      );
      expect(calls).toHaveLength(1);
    });
  }

  it("retries a GET after a 500", async () => {
    const { fetch, calls } = mockFetch([json({}, 500), json({ id: "u" })]);
    const { beakr } = client(fetch);
    await expect(beakr.me.get()).resolves.toEqual({ id: "u" });
    expect(calls).toHaveLength(2);
  });

  for (const status of [501, 505]) {
    it(`never retries a ${status}`, async () => {
      const { fetch, calls } = mockFetch([json({}, status)]);
      const { beakr } = client(fetch);
      await expect(beakr.projects.create({ name: "x" })).rejects.toBeInstanceOf(ServerError);
      expect(calls).toHaveLength(1);
    });
  }

  it("retries a run start after a 503 because the route deduplicates on its body key", async () => {
    const { fetch, calls } = mockFetch([json({}, 503), json({ run_id: "r1" }, 202)]);
    const { beakr } = client(fetch);
    await beakr.runs.start("hello");
    expect(calls).toHaveLength(2);
    expect((calls[0]!.body as { idempotency_key: string }).idempotency_key).toBe(
      (calls[1]!.body as { idempotency_key: string }).idempotency_key,
    );
  });

  it("retries a GET after a connection error, then reports APIConnectionError", async () => {
    const { fetch, calls } = mockFetch([new TypeError("fetch failed"), new TypeError("fetch failed"), new TypeError("fetch failed")]);
    const { beakr } = client(fetch);
    await expect(beakr.me.get()).rejects.toBeInstanceOf(APIConnectionError);
    expect(calls).toHaveLength(3);
  });
});

describe("idempotency", () => {
  it("sends one Idempotency-Key, unchanged across a retry", async () => {
    const { fetch, calls } = mockFetch([
      json(envelope("rate_limited", "slow"), 429, { "retry-after": "0" }),
      json({ id: "l1", name: "Assays" }, 201),
    ]);
    const { beakr } = client(fetch);
    await beakr.labels.create({ name: "Assays" } as never);
    const first = calls[0]!.headers["idempotency-key"];
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[1]!.headers["idempotency-key"]).toBe(first);
  });

  it("uses a fresh key for each call and none on reads", async () => {
    const { fetch, calls } = mockFetch([json({}, 201), json({}, 201), json({ id: "u" })]);
    const { beakr } = client(fetch);
    await beakr.conversations.import({ client: "codex", sessionId: "a", messages: [] });
    await beakr.conversations.import({ client: "codex", sessionId: "b", messages: [] });
    await beakr.me.get();
    expect(calls[0]!.headers["idempotency-key"]).not.toBe(calls[1]!.headers["idempotency-key"]);
    expect(calls[2]!.headers["idempotency-key"]).toBeUndefined();
  });
});

describe("token refresh", () => {
  const ISSUER_TOKEN = "https://issuer.example.test/oauth/token";
  const pair = (extra: Record<string, unknown> = {}) => ({
    accessToken: "oat_old",
    refreshToken: "rt_old",
    tokenEndpoint: ISSUER_TOKEN,
    clientId: "cli",
    ...extra,
  });

  it("refreshes at the issuer on a 401, retries once, and reports the rotated pair", async () => {
    const rotated: unknown[] = [];
    const { fetch, calls } = mockFetch([
      json({ detail: "expired" }, 401),
      json({ access_token: "oat_new", refresh_token: "rt_new", expires_in: 3600 }),
      json({ id: "u" }),
    ]);
    const { beakr } = client(fetch, {
      apiKey: undefined,
      tokens: pair(),
      onTokens: (rotatedPair) => {
        rotated.push(rotatedPair.refreshToken);
      },
    });
    await expect(beakr.me.get()).resolves.toEqual({ id: "u" });
    expect(calls[1]!.url).toBe(ISSUER_TOKEN);
    const form = new URLSearchParams(String(calls[1]!.body));
    expect(Object.fromEntries(form)).toEqual({ grant_type: "refresh_token", refresh_token: "rt_old", client_id: "cli" });
    expect(calls[1]!.headers["authorization"]).toBeUndefined();
    expect(calls[2]!.headers["authorization"]).toBe("Bearer oat_new");
    expect(rotated).toEqual(["rt_new"]);
    expect(beakr.tokens?.accessToken).toBe("oat_new");
    // The rotated pair keeps where it refreshes.
    expect(beakr.tokens?.tokenEndpoint).toBe(ISSUER_TOKEN);
  });

  it("refreshes before sending when the access token has expired", async () => {
    const { fetch, calls } = mockFetch([
      json({ access_token: "oat_new", refresh_token: "rt_new", expires_in: 3600 }),
      json({ id: "u" }),
    ]);
    const { beakr } = client(fetch, { apiKey: undefined, tokens: pair({ expiresAt: Date.now() - 1000 }) });
    await beakr.me.get();
    expect(calls.map((c) => c.url)).toEqual([ISSUER_TOKEN, "https://api.example.test/v1/me"]);
  });

  it("does not loop when the refreshed token is also refused", async () => {
    const { fetch, calls } = mockFetch([
      json({ detail: "expired" }, 401),
      json({ access_token: "oat_new", refresh_token: "rt_new" }),
      json({ detail: "still no" }, 401),
    ]);
    const { beakr } = client(fetch, { apiKey: undefined, tokens: pair() });
    await expect(beakr.me.get()).rejects.toBeInstanceOf(AuthenticationError);
    expect(calls).toHaveLength(3);
  });

  it("does not refresh a pair that names no token endpoint", async () => {
    const { fetch, calls } = mockFetch([json({ detail: "expired" }, 401)]);
    const { beakr } = client(fetch, { apiKey: undefined, tokens: { accessToken: "a", refreshToken: "r" } });
    await expect(beakr.me.get()).rejects.toBeInstanceOf(AuthenticationError);
    expect(calls).toHaveLength(1);
  });
});

describe("replaying creates", () => {
  const cases: Array<[string, string, boolean]> = [
    ["POST", "/v1/projects", true],
    ["POST", "/v1/projects/", true],
    ["POST", "/v1/projects/p1/members", true],
    ["POST", "/v1/labels", true],
    ["POST", "/v1/outputs", false],
    ["POST", "/v1/uploads/u1/complete", true],
    ["post", "/v1/projects?x=1", true],
    ["POST", "/v1/uploads/u1/parts", false],
    ["POST", "/v1/projects/p1/members/u1", false],
    ["POST", "/v1/skills/s1/proposals/p1/accept", false],
    ["POST", "/v1/auth/token/refresh", false],
    ["POST", "/v1/artifacts/list", false],
    ["POST", "/v1/projectsx", false],
    ["PATCH", "/v1/projects", false],
  ];
  for (const [method, path, replays] of cases) {
    it(`${method} ${path} ${replays ? "replays" : "does not replay"}`, () => {
      expect(replaysIdempotencyKey(method, path)).toBe(replays);
    });
  }
});
