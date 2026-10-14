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
  async list(orgId?: string): Promise<{ data: JsonObject[] }> {
    return this.transport.request({
      method: "GET",
      path: `${await this.orgBase(orgId)}/service-accounts`,
    });
  }

  /** Needs a web session (refused to keys and tokens with `session_required`). */
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

  /** Deactivates the account and revokes its keys. */
  async disable(accountId: string, orgId?: string): Promise<JsonObject> {
    return this.transport.request({
      method: "POST",
      path: `${await this.orgBase(orgId)}/service-accounts/${enc(accountId)}/disable`,
    });
  }

  /** A scoped key owned by the service account; `key` is returned once. */
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
