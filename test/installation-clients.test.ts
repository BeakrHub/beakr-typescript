import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetInstallationClients, InstallationClients, VERSION } from "../src/index.js";
import { client, json, mockFetch } from "./helpers.js";

// A self-hosted installation serves /clients/manifest.json from its web image
// (beakr-engine client_index.py): the release and the exact client versions it
// ships. The SDK reads it without a credential, and checkInstallationClients()
// warns once when this SDK is not the version the release ships (as the
// Python SDK's meta.check_installation_clients() does).

const BASE = "https://api.example.test";
const MANIFEST = `${BASE}/clients/manifest.json`;
const SHIPPED = "9.9.9-selfhosted.gaaaaaaaaaaaa";

function manifest(sdk = SHIPPED, schema = 1) {
  return {
    schema_version: schema,
    release: "1.0.7",
    python_index: "/pypi/simple/",
    clients: {
      "beakr-cli": { kind: "python", version: "0.8.0+selfhosted.gb" },
      "beakr-sdk": { kind: "python", version: "0.5.0+selfhosted.gc" },
      "@beakr/sdk": {
        kind: "npm",
        version: sdk,
        files: [],
        latest_url: "/npm/beakr-sdk-latest.tgz",
        install: `npm install {origin}/npm/beakr-sdk-${sdk}.tgz`,
      },
    },
  };
}

beforeEach(() => forgetInstallationClients());
afterEach(() => {
  forgetInstallationClients();
  vi.restoreAllMocks();
});

describe("meta.installationClients", () => {
  it("reads the manifest without a credential and keeps it", async () => {
    const { fetch, calls } = mockFetch([json(manifest())]);
    const { beakr } = client(fetch);

    const found = await beakr.meta.installationClients();

    expect(found).toBeInstanceOf(InstallationClients);
    expect(found!.release).toBe("1.0.7");
    expect(found!.version()).toBe(SHIPPED);
    expect(found!.version("beakr-cli")).toBe("0.8.0+selfhosted.gb");
    expect(found!.packages).toEqual(["@beakr/sdk", "beakr-cli", "beakr-sdk"]);
    expect(found!.installCommand()).toBe(`npm install ${BASE}/npm/beakr-sdk-${SHIPPED}.tgz`);
    expect(found!.sdkMatches).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(MANIFEST);
    expect(calls[0]!.headers["authorization"]).toBeUndefined();
    // Kept for a few minutes per installation: no second request.
    expect(await beakr.meta.installationClients()).toBe(found);
  });

  it("makes no request when a client is constructed", () => {
    const { fetch, calls } = mockFetch([]);
    client(fetch);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["a 404", () => json({ detail: "Not Found" }, 404)],
    ["a sign-in page", () => new Response("<html>sign in</html>", { headers: { "content-type": "text/html" } })],
    ["another schema", () => json(manifest(SHIPPED, 2))],
    ["no release", () => json({ schema_version: 1, release: "", clients: {} })],
  ])("is null for %s", async (_name, reply) => {
    const { fetch } = mockFetch([reply()]);
    const { beakr } = client(fetch);
    expect(await beakr.meta.installationClients()).toBeNull();
  });
});

describe("meta.checkInstallationClients", () => {
  it("warns once on a mismatch", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { fetch } = mockFetch([json(manifest()), json(manifest())]);
    const { beakr } = client(fetch);

    await beakr.meta.checkInstallationClients();
    await beakr.meta.checkInstallationClients({ refresh: true });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      `This installation (release 1.0.7) ships @beakr/sdk ${SHIPPED}; you have ${VERSION}. ` +
        `Upgrade: npm install ${BASE}/npm/beakr-sdk-${SHIPPED}.tgz`,
    );
  });

  it("says nothing on a match or without a manifest", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { fetch } = mockFetch([json(manifest(VERSION)), json({}, 404)]);
    const { beakr } = client(fetch);

    const found = await beakr.meta.checkInstallationClients();
    expect(found!.sdkMatches).toBe(true);
    expect(await beakr.meta.checkInstallationClients({ refresh: true })).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});
