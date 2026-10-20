/**
 * Skills: SKILL.md folders your agent loads on demand (`/v1/skills`); Python's
 * `beakr_sdk/resources/skills.py`.
 *
 * One list covers every skill you can use or install, each labelled with its
 * `visibility` (`private`, `org`, `public`), `owner` (`me`, `org`, `system` for
 * built-ins, `anyone` for public skills from outside your organization),
 * `origin` (`created`, `mined`, `imported`, `system`) and whether it is
 * `installed` in your library; every label is also a filter.
 *
 * ```ts
 * const mine = await beakr.skills.list({ owner: "me" });
 * const skill = await beakr.skills.createFromFolder("skills/plate-reader");
 * await beakr.skills.download(skill.id, "exported/");
 * ```
 */
import { cleanBody } from "../core.js";
import { nodeBuiltin } from "../node-builtins.js";
import { Sha256 } from "../sha256.js";
import type { JsonObject, ResponseOf } from "../types.js";
import { Resource, enc } from "./base.js";

export type SkillVisibility = "private" | "org" | "public";
export type SkillOwner = "me" | "org" | "system" | "anyone";
export type SkillOrigin = "created" | "mined" | "imported" | "system";

/** One page of skills (`GET /v1/skills`). */
export type SkillPage = ResponseOf<"/v1/skills", "get">;
/** A skill in the list, with its labels. */
export type Skill = SkillPage["data"][number];
/** A skill with the revision its files are at (`GET /v1/skills/{skill_id}`). */
export type SkillDetail = ResponseOf<"/v1/skills/{skill_id}", "get">;
/** A skill's SKILL.md folder (`GET /v1/skills/{skill_id}/bundle`). */
export type SkillBundle = ResponseOf<"/v1/skills/{skill_id}/bundle", "get">;
/** A created skill (`POST /v1/skills`). */
export type CreatedSkill = ResponseOf<"/v1/skills", "post">;
/** A skill's files: each path in its folder mapped to its text. */
export type SkillFiles = Record<string, string>;

export const SKILL_MD = "SKILL.md";

type OneOrMany<T> = T | readonly T[];

export interface ListSkillsQuery {
  visibility?: OneOrMany<SkillVisibility>;
  owner?: OneOrMany<SkillOwner>;
  origin?: OneOrMany<SkillOrigin>;
  /** `true` for the skills in your library, `false` for the ones you could install. */
  installed?: boolean;
  search?: string;
  domain?: string;
  /** Add each skill's `files`. */
  includeContent?: boolean;
  cursor?: string;
  limit?: number;
}

export interface CreateSkillOptions {
  visibility?: SkillVisibility;
  /** Where the folder came from (`claude-code`, `codex`...); kept with the skill. */
  source?: string;
  /** The handle to give the skill when its SKILL.md does not name one. */
  slugHint?: string;
}

export interface UploadBundleOptions {
  /** `false` writes the files given and keeps the rest. Default `true`. */
  replace?: boolean;
  /** The `files_sha256` you read: a change made since is refused with `skill_conflict`. */
  expectedSha256?: string;
  /** Write even when `expectedSha256` no longer matches. */
  force?: boolean;
}

/** Names a skill folder on disk carries that are not part of the skill. */
const IGNORED = new Set([".DS_Store", "__pycache__", ".git", "__MACOSX"]);
const ignored = (part: string) => IGNORED.has(part) || part.startsWith(".");

function many<T>(value: OneOrMany<T> | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  return (Array.isArray(value) ? value : [value]) as readonly string[];
}

const utf8 = new TextEncoder();

/**
 * The digest Beakr reports as a skill's `files_sha256`: SHA-256 over
 * `path\0sha256(content)` lines in path order, as the server computes it.
 */
export function bundleSha256(files: SkillFiles): string {
  const lines = Object.keys(files)
    .sort()
    .map((path) => `${path}\0${new Sha256().update(utf8.encode(files[path] ?? "")).hex()}`);
  return new Sha256().update(utf8.encode(lines.join("\n"))).hex();
}

