/**
 * The TypeScript SDK gets the CLI's sign-in from the CLI when the credentials
 * file cannot serve it (PROSE-449, Codex R067). Root causes guarded:
 *
 * - A default `beakr auth login` on macOS keeps the login in the OS keychain,
 *   which the SDK never read, so a signed-in developer got `no_credential`.
 * - An expired stored login failed with `cli_login_expired`: the SDK cannot
 *   take the CLI's refresh lock, so it never refreshed. It now asks
 *   `beakr auth token --json`, which refreshes under that lock; the SDK itself
 *   never presents a refresh token.
 * - The file reader used only `process.getBuiltinModule`, absent before Node
 *   20.16 / 22.3, so on Node 18 a valid credentials file gave `no_credential`.
 *
 * The CLI is a mocked runner (`setCliRunner`); nothing runs the real `beakr`
 * or touches the OS keychain, and every request goes to a mocked fetch.
 */
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { type CliRunResult, runCliToken, setCliRunner, tokenDigest } from "../src/cli-token.js";
import { AuthenticationError, Beakr, BeakrError, type ClientOptions } from "../src/index.js";
import { json, mockFetch } from "./helpers.js";

const BASE = "https://api.test";
const NOW_SECONDS = Date.now() / 1000;

function storedLogin(accessToken: string, overrides: Record<string, unknown> = {}) {
  return {
    access_token: accessToken,
    refresh_token: `refresh-${accessToken}`,
    expires_at: NOW_SECONDS + 3600,
    refresh_expires_at: NOW_SECONDS + 86400,
    base_url: BASE,
    org_id: "org-1",
    client_name: "beakr-cli",
    user: {},
    issuer: "beakr",
    token_endpoint: null,
    oauth_client_id: null,
    refresh_state: null,
    ...overrides,
  };
}

function beakrHome(files: Record<string, unknown> = {}): string {
  const home = mkdtempSync(join(tmpdir(), "beakr-home-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(home, name), JSON.stringify(content));
  }
  vi.stubEnv("BEAKR_HOME", home);
  vi.stubEnv("BEAKR_API_KEY", "");
  return home;
}

function credentials(logins: Record<string, unknown>) {
  return { version: 2, generation: 1, logins };
}

/** A fake CLI answering from a queue; records the arguments of every run. */
function fakeCli(answers: Array<CliRunResult | ((args: readonly string[]) => CliRunResult)>) {
  const runs: Array<readonly string[]> = [];
  const queue = [...answers];
  setCliRunner(async (args) => {
    runs.push(args);
    const answer = queue.shift();
    if (answer === undefined) throw new Error(`unexpected CLI run: ${args.join(" ")}`);
    return typeof answer === "function" ? answer(args) : answer;
  });
  return runs;
}

function cliToken(accessToken: string, expiresAt: number | null = NOW_SECONDS + 3600, source = "cli_tokens"): CliRunResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify({ access_token: accessToken, token_type: "Bearer", expires_at: expiresAt, origin: BASE, source, kind: "access_token" }),
    stderr: "",
  };
}

function cliError(exitCode: number, code: string, message: string): CliRunResult {
  return { exitCode, stdout: JSON.stringify({ error: { code, message } }), stderr: "" };
}

const NOT_INSTALLED: CliRunResult = { exitCode: null, stdout: "", stderr: "", notFound: true };
const unauthorized = () => json({ error: { code: "unauthorized", message: "token refused" } }, 401);

