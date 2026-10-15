/**
 * Knowing when Knowledge is ready, what failed, and retrying it (Python's
 * `tests/test_knowledge_readiness.py`): `projects.knowledgeStatus`,
 * `waitUntilReady`, `knowledgeFailures`, `retryFailed`, and
 * `uploads.uploadMany({ wait: "knowledge" })`.
 */
import { describe, expect, it } from "vitest";
import { KnowledgeFailedError, KnowledgeTimeoutError } from "../src/index.js";
import { client, json, mockFetch } from "./helpers.js";

const path = (url: string) => new URL(url).pathname;
const failedFile = {
  artifact_id: "a1",
  filename: "memo.pdf",
  path: "deals/memo.pdf",
  error_code: "processing_failed",
  reason: "The file could not be read, so nothing from it was added to Knowledge.",
  failed_at: "2026-10-14T12:00:00Z",
  retryable: true,
};
const status = (queued = 0, running = 0, failed = 0) =>
  json({
    total: 3,
    eligible: failed,
    syncing: queued + running,
    synced: 3 - failed - queued - running,
    knowledge_skipped: 0,
    oldest_pending_at: null,
    queued,
    running,
    failed,
    ready: queued + running === 0,
    failed_files: Array.from({ length: failed }, () => failedFile),
    failed_files_next_cursor: null,
  });

describe("project Knowledge readiness", () => {
  it("reads the status", async () => {
    const { fetch, calls } = mockFetch([status(0, 1, 1)]);
    const { beakr } = client(fetch);
    const read = await beakr.projects.knowledgeStatus("p1", { failedLimit: 5 });
    expect([read.ready, read.failed]).toEqual([false, 1]);
    expect(path(calls[0]!.url)).toBe("/v1/projects/p1/knowledge-summary");
    expect(new URL(calls[0]!.url).searchParams.get("failed_limit")).toBe("5");
  });

  it("waits until nothing is queued or running, keeping failures in the answer", async () => {
    const { fetch } = mockFetch([status(2), status(0, 1), status(0, 0, 1)]);
    const { beakr, sleeps } = client(fetch);
    const done = await beakr.projects.waitUntilReady("p1", { pollMs: 2000, maxIntervalMs: 10_000 });
    expect(done.ready).toBe(true);
    expect(done.failed_files?.[0]?.error_code).toBe("processing_failed");
    expect(sleeps).toEqual([2000, 3000]);
  });

  it("reports each status it reads", async () => {
    const { fetch } = mockFetch([status(1), status()]);
    const { beakr } = client(fetch);
    const seen: unknown[] = [];
    await beakr.projects.waitUntilReady("p1", { onStatus: (s) => seen.push(s["queued"]) });
    expect(seen).toEqual([1, 0]);
  });

  it("throws for failures only when asked", async () => {
    const { fetch } = mockFetch([status(0, 0, 2), status(0, 0, 2)]);
    const { beakr } = client(fetch);
    expect((await beakr.projects.waitUntilReady("p1")).failed).toBe(2);
    const error = await beakr.projects
      .waitUntilReady("p1", { raiseOnFailure: true })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KnowledgeFailedError);
    expect((error as KnowledgeFailedError).message).toContain("2 files failed");
  });

  it("gives up with the last status", async () => {
    const { fetch } = mockFetch([status(4)]);
    const { beakr } = client(fetch);
    const error = await beakr.projects
      .waitUntilReady("p1", { timeoutMs: 0 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KnowledgeTimeoutError);
    expect((error as KnowledgeTimeoutError).last["queued"]).toBe(4);
  });

  it("retries every failed file, or the ones named", async () => {
    const answer = () => json({ queued: 1, files: [{ artifact_id: "a1", outcome: "queued" }] });
    const { fetch, calls } = mockFetch([answer(), answer()]);
    const { beakr } = client(fetch);
    await beakr.projects.retryFailed("p1");
    expect(calls[0]!.method).toBe("POST");
    expect(path(calls[0]!.url)).toBe("/v1/projects/p1/knowledge/retry-failed");
    expect(calls[0]!.body).toEqual({});
    await beakr.projects.retryFailed("p1", ["a1", "a2"]);
    expect(calls[1]!.body).toEqual({ artifact_ids: ["a1", "a2"] });
  });

  it("lists every failed file across pages", async () => {
    const { fetch, calls } = mockFetch([
      json({ data: [failedFile], next_cursor: "c2", has_more: true }),
      json({ data: [failedFile], next_cursor: null, has_more: false }),
    ]);
    const { beakr } = client(fetch);
    expect(await beakr.projects.knowledgeFailures("p1")).toHaveLength(2);
    expect(path(calls[1]!.url)).toBe("/v1/projects/p1/knowledge/failed-files");
    expect(new URL(calls[1]!.url).searchParams.get("cursor")).toBe("c2");
  });
});

