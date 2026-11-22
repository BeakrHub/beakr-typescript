import { describe, expect, it } from "vitest";
import {
  ConflictError,
  NotFoundError,
  PersonReviewRequiredError,
  RESOLUTION_OPTIONS_TIMEOUT_MS,
  ValidationError,
  findResolutionOption,
} from "../src/index.js";
import { client, json, mockFetch, type Recorded } from "./helpers.js";

const BASE = "/v1/knowledge/wiki/proposals/f1";

const FLAG = {
  proposal_id: "f1",
  page_id: "p1",
  page_title: "Compound X",
  section_id: "dosing",
  section_title: "Dosing",
  section_content: "<!-- sec:dosing -->\n## Dosing\nIC50 is 12nM.",
  reason: "Sources disagree on the IC50.",
  agent_reasoning: "",
  current_revision: 3,
  is_stale: false,
  sources: [],
  contradicting_sources: [],
  supporting_sources: [],
};

const SECTION_OPTION = {
  id: "A",
  label: "Keep 12nM",
  summary: "Keep Lee 2023.",
  new_section_body: "<!-- sec:dosing -->\n## Dosing\nIC50 is 12nM (Lee 2023).",
};
const ROW_OPTION = {
  id: "B",
  label: "Retire the 40nM row",
  summary: "Delete the disputing row.",
  new_section_body: "<!-- sec:facts -->\n| ... |",
  row_operation: { table: "facts", kind: "delete", row_ids: ["r-2"], row: null, reason: "Other assay." },
};

function drafted(revision = 3) {
  return {
    proposal_id: "f1",
    section_id: "dosing",
    current_revision: revision,
    options: [SECTION_OPTION, ROW_OPTION],
    cached: true,
    no_draft_reason: null,
  };
}

const RESOLVED = { status: "resolved", proposal_id: "f1", page_id: "p1", section_id: "dosing", new_revision: 4 };

function route(call: Recorded): [string, string] {
  return [call.method, new URL(call.url).pathname];
}

