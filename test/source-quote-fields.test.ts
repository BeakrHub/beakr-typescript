// A public source record keeps the passage around a quote and when it was recorded.
//
// The engine documents `context_excerpt` and `source_recorded_at` on a
// citation's quote: beside `excerpt` on a page sources row
// (`GET /v1/knowledge/wiki/pages/{page_id}/sources`) and inside `evidence` on a
// source record (`command`, `write`, `research`). `publicSource` used to keep
// only `excerpt` and `locator` of them, so both were lost. Mirrors the Python
// SDK's tests/test_source_quote_fields.py.
import { describe, expect, it } from "vitest";
import { publicSource } from "../src/sources.js";

const QUOTE = "Dosing starts at 5 mg.";
const CONTEXT = "The protocol was amended in March. Dosing starts at 5 mg. Escalation follows.";

describe("publicSource quote fields", () => {
  it("keeps a source record's evidence quote fields", () => {
    const record = publicSource({
      name: "protocol.pdf",
      evidence: {
        excerpt: QUOTE,
        context_excerpt: CONTEXT,
        locator: "p. 7",
        source_recorded_at: "2026-03-04T14:02:00-05:00",
      },
    });
    expect(record.evidence).toEqual({
      excerpt: QUOTE,
      context_excerpt: CONTEXT,
      locator: "p. 7",
      source_recorded_at: "2026-03-04T14:02:00-05:00",
    });
  });

  it("keeps a page sources row's quote fields", () => {
    // The page sources route carries them at the top level, beside `excerpt`.
    const record = publicSource({
      source_title: "standup",
      excerpt: QUOTE,
      context_excerpt: CONTEXT,
      source_recorded_at: "2026-03-04",
    });
    expect(record.evidence).toEqual({
      excerpt: QUOTE,
      context_excerpt: CONTEXT,
      source_recorded_at: "2026-03-04",
    });
  });

  it("adds nothing to a record without them", () => {
    const record = publicSource({ name: "memo.pdf", evidence: { excerpt: QUOTE } });
    expect(record.evidence).toEqual({ excerpt: QUOTE });
  });
});
