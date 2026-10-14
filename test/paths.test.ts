import { describe, expect, it } from "vitest";
import { segment } from "../src/paths.js";

// C057: "." and ".." survive encodeURIComponent and are then normalised away by
// URL parsing, which silently selects a different route.
describe("segment", () => {
  it.each(["", ".", ".."])("refuses %j", (value) => {
    expect(() => segment(value)).toThrow(TypeError);
  });

  it("encodes everything else as one segment", () => {
    expect(segment("a/b")).toBe("a%2Fb");
    expect(segment("...")).toBe("...");
    expect(segment(42)).toBe("42");
  });
});