function clientWith(fetch: ClientOptions["fetch"], options: ClientOptions = {}) {
  return new Beakr({ baseUrl: BASE, fetch, sleep: async () => {}, ...options });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("a sign-in the credentials file does not hold (the OS keychain)", () => {
  it("asks the CLI for this API's token and sends it", async () => {
    beakrHome();
    const runs = fakeCli([cliToken("at-keychain")]);
    const { fetch, calls } = mockFetch([json({}), json({})]);
    const beakr = clientWith(fetch);
    await beakr.me.get();
    await beakr.me.get();
    expect(runs).toEqual([["auth", "token", "--json", "--api-url", BASE]]);
    expect(calls.map((c) => c.headers.authorization)).toEqual(["Bearer at-keychain", "Bearer at-keychain"]);
  });

  it("runs the CLI once for concurrent first requests", async () => {
    beakrHome();
    const runs = fakeCli([cliToken("at-keychain")]);
    const { fetch, calls } = mockFetch([json({}), json({}), json({})]);
    const beakr = clientWith(fetch);
    await Promise.all([beakr.me.get(), beakr.me.get(), beakr.me.get()]);
    expect(runs).toHaveLength(1);
    expect(calls.every((c) => c.headers.authorization === "Bearer at-keychain")).toBe(true);
  });

  it("asks again once the token the CLI gave has expired", async () => {
    beakrHome();
    const runs = fakeCli([cliToken("at-first", NOW_SECONDS + 3600), cliToken("at-second", NOW_SECONDS + 3 * 3600)]);
    const { fetch, calls } = mockFetch([json({}), json({})]);
    const beakr = clientWith(fetch);
    await beakr.me.get();
    vi.useFakeTimers({ now: Date.now() + 2 * 3600 * 1000, toFake: ["Date"] });
    await beakr.me.get();
    expect(runs).toHaveLength(2);
    expect(calls.map((c) => c.headers.authorization)).toEqual(["Bearer at-first", "Bearer at-second"]);
  });

  it("is not asked when the credentials file holds a current sign-in (the fast path)", async () => {
    beakrHome({ credentials: credentials({ [BASE]: storedLogin("at-file") }) });
    const runs = fakeCli([]);
    const { fetch, calls } = mockFetch([json({})]);
    await clientWith(fetch).me.get();
    expect(runs).toHaveLength(0);
    expect(calls[0]!.headers.authorization).toBe("Bearer at-file");
  });

  it("is not asked with cliLogin: false, nor when a credential is configured", async () => {
    beakrHome();
    const runs = fakeCli([]);
    const off = mockFetch([]);
    const error = await clientWith(off.fetch, { cliLogin: false }).me.get().catch((e: unknown) => e);
    expect((error as AuthenticationError).code).toBe("no_credential");

    vi.stubEnv("BEAKR_API_KEY", "bk_live_env");
    const env = mockFetch([json({})]);
    await clientWith(env.fetch).me.get();
    expect(env.calls[0]!.headers.authorization).toBe("Bearer bk_live_env");
    expect(runs).toHaveLength(0);
  });
});

describe("an expired stored sign-in is refreshed by the CLI, never by the SDK", () => {
  it("uses the token the CLI refreshed under its lock", async () => {
    beakrHome({ credentials: credentials({ [BASE]: storedLogin("at-expired", { expires_at: NOW_SECONDS - 10 }) }) });
    const runs = fakeCli([cliToken("at-refreshed")]);
    const { fetch, calls } = mockFetch([json({ id: "u" })]);
    await expect(clientWith(fetch).me.get()).resolves.toEqual({ id: "u" });
    expect(runs).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.authorization).toBe("Bearer at-refreshed");
    expect(calls.some((c) => c.url.includes("/auth/token/refresh"))).toBe(false);
  });

  it("fails with cli_login_expired when the CLI is not installed", async () => {
    beakrHome({ credentials: credentials({ [BASE]: storedLogin("at-expired", { expires_at: NOW_SECONDS - 10 }) }) });
    fakeCli([NOT_INSTALLED]);
    const { fetch, calls } = mockFetch([]);
    const error = await clientWith(fetch).me.get().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect((error as AuthenticationError).code).toBe("cli_login_expired");
    expect((error as Error).message).toContain("BEAKR_CLI_PATH");
    expect(calls).toHaveLength(0);
  });

  it("reports the CLI's refusal when the sign-in cannot be refreshed", async () => {
    beakrHome({ credentials: credentials({ [BASE]: storedLogin("at-expired", { expires_at: NOW_SECONDS - 10 }) }) });
    fakeCli([cliError(3, "refresh_failed", "Your sign-in has expired or was revoked. Run `beakr auth login`.")]);
    const { fetch, calls } = mockFetch([]);
    const error = await clientWith(fetch).me.get().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect((error as AuthenticationError).code).toBe("refresh_failed");
    expect((error as Error).message).toContain("beakr auth login");
    expect(calls).toHaveLength(0);
  });

  it("reports a CLI failure that is not about authentication, and retries it on the next request", async () => {
    beakrHome({ credentials: credentials({ [BASE]: storedLogin("at-expired", { expires_at: NOW_SECONDS - 10 }) }) });
    const runs = fakeCli([cliError(1, "refresh_lock_timeout", "Another Beakr process is refreshing"), cliToken("at-later")]);
    const { fetch, calls } = mockFetch([json({})]);
    const beakr = clientWith(fetch);
    const error = await beakr.me.get().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BeakrError);
    expect((error as BeakrError).code).toBe("refresh_lock_timeout");
    await beakr.me.get();
    expect(runs).toHaveLength(2);
    expect(calls[0]!.headers.authorization).toBe("Bearer at-later");
  });
});

