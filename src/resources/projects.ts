import { cleanBody } from "../core.js";
import type { BodyOf, JsonObject, ResponseOf } from "../types.js";
import { Resource, enc } from "./base.js";
import { waitForKnowledge, type KnowledgeWaitOptions } from "./knowledge-readiness.js";
import { ModelRefusals } from "./model-refusals.js";
import type { Transport } from "../core.js";
import type { StartedRun } from "./runs.js";

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

/** A project's cross-project guard (`GET /v1/projects/{project_id}/cross-project-guard`). */
export type CrossProjectGuard = ResponseOf<"/v1/projects/{project_id}/cross-project-guard", "get">;

/** Options for {@link Projects.startProfileSetup}. */
export interface ProfileSetupOptions {
  /** Continue this setup conversation instead of starting one. */
  threadId?: string;
  /** The message answers a question the run parked on. */
  answer?: boolean;
  /** The organization requires this profile before the project can be used. */
  required?: boolean;
  /** Deduplicates resends of the same start; generated when omitted. */
  idempotencyKey?: string;
}

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
   * What the project does with writes that bring in content from other
   * projects: `effective` is `allow`, `hold` (an owner or admin accepts them)
   * or `refuse`, the project's `override` else the organization's `org_default`.
   */
  crossProjectGuard(projectId: string): Promise<CrossProjectGuard> {
    return this.transport.request({ method: "GET", path: `/v1/projects/${enc(projectId)}/cross-project-guard` });
  }

  /**
   * Set the project's own guard (`allow`, `hold`, `refuse`); `null` follows the
   * organization's. An owner or admin of the project acting as a person may.
   */
  setCrossProjectGuard(projectId: string, override: "allow" | "hold" | "refuse" | null): Promise<CrossProjectGuard> {
    return this.transport.request({
      method: "PUT",
      path: `/v1/projects/${enc(projectId)}/cross-project-guard`,
      body: { override },
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
   * Start, or continue, a profile-setup conversation with Beakr's agent.
   *
   * The agent leads: it settles the project's entity types first (the kinds of
   * things Knowledge keeps pages for, with examples, attributes and
   * relationships), then what the project is, its goals, people, organizations
   * and topics, and saves the profile as it goes. The session is held to the
   * profile. Returns `{run_id, thread_id, ...}`; follow it with `runs.stream`
   * or `runs.streamText`. Reply in the same `threadId`; when the run parked on
   * a question (`runs.get(runId).question`), reply with `answer: true`.
   * `required` tells the agent the organization requires the profile before
   * the project can be used. Only the project's owners may save its profile.
   */
  startProfileSetup(
    projectId: string,
    message: string,
    options: ProfileSetupOptions = {},
  ): Promise<StartedRun> {
    return this.transport.request({
      method: "POST",
      path: "/v1/runs",
      // The route returns the existing run for the same body key, so resends are safe.
      serverDeduplicated: true,
      body: cleanBody({
        idempotency_key:
          options.idempotencyKey ?? globalThis.crypto.randomUUID().replace(/-/g, ""),
        message,
        thread_id: options.threadId,
        home_project_id: projectId,
        scope: { knowledge_graph: true, projects: [{ id: projectId }] },
        // A client with no profile panel, confined to the profile.
        profile_builder_meta: {
          profile_scope: "project",
          project_id: projectId,
          required: options.required ?? false,
          setup_only: true,
          surface: "terminal",
        },
        is_ask_user_response: options.answer ? true : undefined,
      }),
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
