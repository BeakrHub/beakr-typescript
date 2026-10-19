/**
 * A project's Knowledge profile (Python's `tests/test_knowledge_profile.py`):
 * `projects.knowledgeProfile`, `setKnowledgeProfile`, `updateKnowledgeProfile`.
 */
import { describe, expect, it } from "vitest";
import { NotFoundError } from "../src/index.js";
import { client, json, mockFetch } from "./helpers.js";

const path = (url: string) => new URL(url).pathname;
const profile = {
  project_id: "p1",
  name: "Basel",
  description: "Batch records for the Basel site",
  industry: "",
  goals: ["Track deviations"],
  focus_areas: [],
  core_people: [{ name: "Priya", role: "Owner", relevance: "" }],
  core_organizations: [],
  core_topics: [],
  entity_types: ["batch", "deviation"],
  extraction_guidance: "",
  created_at: "2026-10-19T00:00:00Z",
  updated_at: "2026-10-19T00:00:00Z",
};

describe("projects Knowledge profile", () => {
  it("reads the project's profile", async () => {
    const { fetch, calls } = mockFetch([json(profile)]);
    const { beakr } = client(fetch);
    const read = await beakr.projects.knowledgeProfile("p1");
    expect(read.entity_types).toEqual(["batch", "deviation"]);
    expect(path(calls[0]!.url)).toBe("/v1/projects/p1/knowledge-profile");
  });

  it("throws NotFoundError with its code while the project has none", async () => {
    const { fetch } = mockFetch([
      json({ error: { code: "knowledge_profile_not_found", message: "No profile yet." } }, 404),
    ]);
    const { beakr } = client(fetch);
    const error = await beakr.projects.knowledgeProfile("p1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).code).toBe("knowledge_profile_not_found");
  });

  it("puts the whole profile and patches only the fields given", async () => {
    const { fetch, calls } = mockFetch([json(profile, 201), json(profile)]);
    const { beakr } = client(fetch);
    await beakr.projects.setKnowledgeProfile("p1", {
      description: "Batch records for the Basel site",
      entity_types: ["batch", "deviation"],
      core_people: [{ name: "Priya", role: "Owner" }],
    });
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.body).toEqual({
      description: "Batch records for the Basel site",
      entity_types: ["batch", "deviation"],
      core_people: [{ name: "Priya", role: "Owner" }],
    });
    await beakr.projects.updateKnowledgeProfile("p1", { entity_types: ["batch"] });
    expect(calls[1]!.method).toBe("PATCH");
    expect(calls[1]!.body).toEqual({ entity_types: ["batch"] });
  });
});
