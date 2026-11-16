/**
 * The self-hosted line has no hosted default API (BUGS.md, "Self-hosted CLI
 * build defaults to Beakr's hosted cloud": the SDK's DEFAULT_BASE_URL was
 * https://api.thebeakr.com, so a client built with no URL sent its key to
 * Beakr's cloud). With no `baseUrl`, `BEAKR_BASE_URL` or `BEAKR_API_URL` the
 * constructor throws before any request; the Python SDK does the same
 * (beakr-python#114).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AuthenticationError,
  BASE_URL_REQUIRED_MESSAGE,
  Beakr,
  DEFAULT_BASE_URL,
  errorFromResponse,
} from "../src/index.js";
import { json, mockFetch } from "./helpers.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

function noUrlConfigured() {
  vi.stubEnv("BEAKR_BASE_URL", "");
  vi.stubEnv("BEAKR_API_URL", "");
}

describe("no hosted default base URL", () => {
  it("throws base_url_required with no URL configured, before any request", () => {
    noUrlConfigured();
    const { fetch, calls } = mockFetch([]);
    let error: unknown;
    try {
      new Beakr({ apiKey: "bk_live_test", fetch });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AuthenticationError);
    expect((error as AuthenticationError).code).toBe("base_url_required");
    expect((error as AuthenticationError).message).toBe(
      "Set your deployment's URL: pass baseUrl or set BEAKR_BASE_URL (for example https://beakr.example.com).",
    );
    expect(BASE_URL_REQUIRED_MESSAGE).toBe((error as AuthenticationError).message);
    expect(calls).toEqual([]);
  });

  it("treats a blank baseUrl as unset", () => {
    noUrlConfigured();
    const { fetch, calls } = mockFetch([]);
    expect(() => new Beakr({ apiKey: "bk_live_test", baseUrl: "  ", fetch })).toThrow(AuthenticationError);
    expect(calls).toEqual([]);
  });

  it("uses an explicit baseUrl", async () => {
    noUrlConfigured();
    const { fetch, calls } = mockFetch([json({})]);
    const beakr = new Beakr({ apiKey: "bk_live_test", baseUrl: "https://beakr.example.com/", fetch });
    expect(beakr.baseUrl).toBe("https://beakr.example.com");
    await beakr.me.get();
    expect(calls[0]!.url).toBe("https://beakr.example.com/v1/me");
  });

  it("uses BEAKR_BASE_URL, then BEAKR_API_URL", async () => {
    noUrlConfigured();
    vi.stubEnv("BEAKR_API_URL", "https://api-url.example.com");
    expect(new Beakr({ apiKey: "bk_live_test", fetch: mockFetch([]).fetch }).baseUrl).toBe(
      "https://api-url.example.com",
    );
    vi.stubEnv("BEAKR_BASE_URL", "https://env.example.com/");
    const { fetch, calls } = mockFetch([json({})]);
    const beakr = new Beakr({ apiKey: "bk_live_test", fetch });
    expect(beakr.baseUrl).toBe("https://env.example.com");
    await beakr.me.get();
    expect(calls[0]!.url).toBe("https://env.example.com/v1/me");
  });

  it("keeps DEFAULT_BASE_URL exported, empty", () => {
    expect(DEFAULT_BASE_URL).toBe("");
  });

  it("points an HTML-page answer at the deployment's API URL, not Beakr's cloud", () => {
    const error = errorFromResponse(
      404,
      new Headers({ "content-type": "text/html" }),
      "<html><head><title>Not Found</title></head><body></body></html>",
    );
    expect(error.message).toContain("it must be your deployment's API URL.");
    expect(error.message).not.toContain("thebeakr.com");
  });

  it("names no hosted Beakr host anywhere in the runtime source", () => {
    // src/generated is the engine's documented contract; its only mentions are
    // example values inside doc comments, never a runtime default.
    const root = join(__dirname, "..", "src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          if (full !== join(root, "generated")) walk(full);
        } else if (/\.(ts|mts|cts|js|mjs)$/.test(name)) {
          readFileSync(full, "utf8")
            .split("\n")
            .forEach((line, index) => {
              if (/thebeakr\.com/i.test(line)) offenders.push(`${full}:${index + 1}: ${line.trim()}`);
            });
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });

  it("finds src/generated mentions only inside doc comments", () => {
    const generated = join(__dirname, "..", "src", "generated");
    const offenders: string[] = [];
    for (const name of readdirSync(generated)) {
      const full = join(generated, name);
      if (statSync(full).isDirectory()) continue;
      readFileSync(full, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (/thebeakr\.com/i.test(line) && !/^\s*\*/.test(line)) offenders.push(`${name}:${index + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
