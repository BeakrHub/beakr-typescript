import type { ResponseOf } from "../types.js";
import { OrgScoped, enc } from "./base.js";

export type Role = "owner" | "admin" | "member" | "viewer";

export class Members extends OrgScoped {
  async list(orgId?: string): Promise<ResponseOf<"/v1/organizations/{org_id}/members", "get">> {
    return this.transport.request({ method: "GET", path: `${await this.orgBase(orgId)}/members` });
  }

  /** Change a member's role. The route takes the role as a query parameter. */
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
