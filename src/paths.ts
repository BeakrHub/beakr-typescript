/**
 * One URL path segment from a caller-supplied value (an ID, a slug).
 *
 * `encodeURIComponent` leaves `.` and `..` unchanged, and URL parsing then
 * normalises them away, so `projects.get("..")` would silently call a
 * different route (audit C057). Those values, and an empty one, are refused
 * before any request is built; everything else is encoded as one segment.
 */
export function segment(value: string | number): string {
  const text = String(value);
  if (text === "" || text === "." || text === "..") {
    throw new TypeError(`Invalid path value ${JSON.stringify(text)}: it is not a resource identifier.`);
  }
  return encodeURIComponent(text);
}

/**
 * Whether a download destination names a directory: one that already exists,
 * or a path written with a trailing separator (`"downloads/"`), which says
 * "a folder" even before it exists. Without the second rule a missing
 * `"downloads/"` was written as a file named `downloads`.
 */
export function namesDirectory(destination: string, existsAsDirectory: boolean): boolean {
  return existsAsDirectory || destination.endsWith("/") || destination.endsWith("\\");
}

/**
 * One file or folder name taken from a server reply (a skill's slug, a file's
 * original name), made safe to join onto a local directory. Refused: empty,
 * `.`, `..`, any separator, a drive prefix (`C:`), a NUL byte. A server reply
 * is never trusted to name a path, so a hostile or corrupted one cannot write
 * outside the folder the caller chose.
 */
export function safePathComponent(value: unknown, what: string): string {
  const text = typeof value === "string" ? value : "";
  if (
    text === "" ||
    text === "." ||
    text === ".." ||
    /[\\/]/.test(text) ||
    text.includes("\0") ||
    /^[A-Za-z]:/.test(text)
  ) {
    throw new TypeError(`Refusing to write ${what} ${JSON.stringify(value)}: it is not a single file or folder name.`);
  }
  return text;
}

/**
 * Throw unless `target` resolves inside `root` (or is `root`). The second check
 * behind {@link safePathComponent}: it holds whatever the names were.
 */
export function assertInside(
  nodePath: typeof import("node:path"),
  root: string,
  target: string,
  what: string,
): void {
  const base = nodePath.resolve(root);
  const resolved = nodePath.resolve(target);
  if (resolved !== base && !resolved.startsWith(base + nodePath.sep)) {
    throw new TypeError(`Refusing to write ${what}: ${JSON.stringify(target)} leaves ${JSON.stringify(root)}.`);
  }
}
