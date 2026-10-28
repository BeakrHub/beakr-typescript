import type { QuerySpec } from "./query-spec.js";
import type { ResponseMeta } from "../core.js";
import { KnowledgeCommandError } from "../errors.js";
import { publicSource, type SourceRecord } from "../sources.js";
import type { JsonObject, ResponseOf, components } from "../types.js";
import { Resource, enc } from "./base.js";

/**
 * How long a research call waits for its answer, whatever the client's timeout:
 * the engine gives the research route up to 150s (an agentic loop that reads
 * documents from connected services), so a 60s client would give up first.
 */
export const RESEARCH_TIMEOUT_MS = 170_000;
/** Milliseconds a quick research call waits: the engine ends a quick run within 16s. */
export const QUICK_RESEARCH_TIMEOUT_MS = 30_000;

/** A documents command's response; a `search` adds `results`. */
export type DocumentsResult = ResponseOf<"/v1/knowledge/documents", "post">;

/** A research answer: `text`, `answer`, `sources`, `engine`, `stopped_early`, ... */
export type ResearchResult = ResponseOf<"/v1/knowledge/research", "post">;

export interface DocumentsSearchOptions {
  /** Documents per page (default 8, max 25). */
  limit?: number;
  /** Documents to skip. */
  offset?: number;
  /** Best passages per document (default 2, max 5). */
  passages?: number;
  /** A folder, a glob, or one document's path. */
  path?: string;
  /** Drive-path globs; `!` excludes. */
  glob?: string | string[];
  /** File kinds: pdf, docx, xlsx, csv, pptx, md, txt, email, ... */
  type?: string | string[];
  /** Search inside one document: id, path, title or citation token. */
  document?: string;
  /** A project id or name; omit for everything you can read. */
  projectId?: string;
}

/** The `rows` command's filters (every map card's Facts, Connections or Findings rows). */
export interface RowsOptions {
  /** Card type to read. */
  pageType?: string;
  /** Card titles containing this. */
  entity?: string;
  /** Field name: Facts attribute, Connections relation, Findings kind. */
  attribute?: string;
  /** Rows whose text contains this. */
  query?: string;
  /** Connections only: rows pointing at this page. */
  to?: string;
  /** Only cards linked to this page, in either direction. */
  connectedTo?: string;
  /** Facts only: each card's value on this day (YYYY-MM-DD). */
  asOf?: string;
  /** When window start. */
  startDate?: string;
  /** When window end. */
  endDate?: string;
  /** Facts: the current value per attribute. */
  currentOnly?: boolean;
  /** Counts and totals per group (entity, entity_type, year or a column) instead of rows. */
  groupBy?: string;
  /** Read attribute, to and query as case-insensitive regular expressions. */
  regex?: boolean;
  /**
   * `values` (default), `fields` (field names, counts, examples), `groups`, or
   * `conflicts` (Facts: pairs of rows on one card giving one field different values
   * with overlapping or missing When).
   */
  view?: "values" | "fields" | "groups" | "conflicts";
  /** Exactly one field, as the field inventory names it. */
  fieldId?: string;
  /**
   * How `attribute` finds a field and `query` matches values: `meaning` (the default),
   * `similar` (words only) or `exact`.
   */
  match?: "exact" | "similar" | "meaning";
  /** Continue a card scan that stopped at its cap, after this card id. */
  afterCard?: string;
  /** Column to sort by (Facts also `amount` or `date`). */
  orderBy?: string;
  descending?: boolean;
  limit?: number;
  offset?: number;
  includeEvidence?: boolean;
  /** A project name or id. */
  scope?: string;
}

/** `RowsOptions` keys as the `rows` command names them. */
const ROWS_ARGUMENTS: Record<Exclude<keyof RowsOptions, "scope">, string> = {
  pageType: "page_type",
  entity: "entity",
  attribute: "attribute",
  query: "query",
  to: "to",
  connectedTo: "connected_to",
  asOf: "as_of",
  startDate: "start_date",
  endDate: "end_date",
  currentOnly: "current_only",
  groupBy: "group_by",
  regex: "regex",
  view: "view",
  fieldId: "field_id",
  match: "match",
  afterCard: "after_card",
  orderBy: "order_by",
  descending: "descending",
  limit: "limit",
  offset: "offset",
  includeEvidence: "include_evidence",
};

