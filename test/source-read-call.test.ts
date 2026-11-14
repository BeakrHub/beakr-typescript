import { describe, expect, it } from "vitest";
import { publicSource } from "../src/index.js";

// Root cause: publicSource forwarded `retrieval` only when its arguments
// carried a download `handle`. The API attaches a different call to a cited
// meeting note, email or Slack thread (the provider's read tool and the item's
// own id), and that one was dropped, so a caller saw only the share link, whose
// id the read tool refuses. The engine's public_source keeps both forms.
describe("publicSource retrieval", () => {
  const note = { tool: "granola_get_note", arguments: { note_id: "not_LiveRf00000001" } };
  const thread = {
    tool: "slack_get_thread",
    arguments: { channel_id: "C04K10YTMN0", thread_ts: "1742744865.524899" },
  };

  it.each([note, thread])("keeps a connected item's read call", (call) => {
    const record = publicSource({ name: "note", source_ref: "beakr-source:v1:n", retrieval: call });
    expect(record.retrieval).toEqual(call);
  });

  it("still keeps only the handle of a file retrieval", () => {
    const record = publicSource({
      name: "memo.pdf",
      retrieval: { tool: "drive_download", arguments: { handle: "beakr://external/x", connector_id: "internal" } },
    });
    expect(record.retrieval).toEqual({ tool: "drive_download", arguments: { handle: "beakr://external/x" } });
  });

  it.each([
    { tool: "granola_get_note", arguments: { note_id: { nested: "value" } } },
    { tool: "granola_get_note", arguments: {} },
    { tool: "granola_get_note", arguments: { note_id: true } },
    { tool: "granola_get_note", arguments: { note_id: "" } },
    { tool: "", arguments: { note_id: "not_abc" } },
    { tool: "drive_download", arguments: { handle: "" } },
    { arguments: { note_id: "not_abc" } },
  ])("drops a call that is not a tool with scalar arguments", (retrieval) => {
    expect(publicSource({ name: "note", retrieval }).retrieval).toBeUndefined();
  });
});
