import { BeakrError, ConflictError, RateLimitError, ServerError, APIConnectionError } from "../errors.js";
import { cleanBody } from "../core.js";
import type { JsonObject, ResponseOf } from "../types.js";
import { Resource, enc } from "./base.js";
import {
  readDirectoryEntries,
  uploadEntries,
  uploadRelativePath,
  type FolderEntry,
  type UploadFolderOptions,
  type UploadedFolderFile,
} from "./folder-upload.js";
import { sha256Hex } from "../sha256.js";
import { guessMimeType } from "./file-types.js";
import { uploadBatch, type BatchUpload, type UploadManyOptions } from "./batch-upload.js";
import { Jobs, type Job, type JobWaitOptions } from "./jobs.js";
import {
  alreadyUploadedOutcome,
  waitForFilesKnowledge,
  waitForKnowledge,
  type AlreadyUploaded,
  type KnowledgeWaitOptions,
} from "./knowledge-readiness.js";
import { nodeBuiltin } from "../node-builtins.js";

/**
 * Formerly the size above which uploads went multipart. Every upload is
 * resumable now (a small file is one part); kept so existing imports work.
 */
export const MULTIPART_THRESHOLD = 64 * 1024 * 1024;
/** Part URLs requested per `/parts` call; a small window keeps each URL fresh. */
export const PRESIGN_WINDOW = 8;

export type FileBody = Uint8Array | ArrayBuffer | Blob;

/** What {@link Uploads.uploadMany} resolves to; `job`, `status` and the rest come with a wait. */
export type UploadManyResult = BatchUpload & {
  job?: Job;
  batch?: JsonObject;
  /** The upload's outcome: the job's status, or `succeeded` when its only failures are duplicates. */
  status?: string;
  /** Files already in Beakr: rejected as duplicates, with the copy that was kept. */
  duplicates?: AlreadyUploaded[];
};

/** An upload batch's per-file status: `batch_id`, `status`, `artifacts`, `summary`, `knowledge`. */
export type BatchStatus = ResponseOf<"/v1/bulk/{batch_id}/status", "get">;

export interface UploadedPart {
  part_number: number;
  size: number;
  etag: string;
}

/** A resumable upload, from `/v1/uploads`. */
export interface UploadSession extends JsonObject {
  id: string;
  status: string;
  project_id: string;
  path: string;
  content_length: number;
  part_size: number;
  part_count: number;
  ingest_to_wiki: boolean;
  uploaded_parts: UploadedPart[] | null;
}

export interface UploadComplete extends JsonObject {
  upload: UploadSession;
  artifact: JsonObject & {
    id: string;
    version_id: string;
    job_id: string | null;
  };
  job_id: string;
  /** `/v1/jobs/{job_id}`: the indexing job for this file. */
  status_url: string;
  /** The upload batch's status view (`/v1/bulk/{upload_id}/status`). */
  batch_status_url?: string;
}

export interface UploadFileOptions {
  projectId: string;
  /** File name, optionally with folders (`reports/q3.pdf`). */
  path: string;
  folderId?: string;
  contentType?: string;
  /** Compile the file into Knowledge (default true). */
  ingest?: boolean;
  title?: string;
  artifactType?: string;
  description?: string;
  /**
   * Where the file sat on the uploader's machine, relative to the folder it was
   * uploaded from (`deals/acme/memo.pdf`). Recorded on the file: Knowledge reads
   * name it by this path (`location.display_path`) and `files.read` accepts it.
   * It never places the file. Sent on completion.
   */
  relativePath?: string;
  partSize?: number;
  signal?: AbortSignal;
}

/** A resumable upload stopped on a transient failure; `uploadId` resumes it. */
export class UploadInterruptedError extends BeakrError {
  constructor(
    readonly uploadId: string,
    cause: unknown,
  ) {
    super(`Upload stopped (${String(cause)}). Resume it with upload id ${uploadId}.`, {
      code: "upload_interrupted",
      cause,
    });
    this.name = "UploadInterruptedError";
  }
}

