import type { QuerySpec } from "./query-spec.js";
import { cleanBody, type ResponseMeta } from "../core.js";
import { ConflictError, KnowledgeCommandError, NotFoundError, ValidationError } from "../errors.js";
import { publicSource, type SourceRecord } from "../sources.js";
import type { BodyOf, JsonObject, ResponseOf, components } from "../types.js";
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

/** The card types a project uses (`GET /v1/knowledge/wiki/page-types`): `{ page_types, map_mode }`. */
export type CardTypeList = ResponseOf<"/v1/knowledge/wiki/page-types", "get">;
/** One card type as the narrowest scope that defines it holds it. */
export type CardType = CardTypeList["page_types"][number];
/** A changed card type (`PATCH /v1/knowledge/wiki/page-types/{key}`): `{ page_type }`. */
export type CardTypeSaved = ResponseOf<"/v1/knowledge/wiki/page-types/{key}", "patch">;
/** A removed copy (`DELETE /v1/knowledge/wiki/page-types/{key}`): `{ removed, key, scope }`. */
export type CardTypeCopyRemoved = ResponseOf<"/v1/knowledge/wiki/page-types/{key}", "delete">;
/** The fields a {@link Knowledge.updateCardType} call changes; a field left out is kept. */
export type CardTypeChanges = Omit<
  BodyOf<"/v1/knowledge/wiki/page-types/{key}", "patch">,
  "scope" | "project_id"
>;
/** What a copy or a promotion did: `{ copied, replaced, skipped }`. */
export type CardTypesCopied = ResponseOf<"/v1/knowledge/wiki/page-types/copy", "post">;

/** How a copy or a promotion treats a type the destination already defines. */
export interface CopyCardTypesOptions {
  /** Overwrite a type the destination already defines; otherwise it is skipped. */
  replace?: boolean;
}

/** What a field rename would change or changed on a type's existing cards. */
export type CardTypeFieldsRenamed = ResponseOf<"/v1/knowledge/wiki/page-types/{key}/rename-fields", "post">;
/** What a retype would move or moved. */
export type CardsRetyped = ResponseOf<"/v1/knowledge/wiki/page-types/{key}/retype-cards", "post">;
/** Field renames: `{ old: new }`, or the route's own list of `{ old, new }`. */
export type CardTypeFieldRenames = Record<string, string> | Array<{ old: string; new: string }>;

/** Whether a change to a project's existing cards is written. */
export interface ExistingCardsOptions {
  /** `false` writes the change. Left out or `true`: a dry run that answers the counts and writes nothing. */
  dryRun?: boolean;
  /**
   * The `undo_event_id` an earlier apply of this same change answered. This
   * call's cards join that activity entry, so a change that takes several calls
   * (one call writes at most 500 cards) is one entry and one undo.
   */
  continueEventId?: string;
}

/** {@link Knowledge.retypeCards}' options. */
export interface RetypeCardsOptions extends ExistingCardsOptions {
  /** The pending suggestion this move answers; an apply that leaves no card of the type marks it applied. */
  suggestionId?: string;
}

/** A project's card type settings: `{ inherit, agent_may_change }`. */
export type CardTypeSettings = NonNullable<CardTypeList["settings"]>;
/** What a settings change would do or did (`PUT /v1/knowledge/wiki/page-types/settings`). */
export type CardTypeSettingsChange = ResponseOf<"/v1/knowledge/wiki/page-types/settings", "put">;
/** One page of card type history: `{ data, next_cursor, has_more }`. */
export type CardTypeHistoryPage = ResponseOf<"/v1/knowledge/wiki/page-types/history", "get">;
/** One change to a card type, or a suggestion. */
export type CardTypeHistoryEntry = CardTypeHistoryPage["data"][number];
/** A dismissed suggestion: `{ suggestion, activity_event_id }`. */
export type CardTypeSuggestionDismissed = ResponseOf<
  "/v1/knowledge/wiki/page-types/suggestions/{suggestion_id}/dismiss",
  "post"
>;

