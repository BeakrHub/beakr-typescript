import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Beakr, OPERATIONS } from "../src/index.js";
import { client, json, mockFetch } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const METHODS = ["get", "post", "put", "patch", "delete"] as const;

/**
 * An engine contract: `env`, else `$BEAKR_ENGINE_PATH`, else a sibling engine checkout, else the
 * committed snapshot (scripts/refresh_snapshots.py). `public-openapi.json` is the documented core,
 * the only contract this package is built from.
 */
function loadContract(env: string, file: string): { paths: Record<string, Record<string, unknown>> } {
  const candidates = [
    process.env[env],
    process.env.BEAKR_ENGINE_PATH && resolve(process.env.BEAKR_ENGINE_PATH, `docs/api/${file}`),
    resolve(here, `../../beakr-engine/docs/api/${file}`),
    resolve(here, `../snapshots/beakr-engine/docs/api/${file}`),
  ].filter((c): c is string => Boolean(c));
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error(`${file} not found; set ${env}`);
  return JSON.parse(readFileSync(found, "utf8"));
}

function operationsOf(spec: { paths: Record<string, Record<string, unknown>> }): string[] {
  const ops: string[] = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) if (item[method]) ops.push(`${method.toUpperCase()} ${path}`);
  }
  return ops.sort();
}

const mappedOf = (table: Record<string, { method: string; path: string }>) =>
  Object.entries(table).map(([name, op]) => ({ name, key: `${op.method} ${op.path}` }));

const layers = [
  {
    label: "documented (public) layer",
    contract: operationsOf(loadContract("BEAKR_OPENAPI", "public-openapi.json")),
    mapped: mappedOf(OPERATIONS),
    api: () => new Beakr({ apiKey: "bk_live_x", baseUrl: "https://api.example.test" }).api,
  },
];

for (const layer of layers) {
  describe(`every operation has an SDK method: ${layer.label}`, () => {
    it("covers each contract operation exactly once", () => {
      const covered = new Set(layer.mapped.map((m) => m.key));
      const uncovered = layer.contract.filter((op) => !covered.has(op));
      expect(uncovered, "run `npm run generate` after a contract change").toEqual([]);
      const counts = new Map<string, number>();
      for (const m of layer.mapped) counts.set(m.key, (counts.get(m.key) ?? 0) + 1);
      expect([...counts].filter(([, n]) => n > 1)).toEqual([]);
    });

    it("maps nothing the contract does not have", () => {
      const contract = new Set(layer.contract);
      expect(layer.mapped.filter((m) => !contract.has(m.key)).map((m) => m.name)).toEqual([]);
    });

    it("exposes each mapped name as a callable method", () => {
      const api = layer.api() as unknown as Record<string, Record<string, unknown>>;
      const missing = layer.mapped
        .map((m) => m.name)
        .filter((name) => {
          const [area, method] = name.split(".") as [string, string];
          return typeof api[area]?.[method] !== "function";
        });
      expect(missing).toEqual([]);
    });
  });
}

const path = (url: string) => url.replace("https://api.example.test", "");

describe("generated methods", () => {
  it("encode path parameters", async () => {
    const { fetch, calls } = mockFetch([json({ id: "p/1" })]);
    const { beakr } = client(fetch);
    await beakr.api.projects.getProject({ path: { project_id: "p/1 x" } });
    expect(calls[0]!.method).toBe("GET");
    expect(path(calls[0]!.url)).toBe("/v1/projects/p%2F1%20x");
  });

  it("send query parameters", async () => {
    const { fetch, calls } = mockFetch([json({ data: [] })]);
    const { beakr } = client(fetch);
    await beakr.api.conversations.listConversations({ query: { q: "assay", limit: 5 } });
    expect(path(calls[0]!.url)).toBe("/v1/conversations?q=assay&limit=5");
  });

  it("send a JSON body and an idempotency key on creates", async () => {
    const { fetch, calls } = mockFetch([json({ id: "p1" }, 201)]);
    const { beakr } = client(fetch);
    await beakr.api.projects.createProject({ body: { name: "Assays" } as never });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({ name: "Assays" });
    expect(calls[0]!.headers["idempotency-key"]).toMatch(/[0-9a-f-]{36}/);
  });

  it("reuse a caller-supplied idempotency key", async () => {
    const { fetch, calls } = mockFetch([json({ id: "p1" }, 201), json({ id: "p1" }, 201)]);
    const { beakr } = client(fetch);
    for (let i = 0; i < 2; i++) {
      await beakr.api.projects.createProject(
        { body: { name: "Assays" } as never },
        { idempotencyKey: "create-assays-1" },
      );
    }
    expect(calls.map((c) => c.headers["idempotency-key"])).toEqual(["create-assays-1", "create-assays-1"]);
  });

  it("never send an idempotency key on reads", async () => {
    const { fetch, calls } = mockFetch([json([])]);
    const { beakr } = client(fetch);
    await beakr.api.folders.listFolders();
    expect(calls[0]!.headers["idempotency-key"]).toBeUndefined();
  });

  it("call anonymous operations without the credential", async () => {
    const { fetch, calls } = mockFetch([json({ openapi: "3.1.0" })]);
    const { beakr } = client(fetch);
    await beakr.api.openapi.publicOpenapi();
    expect(calls[0]!.headers["authorization"]).toBeUndefined();
  });

  it("follow the cursor for paginated operations", async () => {
    const { fetch, calls } = mockFetch([
      json({ data: [{ id: "c1" }], next_cursor: "cur_2", has_more: true }),
      json({ data: [{ id: "c2" }], next_cursor: null, has_more: false }),
    ]);
    const { beakr } = client(fetch);
    const ids: string[] = [];
    for await (const item of beakr.api.conversations.listConversationsAll(undefined, { pageSize: 1 })) {
      ids.push(String((item as { id: string }).id));
    }
    expect(ids).toEqual(["c1", "c2"]);
    expect(path(calls[1]!.url)).toBe("/v1/conversations?cursor=cur_2&limit=1");
  });
});