function resumable(error: unknown): boolean {
  if (
    error instanceof APIConnectionError ||
    error instanceof ServerError ||
    error instanceof RateLimitError
  ) {
    return true;
  }
  return error instanceof ConflictError && error.code === "upload_incomplete";
}

function asBlob(body: FileBody): Blob {
  return body instanceof Blob ? body : new Blob([body as BlobPart]);
}

/**
 * Uploads: `upload` sends one file through the resumable routes; the other
 * methods are the resumable multipart routes one call each.
 */
export class Uploads extends Resource {
  create(
    options: Omit<UploadFileOptions, "title" | "artifactType" | "description" | "signal"> & {
      contentLength: number;
      contentHash?: string;
    },
  ): Promise<UploadSession> {
    return this.transport.request({
      method: "POST",
      path: "/v1/uploads",
      body: cleanBody({
        target_project_id: options.projectId,
        parent_folder_id: options.folderId,
        path: options.path,
        content_type: options.contentType,
        content_length: options.contentLength,
        content_hash: options.contentHash,
        part_size: options.partSize,
        ingest_to_wiki: options.ingest ?? true,
      }),
      idempotent: true,
    });
  }

  get(uploadId: string): Promise<UploadSession> {
    return this.transport.request({
      method: "GET",
      path: `/v1/uploads/${enc(uploadId)}`,
    });
  }

  presignParts(
    uploadId: string,
    partNumbers: number[],
  ): Promise<{
    upload_id: string;
    parts: { part_number: number; url: string }[];
  }> {
    return this.transport.request({
      method: "POST",
      path: `/v1/uploads/${enc(uploadId)}/parts`,
      body: { part_numbers: partNumbers },
    });
  }

  complete(
    uploadId: string,
    options: {
      parts?: { part_number: number; etag: string }[];
      title?: string;
      artifactType?: string;
      description?: string;
      relativePath?: string;
    } = {},
  ): Promise<UploadComplete> {
    return this.transport.request({
      method: "POST",
      path: `/v1/uploads/${enc(uploadId)}/complete`,
      body: cleanBody({
        parts: options.parts,
        title: options.title,
        artifact_type: options.artifactType,
        description: options.description,
        relative_path: options.relativePath,
      }),
      idempotent: true,
    });
  }

  abort(uploadId: string): Promise<UploadSession> {
    return this.transport.request({
      method: "DELETE",
      path: `/v1/uploads/${enc(uploadId)}`,
    });
  }

  /**
   * Upload one file through the resumable upload (`/v1/uploads`; a small file
   * is one part) and resolve to the completion (`artifact`, `job_id`,
   * `status_url`). An interrupted upload rejects with
   * {@link UploadInterruptedError}; pass its `uploadId` to {@link resume}.
   */
  async upload(file: FileBody, options: UploadFileOptions): Promise<UploadComplete> {
    const blob = asBlob(file);
    if (blob.size === 0) {
      throw new BeakrError(`${options.path} is empty; Beakr does not store empty files`, {
        code: "empty_file",
      });
    }
    const session = await this.create({
      ...options,
      // Inferred from the name the way folder and batch uploads do, so a
      // single `.md` is not stored as application/octet-stream.
      contentType: options.contentType ?? (blob.type || guessMimeType(options.path)),
      contentLength: blob.size,
      // Declared up front, as the Python SDK does, so the server can check
      // the assembled object (hashed as a stream: no whole-file buffer).
      contentHash: await sha256Hex(blob),
    });
    return this.sendParts(session.id, blob, options);
  }

