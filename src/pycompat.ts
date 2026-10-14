/**
 * Python-compatible text helpers for ports that must produce the same bytes
 * as the Python SDK (``beakr_sdk.amr``): ``json.dumps`` formatting, ``str()``
 * of a JSON value, truthiness, and code-point string ordering.
 *
 * Known, documented limits: a JSON number that Python parsed as a float but
 * whose value is integral (``1.0``) prints as an integer here, because
 * ``JSON.parse`` cannot tell ``1.0`` from ``1``; object keys that look like
 * array indices keep JavaScript's ordering, not insertion order.
 */

/** Python's ``str.isspace`` characters, which ``\s`` means in a Python ``re`` pattern. */
export const PY_WHITESPACE =
  "\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

/** Python ``bool(value)`` for a JSON value. */
export function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Map) return value.size > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

/** ``isinstance(value, int)`` for a JSON value (``bool`` counts, as in Python). */
export function pyIsInt(value: unknown): value is number | boolean {
  return typeof value === "boolean" || (typeof value === "number" && Number.isInteger(value));
}

export function pyIntValue(value: number | boolean): number {
  return typeof value === "boolean" ? (value ? 1 : 0) : value;
}

/** ``repr(float)`` / ``str(int)`` for a JSON number. */
export function pyNumber(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "Infinity";
  if (value === -Infinity) return "-Infinity";
  if (Number.isInteger(value)) {
    return Math.abs(value) < 1e21 ? String(value) : BigInt(value).toString();
  }
  const [mantissa, exponentText] = value.toExponential().split("e");
  const exponent = Number(exponentText);
  if (exponent < -4 || exponent >= 16) {
    const sign = exponent < 0 ? "-" : "+";
    return `${mantissa}e${sign}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  return String(value);
}

function pyStringRepr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\\") out += "\\\\";
    else if (char === quote) out += `\\${quote}`;
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += char;
  }
  return `${quote}${out}${quote}`;
}

function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return pyNumber(value);
  if (typeof value === "string") return pyStringRepr(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return `{${entries.map(([k, v]) => `${pyStringRepr(k)}: ${pyRepr(v)}`).join(", ")}}`;
  }
  return String(value);
}

/** Python ``str(value)`` for a JSON value (containers use a best-effort ``repr``). */
export function pyStr(value: unknown): string {
  if (typeof value === "string") return value;
  return pyRepr(value);
}

/** Order two strings by Unicode code point, as Python compares ``str``. */
export function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i]!.codePointAt(0) ?? 0) - (right[i]!.codePointAt(0) ?? 0);
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}

/** Order two tuples of strings element by element, as Python compares tuples. */
export function compareTuples(a: readonly string[], b: readonly string[]): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const diff = compareCodePoints(a[i]!, b[i]!);
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}

export interface DumpsOptions {
  /** ``indent=``: pretty-print with this many spaces (Python then uses "," between items). */
  indent?: number;
  /** ``ensure_ascii=`` (Python's default is true). */
  ensureAscii?: boolean;
  /** ``sort_keys=`` */
  sortKeys?: boolean;
}

const SHORT_ESCAPES: Record<string, string> = {
  '"': '\\"',
  "\\": "\\\\",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\b": "\\b",
  "\f": "\\f",
};

function hex4(code: number): string {
  return `\\u${code.toString(16).padStart(4, "0")}`;
}

function dumpString(text: string, ensureAscii: boolean): string {
  let out = '"';
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    const code = text.charCodeAt(i);
    const short = SHORT_ESCAPES[char];
    if (short !== undefined) out += short;
    else if (code < 0x20) out += hex4(code);
    // ensure_ascii escapes everything outside ' '..'~', as UTF-16 code units.
    else if (ensureAscii && code > 0x7e) out += hex4(code);
    else out += char;
  }
  return `${out}"`;
}

/** ``json.dumps(value, ...)`` with Python's default formatting. ``Map`` keeps insertion order. */
export function pyJsonDumps(value: unknown, options: DumpsOptions = {}): string {
  const ensureAscii = options.ensureAscii ?? true;
  const indent = options.indent;
  const itemSeparator = indent === undefined ? ", " : ",";
  const render = (node: unknown, level: number): string => {
    if (node === null || node === undefined) return "null";
    if (node === true) return "true";
    if (node === false) return "false";
    if (typeof node === "number") return pyNumber(node);
    if (typeof node === "string") return dumpString(node, ensureAscii);
    const pad = indent === undefined ? "" : "\n" + " ".repeat(indent * (level + 1));
    const closePad = indent === undefined ? "" : "\n" + " ".repeat(indent * level);
    if (Array.isArray(node)) {
      if (node.length === 0) return "[]";
      return `[${pad}${node.map((item) => render(item, level + 1)).join(itemSeparator + pad)}${closePad}]`;
    }
    let entries: [string, unknown][] =
      node instanceof Map
        ? [...(node as Map<string, unknown>).entries()]
        : Object.entries(node as Record<string, unknown>);
    if (options.sortKeys) entries = [...entries].sort(([a], [b]) => compareCodePoints(a, b));
    if (entries.length === 0) return "{}";
    const items = entries.map(
      ([key, item]) => `${dumpString(key, ensureAscii)}: ${render(item, level + 1)}`,
    );
    return `{${pad}${items.join(itemSeparator + pad)}${closePad}}`;
  };
  return render(value, 0);
}

/** ``datetime.now(timezone.utc).isoformat(timespec="seconds")`` */
export function utcNowSeconds(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, 19)}+00:00`;
}
