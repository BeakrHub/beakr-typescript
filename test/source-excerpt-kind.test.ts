// A public source record says whose words its excerpt is.
//
// The engine documents `evidence.excerpt_kind` (`quote`, `description` or
// `person`) on a source record, and `excerpt_kind` (`description` or `person`)
// on a compact record's excerpt whose text is not the source's own words.
// `publicSource` keeps only fields it names, so without carrying it a caller
// could no longer tell a quote from Beakr's description of a figure. The
// deprecated `fidelity`, `evidence_kind` and `anchor_status` stay beside it.
// Mirrors the Python SDK's tests/test_source_excerpt_kind.py.
import { describe, expect, it } from "vitest";
import { publicSource } from "../src/sources.js";

const QUOTE = "Dosing starts at 5 mg.";

describe("publicSource excerpt_kind", () => {
  it.each(["quote", "description", "person"])("keeps a source record's %s kind", (kind) => {
    const record = publicSource({ name: "protocol.pdf", evidence: { excerpt: QUOTE, excerpt_kind: kind } });
    expect(record.evidence).toEqual({ excerpt: QUOTE, excerpt_kind: kind });
  });

  it("keeps the deprecated trust fields beside it", () => {
    const evidence = {
      excerpt: QUOTE,
      excerpt_kind: "quote",
      fidelity: "verbatim",
      evidence_kind: "quote",
      anchor_status: "anchored",
    };
    expect(publicSource({ name: "protocol.pdf", evidence }).evidence).toEqual(evidence);
  });

  it("leaves out a kind the contract does not name", () => {
    const record = publicSource({ name: "memo.pdf", evidence: { excerpt: QUOTE, excerpt_kind: "guess" } });
    expect(record.evidence).toEqual({ excerpt: QUOTE });
  });

  it("adds nothing for an engine without the field", () => {
    const record = publicSource({ name: "memo.pdf", evidence: { excerpt: QUOTE } });
    expect(record.evidence).toEqual({ excerpt: QUOTE });
  });

  it("keeps a compact record's excerpt kind only when it is not a quote", () => {
    const record = publicSource({
      name: "results.pdf",
      excerpts: [
        { citation_key: "artifact:a-u1", text: QUOTE },
        { citation_key: "artifact:a-u2", text: "A bar chart of dose by week.", excerpt_kind: "description" },
        { citation_key: "artifact:a-u3", text: "Per Dana, the trial ended.", excerpt_kind: "person" },
        // A quote carries no kind on an excerpt; one sent anyway is dropped.
        { citation_key: "artifact:a-u4", text: QUOTE, excerpt_kind: "quote" },
      ],
    });
    expect(record.excerpts).toEqual([
      { citation_key: "artifact:a-u1", text: QUOTE },
      { citation_key: "artifact:a-u2", text: "A bar chart of dose by week.", excerpt_kind: "description" },
      { citation_key: "artifact:a-u3", text: "Per Dana, the trial ended.", excerpt_kind: "person" },
      { citation_key: "artifact:a-u4", text: QUOTE },
    ]);
  });
});
