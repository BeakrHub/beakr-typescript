/**
 * Retry-After as an HTTP-date (RFC 9110 section 10.2.3), on a pinned clock.
 *
 * Root cause these guard: `parseRetryAfter` accepted only `Number(value)`, so a
 * date-form Retry-After was treated as absent and the SDK retried after normal
 * jitter -- early for a near deadline, and immediately for one past the
 * 60-second cap that should surface the error instead.
 */
import { describe, expect, it } from "vitest";
import { RateLimitError, parseRetryAfter } from "../src/index.js";
import { client, json, mockFetch } from "./helpers.js";

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const now = () => NOW;

// 30 seconds after NOW in each of the three forms recipients must accept.
const IMF_FIXDATE = "Sun, 11 Oct 2026 12:00:30 GMT";
const RFC850 = "Sunday, 11-Oct-26 12:00:30 GMT";
const ASCTIME = "Sun Oct 11 12:00:30 2026";

describe("parseRetryAfter", () => {
  it.each([IMF_FIXDATE, RFC850, ASCTIME])("turns %s into seconds from now", (value) => {
    expect(parseRetryAfter(value, NOW)).toBe(30);
  });

  it("reads a space-padded single-digit asctime day", () => {
    expect(parseRetryAfter("Sat Oct  3 12:00:00 2026", Date.UTC(2026, 9, 3))).toBe(12 * 3600);
  });

  it("matches month and day names case-insensitively", () => {
    expect(parseRetryAfter("sun, 11 OCT 2026 12:00:30 gmt", NOW)).toBe(30);
  });

  it.each([
    ["26", 2026],
    ["76", 2076],
    ["77", 1977],
    ["94", 1994],
  ])("reads RFC 850 year %s as %i (more than 50 years ahead is the past century)", (digits, year) => {
    const expected = Math.max(0, (Date.UTC(year, 0, 1) - NOW) / 1000);
    expect(parseRetryAfter(`Monday, 01-Jan-${digits} 00:00:00 GMT`, NOW)).toBe(expected);
  });

  it("treats a past date as zero, never negative", () => {
    expect(parseRetryAfter("Sun, 06 Nov 1994 08:49:37 GMT", NOW)).toBe(0);
    expect(parseRetryAfter("Sun, 11 Oct 2026 11:59:59 GMT", NOW)).toBe(0);
  });

  it.each([
    "soon",
    "Sun, 31 Feb 2026 12:00:00 GMT", // no such day
    "Sun, 11 Oct 2026 25:00:00 GMT", // no such hour
    "Sun, 11 Oct 2026 12:00:61 GMT", // no such second
    "Sun, 11 Oct 2026 12:00:30 PST", // HTTP-dates are always GMT
    "Sun, 11 Foo 2026 12:00:30 GMT",
    "2026-10-11T12:00:30Z", // ISO 8601 is not an HTTP-date
    "Sun, 11 Oct 2026",
  ])("treats malformed %s as absent", (value) => {
    expect(parseRetryAfter(value, NOW)).toBeUndefined();
  });

  it.each([
    ["30", 30],
    ["1.5", 1.5],
    ["0", 0],
    ["-5", 0],
    ["3600", 3600],
  ])("keeps numeric %s as %d seconds", (value, seconds) => {
    expect(parseRetryAfter(value, NOW)).toBe(seconds);
  });

  it.each([null, undefined, ""])("treats a missing header (%s) as absent", (value) => {
    expect(parseRetryAfter(value, NOW)).toBeUndefined();
  });

  it("defaults to the current time", () => {
    expect(parseRetryAfter("Sun, 06 Nov 1994 08:49:37 GMT")).toBe(0);
  });
});

describe("client retries", () => {
  it.each([
    [429, IMF_FIXDATE, 30_000],
    [503, RFC850, 30_000],
    [429, ASCTIME, 30_000],
    [429, "Sun, 06 Nov 1994 08:49:37 GMT", 0], // past: retry now
    [429, "Sun, 11 Oct 2026 12:01:00 GMT", 60_000], // exactly the cap: waited out
    [503, "12", 12_000], // numeric unchanged
    [429, "60", 60_000],
  ])("on %i with Retry-After %s waits %i ms", async (status, header, ms) => {
    const { fetch, calls } = mockFetch([json({}, status, { "retry-after": header }), json({ id: "me" })]);
    const { beakr, sleeps } = client(fetch, { now });
    await expect(beakr.me.get()).resolves.toEqual({ id: "me" });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([ms]);
  });

  it.each(["Sun, 11 Oct 2026 12:01:01 GMT", "61"])(
    "surfaces a deadline past the cap (%s) without retrying",
    async (header) => {
      const { fetch, calls } = mockFetch([json({}, 429, { "retry-after": header }), json({ id: "me" })]);
      const { beakr, sleeps } = client(fetch, { now });
      const error = await beakr.me.get().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RateLimitError);
      expect((error as RateLimitError).retryAfter).toBe(61);
      expect(calls).toHaveLength(1);
      expect(sleeps).toEqual([]);
    },
  );

  it.each(["Sun, 31 Feb 2026 12:00:00 GMT", "not a date"])(
    "falls back to default backoff for malformed %s",
    async (header) => {
      const { fetch } = mockFetch([json({}, 429, { "retry-after": header }), json({ id: "me" })]);
      const { beakr, sleeps } = client(fetch, { now });
      await expect(beakr.me.get()).resolves.toEqual({ id: "me" });
      // First retry: half-second base with full jitter.
      expect(sleeps).toHaveLength(1);
      expect(sleeps[0]).toBeGreaterThanOrEqual(250);
      expect(sleeps[0]).toBeLessThanOrEqual(500);
    },
  );

  it("reports a date deadline on RateLimitError in seconds", async () => {
    const { fetch } = mockFetch([json({}, 429, { "retry-after": IMF_FIXDATE })]);
    const { beakr, sleeps } = client(fetch, { now, maxRetries: 0 });
    const error = await beakr.me.get().catch((caught: unknown) => caught);
    expect((error as RateLimitError).retryAfter).toBe(30);
    expect(sleeps).toEqual([]);
  });
});
