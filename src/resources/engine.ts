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
}
