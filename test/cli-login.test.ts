/**
 * The TypeScript SDK reads the Beakr CLI's stored sign-in, like the Python SDK
 * (developer platform W6.1.4). Root cause guarded (PROSE-449): the chain went
 * explicit key, BEAKR_API_KEY, service account file, and never looked at
 * `beakr auth login`, so a developer signed in with the CLI got
 * `no_credential` from the TypeScript SDK while the Python SDK just worked.
 *
 * Every test uses its own temporary Beakr home; nothing reads the real one or
 * the OS keychain.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthenticationError, Beakr, type ClientOptions } from "../src/index.js";
import { json, mockFetch } from "./helpers.js";

const BASE = "https://api.test";
const NOW_SECONDS = Date.now() / 1000;

/** One stored login exactly as the Python `TokenStore` writes it (`asdict(StoredTokens)`). */
function storedLogin(accessToken: string, overrides: Record<string, unknown> = {}) {
  return {
    access_token: accessToken,
    refresh_token: `refresh-${accessToken}`,
    expires_at: NOW_SECONDS + 3600,
    refresh_expires_at: NOW_SECONDS + 86400,
    base_url: BASE,
    org_id: "org-1",
    client_name: "beakr-cli",
    user: { email: "dev@example.com" },
    issuer: "beakr",
    token_endpoint: null,
    oauth_client_id: null,
    refresh_state: null,
    ...overrides,
  };
}

function beakrHome(files: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), "beakr-home-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(home, name), JSON.stringify(content));
  }
  vi.stubEnv("BEAKR_HOME", home);
  return home;
}

function credentials(logins: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { version: 2, generation: 3, logins, ...extra };
}

