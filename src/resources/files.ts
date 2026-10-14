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

/** One window of a file's text (`POST /v1/artifacts/read`). */
export type FileRead = ResponseOf<"/v1/artifacts/read", "post">;

export interface ReadFileOptions {
  /** The place to read around (`p. 7`, `slide 3`, `sheet 2, B4:D9`, `lines 10-30`). */
  unit?: string;
  /** Without a unit: the first character to return (default 0). */
  offset?: number;
  /** The most characters to return (default and maximum 20,000; a unit's window is at most 6,000). */
  maxChars?: number;
  signal?: AbortSignal;
}

/**
 * Files: reading a file by any reference a Knowledge read hands out, and the
 * download helpers (the Python SDK's `files.read`, `download_url`, `download`).
 */
export class Files extends Resource {
  /**
   * Read a file's extracted text by a file id, a version id, a citation token
   * (`{{artifact:<uuid>-u3}}`) or its path as a Sources line prints it
   * (`deals/acme/Closing/memo.docx`, or a trailing part naming one file).
   * With `unit`, or ` › <unit>` after the path (`memo.pdf › p. 7`), the window is the
   * text around that place; a token's own passage is its unit. Continue a plain
   * read with `next_offset` as `offset`, a paged unit with `next_reference`.
   * Rejects with `NotFoundError` when the reference reaches no readable file and
   * `ConflictError` (`ambiguous_reference`) when a path names several.
   */
  read(reference: string, options: ReadFileOptions = {}): Promise<FileRead> {
    const body: BodyOf<"/v1/artifacts/read", "post"> = {
      reference: options.unit ? `${reference}#${options.unit}` : reference,
      offset: options.offset ?? 0,
      max_chars: options.maxChars ?? 20_000,
    };
    return this.transport.request<FileRead>({
      method: "POST",
      path: "/v1/artifacts/read",
      body,
      idempotent: true,
      signal: options.signal,
    });
  }

  /** A short-lived presigned URL for the current version's original bytes. */
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
