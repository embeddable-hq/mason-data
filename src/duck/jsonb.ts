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

/** `escape_json`: a string as Postgres's json output quotes it */
export function quoteJson(s: string): string {
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
  return writeJson(parseJson(text));
}