function clientWith(fetch: ClientOptions["fetch"], options: ClientOptions = {}) {
  return new Beakr({ baseUrl: BASE, fetch, sleep: async () => {}, ...options });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the CLI's stored sign-in", () => {
  it("authenticates with the device-flow login saved for this API", async () => {
    vi.stubEnv("BEAKR_API_KEY", "");
    beakrHome({
      credentials: credentials({
        "https://api.test": storedLogin("at-test"),
        "https://api.thebeakr.com": storedLogin("at-prod", { base_url: "https://api.thebeakr.com" }),
      }),
    });
    const { fetch, calls } = mockFetch([json({ user: {} })]);
    await clientWith(fetch).me.get();
    expect(calls[0]!.headers.authorization).toBe("Bearer at-test");
  });

  it("reads ~/.beakr when BEAKR_HOME is not set", async () => {
    vi.stubEnv("BEAKR_API_KEY", "");
    const home = mkdtempSync(join(tmpdir(), "beakr-user-"));
    mkdirSync(join(home, ".beakr"));
    writeFileSync(
      join(home, ".beakr", "credentials"),
      JSON.stringify(credentials({ "https://api.test": storedLogin("at-home") })),
    );
    vi.stubEnv("BEAKR_HOME", undefined);
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    const { fetch, calls } = mockFetch([json({})]);
    await clientWith(fetch).me.get();
    expect(calls[0]!.headers.authorization).toBe("Bearer at-home");
  });

  it("never offers one API's login to another", async () => {
    vi.stubEnv("BEAKR_API_KEY", "");
    beakrHome({
      credentials: credentials({
        "https://api.thebeakr.com": storedLogin("at-prod", { base_url: "https://api.thebeakr.com" }),
      }),
    });
    const { fetch, calls } = mockFetch([]);
    const error = await clientWith(fetch).me.get().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect((error as AuthenticationError).code).toBe("no_credential");
    expect(calls).toHaveLength(0);
  });

  it("matches the origin the way the CLI files it (case, default port, path)", async () => {
    vi.stubEnv("BEAKR_API_KEY", "");
    beakrHome({ credentials: credentials({ "https://api.test": storedLogin("at-test") }) });
    const { fetch, calls } = mockFetch([json({})]);
    await clientWith(fetch, { baseUrl: "https://API.test:443/" }).me.get();
    expect(calls[0]!.headers.authorization).toBe("Bearer at-test");
  });

  it("reads a version-1 file (one bare pair) under the origin it records", async () => {
    vi.stubEnv("BEAKR_API_KEY", "");
    beakrHome({ credentials: storedLogin("at-legacy") });
    const { fetch, calls } = mockFetch([json({})]);
    await clientWith(fetch).me.get();
    expect(calls[0]!.headers.authorization).toBe("Bearer at-legacy");
  });

  it("honors a logout the CLI recorded as an origin barrier", async () => {
    vi.stubEnv("BEAKR_API_KEY", "");
    beakrHome({
      credentials: credentials({ "https://api.test": storedLogin("at-stale") }),
      "credentials.barriers": { "https://api.test": { nonce: "n1", at: 1 } },
    });
    const { fetch } = mockFetch([]);
    const error = await clientWith(fetch).me.get().catch((e: unknown) => e);
    expect((error as AuthenticationError).code).toBe("no_credential");

    // A copy written after that logout declares it and stays readable.
    beakrHome({
      credentials: credentials(
        { "https://api.test": storedLogin("at-fresh") },
        { origin_after: { "https://api.test": "n1" } },
      ),
      "credentials.barriers": { "https://api.test": { nonce: "n1", at: 1 } },
    });
    const second = mockFetch([json({})]);
    await clientWith(second.fetch).me.get();
    expect(second.calls[0]!.headers.authorization).toBe("Bearer at-fresh");
  });

  it("falls back to the key saved by `beakr auth login --with-api-key` for this API", async () => {
    vi.stubEnv("BEAKR_API_KEY", "");
    beakrHome({ "config.json": { api_key: "bk_live_saved", api_url: "https://api.test/" } });
    const { fetch, calls } = mockFetch([json({})]);
    await clientWith(fetch).me.get();
    expect(calls[0]!.headers.authorization).toBe("Bearer bk_live_saved");

    // A key saved for production is not sent to another API.
    beakrHome({ "config.json": { api_key: "bk_live_prod" } });
    const other = mockFetch([]);
    const error = await clientWith(other.fetch).me.get().catch((e: unknown) => e);
    expect((error as AuthenticationError).code).toBe("no_credential");
  });

  it("is skipped with cliLogin: false", async () => {
    vi.stubEnv("BEAKR_API_KEY", "");
    beakrHome({ credentials: credentials({ "https://api.test": storedLogin("at-test") }) });
    const { fetch, calls } = mockFetch([]);
    const error = await clientWith(fetch, { cliLogin: false }).me.get().catch((e: unknown) => e);
    expect((error as AuthenticationError).code).toBe("no_credential");
    expect(calls).toHaveLength(0);
  });
});

describe("precedence (identical to the Python SDK)", () => {
  function everyLink() {
    const home = beakrHome({
      credentials: credentials({ "https://api.test": storedLogin("at-cli") }),
      "config.json": { api_key: "bk_live_saved", api_url: BASE },
      "service-account.json": { type: "beakr_service_account", api_key: "bk_live_default_sa", base_url: BASE },
    });
    const named = join(home, "named-sa.json");
    writeFileSync(named, JSON.stringify({ type: "beakr_service_account", api_key: "bk_live_named_sa" }));
    return { home, named };
  }

  async function sentBy(options: ClientOptions = {}): Promise<string | undefined> {
    const { fetch, calls } = mockFetch([json({})]);
    await clientWith(fetch, options).me.get();
    return calls[0]!.headers.authorization;
  }

  it("explicit key, BEAKR_API_KEY, explicit service account, CLI login, saved key, then the service account file", async () => {
    const { home, named } = everyLink();
    vi.stubEnv("BEAKR_API_KEY", "bk_live_env");
    expect(await sentBy({ apiKey: "bk_live_mine" })).toBe("Bearer bk_live_mine");
    expect(await sentBy({ tokens: { accessToken: "at-mine" } })).toBe("Bearer at-mine");
    expect(await sentBy()).toBe("Bearer bk_live_env");

    vi.stubEnv("BEAKR_API_KEY", "");
    expect(await sentBy({ serviceAccount: named })).toBe("Bearer bk_live_named_sa");
    expect(await sentBy()).toBe("Bearer at-cli");

    // A service account file named by the environment still comes after the CLI login, as in Python.
    vi.stubEnv("BEAKR_SERVICE_ACCOUNT_FILE", named);
    expect(await sentBy()).toBe("Bearer at-cli");

    writeFileSync(join(home, "credentials"), JSON.stringify(credentials({})));
    expect(await sentBy()).toBe("Bearer bk_live_saved");

    writeFileSync(join(home, "config.json"), JSON.stringify({}));
    expect(await sentBy()).toBe("Bearer bk_live_named_sa");

    vi.stubEnv("BEAKR_SERVICE_ACCOUNT_FILE", "");
    expect(await sentBy()).toBe("Bearer bk_live_default_sa");
  });

  it("an explicit empty apiKey ends the chain", async () => {
    everyLink();
    vi.stubEnv("BEAKR_API_KEY", "");
    const { fetch } = mockFetch([]);
    const error = await clientWith(fetch, { apiKey: "" }).me.get().catch((e: unknown) => e);
    expect((error as AuthenticationError).code).toBe("no_credential");
  });
});