describe("review flags (proposals.conflict / resolutionOptions / resolve / resolveOnEveryCard)", () => {
  it("reads a flag and drafts its options", async () => {
    const { fetch, calls } = mockFetch([json(FLAG), json(drafted())]);
    const { beakr } = client(fetch);
    const flag = await beakr.knowledge.proposals.conflict("f1");
    const options = await beakr.knowledge.proposals.resolutionOptions("f1");
    expect(flag.current_revision).toBe(3);
    expect(options.options.map((option) => option.id)).toEqual(["A", "B"]);
    expect(calls.map(route)).toEqual([
      ["GET", `${BASE}/conflict`],
      ["POST", `${BASE}/resolutions`],
    ]);
    expect(RESOLUTION_OPTIONS_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
  });

  it("applies a section option as a rewrite pinned to the revision", async () => {
    const { fetch, calls } = mockFetch([json(FLAG), json(drafted()), json(RESOLVED)]);
    const { beakr } = client(fetch);
    const result = await beakr.knowledge.proposals.resolve("f1", { optionId: "a", expectedRevision: 3 });
    expect(result.new_revision).toBe(4);
    expect(route(calls[2]!)).toEqual(["POST", `${BASE}/resolve`]);
    expect(calls[2]!.body).toEqual({
      section_id: "dosing",
      new_section_body: SECTION_OPTION.new_section_body,
      expected_revision: 3,
      option_id: "A",
    });
  });

  it("applies a card table option with resolve-rows, by its number", async () => {
    const { fetch, calls } = mockFetch([json(FLAG), json(drafted()), json(RESOLVED)]);
    const { beakr } = client(fetch);
    await beakr.knowledge.proposals.resolve("f1", { optionId: 2, expectedRevision: 3 });
    expect(route(calls[2]!)).toEqual(["POST", `${BASE}/resolve-rows`]);
    expect(calls[2]!.body).toEqual({ option_id: "B", expected_revision: 3 });
  });

  it("applies your own text to the flagged section", async () => {
    const { fetch, calls } = mockFetch([json(FLAG), json(RESOLVED)]);
    const { beakr } = client(fetch);
    await beakr.knowledge.proposals.resolve("f1", { sectionBody: "## Dosing\nIC50 is 12-40nM.", expectedRevision: 3 });
    expect(calls.map(route)).toEqual([
      ["GET", `${BASE}/conflict`],
      ["POST", `${BASE}/resolve`],
    ]);
    expect(calls[1]!.body).toEqual({
      section_id: "dosing",
      new_section_body: "## Dosing\nIC50 is 12-40nM.",
      expected_revision: 3,
    });
  });

  it("refuses a page that changed before drafting or applying anything", async () => {
    const { fetch, calls } = mockFetch([json({ ...FLAG, current_revision: 5 })]);
    const { beakr } = client(fetch);
    const refused = beakr.knowledge.proposals.resolve("f1", { optionId: "A", expectedRevision: 3 });
    await expect(refused).rejects.toBeInstanceOf(ConflictError);
    await expect(refused).rejects.toThrow(/revision 3, now 5/);
    expect(calls.map(route)).toEqual([["GET", `${BASE}/conflict`]]);
  });

  it("passes on the server's 409 when the page changes while applying", async () => {
    const changed = json({ error: { code: "conflict", message: "The page changed since you opened this conflict." } }, 409);
    const { fetch } = mockFetch([json(FLAG), json(drafted()), changed]);
    const { beakr } = client(fetch);
    await expect(beakr.knowledge.proposals.resolve("f1", { optionId: "A", expectedRevision: 3 })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("surfaces the person-review refusal as accept does", async () => {
    const refused = json({ error: { code: "person_review_required", message: "A person must accept." } }, 403);
    const { fetch } = mockFetch([json(FLAG), json(drafted()), refused]);
    const { beakr } = client(fetch);
    await expect(beakr.knowledge.proposals.resolve("f1", { optionId: "A", expectedRevision: 3 })).rejects.toBeInstanceOf(
      PersonReviewRequiredError,
    );
  });

  it("rejects an unknown option without applying anything", async () => {
    const { fetch, calls } = mockFetch([json(FLAG), json(drafted())]);
    const { beakr } = client(fetch);
    await expect(beakr.knowledge.proposals.resolve("f1", { optionId: "Z", expectedRevision: 3 })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(calls).toHaveLength(2);
  });

  it("needs exactly one of optionId and sectionBody, and a revision", async () => {
    const { fetch, calls } = mockFetch([]);
    const { beakr } = client(fetch);
    const proposals = beakr.knowledge.proposals;
    await expect(proposals.resolve("f1", { expectedRevision: 3 })).rejects.toBeInstanceOf(ValidationError);
    await expect(proposals.resolve("f1", { optionId: "A", sectionBody: "x", expectedRevision: 3 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(proposals.resolve("f1", { optionId: "A" } as never)).rejects.toBeInstanceOf(ValidationError);
    expect(calls).toHaveLength(0);
  });

  it("settles a contradiction on every card", async () => {
    const answer = { status: "resolved", proposal_id: "f1", updated: [{ page_id: "p1", revision: 4 }], skipped: [] };
    const { fetch, calls } = mockFetch([json(answer)]);
    const { beakr } = client(fetch);
    const result = await beakr.knowledge.proposals.resolveOnEveryCard("f1", "keep_disputed");
    expect(result.status).toBe("resolved");
    expect(route(calls[0]!)).toEqual(["POST", `${BASE}/resolve-cards`]);
    expect(calls[0]!.body).toEqual({ outcome: "keep_disputed" });
  });

  it("finds an option by its letter in any case or its number", () => {
    const options = [SECTION_OPTION, ROW_OPTION] as never[];
    expect(findResolutionOption(options, "b")).toBe(ROW_OPTION);
    expect(findResolutionOption(options, 1)).toBe(SECTION_OPTION);
    expect(findResolutionOption(options, "3")).toBeUndefined();
  });
});