  /**
   * Upload a directory tree (Node). Sub-directories become folders unless
   * `mirrorFolders: false`; dotfiles are skipped unless `includeHidden`.
   * Either way each file records its path from the directory's parent
   * (`docs/guides/a.md` for `guides/a.md` under `docs/`) as its `relativePath`.
   * The folders start with one named after the directory (`docs/`) unless
   * `rootFolder: false`, and existing folders of the same name are reused, so
   * uploading two trees with shared sub-folder names, or the same tree again,
   * does not fail. Resolves to `[{ path, ...completion }]` in upload order,
   * like Python's `files.upload_folder()`.
   */
  async uploadFolder(directory: string, options: UploadFolderOptions): Promise<UploadedFolderFile[]> {
    const entries = await readDirectoryEntries(directory, { includeHidden: options.includeHidden });
    const nodePath = await nodeBuiltin<typeof import("node:path")>("node:path");
    const rootName = nodePath.basename(nodePath.resolve(directory));
    for (const entry of entries) entry.relativePath = `${rootName}/${entry.path}`;
    return uploadEntries(
      this,
      this.transport,
      entries,
      options,
      (entry) => nodePath.join(directory, ...entry.path.split("/")),
      { rootName: options.rootFolder === false ? undefined : rootName },
    );
  }

  /**
   * Upload a tree given as entries, in any runtime: a browser `webkitdirectory`
   * file list (`{ path: file.webkitRelativePath, data: file }`), an edge
   * function's blobs, or streams. Same folders, order and result as
   * {@link uploadFolder}.
   */
  uploadEntries(
    entries: Iterable<FolderEntry> | AsyncIterable<FolderEntry>,
    options: UploadFolderOptions,
  ): Promise<UploadedFolderFile[]> {
    return uploadEntries(this, this.transport, entries, options);
  }

  /**
   * Upload many files as one batch (`/v1/bulk`): file paths and directories
   * (Node), or entries (`{ path, data }`) from any runtime. A file lands under
   * its own name; a directory's sub-directories become folders (under
   * `folderId` when given). Up to {@link MAX_BATCH_FILES} files. Resolves to
   * the batch's completion; indexing runs as one job, so
   * `await beakr.jobs.wait(batch)` waits for it, or pass `wait` here.
   *
   * `wait: "knowledge"` then also waits until none of the batch's files is
   * queued or running for Knowledge (`knowledgeWait` sets how) and adds the
   * final {@link batchStatus} as `batch`: each file's `knowledge_status` and
   * the batch's `knowledge` counts, including `failed`.
   *
   * With a wait, `status` is the upload's outcome. A file whose bytes are
   * already in the same place is not stored twice: it is listed in
   * `duplicates` (`path`, `artifact_id`, and `duplicate_of`, the file that was
   * kept), and when every failed file is such a duplicate `status` is
   * `"succeeded"` (the job succeeds too on an engine that counts them in
   * `summary.duplicates`; an earlier one reports it `failed`). With
   * `wait: "knowledge"` each kept file's Knowledge is waited for too
   * (`kept_knowledge_status`).
   */
  async uploadMany(
    files: string | string[] | Iterable<FolderEntry> | AsyncIterable<FolderEntry>,
    options: UploadManyOptions & {
      wait?: boolean | JobWaitOptions | "index" | "knowledge";
      knowledgeWait?: KnowledgeWaitOptions;
    },
  ): Promise<UploadManyResult> {
    if (options.wait === "knowledge" && options.ingest === false) {
      throw new TypeError('wait: "knowledge" needs ingest; these files stay out of Knowledge');
    }
    const entries: FolderEntry[] = [];
    const paths =
      typeof files === "string"
        ? [files]
        : Array.isArray(files) && files.every((item) => typeof item === "string")
          ? (files as string[])
          : undefined;
    if (paths) {
      const fs = await nodeBuiltin<typeof import("node:fs/promises")>("node:fs/promises");
      const nodePath = await nodeBuiltin<typeof import("node:path")>("node:path");
      for (const item of paths) {
        if ((await fs.stat(item)).isDirectory()) {
          const rootName = nodePath.basename(nodePath.resolve(item));
          for (const entry of await readDirectoryEntries(item, { includeHidden: options.includeHidden })) {
            entries.push({ ...entry, relativePath: `${rootName}/${entry.path}` });
          }
        } else {
          entries.push({
            path: nodePath.basename(item),
            data: new Uint8Array(await fs.readFile(item)),
            relativePath: nodePath.isAbsolute(item) ? undefined : uploadRelativePath(item),
          });
        }
      }
    } else {
      for await (const entry of files as AsyncIterable<FolderEntry>) entries.push(entry);
    }
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const batch = await uploadBatch(this.transport, entries, options);
    if (!options.wait) return batch;
    const job = await new Jobs(this.transport).wait(
      batch,
      typeof options.wait === "object" ? options.wait : {},
    );
    let result: UploadManyResult = { ...batch, job, status: String(job.status) };
    const summary = (job.result?.["summary"] as JsonObject | undefined) ?? {};
    if (job.status === "failed" || Number(summary["duplicates"] ?? 0) > 0) {
      result = { ...result, ...alreadyUploadedOutcome(await this.batchStatus(batch.batch_id)) };
    }
    if (options.wait !== "knowledge") return result;
    const status = await waitForKnowledge(
      this.transport,
      `batch ${batch.batch_id}`,
      () => this.batchStatus(batch.batch_id),
      options.knowledgeWait,
    );
    result = { ...result, batch: status };
    const kept = [...new Set((result.duplicates ?? []).map((d) => d.duplicate_of.artifact_id))];
    if (kept.length) {
      const knowledge = await waitForFilesKnowledge(this.transport, kept, options.knowledgeWait);
      result.duplicates = (result.duplicates ?? []).map((d) => ({
        ...d,
        kept_knowledge_status: knowledge[d.duplicate_of.artifact_id] ?? null,
      }));
    }
    return result;
  }

