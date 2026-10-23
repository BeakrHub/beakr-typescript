import { describe, expect, it } from "vitest";
import { client, json, mockFetch } from "./helpers.js";

// engine #1765: per-project model refusals and fallbacks (Python's projects.model_refusals).
describe("projects.modelRefusals", () => {
  it("reads the events, the summary and the per-file counts", async () => {
    const { fetch, calls } = mockFetch([
      json({ data: [], has_more: false, next_cursor: null }),
      json({ refusals: 2 }),
      json({ data: [], has_more: false, next_cursor: null }),
    ]);
    const { beakr } = client(fetch);

    await beakr.projects.modelRefusals.list("p1", { outcome: "failed", stage: "compile" });
    const listed = new URL(calls[0]!.url);
    expect(listed.pathname).toBe("/v1/projects/p1/model-refusals");
    expect(listed.searchParams.get("outcome")).toBe("failed");
    expect(listed.searchParams.get("stage")).toBe("compile");

    const summary = await beakr.projects.modelRefusals.summary("p1", "7d");
    expect(summary.refusals).toBe(2);
    expect(new URL(calls[1]!.url).searchParams.get("window")).toBe("7d");

    await beakr.projects.modelRefusals.files("p1", { window: "30d" });
    const files = new URL(calls[2]!.url);
    expect(files.pathname).toBe("/v1/projects/p1/model-refusals/files");
    expect(files.searchParams.get("window")).toBe("30d");
  });
});
