import { BeakrApi } from "./generated/operations.js";
import type { JsonObject } from "./types.js";
import {
  Transport,
  type ClientOptions,
  type QueryValue,
  type RequestOptions,
  type TokenPair,
} from "./core.js";
import { Conversations } from "./resources/conversations.js";
import { EndUserTokens } from "./resources/end-user-tokens.js";
import { Engine } from "./resources/engine.js";
import { ExternalUsers } from "./resources/external-users.js";
import { Files } from "./resources/files.js";
import { Integrations } from "./resources/integrations.js";
import { Interviews } from "./resources/interviews.js";
import {
  Jobs,
  type Job,
  type JobReference,
  type JobWaitOptions,
} from "./resources/jobs.js";
import { Knowledge } from "./resources/knowledge.js";
import { Labels } from "./resources/labels.js";
import { Me } from "./resources/me.js";
import { Members } from "./resources/members.js";
import { Meta } from "./resources/meta.js";
import { OrgAdmin } from "./resources/org-admin.js";
import { Projects } from "./resources/projects.js";
import { Runs } from "./resources/runs.js";
import { Uploads } from "./resources/uploads.js";

/**
 * The Beakr API client.
 *
 *   const beakr = new Beakr({ apiKey: process.env.BEAKR_API_KEY });
 *   const me = await beakr.me.get();
 */
export class Beakr {
  readonly me: Me;
  /** The API describing itself: its OpenAPI document and what this server serves. */
  readonly meta: Meta;
  readonly projects: Projects;
  readonly members: Members;
  /** Organization administration: service accounts. */
  readonly org: OrgAdmin;
  /** The users of your own product, mirrored into your organization. */
  readonly externalUsers: ExternalUsers;
  /** Short-lived tokens you mint for the users of your own product. */
  readonly endUserTokens: EndUserTokens;
  /** Named groups of people mapped to projects. */
  readonly labels: Labels;
  readonly knowledge: Knowledge;
  readonly conversations: Conversations;
  readonly engine: Engine;
  readonly jobs: Jobs;
  readonly runs: Runs;
  /** Send an interview link and read what came back. */
  readonly interviews: Interviews;
  /** Connected integrations, and the read-only tools to query them. */
  readonly integrations: Integrations;
  /** Upload files: one presigned PUT, or resumable parts above 64 MB. */
  readonly uploads: Uploads;
  /** Download a file's original bytes (`download`, `downloadUrl`, Node `downloadTo`). */
  readonly files: Files;
  /** Every documented operation, one typed method each, grouped by area. */
  readonly api: BeakrApi;
  protected readonly transport: Transport;

  constructor(options: ClientOptions = {}) {
    this.transport = new Transport(options);
    this.me = new Me(this.transport);
    this.meta = new Meta(this.transport);
    this.projects = new Projects(this.transport);
    this.members = new Members(this.transport);
    this.org = new OrgAdmin(this.transport);
    this.externalUsers = new ExternalUsers(this.transport);
    this.endUserTokens = new EndUserTokens(this.transport);
    this.labels = new Labels(this.transport);
    this.knowledge = new Knowledge(this.transport);
    this.conversations = new Conversations(this.transport);
    this.engine = new Engine(this.transport);
    this.jobs = new Jobs(this.transport);
    this.runs = new Runs(this.transport);
    this.interviews = new Interviews(this.transport);
    this.integrations = new Integrations(this.transport);
    this.uploads = new Uploads(this.transport);
    this.files = new Files(this.transport);
    this.api = new BeakrApi(this.transport);
  }

  get baseUrl(): string {
    return this.transport.baseUrl;
  }

  /** The current token pair after any automatic refresh. */
  get tokens(): TokenPair | undefined {
    return this.transport.currentTokens;
  }

  /**
   * Every item of any public list, following `next_cursor`. Every list route
   * answers `{data, next_cursor, has_more}`, so one iterator walks any of them:
   * `for await (const project of beakr.paginate("/v1/projects")) { ... }`.
   */
  paginate<T = JsonObject>(
    path: string,
    query: Record<string, QueryValue> = {},
    options: { pageSize?: number } = {},
  ): AsyncGenerator<T> {
    return this.transport.paginate<T>(
      { method: "GET", path, query },
      options.pageSize,
    );
  }

  /** Wait for any long operation (a run, import, sync, ...): `await beakr.wait(run)`. */
  wait(job: JobReference, options?: JobWaitOptions): Promise<Job> {
    return this.jobs.wait(job, options);
  }

  /** Call any route, including ones without a resource method yet. */
  request<T = unknown>(options: RequestOptions): Promise<T> {
    return this.transport.request<T>(options);
  }
}
