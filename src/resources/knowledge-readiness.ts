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