describe("no sign-in, or no CLI", () => {
  it("a logged-out CLI ends at no_credential", async () => {
    beakrHome();
    fakeCli([cliError(3, "unauthorized", "No Beakr credentials found. Run `beakr auth login`.")]);
    const { fetch, calls } = mockFetch([]);
    const error = await clientWith(fetch).me.get().catch((e: unknown) => e);
    expect((error as AuthenticationError).code).toBe("no_credential");
    expect(calls).toHaveLength(0);
  });

  it("without the CLI, the rest of the chain is read from files as before", async () => {
    beakrHome({ "config.json": { api_key: "bk_live_saved", api_url: BASE } });
    fakeCli([NOT_INSTALLED]);
    const { fetch, calls } = mockFetch([json({})]);
    await clientWith(fetch).me.get();
    expect(calls[0]!.headers.authorization).toBe("Bearer bk_live_saved");
  });

  it("a CLI from before `beakr auth token` (a usage error) counts as no CLI", async () => {
    beakrHome({ "config.json": { api_key: "bk_live_saved", api_url: BASE } });
    fakeCli([{ exitCode: 2, stdout: "", stderr: "Error: No such command 'token'." }]);
    const { fetch, calls } = mockFetch([json({})]);
    await clientWith(fetch).me.get();
    expect(calls[0]!.headers.authorization).toBe("Bearer bk_live_saved");
  });
});

describe("a 401 on the CLI's sign-in", () => {
  it("asks the CLI once, naming the refused token by digest, and resends with the new one", async () => {
    beakrHome();
    const runs = fakeCli([cliToken("at-refused"), cliToken("at-renewed")]);
    const { fetch, calls } = mockFetch([unauthorized(), json({ id: "u" })]);
    await expect(clientWith(fetch).me.get()).resolves.toEqual({ id: "u" });
    expect(runs[1]).toEqual(["auth", "token", "--json", "--api-url", BASE, "--rejected-sha256", tokenDigest("at-refused")]);
    expect(runs[1]!.join(" ")).not.toContain("at-refused");
    expect(calls.map((c) => c.headers.authorization)).toEqual(["Bearer at-refused", "Bearer at-renewed"]);
  });

  it("resends at most once", async () => {
    beakrHome();
    const runs = fakeCli([cliToken("at-one"), cliToken("at-two")]);
    const { fetch, calls } = mockFetch([unauthorized(), unauthorized()]);
    await expect(clientWith(fetch).me.get()).rejects.toBeInstanceOf(AuthenticationError);
    expect(runs).toHaveLength(2);
    expect(calls).toHaveLength(2);
  });

  it("reports the 401 when the CLI has nothing newer", async () => {
    beakrHome();
    const runs = fakeCli([cliToken("at-same"), cliToken("at-same")]);
    const { fetch, calls } = mockFetch([unauthorized()]);
    await expect(clientWith(fetch).me.get()).rejects.toBeInstanceOf(AuthenticationError);
    expect(runs).toHaveLength(2);
    expect(calls).toHaveLength(1);
  });

  it("asks the CLI about a refused token from the credentials file, too", async () => {
    beakrHome({ credentials: credentials({ [BASE]: storedLogin("at-file") }) });
    const runs = fakeCli([cliToken("at-from-cli")]);
    const { fetch, calls } = mockFetch([unauthorized(), json({})]);
    await clientWith(fetch).me.get();
    expect(runs).toEqual([["auth", "token", "--json", "--api-url", BASE, "--rejected-sha256", tokenDigest("at-file")]]);
    expect(calls[1]!.headers.authorization).toBe("Bearer at-from-cli");
  });

  it("does not ask the CLI about an explicit API key", async () => {
    beakrHome();
    const runs = fakeCli([]);
    const { fetch } = mockFetch([unauthorized()]);
    await expect(clientWith(fetch, { apiKey: "bk_live_mine" }).me.get()).rejects.toBeInstanceOf(AuthenticationError);
    expect(runs).toHaveLength(0);
  });
});

