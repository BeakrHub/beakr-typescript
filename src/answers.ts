/**
 * Turn an agent run's event stream into an answer a program can show.
 *
 * A run streams `content_delta` events (some marked `is_thinking`), `sources`
 * events keyed by citation key, and a closing `stream_complete` carrying the
 * final text. Its citations are `{{key}}` tokens. `AnswerBuilder` folds those
 * events into `{text, sources, run_id}`. Once the run has finished, the answer
 * is the engine's own rendering from `GET /v1/runs/{run_id}`: each citation
 * shown as the readable reference in parentheses (`(memo.pdf › p. 7)`), and
 * one public source record per cited document in order of first use. Only a
 * server that does not send that rendering gets the answer assembled from the
 * stream, with each `{{key}}` numbered `[n]` and `sources[n-1]` behind it.
 * `TextStream` numbers streamed deltas `[n]` per citation key, for showing an
 * answer as it is written. A port of the Python SDK's `beakr_sdk/answers.py`;
 * keep the two in step.
 */
import { BeakrError } from "./errors.js";
import { publicSource, type SourceRecord } from "./sources.js";

/** What `runs.answer()` returns. */
export interface Answer {
  /**
   * The answer, each citation shown as the readable reference in parentheses
   * (`(memo.pdf › p. 7)`, `(Page Title › Section)`). From a server that does
   * not render answers, the citations are numbered `[n]` instead.
   */
  text: string;
  /**
   * The cited documents in order of first use, as public source records: one
   * per document, however many of its passages the text cites. With `[n]`
   * citations, `sources[n-1]` is the record behind `[n]`.
   */
  sources: SourceRecord[];
  run_id: string;
}

/** The run ended without an answer (`error`, `failed` or `cancelled`). */
export class RunFailedError extends BeakrError {}

/** What a parked run asks the person: `GET /v1/runs/{run_id}`'s `question`. */
export interface RunQuestion {
  text?: string;
  options?: unknown[];
  context?: unknown;
  [key: string]: unknown;
}

/**
 * The run stopped to ask the person something (status `interrupted`) instead
 * of answering, and sent no answer text. Answer `question` by starting a run in
 * `threadId`.
 */
export class RunNeedsInputError extends RunFailedError {
  constructor(
    message: string,
    readonly runId: string,
    readonly threadId: string | undefined,
    readonly question: RunQuestion | undefined,
    readonly interruptKind: string | undefined,
  ) {
    super(message, { code: "interrupted" });
  }
}

const CITATION_TOKEN = /\{\{([^}]+)\}\}/g;

/**
 * A citation key is short; text held back waiting for a closing `}}` longer
 * than this is ordinary text and is released rather than stalling the stream.
 */
const MAX_PENDING = 256;

const FAILED = new Set(["error", "failed", "cancelled"]);

interface StreamedEvent {
  type: string;
  data?: unknown;
  [key: string]: unknown;
}

const dataOf = (event: StreamedEvent): Record<string, unknown> =>
  event.data && typeof event.data === "object" ? (event.data as Record<string, unknown>) : {};

/**
 * Turn `{{key}}` citation tokens into `[n]` in order of first use. `order`
 * collects each key the first time it is seen; pass the same array across calls
 * (a streamed answer) to keep the numbering stable.
 */
export function numberCitations(text: string, order: string[]): string {
  return text.replace(CITATION_TOKEN, (_match, key: string) => {
    if (!order.includes(key)) order.push(key);
    return `[${order.indexOf(key) + 1}]`;
  });
}

/**
 * Numbers citations in streamed text even when a token spans deltas. Only the
 * shortest suffix that could still start an unfinished `{{key}}` is held back.
 */
export class TextStream {
  private pending = "";
  constructor(readonly order: string[] = []) {}

  feed(delta: string): string {
    const text = numberCitations(this.pending + delta, this.order);
    let cut = text.length;
    const opening = text.lastIndexOf("{{");
    if (opening !== -1 && !text.slice(opening).includes("}}")) cut = opening;
    else if (text.endsWith("{")) cut = text.length - 1;
    if (text.length - cut > MAX_PENDING) cut = text.length;
    this.pending = text.slice(cut);
    return text.slice(0, cut);
  }

  finish(): string {
    const rest = this.pending;
    this.pending = "";
    return rest;
  }
}

