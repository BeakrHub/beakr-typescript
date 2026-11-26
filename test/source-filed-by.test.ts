// A public source record names who wrote a conversation citation, by name only.
//
// `publicSource` copies an allowlist of fields into the public record, and
// `filed_by` was not on it, so the writer of an inline `conversation`,
// `agent_note` or `user_note` citation reached no `knowledge.pages.sources()`
// or `runs.answer()` record although the contract's `SourceRecord` declares it
// and the Python SDK's `public_source` keeps it. The engine's public form is
// name-only: `user_name`, `agent`, `client`, `run`, `session` and `text`, never
// `user_id`. Mirrors the Python SDK's tests/test_source_filed_by.py.
import { describe, expect, it } from "vitest";
import { publicSource } from "../src/sources.js";

const USER_ID = "a8469189-0000-0000-0000-000000000000";
const FILED_BY = {
  user_name: "Local evaluation administrator",
  user_id: USER_ID,
  agent: "claude-code/2.1.304",
  client: "beakr-mcp/0.4.0",
  run: "stdio:8d2a",
  session: "sess-41",
  text: "Local evaluation administrator via claude-code/2.1.304",
};
const { user_id: _dropped, ...PUBLIC } = FILED_BY;

describe("publicSource filed_by", () => {
  it("is kept in its public form", () => {
    const record = publicSource({
      source_ref: "beakr-source:v1:abc",
      name: "fx-a retest chat",
      source_kind: "conversation",
      filed_by: FILED_BY,
    });
    expect(record.filed_by).toEqual(PUBLIC);
    expect(JSON.stringify(record)).not.toContain(USER_ID);
  });

  it("is read from a page sources row's meta", () => {
    const record = publicSource({ key: "conversation:fx-a", source_title: "fx-a chat", meta: { filed_by: FILED_BY } });
    expect(record.filed_by).toEqual(PUBLIC);
    expect(JSON.stringify(record)).not.toContain(USER_ID);
  });

  it("leaves out empty and unknown filer fields", () => {
    const record = publicSource({ name: "n", filed_by: { agent: "bot", user_name: "", email: "x@y.test" } });
    expect(record.filed_by).toEqual({ agent: "bot" });
    expect(publicSource({ name: "n", filed_by: {} }).filed_by).toBeUndefined();
  });
});
