import { cleanBody } from "../core.js";
import type { BodyOf, JsonObject, ResponseOf } from "../types.js";
import { Resource, enc } from "./base.js";
import { waitForKnowledge, type KnowledgeWaitOptions } from "./knowledge-readiness.js";
import { ModelRefusals } from "./model-refusals.js";
import type { Transport } from "../core.js";

/** A project's Knowledge status (`GET /v1/projects/{project_id}/knowledge-summary`). */
export type ProjectKnowledgeStatus = ResponseOf<"/v1/projects/{project_id}/knowledge-summary", "get">;
/** One file whose latest attempt to reach the project's Knowledge failed. */
export type KnowledgeFailedFile = NonNullable<ProjectKnowledgeStatus["failed_files"]>[number];
/** What a retry did (`POST /v1/projects/{project_id}/knowledge/retry-failed`). */
export type KnowledgeRetryResult = ResponseOf<
  "/v1/projects/{project_id}/knowledge/retry-failed",
  "post"
>;

/** A project's Knowledge profile (`GET /v1/projects/{project_id}/knowledge-profile`). */
export type ProjectKnowledgeProfile = ResponseOf<
  "/v1/projects/{project_id}/knowledge-profile",
  "get"
>;
/** The whole profile a {@link Projects.setKnowledgeProfile} call sends. */
export type ProjectKnowledgeProfileInput = BodyOf<
  "/v1/projects/{project_id}/knowledge-profile",
  "put"
>;
/** The fields a {@link Projects.updateKnowledgeProfile} call changes. */
export type ProjectKnowledgeProfilePatch = BodyOf<
  "/v1/projects/{project_id}/knowledge-profile",
  "patch"
>;

/** The filters and paging `GET /v1/projects` takes. */
export interface ListProjectsQuery {
  /** Only projects you are a member of, not every project your organization role lets you see. */
  memberOnly?: boolean;
  ownerUserId?: string;
  groupId?: string;
  /** Include each project's Knowledge counts. */
  includeKnowledge?: boolean;
  cursor?: string;
  limit?: number;
}

/** One project as `GET /v1/projects` lists it. */
export type Project = NonNullable<ResponseOf<"/v1/projects", "get">["data"]>[number];
/** One project member as `GET /v1/projects/{project_id}/members` lists it. */
export type ProjectMember = NonNullable<ResponseOf<"/v1/projects/{project_id}/members", "get">["data"]>[number];

function projectsQuery(options: ListProjectsQuery): Record<string, string | number | boolean | undefined> {
  return {
    member_only: options.memberOnly,
    owner_user_id: options.ownerUserId,
    group_id: options.groupId,
    include_knowledge: options.includeKnowledge,
    cursor: options.cursor,
    limit: options.limit,
  };
}

export class Projects extends Resource {
  /** When a model refused a Knowledge stage in a project (`/model-refusals`). */
  readonly modelRefusals: ModelRefusals;

  constructor(transport: Transport) {
    super(transport);
    this.modelRefusals = new ModelRefusals(transport);
  }

  /**
   * One page of the projects you can see (`{data, next_cursor, has_more}`).
   * Pass `cursor` from the previous page, or use {@link iter} to follow every page.
   */
  list(options: ListProjectsQuery = {}): Promise<ResponseOf<"/v1/projects", "get">> {
    return this.transport.request({ method: "GET", path: "/v1/projects", query: projectsQuery(options) });
  }

  /** Every project you can see, following cursors. */
  iter(options: Omit<ListProjectsQuery, "cursor" | "limit"> = {}, pageSize?: number): AsyncGenerator<Project> {
    return this.transport.paginate({ method: "GET", path: "/v1/projects", query: projectsQuery(options) }, pageSize);
  }

  get(
    projectId: string,
  ): Promise<ResponseOf<"/v1/projects/{project_id}", "get">> {
    return this.transport.request({
      method: "GET",
      path: `/v1/projects/${enc(projectId)}`,
    });
  }

  create(
    body: BodyOf<"/v1/projects", "post">,
  ): Promise<ResponseOf<"/v1/projects", "post">> {
    return this.transport.request({
      method: "POST",
      path: "/v1/projects",
      body,
      idempotent: true,
    });
  }

  update(
    projectId: string,
    body: BodyOf<"/v1/projects/{project_id}", "patch">,
  ): Promise<ResponseOf<"/v1/projects/{project_id}", "patch">> {
    return this.transport.request({
      method: "PATCH",
      path: `/v1/projects/${enc(projectId)}`,
      body: cleanBody(body as Record<string, unknown>),
    });
  }

  /**
   * Delete the project permanently; it cannot be restored (archive is reversible).
   * Needs admin access to the project; a personal project cannot be deleted (403).
   * Web app only in practice: API keys and tokens are refused with
   * `session_required` wherever the organization protects sensitive actions,
   * and a session may need a fresh second factor (`mfa_required`).
   */
  delete(projectId: string): Promise<void> {
    return this.transport.request({
      method: "DELETE",
      path: `/v1/projects/${enc(projectId)}`,
      responseType: "none",
    });
  }

