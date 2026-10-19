/**
 * The packed package references no API route outside the documented contract.
 *
 * The public SDK exposes only the documented core. It used to carry a private
 * layer (`src/internal`) with operations outside the documented contract; that
 * code now lives only in the Beakr CLI, filtered to what it calls. This test packs the
 * package exactly as it would be published (`npm pack`, which builds `dist/`
 * through `prepare`) and scans every shipped file for `/v1/...` route literals:
 * each must be a path of the engine's `docs/api/public-openapi.json`.
 *
 * `CHANGELOG.md` is not shipped for that reason: it carries the API
 * changelog's history, which names routes that are now unlisted. It stays in
 * the repository, where the README links it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");

/**
 * Unlisted routes that the documented contract's own prose names (schema and
 * operation descriptions), so the generated types repeat them in doc comments.
 * They are text, not callable code; the fix belongs in the engine's
 * descriptions, and each entry must leave this list when the contract stops
 * naming it.
 */
const NAMED_BY_CONTRACT_PROSE = [
  "/v1/artifacts/list",
  "/v1/assistant/threads/mine/{id}",
  "/v1/conversations/settings",
  // ProposalFiledBy.run: "... which `POST /v1/knowledge/runs/{run}/undo` takes back."
  "/v1/knowledge/runs/{run}/undo",
];

/**
 * The documented contract's text: `BEAKR_OPENAPI`, else `$BEAKR_ENGINE_PATH`, else a sibling engine
 * checkout, else the committed snapshot (scripts/refresh_snapshots.py).
 */
function contractText(): string {
  const file = "public-openapi.json";
  const candidates = [
    process.env.BEAKR_OPENAPI,
    process.env.BEAKR_ENGINE_PATH && resolve(process.env.BEAKR_ENGINE_PATH, `docs/api/${file}`),
    resolve(repo, `../beakr-engine/docs/api/${file}`),
    resolve(repo, `snapshots/beakr-engine/docs/api/${file}`),
  ].filter((c): c is string => Boolean(c));
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error(`${file} not found; set BEAKR_OPENAPI or BEAKR_ENGINE_PATH`);
  return readFileSync(found, "utf8");
}

/** The documented contract's paths, as templates. */
function documentedTemplates(): Set<string> {
  const spec = JSON.parse(contractText()) as { paths: Record<string, unknown> };
  return new Set(Object.keys(spec.paths).map(template));
}

const UUID = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/g;

/** A route with every path parameter, template field and example id reduced to `{}`. */
function template(route: string): string {
  return route
    .replace(UUID, "/{}")
    .replace(/\$\{[^}]*\}/g, "{}")
    .replace(/\{[^}]*\}/g, "{}")
    .split("?", 1)[0]!
    .replace(/[.,;:]+$/, "")
    .replace(/\/+$/, "");
}

/**
 * A literal names a documented route, or a leading part of one that code
 * extends (the org-scoped base `/v1/organizations/${orgId}`, or prose naming
 * the `/v1/bulk` routes).
 */
function documented(route: string, templates: Set<string>): boolean {
  const reduced = template(route);
  if (templates.has(reduced)) return true;
  return [...templates].some((t) => t.startsWith(`${reduced}/`));
}

/**
 * `/v1/...` routes in code (quoted, or a template literal whose `${...}` fields
 * are read whole) and in prose (the README).
 */
function routesIn(source: string): string[] {
  const routes: string[] = [];
  for (let start = source.indexOf("/v1/"); start !== -1; start = source.indexOf("/v1/", start + 1)) {
    let end = start;
    while (end < source.length) {
      if (source.startsWith("${", end)) {
        let depth = 0;
        end++; // the "$"; the braces are counted from here
        do {
          if (source[end] === "{") depth++;
          else if (source[end] === "}") depth--;
          end++;
        } while (depth > 0 && end < source.length);
      } else if (/[A-Za-z0-9_\-{}./]/.test(source[end]!)) {
        end++;
      } else {
        break;
      }
    }
    routes.push(source.slice(start, end));
  }
  return routes;
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

describe("the packed package", () => {
  let work: string;
  let shipped: string[];

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "beakr-sdk-pack-"));
    const out = execFileSync("npm", ["pack", "--json", "--pack-destination", work], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    // `prepare` (the build) logs before npm's JSON report, which starts on a
    // line of its own. Not the first "[": in CI the build log is colored, and an
    // ANSI escape (`\x1b[34m`) carries one, so parsing from it failed there.
    const start = out.search(/^\[\s*$/m);
    const report = JSON.parse(out.slice(start)) as Array<{ filename: string }>;
    execFileSync("tar", ["-xzf", join(work, report[0]!.filename), "-C", work]);
    shipped = filesUnder(join(work, "package"));
  }, 180_000);

  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it("ships no internal layer and no changelog", () => {
    const names = shipped.map((f) => relative(join(work, "package"), f));
    expect(names.filter((n) => /(^|\/)internal(\/|\.)/.test(n))).toEqual([]);
    expect(names).not.toContain("CHANGELOG.md");
    expect(names.some((n) => n.startsWith("dist/"))).toBe(true);
  });

  it("references only routes of the documented contract", () => {
    const templates = documentedTemplates();
    const undocumented: Record<string, string[]> = {};
    for (const file of shipped) {
      const routes = routesIn(readFileSync(file, "utf8")).filter(
        (r) => !documented(r, templates) && !NAMED_BY_CONTRACT_PROSE.includes(r),
      );
      if (routes.length) undocumented[relative(work, file)] = [...new Set(routes)].sort();
    }
    expect(undocumented).toEqual({});
  });
});

describe("the route scan", () => {
  it("excuses only routes the documented contract's prose still names", () => {
    const text = contractText();
    const templates = documentedTemplates();
    expect(NAMED_BY_CONTRACT_PROSE.filter((r) => !text.includes(r) || documented(r, templates))).toEqual([]);
  });

  // Guards the scanner itself: an unlisted route must not pass as documented.
  it("rejects an undocumented route and accepts a documented one", () => {
    const templates = documentedTemplates();
    expect(documented("/v1/workflows/dispatch", templates)).toBe(false);
    expect(documented("/v1/outputs", templates)).toBe(false);
    expect(documented("/v1/projects/${enc(String(args.path.project_id))}", templates)).toBe(true);
    expect(documented("/v1/projects/{project_id}", templates)).toBe(true);
    expect(documented("/v1/projects/", templates)).toBe(true);
    // A leading part of a documented route, but extended into an unlisted one.
    expect(documented("/v1/organizations/{org_id}/credentials", templates)).toBe(false);
    // A template literal is read whole, fields with nested calls included.
    const [route] = routesIn("path: `/v1/workflows/${enc(String(args.path.id))}/run`,");
    expect(route).toBe("/v1/workflows/${enc(String(args.path.id))}/run");
    expect(documented(route!, templates)).toBe(false);
  });
});
