import { cleanBody } from "../core.js";
import type { BodyOf, ResponseOf } from "../types.js";
import { Resource } from "./base.js";

/** The organization's project isolation settings (`GET /v1/project-isolation`). */
export type ProjectIsolationSettings = ResponseOf<"/v1/project-isolation", "get">;
/** The settings a {@link ProjectIsolation.update} call changes. */
export type ProjectIsolationUpdate = BodyOf<"/v1/project-isolation", "put">;

/**
 * How agent sessions keep projects apart, set by an organization admin:
 * `session_mode` (`picker`, or `auto_lock`: the first project a session reads
 * or writes becomes its only write project, and reading a second makes it
 * read-only), `auto_lock_counts_search_results`, `agent_writes_require_session`
 * (service accounts are exempt) and the default `cross_project_guard`
 * (`allow`, `hold`, `refuse`; a project's own is `projects.crossProjectGuard`).
 * `available` says which features are on; a setting whose feature is off
 * cannot be changed (404 `feature_not_enabled`).
 */
export class ProjectIsolation extends Resource {
  /** The settings, which features are available, and `can_change`. */
  get(): Promise<ProjectIsolationSettings> {
    return this.transport.request({ method: "GET", path: "/v1/project-isolation" });
  }

  /** Change the settings given (an organization admin acting as a person). */
  update(settings: ProjectIsolationUpdate): Promise<ProjectIsolationSettings> {
    return this.transport.request({ method: "PUT", path: "/v1/project-isolation", body: cleanBody({ ...settings }) });
  }
}
