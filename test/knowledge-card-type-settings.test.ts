/**
 * Card type settings, history and suggestions (Python's
 * `tests/test_knowledge_card_type_settings.py`): `knowledge.cardTypeSettings`,
 * `setCardTypeSettings` (a dry run unless asked to write), `cardTypeHistory`,
 * `iterCardTypeHistory`, `cardTypeSuggestions`, `dismissCardTypeSuggestion`,
 * `card_types` on `projects.create` and `suggestionId` on `retypeCards`.
 */
import { describe, expect, it } from "vitest";
import { ConflictError } from "../src/index.js";
import { client, json, mockFetch } from "./helpers.js";

const path = (url: string) => new URL(url).pathname;
const query = (url: string) => Object.fromEntries(new URL(url).searchParams);
const settings = { inherit: "organization", agent_may_change: true };
const change = {
  project_id: "p1",
  dry_run: true,
  current: settings,
  requested: { inherit: "own", agent_may_change: true },
  kept_types: ["index", "organization", "overview", "person", "topic"],
  types_dropped: [{ key: "matter", label: "Matter", scope: "global", live_cards: 4 }],
  types_kept: [],
  usable_own_types: ["deviation"],
  suggestions: 0,
  history_id: null,
  undo_event_id: null,
};
const entry = {
  id: "h1",
  actor_type: "user",
  scope: "project",
  key: "deviation",
  label: "Deviation",
  kind: "edited",
  title: "Changed Deviation",
  changed: ["description"],
  undoable: true,
  details: {},
};

describe("knowledge card type settings, history and suggestions", () => {
  it("reads a project's settings from the type list, with counts on request", async () => {
    const listing = { page_types: [], map_mode: true, settings, kept_types: [] };
    const { fetch, calls } = mockFetch([json(listing), json(listing)]);
    const { beakr } = client(fetch);
    expect(await beakr.knowledge.cardTypeSettings("p1")).toEqual(settings);
    expect(query(calls[0]!.url)).toEqual({ project_id: "p1" });
    await beakr.knowledge.listCardTypes({ projectId: "p1", includeCounts: true });
    expect(query(calls[1]!.url)).toEqual({ project_id: "p1", include_counts: "true" });
  });

  it("changes settings as a dry run unless asked to write", async () => {
    // Applying changes which types a whole project is offered: dry_run false only on request.
    const { fetch, calls } = mockFetch([json(change), json(change)]);
    const { beakr } = client(fetch);
    const preview = await beakr.knowledge.setCardTypeSettings("p1", { inherit: "own" });
    expect(preview.types_dropped[0]!.live_cards).toBe(4);
    expect(calls[0]!.method).toBe("PUT");
    expect(path(calls[0]!.url)).toBe("/v1/knowledge/wiki/page-types/settings");
    expect(calls[0]!.body).toEqual({ project_id: "p1", inherit: "own", keep_types_in_use: false, dry_run: true });
    await beakr.knowledge.setCardTypeSettings("p1", { agentMayChange: false, keepTypesInUse: true, dryRun: false });
    expect(calls[1]!.body).toEqual({
      project_id: "p1",
      agent_may_change: false,
      keep_types_in_use: true,
      dry_run: false,
    });
  });

  it("reads one page of history and follows the cursor when iterating", async () => {
    const { fetch, calls } = mockFetch([
      json({ data: [entry], has_more: true, next_cursor: "c2" }),
      json({ data: [entry], has_more: true, next_cursor: "c2" }),
      json({ data: [{ ...entry, id: "h2" }], has_more: false, next_cursor: null }),
    ]);
    const { beakr } = client(fetch);
    const page = await beakr.knowledge.cardTypeHistory({ scope: "org", key: "deviation", limit: 1 });
    expect(page.next_cursor).toBe("c2");
    expect(path(calls[0]!.url)).toBe("/v1/knowledge/wiki/page-types/history");
    expect(query(calls[0]!.url)).toEqual({ scope: "org", key: "deviation", limit: "1" });
    const ids: string[] = [];
    for await (const item of beakr.knowledge.iterCardTypeHistory({ projectId: "p1", includeSuggestions: true })) {
      ids.push(item.id);
    }
    expect(ids).toEqual(["h1", "h2"]);
    expect(query(calls[2]!.url)).toMatchObject({ project_id: "p1", include_suggestions: "true", cursor: "c2" });
  });

  it("lists suggestions and dismisses one for its project", async () => {
    const suggestion = { ...entry, id: "sg1", kind: "retype_suggested", state: "pending" };
    const { fetch, calls } = mockFetch([
      json({ data: [suggestion], has_more: false, next_cursor: null }),
      json({ suggestion: { ...suggestion, state: "dismissed" }, activity_event_id: "e1" }),
      json({ error: { code: "conflict", message: "Already answered." } }, 409),
    ]);
    const { beakr } = client(fetch);
    const waiting = await beakr.knowledge.cardTypeSuggestions("p1");
    expect(waiting.data[0]!.id).toBe("sg1");
    expect(query(calls[0]!.url)).toEqual({ project_id: "p1" });
    const dismissed = await beakr.knowledge.dismissCardTypeSuggestion("sg1", "p1");
    expect(dismissed.suggestion.state).toBe("dismissed");
    expect(path(calls[1]!.url)).toBe("/v1/knowledge/wiki/page-types/suggestions/sg1/dismiss");
    expect(calls[1]!.body).toEqual({ project_id: "p1" });
    const again = await beakr.knowledge.dismissCardTypeSuggestion("sg1", "p1").catch((e: unknown) => e);
    expect(again).toBeInstanceOf(ConflictError);
  });

  it("passes the suggestion a retype answers, and only when given", async () => {
    const { fetch, calls } = mockFetch([json({ cards: 4 }), json({ cards: 4 })]);
    const { beakr } = client(fetch);
    await beakr.knowledge.retypeCards("matter", "p1", "deviation", { suggestionId: "sg1" });
    expect(calls[0]!.body).toEqual({ project_id: "p1", to_type: "deviation", dry_run: true, suggestion_id: "sg1" });
    await beakr.knowledge.retypeCards("matter", "p1", "deviation");
    expect(calls[1]!.body).toEqual({ project_id: "p1", to_type: "deviation", dry_run: true });
  });

  it("creates a project with its card type choice", async () => {
    const { fetch, calls } = mockFetch([json({ id: "p9", name: "Lyon" }, 201)]);
    const { beakr } = client(fetch);
    await beakr.projects.create({
      name: "Lyon",
      card_types: { inherit: "own", copy_from_project_id: "p1", copy_keys: ["deviation"] },
    });
    expect(calls[0]!.body).toEqual({
      name: "Lyon",
      card_types: { inherit: "own", copy_from_project_id: "p1", copy_keys: ["deviation"] },
    });
  });
});