/** The settings a {@link Knowledge.setCardTypeSettings} call changes. */
export interface CardTypeSettingsInput {
  /** `organization` (the organization's and the built-in types), `builtin` or `own` (only the project's). */
  inherit?: "organization" | "builtin" | "own";
  /** Whether Beakr itself may add or change the project's card types. */
  agentMayChange?: boolean;
  /** Make every type that would drop out and still has cards one of the project's own. */
  keepTypesInUse?: boolean;
  /** `false` writes the change. Left out or `true`: a dry run that lists what would drop out. */
  dryRun?: boolean;
}

/** Which changes `GET /v1/knowledge/wiki/page-types/history` lists. */
export interface CardTypeHistoryQuery {
  /** A project's changes (its id). */
  projectId?: string;
  /** `org` for the organization's changes. */
  scope?: "org" | "project";
  /** Only this type's changes. */
  key?: string;
  /** Add suggestions, each with its `state`. */
  includeSuggestions?: boolean;
  cursor?: string;
  limit?: number;
}

/** How many Knowledge compiles are queued and running, and the last cancel's progress. */
export type CompileQueue = ResponseOf<"/v1/projects/{project_id}/knowledge/compiles", "get">;
/** What a cancel of queued compiles reached. */
export type CompilesCancelled = ResponseOf<"/v1/projects/{project_id}/knowledge/compiles/cancel", "post">;

/** One source of a project's compiles: a connected source or an uploaded file. Give at most one. */
export interface CompileSource {
  /** A connected source's attachment id in the project. */
  attachmentId?: string;
  /** An uploaded file's id in the project. */
  artifactId?: string;
}

/** Which card types `GET /v1/knowledge/wiki/page-types` lists. */
export interface ListCardTypesQuery {
  /** The project's id. */
  projectId?: string;
  /** Include types that are only proposed. */
  includeProposed?: boolean;
  /** Include types that are turned off. */
  includeDeprecated?: boolean;
  /** Add `card_count` (live cards) to each type, and `unlisted_types`. */
  includeCounts?: boolean;
}

/** Whose copy of a card type a change or a removal applies to. */
export interface CardTypeScope<S extends string = "project" | "org"> {
  /** `project` (the default): one project. `org`: every project in the organization without its own copy. */
  scope?: S;
  /** The project's id, with scope `project`; left out otherwise. */
  projectId?: string;
}

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
  /**
   * Default true: a short cited answer within 15 seconds from one search of
   * Knowledge and documents. `false` runs the full researcher (up to 150s),
   * which also reads connected services.
   */
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

/**
 * How long drafting a review flag's resolutions may take: the engine drafts with
 * a model and stops within two minutes; options drafted before return at once.
 */
export const RESOLUTION_OPTIONS_TIMEOUT_MS = 150_000;

/** A review flag: the flagged section and its text, why, the sources on each side, `current_revision`. */
export type ReviewFlag = ResponseOf<"/v1/knowledge/wiki/proposals/{proposal_id}/conflict", "get">;
/** Drafted resolutions of a review flag: `{ proposal_id, section_id, current_revision, options, cached, no_draft_reason }`. */
export type ResolutionOptions = ResponseOf<"/v1/knowledge/wiki/proposals/{proposal_id}/resolutions", "post">;
/** One drafted resolution: `id` (A, B, ...), `label`, `summary`, `new_section_body`, and `edits` or `row_operation`. */
export type ResolutionOption = ResolutionOptions["options"][number];
/** A resolved flag: `{ status, proposal_id, page_id, section_id, new_revision }`. */
export type ReviewFlagResolved = ResponseOf<"/v1/knowledge/wiki/proposals/{proposal_id}/resolve", "post">;
/** One outcome applied on every card a contradiction lists: `{ status, proposal_id, updated, skipped }`. */
export type ContradictionResolved = ResponseOf<"/v1/knowledge/wiki/proposals/{proposal_id}/resolve-cards", "post">;
/** `keep_disputed`, `adopt_disputing` or `both_valid`. */
export type ContradictionOutcome = BodyOf<"/v1/knowledge/wiki/proposals/{proposal_id}/resolve-cards", "post">["outcome"];

