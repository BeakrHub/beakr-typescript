import { expect, it } from "vitest";
import { RateLimitError } from "../src/index.js";
import { client, json, mockFetch } from "./helpers.js";

it.each([429, 503])("honors an HTTP-date Retry-After on %i", async (status) => {
  const until = new Date(Date.now() + 30_000).toUTCString();
  const { fetch } = mockFetch([json({}, status, { "retry-after": until }), json({ id: "me" })]);
  const { beakr, sleeps } = client(fetch);
  await expect(beakr.me.get()).resolves.toEqual({ id: "me" });
  expect(sleeps).toHaveLength(1);
  expect(sleeps[0]).toBeGreaterThanOrEqual(25_000);
  expect(sleeps[0]).toBeLessThanOrEqual(30_000);
});

it("surfaces a long HTTP-date delay without retrying early", async () => {
  const until = new Date(Date.now() + 3_600_000).toUTCString();
  const { fetch, calls } = mockFetch([json({}, 429, { "retry-after": until }), json({ id: "me" })]);
  const { beakr, sleeps } = client(fetch);
  await expect(beakr.me.get()).rejects.toBeInstanceOf(RateLimitError);
  expect(calls).toHaveLength(1);
  expect(sleeps).toEqual([]);
});
