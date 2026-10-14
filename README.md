# @beakr/sdk

The TypeScript SDK for the Beakr public API. No runtime dependencies: it uses
`fetch` and Web Crypto, so it runs in Node 18+, Deno, Bun, browsers and edge
runtimes. Ships ESM and CommonJS with type definitions generated from the
published API contract.

```sh
npm install @beakr/sdk   # not on npm yet; see "Installing before the first release"
```

The [Python SDK](https://github.com/BeakrHub/beakr-python) (`beakr-sdk`) has the
same resources, and the [Beakr CLI](https://github.com/BeakrHub/beakr-cli) is
built on it.

## Quickstart

Create a key in the Beakr web app (Settings, API keys; keys are created only
there) and keep it in `BEAKR_API_KEY`.

```ts
import { Beakr } from "@beakr/sdk";

const beakr = new Beakr(); // reads BEAKR_API_KEY, or pass { apiKey }
// The API: `baseUrl`, else BEAKR_BASE_URL, else BEAKR_API_URL, else production.

const me = await beakr.me.get();
const projects = await beakr.projects.list();

// Read Knowledge through the same door Beakr's own agents use.
const page = await beakr.knowledge.command("cat", { page: "Pump calibration" }, { scope: "Assay Lab" });

// Context for an agent starting work, ready to drop into CLAUDE.md.
const context = await beakr.engine.context({ projectId: "...", format: "claude_md" });
```

### Where the credential comes from

The same order as the Python SDK, first match wins:

1. `apiKey` or `tokens` passed to the client;
2. `BEAKR_API_KEY`;
3. `serviceAccount` passed to the client (a parsed file or its path);
4. in Node.js, the Beakr CLI's sign-in for this API (`beakr auth login`): read
   from `~/.beakr/credentials` (`$BEAKR_HOME/credentials`) when that holds a
   current one, otherwise asked of the installed CLI (`beakr auth token --json`);
5. in Node.js, the key saved by `beakr auth login --api-key`, when it was saved
   for this API;
6. the service account file named by `BEAKR_SERVICE_ACCOUNT_FILE`, else
   `~/.beakr/service-account.json` when it exists.

A stored sign-in or saved key is only used by a client pointed at the API that
issued it. Pass `cliLogin: false` to skip links 4 and 5. Links 4 to 6 are
resolved at the client's first request and work on every supported Node
version (18 and later).

The CLI keeps its sign-in in the OS keychain when one is available (the
default on macOS), and refreshes it under a lock that only the CLI takes:
refreshing rotates the pair, and presenting a spent refresh token revokes the
login everywhere. So the SDK never reads the keychain or refreshes the sign-in
itself. When the credentials file has no current sign-in for the API -- it is
in the keychain, or its access token has expired -- the SDK runs the CLI
(`BEAKR_CLI_PATH`, else `beakr` on the `PATH`), which reads it the way every
`beakr` command does and refreshes it if needed, and keeps the access token it
prints in memory until it expires. After a 401 on that token the SDK asks the
CLI once more (naming the refused token by its SHA-256, never on the command
line) and resends once. The refresh token never leaves the CLI. Without the
CLI installed, an expired stored sign-in fails with `cli_login_expired`, and a
keychain sign-in is not found; pass a credential instead.

### Use a token pair you already hold

```ts
const signedIn = new Beakr({
  // An OAuth pair from Beakr's sign-in issuer, with where it refreshes.
  tokens, // { accessToken, refreshToken, expiresAt, tokenEndpoint, clientId }
  onTokens: (rotated) => saveSomewhere(rotated), // a refresh may rotate; persist each pair
});
```

The pair is refreshed at its issuer's `tokenEndpoint` (as the public client
`clientId`) before it expires and on a 401; a pair without a `tokenEndpoint` is
used until it expires and is not refreshed. To sign a person in, use the CLI
(`beakr auth login`); the SDK then finds that sign-in on its own (above).

### Upload a folder, download a file

```ts
// Node: walk a directory; sub-directories become folders, dotfiles are skipped.
const uploaded = await beakr.uploads.uploadFolder("./docs", { projectId });

// Browser or edge: the same, from entries (e.g. an <input webkitdirectory> list).
await beakr.uploads.uploadEntries(
  [...input.files].map((file) => ({ path: file.webkitRelativePath, data: file })),
  { projectId, ingest: false }, // ingest: false keeps the files out of Knowledge
);

const { data, filename } = await beakr.files.download(artifactId); // any runtime
await beakr.files.downloadTo(artifactId, "./downloads"); // Node
```

Many files or whole directories go up as one batch with one indexing job:
`const batch = await beakr.uploads.uploadMany(["results", "summary.pdf"], { projectId })`,
then `await beakr.jobs.wait(batch)` (or pass `wait: true`).

Every file goes through the resumable upload (a small file is one part); an interrupted one
rejects with `UploadInterruptedError`, whose `uploadId` resumes it with
`beakr.uploads.resume`. Folder uploads do not follow symbolic links. Node-only
helpers (`uploadFolder`, `downloadTo`) load `node:` modules lazily, so the SDK still imports
in edge and browser runtimes.

### Import a coding-agent session and compound it

```ts
const result = await beakr.conversations.import({
  client: "claude-code",
  sessionId: "session-123",
  baseIndex: alreadySent, // send only new messages, and say where they start
  messages: [{ role: "user", content: "Use the April calibration from now on." }],
  compound: true, // import and queue compounding in one request
});
```

Message text is kept only by opt-in. `compound: true` holds it, for a bounded
time, until the capture reads it; `holdText: true` holds it the same way for a
later `beakr.engine.compound(...)` without queuing one now; `storeFullText:
true` keeps it. A plain import keeps the summary and metadata only, and a later
compound answers `nothing_to_compound`.

Without `baseIndex` a batch is read as the whole session from the start. If the
server has a different count, the import rejects with a `ConflictError` whose
`expectedBaseIndex` says where to resend from.

### Query what the caller has connected

The same read-only tools Beakr's own agent uses on Slack, Drive, Jira and the
rest, against the integrations the caller connected:

```ts
const { data: tools } = await beakr.integrations.tools({ provider: "slack" });
const result = await beakr.integrations.callTool("slack_search", { query: "calibration" });
console.log(result.content, result.sources);
```

Tools that change data in the connected account are refused.

### Send an interview, read what came back

```ts
const link = await beakr.interviews.createLink("Assay onboarding", {
  goal: "How the team runs the plate reader",
  recipient: { name: "Ada", email: "ada@example.com" }, // recorded only; Beakr sends nothing
});
sendItYourself(link.url); // the link is shown once
const result = await beakr.interviews.linkResult(link.link_id);
if (result.status === "completed") await beakr.interviews.sendToProjects(link.link_id, [projectId]);
```

### Tokens for the users of your own product

With a service account's key, mirror your users and mint each a short-lived
token that can never do more than the key:

```ts
const user = await beakr.externalUsers.create({ external_id: "acme-42", name: "Ada" });
const { token } = await beakr.endUserTokens.mint({
  externalUserId: user.user_id,
  scopes: ["kb:read"],
  projectIds: [projectId],
  ttlSeconds: 900,
});
const asUser = new Beakr({ apiKey: token });
```

## Errors

Every failure is a `BeakrError` with `status`, `code` (from the error
envelope's `error.code`), `message` and `requestId`. Subclasses:
`AuthenticationError` (401), `PermissionDeniedError` (403, with
`requiredScope`), `NotFoundError`, `ConflictError`, `ValidationError`,
`RateLimitError` (with `retryAfter`), `ServerError`, `APIConnectionError`,
`KnowledgeCommandError` (a refused Knowledge command) and `DeviceLoginError`;
`runs.answer()` throws `RunFailedError` for a run
that ended `error`, `failed` or `cancelled`. An error from the API ends its
message with `(called <baseUrl>)` and carries `baseUrl`, so a key sent to the
wrong host reads as that. Branch on `code`, never on the message.

Codes a program should expect from sensitive actions: `session_required`
(do it in the web app), `mfa_required` (verify a second factor and retry),
`client_not_allowed`, `insufficient_scope`.

## Retries and idempotency

- 429 is retried for every request, waiting the server's `Retry-After`. The
  header may be seconds or an HTTP-date (IMF-fixdate, or the obsolete RFC 850
  and asctime forms); a date already past retries at once, and one that is not
  a valid date is ignored in favor of the normal backoff. A wait beyond 60
  seconds is not taken: the error is thrown instead, with
  `RateLimitError.retryAfter` in seconds.
- 500, 502, 503, 504 and connection errors are retried only where a resend
  cannot duplicate an effect: reads, `PUT`, `DELETE`, starting an agent run
  (the route deduplicates), and every public create.
- Creates send an `Idempotency-Key` that stays the same across retries, and
  the engine replays a create resent with the same key and body: the retry
  returns the first result, never a second resource (`REPLAYING_CREATES` in
  `src/replay.ts`). A resend that meets an earlier attempt still holding the
  key (409 `idempotency_in_progress`) waits its `Retry-After` and tries again.
- Other POSTs (decisions such as accept, token exchanges, reads with a body)
  are never resent after an ambiguous failure; 501, 505 and other 4xx are
  never retried.

`maxRetries` (default 2) and `timeoutMs` (default 60 000) are client options.

## Resources

The client covers the documented API only:

`me`, `projects`, `members`, `org` (`serviceAccounts`),
`externalUsers`, `endUserTokens`, `labels`, `uploads` (one file, a folder,
resume), `files` (downloads), `jobs` (`wait`), `knowledge` (with
`proposals` and `pages.sources()`), `conversations`, `engine` (`context`,
`compound`), `runs`, `interviews` and `integrations` (with `tools` /
`callTool`).

### Ask the agent

```ts
import { sourceWhere } from "@beakr/sdk";

const { text, sources, run_id } = await beakr.runs.answer("How long is a compile lease?", { projectId });
console.log(text); // "... lasts 300 seconds [1]."
for (const [i, source] of sources.entries()) console.log(`[${i + 1}] ${sourceWhere(source)}`);
```

`text` has its `{{key}}` citations rendered as `[n]` in order of first use, and
`sources[n-1]` is the public source record behind `[n]`: `filename`,
`provider`, `location` (`url`/`display_path` of the original, or `file_id` for
Beakr's copy), and the cited `evidence`. `knowledge.pages.sources(pageId)`
returns the same records. To show the answer as it is written,
`for await (const chunk of beakr.runs.streamText(runId))` yields the visible
text with citations numbered; `runs.stream()` yields the raw server-sent
events.

Uploads use the resumable flow (`/v1/uploads`) and declare the file's
SHA-256 (`content_hash`), hashed as a stream so no runtime holds the whole file.

Every operation in the documented contract also has a typed method on
`beakr.api`, grouped by area and generated from the contract:

```ts
const project = await beakr.api.projects.createProject(
  { body: { name: "Assays" } },
  { idempotencyKey: "create-assays" }, // a retry with the same key replays, never duplicates
);
await beakr.api.knowledge.getWikiPage({ path: { page_id: pageId } });
for await (const conversation of beakr.api.conversations.listConversationsAll()) {
  console.log(conversation);
}
```

Creates send an `Idempotency-Key` (pass your own to make retries across processes
safe); operations that page with a cursor also get an `...All()` iterator.
`OPERATIONS` lists every method's HTTP method and path, and
`test/contract-coverage.test.ts` fails if any contract operation lacks one.

## Development

```sh
npm install
npm run regen      # after an engine contract change: generate, typecheck, build
npm run generate   # regenerate src/generated/ from the documented contract
npm run build
npm test
npm run typecheck
```

Edge support is tested in Vercel's Edge Runtime context (`@edge-runtime/vm`,
`test/edge-runtime.test.ts`): no `process`, `require` or `Buffer`, requests
through a mocked `fetch`.

`npm run generate` reads, in order: a path or URL argument, `BEAKR_OPENAPI`, or
the committed `docs/api/public-openapi.json` of the engine checkout
(`BEAKR_ENGINE_PATH`, else a sibling `beakr-engine`), else this repository's
snapshot of it.

CI reads no other repository. The files it checks against are committed under
`snapshots/`: `snapshots/beakr-engine` (the documented contract and the API
changelog; never the engine's internal contract) and `snapshots/beakr-python`
(the release scripts every client repository shares, which must match ours).
`snapshots/manifest.json` pins the commit each came from (with
`uncommitted_changes` when taken from a working tree) and each file's SHA-256.
After an engine or beakr-python change, refresh them from checkouts beside this
one (or named with `--engine` / `--python`), then regenerate:

```sh
python3 scripts/refresh_snapshots.py refresh   # rewrite snapshots/ and the manifest
python3 scripts/refresh_snapshots.py diff      # exit 1 when stale against the checkouts
python3 scripts/refresh_snapshots.py verify    # offline: the files are the manifest's (CI)
BEAKR_ENGINE_PATH=snapshots/beakr-engine npm run regen
```

The engine's CI checks this repository and beakr-python out on the branch named
like its own and runs these checks against the real repositories, so drift
shows up there before a refresh here.
Resource methods take their request and response types from that schema, so a
contract change that breaks a method fails `npm run typecheck`.

The documented contract is the only one this package is built from: it carries
no code for routes the API serves without documenting them (the Beakr CLI keeps
its own private client for the few it calls). `test/shipped-surface.test.ts`
packs the package as it would be published and fails on any route in it outside
that contract. `CHANGELOG.md` is not in the package for that reason: it repeats
the API changelog's history, which names routes that are now unlisted.

## Installing before the first release

Until `@beakr/sdk` is on npm, install a packed build of this repository:

```sh
git clone https://github.com/BeakrHub/beakr-typescript && cd beakr-typescript
npm ci && npm run build && npm pack      # beakr-sdk-<version>.tgz
npm install /path/to/beakr-sdk-<version>.tgz   # in your project
```

## Release

Nothing publishes automatically yet. `.github/workflows/publish.yml` is
prepared but runs only when a GitHub release is published and the repository
variable `NPM_PUBLISH_ENABLED` is `true`.

To enable it once:

1. Create the `@beakr` organization (scope) on npm, if it does not exist yet,
   and publish nothing by hand.
2. On npmjs.com, add a Trusted Publisher for `@beakr/sdk` (package settings,
   Trusted publishing; for a package that has never been published, follow
   npm's instructions for a first trusted publish): GitHub Actions, owner
   `BeakrHub`, repository `beakr-typescript`, workflow `publish.yml`,
   environment `npm`.
3. In this repository, create the `npm` environment (Settings, Environments),
   ideally with required reviewers, and set the repository variable
   `NPM_PUBLISH_ENABLED` to `true`.

The workflow authenticates with GitHub's OIDC token (no npm token is stored)
and publishes with provenance.

### Versions and release notes come from the API contract

`scripts/prepare_release.py` (Python 3, standard library only; identical in
every Beakr client repository, and tested in beakr-python) compares the
engine's contract at the last release (`release/released.json`) with the current
one, using the engine's compatibility rules (`scripts/contract_compat.py`). A
breaking change needs a major bump (below 1.0, a minor one), an added or changed
operation a minor bump, a wording change a patch. `package.json`,
`package-lock.json` and `src/version.ts` are kept in step
(`release/config.json`). The API changelog entries added since that release
become the release's section in `CHANGELOG.md`; `### Client changes` is
hand-written and kept across reapplies.

```sh
python3 scripts/prepare_release.py plan     # what changed, which bump it needs
python3 scripts/prepare_release.py apply    # bump versions, write CHANGELOG.md
python3 scripts/prepare_release.py check    # what CI and publishing run
# After publishing: record the engine commit it was built from, then refresh
# the snapshot so it carries that commit's contract and changelog
# (snapshots/beakr-engine/release-base/<sha>), which the offline release check reads.
python3 scripts/prepare_release.py record --engine-commit <engine sha>
python3 scripts/refresh_snapshots.py refresh --engine <engine checkout>
```

## Storing tokens

The SDK keeps tokens in memory and hands every rotated pair to `onTokens`; it
never writes them to disk (it reads the CLI's stored sign-in, above, but never
writes or refreshes it). If your application persists them and runs more than
one process with the same login, coordinate refresh yourself: hold a lock while
refreshing, reload the stored pair under it, and use a pair another process
already rotated instead of presenting the old refresh token. Beakr revokes a
whole sign-in when a used refresh token is presented again. Store each login
with the API origin that issued it and only send it back to that origin.
