import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MULTIPART_THRESHOLD, detectArtifactType, guessMimeType } from "../src/index.js";
import { uploadRelativePath } from "../src/resources/folder-upload.js";
import { client, type Recorded } from "./helpers.js";

const API = "https://api.example.test";
const S3 = "https://s3.example.test/bucket";

/** A fetch that answers each Beakr route the folder upload uses, recording calls. */
function router() {
  const calls: Recorded[] = [];
  let folders = 0;
  const sessions: { content_length: number }[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const method = String(init.method);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    calls.push({ url, method, headers, body });
    const path = new URL(url).pathname;
    const reply = (value: unknown) =>
      new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    const state = (n: number) => ({
      id: `u${n}`,
      status: "open",
      project_id: "p1",
      path: "x",
      content_length: sessions[n - 1]!.content_length,
      part_size: Math.max(sessions[n - 1]!.content_length, 5 * 1024 * 1024),
      part_count: 1,
      ingest_to_wiki: true,
      uploaded_parts: [],
    });
    if (url.startsWith(S3)) return new Response(null, { status: 200, headers: { etag: '"e1"' } });
    if (method === "POST" && path === "/v1/folders") return reply({ id: `f${++folders}` });
    if (method === "POST" && path === "/v1/uploads") {
      sessions.push({ content_length: (body as { content_length: number }).content_length });
      return reply(state(sessions.length));
    }
    const match = /^\/v1\/uploads\/u(\d+)(\/parts|\/complete)?$/.exec(path);
    if (match) {
      const n = Number(match[1]);
      if (method === "GET" && !match[2]) return reply(state(n));
      if (method === "POST" && match[2] === "/parts") {
        return reply({ upload_id: `u${n}`, parts: [{ part_number: 1, url: `${S3}/u${n}?part=1` }] });
      }
      if (method === "POST" && match[2] === "/complete") {
        return reply({ upload: { id: `u${n}` }, artifact: { id: `a${n}` }, job_id: `j${n}`, status_url: "/s" });
      }
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { fetch, calls };
}

const bodiesOf = (calls: Recorded[], pattern: RegExp) =>
  calls.filter((c) => c.url.startsWith(API) && pattern.test(new URL(c.url).pathname)).map((c) => c.body as Record<string, unknown>);
const created = (calls: Recorded[]) => bodiesOf(calls, /^\/v1\/uploads$/);
const completed = (calls: Recorded[]) => bodiesOf(calls, /^\/v1\/uploads\/[^/]+\/complete$/);

const beakrPaths = (calls: Recorded[]) =>
  calls.filter((c) => c.url.startsWith(API)).map((c) => `${c.method} ${new URL(c.url).pathname}`);

const bytes = (text: string) => new TextEncoder().encode(text);

describe("uploads.uploadEntries", () => {
  it("mirrors nested folders, skips hidden entries and uploads in path order", async () => {
    const { fetch, calls } = router();
    const { beakr } = client(fetch);
    const result = await beakr.uploads.uploadEntries(
      [
        { path: "b.txt", data: bytes("b") },
        { path: "a/x.md", data: bytes("x") },
        { path: "a/sub/y.csv", data: bytes("y") },
        { path: ".hidden/z.txt", data: bytes("z") },
        { path: "a/.secret", data: bytes("s") },
      ],
      { projectId: "p1", folderId: "root" },
    );
    expect(result.map((r) => r.path)).toEqual(["a/sub/y.csv", "a/x.md", "b.txt"]);
    const folderBodies = calls.filter((c) => new URL(c.url).pathname === "/v1/folders").map((c) => c.body);
    expect(folderBodies).toEqual([
      { name: "a", project_id: "p1", parent_folder_id: "root" },
      { name: "sub", project_id: "p1", parent_folder_id: "f1" },
    ]);
    expect(completed(calls).map((b) => b.artifact_type)).toEqual(["dataset", "doc", "doc"]);
    expect(created(calls).map((b) => b.content_type)).toEqual([
      "text/csv",
      "text/markdown",
      "text/plain",
    ]);
    // Each file is placed in its folder by the upload itself (parent_folder_id).
    expect(created(calls).map((b) => b.parent_folder_id)).toEqual(["f2", "f1", "root"]);
    expect(beakrPaths(calls).some((p) => p.includes("/resources/") || p.endsWith("/v1/artifacts"))).toBe(false);
  });

  it("puts every file straight into the target folder without mirroring", async () => {
    const { fetch, calls } = router();
    const { beakr } = client(fetch);
    await beakr.uploads.uploadEntries(
      [
        { path: "a/x.md", data: bytes("x") },
        { path: "b.txt", data: bytes("b") },
      ],
      { projectId: "p1", folderId: "root", mirrorFolders: false, ingest: false },
    );
    expect(beakrPaths(calls)).not.toContain("POST /v1/folders");
    expect(created(calls).every((b) => b.ingest_to_wiki === false)).toBe(true);
    expect(created(calls).map((b) => b.parent_folder_id)).toEqual(["root", "root"]);
  });

  it("takes browser files and streams from any iterable", async () => {
    const { fetch, calls } = router();
    const { beakr } = client(fetch);
    async function* entries() {
      yield { path: "img/plate.bin", data: new File([bytes("p")], "plate.bin", { type: "image/png" }) };
      yield {
        path: "notes.txt",
        data: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes("streamed"));
            controller.close();
          },
        }),
      };
    }
    const result = await beakr.uploads.uploadEntries(entries(), { projectId: "p1" });
    expect(result).toHaveLength(2);
    expect(completed(calls)[0]!.artifact_type).toBe("image");
    const put = calls.filter((c) => c.url.startsWith(S3))[1]!;
    expect(new TextDecoder().decode(await (put.body as Blob).arrayBuffer())).toBe("streamed");
  });

  it("sends a file above the threshold through the resumable flow", async () => {
    const { fetch, calls } = router();
    const { beakr } = client(fetch);
    const big = new Blob([new Uint8Array(MULTIPART_THRESHOLD + 1)]);
    const [done] = await beakr.uploads.uploadEntries([{ path: "data/big.bin", data: big }], {
      projectId: "p1",
    });
    expect(done!.job_id).toBe("j1");
    const create = calls.find((c) => new URL(c.url).pathname === "/v1/uploads")!;
    expect(create.body).toMatchObject({ target_project_id: "p1", parent_folder_id: "f1", path: "big.bin" });
    expect(beakrPaths(calls)).not.toContain("POST /v1/uploads/presigned-url");
  });

  it.each(["../escape.txt", "/abs/file.txt", "a//b.txt", "C:/x.txt"])(
    "refuses the entry path %j before sending anything",
    async (path) => {
      const { fetch, calls } = router();
      const { beakr } = client(fetch);
      await expect(
        beakr.uploads.uploadEntries([{ path, data: bytes("x") }], { projectId: "p1" }),
      ).rejects.toThrow(TypeError);
      expect(calls).toEqual([]);
    },
  );
});

