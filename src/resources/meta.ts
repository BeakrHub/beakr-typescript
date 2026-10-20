import { cachedCapabilities, type Capabilities } from "../capabilities.js";
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
}
