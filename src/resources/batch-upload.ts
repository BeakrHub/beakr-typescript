/**
 * Many files in one batch (`/v1/bulk`): the TypeScript counterpart of Python's
 * `files.upload_many()` (`beakr_sdk/resources/_upload.py`).
 *
 * `prepare` creates the folders the files' paths name and returns a presigned
 * URL per file; each file's bytes are PUT there with no Beakr credential; and
 * `complete` records the files and starts indexing them as one job
 * (`job_id`, `status_url`). Paths keep their folders: `reports/q3.pdf` lands in
 * a `reports` folder (under `folderId` when given).
 */

import { cleanBody, type Transport } from "../core.js";
import type { JsonObject } from "../types.js";
import { detectArtifactType, guessMimeType } from "./file-types.js";
import type { FolderEntry } from "./folder-upload.js";
import { sha256Hex } from "../sha256.js";

/** Files one batch may carry (the API's `ingress.bulk_upload.max_files`). */
export const MAX_BATCH_FILES = 1000;

export interface UploadManyOptions {
  projectId: string;
  /** Put the files (and the folders their paths name) inside this folder. */
  folderId?: string;
  /** Include dotfiles and dot-directories of a directory (default false). */
  includeHidden?: boolean;
  /** Compile the files into Knowledge (default true). */
  ingest?: boolean;
  signal?: AbortSignal;
}

/** The batch's completion: one indexing job for every file in it. */
export interface BatchUpload extends JsonObject {
  batch_id: string;
  artifacts: JsonObject[];
  folders: JsonObject[];
  failed?: JsonObject[];
  /** `GET /v1/jobs/{job_id}`: pass the batch to `jobs.wait` to wait for indexing. */
  job_id: string;
  status_url: string;
}

interface Prepared {
  batch_id: string;
  uploads: { path: string; key: string; url: string; headers?: Record<string, string> }[];
}

async function asBlob(data: FolderEntry["data"]): Promise<Blob> {
  if (typeof ReadableStream !== "undefined" && data instanceof ReadableStream) {
    return new Response(data).blob();
  }
  if (data instanceof Blob) return data;
  return new Blob([data as BlobPart]);
}

/** Upload ``entries`` as one batch and resolve to its completion. */
export async function uploadBatch(
  transport: Transport,
  entries: FolderEntry[],
  options: UploadManyOptions,
): Promise<BatchUpload> {
  if (entries.length === 0) throw new TypeError("No files to upload");
  if (entries.length > MAX_BATCH_FILES) {
    throw new RangeError(
      `${entries.length} files: one batch takes at most ${MAX_BATCH_FILES}; split them`,
    );
  }
  const seen = new Set<string>();
  const files = await Promise.all(
    entries.map(async (entry) => {
      if (seen.has(entry.path)) {
        throw new TypeError(`Two files would both be uploaded as ${entry.path}`);
      }
      seen.add(entry.path);
      const blob = await asBlob(entry.data);
      const name = entry.path.split("/").pop() ?? entry.path;
      const contentType = entry.contentType ?? (blob.type || guessMimeType(name));
      return { entry, blob, name, contentType };
    }),
  );
  const prepared = await transport.request<Prepared>({
    method: "POST",
    path: "/v1/bulk/prepare",
    body: cleanBody({
      target_project_id: options.projectId,
      parent_folder_id: options.folderId,
      files: files.map((f) => ({
        path: f.entry.path,
        content_type: f.contentType,
        content_length: f.blob.size,
      })),
    }),
    idempotent: true,
  });
  const targets = new Map(prepared.uploads.map((upload) => [upload.path, upload]));
  const completed = [];
  for (const f of files) {
    const target = targets.get(f.entry.path);
    if (!target) throw new Error(`The batch has no upload URL for ${f.entry.path}`);
    await transport.putExternal(target.url, f.blob, {
      headers:
        target.headers && Object.keys(target.headers).length
          ? target.headers
          : { "Content-Type": f.contentType },
      signal: options.signal,
    });
    completed.push({
      path: f.entry.path,
      key: target.key,
      title: f.name.slice(0, 200),
      artifact_type: detectArtifactType(f.contentType, f.name),
      content_hash: await sha256Hex(f.blob),
      // Where the file sat on the uploader's machine, when that is not `path`.
      ...(f.entry.relativePath && f.entry.relativePath !== f.entry.path
        ? { relative_path: f.entry.relativePath }
        : {}),
    });
  }
  return transport.request<BatchUpload>({
    method: "POST",
    path: "/v1/bulk/complete",
    body: { batch_id: prepared.batch_id, files: completed, ingest_to_wiki: options.ingest ?? true },
    idempotent: true,
  });
}