/** Options for {@link Knowledge.research}. */
export interface ResearchOptions {
  /** A short cited answer within 15 seconds from one search. */
  quick?: boolean;
}

/** The door's reply: `{content: [{type, text}], outcome, sources}`; a refusal's `outcome.error_code` names why. */
export interface KnowledgeResult extends JsonObject {
  content?: { type: string; text?: string }[];
  outcome?: { status?: string; error_code?: string; [key: string]: unknown };
  sources?: unknown[];
}

/** Who filed a proposal: the person, and the API credential, client, agent and run used. */
export type ProposalFiledBy = components["schemas"]["ProposalFiledBy"];

/** The proposal a section or row write staged: its `id`, `content_hash` (an accept's `reviewedHash`) and `filed_by`. */
export type StagedProposal = components["schemas"]["StagedProposalRef"];

/**
 * A write's reply. A write that stages a proposal for one section or card row
 * (`edit_section`, `add_fact`, `add_connection`, `add_finding`, `edit_rows`)
 * names it in `proposal`, so it can be accepted with its `content_hash` as the
 * reviewed hash.
 */
export interface KnowledgeWriteResult extends KnowledgeResult {
  proposal?: StagedProposal | null;
}

/** One proposal as the proposals routes return it, with who filed it (`filed_by`). */
export type WikiProposal = ResponseOf<"/v1/knowledge/wiki/proposals/{proposal_id}", "get">;

/** A page of proposals: `{data, next_cursor, has_more}`. */
export type WikiProposalPage = ResponseOf<"/v1/knowledge/wiki/proposals", "get">;

/** One proposal as a page of {@link WikiProposalPage} lists it. */
export type ListedWikiProposal = WikiProposalPage["data"][number];

export interface DoorOptions {
  /** A project id or name to read or write in. */
  scope?: string;
  /** Reject with KnowledgeCommandError when the door reports `outcome.status === "error"`. Default true. */
  check?: boolean;
}

/** The text parts of a door reply, joined. */
export function resultText(result: KnowledgeResult): string {
  return (result.content ?? [])
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join("\n");
}

function checked<R extends KnowledgeResult>(result: R, check: boolean, meta?: ResponseMeta): R {
  if (check && result.outcome?.status === "error") {
    // The door's outcome protocol (`beakr.wiki_tool_outcome.v1`) names the
    // refusal in `error_code`; `code` is read only as a fallback.
    const outcomeCode = result.outcome["error_code"] ?? result.outcome["code"];
    throw new KnowledgeCommandError(resultText(result) || "The Knowledge command was refused.", result, {
      status: meta?.status,
      requestId: meta?.requestId,
      ...(typeof outcomeCode === "string" && outcomeCode ? { code: outcomeCode } : {}),
    });
  }
  return result;
}

/** The filters and paging `GET /v1/knowledge/wiki/proposals` takes. */
export interface ListProposalsQuery {
  /** `pending` (the default), `dismissed`, ... */
  status?: string;
  projectId?: string;
  groupId?: string;
  labelId?: string;
  /** The proposals one write batch staged. */
  batchId?: string;
  source?: string;
  cursor?: string;
  limit?: number;
}

function proposalsQuery(query: ListProposalsQuery): Record<string, string | number | undefined> {
  return {
    status: query.status,
    project_id: query.projectId,
    group_id: query.groupId,
    label_id: query.labelId,
    batch_id: query.batchId,
    source: query.source,
    cursor: query.cursor,
    limit: query.limit,
  };
}

class Proposals extends Resource {
  /** One page of proposals (pending by default); {@link iter} follows every page. */
  list(query: ListProposalsQuery = {}): Promise<WikiProposalPage> {
    return this.transport.request({ method: "GET", path: "/v1/knowledge/wiki/proposals", query: proposalsQuery(query) });
  }

