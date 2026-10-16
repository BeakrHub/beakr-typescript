/**
 * The public source record: where a cited source lives and what it says.
 *
 * One shape for every surface that shows a source -- `knowledge.pages.sources()`,
 * `runs.answer()`, the CLI's `kb sources`/`kb cat` and the MCP server -- so a
 * program reads `filename`, `provider` and `location` the same way wherever the
 * source came from. A port of the Python SDK's `beakr_sdk/sources.py`; keep the
 * two in step. Empty fields are left out, and backend row fields (internal unit,
 * connector or version ids, hashes) are never forwarded.
 */

/** Where the original is: a provider URL or path, or Beakr's own copy (`file_id`). */
export interface SourceLocation {
  url?: string;
  /** Where the source lives (`deals/acme/memo.pdf`); `files.read` takes it, with ` › <unit>`. */
  display_path?: string;
  /** Where the cited passage sits in it: `p. 7`, `slide 3`, `sheet 2, B4:D9`. */
  unit_locator?: string;
  /** The uploader's relative path, when recorded and different from `display_path`. */
  upload_path?: string;
  provider_item_id?: string;
  /** Beakr's copy of the document: `beakr.files.download(file_id)`. */
  file_id?: string;
  /** The version of Beakr's copy the passage was read from. */
  version_id?: string;
}

export interface SourceEvidence {
  excerpt?: string;
  locator?: string;
  fidelity?: string;
  evidence_kind?: string;
  anchor_status?: string;
}

/** One cited passage of a compact record's document. */
export interface SourceExcerpt {
  citation_key?: string;
  section_id?: string;
  unit_locator?: string;
  text?: string;
}

export interface SourceStatus {
  observed_at?: string;
  availability?: string;
  changed_since_cited?: boolean;
}

export interface SourceSection {
  id?: string;
  title?: string;
  event_start?: string;
  event_end?: string;
  date_precision?: string;
}

export interface SourceRecord {
  /** Opaque; reuse it in a Knowledge write citation. */
  source_ref?: string;
  /** The `{{key}}` token in page or answer text. */
  citation_key?: string;
  name: string;
  filename?: string;
  /** The connector it came from; absent for an uploaded file. */
  provider?: string;
  source_kind?: string;
  /** Page sources: how the source bears on the section (support, qualifies, contradicts). */
  stance?: string;
  location?: SourceLocation;
  evidence?: SourceEvidence;
  status?: SourceStatus;
  section?: SourceSection;
  /** Compact reads: the document's cited passages, each with its token and place. */
  excerpts?: SourceExcerpt[];
  /** Compact reads: how many passages of the document the page cites. */
  cited_passages?: number;
  retrieval?: { tool: string; arguments: { handle: string } };
}

type Row = Record<string, unknown>;

const isEmpty = (value: unknown): boolean =>
  value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);

const asRow = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};

function cleaned<T extends object>(value: Record<string, unknown>): T | undefined {
  const kept = Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined && v !== null && v !== ""),
  );
  return Object.keys(kept).length ? (kept as T) : undefined;
}

function basename(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] ?? path;
}

/** Keep only the public source contract; never forward backend row fields. */
/** `provider` of a source uploaded to Beakr rather than synced from a connector. */
export const UPLOAD_PROVIDER = "upload";

