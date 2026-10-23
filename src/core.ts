/**
 * The transport: request building, credentials, retries, token refresh and
 * pagination. Resources describe requests; this sends them.
 *
 * Retry policy (same as the Python SDK; spec W6.1.3, "429 and 5xx"):
 * - 429 is retried for every method: the server refused before doing the work;
 *   except `credits_exhausted` and `quota_exceeded`, which no retry soon can fix.
 * - 500, 502, 503, 504 and connection errors are retried only when a resend
 *   cannot duplicate an effect: GET, HEAD, PUT, DELETE, a create the engine
 *   replays on its Idempotency-Key (`replay.ts`; the same key is resent), or a
 *   route that deduplicates resends itself. Any other POST is not resent after
 *   an ambiguous failure. 501 and 505 are never retried.
 * - A keyed create's 409 `idempotency_in_progress` / `idempotency_superseded`
 *   (an earlier attempt still holds the key) is waited out the same way.
 * - `Retry-After` (seconds or an HTTP-date) is honored up to 60 seconds; beyond
 *   that the error is returned.
 * - Other 4xx are never retried.
 */
import {
  APIConnectionError,
  AuthenticationError,
  BeakrError,
  errorFromResponse,
  parseRetryAfter,
} from "./errors.js";
import {
  type CliLogin,
  cliLoginExpired,
  defaultServiceAccountFile,
  prepareCliLoginFiles,
  readCliLogin,
  readCliSavedKey,
} from "./cli-login.js";
import { type CliTokenOutcome, runCliToken } from "./cli-token.js";
import { isNodeRuntime, nodeBuiltinSync } from "./node-builtins.js";
import {
  normalizeOrigin,
  readServiceAccountFile,
  SERVICE_ACCOUNT_FILE_ENV,
  type ServiceAccountCredentials,
} from "./service-account.js";
import { maskSecret } from "./redact.js";
import { IDEMPOTENCY_RETRY_CODES, replaysIdempotencyKey } from "./replay.js";
import type { Page } from "./types.js";
import { VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://api.thebeakr.com";
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_RETRIES = 2;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
/** 429 refusals that waiting a few seconds cannot fix (out of credits, quota spent). */
const NOT_RETRIED_429_CODES = new Set(["credits_exhausted", "quota_exceeded"]);
const RETRY_SAFE_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]);
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8_000;
const MAX_RETRY_AFTER_SECONDS = 60;
const REFRESH_SKEW_MS = 30_000;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** An OAuth access/refresh pair (the Beakr CLI's sign-in, or one your app obtained). */
export interface TokenPair {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds when the access token expires. */
  expiresAt?: number;
  /**
   * The OAuth issuer's token endpoint the pair refreshes at, and the public
   * client id it was issued to. A pair without them is not refreshed: a 401
   * surfaces as AuthenticationError.
   */
  tokenEndpoint?: string;
  clientId?: string;
}

/**
 * Where a client's credential comes from, first match wins (the Python SDK's
 * order, spec W6.1.4):
 *
 * 1. `apiKey` or `tokens` passed to the client (an explicit `apiKey: ""` ends
 *    the chain with no credential);
 * 2. `BEAKR_API_KEY`;
 * 3. `serviceAccount` passed to the client (TypeScript only: an explicit
 *    choice outranks a stored one);
 * 4. the Beakr CLI's sign-in for this API (Node.js): from
 *    `~/.beakr/credentials` when it holds a current one, else from the
 *    installed CLI (`beakr auth token --json`), which reads the OS keychain
 *    and refreshes an expired login under its own lock (`cli-token.ts`);
 * 5. the API key saved by `beakr auth login --api-key`, when saved for this API;
 * 6. the service account file named by `BEAKR_SERVICE_ACCOUNT_FILE`, else
 *    `~/.beakr/service-account.json` when it exists.
 *
 * Links 4 to 6 read files (and may run the CLI); they are resolved at the
 * first request, and skipped in runtimes without file access. `cliLogin: false`
 * skips 4 and 5.
 */
export interface ClientOptions {
  /** An API key (`bk_live_...`). Defaults to `BEAKR_API_KEY` when a process env exists. */
  apiKey?: string;
  /** An OAuth token pair. Refreshed at its `tokenEndpoint` before expiry and on a 401. */
  tokens?: TokenPair;
  /**
   * A service account's credentials, parsed or as a file path. Used only when
   * no `apiKey`, `tokens` or `BEAKR_API_KEY` is set. Without it, the file named
   * by `BEAKR_SERVICE_ACCOUNT_FILE` (or `~/.beakr/service-account.json`) is used
   * after the CLI's stored sign-in. A file bound to another API is refused.
   */
  serviceAccount?: ServiceAccountCredentials | string;
  /**
   * Use the Beakr CLI's stored sign-in (`beakr auth login`) for this API when no
   * explicit credential, `BEAKR_API_KEY` or `serviceAccount` is given: the
   * credentials file, else the installed CLI (`BEAKR_CLI_PATH`, else `beakr` on
   * the PATH), which also covers a login kept in the OS keychain and refreshes
   * an expired one. Node.js only; default true.
   */
  cliLogin?: boolean;
  /** Called with every rotated token pair; persist it, the old refresh token is dead. */
  onTokens?: (tokens: TokenPair) => void | Promise<void>;
  /**
   * Defaults to `BEAKR_BASE_URL`, then `BEAKR_API_URL` (the name the CLI and
   * the Python SDK also read, in the same order), then https://api.thebeakr.com.
   */
  baseUrl?: string;
  /** Sent as `X-Beakr-Client` (attribution only). */
  clientName?: string;
  /** Sent as `X-Beakr-Agent` (attribution only). */
  agent?: string;
  /** Sent as `X-Org-Id` to select an organization for session-like credentials. */
  orgId?: string;
  timeoutMs?: number;
  maxRetries?: number;
  defaultHeaders?: Record<string, string>;
  /** Injectable for tests and custom runtimes. Defaults to global `fetch`. */
  fetch?: FetchLike;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Injectable for tests: the clock (epoch milliseconds) an HTTP-date
   * `Retry-After` is measured from. Defaults to `Date.now`.
   */
  now?: () => number;
}

export type QueryValue = string | number | boolean | null | undefined | readonly string[];

export interface RequestOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, QueryValue>;
  /** A JSON value, or a `FormData` sent as multipart (fetch sets its boundary). */
  body?: unknown;
  /** Send the credential (off for anonymous routes). */
  authenticated?: boolean;
  /** Attach an `Idempotency-Key`, stable across this call's retries. */
  idempotent?: boolean;
  /** Use this key instead of a fresh one, so the caller's own retries replay too. */
  idempotencyKey?: string;
  /** The route deduplicates a resend itself, so ambiguous failures may be retried. */
  serverDeduplicated?: boolean;
  /** How to decode a success body. */
  responseType?: "json" | "text" | "bytes" | "none";
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /**
   * Wait at least this long for the response, even when the client's own
   * timeout is shorter (a route that is slow by design, like research).
   */
  minTimeoutMs?: number;
}