  /** Every proposal matching the filters, following cursors. */
  iter(query: Omit<ListProposalsQuery, "cursor" | "limit"> = {}, pageSize?: number): AsyncGenerator<ListedWikiProposal> {
    return this.transport.paginate(
      { method: "GET", path: "/v1/knowledge/wiki/proposals", query: proposalsQuery(query) },
      pageSize,
    );
  }

  get(proposalId: string): Promise<WikiProposal> {
    return this.transport.request({ method: "GET", path: `/v1/knowledge/wiki/proposals/${enc(proposalId)}` });
  }

  /**
   * Apply a proposal. `reviewedHash` is the `content_hash` of the {@link get} you
   * reviewed, sent unchanged: a proposal that changed since is refused (409
   * `proposal_changed`) and nothing is applied, and a proposal that changes a card's
   * table rows can require it (422 `review_required`). This never reads the proposal
   * to fill it in, because a hash from a read made at accept time would bind the
   * accept to whatever the proposal is then rather than to what was reviewed.
   */
  accept(proposalId: string, options: { reviewedHash?: string } = {}): Promise<unknown> {
    return this.transport.request({
      method: "POST",
      path: `/v1/knowledge/wiki/proposals/${enc(proposalId)}/accept`,
      ...(options.reviewedHash !== undefined ? { body: { reviewed_hash: options.reviewedHash } } : {}),
    });
  }

  dismiss(proposalId: string): Promise<unknown> {
    return this.transport.request({ method: "POST", path: `/v1/knowledge/wiki/proposals/${enc(proposalId)}/dismiss` });
  }
}

/** Knowledge pages over REST, as structured records. */
class Pages extends Resource {
  /**
   * Every source that fed a page, as public source records: filename,
   * provider, `location` (the original's URL or path, or `file_id` for Beakr's
   * copy), the cited excerpt, its stance and the section it backs.
   */
  async sources(pageId: string): Promise<SourceRecord[]> {
    const records: SourceRecord[] = [];
    for await (const row of this.transport.paginate<Record<string, unknown>>(
      { method: "GET", path: `/v1/knowledge/wiki/pages/${enc(pageId)}/sources` },
      200,
    )) {
      records.push(publicSource(row));
    }
    return records;
  }
}

/**
 * Knowledge through the same door Beakr's own agents use: `command` runs a
 * read (`ls`, `cat`, `sections`, `grep`, `rows`, `timeline`, ...), `write`
 * stages a change (`new`, `edit_section`, `add_fact`, ...).
 */
export class Knowledge extends Resource {
  readonly proposals = new Proposals(this.transport);
  readonly pages = new Pages(this.transport);

  async command(command: string, args: JsonObject = {}, options: DoorOptions = {}): Promise<KnowledgeResult> {
    const body: JsonObject = { ...args, command };
    if (options.scope) body["scope"] = options.scope;
    let meta: ResponseMeta | undefined;
    const result = await this.transport.request<KnowledgeResult>({
      method: "POST",
      path: "/v1/knowledge/wiki/command",
      body,
      onResponse: (received) => {
        meta = received;
      },
    });
    return checked(result, options.check ?? true, meta);
  }

  /**
   * Every action except `page_type` needs a `rationale`. A write that stages a
   * proposal for one section or card row answers with `proposal`.
   */
  async write(action: string, args: JsonObject = {}, options: DoorOptions = {}): Promise<KnowledgeWriteResult> {
    const body: JsonObject = { ...args, action };
    if (options.scope) body["scope"] = options.scope;
    let meta: ResponseMeta | undefined;
    const result = await this.transport.request<KnowledgeWriteResult>({
      method: "POST",
      path: "/v1/knowledge/wiki/write",
      body,
      onResponse: (received) => {
        meta = received;
      },
    });
    return checked(result, options.check ?? true, meta);
  }

