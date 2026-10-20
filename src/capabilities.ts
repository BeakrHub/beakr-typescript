/**
 * Which documented operations one Beakr server serves.
 *
 * Not every Beakr installation serves the whole documented contract: a
 * self-hosted installation leaves out the hosted organization administration,
 * embedded-mode and integration routes, and answers a bare 404 for them. Every
 * server describes the operations it actually serves in its own public OpenAPI
 * document (`GET /v1/public/openapi.json`), built from the routes it runs, so a
 * client can tell "this installation does not provide that" apart from "that
 * record does not exist" without trying the call.
 *
 * {@link Capabilities} reads that document. `beakr.meta.capabilities()` fetches
 * it once per base URL and keeps it for {@link CAPABILITIES_TTL_MS}. A server
 * that publishes no document (an older release) is assumed to serve
 * everything, so the helper can only ever narrow what a client offers, never
 * invent a refusal.
 */
import { BeakrError } from "./errors.js";
import { OPERATIONS } from "./generated/operations.js";

/**
 * How long a fetched document is trusted before it is read again. Short: an
 * installation that is upgraded in place gains routes without a client restart.
 */
export const CAPABILITIES_TTL_MS = 300_000;

const METHODS = ["get", "post", "put", "patch", "delete"] as const;
const PARAMETER = /\{[^{}/]+\}/;

type OperationIndex = Map<string, RegExp[]>;

/** A contract path as a regex: each `{parameter}` matches one path segment. */
function pattern(template: string): RegExp {
  const parts = template.split(PARAMETER).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${parts.join("[^/]+")}$`);
}

/** `path` without a query string, fragment or trailing slash (`/v1/projects/`). */
function normalize(path: string): string {
  const bare = path.split("?", 1)[0]!.split("#", 1)[0]!;
  return bare.replace(/\/+$/, "") || "/";
}

function indexOf(operations: Iterable<readonly [string, string]>): OperationIndex {
  const index: OperationIndex = new Map();
  for (const [method, template] of operations) {
    const key = method.toUpperCase();
    const patterns = index.get(key) ?? [];
    patterns.push(pattern(normalize(template)));
    index.set(key, patterns);
  }
  return index;
}

function matches(index: OperationIndex, method: string, path: string): boolean {
  const bare = normalize(path);
  return (index.get(method.toUpperCase()) ?? []).some((p) => p.test(bare));
}

/** Every operation of the documented contract this SDK was generated from. */
const CONTRACT = indexOf(Object.values(OPERATIONS).map((op) => [op.method, op.path] as const));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function documentOperations(document: unknown): [string, string][] {
  if (!isRecord(document) || !isRecord(document["paths"])) return [];
  const operations: [string, string][] = [];
  for (const [path, item] of Object.entries(document["paths"])) {
    if (!isRecord(item)) continue;
    for (const method of METHODS) if (method in item) operations.push([method.toUpperCase(), path]);
  }
  return operations;
}

/**
 * The documented operations one server serves, read from its OpenAPI document.
 *
 * Get one with `beakr.meta.capabilities()`. `serves` takes a concrete path
 * (`/v1/organizations/<id>/members`) or a contract template
 * (`/v1/organizations/{org_id}/members`).
 */
export class Capabilities {
  /** Whether the server published a document. Without one every operation is assumed served. */
  readonly documented: boolean;
  private readonly served: OperationIndex;

  constructor(document: unknown) {
    const operations = documentOperations(document);
    this.documented = operations.length > 0;
    this.served = indexOf(operations);
  }

  /** For a server that publishes no document: everything is assumed served. */
  static unknown(): Capabilities {
    return new Capabilities(null);
  }

  /**
   * Whether this server serves `method path`.
   *
   * `false` only when the server published its document and the operation is
   * part of the documented contract but missing from it. A route outside the
   * documented contract cannot be judged from the document and is assumed
   * served, as is everything on a server without a document.
   */
  serves(method: string, path: string): boolean {
    if (!this.documented) return true;
    if (matches(this.served, method, path)) return true;
    return !matches(CONTRACT, method, path);
  }

  /** The `[method, path]` pairs of `operations` this server does not serve. */
  unserved(operations: Iterable<readonly [string, string]>): [string, string][] {
    const missing: [string, string][] = [];
    for (const [method, path] of operations) if (!this.serves(method, path)) missing.push([method, path]);
    return missing;
  }
}

interface CacheEntry {
  at: number;
  capabilities: Promise<Capabilities>;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "").toLowerCase();
}

/** Drop the cached document for `baseUrl`, or for every server. */
export function forgetCapabilities(baseUrl?: string): void {
  if (baseUrl === undefined) cache.clear();
  else cache.delete(cacheKey(baseUrl));
}

/**
 * `baseUrl`'s {@link Capabilities}, fetched with `fetchDocument` at most once per
 * TTL. Concurrent callers share one fetch. Any failure to read the document (no
 * such route on an older server, the server unreachable) is cached as
 * {@link Capabilities.unknown} for the same TTL, so a client asking before every
 * call does not retry a fetch that cannot succeed.
 */
export function cachedCapabilities(
  baseUrl: string,
  fetchDocument: () => Promise<unknown>,
  options: { refresh?: boolean } = {},
): Promise<Capabilities> {
  const key = cacheKey(baseUrl);
  const cached = cache.get(key);
  if (cached && !options.refresh && Date.now() - cached.at < CAPABILITIES_TTL_MS) return cached.capabilities;
  const entry: CacheEntry = {
    at: Date.now(),
    capabilities: fetchDocument().then(
      (document) => new Capabilities(document),
      (error: unknown) => {
        if (error instanceof BeakrError) return Capabilities.unknown();
        // Not a server answer (a bug, an abort): forget it so the next call tries again.
        if (cache.get(key) === entry) cache.delete(key);
        throw error;
      },
    ),
  };
  cache.set(key, entry);
  // The TTL runs from when the document arrived, not from when it was asked for.
  void entry.capabilities.then(
    () => {
      entry.at = Date.now();
    },
    () => undefined,
  );
  return entry.capabilities;
}