describe("uploads.uploadFolder (Node)", () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("walks a directory like Python's upload_folder and does not follow links", async () => {
    root = await mkdtemp(join(tmpdir(), "beakr-folder-"));
    const outside = await mkdtemp(join(tmpdir(), "beakr-outside-"));
    await mkdir(join(root, "reports", "q3"), { recursive: true });
    await mkdir(join(root, ".git"));
    await writeFile(join(root, "reports", "q3", "summary.md"), "s");
    await writeFile(join(root, "readme.txt"), "r");
    await writeFile(join(root, ".env"), "secret");
    await writeFile(join(root, ".git", "config"), "c");
    await writeFile(join(outside, "private.txt"), "p");
    await symlink(join(outside, "private.txt"), join(root, "linked.txt"));
    await symlink(outside, join(root, "linked-dir"));
    const { fetch, calls } = router();
    const { beakr } = client(fetch);
    const result = await beakr.uploads.uploadFolder(root, { projectId: "p1" });
    await rm(outside, { recursive: true, force: true });
    expect(result.map((r) => r.path)).toEqual([
      join(root, "readme.txt"),
      join(root, "reports", "q3", "summary.md"),
    ]);
    const names = calls
      .filter((c) => new URL(c.url).pathname === "/v1/folders")
      .map((c) => (c.body as { name: string }).name);
    expect(names).toEqual(["reports", "q3"]);
  });

  // Regression: a folder upload dropped the folder's own name, and
  // mirrorFolders: false dropped every directory, so the path Knowledge reads
  // showed for a file was not one the uploader could follow back. Each file now
  // records its path from the folder's parent (sent on complete, not create).
  it.each([true, false])(
    "records each file's path from the folder's parent (mirrorFolders %s)",
    async (mirrorFolders) => {
      root = await mkdtemp(join(tmpdir(), "beakr-folder-"));
      await mkdir(join(root, "docs", "guides"), { recursive: true });
      await writeFile(join(root, "docs", "top.md"), "t");
      await writeFile(join(root, "docs", "guides", "a.md"), "a");
      const { fetch, calls } = router();
      const { beakr } = client(fetch);
      await beakr.uploads.uploadFolder(join(root, "docs"), { projectId: "p1", mirrorFolders });
      expect(created(calls).every((body) => !("relative_path" in body))).toBe(true);
      expect(completed(calls).map((body) => body["relative_path"])).toEqual([
        "docs/guides/a.md",
        "docs/top.md",
      ]);
    },
  );

  it("rejects a path that is not a directory", async () => {
    const { fetch } = router();
    const { beakr } = client(fetch);
    root = await mkdtemp(join(tmpdir(), "beakr-folder-"));
    await writeFile(join(root, "file.txt"), "x");
    await expect(beakr.uploads.uploadFolder(join(root, "file.txt"), { projectId: "p1" })).rejects.toThrow(
      TypeError,
    );
  });
});

