import type { JsonObject } from "../types.js";
import { Resource, enc } from "./base.js";

/**
 * One long operation (`GET /v1/jobs/{job_id}`): an agent or workflow run, a
 * project import, an integration sync, a webpage import, a Knowledge compile or
 * a bulk upload, all in one shape.
 */
export interface Job extends JsonObject {
  job_id: string;
  kind: string;
  /** `queued`, `running`, `succeeded`, `failed` or `cancelled`. */
  status: string;
  native_status: string | null;
  progress: { done: number; total: number | null } | null;
  result: JsonObject | null;
  error: { code: string; message: string | null } | null;
  project_id: string | null;
  created_at: string | null;
  finished_at: string | null;
  status_url: string;
  resource_url: string;
}

/** Anything that names a job: its id, or a response carrying `job_id`. */
export type JobReference = string | { job_id?: unknown };

export interface JobWaitOptions {
  /** First poll interval (default 1000 ms); each later wait is `backoff` times longer. */
  intervalMs?: number;
  /** Longest wait between polls (default 15000 ms). */
  maxIntervalMs?: number;
  /** Growth factor per poll (default 1.5). */
  backoff?: number;
  /** Give up after this long (default 600000 ms). */
  timeoutMs?: number;
  /** Throw {@link JobFailedError} for a `failed` or `cancelled` job. */
  raiseOnFailure?: boolean;
}

/** Job states that will not change again. */
export const TERMINAL_JOB_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

export class JobTimeoutError extends Error {
  constructor(
    readonly jobId: string,
    readonly last: Job,
  ) {
    super(`Job ${jobId} is still ${JSON.stringify(last.status)}`);
    this.name = "JobTimeoutError";
  }
}

export class JobFailedError extends Error {
  constructor(readonly job: Job) {
    super(`Job ${job.job_id} ${job.status}: ${job.error?.message ?? job.error?.code ?? job.status}`);
    this.name = "JobFailedError";
  }
}

export function jobIdOf(job: JobReference): string {
  if (typeof job === "string") return job;
  if (job && typeof job.job_id === "string" && job.job_id) return job.job_id;
  throw new TypeError("This response does not reference a job (no job_id).");
}

/** Long operations: read one, or wait for it with backoff. */
export class Jobs extends Resource {
  get(job: JobReference): Promise<Job> {
    return this.transport.request({ method: "GET", path: `/v1/jobs/${enc(jobIdOf(job))}` });
  }

  /** Poll until the job is final and return it; throws {@link JobTimeoutError} at the timeout. */
  async wait(job: JobReference, options: JobWaitOptions = {}): Promise<Job> {
    const backoff = options.backoff ?? 1.5;
    const maxInterval = options.maxIntervalMs ?? 15_000;
    let interval = options.intervalMs ?? 1000;
    if (interval <= 0 || backoff < 1 || maxInterval < interval) {
      throw new RangeError("Need intervalMs > 0, backoff >= 1 and maxIntervalMs >= intervalMs.");
    }
    const jobId = jobIdOf(job);
    const deadline = Date.now() + (options.timeoutMs ?? 600_000);
    for (;;) {
      const state = await this.get(jobId);
      if (TERMINAL_JOB_STATUSES.has(state.status)) {
        if (options.raiseOnFailure && state.status !== "succeeded") throw new JobFailedError(state);
        return state;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new JobTimeoutError(jobId, state);
      await this.transport.sleeper(Math.min(interval, remaining));
      interval = Math.min(maxInterval, interval * backoff);
    }
  }
}
