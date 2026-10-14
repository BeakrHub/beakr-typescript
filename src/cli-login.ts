/**
 * The Beakr CLI's stored sign-in, read from disk (developer platform W6.1.4).
 *
 * `beakr auth login` keeps one login per API origin. In Node.js the SDK reads
 * the file copy, `~/.beakr/credentials` (or `$BEAKR_HOME/credentials`), and the
 * key saved by `beakr auth login --api-key` in `~/.beakr/config.json` -- the
 * same files, payload and origin binding the Python SDK reads
 * (`beakr_sdk/credentials.py`). A stored credential is only offered to a client
 * pointed at the API that issued it.
 *
 * This file is the fast path. What it cannot do is delegated to the CLI itself
 * (`cli-token.ts`, `beakr auth token --json`):
 *
 * - The OS keychain. The CLI keeps the login there when one is available (the
 *   default on macOS), through Python's `keyring`; Node has no portable way to
 *   read those entries.
 * - Refreshing. Refreshing rotates the pair, and every Beakr process that
 *   refreshes it does so under the CLI's `flock` on `credentials.lock`, which
 *   Node cannot take; refreshing outside it can present a spent refresh token
 *   and revoke the login for every process. So nothing here ever refreshes:
 *   the CLI does, under its own lock.
 *
 * File access goes through `nodeBuiltinSync`, so it works on Node 18 once the
 * transport has preloaded `node:fs` and `node:os` (`prepareCliLoginFiles`). In
 * a runtime without file access (browsers, edge runtimes) every read here
 * finds nothing and the chain moves on.
 */

import { nodeBuiltinSync, preloadNodeBuiltins } from "./node-builtins.js";
import { normalizeOrigin } from "./service-account.js";

/** Seconds before expiry at which a stored access token is treated as expired (the CLI's skew). */
const REFRESH_SKEW_SECONDS = 60;
const DEFAULT_BASE_URL = "https://api.thebeakr.com";

/** A usable stored sign-in: the access token the CLI last saved for one origin. */
export interface CliLogin {
  accessToken: string;
  /** Epoch milliseconds when the access token expires, when the CLI recorded it. */
  expiresAt?: number;
}

interface NodeFs {
  readFileSync(path: string, encoding: "utf8"): string;
  existsSync(path: string): boolean;
}

interface NodeOs {
  homedir(): string;
}

function builtin<T>(id: string): T | undefined {
  return nodeBuiltinSync<T>(id);
}

/**
 * Make the synchronous file reads here work on Node without
 * `process.getBuiltinModule` (Node 18, Node 20 before 20.16). A no-op elsewhere.
 */
export function prepareCliLoginFiles(): Promise<void> {
  return preloadNodeBuiltins(["node:fs", "node:os"]);
}

function env(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const value = proc?.env?.[name];
  return value === undefined || value === "" ? undefined : value;
}

/** `$BEAKR_HOME`, else `~/.beakr`; undefined without file access. */
export function beakrHome(): string | undefined {
  const override = env("BEAKR_HOME");
  if (override) return override;
  const home = builtin<NodeOs>("node:os")?.homedir();
  return home ? `${home.replace(/[\\/]+$/, "")}/.beakr` : undefined;
}

function readJson(name: string): unknown {
  const home = beakrHome();
  const fs = builtin<NodeFs>("node:fs");
  if (!home || !fs) return undefined;
  try {
    return JSON.parse(fs.readFileSync(`${home}/${name}`, "utf8"));
  } catch {
    return undefined;
  }
}

/** An origin to compare by, or undefined for a value that is not a URL. */
function originOf(url: string): string | undefined {
  try {
    return normalizeOrigin(url);
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The CLI's `config.json` (empty when absent or unreadable). */
function cliConfig(): Record<string, unknown> {
  return record(readJson("config.json")) ?? {};
}

/** The API the CLI is configured for: `BEAKR_BASE_URL`, `BEAKR_API_URL`, the config, then production. */
function configuredBaseUrl(): string {
  const configured = cliConfig()["api_url"];
  return env("BEAKR_BASE_URL") ?? env("BEAKR_API_URL") ?? (typeof configured === "string" && configured ? configured : DEFAULT_BASE_URL);
}

function loginFrom(entry: unknown): (CliLogin & { baseUrl?: string }) | undefined {
  const data = record(entry);
  const accessToken = data?.["access_token"];
  if (typeof accessToken !== "string" || !accessToken) return undefined;
  const login: CliLogin & { baseUrl?: string } = { accessToken };
  const expiresAt = data?.["expires_at"];
  if (typeof expiresAt === "number") login.expiresAt = expiresAt * 1000;
  const baseUrl = data?.["base_url"];
  if (typeof baseUrl === "string" && baseUrl) login.baseUrl = baseUrl;
  return login;
}

/**
 * Origins a logout recorded while the stored logins could not be rewritten
 * (`credentials.barriers`, `{origin: {nonce, at}}`). A stored copy keeps such
 * an origin's login only when it declares it was written after that barrier.
 */
function originBarriers(): Record<string, string> {
  const barriers: Record<string, string> = {};
  for (const [origin, barrier] of Object.entries(record(readJson("credentials.barriers")) ?? {})) {
    const nonce = record(barrier)?.["nonce"];
    if (typeof nonce === "string") barriers[origin] = nonce;
  }
  return barriers;
}

/** The CLI's sign-in for `origin` from `credentials`, or undefined. */
export function readCliLogin(origin: string): CliLogin | undefined {
  const data = record(readJson("credentials"));
  if (!data) return undefined;
  const wanted = originOf(origin);
  if (!wanted) return undefined;
  let found: CliLogin | undefined;
  const logins = record(data["logins"]);
  if (logins) {
    for (const [stored, entry] of Object.entries(logins)) {
      if (originOf(stored) === wanted) found = loginFrom(entry);
    }
  } else if (!("logins" in data)) {
    // A version-1 payload: one bare pair, filed under the origin it records
    // or, recording none, under the configured API.
    const legacy = loginFrom(data);
    if (legacy && originOf(legacy.baseUrl ?? configuredBaseUrl()) === wanted) found = legacy;
  }
  if (!found) return undefined;
  const barrier = originBarriers()[wanted];
  if (barrier !== undefined && record(data["origin_after"])?.[wanted] !== barrier) return undefined;
  return { accessToken: found.accessToken, ...(found.expiresAt !== undefined ? { expiresAt: found.expiresAt } : {}) };
}

/** Whether the stored access token is past (or within the CLI's skew of) its expiry. */
export function cliLoginExpired(login: CliLogin, now = Date.now()): boolean {
  return login.expiresAt !== undefined && now >= login.expiresAt - REFRESH_SKEW_SECONDS * 1000;
}

/** The API key saved by `beakr auth login --api-key`, when it was saved for `origin`. */
export function readCliSavedKey(origin: string): string | undefined {
  const config = cliConfig();
  const key = config["api_key"];
  if (typeof key !== "string" || !key) return undefined;
  const apiUrl = typeof config["api_url"] === "string" && config["api_url"] ? config["api_url"] : DEFAULT_BASE_URL;
  const wanted = originOf(origin);
  return wanted !== undefined && originOf(apiUrl) === wanted ? key : undefined;
}

/** `~/.beakr/service-account.json` when it exists (the chain's default service account file). */
export function defaultServiceAccountFile(): string | undefined {
  const home = beakrHome();
  const fs = builtin<NodeFs>("node:fs");
  if (!home || !fs) return undefined;
  const path = `${home}/service-account.json`;
  try {
    return fs.existsSync(path) ? path : undefined;
  } catch {
    return undefined;
  }
}
