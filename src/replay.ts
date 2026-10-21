/**
 * Which documented creates replay a resend that carries the same `Idempotency-Key`.
 *
 * The engine guarantees (developer platform W1.2) that a create retried with
 * the same key and body yields exactly one resource and the original response,
 * even when the first attempt failed after committing. Its test
 * `tests/api/test_public_create_idempotency.py` classifies every public POST as
 * a keyed create or as a POST that is not a create; only the keyed creates of
 * the documented contract are listed here, as this package sends no other
 * route. The Python SDK (beakr-python) carries the same list
 * (`beakr_sdk/_replay.py`), and its `tests/test_replaying_creates.py` compares
 * both with the engine.
 *
 * A POST that is not listed (a decision such as `accept`, a token exchange, a
 * read with a body) is not resent after an ambiguous failure: some are refused
 * on a repeat, and a token refresh resent with the same refresh token is
 * treated as theft and revokes the session.
 *
 * The public contract does not yet mark these operations, so the list is
 * curated from the engine's classification rather than generated.
 */

/** POST path templates whose handler replays a keyed resend (canonical paths and their aliases). */
export const REPLAYING_CREATES: readonly string[] = [
  "/v1/bulk/complete",
  "/v1/conversations/import",
  "/v1/folders",
  "/v1/interview/links",
  "/v1/interview/sendables",
  "/v1/interview/sendables/{sendable_id}/links",
  "/v1/knowledge/wiki/write",
  "/v1/labels",
  "/v1/labels/{label_id}/members",
  "/v1/labels/{label_id}/projects",
  "/v1/me/api-keys",
  "/v1/organizations/{org_id}/external-users",
  "/v1/organizations/{org_id}/members",
  "/v1/organizations/{org_id}/service-accounts",
  "/v1/organizations/{org_id}/service-accounts/{account_id}/keys",
  "/v1/projects",
  "/v1/projects/{project_id}/invite",
  "/v1/projects/{project_id}/members",
  "/v1/runs",
  "/v1/skills",
  "/v1/uploads",
  "/v1/uploads/{upload_id}/complete",
];

/**
 * Conflict codes a keyed create answers while an earlier attempt with the same
 * key still holds the claim (or was taken over). Both mean "retry to receive
 * the result" and carry `Retry-After`.
 */
export const IDEMPOTENCY_RETRY_CODES: ReadonlySet<string> = new Set([
  "idempotency_in_progress",
  "idempotency_superseded",
]);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PATTERNS = REPLAYING_CREATES.map(
  (template) => new RegExp(`^${template.split(/\{[^}]+\}/).map(escapeRegExp).join("[^/]+")}/?$`),
);

/** Whether a keyed `method path` (a concrete path, no query) replays a resend. */
export function replaysIdempotencyKey(method: string, path: string): boolean {
  if (method.toUpperCase() !== "POST") return false;
  const bare = path.split("?", 1)[0]!;
  return PATTERNS.some((pattern) => pattern.test(bare));
}
