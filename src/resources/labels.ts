import type { BodyOf, ResponseOf } from "../types.js";
import { Resource, enc } from "./base.js";

export type Label = ResponseOf<"/v1/labels/{label_id}", "get">;
export type LabelPage = ResponseOf<"/v1/labels", "get">;
type Paging = { cursor?: string; limit?: number };

/**
 * Labels: named groups of people mapped to projects. A label's members get
 * the role it holds on each attached project.
 */
export class Labels extends Resource {
  list(query: Paging = {}): Promise<LabelPage> {
    return this.transport.request({ method: "GET", path: "/v1/labels", query });
  }

  create(body: BodyOf<"/v1/labels", "post">): Promise<Label> {
    return this.transport.request({ method: "POST", path: "/v1/labels", idempotent: true, body });
  }

  get(labelId: string): Promise<Label> {
    return this.transport.request({ method: "GET", path: `/v1/labels/${enc(labelId)}` });
  }

  update(labelId: string, body: BodyOf<"/v1/labels/{label_id}", "patch">): Promise<Label> {
    return this.transport.request({ method: "PATCH", path: `/v1/labels/${enc(labelId)}`, body });
  }

  delete(labelId: string): Promise<void> {
    return this.transport.request({ method: "DELETE", path: `/v1/labels/${enc(labelId)}`, responseType: "none" });
  }

  members(labelId: string, query: Paging = {}): Promise<ResponseOf<"/v1/labels/{label_id}/members", "get">> {
    return this.transport.request({ method: "GET", path: `/v1/labels/${enc(labelId)}/members`, query });
  }

  addMember(
    labelId: string,
    body: BodyOf<"/v1/labels/{label_id}/members", "post">,
  ): Promise<ResponseOf<"/v1/labels/{label_id}/members", "post">> {
    return this.transport.request({
      method: "POST",
      path: `/v1/labels/${enc(labelId)}/members`,
      idempotent: true,
      body,
    });
  }

  removeMember(labelId: string, userId: string): Promise<void> {
    return this.transport.request({
      method: "DELETE",
      path: `/v1/labels/${enc(labelId)}/members/${enc(userId)}`,
      responseType: "none",
    });
  }

  projects(labelId: string, query: Paging = {}): Promise<ResponseOf<"/v1/labels/{label_id}/projects", "get">> {
    return this.transport.request({ method: "GET", path: `/v1/labels/${enc(labelId)}/projects`, query });
  }

  attachProject(
    labelId: string,
    body: BodyOf<"/v1/labels/{label_id}/projects", "post">,
  ): Promise<ResponseOf<"/v1/labels/{label_id}/projects", "post">> {
    return this.transport.request({
      method: "POST",
      path: `/v1/labels/${enc(labelId)}/projects`,
      idempotent: true,
      body,
    });
  }

  setProjectRole(
    labelId: string,
    projectId: string,
    body: BodyOf<"/v1/labels/{label_id}/projects/{project_id}", "patch">,
  ): Promise<ResponseOf<"/v1/labels/{label_id}/projects/{project_id}", "patch">> {
    return this.transport.request({
      method: "PATCH",
      path: `/v1/labels/${enc(labelId)}/projects/${enc(projectId)}`,
      body,
    });
  }

  detachProject(labelId: string, projectId: string): Promise<void> {
    return this.transport.request({
      method: "DELETE",
      path: `/v1/labels/${enc(labelId)}/projects/${enc(projectId)}`,
      responseType: "none",
    });
  }
}