  /**
   * Per-file status of an {@link uploadMany} batch, with counts: each file's
   * indexing `status` and `knowledge_status`, the indexing `summary`, and the
   * batch's `knowledge` counts (`queued`, `running`, `created`, `failed`,
   * `ready`...).
   */
  batchStatus(batchId: string): Promise<BatchStatus> {
    return this.transport.request({ method: "GET", path: `/v1/bulk/${enc(batchId)}/status` });
  }

  /** Finish an interrupted multipart upload, sending only the parts storage lacks. */
  resume(
    uploadId: string,
    file: FileBody,
    options: Pick<
      UploadFileOptions,
      "title" | "artifactType" | "description" | "relativePath" | "signal"
    > = {},
  ): Promise<UploadComplete> {
    return this.sendParts(uploadId, asBlob(file), options);
  }

  private async sendParts(
    uploadId: string,
    blob: Blob,
    options: Pick<
      UploadFileOptions,
      "title" | "artifactType" | "description" | "relativePath" | "signal"
    > & {
      path?: string;
    },
  ): Promise<UploadComplete> {
    try {
      const state = await this.get(uploadId);
      if (state.content_length !== blob.size) {
        throw new BeakrError(
          `Upload ${uploadId} is for a ${state.content_length}-byte file; this one is ${blob.size} bytes`,
          { code: "size_mismatch" },
        );
      }
      const etags = new Map<number, string>();
      for (const part of state.uploaded_parts ?? []) etags.set(part.part_number, part.etag);
      const missing: number[] = [];
      for (let n = 1; n <= state.part_count; n += 1) if (!etags.has(n)) missing.push(n);
      for (let start = 0; start < missing.length; start += PRESIGN_WINDOW) {
        const signed = await this.presignParts(uploadId, missing.slice(start, start + PRESIGN_WINDOW));
        for (const part of signed.parts) {
          const from = (part.part_number - 1) * state.part_size;
          const response = await this.transport.putExternal(
            part.url,
            blob.slice(from, from + state.part_size),
            { signal: options.signal },
          );
          etags.set(part.part_number, response.headers.get("etag") ?? "");
        }
      }
      return await this.complete(uploadId, {
        parts: [...etags.entries()]
          .sort(([a], [b]) => a - b)
          .map(([part_number, etag]) => ({ part_number, etag })),
        title: options.title ?? options.path?.split("/").pop(),
        artifactType: options.artifactType,
        description: options.description,
        relativePath: options.relativePath,
      });
    } catch (error) {
      if (resumable(error)) throw new UploadInterruptedError(uploadId, error);
      throw error;
    }
  }
}