function env(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const value = proc?.env?.[name];
  return value === undefined || value === "" ? undefined : value;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function buildQuery(query: Record<string, QueryValue> | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else {
      params.append(key, String(value));
    }
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

function isFormData(body: unknown): body is FormData {
  return typeof FormData !== "undefined" && body instanceof FormData;
}

/** A request body: multipart as is, anything else as JSON. */
function encodeBody(body: unknown): BodyInit {
  return isFormData(body) ? body : JSON.stringify(body);
}

/** Drop undefined fields from a JSON body, so omitted options are not sent as null. */
export function cleanBody<T extends Record<string, unknown>>(body: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<T>;
}

/** Chain links that need file access, waiting for the first request. */
interface FileLinks {
  step: "files";
  serviceAccount: string | undefined;
  cliLogin: boolean;
}

/** The CLI's sign-in, to ask the CLI for (the file has none for this API, or an expired one). */
interface CliLinks {
  step: "cli";
  fileLoginExpired: boolean;
}

type PendingLinks = FileLinks | CliLinks;

/** Node's hook for `util.inspect` and `console.log`; a plain symbol everywhere else. */
export const INSPECT_CUSTOM = Symbol.for("nodejs.util.inspect.custom");

/** The parts of a transport that are safe to print. */
export interface TransportDescription {
  baseUrl: string;
  orgId: string | undefined;
  /** The credential in use, masked (`bk_live_...a1b2`), or "unresolved". */
  credential: string;
}

export class Transport {
  readonly baseUrl: string;
  readonly clientName: string;
  readonly agent: string | undefined;
  orgId: string | undefined;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  // The credential lives in #private fields: a TypeScript `private` field is an
  // ordinary enumerable property, so `console.log(beakr)`, `util.inspect` and
  // `JSON.stringify` printed the full key. Inspection shows it masked instead.
  #apiKey: string | undefined;
  #tokens: TokenPair | undefined;
  /** The CLI's sign-in, when that is the credential (never refreshed here: the CLI refreshes it). */
  #cliLogin: CliLogin | undefined;
  /** Credential-chain links still to resolve at the first request (see `settleCredential`). */
  private pendingLinks: PendingLinks | undefined;
  private settling: Promise<void> | undefined;
  /** In-flight `beakr auth token` runs, keyed by the refused token ("" for none). */
  private readonly cliRuns = new Map<string, Promise<CliTokenOutcome>>();
  private readonly onTokens: ClientOptions["onTokens"];
  /** May carry an `Authorization` header, so it is kept off the object like the key. */
  readonly #defaultHeaders: Record<string, string>;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private refreshing: Promise<void> | undefined;
  private activeOrg: Promise<string> | undefined;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? env("BEAKR_BASE_URL") ?? env("BEAKR_API_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.clientName = options.clientName ?? `sdk-typescript/${VERSION}`;
    this.agent = options.agent;
    this.orgId = options.orgId ?? env("BEAKR_ORG_ID");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
    this.#tokens = options.tokens;
    this.#apiKey = options.tokens ? options.apiKey : this.resolveApiKey(options);
    this.onTokens = options.onTokens;
    this.#defaultHeaders = { ...(options.defaultHeaders ?? {}) };
    const globalFetch = (globalThis as { fetch?: FetchLike }).fetch;
    const fetchImpl = options.fetch ?? globalFetch?.bind(globalThis);
    if (!fetchImpl) throw new BeakrError("No fetch implementation available; pass `fetch`.");
    this.fetchImpl = fetchImpl;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }

  /**
   * Walk the credential chain (see `ClientOptions`) when no token pair is
   * given. Links that need files are resolved here when the runtime can read
   * them synchronously; on Node without `process.getBuiltinModule` they wait
   * for the first request, which loads `node:fs` first.
   */
  private resolveApiKey(options: ClientOptions): string | undefined {
    if (options.apiKey !== undefined) return options.apiKey;
    const envKey = env("BEAKR_API_KEY");
    if (envKey !== undefined) return envKey;
    if (options.serviceAccount !== undefined && typeof options.serviceAccount !== "string") {
      return this.serviceAccountKey(options.serviceAccount);
    }
    const links: FileLinks = { step: "files", serviceAccount: options.serviceAccount, cliLogin: options.cliLogin !== false };
    if (isNodeRuntime() && nodeBuiltinSync("node:fs") === undefined) {
      this.pendingLinks = links;
      return undefined;
    }
    return this.resolveFileLinks(links);
  }

  /**
   * Links 3 (a service account file path) to 6, with file access. Sets
   * `cliLogin` when the credentials file holds a current sign-in for this API,
   * and leaves the CLI to ask (`pendingLinks`) when it holds none or an expired
   * one: the login may be in the keychain, or need the CLI's locked refresh.
   */
  private resolveFileLinks(links: FileLinks): string | undefined {
    if (links.serviceAccount !== undefined) return this.serviceAccountKey(links.serviceAccount);
    if (!links.cliLogin) return this.serviceAccountKey(undefined);
    const login = readCliLogin(normalizeOrigin(this.baseUrl));
    if (login && !cliLoginExpired(login)) {
      this.#cliLogin = login;
      return undefined;
    }
    if (isNodeRuntime()) {
      this.pendingLinks = { step: "cli", fileLoginExpired: login !== undefined };
      return undefined;
    }
    return this.keyAfterCliLogin();
  }

  /** Links 5 and 6: the CLI's saved key for this API, then the service account file. */
  private keyAfterCliLogin(): string | undefined {
    const saved = readCliSavedKey(normalizeOrigin(this.baseUrl));
    if (saved !== undefined) return saved;
    return this.serviceAccountKey(undefined);
  }

  /** Finish the credential chain before the first authenticated request. */
  private async settleCredential(): Promise<void> {
    if (this.pendingLinks === undefined) return;
    this.settling ??= this.settleLinks().finally(() => {
      this.settling = undefined;
    });
    await this.settling;
  }

  /**
   * A link that fails is left pending, so the next request tries it again (the
   * CLI may be installed or signed in by then) and reports the same error.
   */
  private async settleLinks(): Promise<void> {
    for (let links = this.pendingLinks; links !== undefined; links = this.pendingLinks) {
      if (links.step === "files") {
        await prepareCliLoginFiles();
        const key = this.resolveFileLinks(links);
        if (this.pendingLinks === links) this.pendingLinks = undefined;
        this.#apiKey = key;
        continue;
      }
      const outcome = await this.askCli();
      if (outcome.ok) {
        this.#cliLogin = outcome.token;
        this.pendingLinks = undefined;
        return;
      }
      if (links.fileLoginExpired || outcome.reason === "failed") throw this.cliLoginError(outcome);
      // No CLI, or the CLI has no credential for this API: the rest of the chain.
      this.#apiKey = this.keyAfterCliLogin();
      this.pendingLinks = undefined;
    }
  }

  /** Run `beakr auth token` once at a time per refused token. */
  private askCli(rejectedToken?: string): Promise<CliTokenOutcome> {
    const key = rejectedToken ?? "";
    let run = this.cliRuns.get(key);
    if (!run) {
      run = runCliToken(this.baseUrl, rejectedToken !== undefined ? { rejectedToken } : {}).finally(() => {
        this.cliRuns.delete(key);
      });
      this.cliRuns.set(key, run);
    }
    return run;
  }

  /** The error for a CLI sign-in that is expired and that the CLI could not refresh. */
  private cliLoginError(outcome: Exclude<CliTokenOutcome, { ok: true }>): BeakrError {
    const origin = normalizeOrigin(this.baseUrl);
    if (outcome.reason === "unavailable") {
      return new AuthenticationError(
        `The Beakr CLI sign-in for ${origin} has expired, and the SDK refreshes it only through ` +
          `the CLI, which could not be run (${outcome.message}). Install the CLI or set ` +
          "BEAKR_CLI_PATH, run `beakr auth token` to refresh it, or `beakr auth login`.",
        { code: "cli_login_expired" },
      );
    }
    if (outcome.reason === "unauthenticated") {
      return new AuthenticationError(`The Beakr CLI sign-in for ${origin} is not usable: ${outcome.message}`, {
        code: outcome.code ?? "cli_login_expired",
      });
    }
    return new BeakrError(`The Beakr CLI could not provide a token for ${origin}: ${outcome.message}`, {
      code: outcome.code ?? "cli_token_failed",
    });
  }

  /**
   * The service-account link of the chain. A file named explicitly that cannot
   * be used fails here, at construction, not on the first request.
   */
  private serviceAccountKey(option: ClientOptions["serviceAccount"]): string | undefined {
    const named = option ?? env(SERVICE_ACCOUNT_FILE_ENV) ?? defaultServiceAccountFile();
    if (named === undefined) return undefined;
    const account = typeof named === "string" ? readServiceAccountFile(named) : named;
    if (account.baseUrl && normalizeOrigin(account.baseUrl) !== normalizeOrigin(this.baseUrl)) {
      throw new AuthenticationError(
        `The service account key is for ${normalizeOrigin(account.baseUrl)}, not ` +
          `${normalizeOrigin(this.baseUrl)}; a key is only sent to the API that issued it.`,
        { code: "unauthorized" },
      );
    }
    return account.apiKey;
  }

  /** What the client may show of itself: where it talks to and its credential, masked. */
  describe(): TransportDescription {
    return {
      baseUrl: this.baseUrl,
      orgId: this.orgId,
      credential: maskSecret(this.#tokens?.accessToken ?? this.#apiKey ?? this.#cliLogin?.accessToken) ?? "unresolved",
    };
  }

  toJSON(): TransportDescription {
    return this.describe();
  }

  [INSPECT_CUSTOM](): string {
    return `Transport ${JSON.stringify(this.describe())}`;
  }

  /** The current token pair (after any refresh), when the client uses one. */
  get currentTokens(): TokenPair | undefined {
    return this.#tokens ? { ...this.#tokens } : undefined;
  }

  private authHeader(): Record<string, string> {
    const token = this.#tokens?.accessToken ?? this.#apiKey ?? this.#cliLogin?.accessToken;
    if (!token) {
      throw new AuthenticationError(
        "No credential configured: pass `apiKey` or `tokens`, set BEAKR_API_KEY or " +
          "BEAKR_SERVICE_ACCOUNT_FILE, or sign in with `beakr auth login`.",
        { code: "no_credential" },
      );
    }
    return { Authorization: `Bearer ${token}` };
  }

  private headersFor(options: RequestOptions, idempotencyKey: string | undefined): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "X-Beakr-Client": this.clientName,
      ...this.#defaultHeaders,
    };
    if (this.agent) headers["X-Beakr-Agent"] = this.agent;
    if (this.orgId) headers["X-Org-Id"] = this.orgId;
    if (options.authenticated !== false) Object.assign(headers, this.authHeader());
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    if (options.body !== undefined && !isFormData(options.body)) {
      headers["Content-Type"] = "application/json";
    }
    Object.assign(headers, options.headers ?? {});
    return headers;
  }

  /**
   * Before an authenticated request: finish the credential chain, then, on the
   * CLI's sign-in, replace an expired access token -- with a current one from
   * the credentials file when the CLI has already refreshed it, else by asking
   * the CLI, which refreshes it under its lock.
   */
  private async prepareCredential(options: RequestOptions): Promise<void> {
    if (options.authenticated === false) return;
    await this.settleCredential();
    if (!this.#cliLogin || !cliLoginExpired(this.#cliLogin)) return;
    const stored = readCliLogin(normalizeOrigin(this.baseUrl));
    if (stored && !cliLoginExpired(stored)) {
      this.#cliLogin = stored;
      return;
    }
    const outcome = await this.askCli();
    if (!outcome.ok) throw this.cliLoginError(outcome);
    this.#cliLogin = outcome.token;
  }

  /**
   * After a 401 on the CLI's sign-in: adopt a newer pair from the credentials
   * file, else ask the CLI, which refreshes the login if the refused token is
   * still the stored one. True when there is a different token to resend with.
   */
  private async recoverCliLogin(): Promise<boolean> {
    const current = this.#cliLogin;
    if (!current) return false;
    const stored = readCliLogin(normalizeOrigin(this.baseUrl));
    if (stored && stored.accessToken !== current.accessToken && !cliLoginExpired(stored)) {
      this.#cliLogin = stored;
      return true;
    }
    const outcome = await this.askCli(current.accessToken);
    if (!outcome.ok || outcome.token.accessToken === current.accessToken) return false;
    this.#cliLogin = outcome.token;
    return true;
  }

  private canRefresh(): boolean {
    return Boolean(this.#tokens?.refreshToken && this.#tokens.tokenEndpoint);
  }

  private needsProactiveRefresh(): boolean {
    const expiresAt = this.#tokens?.expiresAt;
    return this.canRefresh() && expiresAt !== undefined && Date.now() >= expiresAt - REFRESH_SKEW_MS;
  }

  /** Rotate the token pair once, even when several requests notice at the same time. */
  async refreshTokens(): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = undefined;
      });
    }
    return this.refreshing;
  }

  /** Refresh at the OAuth issuer's token endpoint (RFC 6749 section 6). */
  private async doRefresh(): Promise<void> {
    const previous = this.#tokens;
    if (!previous?.refreshToken || !previous.tokenEndpoint) {
      throw new AuthenticationError("No refresh token and token endpoint to refresh with.");
    }
    const data = await this.postExternalForm<Record<string, unknown>>(previous.tokenEndpoint, {
      grant_type: "refresh_token",
      refresh_token: previous.refreshToken,
      client_id: previous.clientId ?? "",
    });
    this.#tokens = tokenPairFromResponse(data, previous);
    await this.onTokens?.({ ...this.#tokens });
  }

  /** Send a request, applying refresh and the retry policy. */
  async request<T = unknown>(options: RequestOptions): Promise<T> {
    return this.send<T>(options, { allowRefresh: true });
  }

  private async send<T>(options: RequestOptions, { allowRefresh }: { allowRefresh: boolean }): Promise<T> {
    if (allowRefresh && options.authenticated !== false && this.needsProactiveRefresh()) {
      await this.refreshTokens();
    }
    await this.prepareCredential(options);
    const idempotencyKey =
      options.idempotencyKey ?? (options.idempotent ? globalThis.crypto.randomUUID() : undefined);
    const replaysKey = idempotencyKey !== undefined && replaysIdempotencyKey(options.method, options.path);
    const retrySafe = options.serverDeduplicated || replaysKey || RETRY_SAFE_METHODS.has(options.method);
    let refreshed = false;
    let attempt = 0;

    for (;;) {
      const url = `${this.baseUrl}${options.path}${buildQuery(options.query)}`;
      const init: RequestInit = {
        method: options.method,
        headers: this.headersFor(options, idempotencyKey),
      };
      if (options.body !== undefined) init.body = encodeBody(options.body);
      const timeoutMs = Math.max(this.timeoutMs, options.minTimeoutMs ?? 0);
      init.signal = combineSignals(options.signal, AbortSignal.timeout(timeoutMs));

      let response: Response;
      try {
        response = await this.fetchImpl(url, init);
      } catch (cause) {
        if (options.signal?.aborted) throw cause;
        if (retrySafe && attempt < this.maxRetries) {
          await this.sleep(backoffMs(attempt));
          attempt += 1;
          continue;
        }
        throw new APIConnectionError(`Could not reach ${this.baseUrl}: ${String(cause)}`, {
          code: "connection_error",
          cause,
          baseUrl: this.baseUrl,
        });
      }

      if (response.ok) return (await decode(response, options.responseType ?? "json")) as T;

      const body = await readBody(response);
      if (
        response.status === 401 &&
        allowRefresh &&
        !refreshed &&
        options.authenticated !== false &&
        this.canRefresh()
      ) {
        refreshed = true;
        await this.refreshTokens();
        continue;
      }
      if (response.status === 401 && !refreshed && options.authenticated !== false && (await this.recoverCliLogin())) {
        refreshed = true;
        continue;
      }
      const keyStillHeld =
        response.status === 409 && replaysKey && IDEMPOTENCY_RETRY_CODES.has(errorCode(body) ?? "");
      if ((RETRY_STATUSES.has(response.status) || keyStillHeld) && attempt < this.maxRetries) {
        const retryable =
          (response.status === 429 && !NOT_RETRIED_429_CODES.has(errorCode(body) ?? "")) ||
          (response.status !== 429 && (keyStillHeld || retrySafe));
        const retryAfter = parseRetryAfter(response.headers.get("retry-after"), this.now());
        if (retryable && (retryAfter === undefined || retryAfter <= MAX_RETRY_AFTER_SECONDS)) {
          await this.sleep(retryAfter !== undefined ? retryAfter * 1000 : backoffMs(attempt));
          attempt += 1;
          continue;
        }
      }
      throw errorFromResponse(response.status, response.headers, body, response.statusText, this.now(), this.baseUrl);
    }
  }

  /**
   * PUT bytes to a presigned storage URL (an upload part). No Beakr headers and
   * no credential are sent: the URL's signature is the authorization, and a
   * bearer token sent to a storage host is a leaked credential. A PUT is safe to
   * resend, so network failures and retryable statuses are retried. Returns the
   * response so the caller can read headers such as `ETag`.
   */
  /**
   * A form-encoded POST to a third-party OAuth endpoint (the issuer's token endpoint).
   * The issuer is not the Beakr API, so no Beakr headers or credential are
   * sent; the request authenticates with its own form fields. A refusal is
   * raised with the endpoint's body, whose RFC 6749 `error` names the reason.
   */
  async postExternalForm<T = unknown>(url: string, form: Record<string, string>): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams(form),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      throw new APIConnectionError(`Could not reach the sign-in issuer: ${String(cause)}`, {
        code: "connection_error",
        cause,
      });
    }
    const body = await readBody(response);
    if (!response.ok) throw errorFromResponse(response.status, response.headers, body, response.statusText, this.now(), new URL(url).origin);
    return body as T;
  }

  /** GET bytes from a presigned storage URL, with no Beakr credential (retried like PUTs). */
  async getExternalBytes(url: string, options: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: "GET",
          signal: combineSignals(options.signal, AbortSignal.timeout(this.timeoutMs)),
        });
      } catch (cause) {
        if (options.signal?.aborted) throw cause;
        if (attempt < this.maxRetries) {
          await this.sleep(backoffMs(attempt));
          continue;
        }
        throw new APIConnectionError(`Could not reach the storage host: ${String(cause)}`, {
          code: "connection_error",
          cause,
        });
      }
      if (response.ok) return new Uint8Array(await response.arrayBuffer());
      if (RETRY_STATUSES.has(response.status) && attempt < this.maxRetries) {
        await this.sleep(backoffMs(attempt));
        continue;
      }
      throw errorFromResponse(response.status, response.headers, await readBody(response), response.statusText, this.now());
    }
  }

  async putExternal(
    url: string,
    body: Uint8Array | Blob,
    options: { headers?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: "PUT",
          headers: options.headers ?? {},
          body: body as BodyInit,
          signal: combineSignals(options.signal, AbortSignal.timeout(this.timeoutMs)),
        });
      } catch (cause) {
        if (options.signal?.aborted) throw cause;
        if (attempt < this.maxRetries) {
          await this.sleep(backoffMs(attempt));
          continue;
        }
        throw new APIConnectionError(`Could not reach the storage host: ${String(cause)}`, {
          code: "connection_error",
          cause,
        });
      }
      if (response.ok) return response;
      if (RETRY_STATUSES.has(response.status) && attempt < this.maxRetries) {
        await this.sleep(backoffMs(attempt));
        continue;
      }
      throw errorFromResponse(response.status, response.headers, await readBody(response), response.statusText, this.now());
    }
  }

  /**
   * One authenticated request whose body the caller reads itself (a stream).
   * No retries; a 401 is refreshed once when tokens allow. Non-2xx rejects.
   */
  async raw(options: RequestOptions): Promise<Response> {
    if (options.authenticated !== false && this.needsProactiveRefresh()) await this.refreshTokens();
    await this.prepareCredential(options);
    for (let refreshed = false; ; refreshed = true) {
      const init: RequestInit = { method: options.method, headers: this.headersFor(options, undefined) };
      if (options.body !== undefined) init.body = encodeBody(options.body);
      if (options.signal) init.signal = options.signal;
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${options.path}${buildQuery(options.query)}`, init);
      } catch (cause) {
        throw new APIConnectionError(`Could not reach ${this.baseUrl}: ${String(cause)}`, {
          code: "connection_error",
          cause,
          baseUrl: this.baseUrl,
        });
      }
      if (response.ok) return response;
      const body = await readBody(response);
      if (response.status === 401 && !refreshed && this.canRefresh()) {
        await this.refreshTokens();
        continue;
      }
      if (response.status === 401 && !refreshed && options.authenticated !== false && (await this.recoverCliLogin())) {
        continue;
      }
      throw errorFromResponse(response.status, response.headers, body, response.statusText, this.now(), this.baseUrl);
    }
  }

  /**
   * The org id for org-addressed routes: configured `orgId`, else the
   * caller's active org, looked up once and shared by every resource.
   */
  async resolveOrgId(): Promise<string> {
    if (this.orgId) return this.orgId;
    this.activeOrg ??= this.request<{ id?: unknown }>({ method: "GET", path: "/v1/me/organization" })
      .then((org) => {
        if (typeof org?.id !== "string" || !org.id) {
          throw new BeakrError("Could not determine the active organization.", { code: "no_active_org", body: org });
        }
        return org.id;
      })
      .catch((error: unknown) => {
        // A failed lookup is not cached; the next call tries again.
        this.activeOrg = undefined;
        throw error;
      });
    return this.activeOrg;
  }

  /** Every item of a cursor-paginated list (`{data, next_cursor, has_more}`). */
  async *paginate<T>(options: RequestOptions, pageSize?: number): AsyncGenerator<T> {
    let cursor = options.query?.["cursor"] as string | undefined;
    for (;;) {
      const query: Record<string, QueryValue> = { ...(options.query ?? {}), cursor };
      if (pageSize !== undefined) query["limit"] = pageSize;
      const page = await this.request<Page<T> | T[]>({ ...options, query });
      if (Array.isArray(page)) {
        // An older route answering a bare list is one whole page.
        yield* page;
        return;
      }
      yield* page.data ?? [];
      if (!page.has_more || !page.next_cursor) return;
      cursor = page.next_cursor;
    }
  }

  get sleeper(): (ms: number) => Promise<void> {
    return this.sleep;
  }
}

/** Abort when either signal aborts. `AbortSignal.any` exists only from Node 20.3. */
function combineSignals(caller: AbortSignal | undefined, timeout: AbortSignal): AbortSignal {
  if (!caller) return timeout;
  const any = (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (any) return any([caller, timeout]);
  const controller = new AbortController();
  const abort = (signal: AbortSignal) => () => controller.abort(signal.reason);
  if (caller.aborted) controller.abort(caller.reason);
  caller.addEventListener("abort", abort(caller), { once: true });
  timeout.addEventListener("abort", abort(timeout), { once: true });
  return controller.signal;
}

/** Exponential backoff with full jitter: ~0.5s, 1s, 2s ... capped at 8s. */
export function backoffMs(attempt: number): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return ceiling / 2 + Math.random() * (ceiling / 2);
}

/**
 * A pair from an OAuth token response. `previous` carries the refresh token
 * (an issuer may not rotate it) and where the pair refreshes.
 */
export function tokenPairFromResponse(data: Record<string, unknown>, previous?: TokenPair): TokenPair {
  const accessToken = data["access_token"];
  if (typeof accessToken !== "string") {
    throw new AuthenticationError("Token response carried no access_token.", { body: data });
  }
  const pair: TokenPair = { accessToken };
  const refresh = typeof data["refresh_token"] === "string" ? data["refresh_token"] : previous?.refreshToken;
  if (refresh) pair.refreshToken = refresh;
  if (previous?.tokenEndpoint) pair.tokenEndpoint = previous.tokenEndpoint;
  if (previous?.clientId) pair.clientId = previous.clientId;
  const expiresIn = data["expires_in"];
  if (typeof expiresIn === "number") pair.expiresAt = Date.now() + expiresIn * 1000;
  return pair;
}

/** The error code of a refusal body: the envelope's, else a structured `detail`'s. */
function errorCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  for (const holder of [record["error"], record["detail"]]) {
    if (holder && typeof holder === "object") {
      const code = (holder as Record<string, unknown>)["code"];
      if (typeof code === "string") return code;
    }
  }
  return undefined;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function decode(response: Response, type: NonNullable<RequestOptions["responseType"]>): Promise<unknown> {
  if (type === "none" || response.status === 204) return undefined;
  if (type === "bytes") return new Uint8Array(await response.arrayBuffer());
  if (type === "text") return response.text();
  // A JSON-typed call that receives a file (an older contract, or an
  // undeclared media type) must not be decoded as text: that corrupts bytes.
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (contentType && !isTextual(contentType)) return new Uint8Array(await response.arrayBuffer());
  return readBody(response);
}

function isTextual(contentType: string): boolean {
  return (
    contentType.includes("json") ||
    contentType.startsWith("text/") ||
    contentType.includes("xml") ||
    contentType.includes("x-www-form-urlencoded")
  );
}
