import { segment } from "../paths.js";
import type { Transport } from "../core.js";

export abstract class Resource {
  constructor(protected readonly transport: Transport) {}
}

/** Org-addressed resources: an explicit org id, else the transport's shared resolution. */
export abstract class OrgScoped extends Resource {
  protected async orgBase(orgId?: string): Promise<string> {
    return `/v1/organizations/${segment(orgId ?? (await this.transport.resolveOrgId()))}`;
  }
}

export const enc = segment;

/**
 * The client a new key records: `explicit`, else this SDK's own name without
 * its version (`sdk-typescript/1.2.0` records `sdk-typescript`). The API
 * requires every key to record one and refuses a blank one.
 */
export function credentialClient(explicit: string | undefined, transportClient: string): string {
  const name = (explicit ?? transportClient.split("/", 1)[0] ?? "").trim();
  if (!name) throw new TypeError("clientName must name the client the key is for");
  return name;
}
