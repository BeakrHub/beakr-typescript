import { NotFoundError } from "../errors.js";
import type { BodyOf, JsonObject, ResponseOf } from "../types.js";
import { Resource, enc } from "./base.js";
import { nodeBuiltin } from "../node-builtins.js";

export interface DownloadLocation {
  url: string;
  artifact: JsonObject;
}

export interface DownloadedFile {
  data: Uint8Array;
  /** The original file name (else the title, else the id), with no directory. */
  filename: string;
  artifact: JsonObject;
}

function baseName(name: string): string {
  return name.split(/[\\/]/).pop() || name;
}

/** A signed download of a file's original bytes (`POST /v1/artifacts/download-url`). */
export type DownloadLink = ResponseOf<"/v1/artifacts/download-url", "post">;

/** A file's bytes saved from {@link Files.downloadReference}. */
export interface DownloadedReference {
  data: Uint8Array;
  filename: string;
  file: DownloadLink["file"];
}

/** One window of a file's text (`POST /v1/artifacts/read`). */
export type FileRead = ResponseOf<"/v1/artifacts/read", "post">;

export interface ReadFileOptions {
  /** The place to read around (`p. 7`, `slide 3`, `sheet 2, B4:D9`, `lines 10-30`). */
  unit?: string;
  /** Without a unit: the first character to return (default 0). */
  offset?: number;
  /** The most characters to return (default and maximum 20,000; a unit's window is at most 6,000). */
  maxChars?: number;
  /**
   * Only open a file in this project (its id or name). A project you cannot read
   * rejects with `NotFoundError`, naming the closest ones.
   */
  project?: string;
  signal?: AbortSignal;
}

/**
 * Files: reading a file by any reference a Knowledge read hands out, and the
 * download helpers (the Python SDK's `files.read`, `download_url`, `download`).
 */
export class Files extends Resource {
  /**
   * Read a file's extracted text by a file id, a version id, a source record's
   * `source_ref` (`beakr-source:v1:...`, from any Knowledge read or research
   * answer), a citation token (`{{artifact:<uuid>-u3}}`) or its path as a Sources
   * line prints it (`deals/acme/Closing/memo.docx`, or a trailing part naming one
   * file). With `unit`, or ` › <unit>` after the reference (`memo.pdf › p. 7`), the
   * window is the text around that place; a token's or source_ref's own passage is
   * its unit. Continue a plain read with `next_offset` as `offset`, a paged unit
   * with `next_reference`. Rejects with `NotFoundError` when the reference reaches
   * no readable file, `ConflictError` (`ambiguous_reference`) when a path names
   * several, and `ValidationError` for a Knowledge page's source_ref
   * (`knowledge_page`: read it with the knowledge_base `cat` command) or a
   * connected item's (`not_a_file`): only uploads and canvases are files.
   */
  read(reference: string, options: ReadFileOptions = {}): Promise<FileRead> {
    const body: BodyOf<"/v1/artifacts/read", "post"> = {
      reference: options.unit ? `${reference}#${options.unit}` : reference,
      offset: options.offset ?? 0,
      max_chars: options.maxChars ?? 20_000,
      ...(options.project ? { project: options.project } : {}),
    };
    return this.transport.request<FileRead>({
      method: "POST",
      path: "/v1/artifacts/read",
      body,
      idempotent: true,
      signal: options.signal,
    });
  }

  /**
   * A short-lived signed URL for a file's original bytes, by any reference
   * {@link Files.read} takes: a source record's `source_ref` (from a Knowledge
   * read, research answer or documents search), a file or version id, a citation
   * token or a path. A reference that names a version downloads that version; any
   * other, the current one. Rejects with `ValidationError` for a Knowledge page's
   * or connected item's reference (`knowledge_page`, `not_a_file`), `ConflictError`
   * for a Beakr document with no stored original (`no_original_file`) and
   * `NotFoundError` for a file you cannot read.
   */
  downloadLink(
    reference: string,
    options: { inline?: boolean; signal?: AbortSignal } = {},
  ): Promise<DownloadLink> {
    const body: BodyOf<"/v1/artifacts/download-url", "post"> = {
      reference,
      inline: options.inline ?? false,
    };
    return this.transport.request<DownloadLink>({
      method: "POST",
      path: "/v1/artifacts/download-url",
      body,
      idempotent: true,
      signal: options.signal,
    });
  }

  /** The original bytes and name of the file a reference names, in any runtime. */
  async downloadReference(
    reference: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<DownloadedReference> {
    const link = await this.downloadLink(reference, options);
    const data = await this.transport.getExternalBytes(link.url, options);
    return { data, filename: baseName(String(link.filename || reference)), file: link.file };
  }

  /**
   * A short-lived presigned URL for the current version's original bytes.
   * {@link Files.downloadLink} does this in one request, from any reference.
   */
  async downloadUrl(artifactId: string): Promise<DownloadLocation> {
    const artifact = await this.transport.request<JsonObject>({
      method: "GET",
      path: `/v1/artifacts/${enc(artifactId)}`,
    });
    const versionId = artifact["current_version_id"];
    if (!versionId) {
      throw new NotFoundError(`File ${artifactId} has no uploaded version to download.`, {
        code: "not_found",
      });
    }
    const signed = await this.transport.request<{ url: string }>({
      method: "GET",
      path: `/v1/artifacts/versions/${enc(String(versionId))}/download-url`,
    });
    return { url: signed.url, artifact };
  }

  /** The original file's bytes and name, in any runtime. */
  async download(artifactId: string, options: { signal?: AbortSignal } = {}): Promise<DownloadedFile> {
    const located = await this.downloadUrl(artifactId);
    const data = await this.transport.getExternalBytes(located.url, options);
    const name = located.artifact["original_filename"] ?? located.artifact["title"] ?? artifactId;
    return { data, filename: baseName(String(name)), artifact: located.artifact };
  }

  /**
   * Save the original file (Node). `destination` may be an existing directory,
   * in which case the file keeps its original name. Resolves to the path written.
   */
  async downloadTo(artifactId: string, destination: string): Promise<string> {
    const fs = await nodeBuiltin<typeof import("node:fs/promises")>("node:fs/promises");
    const nodePath = await nodeBuiltin<typeof import("node:path")>("node:path");
    const file = await this.download(artifactId);
    let target = destination;
    const existing = await fs.stat(destination).catch(() => undefined);
    if (existing?.isDirectory()) target = nodePath.join(destination, file.filename);
    await fs.mkdir(nodePath.dirname(target), { recursive: true });
    await fs.writeFile(target, file.data);
    return target;
  }
}
