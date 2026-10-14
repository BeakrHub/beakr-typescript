/**
 * Service-account credentials files (developer platform W6.1).
 *
 * A CI job or server authenticates as an organization's service account with a
 * JSON file written by `beakr org service-accounts key --credentials-file`:
 *
 *     {"type": "beakr_service_account", "api_key": "bk_live_...",
 *      "base_url": "https://api.thebeakr.com", "org_id": "...",
 *      "service_account_id": "...", "key_id": "...", "name": "deploy"}
 *
 * Only `type` and `api_key` are required. `base_url`, when present, binds the
 * key to that API: a client pointed at another one refuses it rather than
 * sending the key elsewhere. The same format is read by the Python SDK.
 */
import { AuthenticationError } from "./errors.js";
import { nodeBuiltinSync } from "./node-builtins.js";

export const SERVICE_ACCOUNT_FILE_TYPE = "beakr_service_account";
export const SERVICE_ACCOUNT_FILE_ENV = "BEAKR_SERVICE_ACCOUNT_FILE";

export interface ServiceAccountCredentials {
  apiKey: string;
  baseUrl?: string;
  orgId?: string;
  serviceAccountId?: string;
  keyId?: string;
  name?: string;
}

function invalid(message: string): AuthenticationError {
  return new AuthenticationError(message, { code: "unauthorized" });
}

/** Parse the file's text (or its already-parsed JSON). Throws `AuthenticationError` when unusable. */
export function parseServiceAccountCredentials(
  content: string | Record<string, unknown>,
  source = "the service account file",
): ServiceAccountCredentials {
  let data: unknown = content;
  if (typeof content === "string") {
    try {
      data = JSON.parse(content);
    } catch {
      throw invalid(`${source} is not valid JSON.`);
    }
  }
  if (!data || typeof data !== "object" || (data as { type?: unknown }).type !== SERVICE_ACCOUNT_FILE_TYPE) {
    throw invalid(
      `${source} is not a Beakr service account file (expected "type": "${SERVICE_ACCOUNT_FILE_TYPE}").`,
    );
  }
  const record = data as Record<string, unknown>;
  const apiKey = record.api_key;
  if (typeof apiKey !== "string" || !/^bk_(live|test)_/.test(apiKey)) {
    throw invalid(`${source} has no api_key (bk_live_... or bk_test_...).`);
  }
  const text = (name: string) => {
    const value = record[name];
    return typeof value === "string" && value ? value : undefined;
  };
  return {
    apiKey,
    baseUrl: text("base_url"),
    orgId: text("org_id"),
    serviceAccountId: text("service_account_id"),
    keyId: text("key_id"),
    name: text("name"),
  };
}

type ReadFileSync = (path: string, encoding: "utf8") => string;

function nodeReadFileSync(): ReadFileSync | undefined {
  return nodeBuiltinSync<{ readFileSync?: ReadFileSync }>("node:fs")?.readFileSync;
}

/**
 * Read a credentials file from disk (Node.js; on Node without
 * `process.getBuiltinModule`, after the client has preloaded `node:fs`). In a runtime
 * without file access, read the file yourself and pass its text to
 * `parseServiceAccountCredentials`, then the result as `serviceAccount`.
 */
export function readServiceAccountFile(path: string, readFile?: ReadFileSync): ServiceAccountCredentials {
  const read = readFile ?? nodeReadFileSync();
  if (!read) {
    throw invalid(
      "Reading a service account file needs Node.js file access; pass `serviceAccount` " +
        "with the parsed file instead.",
    );
  }
  let content: string;
  try {
    content = read(path, "utf8");
  } catch (error) {
    throw invalid(`Cannot read the service account file ${path}: ${(error as Error).message}.`);
  }
  return parseServiceAccountCredentials(content, `The service account file ${path}`);
}

/** `scheme://host[:port]`, lower case, default port dropped: what a key is bound to. */
export function normalizeOrigin(url: string): string {
  const parsed = new URL(url.includes("://") ? url : `https://${url}`);
  const defaultPort = parsed.protocol === "http:" ? "80" : parsed.protocol === "https:" ? "443" : "";
  const port = parsed.port && parsed.port !== defaultPort ? `:${parsed.port}` : "";
  return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${port}`;
}
