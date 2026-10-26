import type { ResponseOf } from "../types.js";
import { OrgScoped, enc } from "./base.js";

export type Role = "owner" | "admin" | "member" | "viewer";

/** One member as `GET /v1/organizations/{org_id}/members` lists it. */
export type OrgMember = NonNullable<ResponseOf<"/v1/organizations/{org_id}/members", "get">["data"]>[number];

export class Members extends OrgScoped {
  /** One page of the organization's members; {@link iter} follows every page. */
  async list(
    orgId?: string,
    query: { cursor?: string; limit?: number } = {},
  ): Promise<ResponseOf<"/v1/organizations/{org_id}/members", "get">> {
    return this.transport.request({
      method: "GET",
      path: `${await this.orgBase(orgId)}/members`,
      query: { cursor: query.cursor, limit: query.limit },
    });
  }

  /** Every member of the organization, following cursors. */
  async *iter(orgId?: string, pageSize?: number): AsyncGenerator<OrgMember> {
    yield* this.transport.paginate<OrgMember>(
      { method: "GET", path: `${await this.orgBase(orgId)}/members` },
      pageSize,
    );
  }

  /**
   * Change a member's role. The route takes the role as a query parameter.
   * An organization that requires SSO or a fresh second factor refuses this to
   * API keys and tokens (`session_required`); change the role in the web app.
   */
  async setRole(userId: string, role: Role, orgId?: string): Promise<unknown> {
    return this.transport.request({
      method: "PATCH",
      path: `${await this.orgBase(orgId)}/members/${enc(userId)}`,
      query: { new_role: role },
    });
  }

  async remove(userId: string, orgId?: string): Promise<void> {
    return this.transport.request({
      method: "DELETE",
      path: `${await this.orgBase(orgId)}/members/${enc(userId)}`,
      responseType: "none",
    });
  }
}
