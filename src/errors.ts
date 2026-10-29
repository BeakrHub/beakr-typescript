/**
 * Typed errors. Every error carries the HTTP status, the machine-readable
 * `code` from the error envelope, a message and the request id the server
 * logged the call under.
 *
 * The envelope is `{detail: <legacy>, error: {code, message, fix, details,
 * request_id}}`. `details` holds structured context (`required_scope`,
 * `expected_base_index`, and for a validation error every failing field under
 * `errors`) and is exposed as `BeakrError.details`. Servers before it existed
 * put those fields beside `code` (they still do, for compatibility), so
 * `required_scope` is read from `details` first and the envelope second.
 * Routes that predate the envelope send `detail` only, so each field falls
 * back: the message to `detail`, the request id to the `X-Request-ID` header,
 * the code to one derived from the status.
 *
 * A body that is not JSON is never the message as it is: an HTML page (a web
 * app, a proxy or a server that is not Beakr, at a wrong base URL) is named by
 * its title, with a fix that says to check the API URL, and other text is cut
 * to a short excerpt. A success whose body is an HTML page where JSON was
 * expected throws `UnexpectedResponseError`.
 */
import { parseHttpDate } from "./http-date.js";

export interface BeakrErrorOptions {
  status?: number;
  code?: string;
  requestId?: string;
  body?: unknown;
  details?: Record<string, unknown>;
  cause?: unknown;
  /** The API origin the failed request was sent to. */
  baseUrl?: string;
  /** How to correct the call (`error.fix`), when the server said. */
  fix?: string;
}

export class BeakrError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly requestId: string | undefined;
  readonly body: unknown;
  /** Structured context from `error.details` (`{}` when none was sent). */
  readonly details: Record<string, unknown>;
  /**
   * The API origin the request went to. Named in the message too, so a key
   * sent to the wrong host (a dev key against production) reads as that.
   */
  readonly baseUrl: string | undefined;
  /** How to correct the call (`error.fix`), when the server said; also in the message. */
  readonly fix: string | undefined;

  constructor(message: string, options: BeakrErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.status = options.status;
    this.code = options.code;
    this.requestId = options.requestId;
    this.body = options.body;
    this.details = options.details ?? {};
    this.baseUrl = options.baseUrl;
    this.fix = options.fix;
  }
}

/**
 * `12 of 10 uploads per day; resets 2026-10-14T00:00:00Z` from a limit's details.
 *
 * A `quota_exceeded` refusal names the limit, its window and when it resets in
 * `error.details`; without them the message ("Uploads limit reached") does not
 * say how long to wait. The Python SDK's `quota_text` reads the same fields.
 */
export function quotaText(details: Record<string, unknown>): string | undefined {
  const limit = details["limit"];
  if (limit === undefined || limit === null) return undefined;
  const resource = String(details["resource"] ?? "").replace(/_/g, " ");
  const current = details["current"];
  let text = current !== undefined && current !== null ? `${current} of ${limit}` : `limit ${limit}`;
  if (resource) text += ` ${resource}`;
  if (details["window"]) text += ` per ${details["window"]}`;
  if (details["resets_at"]) text += `; resets ${details["resets_at"]}`;
  return text;
}

/** The request never produced an HTTP response (DNS, refused, timeout, abort). */
export class APIConnectionError extends BeakrError {}

/** 401, or no credential was configured. */
export class AuthenticationError extends BeakrError {}

/** 403. `requiredScope` is set when a scoped credential lacks the route's scope. */
export class PermissionDeniedError extends BeakrError {
  readonly requiredScope: string | undefined;
  constructor(message: string, options: BeakrErrorOptions & { requiredScope?: string } = {}) {
    super(message, options);
    this.requiredScope = options.requiredScope;
  }
}

/**
 * 403 `person_review_required`: the project (or organization) requires a
 * person to accept proposals and commit Knowledge
 * (`GET /v1/knowledge/agent-review`), and this API key or token may not. A
 * signed-in person, or a key holding the `proposals:accept` scope, can; staging
 * the proposal stays open to the key.
 */
export class PersonReviewRequiredError extends PermissionDeniedError {}

export class NotFoundError extends BeakrError {}

/**
 * 409. For a refused incremental conversation import, `expectedBaseIndex` is
 * the stored message count to resend from.
 */
export class ConflictError extends BeakrError {
  get expectedBaseIndex(): number | undefined {
    const body = this.body as Record<string, unknown> | undefined;
    for (const key of ["error", "detail"] as const) {
      const container = body?.[key] as Record<string, unknown> | undefined;
      const value = container?.["expected_base_index"];
      if (typeof value === "number" && Number.isInteger(value)) return value;
    }
    return undefined;
  }
}

/** 400 or 422: the request was malformed or failed validation. */
export class ValidationError extends BeakrError {}

