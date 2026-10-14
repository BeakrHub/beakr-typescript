/**
 * Service-account credentials files close the TypeScript SDK's credential chain
 * (developer platform W6.1): explicit key, BEAKR_API_KEY, then the file.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AuthenticationError,
  Beakr,
  parseServiceAccountCredentials,
  readServiceAccountFile,
} from "../src/index.js";
import { json, mockFetch } from "./helpers.js";

const BASE = "https://api.test";

function file(content: Record<string, unknown>): string {
  const path = join(mkdtempSync(join(tmpdir(), "beakr-sa-")), "sa.json");
  writeFileSync(path, JSON.stringify(content));
  return path;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("service account credentials", () => {
  it("authenticates with the file named by BEAKR_SERVICE_ACCOUNT_FILE", async () => {
    vi.stubEnv("BEAKR_API_KEY", "");
    vi.stubEnv(
      "BEAKR_SERVICE_ACCOUNT_FILE",
      file({ type: "beakr_service_account", api_key: "bk_live_sa", base_url: BASE }),
    );
    const { fetch, calls } = mockFetch([json({ user: {} })]);
    const beakr = new Beakr({ baseUrl: BASE, fetch });
    await beakr.me.get();
    expect(calls[0]?.headers.authorization).toBe("Bearer bk_live_sa");
  });

  it("comes after an explicit key and BEAKR_API_KEY", async () => {
    vi.stubEnv(
      "BEAKR_SERVICE_ACCOUNT_FILE",
      file({ type: "beakr_service_account", api_key: "bk_live_sa" }),
    );
    vi.stubEnv("BEAKR_API_KEY", "bk_live_env");
    const { fetch, calls } = mockFetch([json({}), json({})]);
    await new Beakr({ baseUrl: BASE, fetch }).me.get();
    await new Beakr({ baseUrl: BASE, fetch, apiKey: "bk_live_mine" }).me.get();
    expect(calls.map((c) => c.headers.authorization)).toEqual([
      "Bearer bk_live_env",
      "Bearer bk_live_mine",
    ]);
  });

  it("refuses a key bound to another API", () => {
    vi.stubEnv("BEAKR_API_KEY", "");
    const account = parseServiceAccountCredentials({
      type: "beakr_service_account",
      api_key: "bk_live_sa",
      base_url: "https://api.thebeakr.com",
    });
    expect(() => new Beakr({ baseUrl: BASE, serviceAccount: account })).toThrow(
      /only sent to the API that issued it/,
    );
  });

  it("fails loudly on an unusable file", () => {
    expect(() => parseServiceAccountCredentials("{nope")).toThrow(AuthenticationError);
    expect(() => parseServiceAccountCredentials({ api_key: "bk_live_x" })).toThrow(
      /not a Beakr service account file/,
    );
    expect(() =>
      parseServiceAccountCredentials({ type: "beakr_service_account", api_key: "sk-1" }),
    ).toThrow(/no api_key/);
    expect(() => readServiceAccountFile(join(tmpdir(), "missing-beakr-sa.json"))).toThrow(
      /Cannot read the service account file/,
    );
  });

  it("reads every field the Python SDK writes", () => {
    const account = readServiceAccountFile(
      file({
        type: "beakr_service_account",
        api_key: "bk_test_x",
        base_url: BASE,
        org_id: "org-1",
        service_account_id: "sa-1",
        key_id: "k-1",
        name: "deploy",
      }),
    );
    expect(account).toEqual({
      apiKey: "bk_test_x",
      baseUrl: BASE,
      orgId: "org-1",
      serviceAccountId: "sa-1",
      keyId: "k-1",
      name: "deploy",
    });
  });
});
