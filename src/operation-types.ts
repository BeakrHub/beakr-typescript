// Types the generated per-operation methods (src/generated/operations.ts) use to
// read request and response shapes straight from the contract's `operations`.

type SuccessOf<R> = R extends { 200: infer X }
  ? X
  : R extends { 201: infer X }
    ? X
    : R extends { 202: infer X }
      ? X
      : R extends { 204: unknown }
        ? { content?: never }
        : unknown;

/** The JSON a successful call returns, from the first 2xx response in the contract. */
export type OperationResponse<O> = O extends { responses: infer R }
  ? SuccessOf<R> extends { content: { "application/json": infer J } }
    ? J
    : SuccessOf<R> extends { content?: never }
      ? void
      : unknown
  : unknown;

/** Items of a cursor-paginated list response (`{data: [...]}`). */
export type PageItem<O> = OperationResponse<O> extends { data?: (infer I)[] | null } ? I : unknown;

/** Per-call options every generated method accepts. */
export interface CallOptions {
  /** Send this `Idempotency-Key` (creates only), so your own retries replay too. */
  idempotencyKey?: string;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}