/** 429. `retryAfter` is the server's hint in seconds, when it sent one. */
export class RateLimitError extends BeakrError {
  readonly retryAfter: number | undefined;
  constructor(message: string, options: BeakrErrorOptions & { retryAfter?: number } = {}) {
    super(message, options);
    this.retryAfter = options.retryAfter;
  }
}

/** 5xx. */
export class ServerError extends BeakrError {}

/**
 * A success whose body is an HTML page where the operation answers JSON. Most
 * often the base URL is not a Beakr API: a web app or a proxy answers 200 with
 * a page for any path. `status` is that status.
 */
export class UnexpectedResponseError extends BeakrError {}

/**
 * A Knowledge command or write answered HTTP 200 with `outcome.status ===
 * "error"` (an unknown page, a refused write). `result` keeps the full reply.
 */
/**
 * The Knowledge door answered 200 but reported `outcome.status: "error"`. It
 * carries the response's `status` and `requestId` like every other error, and
 * the door's own `outcome.error_code` (`invalid_arguments`, `unknown_command`,
 * `scope_not_found`, `citation_not_citeable`, ...) as `code` when it named one,
 * else `knowledge_command_error`.
 */
export class KnowledgeCommandError extends BeakrError {
  readonly result: Record<string, unknown>;
  constructor(
    message: string,
    result: Record<string, unknown>,
    options: Omit<BeakrErrorOptions, "body"> = {},
  ) {
    super(message, { code: "knowledge_command_error", ...options, body: result });
    this.result = result;
  }
}


const DEFAULT_CODES: Record<number, string> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  422: "validation_error",
  429: "rate_limited",
};

/**
 * Seconds to wait from a `Retry-After` header, or `undefined` when absent or
 * malformed.
 *
 * The header is either a number of seconds or an HTTP-date (RFC 9110 section
 * 10.2.3); a date becomes the seconds from `nowMs` (default: `Date.now()`)
 * until it. A date already past means "retry now" (`0`), never a negative
 * wait. A value that is neither is ignored, so the caller falls back to its own
 * backoff.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  nowMs: number = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const deadline = parseHttpDate(value, nowMs);
  return deadline === undefined ? undefined : Math.max(0, (deadline - nowMs) / 1000);
}

/** How much of a body that is not JSON an error message keeps. */
const EXCERPT_CHARS = 200;
const TITLE_CHARS = 80;
/**
 * A page's title is near its start: only this much of the body is searched,
 * and the pattern itself is bounded, so a huge body costs no more than a small one.
 */
const TITLE_SEARCH_CHARS = 4096;
const HTML_TITLE = /<title[^>]{0,200}>([\s\S]{0,500}?)<\/title>/i;
/** Control, format and other non-printable characters (an ANSI escape sequence). */
const NOT_PRINTABLE = /[\p{C}\p{Zl}\p{Zp}]/gu;
const HTML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'" };

/**
 * `text` as one short printable line. The text is the server's, and the
 * message reaches a terminal: non-printable characters are removed.
 */
function oneLine(text: string, limit: number): string {
  const line = text.split(/\s+/).filter(Boolean).join(" ").replace(NOT_PRINTABLE, "");
  return line.length <= limit ? line : `${line.slice(0, limit - 3).trimEnd()}...`;
}

/** Whether a body (with its `Content-Type`) is an HTML page. */
export function isHtmlPage(contentType: string | null | undefined, text: string): boolean {
  return (contentType ?? "").toLowerCase().includes("html") || text.trimStart().startsWith("<");
}

/**
 * The message and fix for an HTML page where a Beakr API answer was expected:
 * the base URL points somewhere else (or, for a 5xx, a proxy in front of the
 * API answered). The page itself is never the message: it is long, and it says
 * nothing about Beakr.
 */
