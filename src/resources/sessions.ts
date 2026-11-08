import { cleanBody, type ClientOptions } from "../core.js";
import { UnexpectedResponseError } from "../errors.js";
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

type MakeClient<C> = (options: ClientOptions) => C;

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

  /** The session of the client making the request (a scoped client only). */
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

  /** End the session; its tokens stop working at once. */
  end(sessionId: string): Promise<Session> {
    return this.transport.request({ method: "POST", path: `/v1/sessions/${enc(sessionId)}/end` });
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
