// Build src/generated/operations.ts: one typed method for every operation in the
// public contract, grouped by area, plus the explicit OPERATIONS table that
// test/contract-coverage.test.ts checks against the contract.
//
// Names come from the operationId FastAPI generates ("{function}{path}_{method}"):
// the route function's name, minus a trailing "_route", in camelCase.

const METHODS = ["get", "post", "put", "patch", "delete"];

// Tags that name the same area for an SDK user.
const AREA_ALIASES = {
  "integrations:nango": "integrations",
  "skill-lifecycle": "skills",
  "organization-admin": "orgAdmin",
};

// Routes whose router tag names a neighbouring area rather than their own.
const PATH_AREAS = {
  "/v1/usage": "usage",
};

const camel = (text) =>
  text
    .replace(/[^A-Za-z0-9]+(.)?/g, (_m, c) => (c ? c.toUpperCase() : ""))
    .replace(/^[A-Z]/, (c) => c.toLowerCase());
const pascal = (text) => {
  const c = camel(text);
  return c.charAt(0).toUpperCase() + c.slice(1);
};

function functionName(operationId, path, method) {
  const pathSlug = path.replace(/\W/g, "_");
  const suffix = `${pathSlug}_${method}`;
  const name = operationId.endsWith(suffix)
    ? operationId.slice(0, operationId.length - suffix.length)
    : operationId;
  return name.replace(/_route$/, "");
}

function areaOf(operation, path) {
  if (PATH_AREAS[path]) return PATH_AREAS[path];
  const tag = (operation.tags ?? []).find((t) => t !== "public");
  if (tag) return camel(AREA_ALIASES[tag] ?? tag);
  return camel(path.split("/")[2] ?? "general");
}

function responseKind(operation) {
  for (const code of ["200", "201", "202", "204"]) {
    const response = operation.responses?.[code];
    if (!response) continue;
    if (code === "204") return "none";
    const content = Object.keys(response.content ?? {});
    if (content.length === 0) return "none";
    if (content.includes("application/json")) return "json";
    // Server-sent events are consumed as they arrive, never buffered to the end.
    if (content.includes("text/event-stream")) return "stream";
    // Text only when every format is text: an operation that may also answer a
    // PDF or a zip (an output exported as md or pdf) must keep the bytes exact.
    if (content.every((c) => c.startsWith("text/"))) return "text";
    return "bytes";
  }
  return "json";
}

export function collectOperations(spec) {
  const operations = [];
  const taken = new Map();
  // A deprecated path kept beside its canonical replacement runs the same
  // handler, so both carry the handler's name; the canonical path is named
  // first and keeps it, the deprecated one becomes `<name>Legacy`.
  const entries = [];
  for (const [path, item] of Object.entries(spec.paths).sort(([a], [b]) => a.localeCompare(b))) {
    for (const method of METHODS) if (item[method]) entries.push([path, method, item[method]]);
  }
  const deprecated = (op) => Boolean(op["x-beakr-canonical-path"]);
  entries.sort((a, b) => Number(deprecated(a[2])) - Number(deprecated(b[2])));
  for (const [path, method, operation] of entries) {
    {
      const area = areaOf(operation, path);
      let name = camel(functionName(operation.operationId, path, method));
      if (deprecated(operation) && taken.has(`${area}.${name}`)) name = `${name}Legacy`;
      const key = `${area}.${name}`;
      if (taken.has(key)) name = `${name}${pascal(method)}`;
      taken.set(`${area}.${name}`, true);
      const params = operation.parameters ?? [];
      const pathParams = params.filter((p) => p.in === "path").map((p) => p.name);
      const queryParams = params.filter((p) => p.in === "query");
      const content = Object.keys(operation.requestBody?.content ?? {});
      operations.push({
        area,
        name,
        method: method.toUpperCase(),
        path,
        operationId: operation.operationId,
        pathParams,
        hasQuery: queryParams.length > 0,
        queryRequired: queryParams.some((p) => p.required),
        body: content.length === 0 ? null : content.includes("application/json") ? "json" : "form",
        bodyRequired: Boolean(operation.requestBody?.required),
        response: responseKind(operation),
        anonymous: Array.isArray(operation.security) && operation.security.length === 0,
        paginated: queryParams.some((p) => p.name === "cursor"),
        summary: operation.summary ?? "",
        replacedBy: operation["x-beakr-canonical-path"] ?? null,
      });
    }
  }
  return operations;
}

function pathExpression(op) {
  const template = op.path.replace(/\{([^}]+)\}/g, (_m, name) => `\${enc(String(args.path.${name}))}`);
  return "`" + template + "`";
}

function argsType(op) {
  const t = `operations["${op.operationId}"]`;
  const fields = [];
  if (op.pathParams.length) fields.push(`path: ${t}["parameters"]["path"]`);
  if (op.hasQuery) {
    fields.push(`query${op.queryRequired ? "" : "?"}: NonNullable<${t}["parameters"]["query"]>`);
  }
  if (op.body === "json") {
    fields.push(
      `body${op.bodyRequired ? "" : "?"}: NonNullable<${t}["requestBody"]>["content"]["application/json"]`,
    );
  }
  if (op.body === "form") fields.push(`body${op.bodyRequired ? "" : "?"}: FormData`);
  return fields.length ? `{ ${fields.join("; ")} }` : null;
}

