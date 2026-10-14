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
