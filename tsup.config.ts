import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node18",
  // The SDK uses only fetch and Web Crypto, both global in Node 18+ and browsers.
  platform: "neutral",
});
