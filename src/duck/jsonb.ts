/**
 * A `jsonb` AS POSTGRES WRITES IT (`jsonb_out`): DuckDB's JSON is the text it was given, Postgres's jsonb is a parsed
 * value written back canonically — an object's keys sorted (shorter first, then by bytes, as `lengthCompareJsonbString`
 * orders them) with a duplicate key's LAST value kept, `", "` between members and `": "` after a key, a number written
 * as `numeric_out` writes it (`1e2` is `100`, `2.50` stays `2.50`, `-0` is `0`), a string's escapes as `escape_json`
 * writes them (`é` becomes the character; `"`, `\`, and control characters escaped). The copy stores a jsonb
 * column's text as the source sent it — already canonical — so this matters for a value a statement BUILDS
 * (`'{"b":1,"a":2}'::jsonb`, `jsonb_build_object`, `->` of a literal).
 */
import { numericText, parseNumeric } from "../lib/pg-numeric.ts";

/** a parsed JSON value, with where its text is in the document (`start` … `end`): json's `->` answers that text */
export type Json = ({ t: "null" } | { t: "bool"; v: boolean } | { t: "num"; text: string } | { t: "str"; v: string } | { t: "arr"; v: Json[] } | { t: "obj"; v: Array<[string, Json]> })
  & { start: number; end: number };
type Bare = Json extends infer J ? J extends Json ? Omit<J, "start" | "end"> : never : never;

/** Parses JSON keeping every number's text (JSON.parse would round `0.1000000000000000055511` and drop `2.50`'s zero). */
export function parseJson(text: string): Json {
  let i = 0;
  const ws = (): void => { while (i < text.length && " \t\n\r".includes(text[i]!)) i++; };
  const fail = (what: string): never => { throw new Error(`invalid input syntax for type json: ${what} at offset ${i}`); };
  const str = (): string => {
    i++;
    let out = "";
    for (;;) {
      const c = text[i++];
      if (c === undefined) return fail("a string is not closed");
      if (c === '"') return out;
      if (c !== "\\") { out += c; continue; }
      const e = text[i++];
      switch (e) {
        case '"': case "\\": case "/": out += e; break;
        case "b": out += "\b"; break; case "f": out += "\f"; break; case "n": out += "\n"; break; case "r": out += "\r"; break; case "t": out += "\t"; break;
        case "u": {
          const hex = text.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return fail("a \\u escape needs four hex digits");
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
          break;
        }
        default: return fail(`unknown escape \\${e ?? ""}`);
      }
    }
  };
  const value = (): Json => {
    ws();
    const start = i;
    const v = bare();
    return { ...v, start, end: i } as Json;
  };
  const bare = (): Bare => {
    const c = text[i];
    if (c === "{") {
      i++;
      const members: Array<[string, Json]> = [];
      ws();
      if (text[i] === "}") { i++; return { t: "obj", v: members }; }
      for (;;) {
        ws();
        if (text[i] !== '"') return fail("an object key must be a string");
        const k = str();
        ws();
        if (text[i++] !== ":") return fail("a key must be followed by ':'");
        members.push([k, value()]);
        ws();
        const sep = text[i++];
        if (sep === "}") return { t: "obj", v: members };
        if (sep !== ",") return fail("expected ',' or '}'");
      }
    }
    if (c === "[") {
      i++;
      const items: Json[] = [];
      ws();
      if (text[i] === "]") { i++; return { t: "arr", v: items }; }
      for (;;) {
        items.push(value());
        ws();
        const sep = text[i++];
        if (sep === "]") return { t: "arr", v: items };
        if (sep !== ",") return fail("expected ',' or ']'");
      }
    }
    if (c === '"') return { t: "str", v: str() };
    for (const [word, v] of [["true", { t: "bool", v: true }], ["false", { t: "bool", v: false }], ["null", { t: "null" }]] as Array<[string, Bare]>) {
      if (text.startsWith(word, i)) { i += word.length; return v; }
    }
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if (m === null) return fail("not a JSON value");
    i += m[0].length;
    return { t: "num", text: m[0] };
  };
  const v = value();
  ws();
  if (i < text.length) fail("text after the value");
  return v;
}

