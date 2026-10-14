/**
 * W1.2.7: every long operation is a job; `beakr.wait(job)` polls
 * `GET /v1/jobs/{id}` with backoff until it is final.
 */
import { describe, expect, it } from "vitest";
import { JobFailedError, JobTimeoutError, jobIdOf } from "../src/index.js";
import { client, json, mockFetch } from "./helpers.js";

const state = (status: string) => json({ job_id: "j1", status });

describe("jobs", () => {
  it("reads one job", async () => {
    const { fetch, calls } = mockFetch([state("running")]);
    const { beakr } = client(fetch);
    expect((await beakr.jobs.get("j1")).status).toBe("running");
    expect(new URL(calls[0]!.url).pathname).toBe("/v1/jobs/j1");
  });

  it("waits with backoff up to its ceiling", async () => {
    const { fetch } = mockFetch([
      state("queued"),
      state("running"),
      state("running"),
      state("running"),
      state("succeeded"),
    ]);
    const { beakr, sleeps } = client(fetch);
    const done = await beakr.wait({ job_id: "j1" }, { intervalMs: 100, maxIntervalMs: 300 });
    expect(done.status).toBe("succeeded");
    expect(sleeps).toEqual([100, 150, 225, 300]);
  });

  it("returns a failed job, or throws when asked", async () => {
    const { fetch } = mockFetch([state("failed"), state("failed")]);
    const { beakr } = client(fetch);
    expect((await beakr.jobs.wait("j1")).status).toBe("failed");
    await expect(beakr.jobs.wait("j1", { raiseOnFailure: true })).rejects.toBeInstanceOf(
      JobFailedError,
    );
  });

  it("gives up with the last state", async () => {
    const { fetch } = mockFetch([state("running")]);
    const { beakr } = client(fetch);
    const error = await beakr.jobs.wait("j1", { timeoutMs: 0 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobTimeoutError);
    expect((error as JobTimeoutError).last.status).toBe("running");
  });

  it("takes a job id or any response carrying one", () => {
    expect(jobIdOf("j1")).toBe("j1");
    expect(jobIdOf({ job_id: "r1" })).toBe("r1");
    expect(() => jobIdOf({})).toThrow(TypeError);
  });
});
