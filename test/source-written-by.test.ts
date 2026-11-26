// A public source record says who wrote a cited file (`written_by`).
//
// The engine documents `written_by` (`SourceWrittenBy`: `authors`, each `name`
// and `org_member`; `by_agent`; `text`) on the source record of a citation of
// an uploaded file whose upload recorded its authors. `publicSource` keeps only
// fields it names and named none for it, so `knowledge.pages.sources()` and
// `runs.answer()` never said who wrote a file. A page sources row also carries
// it in the compiler's stored form, a list of `{ name, user_id? }` entries
// (sandbox, engine 3a7bbde4fd, 26 Nov 2026), which is mapped as the engine maps
// it (`compiler/source_authorship.public_written_by`), never with a member id.
// Mirrors the Python SDK's tests/test_upload_authorship.py.
import { describe, expect, it } from "vitest";
import { publicSource } from "../src/sources.js";

/** A page sources row for a citation of a co-written upload, as sandbox served it (trimmed). */
const PAGE_SOURCES_ROW = {
  source_ref: "beakr-source:v1:file:b75b5c40-8bc3-4e13-85cc-2f1a99321da0",
  key: "artifact:a6799af3-4b0f-49d0-98f8-847aa30d7fa8-u1",
  source_type: "artifact",
  source_title: "r11-coauthored-note.md",
  section_id: "sec_description",
  stance: "support",
  meta: {
    origin: "upload",
    file_name: "r11-coauthored-note.md",
    artifact_id: "b75b5c40-8bc3-4e13-85cc-2f1a99321da0",
    written_by: [{ name: "Dr. Jane Testwell" }, { name: "Bob Sample" }],
  },
  artifact_id: "b75b5c40-8bc3-4e13-85cc-2f1a99321da0",
  excerpt: "Assay R108-T2 was run by two people on 2025-04-02.",
  written_by: [{ name: "Dr. Jane Testwell" }, { name: "Bob Sample" }],
};

describe("publicSource written_by", () => {
  it("keeps a Knowledge read's SourceWrittenBy, without member ids", () => {
    const record = publicSource({
      source_ref: "file:a1",
      name: "Assay notes",
      written_by: {
        authors: [
          { name: "Jane Doe", org_member: true, user_id: "u-jane" },
          { name: "Bob Smith", org_member: false },
        ],
        by_agent: true,
        text: "an agent for Jane Doe and Bob Smith",
      },
    });
    expect(record.written_by).toEqual({
      authors: [
        { name: "Jane Doe", org_member: true },
        { name: "Bob Smith", org_member: false },
      ],
      by_agent: true,
      text: "an agent for Jane Doe and Bob Smith",
    });
    expect(publicSource({ source_ref: "file:a1", name: "x", written_by: {} }).written_by).toBeUndefined();
  });

  it("maps a page sources row's stored stamp", () => {
    expect(publicSource(PAGE_SOURCES_ROW).written_by).toEqual({
      authors: [
        { name: "Dr. Jane Testwell", org_member: false },
        { name: "Bob Sample", org_member: false },
      ],
      by_agent: false,
      text: "Dr. Jane Testwell and Bob Sample",
    });
  });

  it("names members and agents but never an id", () => {
    const stamp = [
      { name: "Jane  Doe", user_id: "u-jane", by_agent: true },
      { name: "Bob Smith", by_agent: true },
      { name: "Ana Li", by_agent: true },
      { name: "  " },
    ];
    const record = publicSource({ source_ref: "file:a1", name: "x", meta: { written_by: stamp } });
    expect(record.written_by).toEqual({
      authors: [
        { name: "Jane Doe", org_member: true },
        { name: "Bob Smith", org_member: false },
        { name: "Ana Li", org_member: false },
      ],
      by_agent: true,
      text: "an agent for Jane Doe, Bob Smith and Ana Li",
    });
    expect(JSON.stringify(record)).not.toContain("u-jane");
    expect(publicSource({ source_ref: "file:a1", name: "x", written_by: { name: "Jane Doe" } }).written_by?.text).toBe(
      "Jane Doe",
    );
    expect(publicSource({ source_ref: "file:a1", name: "x", written_by: [] }).written_by).toBeUndefined();
  });
});
