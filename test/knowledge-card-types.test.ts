/**
 * A project's card types (Python's `tests/test_knowledge_card_types.py`):
 * `knowledge.listCardTypes`, `updateCardType`, `removeCardTypeCopy`,
 * `copyCardTypes`, `promoteCardTypes`, `renameCardTypeFields`, `retypeCards`.
 */
import { describe, expect, it } from "vitest";
import { ConflictError } from "../src/index.js";
import { client, json, mockFetch } from "./helpers.js";

const path = (url: string) => new URL(url).pathname;
const query = (url: string) => Object.fromEntries(new URL(url).searchParams);
const pageType = {
  key: "deviation",
  label: "Deviation",
  scope: "project",
  status: "active",
  overrides: "global",
  metadata_schema: {
    key_attributes: ["Root cause", "CAPA"],
    required_attributes: ["Root cause"],
    grain: "card",
  },
};

describe("knowledge card types", () => {
  it("lists a project's card types with only the filters given", async () => {
    const { fetch, calls } = mockFetch([json({ page_types: [pageType], map_mode: true })]);
    const { beakr } = client(fetch);
    const listed = await beakr.knowledge.listCardTypes({ projectId: "p1", includeDeprecated: true });
    expect(listed.page_types[0]!.key).toBe("deviation");
    expect(calls[0]!.method).toBe("GET");
    expect(path(calls[0]!.url)).toBe("/v1/knowledge/wiki/page-types");
    expect(query(calls[0]!.url)).toEqual({ project_id: "p1", include_deprecated: "true" });
  });

  it("patches the scope and only the fields given", async () => {
    const { fetch, calls } = mockFetch([json({ page_type: pageType })]);
    const { beakr } = client(fetch);
    const saved = await beakr.knowledge.updateCardType(
      "deviation",
      {
        description: "One departure from a batch record",
        fields: [{ name: "Root cause", required: true }, { name: "CAPA" }],
      },
      { projectId: "p1" },
    );
    expect(saved.page_type.key).toBe("deviation");
    expect(calls[0]!.method).toBe("PATCH");
    expect(path(calls[0]!.url)).toBe("/v1/knowledge/wiki/page-types/deviation");
    expect(calls[0]!.body).toEqual({
      scope: "project",
      project_id: "p1",
      description: "One departure from a batch record",
      fields: [{ name: "Root cause", required: true }, { name: "CAPA" }],
    });
  });

  it("sends an organization-wide change without a project", async () => {
    const { fetch, calls } = mockFetch([json({ page_type: { ...pageType, scope: "org" } })]);
    const { beakr } = client(fetch);
    await beakr.knowledge.updateCardType("deviation", { status: "deprecated", aliases: [] }, { scope: "org" });
    expect(calls[0]!.body).toEqual({ scope: "org", status: "deprecated", aliases: [] });
  });

  it("encodes the key as one path segment", async () => {
    const { fetch, calls } = mockFetch([json({ page_type: pageType })]);
    const { beakr } = client(fetch);
    await beakr.knowledge.updateCardType("lab note/x", { label: "Lab note" }, { projectId: "p1" });
    expect(path(calls[0]!.url)).toBe("/v1/knowledge/wiki/page-types/lab%20note%2Fx");
  });

  it("removes the scope's own copy", async () => {
    const { fetch, calls } = mockFetch([json({ removed: true, key: "deviation", scope: "project" })]);
    const { beakr } = client(fetch);
    const removed = await beakr.knowledge.removeCardTypeCopy("deviation", { projectId: "p1" });
    expect(removed).toEqual({ removed: true, key: "deviation", scope: "project" });
    expect(calls[0]!.method).toBe("DELETE");
    expect(path(calls[0]!.url)).toBe("/v1/knowledge/wiki/page-types/deviation");
    expect(query(calls[0]!.url)).toEqual({ scope: "project", project_id: "p1" });
  });

  it("throws ConflictError for a type defined only in the scope", async () => {
    const { fetch } = mockFetch([
      json({ error: { code: "conflict", message: "This type is defined only here." } }, 409),
    ]);
    const { beakr } = client(fetch);
    const error = await beakr.knowledge.removeCardTypeCopy("deviation", { scope: "org" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
  });

  it("copies types between two projects", async () => {
    const answer = { copied: [pageType], replaced: [], skipped: [] };
    const { fetch, calls } = mockFetch([json(answer)]);
    const { beakr } = client(fetch);
    const copied = await beakr.knowledge.copyCardTypes("p1", "p2", ["deviation"]);
    expect(copied).toEqual(answer);
    expect(calls[0]!.method).toBe("POST");
    expect(path(calls[0]!.url)).toBe("/v1/knowledge/wiki/page-types/copy");
    expect(calls[0]!.body).toEqual({ from_project_id: "p1", to_project_id: "p2", keys: ["deviation"], replace: false });
  });

  it("promotes a project's types, sending the project as source", async () => {
    const answer = { copied: [], replaced: [], skipped: [{ key: "capa", reason: "not_found" }] };
    const { fetch, calls } = mockFetch([json(answer)]);
    const { beakr } = client(fetch);
    const promoted = await beakr.knowledge.promoteCardTypes("p1", ["deviation", "capa"], { replace: true });
    expect(promoted.skipped).toEqual([{ key: "capa", reason: "not_found" }]);
    expect(path(calls[0]!.url)).toBe("/v1/knowledge/wiki/page-types/promote");
    expect(calls[0]!.body).toEqual({ source: "p1", keys: ["deviation", "capa"], replace: true });
  });

  it("renames fields as a dry run unless asked to write", async () => {
    // The write changes up to 500 cards a call: dry_run false is sent only on request.
    const renamed = { page_type: "deviation", dry_run: true, cards: 12, cards_changed: 9, applied: { Cause: "Root cause" } };
    const { fetch, calls } = mockFetch([json(renamed), json(renamed)]);
    const { beakr } = client(fetch);
    const preview = await beakr.knowledge.renameCardTypeFields("deviation", "p1", { Cause: "Root cause" });
    expect(preview.cards_changed).toBe(9);
    expect(calls[0]!.method).toBe("POST");
    expect(path(calls[0]!.url)).toBe("/v1/knowledge/wiki/page-types/deviation/rename-fields");
    expect(calls[0]!.body).toEqual({
      project_id: "p1",
      renames: [{ old: "Cause", new: "Root cause" }],
      dry_run: true,
    });
    await beakr.knowledge.renameCardTypeFields("deviation", "p1", [{ old: "Cause", new: "Root cause" }], {
      dryRun: false,
    });
    expect(calls[1]!.body).toEqual({
      project_id: "p1",
      renames: [{ old: "Cause", new: "Root cause" }],
      dry_run: false,
    });
  });

  it("retypes cards as a dry run unless asked to write", async () => {
    const answer = { from_type: "deviation", to_type: "incident", dry_run: true, cards: 12 };
    const { fetch, calls } = mockFetch([json(answer), json(answer)]);
    const { beakr } = client(fetch);
    const preview = await beakr.knowledge.retypeCards("deviation", "p1", "incident");
    expect(preview.cards).toBe(12);
    expect(path(calls[0]!.url)).toBe("/v1/knowledge/wiki/page-types/deviation/retype-cards");
    expect(calls[0]!.body).toEqual({ project_id: "p1", to_type: "incident", dry_run: true });
    await beakr.knowledge.retypeCards("deviation", "p1", "incident", { dryRun: false });
    expect(calls[1]!.body).toEqual({ project_id: "p1", to_type: "incident", dry_run: false });
  });
});
