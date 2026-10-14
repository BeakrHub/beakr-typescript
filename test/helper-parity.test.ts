import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NotFoundError } from "../src/index.js";
import { client, json, mockFetch } from "./helpers.js";

describe("files downloads (Python's files.download_url / download)", () => {
  const artifact = { id: "a1", current_version_id: "v1", original_filename: "dir/plate.csv", title: "Plate" };

  it("downloads the original bytes without sending the credential to storage", async () => {
    const { fetch, calls } = mockFetch([
      json(artifact),
      json({ url: "https://s3.example.test/obj?sig=x" }),
      new Response(new Uint8Array([1, 2, 3])),
    ]);
    const { beakr } = client(fetch);
    const file = await beakr.files.download("a1");
    expect(Array.from(file.data)).toEqual([1, 2, 3]);
    expect(file.filename).toBe("plate.csv");
    expect(new URL(calls[1]!.url).pathname).toBe("/v1/artifacts/versions/v1/download-url");
    expect(calls[2]!.headers.authorization).toBeUndefined();
  });

  it("saves into a directory under the original name (Node)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "beakr-dl-"));
    try {
      await mkdir(join(dir, "out"));
      const { fetch } = mockFetch([
        json(artifact),
        json({ url: "https://s3.example.test/obj?sig=x" }),
        new Response(new TextEncoder().encode("a,b")),
      ]);
      const { beakr } = client(fetch);
      const written = await beakr.files.downloadTo("a1", join(dir, "out"));
      expect(written).toBe(join(dir, "out", "plate.csv"));
      expect(await readFile(written, "utf8")).toBe("a,b");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("says so when a file has no uploaded version", async () => {
    const { fetch } = mockFetch([json({ id: "a1", current_version_id: null })]);
    const { beakr } = client(fetch);
    await expect(beakr.files.download("a1")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("files.read (Python's files.read, POST /v1/artifacts/read)", () => {
  it("sends the reference with its unit after #, and the window options", async () => {
    const window = {
      file: { id: "f1", version_id: "v1", title: "memo.pdf", display_path: "d/memo.pdf" },
      unit: { locator: "p. 7", found: true, page: 7, page_count: 9 },
      text: "Rent is $5",
      start: 0,
      end: 10,
      has_more: true,
      next_reference: "d/memo.pdf#p. 8",
    };
    const { fetch, calls } = mockFetch([json(window), json({ ...window, unit: null })]);
    const { beakr } = client(fetch);
    const read = await beakr.files.read("d/memo.pdf", { unit: "p. 7" });
    expect(read.next_reference).toBe("d/memo.pdf#p. 8");
    expect(calls[0]!.method).toBe("POST");
    expect(new URL(calls[0]!.url).pathname).toBe("/v1/artifacts/read");
    expect(calls[0]!.body).toEqual({ reference: "d/memo.pdf#p. 7", offset: 0, max_chars: 20000 });
    await beakr.files.read("{{artifact:v1-u3}}", { offset: 40, maxChars: 100 });
    expect(calls[1]!.body).toEqual({ reference: "{{artifact:v1-u3}}", offset: 40, max_chars: 100 });
  });
});
