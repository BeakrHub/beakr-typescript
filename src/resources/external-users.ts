import { ValidationError } from "../errors.js";
import type { BodyOf, ResponseOf } from "../types.js";
import { OrgScoped, enc } from "./base.js";

const USER_ID = /^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/;

/**
 * `value` as an external user's `user_id`. An `external_id` is unique only within
 * the service account that created the user, so it names no user on its own and
 * is refused before any request.
 */
export function userIdOf(value: string): string {
  if (!USER_ID.test(value)) {
    throw new ValidationError(
      `${JSON.stringify(value)} is not a user_id. External users are addressed by their user_id ` +
        `(a uuid from create or list); find it with externalUsers.list({ externalId: ${JSON.stringify(value)} }).`,
      { code: "validation_error" },
    );
  }
  return value;
}

const BASE = "/v1/organizations/{org_id}/external-users" as const;
const ONE = "/v1/organizations/{org_id}/external-users/{user_id}" as const;

export type ExternalUser = ResponseOf<typeof ONE, "get">;
export type ExternalUserPage = ResponseOf<typeof BASE, "get">;

/**
 * The users of your own product, mirrored into your organization so tokens
 * minted for them (`endUserTokens.mint({ externalUserId })`) act as them.
 * `create` is idempotent on `external_id`, which is unique per creating service
 * account: `get`, `update`, `delete` and token minting take the `user_id`, and
 * `list({ externalId })` finds the one your credential created. Each method takes
 * the org id last, defaulting to the caller's active organization.
 */
export class ExternalUsers extends OrgScoped {
  async list(
    query: { externalId?: string; cursor?: string; limit?: number } = {},
    orgId?: string,
  ): Promise<ExternalUserPage> {
    return this.transport.request({
      method: "GET",
      path: `${await this.orgBase(orgId)}/external-users`,
      query: { external_id: query.externalId, cursor: query.cursor, limit: query.limit },
    });
  }

  async create(body: BodyOf<typeof BASE, "post">, orgId?: string): Promise<ResponseOf<typeof BASE, "post">> {
    return this.transport.request({
      method: "POST",
      path: `${await this.orgBase(orgId)}/external-users`,
      idempotent: true,
      body,
    });
  }

  async get(userId: string, orgId?: string): Promise<ExternalUser> {
    return this.transport.request({
      method: "GET",
      path: `${await this.orgBase(orgId)}/external-users/${enc(userIdOf(userId))}`,
    });
  }

  async update(userId: string, body: BodyOf<typeof ONE, "patch">, orgId?: string): Promise<ExternalUser> {
    return this.transport.request({
      method: "PATCH",
      path: `${await this.orgBase(orgId)}/external-users/${enc(userIdOf(userId))}`,
      body,
    });
  }

  /** Remove the user; what they put into projects stays. */
  async delete(userId: string, orgId?: string): Promise<void> {
    return this.transport.request({
      method: "DELETE",
      path: `${await this.orgBase(orgId)}/external-users/${enc(userIdOf(userId))}`,
      responseType: "none",
    });
  }
}