describe("the stored sign-in is never refreshed by the SDK", () => {
  it("adopts a pair the CLI rotated after the cached access token expired", async () => {
    vi.stubEnv("BEAKR_API_KEY", "");
    const home = beakrHome({
      credentials: credentials({ "https://api.test": storedLogin("at-old", { expires_at: NOW_SECONDS + 3600 }) }),
    });
    const { fetch, calls } = mockFetch([json({}), json({})]);
    const beakr = clientWith(fetch);
    await beakr.me.get();
    // Time passes: the cached token expires and the CLI refreshes the stored pair.
    vi.useFakeTimers({ now: Date.now() + 2 * 3600 * 1000, toFake: ["Date"] });
    writeFileSync(
      join(home, "credentials"),
      JSON.stringify(
        credentials({ "https://api.test": storedLogin("at-new", { expires_at: NOW_SECONDS + 4 * 3600 }) }),
      ),
    );
    try {
      await beakr.me.get();
    } finally {
      vi.useRealTimers();
    }
    expect(calls.map((c) => c.headers.authorization)).toEqual(["Bearer at-old", "Bearer at-new"]);
    expect(calls.some((c) => c.url.includes("/auth/token/refresh"))).toBe(false);
  });

  it("asks for the CLI when the stored access token has expired, without spending the refresh token", async () => {
    vi.stubEnv("BEAKR_API_KEY", "");
    beakrHome({
      credentials: credentials({ "https://api.test": storedLogin("at-expired", { expires_at: NOW_SECONDS - 10 }) }),
    });
    const { fetch, calls } = mockFetch([]);
    const error = await clientWith(fetch).me.get().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect((error as AuthenticationError).code).toBe("cli_login_expired");
    expect((error as Error).message).toContain("beakr auth");
    expect(calls).toHaveLength(0);
  });

  it("on a 401, resends once with a newer stored pair; otherwise reports the 401", async () => {
    vi.stubEnv("BEAKR_API_KEY", "");
    const home = beakrHome({ credentials: credentials({ "https://api.test": storedLogin("at-revoked") }) });
    const unauthorized = () => json({ error: { code: "unauthorized", message: "revoked" } }, 401);
    const { fetch, calls } = mockFetch([
      (call) => {
        // The CLI rotated the pair while this request was in flight.
        writeFileSync(
          join(home, "credentials"),
          JSON.stringify(credentials({ "https://api.test": storedLogin("at-rotated") })),
        );
        expect(call.headers.authorization).toBe("Bearer at-revoked");
        return unauthorized();
      },
      json({ id: "u" }),
      unauthorized(),
    ]);
    const beakr = clientWith(fetch);
    await expect(beakr.me.get()).resolves.toEqual({ id: "u" });
    expect(calls[1]!.headers.authorization).toBe("Bearer at-rotated");

    // Nothing newer stored: the 401 is the answer, and no refresh is attempted.
    await expect(beakr.me.get()).rejects.toBeInstanceOf(AuthenticationError);
    expect(calls).toHaveLength(3);
    expect(calls.some((c) => c.url.includes("/auth/token/refresh"))).toBe(false);
  });
});