function htmlPageReason(status: number, text: string): { reason: string; fix: string } {
  const title = HTML_TITLE.exec(text.slice(0, TITLE_SEARCH_CHARS))?.[1];
  const named = title
    ? oneLine(title.replace(/&(amp|lt|gt|quot|#39|apos);/g, (_, name: string) => HTML_ENTITIES[name] ?? ""), TITLE_CHARS)
    : "";
  const page = named ? `an HTML page ("${named}")` : "an HTML page";
  const fix =
    status >= 500
      ? "If the API URL (baseUrl, or BEAKR_BASE_URL) is right, a proxy in front of the API answered: retry shortly."
      : "Check the API URL (baseUrl, or BEAKR_BASE_URL): it must be a Beakr API, such as https://api.thebeakr.com.";
  return { reason: `The server answered with ${page}, not a Beakr API response`, fix };
}

/** The error for a success whose body is an HTML page where JSON was expected. */
export function unexpectedPageError(
  status: number,
  headers: Headers,
  text: string,
  baseUrl?: string,
): UnexpectedResponseError {
  const { reason, fix } = htmlPageReason(status, text);
  const options: BeakrErrorOptions = { status, code: "unexpected_response", body: text, fix };
  const requestId = headers.get("x-request-id");
  if (requestId) options.requestId = requestId;
  if (baseUrl !== undefined) options.baseUrl = baseUrl;
  const called = baseUrl ? ` (called ${shownUrl(baseUrl)})` : "";
  return new UnexpectedResponseError(`${reason}${called} To fix: ${fix}`, options);
}

/**
 * `baseUrl` as a message names it: scheme, host, port and path only. A base URL
 * can carry a user name and password (`https://user:pass@host`) or a token in
 * its query, and an error message is printed and logged.
 */
function shownUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return `${url.protocol}//${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return baseUrl;
  }
}

function detailMessage(detail: unknown): string | undefined {
  if (detail === undefined || detail === null) return undefined;
  if (typeof detail === "string") return detail;
  // FastAPI validation errors are a list of {loc, msg}; keep them readable.
  if (Array.isArray(detail)) {
    return detail
      .map((item) => {
        if (item && typeof item === "object" && "msg" in item) {
          const loc = Array.isArray((item as { loc?: unknown[] }).loc)
            ? ((item as { loc: unknown[] }).loc.filter((p) => p !== "body").join("."))
            : "";
          const msg = String((item as { msg: unknown }).msg);
          return loc ? `${loc}: ${msg}` : msg;
        }
        return String(item);
      })
      .join("; ");
  }
  return JSON.stringify(detail);
}

/**
 * Map a non-2xx response (status, headers, parsed body) to the matching error.
 * `nowMs` is the clock an HTTP-date `Retry-After` is measured from. `baseUrl`,
 * when given, is the API the request was sent to; the message ends with
 * `(called <baseUrl>)` and the error keeps it as `baseUrl`.
 */
export function errorFromResponse(
  status: number,
  headers: Headers,
  body: unknown,
  statusText = "",
  nowMs: number = Date.now(),
  baseUrl?: string,
): BeakrError {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
  const rawEnvelope = record?.["error"];
  const envelope =
    rawEnvelope && typeof rawEnvelope === "object" ? (rawEnvelope as Record<string, unknown>) : {};
  const detail = record ? record["detail"] : body;

  let code = (envelope["code"] as string | undefined) ?? DEFAULT_CODES[status];
  if (code === undefined && status >= 500) code = "internal_error";
  // Not JSON: an HTML page (a wrong base URL, a proxy) or bare text.
  const page = typeof body === "string" && isHtmlPage(headers.get("content-type"), body) ? htmlPageReason(status, body) : undefined;
  const text = typeof body === "string" && !page ? oneLine(body, EXCERPT_CHARS) : undefined;
  const reason =
    page?.reason ??
    text ??
    (envelope["message"] as string | undefined) ??
    detailMessage(detail) ??
    (statusText || `HTTP ${status}`);
  const rawDetailsForMessage = envelope["details"];
  const quota =
    rawDetailsForMessage && typeof rawDetailsForMessage === "object" && !Array.isArray(rawDetailsForMessage)
      ? quotaText(rawDetailsForMessage as Record<string, unknown>)
      : undefined;
  const fix =
    page?.fix ??
    (typeof envelope["fix"] === "string" && envelope["fix"] ? (envelope["fix"] as string) : undefined);
  let message = baseUrl ? `${reason} (called ${shownUrl(baseUrl)})` : reason;
  if (quota) message += ` (${quota})`;
  if (fix) message += ` To fix: ${fix}`;
  const requestId =
    (envelope["request_id"] as string | undefined) ?? headers.get("x-request-id") ?? undefined;
  const rawDetails = envelope["details"];
  const details =
    rawDetails && typeof rawDetails === "object" && !Array.isArray(rawDetails)
      ? (rawDetails as Record<string, unknown>)
      : {};
  const common: BeakrErrorOptions = { status, body, details };
  if (fix !== undefined) common.fix = fix;
  if (baseUrl !== undefined) common.baseUrl = baseUrl;
  if (code !== undefined) common.code = code;
  if (requestId !== undefined) common.requestId = requestId;

  if (status === 400 || status === 422) return new ValidationError(message, common);
  if (status === 401) return new AuthenticationError(message, common);
  if (status === 403) {
    const requiredScope =
      (details["required_scope"] as string | undefined) ??
      (envelope["required_scope"] as string | undefined);
    const Refusal = code === "person_review_required" ? PersonReviewRequiredError : PermissionDeniedError;
    return new Refusal(message, requiredScope === undefined ? common : { ...common, requiredScope });
  }
  if (status === 404) return new NotFoundError(message, common);
  if (status === 409) return new ConflictError(message, common);
  if (status === 429) {
    const retryAfter = parseRetryAfter(headers.get("retry-after"), nowMs);
    return new RateLimitError(message, retryAfter === undefined ? common : { ...common, retryAfter });
  }
  if (status >= 500) return new ServerError(message, common);
  return new BeakrError(message, common);
}