  /**
   * Ask a question of every map card's rows (the `query` command), as SQL or a
   * spec. `{ sql }` is one SELECT, such as `SELECT value, COUNT(DISTINCT entity) AS
   * cards FROM facts AS OF CURRENT_DATE WHERE entity_type = 'matter' AND field =
   * 'Current status' GROUP BY value ORDER BY cards DESC`; the engine parses it into
   * a spec and never runs it as SQL (`FROM` facts, connections or findings, up to
   * two `JOIN`s on `SAME_CARD(a)` or `TARGET_CARD(a)`, `WHERE` with AND/OR/NOT,
   * `AS OF` a day, `GROUP BY`, `COUNT`/`MIN`/`MAX`/`SUM`/`AVG`, `ORDER BY`, `LIMIT`).
   * A {@link QuerySpec} is the same query as JSON. Only cards you can read are
   * queried; `scope` narrows them to one project (name or id); `cursor` continues
   * a previous answer. Where enabled for the organization. The answer's text opens
   * with what the query was understood as (for SQL the spec it was translated to,
   * how each name resolved, what was defaulted or applied), then the total and a
   * table; its `query` holds the same as data (`spec`, `columns`, `rows`, `total`,
   * `next_cursor`). A query the engine cannot run throws a `KnowledgeCommandError`
   * (`invalid_arguments`).
   */
  query(
    query: QuerySpec | { sql: string },
    options: { scope?: string; cursor?: string } = {},
  ): Promise<KnowledgeResult> {
    const args: JsonObject =
      "sql" in query ? { sql: query.sql } : { spec: query as unknown as JsonObject };
    if (options.cursor) args["cursor"] = options.cursor;
    return this.command("query", args, options.scope ? { scope: options.scope } : {});
  }

  /**
   * Every map card's `facts`, `connections` or `findings` rows as one table (the
   * `rows` command), filtered and walked by {@link RowsOptions}.
   */
  rows(table: "facts" | "connections" | "findings" = "facts", options: RowsOptions = {}): Promise<KnowledgeResult> {
    const { scope, ...rest } = options;
    const args: JsonObject = { table };
    for (const [key, name] of Object.entries(ROWS_ARGUMENTS)) {
      const value = rest[key as keyof typeof rest];
      if (value !== undefined) args[name] = value as JsonObject[string];
    }
    return this.command("rows", args, scope ? { scope } : {});
  }

  /**
   * Search/read/list original indexed documents. Scan notices describe incomplete
   * results. `projectId` is a project id or name; without it a command covers
   * everything you can read.
   */
  documents(
    command: "grep" | "read" | "ls" | "search",
    args: JsonObject = {},
    projectId?: string,
  ): Promise<DocumentsResult> {
    return this.transport.request({
      method: "POST",
      path: "/v1/knowledge/documents",
      body: { command, arguments: args, ...(projectId ? { project_id: projectId } : {}) },
    });
  }

  /**
   * Passages of the original documents ranked by meaning, grouped by document
   * (`documents` `search`). For when you do not know a document's words; `grep`
   * finds and counts every literal mention. The response's `results` is one source
   * record per matching document, best first (`source_ref`, `location` with
   * `display_path`, `file_id` and `version_id`, `match`, `score`, and its best
   * `passages`). Download a result's file with `files.downloadLink(sourceRef)`.
   */
  documentsSearch(query: string, options: DocumentsSearchOptions = {}): Promise<DocumentsResult> {
    const { projectId, ...rest } = options;
    const args: JsonObject = { query };
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) args[key] = value as JsonObject[string];
    }
    return this.documents("search", args, projectId);
  }

  /**
   * A cited answer from Knowledge and connected sources. Waits up to
   * {@link RESEARCH_TIMEOUT_MS} (or the client's timeout, if longer): the engine
   * allows research up to 150s. With `{ quick: true }` the engine answers within
   * 15 seconds from one search of Knowledge and uploaded files (no connected
   * sources); the answer's `engine` is `quick`, and `stopped_early` is true when
   * it is the cited results without a written summary.
   */
  research(query: string, projectId?: string, options: ResearchOptions = {}): Promise<ResearchResult> {
    return this.transport.request({
      method: "POST",
      path: "/v1/knowledge/research",
      body: {
        query,
        ...(projectId ? { project_id: projectId } : {}),
        ...(options.quick ? { quick: true } : {}),
      },
      minTimeoutMs: options.quick ? QUICK_RESEARCH_TIMEOUT_MS : RESEARCH_TIMEOUT_MS,
    });
  }
}