  /** One page of the project's members; {@link iterMembers} follows every page. */
  members(
    projectId: string,
    query: { cursor?: string; limit?: number } = {},
  ): Promise<ResponseOf<"/v1/projects/{project_id}/members", "get">> {
    return this.transport.request({
      method: "GET",
      path: `/v1/projects/${enc(projectId)}/members`,
      query: { cursor: query.cursor, limit: query.limit },
    });
  }

  /** Every member of the project, following cursors. */
  iterMembers(projectId: string, pageSize?: number): AsyncGenerator<ProjectMember> {
    return this.transport.paginate({ method: "GET", path: `/v1/projects/${enc(projectId)}/members` }, pageSize);
  }

  /**
   * Whether the project's Knowledge is ready, its coverage, and what failed:
   * `ready` is true when nothing is queued or running, and `failed_files` are
   * the newest failures (`failedLimit`, default 20) with `error_code`,
   * `reason` and `retryable`. Counts cover the files you can read.
   */
  knowledgeStatus(
    projectId: string,
    options: { failedLimit?: number } = {},
  ): Promise<ProjectKnowledgeStatus> {
    return this.transport.request({
      method: "GET",
      path: `/v1/projects/${enc(projectId)}/knowledge-summary`,
      query: { failed_limit: options.failedLimit },
    });
  }

  /** Every file whose latest attempt to reach the project's Knowledge failed, newest first. */
  async knowledgeFailures(projectId: string): Promise<KnowledgeFailedFile[]> {
    const files: KnowledgeFailedFile[] = [];
    for await (const file of this.transport.paginate<KnowledgeFailedFile>(
      { method: "GET", path: `/v1/projects/${enc(projectId)}/knowledge/failed-files` },
      200,
    )) {
      files.push(file);
    }
    return files;
  }

  /**
   * Poll {@link knowledgeStatus} until nothing is queued or running and resolve
   * to it. Throws `KnowledgeTimeoutError` (with the last status) at the
   * timeout; failed files do not end the wait, and with `raiseOnFailure` throw
   * `KnowledgeFailedError` instead when any remain.
   */
  waitUntilReady(
    projectId: string,
    options: KnowledgeWaitOptions & { failedLimit?: number } = {},
  ): Promise<ProjectKnowledgeStatus> {
    return waitForKnowledge(
      this.transport,
      `project ${projectId}`,
      () => this.knowledgeStatus(projectId, { failedLimit: options.failedLimit }) as Promise<
        ProjectKnowledgeStatus & JsonObject
      >,
      options,
    );
  }

  /**
   * Send failed files to Knowledge again: every failed file (up to 500 per
   * call; `has_more` says more remain), or `artifactIds`. Safe to repeat: files
   * already queued or running are left alone. Needs permission to add files to
   * the project.
   */
  retryFailed(projectId: string, artifactIds?: string[]): Promise<KnowledgeRetryResult> {
    return this.transport.request({
      method: "POST",
      path: `/v1/projects/${enc(projectId)}/knowledge/retry-failed`,
      body: artifactIds === undefined ? {} : { artifact_ids: [...artifactIds] },
    });
  }

  /**
   * The project's Knowledge profile. Throws `NotFoundError` with
   * `code === "knowledge_profile_not_found"` while the project has none (set
   * one with {@link setKnowledgeProfile}). Project members read it; a viewer is
   * refused.
   */
  knowledgeProfile(projectId: string): Promise<ProjectKnowledgeProfile> {
    return this.transport.request({
      method: "GET",
      path: `/v1/projects/${enc(projectId)}/knowledge-profile`,
    });
  }

  /**
   * Set the whole Knowledge profile, creating it when the project has none.
   * Fields left out are set to their empty value. Only the project's owners
   * may set it; Knowledge reads it when it next compiles files.
   */
  setKnowledgeProfile(
    projectId: string,
    profile: ProjectKnowledgeProfileInput,
  ): Promise<ProjectKnowledgeProfile> {
    return this.transport.request({
      method: "PUT",
      path: `/v1/projects/${enc(projectId)}/knowledge-profile`,
      body: cleanBody({ ...profile }),
    });
  }

  /**
   * Change the fields given; the rest are kept. A list given replaces that
   * list. Throws `NotFoundError` (`knowledge_profile_not_found`) when the
   * project has no profile yet.
   */
  updateKnowledgeProfile(
    projectId: string,
    fields: ProjectKnowledgeProfilePatch,
  ): Promise<ProjectKnowledgeProfile> {
    return this.transport.request({
      method: "PATCH",
      path: `/v1/projects/${enc(projectId)}/knowledge-profile`,
      body: cleanBody({ ...fields }),
    });
  }
}
