import { cleanBody } from "../core.js";
import type { BodyOf, ResponseOf } from "../types.js";
import { OrgScoped } from "./base.js";

/** The organization's project isolation settings (`GET /v1/organizations/{org_id}/project-isolation`). */
export type ProjectIsolationSettings = ResponseOf<"/v1/organizations/{org_id}/project-isolation", "get">;
/** How long the organization keeps session reads (`GET /v1/organizations/{org_id}/read-trail`). */
export type ReadTrailSettings = ResponseOf<"/v1/organizations/{org_id}/read-trail", "get">;
/** The settings a {@link ProjectIsolation.update} call changes. */
export type ProjectIsolationUpdate = BodyOf<"/v1/organizations/{org_id}/project-isolation", "put">;

/**
 * How agent sessions keep projects apart, set by an organization admin:
 * `session_mode` (`picker`, or `auto_lock`: the first project a session reads
 * or writes becomes its only write project, and reading a second makes it
 * read-only), `auto_lock_counts_search_results`, `agent_writes_require_session`
 * (service accounts are exempt) and the default `cross_project_guard`
 * (`allow`, `hold`, `refuse`; a project's own is `projects.crossProjectGuard`).
 * `available` says which features are on; a setting whose feature is off
 * cannot be changed (404 `feature_not_enabled`). The organization is `orgId`,
 * else the client's, else the caller's active one.
 */
export class ProjectIsolation extends OrgScoped {
  /** The settings, which features are available, and `can_change`. */
  async get(orgId?: string): Promise<ProjectIsolationSettings> {
    return this.transport.request({ method: "GET", path: `${await this.orgBase(orgId)}/project-isolation` });
  }

  /** Change the settings given (an organization admin acting as a person). */
  async update(settings: ProjectIsolationUpdate, orgId?: string): Promise<ProjectIsolationSettings> {
    return this.transport.request({
      method: "PUT",
      path: `${await this.orgBase(orgId)}/project-isolation`,
      body: cleanBody({ ...settings }),
    });
  }

  /**
   * How long session reads are kept (`read_trail_retention_days`, 90 by
   * default), whether the read trail is `available`, and `can_change`.
   */
  async readTrail(orgId?: string): Promise<ReadTrailSettings> {
    return this.transport.request({ method: "GET", path: `${await this.orgBase(orgId)}/read-trail` });
  }

  /** Keep session reads this many days, 1 to 3650 (an organization admin acting as a person). */
  async setReadTrailRetention(days: number, orgId?: string): Promise<ReadTrailSettings> {
    return this.transport.request({
      method: "PUT",
      path: `${await this.orgBase(orgId)}/read-trail`,
      body: { read_trail_retention_days: days },
    });
  }
}