/** `path` as a relative POSIX path inside the skill, or a `TypeError`. */
function safeRelative(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || parts.includes("..") || !parts.some(Boolean)) {
    throw new TypeError(`Skill file path ${JSON.stringify(path)} leaves the skill folder.`);
  }
  return parts.filter((part) => part && part !== ".").join("/");
}

function decodeText(name: string, data: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new TypeError(
      `${name} is not UTF-8 text; a skill's files are text (SKILL.md, scripts, references, templates).`,
    );
  }
}

/** The files of a zip archive (stored or deflated entries), by path. */
async function unzip(data: Uint8Array): Promise<Map<string, Uint8Array>> {
  const zlib = await nodeBuiltin<typeof import("node:zlib")>("node:zlib");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let end = -1;
  for (let at = data.length - 22; at >= Math.max(0, data.length - 22 - 0xffff); at--) {
    if (view.getUint32(at, true) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new TypeError("Not a zip archive.");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const entries = new Map<string, Uint8Array>();
  const names = new TextDecoder();
  for (let index = 0; index < count; index++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new TypeError("Corrupt zip central directory.");
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = names.decode(data.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = data.subarray(start, start + compressed);
    if (method === 0) entries.set(name, raw);
    else if (method === 8) entries.set(name, new Uint8Array(zlib.inflateRawSync(raw)));
    else throw new TypeError(`${name}: zip compression method ${method} is not supported.`);
  }
  return entries;
}

async function zipFiles(data: Uint8Array): Promise<SkillFiles> {
  let entries = new Map<string, Uint8Array>();
  for (const [name, content] of await unzip(data)) {
    if (name.split("/").some(ignored)) continue;
    entries.set(safeRelative(name), content);
  }
  // A zip of the folder (`plate-reader/SKILL.md`), as Beakr's own export and
  // most archivers write it, is read as the folder's contents.
  if (!entries.has(SKILL_MD)) {
    const tops = new Set([...entries.keys()].map((name) => name.split("/")[0]));
    if (tops.size === 1) {
      const [top] = tops;
      entries = new Map([...entries].map(([name, content]) => [name.slice(`${top}/`.length), content]));
    }
  }
  return Object.fromEntries([...entries].map(([name, content]) => [name, decodeText(name, content)]));
}

/**
 * A SKILL.md folder, a `SKILL.md` file or a `.zip` of a folder, as the
 * `{path: text}` files the API takes (Node). Hidden files are left out; a
 * missing SKILL.md or a file that is not UTF-8 text is a `TypeError`.
 */
export async function readSkillFolder(path: string): Promise<SkillFiles> {
  const fs = await nodeBuiltin<typeof import("node:fs/promises")>("node:fs/promises");
  const nodePath = await nodeBuiltin<typeof import("node:path")>("node:path");
  const stat = await fs.stat(path).catch(() => undefined);
  let files: SkillFiles;
  if (stat?.isDirectory()) {
    files = {};
    const walk = async (dir: string, relative: string[]): Promise<void> => {
      const children = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      );
      for (const child of children) {
        if (ignored(child.name)) continue;
        const parts = [...relative, child.name];
        const full = nodePath.join(dir, child.name);
        if (child.isDirectory()) await walk(full, parts);
        else if (child.isFile()) files[parts.join("/")] = decodeText(parts.join("/"), await fs.readFile(full));
      }
    };
    await walk(path, []);
  } else if (stat?.isFile()) {
    const data = new Uint8Array(await fs.readFile(path));
    const isZip = data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04;
    if (isZip) files = await zipFiles(data);
    else if (nodePath.basename(path) === SKILL_MD) files = { [SKILL_MD]: decodeText(SKILL_MD, data) };
    else throw new TypeError(`${path} is not a skill folder, a SKILL.md or a .zip of one.`);
  } else {
    throw new TypeError(`${path} is not a skill folder, a SKILL.md or a .zip of one.`);
  }
  if (!(SKILL_MD in files)) throw new TypeError(`${path} has no ${SKILL_MD} at its top level.`);
  return files;
}

/** Skills Beakr drafted from work you repeated, waiting for you to keep or dismiss. */
export class SkillProposals extends Resource {
  /** Proposals by `status`: `pending` (the default), `accepted` or `dismissed`. */
  list(
    query: { status?: "pending" | "accepted" | "dismissed"; cursor?: string; limit?: number } = {},
  ): Promise<ResponseOf<"/v1/me/skills/proposals", "get">> {
    return this.transport.request({ method: "GET", path: "/v1/me/skills/proposals", query });
  }

  /** Every proposal of a status, following cursors. */
  iter(query: { status?: "pending" | "accepted" | "dismissed" } = {}, pageSize?: number): AsyncGenerator<JsonObject> {
    return this.transport.paginate({ method: "GET", path: "/v1/me/skills/proposals", query }, pageSize);
  }

  /**
   * Make the draft a private skill of yours, installed in your library.
   * `force` creates it even when it repeats a skill you have (409
   * `duplicate_candidate` otherwise).
   */
  accept(
    proposalId: string,
    options: { force?: boolean } = {},
  ): Promise<ResponseOf<"/v1/me/skills/proposals/{proposal_id}/accept", "post">> {
    return this.transport.request({
      method: "POST",
      path: `/v1/me/skills/proposals/${enc(proposalId)}/accept`,
      query: { force: options.force },
    });
  }

  dismiss(proposalId: string): Promise<ResponseOf<"/v1/me/skills/proposals/{proposal_id}/dismiss", "post">> {
    return this.transport.request({
      method: "POST",
      path: `/v1/me/skills/proposals/${enc(proposalId)}/dismiss`,
    });
  }
}

export class Skills extends Resource {
  readonly proposals: SkillProposals = new SkillProposals(this.transport);

  private query(query: Omit<ListSkillsQuery, "cursor" | "limit">) {
    return {
      visibility: many(query.visibility),
      owner: many(query.owner),
      origin: many(query.origin),
      installed: query.installed,
      search: query.search,
      domain: query.domain,
      include_content: query.includeContent,
    };
  }

  /** One page of the skills you can use or install, by name. Each filter takes one value or several. */
  list(query: ListSkillsQuery = {}): Promise<SkillPage> {
    return this.transport.request({
      method: "GET",
      path: "/v1/skills",
      query: { ...this.query(query), cursor: query.cursor, limit: query.limit },
    });
  }

  /** Every skill matching the filters, following cursors. */
  iter(query: Omit<ListSkillsQuery, "cursor" | "limit"> = {}, pageSize?: number): AsyncGenerator<Skill> {
    return this.transport.paginate({ method: "GET", path: "/v1/skills", query: this.query(query) }, pageSize);
  }

  /**
   * One skill by id or slug, with `latest_revision`. A slug resolves to your
   * own skill first, then a built-in, then one you installed, then your
   * organization's; pass the id for any other.
   */
  get(skill: string, options: { includeContent?: boolean } = {}): Promise<SkillDetail> {
    return this.transport.request({
      method: "GET",
      path: `/v1/skills/${enc(skill)}`,
      query: { include_content: options.includeContent },
    });
  }

  /** The SKILL.md folder, with `files_sha256` to send back as `expectedSha256`. */
  bundle(skillId: string): Promise<SkillBundle> {
    return this.transport.request({ method: "GET", path: `/v1/skills/${enc(skillId)}/bundle` });
  }

  /** The SKILL.md folder as zip bytes (any runtime). */
  downloadZip(skillId: string): Promise<Uint8Array> {
    return this.transport.request({
      method: "GET",
      path: `/v1/skills/${enc(skillId)}/bundle.zip`,
      responseType: "bytes",
    });
  }

  /**
   * Save a skill's SKILL.md folder, or its zip with `asZip` (Node). When
   * `destination` is an existing directory the skill is saved inside it, as
   * `<slug>/` or `<slug>.zip`; otherwise `destination` is the folder or zip
   * itself. Resolves to the path written.
   */
  async download(skillId: string, destination: string, options: { asZip?: boolean } = {}): Promise<string> {
    const fs = await nodeBuiltin<typeof import("node:fs/promises")>("node:fs/promises");
    const nodePath = await nodeBuiltin<typeof import("node:path")>("node:path");
    const isDir = (await fs.stat(destination).catch(() => undefined))?.isDirectory() ?? false;
    if (options.asZip) {
      const data = await this.downloadZip(skillId);
      const target = isDir ? nodePath.join(destination, `${(await this.bundle(skillId)).slug}.zip`) : destination;
      await fs.mkdir(nodePath.dirname(target), { recursive: true });
      await fs.writeFile(target, data);
      return target;
    }
    const bundle = await this.bundle(skillId);
    const folder = isDir ? nodePath.join(destination, bundle.slug) : destination;
    // Every path is checked before anything is written, so a bundle naming a
    // path outside the folder leaves no partial copy behind.
    const targets = Object.entries(bundle.files ?? {}).map(
      ([name, content]) => [nodePath.join(folder, ...safeRelative(name).split("/")), content] as const,
    );
    for (const [target, content] of targets) {
      await fs.mkdir(nodePath.dirname(target), { recursive: true });
      await fs.writeFile(target, content, "utf8");
    }
    await fs.mkdir(folder, { recursive: true });
    return folder;
  }

  /**
   * Create a skill of yours from its files (with `SKILL.md`). It is installed
   * in your library and private unless `visibility` says otherwise; a retry
   * replays its `Idempotency-Key`.
   */
  create(files: SkillFiles, options: CreateSkillOptions = {}): Promise<CreatedSkill> {
    return this.transport.request({
      method: "POST",
      path: "/v1/skills",
      idempotent: true,
      body: cleanBody({
        files,
        visibility: options.visibility,
        source: options.source,
        slug_hint: options.slugHint,
      }),
    });
  }

  /** Create a skill from a SKILL.md folder, a SKILL.md or a `.zip` of a folder (Node). */
  async createFromFolder(path: string, options: CreateSkillOptions = {}): Promise<CreatedSkill> {
    return this.create(await readSkillFolder(path), options);
  }

  /**
   * Replace the files of a skill you own, from `{path: text}` or a folder or
   * zip path (Node). A change made since `expectedSha256` is refused with
   * `ConflictError` (`skill_conflict`) unless `force`.
   */
  async uploadBundle(
    skillId: string,
    files: SkillFiles | string,
    options: UploadBundleOptions = {},
  ): Promise<SkillBundle> {
    const payload = typeof files === "string" ? await readSkillFolder(files) : files;
    const body: Record<string, unknown> = { files: payload, replace: options.replace ?? true };
    if (options.expectedSha256 !== undefined) body["expected_sha256"] = options.expectedSha256;
    if (options.force) body["force"] = true;
    return this.transport.request({ method: "PUT", path: `/v1/skills/${enc(skillId)}/bundle`, body });
  }

  /** Add a skill you can see to your library, so your agent is told about it. */
  install(skillId: string): Promise<ResponseOf<"/v1/me/skills/library/{skill_id}", "post">> {
    return this.transport.request({ method: "POST", path: `/v1/me/skills/library/${enc(skillId)}` });
  }

  /** Remove a skill from your library; the skill itself is kept. */
  uninstall(skillId: string): Promise<void> {
    return this.transport.request({
      method: "DELETE",
      path: `/v1/me/skills/library/${enc(skillId)}`,
      responseType: "none",
    });
  }

  /** Delete a skill you wrote, for everyone who installed it. */
  delete(skillId: string): Promise<void> {
    return this.transport.request({ method: "DELETE", path: `/v1/skills/${enc(skillId)}`, responseType: "none" });
  }
}
