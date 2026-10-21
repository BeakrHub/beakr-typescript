/**
 * Wait for Knowledge: a project's, or an upload batch's files' (Python's
 * `beakr_sdk/resources/knowledge_readiness.py`).
 *
 * A file reaches a project's Knowledge in the background after it is indexed.
 * These waits poll until nothing is queued or running and resolve to the last
 * answer, so a program can tell "ready" from "ready, but some files failed".
 * Failed files never end a wait early; they are in the answer, and
 * {@link KnowledgeFailedError} is thrown for them only with `raiseOnFailure`.
 */

import type { Transport } from "../core.js";
import type { JsonObject } from "../types.js";

export interface KnowledgeWaitOptions {
  /** First poll interval (default 5000 ms); each later wait is `backoff` times longer. */
  pollMs?: number;
  /** Longest wait between polls (default 30000 ms). */
  maxIntervalMs?: number;
  /** Growth factor per poll (default 1.5). */
  backoff?: number;
  /** Give up after this long (default 600000 ms). */
  timeoutMs?: number;
  /** Throw {@link KnowledgeFailedError} when the wait ends with failed files. */
  raiseOnFailure?: boolean;
  /** Called with each status read (to show progress). */
  onStatus?: (status: JsonObject) => void;
}

/** Knowledge was still queued or running when the wait gave up; `last` is the last answer. */
export class KnowledgeTimeoutError extends Error {
  constructor(
    what: string,
    readonly last: JsonObject,
  ) {
    const counts = countsOf(last);
    super(
      `Knowledge for ${what} is not ready: ${Number(counts["queued"] ?? 0)} queued, ` +
        `${Number(counts["running"] ?? 0)} running`,
    );
    this.name = "KnowledgeTimeoutError";
  }
}

/** Knowledge finished with failed files (thrown only with `raiseOnFailure`). */
export class KnowledgeFailedError extends Error {
  constructor(
    what: string,
    readonly status: JsonObject,
  ) {
    const failed = Number(countsOf(status)["failed"] ?? 0);
    super(`Knowledge for ${what} is ready, but ${failed} ${failed === 1 ? "file" : "files"} failed`);
    this.name = "KnowledgeFailedError";
  }
}

/** The queued/running/failed counts of a project status or a batch status (`knowledge`). */
function countsOf(answer: JsonObject): Record<string, unknown> {
  const knowledge = answer["knowledge"];
  return knowledge && typeof knowledge === "object" && !Array.isArray(knowledge)
    ? (knowledge as Record<string, unknown>)
    : answer;
}

function isReady(answer: JsonObject): boolean {
  const counts = countsOf(answer);
  if ("ready" in counts) return Boolean(counts["ready"]);
  return !(Number(counts["queued"] ?? 0) || Number(counts["running"] ?? 0));
}

/** Poll `read` until nothing is queued or running for Knowledge; resolve to its last answer. */
export async function waitForKnowledge<T extends JsonObject>(
  transport: Transport,
  what: string,
  read: () => Promise<T>,
  options: KnowledgeWaitOptions = {},
): Promise<T> {
  const backoff = options.backoff ?? 1.5;
  const maxInterval = options.maxIntervalMs ?? 30_000;
  let interval = options.pollMs ?? 5000;
  if (interval <= 0 || backoff < 1 || maxInterval < interval) {
    throw new RangeError("Need pollMs > 0, backoff >= 1 and maxIntervalMs >= pollMs.");
  }
  const deadline = Date.now() + (options.timeoutMs ?? 600_000);
  for (;;) {
    const answer = await read();
    options.onStatus?.(answer);
    if (isReady(answer)) {
      if (options.raiseOnFailure && Number(countsOf(answer)["failed"] ?? 0) > 0) {
        throw new KnowledgeFailedError(what, answer);
      }
      return answer;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new KnowledgeTimeoutError(what, answer);
    await transport.sleeper(Math.min(interval, remaining));
    interval = Math.min(maxInterval, interval * backoff);
  }
}

/** A file the upload duplicated: the batch rejected it and kept `duplicate_of`. */
export interface AlreadyUploaded extends JsonObject {
  path: string | null;
  artifact_id: string | null;
  duplicate_of: JsonObject & { artifact_id: string; title?: string | null };
  /** With `wait: "knowledge"`: the kept file's Knowledge status once it settled. */
  kept_knowledge_status?: string | null;
}

/**
 * The batch's duplicate files, and whether they are its only failures.
 *
 * Indexing does not store bytes already in the same place twice: it rejects the
 * new file as `duplicate` and keeps the existing one (`duplicate_of`). That is
 * "already uploaded", not a failure, so an upload whose only failed files are
 * duplicates reads `succeeded` (Python's `already_uploaded_outcome`). An engine
 * that counts them in `summary.duplicates` leaves them out of `summary.failed`;
 * an earlier one counted them there.
 */
export function alreadyUploadedOutcome(batchStatus: JsonObject): {
  duplicates: AlreadyUploaded[];
  status?: "succeeded";
} {
  const files = (batchStatus["artifacts"] as JsonObject[] | undefined) ?? [];
  const duplicates: AlreadyUploaded[] = [];
  for (const item of files) {
    const keptRef = item["duplicate_of"] as JsonObject | null | undefined;
    if (item["error_code"] !== "duplicate" || !keptRef || !keptRef["artifact_id"]) continue;
    duplicates.push({
      path: (item["path"] as string | undefined) ?? null,
      artifact_id: (item["id"] as string | undefined) ?? null,
      duplicate_of: { ...keptRef, artifact_id: String(keptRef["artifact_id"]) },
    });
  }
  const summary = (batchStatus["summary"] as JsonObject | undefined) ?? {};
  const failed = Number(summary["failed"] ?? 0);
  const othersFailed = "duplicates" in summary ? failed : failed - duplicates.length;
  return duplicates.length && othersFailed <= 0
    ? { duplicates, status: "succeeded" }
    : { duplicates };
}

/**
 * Poll each file (`GET /v1/artifacts/{id}`) until none is queued or running for
 * Knowledge; resolves to `{ [fileId]: knowledge_status }`. Used for the copy an
 * upload duplicated, which is not one of the batch's files.
 */
export async function waitForFilesKnowledge(
  transport: Transport,
  fileIds: string[],
  options: KnowledgeWaitOptions = {},
): Promise<Record<string, string | null>> {
  const statuses: Record<string, string | null> = {};
  await waitForKnowledge(
    transport,
    `${fileIds.length} kept file(s)`,
    async () => {
      for (const fileId of fileIds) {
        const artifact = await transport.request<JsonObject>({
          method: "GET",
          path: `/v1/artifacts/${encodeURIComponent(fileId)}`,
        });
        statuses[fileId] = (artifact["knowledge_status"] as string | null | undefined) ?? null;
      }
      const all = Object.values(statuses);
      const queued = all.filter((s) => s === "queued").length;
      const running = all.filter((s) => s === "running").length;
      return { queued, running, ready: queued + running === 0, files: { ...statuses } };
    },
    { ...options, raiseOnFailure: false, onStatus: undefined },
  );
  return statuses;
}
