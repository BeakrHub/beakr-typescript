import { cleanBody, newSessionId, onTransport, type ClientOptions } from "../core.js";
import { NotFoundError, UnexpectedResponseError, ValidationError } from "../errors.js";
import type { ResponseOf } from "../types.js";
import { Resource, credentialClient, enc } from "./base.js";

export type Session = ResponseOf<"/v1/sessions/{session_id}", "get">;
export type SessionPage = ResponseOf<"/v1/sessions", "get">;
export type SessionToken = ResponseOf<"/v1/sessions/{session_id}/tokens", "post">;
/** One page of a session's read trail, newest first (`GET /v1/sessions/{session_id}/trail`). */
export type SessionTrailPage = ResponseOf<"/v1/sessions/{session_id}/trail", "get">;
/**
 * One read a session made: when (`at`), what (`op`: `search`, `cat`, `rows`,
 * `documents:<command>`, `read_file`, `research`...), the `projects` it
 * touched and the `items` it returned (pages, files, connector items, messages).
 */
export type SessionRead = SessionTrailPage["data"][number];
/**
 * Which projects a picked session could read and write, given the lists so far
 * (`POST /v1/sessions/options`): `valid`, every failing `reasons` entry, the
 * `notes` on held writes, and each readable project with its `boundary`,
 * `can_read`/`can_write` and the reason when it can't.
 */
export type SessionOptions = ResponseOf<"/v1/sessions/options", "post">;
/**
 * Where a session can still write, and why not elsewhere
 * (`GET /v1/sessions/current/status`, `GET /v1/sessions/{session_id}/status`).
 */
export type SessionStatus = ResponseOf<"/v1/sessions/current/status", "get">;
/** How a session works: `automatic`, `picked` or `read_everything`. */
export type SessionMode = "automatic" | "picked" | "read_everything";

export interface CreateSessionOptions {
  /**
   * Project ids the session may read (a picked session). With neither list nor
   * `readEverything` the session is automatic, or, where the organization makes
   * every session pick, waits for the person to choose.
   */
  read?: string[];
  /** Project ids the session may write; each is also read (`write` alone reads the same projects). */
  write?: string[];
  /** Read every project the person can read, locked ones included, and write none (no lists). */
  readEverything?: boolean;
  /** A label the person recognizes, such as the agent and folder. */
  label?: string;
  /** The folder the client runs in, shown on the picker. */
  folder?: string;
  /** The client shown to the person; defaults to this SDK's name. */
  clientName?: string;
  /** Token lifetime in seconds (3600 by default, at most 43200). */
  ttlSeconds?: number;
}

export interface UpdateSessionOptions {
  /** The read projects, replacing the list. Dropping one drops its write too. */
  read?: string[];
  /** The write projects, replacing the list; each must be a read project. */
  write?: string[];
  label?: string;
  /** Ask the client to reuse this selection in the session's folder (the person only). */
  rememberFolder?: boolean;
  /** Read every project and write none (not after an automatic session touched a project). */
  readEverything?: boolean;
  /** `automatic`: the server tracks what it touches instead (not in a `must_pick` organization). */
  mode?: "automatic";
}

/** A session and a client confined to it. */
export interface ScopedSession<C> {
  session: Omit<Session, "token">;
  /** Sends the session's token and mints a new one before it expires. */
  client: C;
  id: string;
  /** Where the person chooses and changes the session's projects. */
  pickerUrl: string;
}

export interface StartSessionOptions {
  /** A label the person recognizes, such as the job's name. */
  label?: string;
  /** The client shown to the person; defaults to this SDK's name. */
  clientName?: string;
  /** Project ids to read: a picked session (`create` takes them the same way). */
  read?: string[];
  /** Project ids to write; each is also read. */
  write?: string[];
  /** Read every project, locked ones included, and write none. */
  readEverything?: boolean;
}

type MakeClient<C> = (options: ClientOptions) => C;

/**
 * A session joined by `X-Beakr-Session`, and a client that sends its id
 * (`sessions.start`). `session` is the server's record of it (`mode`,
 * `lock_state`, `write_project`, `touched_projects`...) as it was when it
 * started; it is undefined on a server without sessions per agent
 * conversation, where the id only labels the writes. `current()` reads it again.
 */
export class AgentSession<C> {
  constructor(
    /** The `X-Beakr-Session` id `client` sends. */
    readonly agentSessionId: string,
    /** The same caller as the client that started it, in this session. */
    readonly client: C,
    readonly session: Session | undefined,
    private readonly sessions: Sessions<C>,
  ) {}

  /** The session's id on the server (undefined where the server keeps none). */
  get id(): string | undefined {
    return this.session ? String(this.session.id) : undefined;
  }

  /** The session now: its lock state, write project and the projects it touched. */
  current(): Promise<Session> {
    return this.sessions.current();
  }

  /** Where the session can still write, and why not elsewhere (`sessions.status`). */
  status(): Promise<SessionStatus> {
    return this.sessions.status();
  }