/** How {@link Proposals.resolve} resolves a flag: exactly one of `optionId` and `sectionBody`. */
export interface ResolveReviewOptions {
  /** The page revision the options were drafted or the flag read against (`current_revision`). */
  expectedRevision: number;
  /** A drafted option: its id (`A`, `B`, ...) or its 1-based number in `options`. */
  optionId?: string | number;
  /** Instead of an option: the flagged section's new Markdown. */
  sectionBody?: string;
}

/** The drafted option by its id (any case) or 1-based number, else undefined. */
export function findResolutionOption(
  options: readonly ResolutionOption[],
  optionId: string | number,
): ResolutionOption | undefined {
  const wanted = String(optionId).trim();
  const byId = options.find((option) => String(option.id ?? "").trim().toLowerCase() === wanted.toLowerCase());
  if (byId) return byId;
  if (/^\d+$/.test(wanted)) {
    const number = Number(wanted);
    if (number >= 1 && number <= options.length) return options[number - 1];
  }
  return undefined;
}

function pageChanged(proposalId: string, expected: number, current: unknown): ConflictError {
  return new ConflictError(
    `The page changed since these options were drafted (revision ${expected}, now ${String(current)}); ` +
      "nothing was applied. Draft the options again and choose again.",
    {
      status: 409,
      code: "conflict",
      fix: `Call proposals.resolutionOptions("${proposalId}") again and choose from the new options.`,
    },
  );
}

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
  /**
   * One kind of proposal: `review` lists only review flags ({@link Proposals.reviewFlags});
   * others include `create`, `edit`, `archive`, `mv` and `find_replace`.
   */
  proposalType?: string;
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
    proposal_type: query.proposalType,
    cursor: query.cursor,
    limit: query.limit,
  };
}

class Proposals extends Resource {
  /** One page of proposals (pending by default); {@link iter} follows every page. */
  list(query: ListProposalsQuery = {}): Promise<WikiProposalPage> {
    return this.transport.request({ method: "GET", path: "/v1/knowledge/wiki/proposals", query: proposalsQuery(query) });
  }

