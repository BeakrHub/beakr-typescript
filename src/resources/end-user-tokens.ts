import { cleanBody } from "../core.js";
import type { ResponseOf } from "../types.js";
import { Resource, enc } from "./base.js";
import { userIdOf } from "./external-users.js";

export type EndUserToken = ResponseOf<"/v1/auth/end-user-tokens", "post">;
export type EndUserTokenPage = ResponseOf<"/v1/auth/end-user-tokens", "get">;

/**
 * Give either `externalUserId` (the token acts as that external user, and its
 * label and project memberships decide its projects), or `subject` with
 * `projectIds` (the token acts as your service account, confined to those
 * projects). The server refuses both together.
 */
export interface MintEndUserTokenOptions {
  /** Who the token acts for in your product; recorded in the audit trail. With `projectIds`. */
  subject?: string;
  /** An external user (see `externalUsers`) the token acts as, by its `user_id`. Without `subject`/`projectIds`. */
  externalUserId?: string;
  /** Scopes, never more than the caller's own. */
  scopes: string[];
  /** Confine the token to these projects. With `subject`. */
  projectIds?: string[];
  /** Lifetime in seconds. */
  ttlSeconds?: number;
}

/**
 * Short-lived tokens you mint for the users of your own product, so their
 * requests run as them and never with more than your key can do. Mint with an
 * API key (a service account's, for an embedded product).
 */
export class EndUserTokens extends Resource {
  /** Mint a token; `token` is shown once. Not retried: a retry mints another. */
  mint(options: MintEndUserTokenOptions): Promise<EndUserToken> {
    return this.transport.request({
      method: "POST",
      path: "/v1/auth/end-user-tokens",
      body: cleanBody({
        subject: options.subject,
        external_user_id:
          options.externalUserId === undefined ? undefined : userIdOf(options.externalUserId),
        scopes: options.scopes,
        project_ids: options.projectIds,
        ttl_seconds: options.ttlSeconds,
      }),
    });
  }

  /** One page of live end-user tokens, newest first. */
  list(query: { subject?: string; cursor?: string; limit?: number } = {}): Promise<EndUserTokenPage> {
    return this.transport.request({ method: "GET", path: "/v1/auth/end-user-tokens", query });
  }

  /** Revoke a token; it stops working immediately. */
  revoke(tokenId: string): Promise<void> {
    return this.transport.request({
      method: "DELETE",
      path: `/v1/auth/end-user-tokens/${enc(tokenId)}`,
      responseType: "none",
    });
  }
}
