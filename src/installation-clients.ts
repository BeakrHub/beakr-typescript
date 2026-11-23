/**
 * The client versions a self-hosted installation's release ships.
 *
 * A full self-hosted deployment serves its own release's clients from the same
 * host as the app (beakr-engine `client_index.py`, served by its web image):
 * `GET /clients/manifest.json` names the release and, for each client package,
 * the exact stamped version (`0.4.0-selfhosted.g<commit>` for this SDK), its
 * files and their sha256, and how to install it from the installation itself
 * (`npm install https://<host>/npm/beakr-sdk-<version>.tgz`). The manifest sits
 * outside `/v1` and needs no credential: none is sent.
 *
 * `beakr.meta.installationClients()` reads it (`null` from a server that serves
 * none: hosted Beakr, or an older release). `beakr.meta.checkInstallationClients()`
 * also warns once per installation and version (`console.warn`) when this SDK is
 * not the version the installation ships. Nothing here runs on its own:
 * constructing a client makes no request.
 */
import { BeakrError } from "./errors.js";
import { VERSION } from "./version.js";

export const INSTALLATION_MANIFEST_PATH = "/clients/manifest.json";
/** This SDK's package name in the manifest. */
export const SDK_PACKAGE = "@beakr/sdk";
/** How long a read manifest (or a failure to read one) is kept before asking again. */
export const INSTALLATION_CLIENTS_TTL_MS = 300_000;
/** The literal placeholder the manifest's install commands carry for the installation. */
const ORIGIN_PLACEHOLDER = "{origin}";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One installation's `/clients/manifest.json`: its release and client versions. */
export class InstallationClients {
  /** The installation's release version (`1.0.7`). */
  readonly release: string;
  private readonly clients: Record<string, unknown>;

  private constructor(
    /** The installation, as this client is configured (no trailing slash). */
    readonly baseUrl: string,
    /** The manifest as served. */
    readonly manifest: Record<string, unknown>,
  ) {
    this.release = String(manifest["release"]);
    this.clients = manifest["clients"] as Record<string, unknown>;
  }

  /** The manifest, or `null` for anything that is not a schema 1 manifest. */
  static parse(baseUrl: string, data: unknown): InstallationClients | null {
    if (!isRecord(data) || data["schema_version"] !== 1) return null;
    if (typeof data["release"] !== "string" || data["release"] === "") return null;
    if (!isRecord(data["clients"])) return null;
    return new InstallationClients(baseUrl.replace(/\/+$/, ""), data);
  }

  /** The client packages the release ships. */
  get packages(): string[] {
    return Object.keys(this.clients).sort();
  }

  /** The exact version of `pkg` the release ships, or `null`. */
  version(pkg: string = SDK_PACKAGE): string | null {
    const entry = this.clients[pkg];
    const value = isRecord(entry) ? entry["version"] : undefined;
    return typeof value === "string" && value !== "" ? value : null;
  }

  /** How to install exactly that version, with this installation's address filled in. */
  installCommand(pkg: string = SDK_PACKAGE): string | null {
    const entry = this.clients[pkg];
    const command = isRecord(entry) ? entry["install"] : undefined;
    if (typeof command !== "string" || command === "") return null;
    return command.split(ORIGIN_PLACEHOLDER).join(this.baseUrl);
  }

  /** Whether this SDK is the one the release ships (`null` when it names none). */
  get sdkMatches(): boolean | null {
    const expected = this.version(SDK_PACKAGE);
    return expected === null ? null : expected === VERSION;
  }
}

interface CacheEntry {
  at: number;
  found: Promise<InstallationClients | null>;
}

const cache = new Map<string, CacheEntry>();
const warned = new Set<string>();

function cacheKey(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "").toLowerCase();
}

/** Drop the cached manifest (and the once-only warning) for `baseUrl`, or for every server. */
export function forgetInstallationClients(baseUrl?: string): void {
  if (baseUrl === undefined) {
    cache.clear();
    warned.clear();
    return;
  }
  const key = cacheKey(baseUrl);
  cache.delete(key);
  for (const item of [...warned]) if (item.startsWith(`${key} `)) warned.delete(item);
}

/**
 * `baseUrl`'s {@link InstallationClients}, read with `fetchText` at most once per
 * TTL. Any server answer that is not a manifest (a 404, a sign-in page, another
 * schema) is `null`, cached for the same TTL.
 */
export function cachedInstallationClients(
  baseUrl: string,
  fetchText: () => Promise<string>,
  options: { refresh?: boolean } = {},
): Promise<InstallationClients | null> {
  const key = cacheKey(baseUrl);
  const cached = cache.get(key);
  if (cached && !options.refresh && Date.now() - cached.at < INSTALLATION_CLIENTS_TTL_MS) return cached.found;
  const entry: CacheEntry = {
    at: Date.now(),
    found: fetchText().then(
      (text) => {
        try {
          return InstallationClients.parse(baseUrl, JSON.parse(text));
        } catch {
          return null;
        }
      },
      (error: unknown) => {
        if (error instanceof BeakrError) return null;
        // Not a server answer (a bug, an abort): forget it so the next call tries again.
        if (cache.get(key) === entry) cache.delete(key);
        throw error;
      },
    ),
  };
  cache.set(key, entry);
  return entry.found;
}

/** The warning `checkInstallationClients` gives, or `null` when there is nothing to say. */
export function mismatchMessage(found: InstallationClients | null): string | null {
  if (found === null || found.sdkMatches !== false) return null;
  const command = found.installCommand(SDK_PACKAGE);
  return (
    `This installation (release ${found.release}) ships ${SDK_PACKAGE} ${found.version(SDK_PACKAGE)}; ` +
    `you have ${VERSION}.` +
    (command ? ` Upgrade: ${command}` : "")
  );
}

/** Warn (`console.warn`) once per installation and shipped version when this SDK differs. */
export function warnOnceOnMismatch(found: InstallationClients | null): void {
  const message = mismatchMessage(found);
  if (message === null || found === null) return;
  const key = `${cacheKey(found.baseUrl)} ${found.version(SDK_PACKAGE)}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}
