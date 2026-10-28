// Regressions found by the fresh-install sandbox run of 2026-10-25.
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KnowledgeCommandError, bundleSha256 } from "../src/index.js";
import { client, json, mockFetch } from "./helpers.js";

const FILES = { "SKILL.md": "---\nname: plate-reader\n---\nRun the plate.\n" };
const BUNDLE = { skill_id: "s1", slug: "plate-reader", files: FILES, file_count: 1, files_sha256: bundleSha256(FILES) };

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "beakr-e2e-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// Root cause: a destination was treated as a directory only when it already
// existed, so a missing "dir/" was written as a file named "dir" (the README's
// own `download(skill.id, "exported/")` example hit it).
describe("a destination ending in / is a folder, created if missing", () => {
  it("skills.download writes <dir>/<slug>/", async () => {
    const { fetch } = mockFetch([json(BUNDLE)]);
    const { beakr } = client(fetch);
    const saved = await beakr.skills.download("s1", join(dir, "exported") + "/");
    expect(saved).toBe(join(dir, "exported", "plate-reader"));
    expect(await readFile(join(saved, "SKILL.md"), "utf8")).toBe(FILES["SKILL.md"]);
  });

  it("skills.download asZip writes <dir>/<slug>.zip", async () => {
    const { fetch } = mockFetch([new Response(new Uint8Array([80, 75, 5, 6])), json(BUNDLE)]);
    const { beakr } = client(fetch);
    const saved = await beakr.skills.download("s1", join(dir, "zips") + "/", { asZip: true });
    expect(saved).toBe(join(dir, "zips", "plate-reader.zip"));
    expect((await stat(saved)).isFile()).toBe(true);
  });

  it("files.downloadTo writes <dir>/<original name>", async () => {
    const { fetch } = mockFetch([
      json({ id: "a1", current_version_id: "v1", original_filename: "plate.csv" }),
      json({ url: "https://s3.example.test/obj?sig=x" }),
      new Response(new TextEncoder().encode("a,b")),
    ]);
    const { beakr } = client(fetch);
    const written = await beakr.files.downloadTo("a1", join(dir, "downloads") + "/");
    expect(written).toBe(join(dir, "downloads", "plate.csv"));
    expect(await readFile(written, "utf8")).toBe("a,b");
  });

  it("a path without a trailing / is still the file itself", async () => {
    const { fetch } = mockFetch([
      json({ id: "a1", current_version_id: "v1", original_filename: "plate.csv" }),
      json({ url: "https://s3.example.test/obj?sig=x" }),
      new Response(new TextEncoder().encode("a,b")),
    ]);
    const { beakr } = client(fetch);
    const written = await beakr.files.downloadTo("a1", join(dir, "renamed.csv"));
    expect(written).toBe(join(dir, "renamed.csv"));
  });
});

// Root cause: the bundle reports its digest as `files_sha256`; a caller passing
// `bundle.sha256` (undefined) silently skipped the overwrite check.
describe("skills.uploadBundle expectedSha256", () => {
  it("refuses an explicit undefined instead of writing unchecked", async () => {
    const { fetch, calls } = mockFetch([]);
    const { beakr } = client(fetch);
    await expect(beakr.skills.uploadBundle("s1", FILES, { expectedSha256: undefined })).rejects.toThrow(
      "files_sha256",
    );
    expect(calls).toHaveLength(0);
  });
});

// Root cause: the single-file upload declared application/octet-stream unless
// told otherwise, while folder and batch uploads inferred the type from the name.
describe("uploads.upload content type", () => {
  it("infers text/markdown for a .md file", async () => {
    const { fetch, calls } = mockFetch([json({ error: { code: "stop", message: "stop" } }, 400)]);
    const { beakr } = client(fetch);
    await beakr.uploads
      .upload(new TextEncoder().encode("# hi"), { projectId: "p1", path: "notes/readme.md" })
      .catch(() => undefined);
    expect((calls[0]!.body as { content_type: string }).content_type).toBe("text/markdown");
  });
});