  /**
   * One page of review flags only (`proposal_type=review`), open ones unless
   * `status` says otherwise: sections Knowledge flagged as contradicted,
   * unverifiable or unclear. Resolve one with {@link resolutionOptions} and {@link resolve}.
   */
  reviewFlags(query: Omit<ListProposalsQuery, "proposalType"> = {}): Promise<WikiProposalPage> {
    return this.list({ ...query, proposalType: "review" });
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

  /**
   * A review flag (a proposal of type `review`): the flagged section and its
   * current text, why it was flagged, the sources on each side, and the page's
   * `current_revision` to resolve against.
   */
  conflict(proposalId: string): Promise<ReviewFlag> {
    return this.transport.request({ method: "GET", path: `/v1/knowledge/wiki/proposals/${enc(proposalId)}/conflict` });
  }

  /**
   * Beakr's drafted resolutions for a pending review flag, each with what it
   * changes. Drafting uses a model and can take up to two minutes, so this waits
   * up to {@link RESOLUTION_OPTIONS_TIMEOUT_MS} whatever the client's timeout;
   * options drafted for the same page revision return at once (`cached: true`).
   * Drafting is open to any key with `kb:write`; applying is {@link resolve}.
   */
  resolutionOptions(proposalId: string): Promise<ResolutionOptions> {
    return this.transport.request({
      method: "POST",
      path: `/v1/knowledge/wiki/proposals/${enc(proposalId)}/resolutions`,
      minTimeoutMs: RESOLUTION_OPTIONS_TIMEOUT_MS,
    });
  }

  /**
   * Resolve a review flag: apply a drafted option (`optionId`) or your own text
   * for the flagged section (`sectionBody`), pinned to `expectedRevision`. A card
   * table option is applied as its row operation (`POST .../resolve-rows`), any
   * other as a section rewrite (`POST .../resolve`). The page's revision is read
   * first, and a page that changed since rejects with `ConflictError` before
   * anything is sent, so options drafted for a newer revision are never applied
   * unseen. Where the project requires a person to accept proposals, a person,
   * or a key with the `proposals:accept` (reviewer) permission, must apply it, as
   * for {@link accept}: any other key or token is refused with
   * `PersonReviewRequiredError` (403). A scheduled job closes flags with a reviewer key.
   */
  async resolve(proposalId: string, options: ResolveReviewOptions): Promise<ReviewFlagResolved> {
    const { expectedRevision, optionId, sectionBody } = options;
    const hasOption = optionId !== undefined && optionId !== null && String(optionId).trim() !== "";
    const hasBody = typeof sectionBody === "string" && sectionBody.trim() !== "";
    if (hasOption === hasBody) {
      throw new ValidationError("Pass exactly one of optionId or sectionBody.", { code: "validation_error" });
    }
    if (!Number.isInteger(expectedRevision)) {
      throw new ValidationError(
        "expectedRevision is required: the current_revision the options were drafted against.",
        { code: "validation_error" },
      );
    }
    const base = `/v1/knowledge/wiki/proposals/${enc(proposalId)}`;
    const flag = await this.conflict(proposalId);
    if (flag.current_revision !== expectedRevision) {
      throw pageChanged(proposalId, expectedRevision, flag.current_revision);
    }
    if (hasBody) {
      return this.transport.request({
        method: "POST",
        path: `${base}/resolve`,
        body: { section_id: flag.section_id, new_section_body: sectionBody, expected_revision: expectedRevision },
      });
    }
    const drafted = await this.resolutionOptions(proposalId);
    if (drafted.current_revision !== expectedRevision) {
      throw pageChanged(proposalId, expectedRevision, drafted.current_revision);
    }
    const option = findResolutionOption(drafted.options ?? [], optionId as string | number);
    if (option === undefined) {
      throw new NotFoundError(`Option ${String(optionId)} is not among this flag's drafted options.`, {
        status: 404,
        code: "not_found",
      });
    }
    if (option.row_operation) {
      return this.transport.request({
        method: "POST",
        path: `${base}/resolve-rows`,
        body: { option_id: option.id, expected_revision: expectedRevision },
      });
    }
    return this.transport.request({
      method: "POST",
      path: `${base}/resolve`,
      body: {
        section_id: drafted.section_id ?? flag.section_id,
        new_section_body: option.new_section_body,
        expected_revision: expectedRevision,
        option_id: option.id,
      },
    });
  }

  /**
   * Settle a contradiction review on every card it lists with one `outcome`.
   * A card that changed since the review, or that you cannot write, is skipped
   * and listed in `skipped`; with no card changed `status` is `unchanged` and the
   * review stays pending. Where the project requires a person, a person or a
   * `proposals:accept` (reviewer) key must apply it (`PersonReviewRequiredError` otherwise).
   */
  resolveOnEveryCard(proposalId: string, outcome: ContradictionOutcome): Promise<ContradictionResolved> {
    return this.transport.request({
      method: "POST",
      path: `/v1/knowledge/wiki/proposals/${enc(proposalId)}/resolve-cards`,
      body: { outcome },
    });
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
   * A cited answer from Knowledge and documents, quick by default: the engine
   * answers within 15 seconds from one search of Knowledge and uploaded files
   * (no connected sources); the answer's `engine` is `quick`, and
   * `stopped_early` is true when it is the cited results without a written
   * summary. `{ quick: false }` runs the full researcher, which also reads
   * connected sources; it waits up to {@link RESEARCH_TIMEOUT_MS} (or the
   * client's timeout, if longer), since the engine allows it up to 150s.
   */
  research(query: string, projectId?: string, options: ResearchOptions = {}): Promise<ResearchResult> {
    const quick = options.quick ?? true;
    return this.transport.request({
      method: "POST",
      path: "/v1/knowledge/research",
      body: {
        query,
        ...(projectId ? { project_id: projectId } : {}),
        ...(quick ? { quick: true } : {}),
      },
      minTimeoutMs: quick ? QUICK_RESEARCH_TIMEOUT_MS : RESEARCH_TIMEOUT_MS,
    });
  }

  /**
   * The card types a project uses. Each type is as the narrowest scope that
   * defines it holds it: `scope` is `project`, `org` or `global`, and
   * `metadata_schema` holds its fields (`key_attributes`), which are required
   * (`required_attributes`) and whether an instance is a card or a row (`grain`).
   */
  listCardTypes(query: ListCardTypesQuery = {}): Promise<CardTypeList> {
    return this.transport.request({
      method: "GET",
      path: "/v1/knowledge/wiki/page-types",
      query: {
        project_id: query.projectId,
        include_proposed: query.includeProposed,
        include_deprecated: query.includeDeprecated,
        include_counts: query.includeCounts,
      },
    });
  }

  /**
   * Change a card type as one scope holds it. A field left out is kept; a list
   * given replaces that list. `fields` is the type's fields in order, each
   * `{ name, required }`; `grain` is `card` or `row`; `status: "deprecated"`
   * turns the type off for the scope. Changing a type the scope only inherits
   * gives the scope its own copy, and `page_type.overrides` names the scope that
   * copy stands in front of ({@link removeCardTypeCopy} drops it). A project's
   * owners change its types and an organization's admins the organization's.
   * Cards already written are not rewritten; later compiles use the new
   * definition.
   */
  updateCardType(
    key: string,
    changes: CardTypeChanges,
    where: CardTypeScope<"project" | "org" | "global"> = {},
  ): Promise<CardTypeSaved> {
    return this.transport.request({
      method: "PATCH",
      path: `/v1/knowledge/wiki/page-types/${enc(key)}`,
      body: cleanBody({ scope: where.scope ?? "project", project_id: where.projectId, ...changes }),
    });
  }

  /**
   * Remove a scope's own copy of a card type, so the scope goes back to the type
   * it inherits. A type defined only in that scope throws `ConflictError`: turn
   * it off with `updateCardType(key, { status: "deprecated" })` instead.
   */
  removeCardTypeCopy(key: string, where: CardTypeScope = {}): Promise<CardTypeCopyRemoved> {
    return this.transport.request({
      method: "DELETE",
      path: `/v1/knowledge/wiki/page-types/${enc(key)}`,
      query: { scope: where.scope ?? "project", project_id: where.projectId },
    });
  }

  /**
   * Copy card types one project defines into another project, which gets its own
   * copies. The caller must see the source project and own the destination. A
   * key the source does not itself define is skipped as `not_found`, and one the
   * destination already defines as `exists` unless `replace` is true. Cards are
   * not copied or changed.
   */
  copyCardTypes(
    fromProjectId: string,
    toProjectId: string,
    keys: string[],
    options: CopyCardTypesOptions = {},
  ): Promise<CardTypesCopied> {
    return this.transport.request({
      method: "POST",
      path: "/v1/knowledge/wiki/page-types/copy",
      body: {
        from_project_id: fromProjectId,
        to_project_id: toProjectId,
        keys: [...keys],
        replace: options.replace ?? false,
      },
    });
  }

  /**
   * Copy card types a project defines up to the organization, where every
   * project without a copy of its own inherits them. `projectId` is the project
   * whose types to promote (the route names it `source`). Needs an organization
   * admin. A key the project does not itself define is skipped as `not_found`,
   * and one the organization already defines as `exists` unless `replace` is
   * true.
   */
  promoteCardTypes(
    projectId: string,
    keys: string[],
    options: CopyCardTypesOptions = {},
  ): Promise<CardTypesCopied> {
    return this.transport.request({
      method: "POST",
      path: "/v1/knowledge/wiki/page-types/promote",
      body: { source: projectId, keys: [...keys], replace: options.replace ?? false },
    });
  }

  /**
   * Rename fields on every card of a type in one project: a dry run unless
   * `{ dryRun: false }`. The type's field list is renamed with the cards, and
   * rows that become the same field are merged with their citations kept. A dry
   * run writes nothing and answers the counts (`cards`, `cards_changed`,
   * `rows_renamed`, `rows_merged`) and the renames it would have `applied` and
   * `refused`. A write changes at most 500 cards a call; `cards_remaining` says
   * how many are left, and the same call again changes the next ones. An applied
   * change answers `commit_id` and `undo_event_id` and shows in the project's
   * activity, where an owner can undo it. Only the project's owners may;
   * `ConflictError` while Knowledge runs maintenance on the project.
   */
  renameCardTypeFields(
    key: string,
    projectId: string,
    renames: CardTypeFieldRenames,
    options: ExistingCardsOptions = {},
  ): Promise<CardTypeFieldsRenamed> {
    const pairs = Array.isArray(renames)
      ? renames.map((pair) => ({ old: pair.old, new: pair.new }))
      : Object.entries(renames).map(([from, to]) => ({ old: from, new: to }));
    return this.transport.request({
      method: "POST",
      path: `/v1/knowledge/wiki/page-types/${enc(key)}/rename-fields`,
      body: cleanBody({
        project_id: projectId,
        renames: pairs,
        dry_run: options.dryRun ?? true,
        continue_event_id: options.continueEventId,
      }),
    });
  }

  /**
   * Move every card of a type in one project to another type: a dry run unless
   * `{ dryRun: false }`. `toType` must be an active type in the project whose
   * instances are cards. A write moves at most 500 cards a call
   * (`cards_retyped`, `cards_skipped`, `cards_remaining`). A card's text is not
   * changed: if the two types name a field differently, rename the fields on
   * the target type afterwards ({@link renameCardTypeFields}).
   */
  retypeCards(
    key: string,
    projectId: string,
    toType: string,
    options: RetypeCardsOptions = {},
  ): Promise<CardsRetyped> {
    return this.transport.request({
      method: "POST",
      path: `/v1/knowledge/wiki/page-types/${enc(key)}/retype-cards`,
      body: cleanBody({
        project_id: projectId,
        to_type: toType,
        dry_run: options.dryRun ?? true,
        suggestion_id: options.suggestionId,
        continue_event_id: options.continueEventId,
      }),
    });
  }

  /**
   * A project's card type settings, or `null` when the list names none:
   * `inherit` (`organization`, `builtin` or `own`) and `agent_may_change`. Read
   * from {@link listCardTypes}, which answers them beside the types.
   */
  async cardTypeSettings(projectId: string): Promise<CardTypeSettings | null> {
    const listing = await this.listCardTypes({ projectId });
    return listing.settings ?? null;
  }

  /**
   * Change where a project's card types come from, or who may change them: a
   * dry run unless `{ dryRun: false }`. A dry run writes nothing and answers
   * `current`, `requested` and `types_dropped`, each type the project would stop
   * being offered with its `live_cards`. `inherit: "own"` needs the project to
   * define at least one active type whose instances are cards. Applying never
   * changes or removes a card or a type: a dropped type that still has cards
   * gets a suggestion to move them ({@link cardTypeSuggestions}), or with
   * `keepTypesInUse` becomes one of the project's own types. Only the project's
   * owners may.
   */
  setCardTypeSettings(projectId: string, settings: CardTypeSettingsInput): Promise<CardTypeSettingsChange> {
    return this.transport.request({
      method: "PUT",
      path: "/v1/knowledge/wiki/page-types/settings",
      body: cleanBody({
        project_id: projectId,
        inherit: settings.inherit,
        agent_may_change: settings.agentMayChange,
        keep_types_in_use: settings.keepTypesInUse ?? false,
        dry_run: settings.dryRun ?? true,
      }),
    });
  }

  /**
   * One page of the changes to card types, newest first: a project's
   * (`projectId`) or the organization's (`scope: "org"`), narrowed to one type
   * with `key`. Each entry says who, when, the `kind`, a `title`, the fields that
   * `changed` and the definition `before` and `after`.
   * {@link iterCardTypeHistory} follows every page.
   */
  cardTypeHistory(query: CardTypeHistoryQuery = {}): Promise<CardTypeHistoryPage> {
    return this.transport.request({
      method: "GET",
      path: "/v1/knowledge/wiki/page-types/history",
      query: historyQuery(query),
    });
  }

  /** Every entry {@link cardTypeHistory} lists, following cursors. */
  iterCardTypeHistory(
    query: Omit<CardTypeHistoryQuery, "cursor" | "limit"> = {},
    pageSize?: number,
  ): AsyncGenerator<CardTypeHistoryEntry> {
    return this.transport.paginate(
      { method: "GET", path: "/v1/knowledge/wiki/page-types/history", query: historyQuery(query) },
      pageSize,
    );
  }

  /**
   * One page of what waits for a person in a project: `held_back` (a type Beakr
   * was not allowed to add) and `retype_suggested` (cards to move, with
   * `details.from_type` and `details.cards`). Answer a move with
   * {@link retypeCards} and its `suggestionId`, or
   * {@link dismissCardTypeSuggestion}.
   */
  cardTypeSuggestions(
    projectId: string,
    page: { cursor?: string; limit?: number } = {},
  ): Promise<CardTypeHistoryPage> {
    return this.transport.request({
      method: "GET",
      path: "/v1/knowledge/wiki/page-types/suggestions",
      query: { project_id: projectId, cursor: page.cursor, limit: page.limit },
    });
  }

  /** Every suggestion {@link cardTypeSuggestions} lists, following cursors. */
  iterCardTypeSuggestions(projectId: string, pageSize?: number): AsyncGenerator<CardTypeHistoryEntry> {
    return this.transport.paginate(
      { method: "GET", path: "/v1/knowledge/wiki/page-types/suggestions", query: { project_id: projectId } },
      pageSize,
    );
  }

  /**
   * Dismiss one suggestion of a project. Only the project's owners may;
   * `ConflictError` if it was already answered.
   */
  dismissCardTypeSuggestion(suggestionId: string, projectId: string): Promise<CardTypeSuggestionDismissed> {
    return this.transport.request({
      method: "POST",
      path: `/v1/knowledge/wiki/page-types/suggestions/${enc(suggestionId)}/dismiss`,
      body: { project_id: projectId },
    });
  }

  /**
   * How many Knowledge compiles are queued and running in a project, or for one
   * source (`attachmentId`) or file (`artifactId`), and the last cancel's
   * progress: `{ queued, running, last_cancel }`. `last_cancel` is `null` or
   * `{ cancel_id, status, done, total, summary, cancelled_by, cancelled_at }`.
   */
  compileQueue(projectId: string, source: CompileSource = {}): Promise<CompileQueue> {
    return this.transport.request({
      method: "GET",
      path: `/v1/projects/${enc(projectId)}/knowledge/compiles`,
      query: { attachment_id: source.attachmentId, artifact_id: source.artifactId },
    });
  }

  /**
   * Cancel the queued Knowledge compiles of a project, or of one source or file.
   * Compiles already running finish (`already_running`) and pages Knowledge
   * already wrote stay. A source's cancel also stops that source's running sync;
   * the whole project's (no source) stops every running sync in the project
   * (`sync_stopped`, `syncs_stopped`; `sync_job_id` for a source). Answers while
   * the queue drains; {@link compileQueue} follows it. A project admin may cancel
   * anything in the project, the person who attached a source or uploaded a file
   * its compiles.
   */
  cancelQueuedCompiles(projectId: string, source: CompileSource = {}): Promise<CompilesCancelled> {
    return this.transport.request({
      method: "POST",
      path: `/v1/projects/${enc(projectId)}/knowledge/compiles/cancel`,
      body: cleanBody({ attachment_id: source.attachmentId, artifact_id: source.artifactId }),
    });
  }
}

function historyQuery(query: CardTypeHistoryQuery): Record<string, string | number | boolean | undefined> {
  return {
    project_id: query.projectId,
    scope: query.scope,
    key: query.key,
    include_suggestions: query.includeSuggestions,
    cursor: query.cursor,
    limit: query.limit,
  };
}
