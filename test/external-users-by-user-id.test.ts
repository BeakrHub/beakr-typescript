/**
 * External users are addressed by user_id, never by external_id alone.
 *
 * Root cause: an external_id is unique only within the service account that
 * created the user, so two backends in one organization may each have a
 * "customer-42". get, update, delete and token minting take the user_id and
 * refuse an external_id before any request; `list({ externalId })` stays the
 * caller-scoped way to find it.
 */
import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/index.js";
import { client, json, mockFetch } from "./helpers.js";

const USER_ID = "5b1f6c2e-8d3a-4e7b-9c1d-2a3b4c5d6e7f";

describe("external users by user_id", () => {
  const calls = [
    (b: any) => b.externalUsers.get("customer-42", "org-1"),
    (b: any) => b.externalUsers.update("customer-42", { name: "Ada" }, "org-1"),
    (b: any) => b.externalUsers.delete("customer-42", "org-1"),
    (b: any) => b.endUserTokens.mint({ scopes: ["kb:read"], externalUserId: "customer-42" }),
  ];
  for (const [i, call] of calls.entries()) {
    it(`refuses an external_id before any request (${i})`, async () => {
      const { fetch, calls: sent } = mockFetch([]);
      const { beakr } = client(fetch);
      await expect(Promise.resolve().then(() => call(beakr))).rejects.toBeInstanceOf(ValidationError);
      expect(sent).toHaveLength(0);
    });
  }

  it("reaches the user by its user_id", async () => {
    const { fetch, calls: sent } = mockFetch([json({ user_id: USER_ID })]);
    const { beakr } = client(fetch);
    await expect(beakr.externalUsers.get(USER_ID, "org-1")).resolves.toEqual({ user_id: USER_ID });
    expect(sent[0]!.url).toBe(`https://api.example.test/v1/organizations/org-1/external-users/${USER_ID}`);
  });
});
