import { KnowledgeCommandError } from "../errors.js";
import { publicSource, type SourceRecord } from "../sources.js";
import type { JsonObject } from "../types.js";
import { Resource, enc } from "./base.js";

/**
 * How long a research call waits for its answer, whatever the client's timeout:
 * the engine gives the research route up to 150s (an agentic loop that reads
 * documents from connected services), so a 60s client would give up first.
 */
export const RESEARCH_TIMEOUT_MS = 170_000;
/** Milliseconds a quick research call waits: the engine ends a quick run within 16s. */
export const QUICK_RESEARCH_TIMEOUT_MS = 30_000;

/** Options for {@link Knowledge.research}. */
export interface ResearchOptions {
  /** A short cited answer within 15 seconds from one search. */
  quick?: boolean;
}

/** The door's reply: `{content: [{type, text}], outcome, sources}`. */
export interface KnowledgeResult extends JsonObject {
  content?: { type: string; text?: string }[];
  outcome?: { status?: string; [key: string]: unknown };
  sources?: unknown[];
}

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

function checked(result: KnowledgeResult, check: boolean): KnowledgeResult {
  if (check && result.outcome?.status === "error") {
    throw new KnowledgeCommandError(resultText(result) || "The Knowledge command was refused.", result);
  }
  return result;
}

class Proposals extends Resource {
  list(query: { status?: string; projectId?: string; limit?: number } = {}): Promise<unknown> {
    return this.transport.request({
      method: "GET",
      path: "/v1/knowledge/wiki/proposals",
      query: { status: query.status, project_id: query.projectId, limit: query.limit },
    });
  }

  get(proposalId: string): Promise<unknown> {
    return this.transport.request({ method: "GET", path: `/v1/knowledge/wiki/proposals/${enc(proposalId)}` });
  }

  accept(proposalId: string): Promise<unknown> {
    return this.transport.request({ method: "POST", path: `/v1/knowledge/wiki/proposals/${enc(proposalId)}/accept` });
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
    const result = await this.transport.request<KnowledgeResult>({
      method: "POST",
      path: "/v1/knowledge/wiki/command",
      body,
    });
    return checked(result, options.check ?? true);
  }

  /** Every action except `page_type` needs a `rationale`. */
  async write(action: string, args: JsonObject = {}, options: DoorOptions = {}): Promise<KnowledgeResult> {
    const body: JsonObject = { ...args, action };
    if (options.scope) body["scope"] = options.scope;
    const result = await this.transport.request<KnowledgeResult>({
      method: "POST",
      path: "/v1/knowledge/wiki/write",
      body,
    });
    return checked(result, options.check ?? true);
  }

  /** Search/read/list original indexed documents. Scan notices describe incomplete results. */
  documents(command: "grep" | "read" | "ls", args: JsonObject = {}, projectId?: string): Promise<unknown> {
    return this.transport.request({
      method: "POST",
      path: "/v1/knowledge/documents",
      body: { command, arguments: args, ...(projectId ? { project_id: projectId } : {}) },
    });
  }

  /**
   * A cited answer from Knowledge and connected sources. Waits up to
   * {@link RESEARCH_TIMEOUT_MS} (or the client's timeout, if longer): the engine
   * allows research up to 150s. With `{ quick: true }` the engine answers within
   * 15 seconds from one search of Knowledge and uploaded files (no connected
   * sources); the answer's `engine` is `quick`, and `stopped_early` is true when
   * it is the cited results without a written summary.
   */
  research(query: string, projectId?: string, options: ResearchOptions = {}): Promise<unknown> {
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
