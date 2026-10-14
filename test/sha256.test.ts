import { describe, expect, it } from "vitest";
import { Sha256, sha256Hex } from "../src/sha256.js";

const webDigest = async (data: Uint8Array<ArrayBuffer>) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

// The incremental fallback (edge runtimes) must equal Web Crypto at every
// length around the 64-byte block and 56-byte padding boundaries, however the
// input is chunked.
describe("Sha256 (incremental, for runtimes without a streaming digest)", () => {
  const lengths = [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 4097];
  it.each(lengths)("matches Web Crypto for %i bytes in odd chunks", async (length) => {
    const data = new Uint8Array(length).map((_, i) => (i * 31 + 7) & 0xff);
    const hash = new Sha256();
    for (let i = 0; i < length; i += 13) hash.update(data.subarray(i, i + 13));
    expect(hash.hex()).toBe(await webDigest(data));
  });

  it("matches the published 'abc' vector", () => {
    expect(new Sha256().update(new TextEncoder().encode("abc")).hex()).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("sha256Hex", () => {
  it("hashes a Blob as a stream", async () => {
    const data = new TextEncoder().encode("hello");
    expect(await sha256Hex(new Blob([data]))).toBe(await webDigest(data));
  });
});