describe("file types", () => {
  it("matches the Python SDK's classification", () => {
    expect(detectArtifactType(guessMimeType("run.h5ad"), "run.h5ad")).toBe("scientific_data");
    expect(detectArtifactType(guessMimeType("nb.ipynb"), "nb.ipynb")).toBe("notebook");
    expect(detectArtifactType(guessMimeType("sheet.xlsx"), "sheet.xlsx")).toBe("dataset");
    expect(guessMimeType("unknown.qqq")).toBe("application/octet-stream");
  });
});

describe("edge safety", () => {
  // The SDK must import in edge and browser runtimes, so no source file may
  // import a Node built-in statically; Node-only helpers load them lazily.
  it("has no static node: imports in src", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith(".ts")) files.push(full);
      }
    };
    walk(join(__dirname, "..", "src"));
    const offenders = files.filter((file) =>
      /^\s*(import|export)\s[^;]*from\s+["']node:|require\(\s*["']node:/m.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});

describe("uploadRelativePath", () => {
  it("records a relative path with directories, never an absolute or climbing one", () => {
    expect(uploadRelativePath("deals/acme/memo.pdf")).toBe("deals/acme/memo.pdf");
    expect(uploadRelativePath("./deals/memo.pdf")).toBe("deals/memo.pdf");
    expect(uploadRelativePath("deals\\memo.pdf")).toBe("deals/memo.pdf");
    expect(uploadRelativePath("memo.pdf")).toBeUndefined();
    expect(uploadRelativePath("/abs/memo.pdf")).toBeUndefined();
    expect(uploadRelativePath("C:/abs/memo.pdf")).toBeUndefined();
    expect(uploadRelativePath("../outside/memo.pdf")).toBeUndefined();
  });
});
