import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MULTIPART_THRESHOLD, UploadInterruptedError } from "../src/index.js";
import { client, json, mockFetch, type Recorded } from "./helpers.js";

const path = (url: string) => url.replace("https://api.example.test", "");
const S3 = "https://s3.example.test/bucket";

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: "u1",
    status: "open",
    project_id: "p1",
    path: "big.bin",
    content_length: 25,
    part_size: 10,
    part_count: 3,
    ingest_to_wiki: true,
    uploaded_parts: [],
    ...overrides,
  };
}

const presigned = (numbers: number[]) =>
  json({ upload_id: "u1", parts: numbers.map((n) => ({ part_number: n, url: `${S3}/u1?partNumber=${n}&sig=x` })) });

const etag = (n: number) => () => new Response(null, { status: 200, headers: { etag: `"e${n}"` } });

const completed = json({
  upload: session({ status: "completed" }),
  artifact: { id: "a1", version_id: "v1", job_id: "j1" },
  job_id: "j1",
  status_url: "/v1/jobs/j1",
  batch_status_url: "/v1/bulk/u1/status",
});

async function partBytes(call: Recorded): Promise<number[]> {
  return Array.from(new Uint8Array(await (call.body as Blob).arrayBuffer()));
}

describe("uploads", () => {
  it("resumes from the parts storage holds and sends the rest without a credential", async () => {
    const { fetch, calls } = mockFetch([
      json(session({ uploaded_parts: [{ part_number: 1, size: 10, etag: '"held"' }] })),
      presigned([2, 3]),
      etag(2),
      etag(3),
      completed,
    ]);
    const { beakr } = client(fetch);
    const bytes = new Uint8Array(25).map((_, i) => i);
    const done = await beakr.uploads.resume("u1", bytes, { title: "Big" });
    expect(done.job_id).toBe("j1");
    expect(path(calls[1]!.url)).toBe("/v1/uploads/u1/parts");
    expect(calls[1]!.body).toEqual({ part_numbers: [2, 3] });
    expect(calls[2]!.url).toBe(`${S3}/u1?partNumber=2&sig=x`);
    expect(calls[2]!.headers.authorization).toBeUndefined();
    expect(await partBytes(calls[2]!)).toEqual(Array.from({ length: 10 }, (_, i) => i + 10));
    expect(await partBytes(calls[3]!)).toEqual([20, 21, 22, 23, 24]);
    expect(calls[4]!.body).toEqual({
      parts: [
        { part_number: 1, etag: '"held"' },
        { part_number: 2, etag: '"e2"' },
        { part_number: 3, etag: '"e3"' },
      ],
      title: "Big",
    });
    expect(calls[4]!.headers["idempotency-key"]).toBeTruthy();
  });

  it("names the upload to resume when the connection drops", async () => {
    const { fetch } = mockFetch([json(session()), presigned([1, 2, 3]), new TypeError("reset")]);
    const { beakr } = client(fetch, { maxRetries: 0 });
    const error = await beakr.uploads.resume("u1", new Uint8Array(25)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UploadInterruptedError);
    expect((error as UploadInterruptedError).uploadId).toBe("u1");
  });

  it("does not report a refusal resuming cannot fix as an interruption", async () => {
    const { fetch } = mockFetch([
      json(session({ part_count: 1, part_size: 25 })),
      presigned([1]),
      etag(1),
      json({ error: { code: "size_mismatch", message: "wrong size" } }, 422),
    ]);
    const { beakr } = client(fetch);
    const error = await beakr.uploads.resume("u1", new Uint8Array(25)).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(UploadInterruptedError);
  });

  it("sends a small file as a one-part resumable upload whose PUT keeps its signed query string", async () => {
    // Root cause: small files went through presigned-url, POST /v1/artifacts and
    // versions, which are not in the documented contract.
    const one = session({ content_length: 5, part_size: 5 * 1024 * 1024, part_count: 1 });
    const { fetch, calls } = mockFetch([
      json(one, 201),
      json(one),
      json({ upload_id: "u1", parts: [{ part_number: 1, url: `${S3}/u1?X-Amz-Signature=abc` }] }),
      new Response(null, { status: 200, headers: { etag: '"e1"' } }),
      json({ upload: one, artifact: { id: "a1" }, job_id: "j1", status_url: "/v1/jobs/j1" }),
    ]);
    const { beakr } = client(fetch);
    const result = await beakr.uploads.upload(new TextEncoder().encode("hello"), {
      projectId: "p1",
      path: "notes/hello.txt",
      folderId: "f1",
      contentType: "text/plain",
      ingest: false,
    });
    expect((result.artifact as { id: string }).id).toBe("a1");
    expect(path(calls[0]!.url)).toBe("/v1/uploads");
    expect(calls[0]!.body).toMatchObject({
      target_project_id: "p1",
      parent_folder_id: "f1",
      ingest_to_wiki: false,
      content_hash: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    });
    expect(calls[3]!.url).toBe(`${S3}/u1?X-Amz-Signature=abc`);
    expect(calls[3]!.headers.authorization).toBeUndefined();
    expect(calls.some((c) => c.url.includes("presigned-url") || path(c.url) === "/v1/artifacts")).toBe(false);
  });

  it("refuses an empty file before sending anything", async () => {
    const { fetch, calls } = mockFetch([]);
    const { beakr } = client(fetch);
    await expect(
      beakr.uploads.upload(new Uint8Array(0), { projectId: "p1", path: "empty.txt" }),
    ).rejects.toThrow(/empty/);
    expect(calls).toEqual([]);
  });

  it("starts a multipart upload above the threshold, declaring the file's hash", async () => {
    const data = new Uint8Array(MULTIPART_THRESHOLD + 1);
    data[0] = 7;
    data[data.length - 1] = 9;
    const big = new Blob([data]);
    const expected = createHash("sha256").update(data).digest("hex");
    const { fetch, calls } = mockFetch([json(session({ id: "u2" }), 201), new Error("stop here")]);
    const { beakr } = client(fetch, { maxRetries: 0 });
    await beakr.uploads.upload(big, { projectId: "p1", path: "big.bin", ingest: false }).catch(() => undefined);
    expect(path(calls[0]!.url)).toBe("/v1/uploads");
    // Python's multipart flow sends content_hash (sha256 of the whole file) too.
    expect(calls[0]!.body).toEqual({
      target_project_id: "p1",
      path: "big.bin",
      content_type: "application/octet-stream",
      content_length: MULTIPART_THRESHOLD + 1,
      content_hash: expected,
      ingest_to_wiki: false,
    });
  });

  it("maps abort and get to their routes", async () => {
    const { fetch, calls } = mockFetch([json(session({ status: "aborted" })), json(session())]);
    const { beakr } = client(fetch);
    expect((await beakr.uploads.abort("u1")).status).toBe("aborted");
    await beakr.uploads.get("u1");
    expect(calls.map((c) => `${c.method} ${path(c.url)}`)).toEqual(["DELETE /v1/uploads/u1", "GET /v1/uploads/u1"]);
  });
});
