/**
 * Runtime smoke of the BUILT package (`dist/`) under `node --test`, for the
 * Node versions the vitest suite cannot run on.
 *
 * `package.json` declares `engines.node >=18`, but vitest 4 (and vite) need
 * Node 20+, so on Node 18 the full suite cannot start (PROSE-449). This file
 * uses only `node:test`, which Node 18 has, and exercises the paths that
 * depend on the Node version: the credentials file read without
 * `process.getBuiltinModule` (Node 18 and 20 before 20.16), the CLI token
 * bridge spawning a real child process, retries with `Retry-After`, and
 * loading both the ESM and CommonJS entry points. CI runs it on every Node in
 * the matrix after `npm run build`; it never touches the real Beakr home, the
 * OS keychain or the network.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { AuthenticationError, Beakr, RateLimitError, VERSION } from "../dist/index.js";

const BASE = "https://api.test";
const NOW_SECONDS = Date.now() / 1000;
const SAVED_ENV = { ...process.env };

function storedLogin(accessToken) {
  return {
    access_token: accessToken,
    refresh_token: `refresh-${accessToken}`,
    expires_at: NOW_SECONDS + 3600,
    refresh_expires_at: NOW_SECONDS + 86400,
    base_url: BASE,
    org_id: "org-1",
    client_name: "beakr-cli",
    user: {},
    issuer: "beakr",
    token_endpoint: null,
    oauth_client_id: null,
    refresh_state: null,
  };
}

/** A fetch that answers from a queue and records every request's headers. */
function mockFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const fetch = async (url, init = {}) => {
    calls.push({ url, headers: Object.fromEntries(new Headers(init.headers).entries()) });
    const next = queue.shift();
    if (next === undefined) throw new Error(`unexpected request: ${url}`);
    return next();
  };
  return { fetch, calls };
}

const json = (body, status = 200, headers = {}) => () =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

function emptyHome() {
  const home = mkdtempSync(join(tmpdir(), "beakr-node-smoke-"));
  process.env.BEAKR_HOME = home;
  return home;
}

beforeEach(() => {
  for (const name of ["BEAKR_API_KEY", "BEAKR_BASE_URL", "BEAKR_SERVICE_ACCOUNT_FILE", "BEAKR_CLI_PATH"]) {
    delete process.env[name];
  }
  // A home with nothing in it: no stored login, no service account file.
  emptyHome();
  // Never fall back to a real `beakr` on the PATH.
  process.env.BEAKR_CLI_PATH = join(tmpdir(), "beakr-node-smoke-no-cli");
});

afterEach(() => {
  process.env = { ...SAVED_ENV };
});

test(`runs on Node ${process.versions.node} against dist/ (SDK ${VERSION})`, () => {
  assert.equal(typeof Beakr, "function");
});

test("the CommonJS entry point loads and exports the client", () => {
  const require = createRequire(import.meta.url);
  const cjs = require("../dist/index.cjs");
  assert.equal(typeof cjs.Beakr, "function");
  assert.equal(cjs.VERSION, VERSION);
});

test("an API key from BEAKR_API_KEY is sent as a bearer token", async () => {
  process.env.BEAKR_API_KEY = "bk_live_env";
  const { fetch, calls } = mockFetch([json({ user: {} })]);
  await new Beakr({ baseUrl: BASE, fetch }).me.get();
  assert.equal(calls[0].headers.authorization, "Bearer bk_live_env");
});

test("the CLI's credentials file is read on this Node (getBuiltinModule or not)", async () => {
  writeFileSync(
    join(process.env.BEAKR_HOME, "credentials"),
    JSON.stringify({ version: 2, generation: 1, logins: { [BASE]: storedLogin("at-file") } }),
  );
  const { fetch, calls } = mockFetch([json({ user: {} })]);
  await new Beakr({ baseUrl: BASE, fetch }).me.get();
  assert.equal(calls[0].headers.authorization, "Bearer at-file");
});

test("the CLI token bridge spawns the installed CLI and uses its token", async () => {
  const cli = join(process.env.BEAKR_HOME, "fake-beakr");
  const answer = JSON.stringify({
    access_token: "at-cli",
    token_type: "Bearer",
    expires_at: NOW_SECONDS + 3600,
    origin: BASE,
    source: "cli_tokens",
    kind: "access_token",
  });
  writeFileSync(
    cli,
    `#!/bin/sh\n[ "$1 $2 $3" = "auth token --json" ] || exit 64\nprintf '%s\\n' '${answer}'\n`,
  );
  chmodSync(cli, 0o755);
  process.env.BEAKR_CLI_PATH = cli;
  const { fetch, calls } = mockFetch([json({ user: {} })]);
  await new Beakr({ baseUrl: BASE, fetch }).me.get();
  assert.equal(calls[0].headers.authorization, "Bearer at-cli");
});

test("with no credential anywhere the request fails as unauthenticated", async () => {
  const { fetch, calls } = mockFetch([]);
  await assert.rejects(new Beakr({ baseUrl: BASE, fetch }).me.get(), AuthenticationError);
  assert.equal(calls.length, 0);
});

test("a 429 is retried after Retry-After, then gives up after maxRetries", async () => {
  const sleeps = [];
  const sleep = async (ms) => {
    sleeps.push(ms);
  };
  const ok = mockFetch([json({}, 429, { "retry-after": "2" }), json({ user: {} })]);
  await new Beakr({ apiKey: "bk_live_x", baseUrl: BASE, fetch: ok.fetch, sleep }).me.get();
  assert.equal(ok.calls.length, 2);
  assert.deepEqual(sleeps, [2000]);

  const limited = mockFetch([json({}, 429, { "retry-after": "1" }), json({}, 429, { "retry-after": "1" })]);
  const client = new Beakr({ apiKey: "bk_live_x", baseUrl: BASE, fetch: limited.fetch, sleep, maxRetries: 1 });
  await assert.rejects(client.me.get(), RateLimitError);
  assert.equal(limited.calls.length, 2);
});