// Root cause: the door answers 200 with outcome.status "error", and the error
// built from it carried no HTTP status and an empty request id. It also read
// `outcome.code`, which the door never sends: its outcome protocol
// (`beakr.wiki_tool_outcome.v1`) names the refusal in `outcome.error_code`, so
// `code` was always the generic `knowledge_command_error`.
describe("KnowledgeCommandError", () => {
  const refusal = {
    protocol: "beakr.wiki_tool_outcome.v1",
    status: "error",
    error_code: "invalid_arguments",
    committed_page_ids: [],
    committed_revisions: {},
    commit_ids: [],
  };

  it("carries the response status, request id and the door's error_code", async () => {
    const { fetch } = mockFetch([
      json(
        { content: [{ type: "text", text: "add_fact needs evidence" }], outcome: refusal },
        200,
        { "x-request-id": "req-123" },
      ),
    ]);
    const { beakr } = client(fetch);
    const error = (await beakr.knowledge
      .write("add_fact", { entity: "P-17", field: "x", value: "y" })
      .catch((e: unknown) => e)) as KnowledgeCommandError;
    expect(error).toBeInstanceOf(KnowledgeCommandError);
    expect(error.status).toBe(200);
    expect(error.requestId).toBe("req-123");
    expect(error.code).toBe("invalid_arguments");
    expect(error.result["outcome"]).toEqual(refusal);
  });

  it("names the refusal on a read command too", async () => {
    const { fetch } = mockFetch([
      json({
        content: [{ type: "text", text: "Unknown command: bogus_cmd." }],
        outcome: { ...refusal, error_code: "unknown_command" },
      }),
    ]);
    const { beakr } = client(fetch);
    const error = (await beakr.knowledge.command("bogus_cmd").catch((e: unknown) => e)) as KnowledgeCommandError;
    expect(error).toBeInstanceOf(KnowledgeCommandError);
    expect(error.code).toBe("unknown_command");
  });

  it("falls back to the generic code when the outcome names none", async () => {
    const { fetch } = mockFetch([
      json({ content: [{ type: "text", text: "refused" }], outcome: { status: "error" } }),
    ]);
    const { beakr } = client(fetch);
    const error = (await beakr.knowledge.command("cat").catch((e: unknown) => e)) as KnowledgeCommandError;
    expect(error.code).toBe("knowledge_command_error");
  });
});

// Root cause guarded: the skill's slug, its bundle's file paths and a file's
// original name come from the server and were joined onto the caller's folder
// unchecked, so a hostile or corrupted reply could write outside it.
describe("server-supplied names never leave the chosen folder", () => {
  const badNames = ["..", ".", "", "../escape", "a/b", "a\\b", "/etc/passwd", "C:evil", "na\0me"];

  for (const slug of badNames) {
    it(`skills.download refuses slug ${JSON.stringify(slug)}`, async () => {
      const { fetch } = mockFetch([json({ ...BUNDLE, slug })]);
      const { beakr } = client(fetch);
      await expect(beakr.skills.download("s1", dir)).rejects.toThrow(/Refusing to write the skill's slug/);
    });

    it(`skills.download asZip refuses slug ${JSON.stringify(slug)}`, async () => {
      const { fetch } = mockFetch([new Response(new Uint8Array([80, 75, 5, 6])), json({ ...BUNDLE, slug })]);
      const { beakr } = client(fetch);
      await expect(beakr.skills.download("s1", dir, { asZip: true })).rejects.toThrow(
        /Refusing to write the skill's slug/,
      );
    });
  }

  for (const name of ["../../escape.md", "/abs.md", "C:/x.md", "ok/../../x.md", "nul\0.md"]) {
    it(`skills.download refuses bundle path ${JSON.stringify(name)} before writing anything`, async () => {
      const { fetch } = mockFetch([json({ ...BUNDLE, files: { "SKILL.md": "x", [name]: "no" } })]);
      const { beakr } = client(fetch);
      await expect(beakr.skills.download("s1", dir)).rejects.toThrow(/leaves the skill folder/);
      await expect(stat(join(dir, "plate-reader", "SKILL.md"))).rejects.toThrow();
    });
  }

  for (const original of ["..", "dir/", "x/..", "a\0b.csv"]) {
    it(`files.downloadTo refuses original name ${JSON.stringify(original)}`, async () => {
      const { fetch } = mockFetch([
        json({ id: "a1", current_version_id: "v1", original_filename: original }),
        json({ url: "https://s3.example.test/obj?sig=x" }),
        new Response(new TextEncoder().encode("a,b")),
      ]);
      const { beakr } = client(fetch);
      await expect(beakr.files.downloadTo("a1", dir)).rejects.toThrow(/Refusing to write the file's name/);
    });
  }
});
