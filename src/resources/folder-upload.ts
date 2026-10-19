/**
 * Upload a tree of files, recreating its folders: the TypeScript counterpart of
 * Python's `files.upload_folder()` (`beakr_sdk/resources/_upload.py`).
 *
 * The core works on entries (`{ path, data }`), so it runs anywhere `fetch`
 * does: a browser `webkitdirectory` file list, an edge function, or Node. Only
 * {@link readDirectoryEntries} touches the file system, and it loads
 * `node:fs/promises` with a dynamic import, so importing the SDK in an edge or
 * browser runtime never pulls in a Node module.
 *
 * Behavior matches Python's:
 * - files go in a stable order (by path segments);
 * - hidden files and anything under a hidden folder (a segment starting with
 *   `.`) are skipped unless `includeHidden`;
 * - with `mirrorFolders` (the default) each sub-directory becomes a folder
 *   under `folderId`, parents first; a folder of the same name already in the
 *   same place is reused (also after the API refuses a duplicate created
 *   meanwhile), so two trees sharing sub-folder names, or the same tree again,
 *   fill the existing folders; without it every file goes straight into
 *   `folderId`;
 * - {@link Uploads.uploadFolder} starts the tree with a folder named after the
 *   directory (`rootFolder`, default true), matching each file's recorded path;
 * - each file is uploaded by {@link Uploads.upload} (the resumable upload, one
 *   part for a small file); `ingest: false` keeps the files out of Knowledge;
 * - each file records where it sat (`relativePath`, sent on completion): the
 *   entry's own `relativePath`, else its `path` when that names directories.
 *   {@link Uploads.uploadFolder} sets it to the path from the directory's
 *   parent, so it starts with the directory's own name, as Python's does;
 * - the result is `[{ path, ...uploaded }]` in upload order; the first failure
 *   rejects the call, and files already uploaded stay uploaded (a resumable
 *   one rejects with `UploadInterruptedError`, whose `uploadId` resumes it).
 */

import { cleanBody, type Transport } from "../core.js";
import { ValidationError } from "../errors.js";
import type { JsonObject } from "../types.js";
import { detectArtifactType, guessMimeType } from "./file-types.js";
import type { FileBody, UploadFileOptions } from "./uploads.js";
import { nodeBuiltin } from "../node-builtins.js";

/** One file to upload: its path relative to the tree's root, and its bytes. */
export interface FolderEntry {
  /** Relative path with `/` separators, e.g. `reports/2026/q3.pdf`. */
  path: string;
  data: FileBody | ReadableStream<Uint8Array>;
  /** Defaults to the type a `File` carries, else the one its extension implies. */
  contentType?: string;
  /**
   * The path recorded on the file (`docs/guides/a.md`): where it sat on the
   * uploader's machine. Defaults to `path` when that names directories.
   */
  relativePath?: string;
}

/**
 * The path a file given as `path` records: the path itself when it is relative
 * and names directories (`deals/acme/memo.pdf`), with `/` separators; otherwise
 * `undefined` (a bare name, an absolute path, or one that climbs with `..` say
 * nothing a reader could follow back). Matches Python's `upload_relative_path`.
 */
export function uploadRelativePath(path: string): string | undefined {
  const normalized = path.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return undefined;
  const segments = normalized.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length < 2 || segments.includes("..")) return undefined;
  return segments.join("/");
}

export interface UploadFolderOptions {
  projectId: string;
  /** Upload into this folder (the tree's root becomes its contents). */
  folderId?: string;
  /** Recreate sub-directories as folders (default true). */
  mirrorFolders?: boolean;
  /** Include dotfiles and dot-directories (default false). */
  includeHidden?: boolean;
  /** Compile the files into Knowledge (default true). */
  ingest?: boolean;
  /**
   * {@link Uploads.uploadFolder} only: start the folders with one named after the
   * directory (`docs/`), matching each file's recorded path (default true);
   * false puts the directory's contents straight into `folderId`.
   */
  rootFolder?: boolean;
  signal?: AbortSignal;
}

/** Internal: a folder name to place the whole tree under (set by `uploadFolder`). */
export interface UploadEntriesInternal {
  rootName?: string;
}

export interface UploadedFolderFile extends JsonObject {
  path: string;
  /** The file's indexing job: `beakr.jobs.wait(file)` waits for it. */
  job_id?: string;
}

interface Uploader {
  upload(file: FileBody, options: UploadFileOptions): Promise<JsonObject>;
}

function segmentsOf(path: string): string[] {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new TypeError(`Folder entry paths are relative to the tree's root: ${JSON.stringify(path)}`);
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new TypeError(`Invalid folder entry path ${JSON.stringify(path)}`);
  }
  return segments;
}

function compareSegments(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  }
  return a.length - b.length;
}

async function asFileBody(data: FolderEntry["data"]): Promise<FileBody> {
  if (typeof ReadableStream !== "undefined" && data instanceof ReadableStream) {
    return new Response(data).blob();
  }
  return data as FileBody;
}

