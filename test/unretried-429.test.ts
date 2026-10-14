/**
 * A 429 that no quick retry can fix is returned at once.
 *
 * Root cause: every 429 was retried (twice, with backoff), on the reading that
 * the server refused before doing work. An organization out of credits
 * (`credits_exhausted`) or over a usage quota (`quota_exceeded`) gets the same
 * refusal on every resend, so the caller waited for nothing and the engine saw
 * three requests. Other 429s (`rate_limited`) are still retried.
 */
import { describe, expect, it } from "vitest";
import { client, json, mockFetch } from "./helpers.js";

const refusal = (code: string) => ({ error: { code, message: `refused: ${code}`, fix: "Add credits." } });

describe("429 retries", () => {
  for (const code of ["credits_exhausted", "quota_exceeded"]) {
    it(`does not retry ${code}`, async () => {
      const { fetch, calls } = mockFetch([json(refusal(code), 429), json(refusal(code), 429), json(refusal(code), 429)]);
      const { beakr } = client(fetch);
      await expect(beakr.knowledge.research("What changed?")).rejects.toMatchObject({ code });
      expect(calls).toHaveLength(1);
    });
  }

  it("still retries a rate limit", async () => {
    const { fetch, calls } = mockFetch([json(refusal("rate_limited"), 429, { "retry-after": "0" }), json({ text: "ok" })]);
    const { beakr } = client(fetch);
    await expect(beakr.knowledge.research("What changed?")).resolves.toEqual({ text: "ok" });
    expect(calls).toHaveLength(2);
  });
});