  /** One page of what the session read, newest first (`sessions.trail`). */
  trail(query: { cursor?: string; limit?: number } = {}): Promise<SessionTrailPage> {
    return this.sessions.trail(this.id, query);
  }

  /** End the session now. Its id is used up: requests with it throw `SessionEndedError`. */
  async end(): Promise<Session | undefined> {
    return this.id === undefined ? undefined : this.sessions.end(this.id);
  }
}

function expiresAtMs(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Agent sessions. A session works one of three ways (`mode`): `automatic` (it
 * starts open and the server tracks what it touches: touching a project whose
 * boundary is locked locks its writes to that project, a second makes it
 * read-only), `picked` (`read`/`write` lists declared at the start, checked
 * against the projects' boundaries: `SessionSelectionInvalidError` with every
 * reason; `options` says what can be added first) or `read_everything` (every
 * project, locked ones included, and no writes). A declaration applies only
 * while the session has touched nothing (`SessionAlreadyStartedError` after);
 * `status` says where it can still write. Start one with your own credential and
 * get back a client confined to it; the person can change a picked session's
 * projects at `pickerUrl` while it runs.
 */
export class Sessions<C = unknown> extends Resource {
  constructor(
    transport: ConstructorParameters<typeof Resource>[0],
    private readonly makeClient: MakeClient<C>,
  ) {
    super(transport);
  }

  /** Start a session and return a client confined to it. Not retried: a retry starts another. */
  async create(options: CreateSessionOptions = {}): Promise<ScopedSession<C>> {
    const read = options.read ?? (options.write ? [...options.write] : undefined);
    const created = await this.transport.request<Session & { token?: SessionToken | null }>({
      method: "POST",
      path: "/v1/sessions",
      body: cleanBody({
        client_name: credentialClient(options.clientName, this.transport.clientName),
        label: options.label,
        folder: options.folder,
        read_project_ids: read,
        write_project_ids: options.write,
        read_everything: options.readEverything,
        issue_token: true,
        ttl_seconds: options.ttlSeconds,
      }),
    });
    const { token, ...session } = created;
    return this.scope(session, token ?? undefined, options.ttlSeconds);
  }

  /** A scoped client for a session you started earlier (mints a fresh token). */
  async scoped(sessionId: string, options: { ttlSeconds?: number } = {}): Promise<ScopedSession<C>> {
    const token = await this.mintToken(sessionId, options);
    const session = await this.get(sessionId);
    return this.scope(session, token, options.ttlSeconds);
  }

  /**
   * A fresh session for a block of work: makes a new `X-Beakr-Session` id,
   * starts that session on the server (`POST /v1/sessions` with
   * `agent_session`) and returns `client`, the same caller sending the id.
   * End it with `end()`, or use `within`, which ends it for you. On a server
   * without sessions per agent conversation nothing is started and `client`
   * only labels its writes with the id.
   */
  async start(options: StartSessionOptions = {}): Promise<AgentSession<C>> {
    const agentSessionId = await newSessionId();
    const transport = this.transport.withSession(agentSessionId);
    let session: Session | undefined;
    try {
      session = await transport.request<Session>({
        method: "POST",
        path: "/v1/sessions",
        body: cleanBody({
          agent_session: agentSessionId,
          label: options.label,
          client_name: credentialClient(options.clientName, this.transport.clientName),
          read_project_ids: options.read ?? (options.write ? [...options.write] : undefined),
          write_project_ids: options.write,
          read_everything: options.readEverything,
        }),
      });
    } catch (error) {
      // A server without sessions (404), or without sessions per conversation
      // (422 feature_not_enabled), starts none; the client still sends the id,
      // which labels its writes as one session.
      const notStarted =
        error instanceof NotFoundError || (error instanceof ValidationError && error.code === "feature_not_enabled");
      if (!notStarted) throw error;
    }
    const sessions = new Sessions<C>(transport, this.makeClient);
    return new AgentSession(agentSessionId, this.makeClient(onTransport(transport)), session, sessions);
  }

  /**
   * Run `work` in a fresh session (`start`) and end the session when it
   * settles, even when it throws:
   * `await beakr.sessions.within({ label: "import" }, async (s) => s.client.knowledge.write(...))`.
   */
  async within<T>(options: StartSessionOptions, work: (session: AgentSession<C>) => Promise<T>): Promise<T> {
    const session = await this.start(options);
    try {
      return await work(session);
    } finally {
      await session.end();
    }
  }

  /** One page of your sessions, newest first; a scoped client sees only its own. */
  list(query: { includeEnded?: boolean; cursor?: string; limit?: number } = {}): Promise<SessionPage> {
    return this.transport.request({
      method: "GET",
      path: "/v1/sessions",
      query: { include_ended: query.includeEnded, cursor: query.cursor, limit: query.limit },
    });
  }

  get(sessionId: string): Promise<Session> {
    return this.transport.request({ method: "GET", path: `/v1/sessions/${enc(sessionId)}` });
  }

  /**
   * The session this client's requests run in: a scoped client's, or the one
   * its `X-Beakr-Session` joins. Its `mode`, `summary`, `lock_state` (`open`,
   * `locked`, `read_only`), `write_project` and `touched_projects` say what it
   * may still write.
   */
  current(): Promise<Session> {
    return this.transport.request({ method: "GET", path: "/v1/sessions/current" });
  }

  /**
   * Which projects a picked session could read and write, given the lists so
   * far. With your own credential, not a session token.
   */
  options(lists: { read?: string[]; write?: string[] } = {}): Promise<SessionOptions> {
    return this.transport.request({
      method: "POST",
      path: "/v1/sessions/options",
      body: { read_project_ids: lists.read ?? [], write_project_ids: lists.write ?? [] },
    });
  }

  /**
   * Where a session can still write, and why not elsewhere: its `mode`,
   * `lock_state` (and `locked_to`), what it has read, `write.projects` it may
   * write (`outcome` `write` or `held`), `write.refused` with each project's
   * `code` and `reason`, a one-line `summary` and its last boundary `events`.
   * Without `sessionId`, the session this client's requests run in
   * (`NotFoundError` outside one).
   */
  status(sessionId?: string): Promise<SessionStatus> {
    const path = sessionId === undefined ? "/v1/sessions/current/status" : `/v1/sessions/${enc(sessionId)}/status`;
    return this.transport.request({ method: "GET", path });
  }

  /**
   * Set the session's projects. From your own client this chooses or changes
   * them (`readEverything` makes it read every project and write none); from the
   * session's scoped client it may only drop projects, and naming one the
   * session lacks throws `SessionWidenRefusedError`.
   */
  update(sessionId: string, options: UpdateSessionOptions): Promise<Session> {
    return this.transport.request({
      method: "PATCH",
      path: `/v1/sessions/${enc(sessionId)}`,
      body: cleanBody({
        read_project_ids: options.read,
        write_project_ids: options.write,
        label: options.label,
        remember_folder: options.rememberFolder,
        read_everything: options.readEverything,
        mode: options.mode,
      }),
    });
  }

  /**
   * End the session; its tokens stop working at once. Without `sessionId`,
   * ends the session this client's requests run in (`current`). An
   * `X-Beakr-Session` id is used once: after its session ends, this client's
   * requests throw `SessionEndedError`; make a new client or use `start`.
   */
  async end(sessionId?: string): Promise<Session> {
    const id = sessionId ?? String((await this.current()).id);
    return this.transport.request({ method: "POST", path: `/v1/sessions/${enc(id)}/end` });
  }

  /**
   * One page of what a session read, newest first: each read's `op`, the
   * `projects` it touched and the `items` it returned. Without `sessionId`, the
   * session this client's requests run in. Readable by the session's person,
   * organization admins, and owners or admins of a project it read (who see
   * only the reads that touched their projects). Needs the read trail turned on
   * (404 `feature_not_enabled` otherwise).
   */
  async trail(sessionId?: string, query: { cursor?: string; limit?: number } = {}): Promise<SessionTrailPage> {
    const id = sessionId ?? String((await this.current()).id);
    return this.transport.request({
      method: "GET",
      path: `/v1/sessions/${enc(id)}/trail`,
      query: { cursor: query.cursor, limit: query.limit },
    });
  }

  /** Every read of a session's trail (`trail`), newest first, following cursors. */
  async *iterTrail(sessionId?: string, pageSize?: number): AsyncGenerator<SessionRead> {
    const id = sessionId ?? String((await this.current()).id);
    yield* this.transport.paginate<SessionRead>({ method: "GET", path: `/v1/sessions/${enc(id)}/trail` }, pageSize);
  }

  /** Mint another token, with the credential that started the session. Not retried. */
  mintToken(sessionId: string, options: { ttlSeconds?: number } = {}): Promise<SessionToken> {
    return this.transport.request({
      method: "POST",
      path: `/v1/sessions/${enc(sessionId)}/tokens`,
      body: cleanBody({ ttl_seconds: options.ttlSeconds }),
    });
  }

  private scope(
    session: Omit<Session, "token">,
    token: SessionToken | undefined,
    ttlSeconds: number | undefined,
  ): ScopedSession<C> {
    if (!token?.token) {
      throw new UnexpectedResponseError(
        "The API answered without a session token; the session was created but no scoped " +
          "client can be built. Get one with sessions.scoped(sessionId).",
      );
    }
    const id = String(session.id);
    const options: ClientOptions = {
      ...this.transport.sharedOptions(),
      apiKey: token.token,
      renewApiKey: async () => {
        const minted = await this.mintToken(id, ttlSeconds === undefined ? {} : { ttlSeconds });
        const expiresAt = expiresAtMs(minted.expires_at);
        return expiresAt === undefined ? { token: minted.token } : { token: minted.token, expiresAt };
      },
    };
    const expiresAt = expiresAtMs(token.expires_at);
    if (expiresAt !== undefined) options.apiKeyExpiresAt = expiresAt;
    return { session, client: this.makeClient(options), id, pickerUrl: String(session.picker_url) };
  }
}
