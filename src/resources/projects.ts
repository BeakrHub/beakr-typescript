import { cleanBody } from "../core.js";
import type { BodyOf, ResponseOf } from "../types.js";
import { Resource, enc } from "./base.js";

export class Projects extends Resource {
  list(
    options: { memberOnly?: boolean } = {},
  ): Promise<ResponseOf<"/v1/projects", "get">> {
    return this.transport.request({
      method: "GET",
      path: "/v1/projects",
      query: { member_only: options.memberOnly },
    });
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
   * May need a fresh second factor (`mfa_required`).
   */
  delete(projectId: string): Promise<void> {
    return this.transport.request({
      method: "DELETE",
      path: `/v1/projects/${enc(projectId)}`,
      responseType: "none",
    });
  }

  members(
    projectId: string,
  ): Promise<ResponseOf<"/v1/projects/{project_id}/members", "get">> {
    return this.transport.request({
      method: "GET",
      path: `/v1/projects/${enc(projectId)}/members`,
    });
  }
}
