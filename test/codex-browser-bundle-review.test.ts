/** Importing the client for browser/edge use must not require Node built-ins. */
import { build } from "esbuild";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

it("bundles a normal Beakr client for the browser without Node shims", async () => {
  // Dynamic literal imports are still resolved by browser bundlers. Merely
  // banning static node: imports does not establish browser/edge compatibility.
  const result = await build({
    stdin: {
      contents: 'import { Beakr } from "./src/index.ts"; export const client = new Beakr({ apiKey: "bk_test_dummy" });',
      resolveDir: resolve(__dirname, ".."),
      loader: "ts",
    },
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    logLevel: "silent",
  });
  expect(result.outputFiles[0]?.text.length).toBeGreaterThan(0);
});

it("sends requests in a runtime with no Node globals", async () => {
  const result = await build({
    stdin: {
      contents: `
        import { Beakr } from "./src/index.ts";
        export async function smoke() {
          const client = new Beakr({ apiKey: "bk_test_dummy", baseUrl: "https://api.test" });
          const project = await client.projects.get("p1");
          return { project };
        }
      `,
      resolveDir: resolve(__dirname, ".."),
      loader: "ts",
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "reviewSdk",
    write: false,
    logLevel: "silent",
  });
  const calls: string[] = [];
  // Deliberately omit process, Buffer, require and any dynamic-import hook.
  const context = {
    Blob, TextEncoder, TextDecoder, Headers, Request, Response, URL,
    AbortController, AbortSignal, setTimeout, clearTimeout, crypto: globalThis.crypto,
    fetch: async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ id: "p1" }), {
        headers: { "content-type": "application/json" },
      });
    },
  };
  const outcome = await runInNewContext(
    result.outputFiles[0]!.text + "\nreviewSdk.smoke()", context, { timeout: 2000 },
  );
  expect(outcome).toEqual({ project: { id: "p1" } });
  expect(calls).toEqual(["https://api.test/v1/projects/p1"]);
});