/** The visible answer text an event adds (empty for thinking and other events). */
export function answerDelta(event: StreamedEvent): string {
  const data = dataOf(event);
  if (event.type === "content_delta" && !data["is_thinking"]) return String(data["delta"] ?? "");
  return "";
}

/** Folds a run's events into `{text, sources, run_id}`. */
export class AnswerBuilder {
  private readonly deltas: string[] = [];
  private finalText: string | undefined;
  private readonly sources = new Map<string, Record<string, unknown>>();
  private status = "completed";
  private error: string | undefined;
  threadId: string | undefined;
  interruptKind: string | undefined;

  constructor(readonly runId: string) {}

  /** The run parked on a question for the person instead of answering. */
  get interrupted(): boolean {
    return this.status === "interrupted";
  }

  feed(event: StreamedEvent): void {
    const data = dataOf(event);
    const threadId = (event as { thread_id?: unknown }).thread_id;
    if (threadId) this.threadId = String(threadId);
    const delta = answerDelta(event);
    if (delta) {
      this.deltas.push(delta);
    } else if (event.type === "sources") {
      const list = Array.isArray(data["sources"]) ? data["sources"] : [];
      for (const source of list) {
        if (!source || typeof source !== "object") continue;
        const key = (source as Record<string, unknown>)["key"];
        if (!key) continue;
        // A later event for the same key carries more (quote, path).
        this.sources.set(String(key), { ...(this.sources.get(String(key)) ?? {}), ...(source as Record<string, unknown>) });
      }
    } else if (event.type === "error") {
      this.error = String(data["message"] ?? data["error"] ?? "the run failed");
    } else if (event.type === "stream_complete") {
      if (data["status"]) this.status = String(data["status"]);
      if (data["interrupt_kind"]) this.interruptKind = String(data["interrupt_kind"]);
      if (typeof data["final_text"] === "string") this.finalText = data["final_text"];
    }
  }

  /**
   * The answer; throws `RunFailedError` when the run ended without one, and
   * `RunNeedsInputError` (with `question`, read from the run by the caller)
   * when it parked on a question rather than returning an empty answer.
   */
  result(run?: Record<string, unknown>): Answer {
    // `run` is GET /v1/runs/{run_id} after the stream ended. Its `answer` (the
    // engine's own rendering) is the answer when present; streamed sources only
    // fill in what its records leave out (a document's file id). Without it (an
    // older server) the answer is assembled from the stream.
    const state = run ?? {};
    const status = String(state["status"] ?? this.status);
    if (this.interrupted || status === "interrupted") {
      const question = (state["question"] && typeof state["question"] === "object" ? state["question"] : undefined) as
        | RunQuestion
        | undefined;
      const asked = question?.text;
      throw new RunNeedsInputError(
        `Run ${this.runId} is waiting for an answer` + (asked ? `: ${asked}` : " (it asked the person a question)"),
        this.runId,
        this.threadId ?? (typeof state["thread_id"] === "string" ? state["thread_id"] : undefined),
        question,
        this.interruptKind ?? (typeof state["interrupt_kind"] === "string" ? state["interrupt_kind"] : undefined),
      );
    }
    if (this.error !== undefined || FAILED.has(this.status) || FAILED.has(status)) {
      const reason = this.error ?? `the run ended ${FAILED.has(status) ? status : this.status}`;
      throw new RunFailedError(`Run ${this.runId}: ${reason}`, { code: status });
    }
    const answer = state["answer"] as { text?: unknown; sources?: unknown } | null | undefined;
    if (answer && typeof answer.text === "string") {
      const records = Array.isArray(answer.sources) ? answer.sources : [];
      return {
        text: answer.text.trim(),
        sources: records
          .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
          .map((record) => {
            const key = typeof record["citation_key"] === "string" ? record["citation_key"] : undefined;
            const streamed = key ? (this.sources.get(key) ?? {}) : {};
            return publicSource({ ...streamed, ...record }, key);
          }),
        run_id: this.runId,
      };
    }
    const raw = this.finalText ?? this.deltas.join("");
    const order: string[] = [];
    const text = numberCitations(raw, order);
    const sources = order.map((key) => publicSource(this.sources.get(key) ?? { key }, key));
    return { text: text.trim(), sources, run_id: this.runId };
  }
}
