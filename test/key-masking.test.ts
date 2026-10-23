import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { Beakr } from "../src/index.js";
import { Transport } from "../src/core.js";
import { maskSecret } from "../src/redact.js";
import { json, mockFetch } from "./helpers.js";

// A fake key shaped like a real one; never a real credential.
const KEY = "bk_live_FAKEfakeFAKEfake0123456789abcd";
const MASKED = "bk_live_...abcd";
const ACCESS = "bk_at_FAKEaccessTOKENfake0123456789wxyz";
const REFRESH = "bk_rt_FAKErefreshTOKENfake0123456789qrst";

function fetchOnly() {
  return mockFetch([json({ id: "u1" })]).fetch;
}

/** Every way a caller can print or serialize an object. */
function renderings(value: unknown): string[] {
  return [
    inspect(value),
    inspect(value, { depth: Infinity, showHidden: true }),
    JSON.stringify(value) ?? "",
    String(value),
    `${value as string}`,
  ];
}

describe("the API key never prints", () => {
  it("masks like the Python SDK", () => {
    expect(maskSecret(KEY)).toBe(MASKED);
    expect(maskSecret("bk_live_short")).toBe("bk_live_***");
    expect(maskSecret(undefined)).toBeUndefined();
  });

  it("is absent from inspect, JSON and String of the client", () => {
    const beakr = new Beakr({ apiKey: KEY, baseUrl: "https://api.example.test", fetch: fetchOnly() });
    for (const text of renderings(beakr)) {
      expect(text).not.toContain(KEY);
    }
    expect(inspect(beakr)).toContain(MASKED);
    expect(JSON.parse(JSON.stringify(beakr))).toEqual({
      baseUrl: "https://api.example.test",
      credential: MASKED,
    });
    expect(String(beakr)).toContain(MASKED);
  });

  it("is absent from every resource and its transport", () => {
    const beakr = new Beakr({ apiKey: KEY, baseUrl: "https://api.example.test", fetch: fetchOnly() });
    const resources = Object.entries(beakr).filter(
      ([, value]) => value !== null && typeof value === "object",
    );
    expect(resources.length).toBeGreaterThan(15);
    for (const [name, resource] of resources) {
      const transport = (resource as { transport?: unknown }).transport ?? resource;
      for (const text of [...renderings(resource), ...renderings(transport)]) {
        expect(text, name).not.toContain(KEY);
      }
      expect(Object.values(transport as object)).not.toContain(KEY);
    }
  });

  it("keeps a token pair and a default Authorization header off the object too", () => {
    const transport = new Transport({
      tokens: { accessToken: ACCESS, refreshToken: REFRESH },
      defaultHeaders: { Authorization: `Bearer ${KEY}` },
      baseUrl: "https://api.example.test",
      fetch: fetchOnly(),
    });
    for (const text of renderings(transport)) {
      expect(text).not.toContain(ACCESS);
      expect(text).not.toContain(REFRESH);
      expect(text).not.toContain(KEY);
    }
    expect(JSON.stringify(Object.entries(transport))).not.toContain(ACCESS);
    expect(JSON.stringify(Object.entries(transport))).not.toContain(KEY);
    expect(transport.describe().credential).toBe("bk_at_...wxyz");
  });

  it("still sends the key", async () => {
    const { fetch, calls } = mockFetch([json({ id: "u1" })]);
    const beakr = new Beakr({ apiKey: KEY, baseUrl: "https://api.example.test", fetch });
    await beakr.me.get();
    expect(calls[0]!.headers["authorization"]).toBe(`Bearer ${KEY}`);
  });
});