export function publicSource(source: Row, citationKey?: string): SourceRecord {
  const meta = asRow(source["meta"]);
  const location = asRow(source["location"]);
  const evidence = asRow(source["evidence"]);
  const status = asRow(source["status"]);
  const section = asRow(source["section"]);
  const retrieval = asRow(source["retrieval"]);

  const first = (...keys: string[]): unknown => {
    for (const key of keys) {
      if (!isEmpty(source[key])) return source[key];
      if (!isEmpty(meta[key])) return meta[key];
    }
    return undefined;
  };
  const str = (value: unknown): string | undefined => (isEmpty(value) ? undefined : String(value));

  const name = String(first("name", "source_title", "title") ?? "Untitled source");
  const kind = str(first("source_kind", "unit_kind", "type", "source_type"));
  const path = str(location["display_path"] ?? first("display_path", "path", "local_path"));
  let filename = str(first("filename", "file_name"));
  if (!filename && path) filename = basename(path);
  if (!filename && ["file", "document", "artifact"].includes((kind ?? "").toLowerCase())) filename = name;
  const fileIdValue = first("artifact_id");
  // Every document Beakr holds (uploaded or synced) is a file whose bytes
  // files.download(id) returns; its artifact_id is that public id.
  const fileId = str(location["file_id"] ?? (typeof fileIdValue === "string" ? fileIdValue : undefined));
  const url = str(location["url"] ?? first("url", "web_view_url", "full_text_url", "pdf_url"));
  let provider = str(first("provider", "source_provider"));
  // A file Beakr holds itself: no connector to name, no original elsewhere.
  if (!provider && (first("origin") === "upload" || (fileId && !url))) provider = UPLOAD_PROVIDER;

  const item: Record<string, unknown> = {
    source_ref: str(first("source_ref")),
    citation_key: citationKey ?? str(first("citation_key", "key")),
    name,
    filename,
    provider,
    source_kind: kind,
    stance: typeof source["stance"] === "string" ? source["stance"] : undefined,
    location: cleaned<SourceLocation>({
      url,
      display_path: path,
      unit_locator: str(location["unit_locator"]),
      upload_path: str(location["upload_path"]),
      provider_item_id: str(location["provider_item_id"] ?? first("provider_file_id", "remote_file_id")),
      file_id: fileId,
      version_id: fileId ? str(location["version_id"]) : undefined,
    }),
    evidence: cleaned<SourceEvidence>({
      excerpt: str(evidence["excerpt"] ?? first("excerpt", "excerpt_text", "quote")),
      locator: str(evidence["locator"] ?? first("locator", "chunk_ref")),
      fidelity: str(evidence["fidelity"] ?? first("fidelity")),
      evidence_kind: str(evidence["evidence_kind"] ?? first("evidence_kind")),
      anchor_status: str(evidence["anchor_status"] ?? first("anchor_status")),
    }),
    status: cleaned<SourceStatus>({
      observed_at: str(status["observed_at"] ?? first("observed_at")),
      availability: str(status["availability"] ?? first("source_availability")),
      changed_since_cited:
        "changed_since_cited" in status ? status["changed_since_cited"] : first("source_moved"),
    }),
    section: cleaned<SourceSection>({
      id: str(section["id"] ?? source["section_id"]),
      title: str(section["title"] ?? first("section_title")),
      event_start: str(section["event_start"] ?? first("event_start")),
      event_end: str(section["event_end"] ?? first("event_end")),
      date_precision: str(section["date_precision"] ?? first("date_precision")),
    }),
  };
  // A compact record carries its document's passages as `excerpts`, each with
  // its token and where it sits, and how many it cites. Dropping them left a
  // Sources listing with no excerpt for compact reads.
  const excerpts = (Array.isArray(source["excerpts"]) ? source["excerpts"] : [])
    .map(asRow)
    .filter((excerpt) => !isEmpty(excerpt["text"]))
    .map((excerpt) =>
      Object.fromEntries(
        (["citation_key", "section_id", "unit_locator", "text"] as const)
          .filter((key) => !isEmpty(excerpt[key]))
          .map((key) => [key, String(excerpt[key])]),
      ) as SourceExcerpt,
    );
  if (excerpts.length) item["excerpts"] = excerpts;
  if (typeof source["cited_passages"] === "number" && Number.isInteger(source["cited_passages"])) {
    item["cited_passages"] = source["cited_passages"];
  }
  const args = asRow(retrieval["arguments"]);
  if (typeof retrieval["tool"] === "string" && retrieval["tool"] && typeof args["handle"] === "string" && args["handle"]) {
    item["retrieval"] = { tool: retrieval["tool"], arguments: { handle: args["handle"] } };
  }
  return Object.fromEntries(Object.entries(item).filter(([, v]) => !isEmpty(v))) as unknown as SourceRecord;
}

/**
 * The command that fetches a source's bytes when it has no original to link to.
 * A connector file's original lives with its provider (`location.url`); an
 * uploaded file exists only in Beakr, so it is read back by its file id.
 */
export function downloadHint(record: SourceRecord): string | undefined {
  const location = record.location ?? {};
  if (!location.file_id || location.url) return undefined;
  return `beakr files download ${location.file_id}`;
}

/** One line saying where a source lives: `filename · provider · url-or-path`. */
export function sourceWhere(record: SourceRecord): string {
  const location = record.location ?? {};
  const label = record.filename ?? record.name;
  const parts = [label, record.provider].filter(Boolean) as string[];
  if (location.url) parts.push(location.url);
  // A path that is just the filename again says nothing new.
  else if (location.display_path && location.display_path !== label) parts.push(location.display_path);
  const hint = downloadHint(record);
  if (hint) parts.push(`file ${location.file_id} (\`${hint}\`)`);
  return parts.join(" · ");
}
