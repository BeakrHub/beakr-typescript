/**
 * The SDK runs in a real edge runtime (spec W6.2: "Node and edge runtimes").
 *
 * Root cause guarded (PROSE-449): edge support was only checked in a bare
 * `node:vm` context the test assembled by hand from Node's own globals, which
 * is not what an edge platform provides. This runs the SDK inside
 * `@edge-runtime/vm`, Vercel's Edge Runtime context: Web-standard globals from
 * `@edge-runtime/primitives` and no `process`, `require` or `Buffer`. The
 * bundle is built the way an edge bundler builds it (edge/worker/browser
 * export conditions, no Node built-ins), and every request goes to a mocked
 * `fetch` -- no network.
 */
import { EdgeVM } from "@edge-runtime/vm";
import { build } from "esbuild";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

type Reply = { status: number; body: unknown; headers?: Record<string, string> };

let bundle = "";

beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `
        import { Beakr, AuthenticationError } from "./src/index.ts";
        globalThis.beakrSdk = { Beakr, AuthenticationError };
      `,
      resolveDir: resolve(__dirname, ".."),
      loader: "ts",
    },
    bundle: true,
    platform: "neutral",
    conditions: ["edge-light", "worker", "browser"],
    mainFields: ["module", "main"],
    format: "iife",
    target: "es2022",
    write: false,
    logLevel: "silent",
  });
  bundle = result.outputFiles[0]!.text;
});

/** A fresh Edge Runtime with the SDK loaded and `fetch` answering from `replies`. */
function edgeRuntime(replies: Reply[]) {
  const sent: Sent[] = [];
  const queue = [...replies];
  const vm = new EdgeVM({
    extend: (context) => {
      // The edge context's own Response and Headers, so the SDK sees only
      // edge-runtime objects.
      const EdgeResponse = context.Response as typeof Response;
      const EdgeHeaders = context.Headers as typeof Headers;
      context.fetch = async (url: RequestInfo | URL, init: RequestInit = {}) => {
        const headers: Record<string, string> = {};
        new EdgeHeaders(init.headers).forEach((value, key) => {
          headers[key] = value;
        });
        sent.push({
          url: String(url),
          method: String(init.method ?? "GET"),
          headers,
          body: typeof init.body === "string" ? init.body : null,
        });
        const reply = queue.shift();
        if (!reply) throw new Error(`unexpected request ${String(url)}`);
        return new EdgeResponse(JSON.stringify(reply.body), {
          status: reply.status,
          headers: { "content-type": "application/json", ...(reply.headers ?? {}) },
        });
      };
      return context;
    },
  });
  vm.evaluate(bundle);
  return { vm, sent };
}

describe("edge runtime (@edge-runtime/vm)", () => {
  it("is a runtime without Node APIs", () => {
    const { vm } = edgeRuntime([]);
    expect(
      vm.evaluate(
        "JSON.stringify([typeof process, typeof require, typeof Buffer, typeof fetch, typeof crypto.randomUUID])",
      ),
    ).toBe(JSON.stringify(["undefined", "undefined", "undefined", "function", "function"]));
  });

  it("imports the SDK and makes an authenticated request through fetch", async () => {
    const { vm, sent } = edgeRuntime([{ status: 200, body: { id: "p1", name: "Assays" } }]);
    const project = await vm.evaluate(`
      (async () => {
        const client = new beakrSdk.Beakr({
          apiKey: "bk_test_edge",
          baseUrl: "https://api.test",
          agent: "edge-fn/1",
        });
        return JSON.stringify(await client.projects.get("p1"));
      })()
    `);
    expect(JSON.parse(project as string)).toEqual({ id: "p1", name: "Assays" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://api.test/v1/projects/p1");
    expect(sent[0]!.headers["authorization"]).toBe("Bearer bk_test_edge");
    expect(sent[0]!.headers["x-beakr-agent"]).toBe("edge-fn/1");
    expect(sent[0]!.headers["x-beakr-client"]).toMatch(/^sdk-typescript\//);
  });

  it("retries a keyed create with the same Idempotency-Key after a 503", async () => {
    const { vm, sent } = edgeRuntime([
      { status: 503, body: { error: { code: "unavailable", message: "busy" } } },
      { status: 201, body: { id: "p2" } },
    ]);
    const created = await vm.evaluate(`
      (async () => {
        const client = new beakrSdk.Beakr({
          apiKey: "bk_test_edge",
          baseUrl: "https://api.test",
          sleep: async () => {},
        });
        return JSON.stringify(await client.projects.create({ name: "Edge" }));
      })()
    `);
    expect(JSON.parse(created as string)).toEqual({ id: "p2" });
    expect(sent.map((s) => s.method)).toEqual(["POST", "POST"]);
    const key = sent[0]!.headers["idempotency-key"];
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent[1]!.headers["idempotency-key"]).toBe(key);
    expect(sent[1]!.body).toBe(sent[0]!.body);
  });

  it("walks the credential chain without file access and reports no credential", async () => {
    const { vm, sent } = edgeRuntime([]);
    const outcome = await vm.evaluate(`
      (async () => {
        const client = new beakrSdk.Beakr({ baseUrl: "https://api.test" });
        try {
          await client.me.get();
          return "sent";
        } catch (error) {
          return JSON.stringify([error instanceof beakrSdk.AuthenticationError, error.code]);
        }
      })()
    `);
    expect(JSON.parse(outcome as string)).toEqual([true, "no_credential"]);
    expect(sent).toHaveLength(0);
  });
});
