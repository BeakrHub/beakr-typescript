import { cleanBody } from "../core.js";
import type { BodyOf, JsonObject, ResponseOf } from "../types.js";
import { Resource, enc } from "./base.js";

export type IntegrationToolPage = ResponseOf<"/v1/integrations/tools", "get">;
export type IntegrationTool = IntegrationToolPage["data"][number];
export type IntegrationToolResult = ResponseOf<"/v1/integrations/tools/{tool_name}/call", "post">;
type ToolCallBody = NonNullable<BodyOf<"/v1/integrations/tools/{tool_name}/call", "post">>;

export interface ToolsQuery {
  /** Only this provider's tools (`slack`, `google-drive`, ...). */
  provider?: string;
  /** Only the tools of this one connection. */
  connectorId?: string;
  cursor?: string;
  limit?: number;
}

/**
 * Integrations: connect (a browser link; OAuth finishes in the browser), list,
 * status and disconnect, and query what the caller has connected with the
 * same read-only tools Beakr's agent uses (`tools`, `callTool`). Scopes
 * `integrations:read` / `integrations:admin`.
 */
export class Integrations extends Resource {
  /** One page of the connections you can see, each with the projects it feeds. */
  list(
    query: { cursor?: string; limit?: number } = {},
  ): Promise<{ data: JsonObject[]; next_cursor?: string | null; has_more?: boolean }> {
    return this.transport.request({
      method: "GET",
      path: "/v1/integrations",
      query: { cursor: query.cursor, limit: query.limit },
    });
  }

  /** Every connection you can see, following cursors. */
  iter(pageSize?: number): AsyncGenerator<JsonObject> {
    return this.transport.paginate({ method: "GET", path: "/v1/integrations" }, pageSize);
  }

  /** Returns `connect_url`; open it in a browser to finish connecting. */
  connect(provider: string, options: { scope?: "user" | "org" } = {}): Promise<JsonObject> {
    return this.transport.request({
      method: "POST",
      path: `/v1/integrations/${enc(provider)}/connect`,
      body: { scope: options.scope ?? "user" },
    });
  }

  status(connectorId: string): Promise<JsonObject> {
    return this.transport.request({ method: "GET", path: `/v1/integrations/${enc(connectorId)}/status` });
  }

  /**
   * One page of the read-only tools for the integrations the caller has
   * connected, each with its `input_schema` and the connections it can use.
   */
  tools(query: ToolsQuery = {}): Promise<IntegrationToolPage> {
    return this.transport.request({
      method: "GET",
      path: "/v1/integrations/tools",
      query: {
        provider: query.provider,
        connector_id: query.connectorId,
        cursor: query.cursor,
        limit: query.limit,
      },
    });
  }

  /** Every tool, following cursors. */
  iterTools(query: Omit<ToolsQuery, "cursor" | "limit"> = {}, pageSize?: number): AsyncGenerator<IntegrationTool> {
    return this.transport.paginate(
      {
        method: "GET",
        path: "/v1/integrations/tools",
        query: { provider: query.provider, connector_id: query.connectorId },
      },
      pageSize,
    );
  }

  /**
   * Run one read-only tool against the caller's connected integration and
   * answer its text, the sources it read, and whether it reported a failure.
   * `connectorId` picks the connection when the caller has more than one for
   * the provider. Tools that change data in the connected account are refused.
   */
  callTool(
    toolName: string,
    args: ToolCallBody["arguments"] = {},
    options: { connectorId?: string } = {},
  ): Promise<IntegrationToolResult> {
    return this.transport.request({
      method: "POST",
      path: `/v1/integrations/tools/${enc(toolName)}/call`,
      body: cleanBody({ arguments: args, connector_id: options.connectorId }),
    });
  }

  disconnect(connectorId: string): Promise<JsonObject> {
    return this.transport.request({ method: "DELETE", path: `/v1/integrations/${enc(connectorId)}` });
  }
}
