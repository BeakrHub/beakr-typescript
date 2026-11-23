import { cachedCapabilities, type Capabilities } from "../capabilities.js";
import {
  cachedInstallationClients,
  INSTALLATION_MANIFEST_PATH,
  type InstallationClients,
  warnOnceOnMismatch,
} from "../installation-clients.js";
import type { ResponseOf } from "../types.js";
import { Resource } from "./base.js";

/** The API describing itself. */
export class Meta extends Resource {
  /** The public OpenAPI document (every operation a key or token may call). */
  openapi(): Promise<ResponseOf<"/v1/public/openapi.json", "get">> {
    return this.transport.request({ method: "GET", path: "/v1/public/openapi.json", authenticated: false });
  }

  /**
   * Which documented operations this server serves, as a {@link Capabilities}.
   *
   * Read from the server's own OpenAPI document, fetched at most once per base
   * URL every few minutes (`{ refresh: true }` reads it again now). A
   * self-hosted installation serves less than the hosted service:
   * `(await beakr.meta.capabilities()).serves("GET", "/v1/integrations")` says
   * whether this one has integrations before a call answers 404.
   */
  capabilities(options: { refresh?: boolean } = {}): Promise<Capabilities> {
    return cachedCapabilities(this.transport.baseUrl, () => this.openapi(), options);
  }

  /**
   * The client versions this installation's release ships, or `null`.
   *
   * A self-hosted installation serves its release's manifest at
   * `/clients/manifest.json` (no credential is sent): its release and, per
   * client package, the exact version and how to install it from the
   * installation itself. `null` from a server that serves none (hosted Beakr,
   * an older release). Kept per base URL for a few minutes; `{ refresh: true }`
   * reads it again now.
   */
  installationClients(options: { refresh?: boolean } = {}): Promise<InstallationClients | null> {
    return cachedInstallationClients(
      this.transport.baseUrl,
      () =>
        this.transport.request<string>({
          method: "GET",
          path: INSTALLATION_MANIFEST_PATH,
          authenticated: false,
          responseType: "text",
        }),
      options,
    );
  }

  /**
   * {@link installationClients}, warning once (`console.warn`) per installation
   * and shipped version when this SDK is not the version the release ships.
   */
  async checkInstallationClients(options: { refresh?: boolean } = {}): Promise<InstallationClients | null> {
    const found = await this.installationClients(options);
    warnOnceOnMismatch(found);
    return found;
  }
}