/** a character `quoteJson` writes otherwise than itself: `"`, `\` and the control characters */
const NEEDS_ESCAPE = /["\\\u0000-\u001f]/;
/** `escape_json`: a string as Postgres's json output quotes it */
export function quoteJson(s: string): string {
  // nothing to escape (most strings): quoted whole, never a character at a time
  if (!NEEDS_ESCAPE.test(s)) return `"${s}"`;
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

/** jsonb's key order: shorter first, then by the UTF-8 bytes (lengthCompareJsonbStringValue) */
function keyOrder(a: string, b: string): number {
  const x = Buffer.from(a, "utf8"), y = Buffer.from(b, "utf8");
  return x.length - y.length || Buffer.compare(x, y);
}

/** an object's pairs as jsonb stores them, in its key order: a key held twice keeps its LAST value
 *  (uniqueifyJsonbObject). What jsonb writes and what its order compares (src/duck/jsonb-order.ts) both read it. */
export function storedPairs(members: ReadonlyArray<[string, Json]>): Array<[string, Json]> {
  const last = new Map<string, Json>();
  for (const [k, x] of members) last.set(k, x);
  return [...last.keys()].sort(keyOrder).map((k) => [k, last.get(k)!]);
}

/** a parsed value as jsonb writes it */
export function writeJson(v: Json): string {
  switch (v.t) {
    case "null": return "null";
    case "bool": return v.v ? "true" : "false";
    case "num": return numericText(parseNumeric(v.text));
    case "str": return quoteJson(v.v);
    case "arr": return `[${v.v.map(writeJson).join(", ")}]`;
    case "obj": return `{${storedPairs(v.v).map(([k, x]) => `${quoteJson(k)}: ${writeJson(x)}`).join(", ")}}`;
  }
}

/** A JSON text as Postgres's jsonb writes it; throws a json syntax error for a text that is no JSON. */
export function jsonbText(text: string): string {
  return fastJsonbText(text) ?? writeJson(parseJson(text));
}

/** a JSON string (skipped whole) or a number, as JSON's grammar writes them (`parseJson`'s number) */
const TOKENS = /"(?:[^"\\]|\\.)*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
const PLAIN_INTEGER = /^-?(?:0|[1-9]\d*)$/;
const ASCII = /^[\x00-\x7f]*$/;

/**
 * `jsonbText` BY V8'S OWN PARSER, about 15 times faster than `parseJson` (issue 461: a generated table's build writes
 * every jsonb it stores through it, 25 µs a 340-byte document the slow way, 40 s over 1 M rows): JSON.parse with each
 * number a double would not keep handed over as its text, then written as `writeJson` writes it — the keys in jsonb's order, a key held twice
 * kept once with its LAST value (as JSON.parse keeps it), `numeric_out`'s number text. Null where it does not answer
 * exactly what the slow path answers, which then answers: a text holding a `\u` escape (`\u0000` and a lone surrogate,
 * which jsonb refuses and JSON.parse reads), and a text JSON.parse refuses (the slow path says why in Postgres's words).
 * `tests/duck-jsonb-text.test.ts` holds the two to the same text over every shape.
 */
function fastJsonbText(text: string): string | null {
  if (text.includes("\\u")) return null;
  let v: unknown;
  try {
    // each number whose text a double would not keep (a point, an exponent, `-0`, past 2^53) handed to JSON.parse as a
    // string marked by a NUL, which no string of this text can hold (a raw NUL is no JSON, an escaped one goes the slow
    // way): JSON.parse's reviver with its source text was 3-5 times its cost
    v = JSON.parse(text.replace(TOKENS, (m) => m.charCodeAt(0) === 34 || (PLAIN_INTEGER.test(m) && m !== "-0" && Number.isSafeInteger(Number(m))) ? m : `"\\u0000${m}"`));
  } catch (e) {
    // not JSON to V8: the slow path reads it again and refuses it in Postgres's words (a tolerable failure, nothing changed)
    if (e instanceof SyntaxError) return null;
    throw e;
  }
  try { return fastWrite(v); } catch (e) {
    // a marked number where JSON allows no number (a key: `{1.5: 2}` is no JSON): the slow path refuses it in Postgres's words
    if (e === NOT_JSON) return null;
    throw e;
  }
}

/** thrown by `fastWrite` where the marked text was never JSON: a number the marking turned into a string stands as a key */
const NOT_JSON = new Error("a marked number in a key's place");

function fastWrite(v: unknown): string {
  if (v === null) return "null";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v.charCodeAt(0) === 0 ? numericText(parseNumeric(v.slice(1))) : quoteJson(v);
  if (Array.isArray(v)) return `[${v.map(fastWrite).join(", ")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  // a key no JSON string of this text can start with (`fastJsonbText`): a number marked in a key's place, which is no JSON
  if (keys.some((k) => k.charCodeAt(0) === 0)) throw NOT_JSON;
  // jsonb's order (`keyOrder`): by UTF-8 length, then bytes, which for ASCII keys is the string's length and its order
  if (keys.every((k) => ASCII.test(k))) keys.sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  else keys.sort(keyOrder);
  return `{${keys.map((k) => `${quoteJson(k)}: ${fastWrite(o[k])}`).join(", ")}}`;
}
