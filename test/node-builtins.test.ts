import { afterEach, describe, expect, it, vi } from "vitest";
import { nodeBuiltin } from "../src/node-builtins.js";

describe("nodeBuiltin", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses process.getBuiltinModule when the runtime has it", async () => {
    const path = await nodeBuiltin<typeof import("node:path")>("node:path");
    expect(path.join("a", "b")).toBe(`a${path.sep}b`);
  });

  it("falls back to a dynamic import on Node without getBuiltinModule", async () => {
    vi.stubGlobal("process", { ...process, getBuiltinModule: undefined });
    const fs = await nodeBuiltin<typeof import("node:fs/promises")>("node:fs/promises");
    expect(typeof fs.readFile).toBe("function");
  });
});
