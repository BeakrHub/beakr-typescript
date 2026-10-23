import type { ResponseOf } from "../types.js";
import { Resource, enc } from "./base.js";

/** One page of refusal events (`GET /v1/projects/{project_id}/model-refusals`). */
export type ModelRefusalEvents = ResponseOf<"/v1/projects/{project_id}/model-refusals", "get">;
/** Counts for a window (`GET /v1/projects/{project_id}/model-refusals/summary`). */
export type ModelRefusalSummary = ResponseOf<
  "/v1/projects/{project_id}/model-refusals/summary",
  "get"
>;
/** One page of per-file counts (`GET /v1/projects/{project_id}/model-refusals/files`). */
export type ModelRefusalFiles = ResponseOf<
  "/v1/projects/{project_id}/model-refusals/files",
  "get"
>;
/** The windows the summary and files reads count over. */
export type ModelRefusalWindow = "24h" | "7d" | "30d";

/**
 * When a model refused a Knowledge stage in a project, and what happened next
 * (the Python SDK's `projects.model_refusals`). A fallback is the stage moving
 * to the next model in its ladder; each event's `outcome` is `recovered`,
 * `failed` or `skipped`. A file's `model_refusal_count` and
 * `compile_needed_fallback` say the same per file.
 */
export class ModelRefusals extends Resource {
  /** One page of refusal events, newest first. */
  list(
    projectId: string,
    options: {
      artifactId?: string;
      outcome?: "recovered" | "failed" | "skipped";
      stage?: string;
      limit?: number;
      cursor?: string;
    } = {},
  ): Promise<ModelRefusalEvents> {
    return this.transport.request({
      method: "GET",
      path: `/v1/projects/${enc(projectId)}/model-refusals`,
      query: {
        artifact_id: options.artifactId,
        outcome: options.outcome,
        stage: options.stage,
        limit: options.limit,
        cursor: options.cursor,
      },
    });
  }

  /** Refusal, fallback and outcome counts for `window` (`24h`, `7d` or `30d`). */
  summary(projectId: string, window?: ModelRefusalWindow): Promise<ModelRefusalSummary> {
    return this.transport.request({
      method: "GET",
      path: `/v1/projects/${enc(projectId)}/model-refusals/summary`,
      query: { window },
    });
  }

  /** One page of per-file counts for `window`. */
  files(
    projectId: string,
    options: { window?: ModelRefusalWindow; limit?: number; cursor?: string } = {},
  ): Promise<ModelRefusalFiles> {
    return this.transport.request({
      method: "GET",
      path: `/v1/projects/${enc(projectId)}/model-refusals/files`,
      query: { window: options.window, limit: options.limit, cursor: options.cursor },
    });
  }
}
