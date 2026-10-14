import type { ResponseOf } from "../types.js";
import { Resource } from "./base.js";

export class Me extends Resource {
  get(): Promise<ResponseOf<"/v1/me", "get">> {
    return this.transport.request({ method: "GET", path: "/v1/me" });
  }

  /** The organization requests are scoped to. */
  activeOrg(): Promise<ResponseOf<"/v1/me/organization", "get">> {
    return this.transport.request({ method: "GET", path: "/v1/me/organization" });
  }
}