/** Upload every entry; see the module notes for ordering, skipping and folders. */
export async function uploadEntries(
  uploader: Uploader,
  transport: Transport,
  entries: Iterable<FolderEntry> | AsyncIterable<FolderEntry>,
  options: UploadFolderOptions,
  displayPath: (entry: FolderEntry) => string = (entry) => entry.path,
  internal: UploadEntriesInternal = {},
): Promise<UploadedFolderFile[]> {
  const collected: { entry: FolderEntry; segments: string[] }[] = [];
  for await (const entry of entries as AsyncIterable<FolderEntry>) {
    const segments = segmentsOf(entry.path);
    if (!options.includeHidden && segments.some((segment) => segment.startsWith("."))) continue;
    collected.push({ entry, segments });
  }
  collected.sort((a, b) => compareSegments(a.segments, b.segments));

  const mirror = options.mirrorFolders ?? true;
  const leading = internal.rootName ? [internal.rootName] : [];
  const folderIds = new Map<string, string | undefined>([["", options.folderId]]);
  const children = new Map<string, Map<string, string>>();

  // The folders directly under `parentId` (the project's top level when undefined).
  const childFolders = async (parentId: string | undefined, refresh = false): Promise<Map<string, string>> => {
    const key = parentId ?? "";
    if (refresh) children.delete(key);
    let known = children.get(key);
    if (!known) {
      known = new Map();
      const listed = transport.paginate<{ id: string; name: string }>({
        method: "GET",
        path: "/v1/folders",
        query: parentId
          ? { project_id: options.projectId, parent_folder_id: parentId }
          : { project_id: options.projectId, root_only: true },
      });
      for await (const folder of listed) known.set(String(folder.name), String(folder.id));
      children.set(key, known);
    }
    return known;
  };

  const ensureFolder = async (dirs: string[]): Promise<string | undefined> => {
    const key = dirs.join("/");
    if (folderIds.has(key)) return folderIds.get(key);
    const parentId = await ensureFolder(dirs.slice(0, -1));
    const name = dirs[dirs.length - 1]!;
    let existing = await childFolders(parentId);
    let id = existing.get(name);
    if (id === undefined) {
      try {
        const created = await transport.request<{ id: string }>({
          method: "POST",
          path: "/v1/folders",
          body: cleanBody({ name, project_id: options.projectId, parent_folder_id: parentId }),
          idempotent: true,
        });
        id = String(created.id);
      } catch (error) {
        // Created by someone else since the listing: use theirs.
        if (!(error instanceof ValidationError)) throw error;
        existing = await childFolders(parentId, true);
        id = existing.get(name);
        if (id === undefined) throw error;
      }
      existing.set(name, id);
    }
    folderIds.set(key, id);
    return id;
  };

  const results: UploadedFolderFile[] = [];
  for (const { entry, segments } of collected) {
    const name = segments[segments.length - 1]!;
    const target = mirror ? await ensureFolder([...leading, ...segments.slice(0, -1)]) : options.folderId;
    const body = await asFileBody(entry.data);
    const fileType = body instanceof Blob && body.type ? body.type : undefined;
    const contentType = entry.contentType ?? fileType ?? guessMimeType(name);
    const recorded = entry.relativePath ?? uploadRelativePath(segments.join("/"));
    const uploaded = await uploader.upload(body, {
      projectId: options.projectId,
      path: name,
      relativePath: recorded && recorded !== name ? recorded : undefined,
      folderId: target,
      contentType,
      artifactType: detectArtifactType(contentType, name),
      ingest: options.ingest ?? true,
      signal: options.signal,
    });
    results.push({ path: displayPath(entry), ...uploaded });
  }
  return results;
}

/**
 * The files under a directory, as entries (Node only). Hidden files and
 * folders are skipped here unless `includeHidden`, so they are never read.
 * Symbolic links are not followed, so a link cannot pull files from outside
 * the tree into the upload. On Node 19.8+ each file is opened lazily as a Blob
 * (`fs.openAsBlob`), so a large tree is not read into memory up front.
 */
export async function readDirectoryEntries(
  root: string,
  options: { includeHidden?: boolean } = {},
): Promise<FolderEntry[]> {
  const fs = await nodeBuiltin<typeof import("node:fs/promises")>("node:fs/promises");
  const fsSync = await nodeBuiltin<typeof import("node:fs")>("node:fs");
  const nodePath = await nodeBuiltin<typeof import("node:path")>("node:path");
  const stats = await fs.stat(root);
  if (!stats.isDirectory()) throw new TypeError(`Not a directory: ${root}`);
  const openAsBlob = (fsSync as { openAsBlob?: (path: string) => Promise<Blob> }).openAsBlob;
  const entries: FolderEntry[] = [];
  const walk = async (dir: string, relative: string[]): Promise<void> => {
    for (const child of await fs.readdir(dir, { withFileTypes: true })) {
      if (!options.includeHidden && child.name.startsWith(".")) continue;
      const parts = [...relative, child.name];
      const full = nodePath.join(dir, child.name);
      if (child.isDirectory()) {
        await walk(full, parts);
      } else if (child.isFile()) {
        const data = openAsBlob ? await openAsBlob(full) : new Uint8Array(await fs.readFile(full));
        entries.push({ path: parts.join("/"), data });
      }
    }
  };
  await walk(root, []);
  return entries;
}