describe("Node without process.getBuiltinModule (Node 18, Node 20 before 20.16)", () => {
  function withoutGetBuiltinModule() {
    vi.stubGlobal("process", { ...process, getBuiltinModule: undefined });
    expect((globalThis as { process: { getBuiltinModule?: unknown } }).process.getBuiltinModule).toBeUndefined();
  }

  it("still reads the CLI's credentials file", async () => {
    beakrHome({ credentials: credentials({ [BASE]: storedLogin("at-node18") }) });
    const runs = fakeCli([]);
    withoutGetBuiltinModule();
    const { fetch, calls } = mockFetch([json({})]);
    await clientWith(fetch).me.get();
    expect(calls[0]!.headers.authorization).toBe("Bearer at-node18");
    expect(runs).toHaveLength(0);
  });

  it("still reads a service account file named by path", async () => {
    const home = beakrHome();
    const path = join(home, "sa.json");
    writeFileSync(path, JSON.stringify({ type: "beakr_service_account", api_key: "bk_live_sa18", base_url: BASE }));
    withoutGetBuiltinModule();
    const { fetch, calls } = mockFetch([json({})]);
    await clientWith(fetch, { serviceAccount: path }).me.get();
    expect(calls[0]!.headers.authorization).toBe("Bearer bk_live_sa18");
  });

  it("still asks the CLI when the file has no sign-in", async () => {
    beakrHome();
    fakeCli([cliToken("at-cli18")]);
    withoutGetBuiltinModule();
    const { fetch, calls } = mockFetch([json({})]);
    await clientWith(fetch).me.get();
    expect(calls[0]!.headers.authorization).toBe("Bearer at-cli18");
  });
});

describe("the default runner (child_process, through BEAKR_CLI_PATH)", () => {
  // A stand-in executable, never the real `beakr`: it prints what the CLI
  // would, and records its arguments.
  it.skipIf(process.platform === "win32")("runs the named executable and parses its JSON", async () => {
    const dir = beakrHome();
    const script = join(dir, "fake-beakr");
    writeFileSync(
      script,
      `#!/bin/sh\necho "$@" > "${join(dir, "args")}"\necho '{"access_token": "at-exec", "expires_at": null, "source": "cli_tokens"}'\n`,
    );
    chmodSync(script, 0o755);
    vi.stubEnv("BEAKR_CLI_PATH", script);
    setCliRunner();
    const outcome = await runCliToken(BASE);
    expect(outcome).toEqual({ ok: true, token: { accessToken: "at-exec", source: "cli_tokens" } });
    expect(readFileSync(join(dir, "args"), "utf8").trim()).toBe(`auth token --json --api-url ${BASE}`);
  });

  it("reports a missing executable as unavailable", async () => {
    const dir = beakrHome();
    vi.stubEnv("BEAKR_CLI_PATH", join(dir, "no-such-beakr"));
    setCliRunner();
    const outcome = await runCliToken(BASE);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe("unavailable");
  });
});
