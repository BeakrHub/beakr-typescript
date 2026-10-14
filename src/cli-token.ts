/**
 * The Beakr CLI's sign-in, asked of the CLI itself (`beakr auth token --json`).
 *
 * The credentials file (`cli-login.ts`) is the fast path, but it cannot serve
 * every login: the CLI keeps the login in the OS keychain when one is
 * available, and an expired login has to be refreshed under the CLI's
 * cross-process lock, which Node cannot take. For both, the SDK runs the
 * installed CLI, which reads the keychain or the file exactly as every `beakr`
 * command does and refreshes through its own locked path. The SDK therefore
 * never rotates the stored pair and never sees a refresh token, so it cannot
 * spend one twice or bring back a login `beakr auth logout` cleared.
 *
 * Node.js only. `node:child_process` is loaded when the CLI is first run, never
 * at import time, so the module bundles for browsers and edge runtimes, where
 * `runCliToken` reports the CLI as unavailable without trying.
 */

import type { CliLogin } from "./cli-login.js";
import { isNodeRuntime, nodeBuiltin } from "./node-builtins.js";
import { Sha256 } from "./sha256.js";

/** Long enough for the CLI to wait out another process's refresh (its lock times out at 60s). */
const CLI_TIMEOUT_MS = 90_000;

/** What running the CLI produced. `notFound` when the executable is not installed. */
export interface CliRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  notFound?: boolean;
}

/** Runs `beakr` with `args` and collects its output. Injectable for tests. */
export type CliRunner = (args: readonly string[], options: { timeoutMs: number }) => Promise<CliRunResult>;

/** A token the CLI handed out. `source` is the CLI's credential source (`cli_tokens` for a sign-in). */
export interface CliToken extends CliLogin {
  source: string;
}

export type CliTokenOutcome =
  | { ok: true; token: CliToken }
  | {
      ok: false;
      /**
       * `unavailable`: no CLI to ask (not installed, too old for `auth token`,
       * or not Node.js). `unauthenticated`: the CLI has no credential for this
       * API, or its sign-in could not be refreshed. `failed`: anything else.
       */
      reason: "unavailable" | "unauthenticated" | "failed";
      code?: string;
      message: string;
    };

interface ChildProcessModule {
  execFile(
    file: string,
    args: readonly string[],
    options: { timeout: number; windowsHide: boolean; maxBuffer: number; env?: Record<string, string | undefined> },
    callback: (error: (Error & { code?: unknown }) | null, stdout: string, stderr: string) => void,
  ): unknown;
}

let runnerOverride: CliRunner | undefined;

/**
 * Replace how the CLI is run (tests), or restore the default with no argument.
 * Not part of the public API.
 */
export function setCliRunner(runner?: CliRunner): void {
  runnerOverride = runner;
}

function env(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const value = proc?.env?.[name];
  return value === undefined || value === "" ? undefined : value;
}

/** Run the installed CLI: `BEAKR_CLI_PATH`, else `beakr` on the PATH. */
const defaultRunner: CliRunner = async (args, { timeoutMs }) => {
  const childProcess = await nodeBuiltin<ChildProcessModule>("node:child_process");
  const executable = env("BEAKR_CLI_PATH") ?? "beakr";
  return new Promise<CliRunResult>((resolve) => {
    childProcess.execFile(
      executable,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && error.code === "ENOENT") {
          resolve({ exitCode: null, stdout: "", stderr: String(stderr ?? ""), notFound: true });
          return;
        }
        const exitCode = error ? (typeof error.code === "number" ? error.code : null) : 0;
        resolve({ exitCode, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });
};

/** Hex SHA-256 of a token, so a refused token is named without putting it on a command line. */
export function tokenDigest(token: string): string {
  return new Sha256().update(new TextEncoder().encode(token)).hex();
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Ask the CLI for the access token for `baseUrl`, refreshed if it was about to
 * expire. With `rejectedToken` (a token the API just refused), the CLI
 * refreshes the sign-in if that token is still the stored one, and otherwise
 * returns the newer token another process already saved.
 */
export async function runCliToken(baseUrl: string, options: { rejectedToken?: string } = {}): Promise<CliTokenOutcome> {
  const runner = runnerOverride ?? (isNodeRuntime() ? defaultRunner : undefined);
  if (!runner) return { ok: false, reason: "unavailable", message: "The Beakr CLI can only be run from Node.js." };
  const args = ["auth", "token", "--json", "--api-url", baseUrl];
  if (options.rejectedToken !== undefined) args.push("--rejected-sha256", tokenDigest(options.rejectedToken));
  let result: CliRunResult;
  try {
    result = await runner(args, { timeoutMs: CLI_TIMEOUT_MS });
  } catch (error) {
    return { ok: false, reason: "unavailable", message: `Could not run the Beakr CLI: ${String(error)}` };
  }
  if (result.notFound) {
    return { ok: false, reason: "unavailable", message: "The Beakr CLI (`beakr`) is not installed or not on the PATH." };
  }
  const body = parseJson(result.stdout);
  if (result.exitCode === 0) {
    const accessToken = body?.["access_token"];
    if (typeof accessToken !== "string" || !accessToken) {
      return { ok: false, reason: "failed", message: "`beakr auth token` printed no access token." };
    }
    const token: CliToken = { accessToken, source: typeof body?.["source"] === "string" ? (body["source"] as string) : "cli" };
    const expiresAt = body?.["expires_at"];
    if (typeof expiresAt === "number") token.expiresAt = expiresAt * 1000;
    return { ok: true, token };
  }
  const error = body?.["error"] as { code?: unknown; message?: unknown } | undefined;
  const code = typeof error?.code === "string" ? error.code : undefined;
  const message = typeof error?.message === "string" ? error.message : result.stderr.trim() || "no output";
  if (result.exitCode === 3) return { ok: false, reason: "unauthenticated", ...(code ? { code } : {}), message };
  if (!error) {
    // A CLI from before `beakr auth token` exits 2 with a usage error.
    return { ok: false, reason: "unavailable", message: `The installed Beakr CLI cannot hand out a token (${message}); run \`beakr update\`.` };
  }
  return { ok: false, reason: "failed", ...(code ? { code } : {}), message };
}
