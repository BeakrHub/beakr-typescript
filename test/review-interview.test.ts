/**
 * Drafting an interview from a project's open review flags (Python's
 * `tests/test_review_interview.py`): `interviews.draftFromReviews`, which posts
 * to `/v1/projects/{project_id}/interviews/from-reviews`. It drafts and saves an
 * interview; it never sends one.
 */
import { describe, expect, it } from "vitest";
import { client, json, mockFetch } from "./helpers.js";

const drafted = {
  interview: { id: "s1", title: "Settle the Lot 42 questions", links: [] },
  questions: [
    {
      number: 1,
      question: "Which release date of Lot 42 is right, 3 May or 5 May?",
      proposal_id: "f1",
      kind: "contradiction",
      page_id: "pg1",
      page_title: "Lot 42",
      section_id: "release",
      reason: "Two records give different release dates.",
      asked_revision: 4,
      written_by: "model",
      linked: true,
    },
  ],
  skipped: [{ proposal_id: "f2", reason: "not_open" }],
  questions_written_by: "model",
  edit_url: "https://app.example/interviews/send?edit=s1",
  empty_reason: null,
  message: null,
};
const nothing = {
  interview: null,
  questions: [],
  skipped: [],
  questions_written_by: null,
  edit_url: null,
  empty_reason: "no_open_flags",
  message: "This project has no open review flags.",
};

describe("interviews.draftFromReviews", () => {
  it("posts only the options given, with an idempotency key", async () => {
    const { fetch, calls } = mockFetch([json(drafted, 201), json(drafted, 201), json(drafted, 201)]);
    const { beakr } = client(fetch);
    expect(await beakr.interviews.draftFromReviews("p1")).toEqual(drafted);
    await beakr.interviews.draftFromReviews("p1", { include: ["ambiguity", "likely_error"], participant: "Dana" });
    await beakr.interviews.draftFromReviews("p1", {
      proposalIds: ["f1", "f2"],
      maxQuestions: 5,
      title: "Lot 42",
      goals: "Settle the dates",
    });
    expect(calls.map((c) => c.method)).toEqual(["POST", "POST", "POST"]);
    expect(new URL(calls[0]!.url).pathname).toBe("/v1/projects/p1/interviews/from-reviews");
    expect(calls.map((c) => c.body)).toEqual([
      {},
      { include: ["ambiguity", "likely_error"], participant: "Dana" },
      { proposal_ids: ["f1", "f2"], max_questions: 5, title: "Lot 42", goals: "Settle the dates" },
    ]);
    expect(calls[0]!.headers["idempotency-key"]).toBeTruthy();
  });

  it("leaves empty lists out", async () => {
    const { fetch, calls } = mockFetch([json(drafted, 201)]);
    const { beakr } = client(fetch);
    await beakr.interviews.draftFromReviews("p1", { proposalIds: [], include: [] });
    expect(calls[0]!.body).toEqual({});
  });

  it("answers no interview when there is nothing to ask", async () => {
    const { fetch } = mockFetch([json(nothing)]);
    const { beakr } = client(fetch);
    const answer = await beakr.interviews.draftFromReviews("p1");
    expect(answer.interview).toBeNull();
    expect(answer.empty_reason).toBe("no_open_flags");
  });

  it("encodes the project id as one path segment", async () => {
    const { fetch, calls } = mockFetch([json(drafted, 201)]);
    const { beakr } = client(fetch);
    await beakr.interviews.draftFromReviews("p/1");
    expect(new URL(calls[0]!.url).pathname).toBe("/v1/projects/p%2F1/interviews/from-reviews");
  });
});
