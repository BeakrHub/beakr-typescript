import { cleanBody, type Transport } from "../core.js";
import type { JsonObject } from "../types.js";
import { OrgScoped, credentialClient, enc } from "./base.js";

export interface MintKeyOptions {
  scopes: string[];
  name?: string;
  projectIds?: string[];
  expiresInDays?: number;
  /**
   * The client the key is for (a CI system, an integration), recorded on the
   * key. The API requires one; it defaults to this SDK's name.
   */
  clientName?: string;
}

class ServiceAccounts extends OrgScoped {
  /** One page of the organization's service accounts; {@link iter} follows every page. */
  async list(
    orgId?: string,
    query: { cursor?: string; limit?: number } = {},
  ): Promise<{ data: JsonObject[]; next_cursor?: string | null; has_more?: boolean }> {
    return this.transport.request({
      method: "GET",
      path: `${await this.orgBase(orgId)}/service-accounts`,
      query: { cursor: query.cursor, limit: query.limit },
    });
  }

  /** Every service account of the organization, following cursors. */
  async *iter(orgId?: string, pageSize?: number): AsyncGenerator<JsonObject> {
    yield* this.transport.paginate<JsonObject>(
      { method: "GET", path: `${await this.orgBase(orgId)}/service-accounts` },
      pageSize,
    );
  }

  /**
   * Web app only: creating a service account needs a signed-in person, so API
   * keys and tokens are refused with `session_required`. Create it under
   * Settings > Organization > Developer, then use its key from your backend.
   */
  async create(
    name: string,
    role: "member" | "admin" | "viewer" = "member",
    orgId?: string,
  ): Promise<JsonObject> {
    return this.transport.request({
      method: "POST",
      path: `${await this.orgBase(orgId)}/service-accounts`,
      body: { name, role },
    });
  }

  /**
   * Deactivates the account and revokes its keys. Web app only: API keys and
   * tokens are refused with `session_required`.
   */
  async disable(accountId: string, orgId?: string): Promise<JsonObject> {
    return this.transport.request({
      method: "POST",
      path: `${await this.orgBase(orgId)}/service-accounts/${enc(accountId)}/disable`,
    });
  }

  /**
   * A scoped key owned by the service account; `key` is returned once. Web app
   * only: keys and tokens never create keys, so API keys and tokens are refused
   * with `session_required`.
   */
  async mintKey(
    accountId: string,
    options: MintKeyOptions,
    orgId?: string,
  ): Promise<JsonObject> {
    return this.transport.request({
      method: "POST",
      path: `${await this.orgBase(orgId)}/service-accounts/${enc(accountId)}/keys`,
      body: cleanBody({
        scopes: options.scopes,
        name: options.name,
        project_ids: options.projectIds,
        expires_in_days: options.expiresInDays,
        client_name: credentialClient(options.clientName, this.transport.clientName),
      }),
    });
  }
}

/** Organization administration: service accounts (the rest of org administration is not in the documented API). */
export class OrgAdmin {
  readonly serviceAccounts: ServiceAccounts;

  constructor(transport: Transport) {
    this.serviceAccounts = new ServiceAccounts(transport);
  }
}
