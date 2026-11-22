/**
 * Stopping queued Knowledge work (ENG-2451; Python's `tests/test_cancels.py`):
 * `knowledge.compileQueue`, `knowledge.cancelQueuedCompiles` and
 * `integrations.cancelSourceSync`.
 */
import { describe, expect, it } from "vitest";
import { ConflictError } from "../src/index.js";
import { client, json, mockFetch } from "./helpers.js";

const path = (url: string) => new URL(url).pathname;
const query = (url: string) => Object.fromEntries(new URL(url).searchParams);
const queue = {
  queued: 12,
  running: 2,
  last_cancel: {
    cancel_id: "c1",
    status: "cancelling",
    done: 12,
    total: 40,
    summary: "Cancelling: 12 of 40 queued compiles skipped",
    cancelled_by: "Dana",
    cancelled_at: "2026-11-21T12:00:00Z",
  },
};
const cancelled = {
  cancel_id: "c1",
  scope: "source",
  status: "cancelling",
  will_be_skipped: 40,
  already_running: 2,
  sync_stopped: true,
  syncs_stopped: 1,
  sync_job_id: "j1",
  next_sync: "This source does not sync automatically.",
  note: "Finished work is kept.",
};
const syncCancelled = {
  sync_job_id: "j1",
  status: "cancelling",
  cancelled_by: "Dana",
  next_sync: "This source does not sync automatically.",
  note: "Items already synced are kept.",
};

describe("compile queue and cancels", () => {
  it("reads the queue of a project, a source or a file", async () => {
    const { fetch, calls } = mockFetch([json(queue), json(queue), json(queue)]);
    const { beakr } = client(fetch);
    expect(await beakr.knowledge.compileQueue("p1")).toEqual(queue);
    await beakr.knowledge.compileQueue("p1", { attachmentId: "s1" });
    await beakr.knowledge.compileQueue("p1", { artifactId: "f1" });
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "GET"]);
    expect(path(calls[0]!.url)).toBe("/v1/projects/p1/knowledge/compiles");
    expect(query(calls[0]!.url)).toEqual({});
    expect(query(calls[1]!.url)).toEqual({ attachment_id: "s1" });
    expect(query(calls[2]!.url)).toEqual({ artifact_id: "f1" });
  });

  it("cancels queued compiles, sending only the source given", async () => {
    const { fetch, calls } = mockFetch([json(cancelled, 202), json(cancelled, 202), json(cancelled, 202)]);
    const { beakr } = client(fetch);
    expect(await beakr.knowledge.cancelQueuedCompiles("p1")).toEqual(cancelled);
    await beakr.knowledge.cancelQueuedCompiles("p1", { attachmentId: "s1" });
    await beakr.knowledge.cancelQueuedCompiles("p1", { artifactId: "f1" });
    expect(path(calls[0]!.url)).toBe("/v1/projects/p1/knowledge/compiles/cancel");
    expect(calls[0]!.method).toBe("POST");
    expect(calls.map((c) => c.body)).toEqual([{}, { attachment_id: "s1" }, { artifact_id: "f1" }]);
  });

  it("cancels a source's running sync", async () => {
    const { fetch, calls } = mockFetch([json(syncCancelled)]);
    const { beakr } = client(fetch);
    expect(await beakr.integrations.cancelSourceSync("p1", "s1")).toEqual(syncCancelled);
    expect(calls[0]!.method).toBe("POST");
    expect(path(calls[0]!.url)).toBe("/v1/projects/p1/sources/s1/sync/cancel");
  });

  it("encodes each id as one path segment", async () => {
    const { fetch, calls } = mockFetch([json(syncCancelled)]);
    const { beakr } = client(fetch);
    await beakr.integrations.cancelSourceSync("p/1", "s/1");
    expect(new URL(calls[0]!.url).pathname).toBe("/v1/projects/p%2F1/sources/s%2F1/sync/cancel");
  });

  it("reads nothing running as a conflict with its code", async () => {
    const { fetch } = mockFetch([
      json({ error: { code: "no_running_sync", message: "No sync is running." } }, 409),
    ]);
    const { beakr } = client(fetch);
    const failure = await beakr.integrations.cancelSourceSync("p1", "s1").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ConflictError);
    expect((failure as ConflictError).code).toBe("no_running_sync");
  });
});
