/**
 * Research waits as long as the engine allows it, whatever the client's timeout.
 *
 * Root cause: the engine gives POST /v1/knowledge/research up to 150s (an
 * agentic loop that reads documents from connected services), but every request
 * used the client's timeout, 60s by default, so a slow research answer was
 * abandoned while the engine was still producing it. Research now waits at least
 * RESEARCH_TIMEOUT_MS (170s); other requests keep the client's timeout.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { RESEARCH_TIMEOUT_MS } from "../src/index.js";
import { client, json, mockFetch } from "./helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function timeouts(): number[] {
  const seen: number[] = [];
  const original = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
    seen.push(ms);
    return original(ms);
  });
  return seen;
}

describe("research timeout", () => {
  it("outwaits the engine's 150s research route", async () => {
    const seen = timeouts();
    const { fetch } = mockFetch([json({ text: "ok" }), json({ data: [], next_cursor: null, has_more: false })]);
    const { beakr } = client(fetch);
    await beakr.knowledge.research("What changed?");
    await beakr.projects.list();
    expect(RESEARCH_TIMEOUT_MS).toBeGreaterThan(150_000);
    expect(seen).toEqual([RESEARCH_TIMEOUT_MS, 60_000]);
  });

  it("keeps a longer client timeout", async () => {
    const seen = timeouts();
    const { fetch } = mockFetch([json({ text: "ok" })]);
    const { beakr } = client(fetch, { timeoutMs: 300_000 });
    await beakr.knowledge.research("What changed?");
    expect(seen).toEqual([300_000]);
  });
});