describe("uploads.uploadMany({ wait: 'knowledge' })", () => {
  const S3 = "https://s3.example.test/bucket";
  const batchStatus = (knowledge: Record<string, unknown>) =>
    json({
      batch_id: "b1",
      status: "completed",
      artifacts: [{ id: "a1", path: "a.md", title: "a.md", status: "indexed" }],
      summary: { total: 1, indexed: 1 },
      knowledge,
    });
  const upload = () => [
    json({
      batch_id: "b1",
      expires_at: "2026-10-14T13:00:00Z",
      folder_paths: [],
      uploads: [{ path: "a.md", key: "k/a.md", url: `${S3}/a.md?sig=1`, headers: {} }],
    }),
    new Response(null, { status: 200 }),
    json({
      batch_id: "b1",
      artifacts: [{ id: "a1" }],
      folders: [],
      failed: [],
      job_id: "j1",
      status_url: "/v1/jobs/j1",
    }),
    json({ job_id: "j1", status: "succeeded" }),
  ];

  it("waits for the batch's indexing, then for its files' Knowledge", async () => {
    const { fetch, calls } = mockFetch([
      ...upload(),
      batchStatus({ queued: 1, running: 0, failed: 0, ready: false }),
      batchStatus({ queued: 0, running: 0, failed: 1, ready: true }),
    ]);
    const { beakr, sleeps } = client(fetch);
    const result = await beakr.uploads.uploadMany([{ path: "a.md", data: new Uint8Array([97]) }], {
      projectId: "p1",
      wait: "knowledge",
      knowledgeWait: { pollMs: 1000 },
    });
    expect(result.job?.status).toBe("succeeded");
    expect((result.batch?.["knowledge"] as { failed: number }).failed).toBe(1);
    expect(path(calls[4]!.url)).toBe("/v1/bulk/b1/status");
    expect(sleeps).toEqual([1000]);
  });

  it("refuses a Knowledge wait for files kept out of Knowledge", async () => {
    const { fetch } = mockFetch([]);
    const { beakr } = client(fetch);
    await expect(
      beakr.uploads.uploadMany([{ path: "a.md", data: new Uint8Array([97]) }], {
        projectId: "p1",
        ingest: false,
        wait: "knowledge",
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

/**
 * An upload whose bytes are already there. Indexing does not store them twice:
 * it rejects the new file as `duplicate` and keeps the existing one, and the
 * batch job reads `failed`. The upload did what was asked, so `status` reads
 * `succeeded`, the duplicate names the kept file, and a Knowledge wait waits for it.
 */
describe("uploads.uploadMany with a duplicate file", () => {
  const S3 = "https://s3.example.test/bucket";
  const upload = () => [
    json({
      batch_id: "b1",
      expires_at: "2026-10-14T13:00:00Z",
      folder_paths: [],
      uploads: [{ path: "a.md", key: "k/a.md", url: `${S3}/a.md?sig=1`, headers: {} }],
    }),
    new Response(null, { status: 200 }),
    json({
      batch_id: "b1",
      artifacts: [{ id: "a1" }],
      folders: [],
      failed: [],
      job_id: "j1",
      status_url: "/v1/jobs/j1",
    }),
    json({
      job_id: "j1",
      status: "failed",
      error: { code: "upload_failed", message: "Some files failed." },
    }),
  ];
  const duplicateBatch = (alsoFailed = 0) =>
    json({
      batch_id: "b1",
      status: "completed",
      artifacts: [
        {
          id: "a1",
          path: "a.md",
          title: "a.md",
          status: "index_failed",
          error_code: "duplicate",
          error: "This file has already been uploaded",
          duplicate_of: { artifact_id: "kept1", title: "a.md" },
        },
      ],
      summary: { total: 1, failed: 1 + alsoFailed },
      knowledge: { queued: 0, running: 0, failed: 0, ready: true },
    });
  const files = [{ path: "a.md", data: new Uint8Array([97]) }];

  it("reports it as already uploaded and waits for the kept file's Knowledge", async () => {
    const { fetch, calls } = mockFetch([
      ...upload(),
      duplicateBatch(),
      duplicateBatch(),
      json({ id: "kept1", knowledge_status: "running" }),
      json({ id: "kept1", knowledge_status: "created" }),
    ]);
    const { beakr, sleeps } = client(fetch);
    const result = await beakr.uploads.uploadMany(files, {
      projectId: "p1",
      wait: "knowledge",
      knowledgeWait: { pollMs: 1000 },
    });
    expect(result.job?.status).toBe("failed");
    expect(result.status).toBe("succeeded");
    expect(result.duplicates).toEqual([
      {
        path: "a.md",
        artifact_id: "a1",
        duplicate_of: { artifact_id: "kept1", title: "a.md" },
        kept_knowledge_status: "created",
      },
    ]);
    expect(path(calls.at(-1)!.url)).toBe("/v1/artifacts/kept1");
    expect(sleeps).toEqual([1000]);
  });

  it("keeps a real failure beside a duplicate failed", async () => {
    const { fetch } = mockFetch([...upload(), duplicateBatch(1)]);
    const { beakr } = client(fetch);
    const result = await beakr.uploads.uploadMany(files, { projectId: "p1", wait: true });
    expect(result.status).toBe("failed");
    expect(result.duplicates).toHaveLength(1);
  });
});
