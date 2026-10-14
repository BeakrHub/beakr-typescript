import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_BATCH_FILES } from "../src/index.js";
import { client, json, mockFetch } from "./helpers.js";

const S3 = "https://s3.example.test/bucket";
const path = (url: string) => url.replace("https://api.example.test", "");
const bytes = (text: string) => new TextEncoder().encode(text);

const prepared = (paths: string[]) =>
  json({
    batch_id: "b1",
    expires_at: "2026-10-12T13:00:00Z",
    folder_paths: [],
    uploads: paths.map((p) => ({ path: p, key: `k/${p}`, url: `${S3}/${p}?sig=1`, headers: {} })),
  });
const completion = () =>
  json({
  batch_id: "b1",
  artifacts: [{ id: "a1" }],
  folders: [],
  failed: [],
  indexing_task_id: null,
  job_id: "j1",
  status_url: "/v1/jobs/j1",
});
const stored = () => new Response(null, { status: 200 });

describe("uploads.uploadMany (/v1/bulk)", () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("sends entries as one batch, keeping their folders", async () => {
    const { fetch, calls } = mockFetch([
      prepared(["a.md", "sub/b.csv"]),
      stored(),
      stored(),
      completion(),
    ]);
    const { beakr } = client(fetch);
    const batch = await beakr.uploads.uploadMany(
      [
        { path: "sub/b.csv", data: bytes("x,y") },
        { path: "a.md", data: bytes("a") },
      ],
      { projectId: "p1", folderId: "f1" },
    );
    expect(batch.job_id).toBe("j1");
    expect(path(calls[0]!.url)).toBe("/v1/bulk/prepare");
    expect(calls[0]!.body).toMatchObject({
      target_project_id: "p1",
      parent_folder_id: "f1",
      files: [{ path: "a.md" }, { path: "sub/b.csv" }],
    });
    expect(calls[1]!.url).toBe(`${S3}/a.md?sig=1`);
    expect(calls[1]!.headers.authorization).toBeUndefined();
    expect(path(calls[3]!.url)).toBe("/v1/bulk/complete");
    expect(calls[3]!.body).toMatchObject({
      batch_id: "b1",
      ingest_to_wiki: true,
      files: [
        { path: "a.md", key: "k/a.md", title: "a.md" },
        { path: "sub/b.csv", key: "k/sub/b.csv", artifact_type: "dataset" },
      ],
    });
  });

  it("reads files and directories from disk and can wait for indexing", async () => {
    root = await mkdtemp(join(tmpdir(), "beakr-batch-"));
    await mkdir(join(root, "docs", "deep"), { recursive: true });
    await writeFile(join(root, "docs", "a.md"), "a");
    await writeFile(join(root, "docs", "deep", "b.md"), "b");
    await writeFile(join(root, "docs", ".env"), "secret");
    await writeFile(join(root, "notes.txt"), "n");
    const { fetch, calls } = mockFetch([
      prepared(["a.md", "deep/b.md", "notes.txt"]),
      stored(),
      stored(),
      stored(),
      completion(),
      json({ id: "j1", status: "succeeded" }),
    ]);
    const { beakr } = client(fetch);
    const batch = await beakr.uploads.uploadMany([join(root, "docs"), join(root, "notes.txt")], {
      projectId: "p1",
      wait: true,
    });
    expect((calls[0]!.body as { files: { path: string }[] }).files.map((f) => f.path)).toEqual([
      "a.md",
      "deep/b.md",
      "notes.txt",
    ]);
    expect(batch.job?.status).toBe("succeeded");
    // The batch is a job reference: jobs.wait takes it as is.
    expect(path(calls[5]!.url)).toBe("/v1/jobs/j1");
  });

  it("records where each file sat: a directory's name and a relative path's folders", async () => {
    root = await mkdtemp(join(tmpdir(), "beakr-batch-"));
    await mkdir(join(root, "docs", "deep"), { recursive: true });
    await mkdir(join(root, "deals"));
    await writeFile(join(root, "docs", "deep", "b.md"), "b");
    await writeFile(join(root, "deals", "memo.txt"), "m");
    const { fetch, calls } = mockFetch([prepared(["deep/b.md", "memo.txt"]), stored(), stored(), completion()]);
    const { beakr } = client(fetch);
    const previous = process.cwd();
    process.chdir(root);
    try {
      await beakr.uploads.uploadMany(["docs", "deals/memo.txt"], { projectId: "p1" });
    } finally {
      process.chdir(previous);
    }
    const files = (calls[3]!.body as { files: { path: string; relative_path?: string }[] }).files;
    expect(files.map((f) => [f.path, f.relative_path])).toEqual([
      ["deep/b.md", "docs/deep/b.md"],
      ["memo.txt", "deals/memo.txt"],
    ]);
  });

  it("refuses more files than one batch takes before sending anything", async () => {
    const { fetch, calls } = mockFetch([]);
    const { beakr } = client(fetch);
    const many = Array.from({ length: MAX_BATCH_FILES + 1 }, (_, i) => ({
      path: `f${i}.txt`,
      data: bytes("x"),
    }));
    await expect(beakr.uploads.uploadMany(many, { projectId: "p1" })).rejects.toThrow(RangeError);
    expect(calls).toEqual([]);
  });

  it("reads a batch's status", async () => {
    const { fetch, calls } = mockFetch([
      json({ batch_id: "b1", status: "indexing", artifacts: [], summary: {} }),
    ]);
    const { beakr } = client(fetch);
    expect((await beakr.uploads.batchStatus("b1")).status).toBe("indexing");
    expect(path(calls[0]!.url)).toBe("/v1/bulk/b1/status");
  });
});
