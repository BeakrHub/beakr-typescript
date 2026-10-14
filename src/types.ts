/**
 * Helpers that read request and response types out of the generated public
 * schema, so a resource method's types follow the published contract.
 */
import type { paths } from "./generated/schema.js";

export type { components, operations, paths } from "./generated/schema.js";

type Method = "get" | "post" | "put" | "patch" | "delete";
type Operation<P extends keyof paths, M extends Method> = M extends keyof paths[P]
  ? NonNullable<paths[P][M]>
  : never;

type JsonOf<R> = R extends { content: { "application/json": infer B } } ? B : unknown;

/** The JSON body of the operation's success response (200, 201 or 202). */
export type ResponseOf<P extends keyof paths, M extends Method> =
  Operation<P, M> extends { responses: infer R }
    ? R extends { 200: infer S }
      ? JsonOf<S>
      : R extends { 201: infer S }
        ? JsonOf<S>
        : R extends { 202: infer S }
          ? JsonOf<S>
          : unknown
    : unknown;

/** The JSON request body the operation accepts. */
export type BodyOf<P extends keyof paths, M extends Method> =
  Operation<P, M> extends { requestBody?: { content: { "application/json": infer B } } }
    ? B
    : never;

/** A cursor-paginated page. */
export interface Page<T> {
  data: T[];
  next_cursor: string | null;
  has_more: boolean;
}

export type JsonObject = Record<string, unknown>;
