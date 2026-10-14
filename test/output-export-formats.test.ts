/**
 * Spec 3.11: outputs export as md and html beside the office formats. One
 * generated method answers every format, so it returns the exact bytes; the
 * caller decodes the text formats. Root cause guarded: an operation whose
 * formats included text was generated as a text method, which decoded a PDF
 * or zip as UTF-8 and corrupted it.
 *
 * The documented contract has no export operation today, so the generator is
 * checked on a contract fragment shaped like one, and the transport on the
 * bytes such a method asks for.
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error -- the generator is plain JavaScript without declarations.
import { collectOperations } from "../scripts/operations.mjs";
import { Transport } from "../src/core.js";
import { mockFetch } from "./helpers.js";

const exportOperation = (content: string[]) => ({
  openapi: "3.1.0",
  paths: {
    "/v1/outputs/{output_id}/export/{format}": {
      get: {
        operationId: "export_output_v1_outputs__output_id__export__format__get",
        tags: ["outputs"],
        responses: { "200": { content: Object.fromEntries(content.map((c) => [c, {}])) } },
      },
    },
  },
});

const kindOf = (content: string[]) =>
  (collectOperations(exportOperation(content)) as { response: string }[])[0]!.response;

describe("output export formats", () => {
  it("generates bytes for an operation answering text and binary formats", () => {
    expect(kindOf(["application/pdf", "text/markdown", "text/html"])).toBe("bytes");
    expect(kindOf(["text/markdown"])).toBe("text");
  });

  it("returns a markdown export as bytes that decode to its text", async () => {
    const text = "# KX2 report\n\nRecovery was 92% [1].\n";
    const { fetch } = mockFetch([
      new Response(text, { headers: { "content-type": "text/markdown; charset=utf-8" } }),
    ]);
    const transport = new Transport({ apiKey: "bk_live_test", baseUrl: "https://api.example.test", fetch });
    const result = await transport.request({ method: "GET", path: "/v1/outputs/c1/export/md", responseType: "bytes" });
    expect(result).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(result as Uint8Array)).toBe(text);
  });

  it("preserves a PDF export byte for byte", async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x80, 0xff, 0xfe]);
    const { fetch } = mockFetch([new Response(bytes, { headers: { "content-type": "application/pdf" } })]);
    const transport = new Transport({ apiKey: "bk_live_test", baseUrl: "https://api.example.test", fetch });
    const result = await transport.request({ method: "GET", path: "/v1/outputs/c1/export/pdf", responseType: "bytes" });
    expect(result).toEqual(bytes);
  });
});