function argsRequired(op) {
  return op.pathParams.length > 0 || op.queryRequired || (op.body && op.bodyRequired);
}

function requestLiteral(op) {
  const parts = [`method: "${op.method}"`, `path: ${op.pathParams.length ? pathExpression(op) : `"${op.path}"`}`];
  if (op.hasQuery) parts.push("query: args?.query as Record<string, QueryValue> | undefined");
  if (op.body) parts.push("body: args?.body");
  if (op.anonymous) parts.push("authenticated: false");
  if (op.method === "POST" && !op.anonymous) parts.push("idempotent: true");
  if (op.response !== "json" && op.response !== "stream") parts.push(`responseType: "${op.response}"`);
  if (op.response === "stream") parts.push(`headers: { ...options?.headers, Accept: "text/event-stream" }`);
  parts.push("idempotencyKey: options?.idempotencyKey");
  parts.push("signal: options?.signal");
  if (op.response !== "stream") parts.push("headers: options?.headers");
  return `{ ${parts.join(", ")} }`;
}

function responseType(op) {
  if (op.response === "none") return "void";
  if (op.response === "text") return "string";
  if (op.response === "bytes") return "Uint8Array";
  if (op.response === "stream") return "AsyncGenerator<RunEvent>";
  return `OperationResponse<operations["${op.operationId}"]>`;
}

/** The source of src/generated/operations.ts for a contract document. */
export function renderOperations(spec) {
  const root = "../";
  const operations = collectOperations(spec);
  const areas = new Map();
  for (const op of operations) {
    if (!areas.has(op.area)) areas.set(op.area, []);
    areas.get(op.area).push(op);
  }
  const out = [];
  out.push("// Generated by scripts/generate.mjs from the Beakr public OpenAPI document. Do not edit.");
  out.push("// One typed method per public operation, grouped by area: beakr.api.<area>.<method>().");
  out.push(`import type { QueryValue, RequestOptions, Transport } from "${root}core.js";`);
  out.push(`import type { CallOptions, OperationResponse, PageItem } from "${root}operation-types.js";`);
  out.push('import type { operations } from "./schema.js";');
  out.push(`import { eventStream, type RunEvent } from "${root}resources/runs.js";`);
  out.push(`import { segment as enc } from "${root}paths.js";`);
  out.push("");
  out.push("/** Every public operation: SDK name -> HTTP method and contract path. */");
  out.push("export const OPERATIONS = {");
  for (const op of operations) {
    out.push(`  "${op.area}.${op.name}": { method: "${op.method}", path: "${op.path}" },`);
  }
  out.push("} as const;");
  out.push("");
  out.push("export type OperationName = keyof typeof OPERATIONS;");
  out.push("");
  for (const [area, ops] of [...areas.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    out.push(`/** Public operations tagged ${area}. */`);
    out.push(`export class ${pascal(area)}Api {`);
    out.push("  constructor(private readonly transport: Transport) {}");
    for (const op of ops) {
      const type = argsType(op);
      const argList = type ? `args${argsRequired(op) ? "" : "?"}: ${type}, ` : "";
      const call = requestLiteral(op);
      out.push("");
      out.push(
        op.replacedBy
          ? `  /** ${op.method} ${op.path}. @deprecated Use the method for ${op.replacedBy}. */`
          : `  /** ${op.method} ${op.path}${op.summary ? ` (${op.summary})` : ""} */`,
      );
      out.push(`  ${op.name}(${argList}options?: CallOptions): Promise<${responseType(op)}> {`);
      out.push(`    const request: RequestOptions = ${call};`);
      if (op.response === "stream") {
        // Resolves once the response headers arrive; events are read as the
        // server sends them.
        out.push("    return this.transport.raw(request).then((response) => eventStream(response));");
      } else {
        out.push("    return this.transport.request(request);");
      }
      out.push("  }");
      if (op.paginated) {
        out.push("");
        out.push(`  /** Every item of ${op.method} ${op.path}, following its cursor. */`);
        out.push(
          `  ${op.name}All(${argList}options?: CallOptions & { pageSize?: number }): AsyncGenerator<PageItem<operations["${op.operationId}"]>> {`,
        );
        out.push(`    const request: RequestOptions = ${call};`);
        out.push("    return this.transport.paginate(request, options?.pageSize);");
        out.push("  }");
      }
    }
    out.push("}");
    out.push("");
  }
  out.push("/** All areas, as exposed on `beakr.api`. */");
  out.push("export class BeakrApi {");
  for (const area of [...areas.keys()].sort()) out.push(`  readonly ${area}: ${pascal(area)}Api;`);
  out.push("");
  out.push("  constructor(transport: Transport) {");
  for (const area of [...areas.keys()].sort()) out.push(`    this.${area} = new ${pascal(area)}Api(transport);`);
  out.push("  }");
  out.push("}");
  out.push("");
  return { source: out.join("\n"), count: operations.length, areas: areas.size };
}
