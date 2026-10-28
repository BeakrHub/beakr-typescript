import { cleanBody } from "../core.js";
import type { JsonObject, ResponseOf } from "../types.js";
import { Resource, enc } from "./base.js";

export interface ImportedMessage {
  role: "user" | "assistant";
  content: string;
  /** ISO timestamp of the message. */
  at?: string;
  /**
   * Who wrote it: `human` only for a turn the agent host marks as typed by a
   * person, `system` for one the host wrote itself (a background task's
   * report), `agent` for the agent's turns. Omitted: `unknown`. Imported-session
   * learning quotes only `human` user turns.
   */
  author?: "human" | "system" | "agent" | "unknown";
}

/** `chatgpt-export` (a conversation from a ChatGPT data export) is stored as `chatgpt`. */
export type ConversationClient =
  | "claude-code"
  | "codex"
  | "chatgpt"
  | "chatgpt-export"
  | "claude"
  | "generic";

/** One tool the session called and how many times so far. */
export interface ToolUsed {
  name: string;
  count?: number;
}

export interface ImportOptions {
  client: ConversationClient;
  sessionId: string;
  messages: ImportedMessage[];
  /**
   * Position of `messages[0]` in the session. Send it whenever you send only
   * the messages after the ones already imported: without it the batch is read
   * as the whole session from the start. A 409 ConflictError's
   * `expectedBaseIndex` says where to resend from.
   */
  baseIndex?: number;
  projectId?: string;
  title?: string;
  /**
   * What the session was about; kept instead of the transcript. Messages sent
   * with no summary, no `storeFullText`, `compound` or `holdText` are refused
   * (422 `summary_required`); a later batch of a summarised session needs none.
   */
  summary?: string;
  filesTouched?: string[];
  /**
   * What the session read, so freshness can check it later. Send the revision
   * you read for each page; a read without one is listed but not checked.
   */
  sourcesRead?: SourceRead[];
  /**
   * The tools the session called, counted from its transcript: the session's
   * totals so far (a later import's larger count per tool is kept).
   */
  toolsUsed?: ToolUsed[];
  interactive?: boolean;
  /**
   * Keep message text. Omitted: your full-text setting for this client applies
   * (`getSettings`); true or false overrides it. Without full text, `compound`
   * or `holdText`, only the summary and references are stored, and a later
   * compound answers `nothing_to_compound`.
   */
  storeFullText?: boolean;
  /**
   * Compound right after importing. Holds the unread text, for a bounded
   * time, until that capture reads it.
   */
  compound?: boolean;
  /**
   * Hold this batch's text for a compound requested later (a session sent in
   * several batches, or compounded with `engine.compound`), without queuing
   * one now. Released at the same deadline as `compound`.
   */
  holdText?: boolean;
}

/** What an import stored: `conversation_id`, `created`, `appended`, `revision`, `stored`, ... */
export type ConversationImported = ResponseOf<"/v1/conversations/import", "post">;

/** A page of imported conversations: `{data, next_cursor, has_more}`. */
export type ConversationPage = ResponseOf<"/v1/conversations", "get">;

/** One imported conversation as a {@link ConversationPage} lists it. */
export type ConversationSummary = ConversationPage["data"][number];

export interface ListConversationsQuery {
  client?: string;
  projectId?: string;
  q?: string;
  limit?: number;
  cursor?: string;
}

export interface SearchConversationsOptions {
  projectId?: string;
  /** Also search your Beakr chats by title. Default true. */
  includeThreads?: boolean;
  /**
   * "all" (default): every word must appear; quotes and `-word` work.
   * "any": a natural-language question, ranked by how many of its words match.
   */
  match?: "all" | "any";
  limit?: number;
}

export interface ConversationHit extends JsonObject {
  kind: "imported" | "ask_thread";
  id: string;
  title: string | null;
  summary: string | null;
  href: string;
}

/**
 * What a session read: a Knowledge page with the revision it read, a document
 * (file) with the stored version it read, or a source by reference.
 */
export type SourceRead =
  | { page_id: string; revision?: number }
  | { document_id: string; version_id?: string }
  | { source_ref: string; version?: string };

export class Conversations extends Resource {
  /** Import (or append to) a session. Not retried after an ambiguous failure. */
  import(options: ImportOptions): Promise<ConversationImported> {
    return this.transport.request({
      method: "POST",
      path: "/v1/conversations/import",
      idempotent: true,
      body: cleanBody({
        client: options.client,
        session_id: options.sessionId,
        base_index: options.baseIndex,
        messages: options.messages,
        project_id: options.projectId,
        title: options.title,
        summary: options.summary,
        files_touched: options.filesTouched,
        sources_read: options.sourcesRead,
        tools_used: options.toolsUsed,
        interactive: options.interactive,
        store_full_text: options.storeFullText,
        compound: options.compound,
        hold_text: options.holdText,
      }),
    });
  }

  list(query: ListConversationsQuery = {}): Promise<ConversationPage> {
    return this.transport.request({ method: "GET", path: "/v1/conversations", query: this.query(query) });
  }

  /** Every conversation, following cursors. */
  iter(query: Omit<ListConversationsQuery, "cursor" | "limit"> = {}, pageSize?: number): AsyncGenerator<ConversationSummary> {
    return this.transport.paginate({ method: "GET", path: "/v1/conversations", query: this.query(query) }, pageSize);
  }

  get(conversationId: string): Promise<JsonObject> {
    return this.transport.request({ method: "GET", path: `/v1/conversations/${enc(conversationId)}` });
  }

  /** Your own conversations about `q` (imported sessions and Beakr chats), best first. */
  search(q: string, options: SearchConversationsOptions = {}): Promise<{ data: ConversationHit[]; query: string }> {
    return this.transport.request({
      method: "GET",
      path: "/v1/conversations/search",
      query: {
        q,
        project_id: options.projectId,
        include_threads: options.includeThreads === false ? "false" : "true",
        match: options.match ?? "all",
        limit: options.limit,
      },
    });
  }

  delete(conversationId: string): Promise<void> {
    return this.transport.request({
      method: "DELETE",
      path: `/v1/conversations/${enc(conversationId)}`,
      responseType: "none",
    });
  }

  private query(query: ListConversationsQuery) {
    return {
      client: query.client,
      project_id: query.projectId,
      q: query.q,
      limit: query.limit,
      cursor: query.cursor,
    };
  }
}
