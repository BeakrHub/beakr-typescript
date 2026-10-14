import { AnswerBuilder, TextStream, answerDelta, type Answer } from "../answers.js";
import { cleanBody } from "../core.js";
import { ValidationError } from "../errors.js";
import type { JsonObject } from "../types.js";
import { Resource, enc } from "./base.js";

export interface RunEvent {
  type: string;
  event_id?: string;
  [key: string]: unknown;
}

/**
 * The events of a `text/event-stream` response, yielded as they arrive and
 * ending at `stream_complete`. Used by the generated streaming operations.
 */
export async function* eventStream(
  response: Response,
): AsyncGenerator<RunEvent> {
  if (!response.body) return;
  for await (const event of parseSse(response.body)) {
    yield event;
    if (event.type === "stream_complete") return;
  }
}

/**
 * Parse a text/event-stream body into events (`data:` lines joined, `id:` kept).
 * `onId` hears every `id:` line, including an id sent with no data.
 * However iteration ends (the consumer stops, `stream_complete`, an error), the
 * HTTP body is cancelled unless it already ended and its reader is released.
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  onId?: (id: string) => void,
): AsyncGenerator<RunEvent> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  let data: string[] = [];
  let eventName: string | undefined;
  let id: string | undefined;
  const flush = (): RunEvent | undefined => {
    if (data.length === 0) return undefined;
    const raw = data.join("\n");
    data = [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { data: raw };
    }
    const event: RunEvent =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? {
            type: eventName ?? "message",
            ...(parsed as Record<string, unknown>),
          }
        : { type: eventName ?? "message", data: parsed };
    if (id !== undefined) event.event_id = id;
    eventName = undefined;
    return event;
  };
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      let newline = buffer.search(/\r?\n/);
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(
          buffer[newline] === "\r" ? newline + 2 : newline + 1,
        );
        if (line === "") {
          const event = flush();
          if (event) yield event;
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          const value =
            colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "data") data.push(value);
          else if (field === "event") eventName = value;
          else if (field === "id") {
            id = value;
            // An id with no data still moves the resume point (as EventSource does).
            onId?.(value);
          }
        }
        newline = buffer.search(/\r?\n/);
      }
      if (done) {
        finished = true;
        const event = flush();
        if (event) yield event;
        return;
      }
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export interface StartRunOptions {
  threadId?: string;
  projectId?: string;
  mode?: string;
  model?: string;
  timezone?: string;
  /**
   * Ids of files you can read, given to the agent the way files attached in
   * Beakr's chat are; the start fails with `not_found` if any is not readable.
   */
  files?: string[];
  /** Deduplicates resends of the same start; generated when omitted. */
  idempotencyKey?: string;
}

/** `runs.answer()`: the question plus the same options as `runs.start()`. */
export interface AnswerOptions extends StartRunOptions {
  question: string;
  signal?: AbortSignal;
}

/** Agent runs: start, follow, cancel. */
export class Runs extends Resource {
  /** Start a run (a new thread unless `threadId`). Returns `{run_id, thread_id, ...}`. */
  start(message: string, options: StartRunOptions = {}): Promise<JsonObject> {
    return this.transport.request({
      method: "POST",
      path: "/v1/runs",
      // The route returns the existing run for the same body key, so resends are safe.
      serverDeduplicated: true,
      body: cleanBody({
        idempotency_key:
          options.idempotencyKey ??
          globalThis.crypto.randomUUID().replace(/-/g, ""),
        message,
        thread_id: options.threadId,
        home_project_id: options.projectId,
        scope: options.projectId
          ? { projects: [{ id: options.projectId }] }
          : undefined,
        mode: options.mode,
        model: options.model,
        timezone: options.timezone,
        files: options.files?.length ? [...options.files] : undefined,
      }),
    });
  }

  /**
   * Ask the agent and wait for the whole answer:
   * `const { text, sources, run_id } = await beakr.runs.answer("question", { projectId })`
   * (or `runs.answer({ question, projectId })`). An empty question throws
   * `ValidationError` without sending a request.
   * `text` has its citations rendered as `[n]`, and `sources[n-1]` is the
   * public source record behind `[n]`. Throws `RunFailedError` when the run
   * ends `error`, `failed` or `cancelled`.
   */
  async answer(question: string, options?: Omit<AnswerOptions, "question">): Promise<Answer>;
  async answer(options: AnswerOptions): Promise<Answer>;
  async answer(
    questionOrOptions: string | AnswerOptions,
    maybeOptions: Omit<AnswerOptions, "question"> = {},
  ): Promise<Answer> {
    const { question, signal, ...start } =
      typeof questionOrOptions === "string"
        ? { ...maybeOptions, question: questionOrOptions }
        : questionOrOptions;
    if (typeof question !== "string" || !question.trim()) {
      // Refused here rather than sent: the API would answer 422 after a round trip.
      throw new ValidationError("runs.answer needs a non-empty question.", { code: "validation_error" });
    }
    const run = await this.start(question, start);
    const runId = String(run["run_id"] ?? run["id"]);
    const builder = new AnswerBuilder(runId);
    for await (const event of this.stream(runId, signal ? { signal } : {})) builder.feed(event);
    // The run as the server reports it once the stream ends: its rendered
    // answer, or the question it parked on.
    return builder.result(await this.get(runId));
  }

  /**
   * The visible answer text of a run as it is written, thinking left out and
   * citations numbered `[n]` in order of first use:
   * `for await (const chunk of beakr.runs.streamText(runId)) process.stdout.write(chunk)`.
   */
  async *streamText(
    runId: string,
    options: { lastEventId?: string; signal?: AbortSignal } = {},
  ): AsyncGenerator<string> {
    const citations = new TextStream();
    for await (const event of this.stream(runId, options)) {
      const chunk = citations.feed(answerDelta(event));
      if (chunk) yield chunk;
    }
    const rest = citations.finish();
    if (rest) yield rest;
  }

  get(runId: string): Promise<JsonObject> {
    return this.transport.request({
      method: "GET",
      path: `/v1/runs/${enc(runId)}`,
    });
  }

  cancel(runId: string): Promise<void> {
    return this.transport.request({
      method: "POST",
      path: `/v1/runs/${enc(runId)}/cancel`,
      responseType: "none",
    });
  }

  /**
   * The run's events as they happen, until `stream_complete`. Each item is the
   * parsed `data` of one server-sent event, with its `id` as `event_id`; pass
   * the last `event_id` as `lastEventId` to resume after a disconnect.
   */
  async *stream(
    runId: string,
    options: { lastEventId?: string; signal?: AbortSignal } = {},
  ): AsyncGenerator<RunEvent> {
    const response = await this.transport.raw({
      method: "GET",
      path: `/v1/runs/${enc(runId)}/events`,
      query: { last_event_id: options.lastEventId },
      headers: { Accept: "text/event-stream" },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.body) return;
    for await (const event of parseSse(response.body)) {
      yield event;
      if (event.type === "stream_complete") return;
    }
  }

  /** The caller's threads. */
  threads(query: { limit?: number } = {}): Promise<unknown> {
    return this.transport.request({
      method: "GET",
      path: "/v1/me/threads",
      query,
    });
  }
}
