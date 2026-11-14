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
 * How agent sessions keep projects apart, set by an organization admin, with
 * project boundaries (a project's own is `projects.setBoundary`):
 * `session_mode` (`automatic`: a session starts open and the server tracks what
 * it touches; `must_pick`: every agent session chooses its projects, or read
 * everything, before it starts), `default_boundary` (what new projects start
 * with), `minimum_boundary` (a floor no project goes below; `null` for none,
 * `{content_out: "locked"}` keeps every project locked, what auto-lock was) and
 * `agent_writes_require_session` (service accounts are exempt). `presets` lists
 * the boundary presets. `available` says which features are on; a setting whose
 * feature is off cannot be changed (404 `feature_not_enabled`). The retired
 * settings (`cross_project_guard`, `auto_lock_counts_search_results`, session
 * modes `picker` and `auto_lock`) answer `SettingRetiredError`. The organization
 * is `orgId`, else the client's, else the caller's active one.
 */
export class ProjectIsolation extends OrgScoped {
  /** The settings, which features are available, and `can_change`. */
  async get(orgId?: string): Promise<ProjectIsolationSettings> {
    return this.transport.request({ method: "GET", path: `${await this.orgBase(orgId)}/project-isolation` });
  }

  /**
   * Change the settings given (an organization admin acting as a person).
   * `minimum_boundary: null` clears the floor; leaving it out keeps it. A default
   * below the minimum throws `BoundaryBelowMinimumError`.
   */
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
