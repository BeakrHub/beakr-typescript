/**
 * Skills (Python's `tests/test_skills.py`): the one filtered list, a skill by id
 * or slug, its files, the library and proposals.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConflictError, bundleSha256, readSkillFolder } from "../src/index.js";
import { client, json, mockFetch } from "./helpers.js";

const url = (call: { url: string }) => new URL(call.url);
const FILES = { "SKILL.md": "---\nname: plate-reader\n---\nRead it.\n", "scripts/run.py": "print(1)\n" };
const SKILL = {
  id: "s1",
  slug: "plate-reader",
  name: "Plate reader",
  description: "Read plate-reader exports.",
  domain: null,
  visibility: "private",
  owner: "me",
  origin: "imported",
  installed: true,
  created_at: "2026-10-20T00:00:00Z",
  updated_at: "2026-10-20T00:00:00Z",
  files: null,
};
const BUNDLE = { skill_id: "s1", slug: "plate-reader", files: FILES, file_count: 2, files_sha256: bundleSha256(FILES) };
const page = (data: unknown[], next: string | null = null) => ({ data, next_cursor: next, has_more: next !== null });

/** A zip of `entries`, deflated, as archivers write it (CRCs are not checked by the reader). */
function zipOf(entries: Record<string, string | Uint8Array>): Uint8Array {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const raw = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const data = deflateRawSync(raw);
    const nameBytes = new TextEncoder().encode(name);
    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(8, 8, true);
    header.setUint32(18, data.length, true);
    header.setUint32(22, raw.length, true);
    header.setUint16(26, nameBytes.length, true);
    local.push(new Uint8Array(header.buffer), nameBytes, data);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(10, 8, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, raw.length, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, Object.keys(entries).length, true);
  end.setUint16(10, Object.keys(entries).length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const parts = [...local, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "beakr-skills-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("skills.list", () => {
  it("sends every filter, one value or several", async () => {
    const { fetch, calls } = mockFetch([json(page([SKILL]))]);
    const { beakr } = client(fetch);
    await beakr.skills.list({
      visibility: ["private", "org"],
      owner: "me",
      origin: ["created", "imported"],
      installed: false,
      search: "plate",
      domain: "lab",
      includeContent: true,
    });
    const params = url(calls[0]!).searchParams;
    expect(url(calls[0]!).pathname).toBe("/v1/skills");
    expect(params.getAll("visibility")).toEqual(["private", "org"]);
    expect(params.getAll("owner")).toEqual(["me"]);
    expect(params.getAll("origin")).toEqual(["created", "imported"]);
    expect([params.get("installed"), params.get("search"), params.get("domain")]).toEqual(["false", "plate", "lab"]);
    expect(params.get("include_content")).toBe("true");
  });

  it("iterates every page and sends no filter it was not given", async () => {
    const { fetch, calls } = mockFetch([json(page([SKILL], "c2")), json(page([{ ...SKILL, id: "s2" }]))]);
    const { beakr } = client(fetch);
    const ids: string[] = [];
    for await (const skill of beakr.skills.iter()) ids.push(skill.id);
    expect(ids).toEqual(["s1", "s2"]);
    expect([...url(calls[0]!).searchParams.keys()]).toEqual([]);
    expect(url(calls[1]!).searchParams.get("cursor")).toBe("c2");
  });
});

describe("skills.get, bundle, download", () => {
  it("takes an id or a slug", async () => {
    const { fetch, calls } = mockFetch([json({ ...SKILL, latest_revision: null })]);
    const { beakr } = client(fetch);
    expect((await beakr.skills.get("plate-reader", { includeContent: true })).owner).toBe("me");
    expect(url(calls[0]!).pathname).toBe("/v1/skills/plate-reader");
    expect(url(calls[0]!).searchParams.get("include_content")).toBe("true");
  });

  it("writes the folder inside an existing directory", async () => {
    const { fetch, calls } = mockFetch([json(BUNDLE)]);
    const { beakr } = client(fetch);
    const saved = await beakr.skills.download("s1", dir);
    expect(saved).toBe(join(dir, "plate-reader"));
    expect(url(calls[0]!).pathname).toBe("/v1/skills/s1/bundle");
    expect(await readFile(join(saved, "scripts", "run.py"), "utf8")).toBe("print(1)\n");
    expect(await readSkillFolder(saved)).toEqual(FILES);
  });

  it("saves the zip, which reads back as the skill's files", async () => {
    const archive = zipOf({ "plate-reader/SKILL.md": FILES["SKILL.md"], "plate-reader/scripts/run.py": FILES["scripts/run.py"] });
    const { fetch, calls } = mockFetch([
      new Response(archive.buffer as ArrayBuffer, { headers: { "content-type": "application/zip" } }),
      json(BUNDLE),
    ]);
    const { beakr } = client(fetch);
    const saved = await beakr.skills.download("s1", dir, { asZip: true });
    expect(saved).toBe(join(dir, "plate-reader.zip"));
    expect(url(calls[0]!).pathname).toBe("/v1/skills/s1/bundle.zip");
    expect(await readSkillFolder(saved)).toEqual(FILES);
  });

  it("refuses a path outside the folder before writing anything", async () => {
    const { fetch } = mockFetch([json({ ...BUNDLE, files: { "SKILL.md": "x", "../escape.md": "no" } })]);
    const { beakr } = client(fetch);
    await expect(beakr.skills.download("s1", join(dir, "out"))).rejects.toThrow("leaves the skill folder");
    await expect(readFile(join(dir, "out", "SKILL.md"), "utf8")).rejects.toThrow();
  });
});

describe("creating and replacing skills", () => {
  it("creates from a folder's text files with an idempotency key", async () => {
    const folder = join(dir, "plate-reader");
    await mkdir(join(folder, "scripts"), { recursive: true });
    await writeFile(join(folder, "SKILL.md"), FILES["SKILL.md"]);
    await writeFile(join(folder, "scripts", "run.py"), FILES["scripts/run.py"]);
    await writeFile(join(folder, ".DS_Store"), new Uint8Array([0, 1]));
    const { fetch, calls } = mockFetch([json(SKILL, 201)]);
    const { beakr } = client(fetch);
    await beakr.skills.createFromFolder(folder, { visibility: "org", source: "claude-code" });
    expect(calls[0]!.method).toBe("POST");
    expect(url(calls[0]!).pathname).toBe("/v1/skills");
    expect(calls[0]!.body).toEqual({ files: FILES, visibility: "org", source: "claude-code" });
    expect(calls[0]!.headers["idempotency-key"]).toBeTruthy();
  });

  it("creates from a zip and refuses a folder that is not a skill", async () => {
    const archive = join(dir, "skill.zip");
    await writeFile(archive, zipOf({ "SKILL.md": FILES["SKILL.md"], "__MACOSX/._SKILL.md": new Uint8Array([0]) }));
    const { fetch, calls } = mockFetch([json(SKILL, 201)]);
    const { beakr } = client(fetch);
    await beakr.skills.createFromFolder(archive);
    expect(calls[0]!.body).toEqual({ files: { "SKILL.md": FILES["SKILL.md"] } });

    await mkdir(join(dir, "empty"));
    await expect(beakr.skills.createFromFolder(join(dir, "empty"))).rejects.toThrow("has no SKILL.md");
    await mkdir(join(dir, "binary"));
    await writeFile(join(dir, "binary", "SKILL.md"), "x");
    await writeFile(join(dir, "binary", "logo.png"), new Uint8Array([0x89, 0x50, 0xff, 0xfe]));
    await expect(beakr.skills.createFromFolder(join(dir, "binary"))).rejects.toThrow("logo.png is not UTF-8 text");
    expect(calls).toHaveLength(1);
  });

  it("uploads with the base digest and raises ConflictError on a conflict", async () => {
    const { fetch, calls } = mockFetch([
      json(BUNDLE),
      json({ error: { code: "skill_conflict", message: "changed" } }, 409),
    ]);
    const { beakr } = client(fetch);
    await beakr.skills.uploadBundle("s1", FILES, { replace: false, expectedSha256: "abc" });
    expect(calls[0]!.method).toBe("PUT");
    expect(url(calls[0]!).pathname).toBe("/v1/skills/s1/bundle");
    expect(calls[0]!.body).toEqual({ files: FILES, replace: false, expected_sha256: "abc" });
    const folder = join(dir, "plate-reader");
    await mkdir(folder);
    await writeFile(join(folder, "SKILL.md"), FILES["SKILL.md"]);
    const error = await beakr.skills.uploadBundle("s1", folder, { force: true }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).code).toBe("skill_conflict");
    expect(calls[1]!.body).toEqual({ files: { "SKILL.md": FILES["SKILL.md"] }, replace: true, force: true });
  });
});

