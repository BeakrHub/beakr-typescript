import { cleanBody, newSessionId, onTransport, type ClientOptions } from "../core.js";
import { NotFoundError, UnexpectedResponseError, ValidationError } from "../errors.js";
import type { ResponseOf } from "../types.js";
import { Resource, credentialClient, enc } from "./base.js";

export type Session = ResponseOf<"/v1/sessions/{session_id}", "get">;
export type SessionPage = ResponseOf<"/v1/sessions", "get">;
export type SessionToken = ResponseOf<"/v1/sessions/{session_id}/tokens", "post">;

export interface CreateSessionOptions {
  /** Project ids the session may read. With neither list the session waits for the person to choose. */
  read?: string[];
  /** Project ids the session may write; each is also read (`write` alone reads the same projects). */
  write?: string[];
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
 * Agent sessions that read and write only the projects a person chooses. Start
 * one with your own credential and get back a client confined to it; the person
 * can change its projects at `pickerUrl` while it runs.
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
    const agentSessionId = newSessionId();
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
   * its `X-Beakr-Session` joins. With auto-lock, `lock_state` (`open`,
   * `locked`, `read_only`), `write_project` and `touched_projects` say what it
   * may still write.
   */
  current(): Promise<Session> {
    return this.transport.request({ method: "GET", path: "/v1/sessions/current" });
  }

  /**
   * Set the session's projects. From your own client this chooses or changes
   * them; from the session's scoped client it may only drop projects, and naming
   * one the session lacks throws `SessionWidenRefusedError`.
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
