import { cleanBody } from "../core.js";
import type { JsonObject } from "../types.js";
import { Resource } from "./base.js";

export interface ContextOptions {
  projectId?: string;
  question?: string;
  /** ISO timestamp: include what changed since then. */
  since?: string;
  format?: "json" | "markdown" | "claude_md" | "agents_md";
  budgetChars?: number;
  /** The agent starting the session (`claude-code`, `codex`); each keeps its own last session. Omitted: the `X-Beakr-Client` header. */
  client?: string;
}

export class Engine extends Resource {
  /** Onboarding context for an agent: profiles, memories, recent changes, skills, entities. */
  context(options: ContextOptions = {}): Promise<JsonObject> {
    return this.transport.request({
      method: "POST",
      path: "/v1/context",
      body: cleanBody({
        project_id: options.projectId,
        question: options.question,
        since: options.since,
        format: options.format ?? "markdown",
        budget_chars: options.budgetChars,
        client: options.client,
      }),
    });
  }

  /** Send the not-yet-compounded part of an imported conversation to Knowledge (202). */
  compound(conversationId: string): Promise<JsonObject> {
    return this.transport.request({ method: "POST", path: "/v1/compound", body: { conversation_id: conversationId } });
  }

  /**
   * Stop a queued or running compound of an imported conversation. A batch
   * already being read finishes and its proposals stay; no further batch
   * starts, and the conversation's `compound_status` reads `cancelled`.
   * {@link compound} resumes from where it stopped. Returns
   * `{conversation_id, status, pending_messages}`; `status` is
   * `nothing_to_cancel` when no compound was queued or running.
   */
  cancelCompound(conversationId: string): Promise<JsonObject> {
    return this.transport.request({
      method: "POST",
      path: "/v1/compound/cancel",
      body: { conversation_id: conversationId },
      // Cancelling twice is cancelling once, so an ambiguous failure may be resent.
      idempotent: true,
    });
  }
}