describe("the library and proposals", () => {
  it("installs, uninstalls and deletes", async () => {
    const { fetch, calls } = mockFetch([
      json({ status: "installed", skill_id: "s1" }, 201),
      new Response(null, { status: 204 }),
      new Response(null, { status: 204 }),
    ]);
    const { beakr } = client(fetch);
    expect((await beakr.skills.install("s1")).status).toBe("installed");
    await beakr.skills.uninstall("s1");
    await beakr.skills.delete("s1");
    expect(calls.map((c) => `${c.method} ${url(c).pathname}`)).toEqual([
      "POST /v1/me/skills/library/s1",
      "DELETE /v1/me/skills/library/s1",
      "DELETE /v1/skills/s1",
    ]);
  });

  it("lists, accepts and dismisses proposals", async () => {
    const { fetch, calls } = mockFetch([
      json(page([{ id: "p1", title: "Plate reader", status: "pending" }])),
      json(SKILL, 201),
      json({ status: "dismissed", proposal_id: "p2" }),
    ]);
    const { beakr } = client(fetch);
    expect((await beakr.skills.proposals.list({ status: "pending" })).data[0]!.id).toBe("p1");
    expect(url(calls[0]!).searchParams.get("status")).toBe("pending");
    await beakr.skills.proposals.accept("p1", { force: true });
    expect(url(calls[1]!).pathname).toBe("/v1/me/skills/proposals/p1/accept");
    expect(url(calls[1]!).searchParams.get("force")).toBe("true");
    expect((await beakr.skills.proposals.dismiss("p2")).status).toBe("dismissed");
  });
});

describe("bundleSha256", () => {
  it("matches the server's digest", () => {
    // Python's test vector (beakr-cli tests/test_personal_skill_sync_revision.py).
    expect(
      bundleSha256({ "SKILL.md": "---\nname: X\n---\nBody\n", "references/a.md": "é unicode", "empty.txt": "" }),
    ).toBe("2b62c3ac9102f4f41948ad05e3215d0452cb77e64dcc715445d03f31e2ebe271");
    expect(bundleSha256({})).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});
