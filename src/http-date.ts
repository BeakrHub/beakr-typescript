/**
 * Parse an HTTP-date (RFC 9110 section 5.6.7).
 *
 * A `Retry-After` header may carry an HTTP-date instead of a number of seconds
 * (RFC 9110 section 10.2.3). Senders must use IMF-fixdate, but recipients must
 * also accept the two obsolete forms, RFC 850 and ANSI C `asctime()`:
 *
 *     Sun, 06 Nov 1994 08:49:37 GMT    ; IMF-fixdate
 *     Sunday, 06-Nov-94 08:49:37 GMT   ; obsolete RFC 850 format
 *     Sun Nov  6 08:49:37 1994         ; ANSI C's asctime() format
 *
 * The grammar is matched here rather than with `Date.parse`, whose handling of
 * anything but IMF-fixdate is implementation-defined (and which would accept a
 * non-GMT zone or an ISO 8601 string). The Python SDK
 * (beakr-python's `src/beakr_sdk/_http_date.py`) implements the same grammar so
 * both SDKs agree on every header.
 */

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY = "(?:mon|tue|wed|thu|fri|sat|sun)";
const DAY_LONG = "(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)";
const MONTH = `(?<month>${MONTHS.join("|")})`;
const TIME = "(?<hour>\\d{2}):(?<minute>\\d{2}):(?<second>\\d{2})";

const IMF_FIXDATE = new RegExp(`^${DAY}, (?<day>\\d{2}) ${MONTH} (?<year>\\d{4}) ${TIME} GMT$`, "i");
const RFC850 = new RegExp(`^${DAY_LONG}, (?<day>\\d{2})-${MONTH}-(?<year>\\d{2}) ${TIME} GMT$`, "i");
const ASCTIME = new RegExp(`^${DAY} ${MONTH} (?<day>\\d{2}| \\d) ${TIME} (?<year>\\d{4})$`, "i");

/**
 * The epoch milliseconds an HTTP-date names, or `undefined` when it is not one.
 *
 * `nowMs` resolves the RFC 850 two-digit year: a year that would land more than
 * 50 years after now is the most recent past year with those digits.
 */
export function parseHttpDate(value: string, nowMs: number): number | undefined {
  const text = value.trim();
  for (const pattern of [IMF_FIXDATE, RFC850, ASCTIME]) {
    const groups = pattern.exec(text)?.groups;
    if (!groups) continue;
    let year = Number(groups["year"]);
    if (pattern === RFC850) year = expandTwoDigitYear(year, new Date(nowMs).getUTCFullYear());
    const month = MONTHS.indexOf(groups["month"]!.toLowerCase());
    const day = Number(groups["day"]);
    const hour = Number(groups["hour"]);
    const minute = Number(groups["minute"]);
    // RFC 9110 allows second 60 for a leap second; Date does not.
    const parsedSecond = Number(groups["second"]);
    const second = parsedSecond === 60 ? 59 : parsedSecond;
    const ms = Date.UTC(year, month, day, hour, minute, second);
    // Date.UTC rolls out-of-range fields over (Feb 30 -> Mar 2); those are not dates.
    const check = new Date(ms);
    if (
      check.getUTCFullYear() !== year ||
      check.getUTCMonth() !== month ||
      check.getUTCDate() !== day ||
      check.getUTCHours() !== hour ||
      check.getUTCMinutes() !== minute ||
      check.getUTCSeconds() !== second
    ) {
      return undefined;
    }
    return ms;
  }
  return undefined;
}

function expandTwoDigitYear(twoDigits: number, nowYear: number): number {
  let year = nowYear - (nowYear % 100) + twoDigits;
  if (year > nowYear + 50) year -= 100;
  return year;
}
