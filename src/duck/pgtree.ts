/**
 * POSTGRES'S OWN ANALYSIS OF A STATEMENT, READ (docs/DESIGN.md "Postgres decides, DuckDB computes"). The
 * catalog Postgres (src/api/postgres/catalog.ts) holds every copied table under its source types; with
 * `debug_print_parse` on it logs the ANALYSED query tree of a statement it parses — every expression with the type
 * Postgres resolved for it (the operator it chose, the implicit casts it inserted, an aggregate's result type) and the
 * offset into the text it came from. This module reads that tree (Postgres's `outfuncs.c` node format) and indexes it
 * by offset, so the rewrite (src/duck/rewrite.ts) knows, for each node of the RAW parse tree it rewrites, what
 * Postgres made of it: `/` over a `sum(bigint)` is a numeric division, `round(x)` of a double precision is `rint`, a
 * text sort key sorts by the database's collation.
 *
 * The format: `{NODE :field value …}`; a value is a node, a list `( … )` (of nodes or of values; `(b …)` a bitmapset,
 * `(o …)` OIDs, `(i …)` ints), `<>` for NULL, a quoted string, a bare token (outToken backslash-escapes the
 * characters that would end one), or a datum `N [ b b … ]` (a Const's value).
 */

import { constantExpression } from "./constant-key.ts";

export type TreeValue = TreeNode | TreeValue[] | string | null;
export interface TreeNode { readonly _node: string; readonly [field: string]: TreeValue }

/**
 * THE LOG'S ONE GRAMMAR (issue 956): the analysed tree as `debug_print_parse` logs it (the DETAIL's bytes), read with
 * Postgres's line wrapping undone, so every reader of the tree gets each name exactly as written.
 *
 * Postgres writes the tree (nodeToString) and then wraps it (`format_node_dump`, src/backend/nodes/print.c), counting
 * BYTES, even with `debug_pretty_print = off`. A line takes the next 78 bytes. If the byte after them is a space, that
 * space becomes the line break. Otherwise the last space among the line's bytes 1 to 77 becomes the break, and what
 * follows it starts the next line. With no such space, a line break is inserted after the 78 bytes, inside a token.
 * Every line, the last one too, ends in a line break.
 *
 * The space Postgres breaks at can be a name's own: outToken writes a space in a name as `\ `, so a break there leaves
 * `\` and a line break, which is just how Postgres writes a line break that IS in the name. Read as text, `meta → n`
 * came back as `meta\n→ n`, and the rewrite could not find the column by its name (a numeric's exact value lost). So the
 * bytes are not read line by line: every reading of the line breaks (a space, an inserted break, the end, or a name's
 * own line break where it is escaped) is wrapped again by Postgres's own rule, and only a reading that gives back the
 * very same bytes is kept. A break inside a run of 78 bytes with no space may have been a space too: a space read
 * between two halves of a quoted name or a field's value does not parse (outToken escapes every space it writes), so
 * the parse decides. A name's own line break that can trade places with a wrapped space is told by the names the
 * statement writes, and then by the catalog's columns (analyze.ts). One reading must be left. Where more are, Mason refuses by name (`name-unreadable`), and never
 * guesses.
 */
export function readParseLog(detail: Uint8Array, written: ReadonlySet<string> = new Set()): TreeValue {
  const trees: TreeValue[] = [];
  let failure: unknown = null;
  const read = unwrapNodeDump(detail);
  // every parse reads the whole log: past a few, the work is refused rather than done (a statement of many names of
  // line breaks once took 30 s on the listener's thread)
  if (read.reduce((n, r) => n + r.spaces.length + 1, 0) > MAX_PARSES) throw new UnreadableNames();
  for (const r of read) {
    // each break inside a run of 78 bytes with no space was a space, or was inserted: each choice is its own (what
    // follows is the same either way). A reading with spaces at the sites `combo` names, parsed:
    const parsed = (combo: (k: number) => boolean): { tree: TreeValue } | { error: unknown; at: number } => {
      const parts: Uint8Array[] = [];
      let from = 0;
      r.spaces.forEach((at, k) => { if (combo(k)) { parts.push(r.text.subarray(from, at), Buffer.from(" ")); from = at; } });
      parts.push(r.text.subarray(from));
      try { return { tree: parseTree(Buffer.concat(parts).toString("utf8")) }; }
      catch (e) { return { error: e, at: e instanceof TreeSyntaxError ? e.at : Infinity }; }
    };
    // Each site read as inserted, then each one alone as a space. Where every single space fails to parse before the
    // next site, every reading with spaces fails at its first one just so, as all before it is the same: the one
    // with none is the only one. Otherwise every combination is parsed, up to a bound past which none is guessed
    const none = parsed(() => false);
    const decided = r.spaces.every((_, k) => {
      const one = parsed((j) => j === k);
      return !("tree" in one) && one.at < (r.spaces[k + 1] ?? Infinity) + 1;
    });
    const readings = decided ? [none] : r.spaces.length > MAX_INSIDE_TOKEN ? null
      : Array.from({ length: 2 ** r.spaces.length }, (_, combo) => parsed((k) => (combo & (1 << k)) !== 0));
    if (readings === null) throw new UnreadableNames();
    // a reading that does not parse is not what Postgres wrote: the next is tried, and the error kept for the report
    for (const x of readings) { if ("tree" in x) trees.push(x.tree); else failure = x.error; }
  }
  if (trees.length === 1) return trees[0]!;
  if (trees.length === 0) throw failure ?? new Error("the catalog Postgres's parse tree: its log's line breaks can be read no way: report it");
  // A name's own line break near a space in a name can trade places with the break Postgres wrapped at, and the bytes
  // are the same either way (`line\ break\` + LF + `here` is `line break\nhere` or `line\nbreak here`). Such a name
  // is told by the statement: a reading is kept only if each name it holds with a line break is one the statement writes
  const plausible = trees.filter((t) => namesWithLineBreak(t).every((n) => written.has(n)));
  if (plausible.length === 1) return plausible[0]!;
  throw new UnreadableNames([...new Set(trees.flatMap(relationsOf))]);
}

/** a parse tree's log that more than one tree could have been wrapped into, or past the fixed work its reading may take:
 *  a name with a line break beside a space that the names given do not tell, more readings, parses or search steps
 *  than the bounds below, or more breaks inside tokens than single readings settle (Mason gap `name-unreadable`) */
export class UnreadableNames extends Error {
  /** the relations (pg_class OIDs) the readings read, whose columns' names may tell them apart */
  readonly relations: number[];
  constructor(relations: number[] = []) { super("the catalog Postgres's parse tree holds a name that Mason cannot read back"); this.relations = relations; }
}

/** every relation a tree reads (a RANGETBLENTRY's relid) */
function relationsOf(v: TreeValue): number[] {
  if (v === null || typeof v === "string") return [];
  if (Array.isArray(v)) return v.flatMap(relationsOf);
  const own = v._node === "RANGETBLENTRY" && typeof v.relid === "string" && /^[1-9]\d*$/.test(v.relid) ? [Number(v.relid)] : [];
  return [...own, ...Object.entries(v).flatMap(([k, x]) => k === "_node" ? [] : relationsOf(x))];
}

/** the most breaks inside a token whose every combination one reading of a log is parsed with (each doubles the
 *  parses), the most readings, and the most parses of a log (a statement's every name with a space is one reading and
 *  one parse) */
const MAX_INSIDE_TOKEN = 4, MAX_READINGS = 16, MAX_PARSES = 24;
/** the search's steps past one a line: a FIXED bound for each statement, so its work is the log's length and no more */
const EXTRA_STEPS = 2000;

/** every string of a tree that holds a line break: only a name can, as the log's breaks are undone */
function namesWithLineBreak(v: TreeValue): string[] {
  if (v === null) return [];
  if (typeof v === "string") return v.includes("\n") ? [v] : [];
  if (Array.isArray(v)) return v.flatMap(namesWithLineBreak);
  return Object.entries(v).flatMap(([k, x]) => k === "_node" ? [] : namesWithLineBreak(x));
}

const LINE = 78, LF = 10, SPACE = 32, BACKSLASH = 92;

/** format_node_dump's choice for the line of `s` starting at `at`: its length and where the next line starts, or null
 *  where the text ends within the line. `length` is the whole text's, or Infinity while more than this line is known. */
function pgLineEnd(s: Uint8Array, at: number, length: number): { length: number; next: number } | null {
  if (length - at <= LINE) return null;
  if (s[at + LINE] === SPACE) return { length: LINE, next: at + LINE + 1 };
  for (let k = LINE - 1; k > 0; k--) if (s[at + k] === SPACE) return { length: k, next: at + k + 1 };
  return { length: LINE, next: at + LINE };
}

/**
 * Every text Postgres could have wrapped into `wrapped` (one, unless a name holds a line break or a run of 78 bytes has
 * no space), each with the places a break inside such a run may have been a space. A depth-first search, line by line, each line's choice checked by Postgres's own rule as soon as the 79
 * bytes it reads are known, so a wrong choice dies within two lines and the search is linear in the log.
 */
export function unwrapNodeDump(wrapped: Uint8Array): Array<{ text: Uint8Array; spaces: number[] }> {
  // the DETAIL as sent ends in the last line's break; one without it is read as if it had it
  const o = wrapped.length > 0 && wrapped[wrapped.length - 1] === LF ? Buffer.from(wrapped) : Buffer.concat([wrapped, Buffer.from([LF])]);
  const s = Buffer.alloc(o.length);
  // each line chosen, in the text's coordinates: where it starts, how long it is, where the next starts (-1: the end)
  const starts: number[] = [], lengths: number[] = [], nexts: number[] = [];
  // "either": a break inside 78 bytes with no space, before a byte that is no space, was a space or was inserted;
  // read as inserted, with where the space would go kept (`spaces`)
  type Choice = { e: number; kind: "space" | "either" | "end" };
  type Frame = { at: number; sLen: number; lines: number; checked: number; spaces: number; choices: Choice[]; next: number };
  const spaces: number[] = [];
  /** whether the text read so far escapes its byte at `e` (an odd run of backslashes before it), as outToken escapes
   *  every line break of a name: one that is not is never the text's own */
  const escapedInText = (e: number): boolean => { let n = 0; for (let k = e - 1; k >= 0 && s[k] === BACKSLASH; k--) n++; return n % 2 === 1; };
  /** the lines whose 79 bytes are known, held to Postgres's rule; false where one breaks elsewhere */
  const holds = (from: number, sLen: number, complete: boolean): { ok: boolean; checked: number } => {
    let i = from;
    for (; i < starts.length; i++) {
      if (!complete && sLen < starts[i]! + LINE + 1) break;
      const r = pgLineEnd(s, starts[i]!, complete ? sLen : Infinity);
      if (r === null ? nexts[i] !== -1 : r.length !== lengths[i] || r.next !== nexts[i]) return { ok: false, checked: i };
    }
    return { ok: true, checked: i };
  };
  /** whether a line break at `e` of the line starting at `at` can be the text's own: escaped by the backslashes before
   *  it, in this line and, where the line starts with them, at the end of the text read so far (`sLen`) */
  const escapable = (at: number, e: number, sLen: number): boolean => {
    let n = 0, k = e - 1;
    for (; k >= at && o[k] === BACKSLASH; k--) n++;
    if (k < at) for (let j = sLen - 1; j >= 0 && s[j] === BACKSLASH; j--) n++;
    return n % 2 === 1;
  };
  const choicesAt = (at: number, sLen: number): Choice[] => {
    const out: Choice[] = [];
    for (let e = at + 1; e <= Math.min(at + LINE, o.length - 1); e++) {
      if (o[e] !== LF) continue;
      if (e === o.length - 1) { out.push({ e, kind: "end" }); break; }
      const inside = e - at === LINE && o[e + 1] !== SPACE && !o.subarray(at + 1, e).includes(SPACE);
      out.push({ e, kind: inside ? "either" : "space" });
      // a line break no backslash escapes is never the text's own, so the line ends there at the latest
      if (!escapable(at, e, sLen)) break;
    }
    return out;
  };
  const found: Array<{ text: Uint8Array; spaces: number[] }> = [];
  const stack: Frame[] = [{ at: 0, sLen: 0, lines: 0, checked: 0, spaces: 0, choices: choicesAt(0, 0), next: 0 }];
  let budget = o.reduce((n, b) => b === LF ? n + 1 : n, 0) + EXTRA_STEPS;
  while (stack.length > 0) {
    // past the bound, the readings are too many to tell apart: refused by name, never one guessed
    if (--budget < 0 || found.length > MAX_READINGS) throw new UnreadableNames();
    const f = stack[stack.length - 1]!;
    starts.length = lengths.length = nexts.length = f.lines;
    spaces.length = f.spaces;
    const c = f.choices[f.next++];
    if (c === undefined) { stack.pop(); continue; }
    let sLen = f.sLen;
    o.copy(s, sLen, f.at, c.e);
    const start = sLen, length = c.e - f.at;
    sLen += length;
    if (c.kind === "space") s[sLen++] = SPACE;
    if (c.kind === "either") spaces.push(sLen);
    starts.push(start); lengths.push(length); nexts.push(c.kind === "end" ? -1 : sLen);
    // every line break this reading keeps as the text's own (the line's first byte included) is escaped in the text
    let own = true;
    for (let k = start; k < start + length && own; k++) if (s[k] === LF && !escapedInText(k)) own = false;
    if (!own) continue;
    const complete = c.kind === "end";
    const held = holds(f.checked, sLen, complete);
    if (!held.ok) continue;
    if (complete) { found.push({ text: Buffer.from(s.subarray(0, sLen)), spaces: [...spaces] }); continue; }
    stack.push({ at: c.e + 1, sLen, lines: starts.length, checked: held.checked, spaces: spaces.length, choices: choicesAt(c.e + 1, sLen), next: 0 });
  }
  return found;
}

/** a text the node format does not read, and the byte where it went wrong */
class TreeSyntaxError extends Error {
  readonly at: number;
  constructor(message: string, at: number) { super(message); this.at = at; }
}

/** pg_strtok's (read.c) whitespace between tokens: a space, a line break or a tab, and nothing else. Every other
 *  character (a no-break space, U+3000, a BOM, a carriage return, a form feed) is part of a name, which outToken writes
 *  unescaped */
const BETWEEN = (c: string): boolean => c === " " || c === "\n" || c === "\t";
/** where pg_strtok ends a token: its whitespace, or a parenthesis or a brace */
const ENDS_TOKEN = (c: string): boolean => BETWEEN(c) || c === "(" || c === ")" || c === "{" || c === "}";

/** Parses one node-format text (outfuncs.c's nodeToString), tokens split as pg_strtok splits them, or throws with the
 *  offset where it went wrong. A space or line break inside a quoted name that is not escaped is no text outToken
 *  writes, and is refused as such. */
function parseTree(text: string): TreeValue {
  let i = 0;
  const ws = (): void => { while (i < text.length && BETWEEN(text[i]!)) i++; };
  const fail = (what: string): never => { throw new TreeSyntaxError(`the catalog Postgres's parse tree: ${what} at offset ${i}: ${JSON.stringify(text.slice(i, i + 40))}`, Buffer.byteLength(text.slice(0, i))); };
  const bare = (): string => {
    let s = "";
    while (i < text.length && !ENDS_TOKEN(text[i]!)) {
      if (text[i] === "\\" && i + 1 < text.length) { s += text[i + 1]; i += 2; continue; }
      s += text[i++];
    }
    return s;
  };
  const value = (): TreeValue => {
    ws();
    const c = text[i];
    if (c === undefined) return fail("the text ends inside a value");
    if (c === "{") return node();
    if (c === "(") {
      i++;
      const out: TreeValue[] = [];
      for (;;) {
        ws();
        if (text[i] === ")") { i++; return out; }
        if (i >= text.length) return fail("a list is not closed");
        out.push(value());
      }
    }
    if (c === "<" && text[i + 1] === ">") { i += 2; return null; }
    if (c === '"') {
      // pg_strtok's token (read.c): it ends where any token ends, and is a string when its last character is a quote
      // that is not escaped (a quote inside a name is not escaped: `"a"b"`)
      i++;
      let s = "", closed = false;
      while (i < text.length && !ENDS_TOKEN(text[i]!)) {
        if (text[i] === "\\" && i + 1 < text.length) { s += text[i + 1]; i += 2; closed = false; continue; }
        closed = text[i] === '"';
        s += text[i++];
      }
      if (!closed) fail("a quoted name that does not end in a quote");
      return s.slice(0, -1);
    }
    const tok = bare();
    // a datum: its length, then its bytes in brackets
    const save = i;
    ws();
    if (text[i] === "[") {
      const end = text.indexOf("]", i);
      if (end < 0) return fail("a datum is not closed");
      const datum = `${tok} ${text.slice(i, end + 1)}`;
      i = end + 1;
      return datum;
    }
    i = save;
    return tok;
  };
  const node = (): TreeNode => {
    i++; // {
    ws();
    const name = bare();
    const out: Record<string, TreeValue> = { _node: name };
    for (;;) {
      ws();
      if (text[i] === "}") { i++; return out as TreeNode; }
      if (text[i] !== ":") return fail(`a field of ${name} must start with ':'`);
      i++;
      const field = bare();
      out[field] = value();
    }
  };
  const v = value();
  ws();
  if (i < text.length) fail("text after the tree");
  return v;
}

/** Postgres's first OID for an object not of its own (FirstNormalObjectId): below it, Postgres's catalog; past it, a
 *  table copied, a type an extension made, or what the catalog Postgres made itself (catalog.ts LATEST_SQL) */
export const FIRST_USER_OID = 16384;

const isNode = (v: TreeValue): v is TreeNode => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v: TreeValue | undefined): number | null => typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : null;

/** What Postgres made of one expression: its node, its result type (OID) and typmod, its arguments' types, and the
 *  operator, function or aggregate it resolved to. */
export interface Typed {
  node: string;
  type: number;
  typmod: number;
  args: Array<{ type: number; typmod: number }>;
  /** OPEXPR's opno, FUNCEXPR's funcid, AGGREF's aggfnoid, WINDOWFUNC's winfnoid */
  oid: number | null;
  /** FUNCEXPR's funcformat: 0 a call, 1 an explicit cast, 2 an implicit cast, 3 SQL syntax (EXTRACT …) */
  format: number | null;
  /** the collation the expression's result carries (0 for none), and the one its inputs were compared under */
  collation: number;
  inputCollation: number;
  /** a row comparison's (ROWCOMPAREEXPR) collation of each column it compares, in order */
  inputCollations?: number[];
  /** a row comparison's type of each column it compares, as Postgres coerced both sides to it (the left's: `('b', 3)`
   *  beside a char(4) is compared as a char(4)) */
  inputTypes?: number[];
  /** an ordered-set aggregate's (AGGREF) direct arguments' types, as Postgres resolved the call: percentile_disc's
   *  fraction is float8, or float8[] for the overload that answers an array */
  directArgs?: Array<{ type: number; typmod: number }>;
  /** a VAR's query level: 0 this query's own column, 1 the query around it (a correlated subquery's) */
  levelsUp: number | null;
  /** a GROUPINGFUNC's query level and the GROUP BY entries it reads (`Grouping`) */
  grouping?: Grouping;
  /** a WINDOWFUNC's WINDOW clause (`Keys.windows`' winref) */
  winref?: number | null;
  /** a CONST's value as Postgres parsed it, its bytes (`constvalue`: `8 [ 0 -48 70 … ]`); null when NULL or not a CONST */
  datum: number[] | null;
  /** a text or varchar CONST's value as Postgres read it, null for its NULL; absent on anything else (`constText`) */
  text?: string | null;
  /** a text[] or varchar[] that is constant, as Postgres read it: a CONST's elements or an ARRAY[…] of constants, null
   *  for an element's NULL; null for the array's own NULL; absent on anything else (`constTextArray`) */
  textArray?: ReadonlyArray<string | null> | null;
  /** a VAR's FROM item by the name the query calls it (`u` in `FROM ua u`), when another FROM item of its query has a
   *  column of the same name but another case (`email` beside `"Email"`), its own or a subquery's it is read from: DuckDB binds names case-insensitively, so
   *  the bare name is ambiguous there and is qualified (src/duck/rewrite.ts) */
  qualifier: string | null;
  /** a VAR's column renamed (`t__mason_3`) where its FROM item — a subquery, a CTE — has another column of the same
   *  name but another case (`"T"` beside `t`), which DuckDB cannot tell apart: the item's columns are renamed alike
   *  (caseTwins) */
  renamed: string | null;
  /** a Const of the analysis (under a COLLATE): a sort key that orders nothing, by ONE reader (src/duck/constant-key.ts) */
  constant?: true;
  /** a VAR as DuckDB can name it: the FROM item it is read from and the column's name there (an alias list's); a merged
   *  column of a join by the join's name, or null for that of a join (or a VALUES, a subquery) with none, which only its
   *  bare name reads. A join's name hides what it joins, so a column of a named join is read by that name, and `twin`
   *  says the join has two of that name, which no name tells apart. What a `*` expands to has no text of its own to read
   *  this from. Absent for a set operation's output, which only its arm's column names */
  column?: { owner: string | null; name: string; twin?: true };
  /** a VAR read from a TABLE of its query's FROM (an RTE_RELATION): the catalog's OID of that table and the column's
   *  number in it — what a stored JSON path is found by (src/duck/kept.ts); absent for any other node, and for a column
   *  of a subquery, a CTE, a function or a join */
  relation?: { relid: number; attno: number };
  /** a VAR read from a FUNCTION of its query's FROM (an RTE_FUNCTION): the function's FROM name and the column's name
   *  there. A function of one column that is no row (`jsonb_array_elements(x) e`, its column `value`) is read whole
   *  by its FROM name alone (`e`), which Postgres analyses as that column (makeWholeRowVar): a one-part name that is
   *  not the column's is that whole row (src/duck/rewrite.ts) */
  functionColumn?: { alias: string; column: string };
  /** an AGGREF's arguments as its ORDER BY binds to them (`Keys`: `sorted` its ORDER BY, `distinct` its DISTINCT) */
  keys?: Keys;
  /** Postgres wrapped THIS expression in its implicit time→timetz cast (a FUNCEXPR of time_timetz, function 2047, its
   *  funcformat COERCE_IMPLICIT_CAST), which has no offset of its own and is listed nowhere: a time coerced beside a
   *  timetz (an operator's operand, a CASE or COALESCE arm, a function's argument, the value of a `CASE tm WHEN
   *  <timetz>` whose every WHEN casts it …), the ONE fact src/duck/rewrite.ts `coerceImplicit` reads (issue 167). Absent
   *  on everything else */
  implicitTimetz?: true;
  /** Postgres wrapped THIS char(n) expression in its implicit cast to text or varchar (a FUNCEXPR of text(bpchar),
   *  funcformat COERCE_IMPLICIT_CAST: the value without its trailing blanks), which has no offset of its own: a char(n)
   *  beside a text (an operator's or a function's argument, a CASE or NULLIF arm, a VALUES row of a text column …),
   *  the type it was cast to; src/duck/rewrite.ts `coerceImplicit` writes it (PR 674 class round r3). Absent on
   *  everything else */
  implicitText?: number;
  /** an OPEXPR's arguments' and a ROWCOMPAREEXPR's right arguments' subquery outputs (PARAM_SUBLINK, beneath any
   *  coercion), in order, each its own type as the subquery's analysis gave it; null where the argument holds none. The
   *  type of a SubLink's output column whatever the subquery's form (a set operation, VALUES, a *, TABLE) */
  params?: Array<{ type: number; typmod: number } | null>;
}

/**
 * THE KEYS OF A SORT, AS POSTGRES BOUND THEM (the class "an output not resolved to its column"): a SELECT's ORDER BY and
 * DISTINCT ON, or an aggregate's ORDER BY, over its target entries. A key equal to an entry by its ANALYSED expression
 * (findTargetlistEntrySQL99: `'1.5'::numeric` to `1.5::numeric AS v`) is that entry, and leaves no node at its own
 * offset; one equal to none is a junk entry of its own. Read by ONE resolver, `keysConstant` (src/duck/constant-key.ts).
 */
export interface Keys {
  /** each target entry, the junk ones too, in its list's order: whether the analysis made it a Const, the offset of its
   *  expression (null for none), the first entry whose analysed expression is equal (the one a key binds to), and
   *  whether it reads a column of its own query (a VAR outside a subquery), and whether it is an OUTPUT (no junk entry:
   *  the rewrite may add targets of its own after them, so its list's length cannot tell) */
  entries: Array<{ constant: boolean; at: number | null; first: number; reads: boolean; output: boolean; ref: number | null; groupings: Grouping[] }>;
  /** the entries the ORDER BY sorts by, in order: Postgres drops a key whose entry an earlier key sorts by */
  sorted: number[];
  /** the entries a DISTINCT ON (an aggregate's DISTINCT) compares, a set: ORDER BY's first, then the rest */
  distinct: number[];
  /** each WINDOW clause of the query (a named one by its name; an OVER's own by its `winref`, which its WINDOWFUNC
   *  carries), the entries its PARTITION BY and its ORDER BY read, in order */
  windows: Array<{ name: string | null; winref: number | null; partition: number[]; order: number[] }>;
}

/** A GROUPING(…) as Postgres analysed it (GROUPINGFUNC): the query it belongs to, `levelsUp` queries out from the one
 *  holding it (its arguments' Var level), and the GROUP BY entries each argument reads, by their `ressortgroupref`
 *  (`refs`, matched by Postgres's equality: finalize_grouping_exprs) */
export interface Grouping { levelsUp: number; refs: number[] }

/** the integers of an integer list (`(i 2 3)`) */
const ints = (v: TreeValue | undefined): number[] => Array.isArray(v) ? v.map((x) => typeof x === "string" ? num(x) : null).filter((x): x is number => x !== null) : [];

/** each GROUPINGFUNC of an analysed expression, in the order a walk of it meets them, outside its subqueries */
function groupingsIn(v: TreeValue | undefined): Grouping[] {
  if (Array.isArray(v)) return v.flatMap(groupingsIn);
  if (v === undefined || !isNode(v) || v._node === "QUERY") return [];
  const own = v._node === "GROUPINGFUNC" ? [{ levelsUp: num(v.agglevelsup ?? null) ?? 0, refs: ints(v.refs) }] : [];
  return [...own, ...Object.entries(v).flatMap(([k, x]) => k === "_node" ? [] : groupingsIn(x))];
}

/** Keys: `targets` a TARGETENTRY list, `sort` and `distinct` SORTGROUPCLAUSE lists over it */
function keysOf(targets: TreeValue | undefined, sort: TreeValue | undefined, distinct: TreeValue | undefined, rtable: TreeNode[], windows?: TreeValue): Keys {
  const list = Array.isArray(targets) ? targets.filter(isNode) : [];
  // (a grouped key's entry is a VAR of the GROUP entry by the time the tree is printed; it was bound as what it groups)
  const exprs = list.map((t) => ungrouped(t.expr ?? null, rtable));
  const entries = exprs.map((e, i) => ({
    constant: constantExpression(e),
    at: isNode(e) ? num(e.location) : null,
    first: exprs.findIndex((o, j) => j <= i && sameExpression(o, e)),
    reads: readsVar(e),
    output: list[i]!.resjunk !== "true",
    ref: num(list[i]!.ressortgroupref ?? null),
    groupings: groupingsIn(list[i]!.expr ?? null),
  }));
  const refs = (v: TreeValue | undefined): number[] => (Array.isArray(v) ? v.filter(isNode) : []).map((c) => {
    const ref = num(c.tleSortGroupRef ?? null);
    return list.findIndex((t) => ref !== null && ref !== 0 && num(t.ressortgroupref ?? null) === ref);
  });
  const clauses = Array.isArray(windows) ? windows.filter(isNode) : [];
  return {
    entries, sorted: refs(sort), distinct: refs(distinct),
    windows: clauses.map((w) => ({ name: typeof w.name === "string" ? w.name : null, winref: num(w.winref ?? null), partition: refs(w.partitionClause), order: refs(w.orderClause) })),
  };
}

/** whether an analysed expression reads a column: a VAR outside a subquery's own QUERY */
function readsVar(v: TreeValue | undefined): boolean {
  if (Array.isArray(v)) return v.some(readsVar);
  if (v === undefined || !isNode(v) || v._node === "QUERY") return false;
  return v._node === "VAR" || Object.entries(v).some(([k, x]) => k !== "_node" && readsVar(x));
}

/** Postgres's equal() of two analysed expressions: alike in every field but an offset and a cast's form (`::` or an
 *  implicit cast, which its equal() ignores too: COMPARE_COERCIONFORM_FIELD) */
const IGNORED = new Set(["location", "funcformat", "relabelformat", "coerceformat", "convertformat", "row_format"]);
function sameExpression(a: TreeValue | undefined, b: TreeValue | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameExpression(x, b[i]));
  }
  if (a === undefined || b === undefined || !isNode(a) || !isNode(b)) return false;
  const ka = Object.keys(a).filter((k) => !IGNORED.has(k)), kb = Object.keys(b).filter((k) => !IGNORED.has(k));
  return ka.length === kb.length && ka.every((k) => sameExpression(a[k], b[k]));
}

/** a `constvalue`'s bytes: `<length> [ b0 b1 … ]`, each a signed byte */
export function datumBytes(v: TreeValue | undefined): number[] | null {
  if (typeof v !== "string") return null;
  const m = /^\s*\d+\s*\[([-\d\s]*)\]\s*$/.exec(v);
  return m ? m[1]!.trim().split(/\s+/).filter((x) => x !== "").map((x) => Number(x) & 255) : null;
}

const [TEXT, VARCHAR, TEXT_ARRAY, VARCHAR_ARRAY] = [25, 1043, 1009, 1015];
const int32 = (b: readonly number[], at: number): number => ((b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16) | ((b[at + 3] ?? 0) << 24)) >>> 0;

/** a varlena's text and the bytes it takes, in a datum's bytes at `at`; null for a form no constant is written in
 *  (compressed, external), which the caller reads as no constant */
function varlena(b: readonly number[], at: number): { text: string; size: number } | null {
  const first = b[at];
  if (first === undefined) return null;
  // a 1-byte header (low bit 1) holds its length, itself included, in the seven bits above; 0x01 is an external pointer
  const short = (first & 1) === 1;
  if (first === 1 || (!short && (first & 3) !== 0)) return null;
  const size = short ? first >>> 1 : int32(b, at) >>> 2, head = short ? 1 : 4;
  if (size < head || at + size > b.length) return null;
  return { text: Buffer.from(b.slice(at + head, at + size)).toString("utf8"), size };
}

/**
 * A text[] or varchar[] datum's elements as `array_in` read them (array.h: the varlena header, ndim, dataoffset,
 * elemtype, the dims and lower bounds, the null bitmap where dataoffset is set, then the elements, each aligned to 4
 * bytes; the catalog is little-endian). Null for what is not a plain array of at most one dimension.
 */
export function textArrayElements(b: readonly number[]): Array<string | null> | null {
  if (b.length < 16) return null;
  const ndim = int32(b, 4), offset = int32(b, 8), element = int32(b, 12);
  if (ndim > 1 || (element !== TEXT && element !== VARCHAR)) return null;
  if (ndim === 0) return [];
  if (b.length < 24) return null;
  const count = int32(b, 16), bitmap = 24;
  let at = offset !== 0 ? offset : 24;
  const out: Array<string | null> = [];
  for (let i = 0; i < count; i++) {
    if (offset !== 0 && (((b[bitmap + (i >> 3)] ?? 0) >> (i & 7)) & 1) === 0) { out.push(null); continue; }
    const v = varlena(b, at);
    if (v === null) return null;
    out.push(v.text);
    at = (at + v.size + 3) & ~3;
  }
  return out;
}

/** a CONST of text or varchar as Postgres read it; undefined for any other node */
function constText(v: TreeValue): string | null | undefined {
  if (!isNode(v) || v._node !== "CONST" || (num(v.consttype) !== TEXT && num(v.consttype) !== VARCHAR)) return undefined;
  if (v.constisnull === "true") return null;
  const b = datumBytes(v.constvalue);
  return (b === null ? null : varlena(b, 0))?.text;
}

/** a text[] or varchar[] that is constant, as Postgres read it; undefined for any other node */
function constTextArray(v: TreeNode): ReadonlyArray<string | null> | null | undefined {
  if (v._node === "CONST") {
    if (num(v.consttype) !== TEXT_ARRAY && num(v.consttype) !== VARCHAR_ARRAY) return undefined;
    if (v.constisnull === "true") return null;
    const b = datumBytes(v.constvalue);
    return (b === null ? null : textArrayElements(b)) ?? undefined;
  }
  if (v._node !== "ARRAYEXPR" || v.multidims === "true" || (num(v.array_typeid) !== TEXT_ARRAY && num(v.array_typeid) !== VARCHAR_ARRAY)) return undefined;
  const out: Array<string | null> = [];
  for (const e of Array.isArray(v.elements) ? v.elements : []) {
    const text = constText(e);
    if (text === undefined) return undefined;
    out.push(text);
  }
  return out;
}

const BOOL = 16;
/** The type an expression node yields: exprType (nodeFuncs.c), for the nodes a SELECT's expressions are made of. */
export function exprType(n: TreeNode): { type: number; typmod: number } | null {
  const t = (f: string, m?: string): { type: number; typmod: number } | null => {
    const v = num(n[f]);
    return v === null ? null : { type: v, typmod: m === undefined ? -1 : num(n[m]) ?? -1 };
  };
  switch (n._node) {
    case "VAR": return t("vartype", "vartypmod");
    case "CONST": return t("consttype", "consttypmod");
    case "PARAM": return t("paramtype", "paramtypmod");
    case "AGGREF": return t("aggtype");
    case "WINDOWFUNC": return t("wintype");
    case "GROUPINGFUNC": return { type: 23, typmod: -1 };
    case "FUNCEXPR": {
      const r = t("funcresulttype");
      // a length coercion (numeric(p, s), varchar(n)) carries its typmod as its second argument's constant
      if (r && num(n.funcformat) !== 0 && Array.isArray(n.args) && n.args.length >= 2 && isNode(n.args[1]!) && n.args[1]._node === "CONST") {
        const datum = n.args[1].constvalue;
        // the bytes, spaced as nodeToString writes them (the log's line breaks undone: readParseLog)
        const m = typeof datum === "string" ? /\[\s*(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s*\]/.exec(datum) : null;
        if (m) r.typmod = (Number(m[1]) & 255) | ((Number(m[2]) & 255) << 8) | ((Number(m[3]) & 255) << 16) | ((Number(m[4]) & 255) << 24);
      }
      return r;
    }
    case "OPEXPR": case "DISTINCTEXPR": case "NULLIFEXPR": return n._node === "DISTINCTEXPR" ? { type: BOOL, typmod: -1 } : t("opresulttype");
    case "SCALARARRAYOPEXPR": case "BOOLEXPR": case "NULLTEST": case "BOOLEANTEST": case "ROWCOMPAREEXPR": return { type: BOOL, typmod: -1 };
    case "RELABELTYPE": case "COERCEVIAIO": case "ARRAYCOERCEEXPR": case "COERCETODOMAIN": return t("resulttype", "resulttypmod");
    case "CASEEXPR": return t("casetype");
    case "COALESCEEXPR": return t("coalescetype");
    case "MINMAXEXPR": return t("minmaxtype");
    case "SQLVALUEFUNCTION": return t("type", "typmod");
    case "FIELDSELECT": return t("resulttype", "resulttypmod");
    case "SUBSCRIPTINGREF": return t("refrestype", "reftypmod");
    case "ARRAYEXPR": return t("array_typeid");
    case "ROWEXPR": return t("row_typeid");
    case "COLLATEEXPR": return Array.isArray(n.arg) ? null : isNode(n.arg ?? null) ? exprType(n.arg as TreeNode) : null;
    case "SUBLINK": {
      // an EXPR or ARRAY sublink's type is its subselect's first output column's
      const sub = n.subselect;
      if (!isNode(sub ?? null)) return null;
      const tl = (sub as TreeNode).targetList;
      const first = Array.isArray(tl) ? tl.find((e) => isNode(e) && e.resjunk !== "true") as TreeNode | undefined : undefined;
      const st = first && isNode(first.expr ?? null) ? exprType(first.expr as TreeNode) : null;
      const kind = num(n.subLinkType);
      return kind === 4 /* EXPR */ ? st : kind === 5 /* ARRAY */ ? null : { type: BOOL, typmod: -1 };
    }
    default: return null;
  }
}

const argsOf = (n: TreeNode): TreeValue[] => {
  if (Array.isArray(n.args)) return n.args;
  if (isNode(n.arg ?? null)) return [n.arg as TreeNode];
  return [];
};

/**
 * Every typed expression of the analysed tree, by the offset it came from — outermost first where several share one
 * (a cast and the coercion inside it). An implicit cast Postgres inserted has no offset of its own (-1) and is listed
 * only as its parent's argument type. AGGREF's arguments are its TARGETENTRY exprs.
 */
export function typesByLocation(tree: TreeValue): Map<number, Typed[]> {
  const out = new Map<number, Typed[]>();
  // the arguments Postgres wrapped in its implicit time→timetz cast (`Typed.implicitTimetz`)
  const asTimetz = new WeakSet<TreeNode>();
  // the char(n) arguments Postgres wrapped in its implicit cast to text or varchar (`Typed.implicitText`)
  const asText = new WeakMap<TreeNode, number>();
  // the range tables of the queries around the node being visited, innermost last
  const rtables: TreeNode[][] = [];
  const visit = (v: TreeValue): void => {
    if (Array.isArray(v)) { for (const x of v) visit(x); return; }
    if (!isNode(v)) return;
    if (v._node === "QUERY") {
      rtables.push(Array.isArray(v.rtable) ? v.rtable.filter(isNode) : []);
      try { for (const [k, x] of Object.entries(v)) if (k !== "_node") visit(x); } finally { rtables.pop(); }
      return;
    }
    // a row comparison has no offset of its own: it is found at its first left column's (`rowCompareAt`)
    const first = v._node === "ROWCOMPAREEXPR" && Array.isArray(v.largs) && isNode(v.largs[0] ?? null) ? v.largs[0] as TreeNode : null;
    const placed = (x: TreeNode): number | null => {
      const at = num(x.location ?? null);
      // (an implicit cast Postgres added has none of its own: its argument's)
      return (at === null || at < 0) && isNode(x.arg ?? null) ? placed(x.arg as TreeNode) : at;
    };
    const loc = first !== null ? placed(first) : num(v.location);
    const t = exprType(v);
    const wrapped = implicitTimetzArg(v);
    if (wrapped !== null) asTimetz.add(wrapped);
    const trimmed = implicitTextArg(v);
    if (trimmed !== null) asText.set(trimmed, exprType(v)!.type);
    if (loc !== null && loc >= 0 && t !== null) {
      const typed = typedOf(v, t, rtables);
      if (asTimetz.has(v)) typed.implicitTimetz = true;
      const text = asText.get(v);
      if (text !== undefined) typed.implicitText = text;
      const list = out.get(loc);
      if (list) list.push(typed); else out.set(loc, [typed]);
    }
    // a row compared with a subquery's rows is found at its SubLink's offset too: a grouped column's Var has none
    // (PR 674 class round r3: `(id, a) < ANY (…) … GROUP BY id` placed nothing at its first column)
    const test = v._node === "SUBLINK" && isNode(v.testexpr ?? null) ? v.testexpr as TreeNode : null;
    const at = num(v.location);
    if (test !== null && test._node === "ROWCOMPAREEXPR" && at !== null && at >= 0) {
      const typed = typedOf(test, { type: BOOL, typmod: -1 }, rtables);
      const list = out.get(at);
      if (list) list.push(typed); else out.set(at, [typed]);
    }
    for (const [k, x] of Object.entries(v)) if (k !== "_node") visit(x);
  };
  visit(tree);
  return out;
}

/** the argument of Postgres's IMPLICIT cast of a char(n) to a text or a varchar (a FUNCEXPR whose one argument is a
 *  bpchar and whose result a text or a varchar, COERCE_IMPLICIT_CAST: text(bpchar), which drops the trailing blanks),
 *  or null for any other node */
function implicitTextArg(v: TreeNode): TreeNode | null {
  if (v._node !== "FUNCEXPR" || num(v.funcformat ?? null) !== 2) return null;
  const to = num(v.funcresulttype ?? null);
  if (to !== 25 && to !== 1043) return null;
  const args = argsOf(v).filter(isNode);
  const a = args[0];
  return args.length === 1 && a !== undefined && a._node !== "CASETESTEXPR" && exprType(a)?.type === 1042 ? a : null;
}

/** a SubLink's output column (PARAM_SUBLINK) an argument holds, beneath any coercion, its type as the subquery gave it */
function sublinkParamOf(v: TreeValue): { type: number; typmod: number } | null {
  if (!isNode(v)) return null;
  if (v._node === "PARAM") return num(v.paramkind ?? null) === 2 ? exprType(v) : null;
  if (v._node === "FUNCEXPR" || v._node === "RELABELTYPE" || v._node === "COERCEVIAIO") {
    const args = v._node === "FUNCEXPR" ? argsOf(v).filter(isNode) : isNode(v.arg ?? null) ? [v.arg as TreeNode] : [];
    return args.length >= 1 ? sublinkParamOf(args[0]!) : null;
  }
  return null;
}

/** the argument of Postgres's IMPLICIT time→timetz cast (FUNCEXPR of time_timetz, function 2047, COERCE_IMPLICIT_CAST),
 *  or null for any other node: the one test of it (`typesByLocation`, `implicitTimetzCasts`) */
function implicitTimetzArg(v: TreeNode): TreeNode | null {
  // `CASE tm WHEN '12:30-05'::timetz …`: each WHEN compares a placeholder of the CASE's value (CaseTestExpr), which
  // Postgres casts in each: the CASE's own value is the one cast, where every WHEN casts it (`caseCasts`)
  if (v._node === "CASEEXPR" && isNode(v.arg ?? null)) { const c = caseCasts(v); return c.cast > 0 && c.cast === c.whens ? v.arg as TreeNode : null; }
  const a = timetzCastOf(v);
  return a !== null && a._node !== "CASETESTEXPR" ? a : null;
}
const timetzCastOf = (v: TreeValue | undefined): TreeNode | null => {
  if (v === undefined || !isNode(v) || v._node !== "FUNCEXPR" || num(v.funcid ?? null) !== 2047 || num(v.funcformat ?? null) !== 2) return null;
  const a = argsOf(v)[0];
  return a !== undefined && isNode(a) ? a : null;
};
/** a `CASE x WHEN …`'s WHENs, and how many of them cast its placeholder (x) to a timetz */
function caseCasts(v: TreeNode): { whens: number; cast: number } {
  const whens = (Array.isArray(v.args) ? v.args : []).filter(isNode);
  const cast = whens.filter((w) => { const e = w.expr ?? null; const first = isNode(e) ? argsOf(e)[0] : undefined; return timetzCastOf(first)?._node === "CASETESTEXPR"; }).length;
  return { whens: whens.length, cast };
}

/** how many implicit time→timetz casts Postgres's analysis holds, a CASE's WHENs that cast its value counted once:
 *  each must be written where its argument is (src/duck/rewrite.ts `coerceImplicit` counts what it wrote against this,
 *  and refuses the statement when one was not: a CASE whose WHENs cast its value in some and not others among them) */
export function implicitTimetzCasts(tree: TreeValue): number {
  let n = 0;
  const visit = (v: TreeValue): void => {
    if (Array.isArray(v)) { for (const x of v) visit(x); return; }
    if (!isNode(v)) return;
    const a = timetzCastOf(v);
    if (a !== null && a._node !== "CASETESTEXPR") n++;
    if (v._node === "CASEEXPR" && isNode(v.arg ?? null) && caseCasts(v).cast > 0) n++;
    for (const [k, x] of Object.entries(v)) if (k !== "_node") visit(x);
  };
  visit(tree);
  return n;
}

/** one expression of a query whose range tables are `rtables`, innermost last, as `Typed` says it */
function typedOf(v: TreeNode, t: { type: number; typmod: number }, rtables: TreeNode[][]): Typed {
  const raw = v._node === "AGGREF" || v._node === "WINDOWFUNC"
    ? argsOf(v).map((a) => isNode(a) && a._node === "TARGETENTRY" ? a.expr ?? null : a)
    : argsOf(v);
  const args = raw.filter(isNode).map((a) => exprType(a) ?? { type: 0, typmod: -1 });
  const typed: Typed = {
    node: v._node, type: t.type, typmod: t.typmod, args,
    oid: num(v.opno ?? v.funcid ?? v.aggfnoid ?? v.winfnoid ?? null),
    format: num(v.funcformat ?? null),
    collation: collationOf(v),
    inputCollation: num(v.inputcollid ?? null) ?? 0,
    levelsUp: v._node === "VAR" ? num(v.varlevelsup ?? null) : null,
    datum: v._node === "CONST" && v.constisnull !== "true" ? datumBytes(v.constvalue) : null,
    qualifier: v._node === "VAR" ? qualifierOf(v, rtables) : null,
    renamed: v._node === "VAR" ? renamedOf(v, rtables) : null,
  };
  if (constantExpression(v)) typed.constant = true;
  // a row comparison compares each column under its own collation (RowCompareExpr's inputcollids)
  if (v._node === "ROWCOMPAREEXPR" && Array.isArray(v.inputcollids)) typed.inputCollations = v.inputcollids.filter((x) => x !== "o").map((x) => typeof x === "string" ? num(x) ?? 0 : 0);
  if (v._node === "ROWCOMPAREEXPR" && Array.isArray(v.largs)) typed.inputTypes = v.largs.filter(isNode).map((a) => exprType(a)?.type ?? 0);
  // a SubLink's output columns, as the operator reads them (PR 674 class round r3)
  const outputs = v._node === "OPEXPR" ? argsOf(v) : v._node === "ROWCOMPAREEXPR" && Array.isArray(v.rargs) ? v.rargs : [];
  if (outputs.some((a) => sublinkParamOf(a) !== null)) typed.params = outputs.map(sublinkParamOf);
  if (v._node === "AGGREF" && Array.isArray(v.aggdirectargs)) typed.directArgs = v.aggdirectargs.filter(isNode).map((a) => exprType(a) ?? { type: 0, typmod: -1 });
  if (v._node === "AGGREF") typed.keys = keysOf(v.args, v.aggorder, v.aggdistinct, []);
  // a GROUPING(…): its query level and the GROUP BY entries its arguments read; a window function: its WINDOW clause
  if (v._node === "GROUPINGFUNC") typed.grouping = groupingsIn(v)[0]!;
  if (v._node === "WINDOWFUNC") typed.winref = num(v.winref ?? null);
  const text = constText(v);
  if (text !== undefined) typed.text = text;
  const textArray = constTextArray(v);
  if (textArray !== undefined) typed.textArray = textArray;
  const relation = v._node === "VAR" ? relationOf(v, rtables) : null;
  if (relation !== null) typed.relation = relation;
  const column = v._node === "VAR" ? columnOf(v, rtables) : null;
  if (column !== null) typed.column = column;
  const fromFunction = v._node === "VAR" ? functionColumnOf(v, rtables) : null;
  if (fromFunction !== null) typed.functionColumn = fromFunction;
  return typed;
}

/**
 * THE COLLATION AN EXPRESSION'S RESULT CARRIES, as Postgres's exprCollation reads it: each node keeps it in a field of
 * its own (a COLLATE's `collOid`, a relabel's `resultcollid`, a CASE's `casecollid` …). A SUBLINK's is its subselect's
 * first output's (an EXPR or ARRAY sublink; a test of one carries none). 0: none (a type that is not collatable).
 */
export function collationOf(v: TreeNode): number {
  if (v._node === "SUBLINK") {
    const sub = v.subselect;
    const tl = isNode(sub ?? null) ? (sub as TreeNode).targetList : undefined;
    const first = Array.isArray(tl) ? tl.find((e) => isNode(e) && e.resjunk !== "true") as TreeNode | undefined : undefined;
    const kind = num(v.subLinkType);
    return (kind === 4 || kind === 5) && first !== undefined && isNode(first.expr ?? null) ? collationOf(first.expr as TreeNode) : 0;
  }
  return num(v.opcollid ?? v.funccollid ?? v.aggcollid ?? v.wincollid ?? v.varcollid ?? v.constcollid ?? v.collOid ?? v.resultcollid ?? v.casecollid
    ?? v.coalescecollid ?? v.minmaxcollid ?? v.array_collid ?? v.paramcollid ?? v.refcollid ?? v.collid ?? v.collation ?? null) ?? 0;
}

/**
 * WHERE A STATEMENT'S ANALYSIS ORDERS A COLLATABLE VALUE, by the collation it orders under: a sort key of any query
 * (its ORDER BY, a window's ORDER BY, an aggregate's ORDER BY or WITHIN GROUP), a GREATEST / LEAST, a row comparison,
 * and — as candidates whose operator or function the caller names from the catalog — an operator's and an aggregate's
 * or window function's input collation (`<` orders, `=` does not; `max` orders, `count` does not), and a plain
 * function's (`calls`: `upper` maps case under it, issue 406; `length` reads none of it).
 */
export function textOrdering(tree: TreeValue): { orders: Set<number>; operators: Map<number, Set<number>>; functions: Map<number, Set<number>>; calls: Map<number, Set<number>> } {
  const orders = new Set<number>(), operators = new Map<number, Set<number>>(), functions = new Map<number, Set<number>>(), calls = new Map<number, Set<number>>();
  const add = (m: Map<number, Set<number>>, oid: number | null, coll: number): void => { if (oid === null || coll === 0) return; const s = m.get(oid) ?? new Set(); s.add(coll); m.set(oid, s); };
  const sorted = (clauses: TreeValue | undefined, targets: TreeValue | undefined): void => {
    if (!Array.isArray(clauses) || !Array.isArray(targets)) return;
    for (const c of clauses) {
      if (!isNode(c)) continue;
      const ref = num(c.tleSortGroupRef ?? null);
      const t = targets.find((x) => isNode(x) && ref !== null && num(x.ressortgroupref ?? null) === ref) as TreeNode | undefined;
      const e = t !== undefined && isNode(t.expr ?? null) ? t.expr as TreeNode : null;
      if (e !== null) { const coll = collationOf(e); if (coll !== 0) orders.add(coll); }
    }
  };
  const visit = (v: TreeValue | undefined): void => {
    if (Array.isArray(v)) { for (const x of v) visit(x); return; }
    if (v === undefined || !isNode(v)) return;
    if (v._node === "QUERY") {
      sorted(v.sortClause, v.targetList);
      if (Array.isArray(v.windowClause)) for (const w of v.windowClause) if (isNode(w)) sorted(w.orderClause, v.targetList);
    }
    if (v._node === "AGGREF") { sorted(v.aggorder, v.args); add(functions, num(v.aggfnoid ?? null), num(v.inputcollid ?? null) ?? 0); }
    if (v._node === "WINDOWFUNC") add(functions, num(v.winfnoid ?? null), num(v.inputcollid ?? null) ?? 0);
    if (v._node === "OPEXPR") add(operators, num(v.opno ?? null), num(v.inputcollid ?? null) ?? 0);
    if (v._node === "FUNCEXPR") add(calls, num(v.funcid ?? null), num(v.inputcollid ?? null) ?? 0);
    if (v._node === "MINMAXEXPR") { const coll = num(v.inputcollid ?? null) ?? 0; if (coll !== 0) orders.add(coll); }
    if (v._node === "ROWCOMPAREEXPR" && Array.isArray(v.inputcollids)) for (const x of v.inputcollids) { const coll = typeof x === "string" ? num(x) ?? 0 : 0; if (coll !== 0) orders.add(coll); }
    for (const [k, x] of Object.entries(v)) if (k !== "_node") visit(x);
  };
  visit(tree);
  return { orders, operators, functions, calls };
}

/**
 * WHAT A STATEMENT'S ANALYSIS CALLS: every function, by OID, however it is called (a function's `funcid`, an operator's,
 * NULLIF's or IS DISTINCT FROM's `opfuncid`, an aggregate's `aggfnoid`, a window function's `winfnoid`; 0 where the
 * analysis left one unset), and whether it reads its session by a keyword or a sequence (`current_user`, `user`,
 * `current_catalog`, CURRENT_DATE: a SQLVALUEFUNCTION; nextval's NEXTVALUEEXPR). The caller asks the catalog's pg_proc
 * whether each depends on its arguments alone (`provolatile`), Postgres's own word for it (issue 406).
 */
export function functionsCalled(tree: TreeValue): { oids: Set<number>; session: boolean } {
  const oids = new Set<number>();
  let session = false;
  const visit = (v: TreeValue | undefined): void => {
    if (Array.isArray(v)) { for (const x of v) visit(x); return; }
    if (v === undefined || !isNode(v)) return;
    if (v._node === "SQLVALUEFUNCTION" || v._node === "NEXTVALUEEXPR" || v._node === "CURRENTOFEXPR") session = true;
    for (const k of ["funcid", "opfuncid", "aggfnoid", "winfnoid"]) if (k in v) oids.add(num(v[k] ?? null) ?? 0);
    for (const [k, x] of Object.entries(v)) if (k !== "_node") visit(x);
  };
  visit(tree);
  return { oids, session };
}

/** EVERY COLLATION A STATEMENT'S ANALYSIS NAMES (an expression's, an operator's input, a row comparison's per column, a
 *  FROM item's columns'), by OID: what src/duck/collation.ts resolves before the rewrite reads any */
export function collationOids(tree: TreeValue): Set<number> {
  const out = new Set<number>();
  const field = /(collid|collids|collOid|^collation|^colcollations)$/;
  const visit = (v: TreeValue | undefined, key: string): void => {
    if (Array.isArray(v)) {
      if (field.test(key)) { for (const x of v) if (typeof x === "string" && x !== "o") { const n = num(x); if (n !== null) out.add(n); } return; }
      for (const x of v) visit(x, "");
      return;
    }
    if (typeof v === "string") { if (field.test(key)) { const n = num(v); if (n !== null) out.add(n); } return; }
    if (v === undefined || !isNode(v)) return;
    for (const [k, x] of Object.entries(v)) if (k !== "_node") visit(x, k);
  };
  visit(tree, "");
  out.delete(0);
  return out;
}

/** The output columns of one query, as its `targetList` numbers them. */
export interface QueryOutputs {
  /** each output in order: what it reads, a grouped column as the column it groups; null for an expression */
  columns: Array<Typed | null>;
  /** how many columns a `t.*` lists, by the FROM item's name */
  widths: Map<string, number>;
  /** each JOIN's merged columns as Postgres found them (`joinmergedcols`), in its range table's order: a JOIN's sides
   *  before it, left to right, as the FROM clause holds them. A NATURAL JOIN is written as these (src/duck/rewrite.ts) */
  joins: string[][];
  /** its ORDER BY and DISTINCT ON keys as Postgres bound them */
  keys: Keys;
}

/**
 * Each SELECT's outputs, found by any offset its targets hold. THE ORDER OF A `*` IS ITS QUERY'S `targetList`, NEVER THE
 * ORDER ITS VARS ARE MET IN THE TREE: under a GROUP BY (Postgres 17+) a key's output is a VAR of the RTE_GROUP entry at
 * no offset, and the column it groups is in that entry's `groupexprs`, which comes first and in the GROUP BY's order. So
 * the offset of a star says nothing of which of its columns is which; a set operation's own outputs are left out, as
 * they carry its first SELECT's offsets.
 */
export function outputsByLocation(tree: TreeValue): Map<number, QueryOutputs> {
  return analysedQueries(tree).byOffset;
}

/**
 * Each SELECT's outputs, by any offset its targets hold (`outputsByLocation`), and those of each SELECT whose outputs hold
 * none: `TABLE t`, whose `*` the grammar writes at no offset, so Postgres's expansion of it is at none either. Such a
 * one is known by the FROM items it reads, by the names its range table gives them (`eref`), in order, and by the
 * offsets its own LIMIT and OFFSET hold (`limits`).
 */
export function analysedQueries(tree: TreeValue): { byOffset: Map<number, QueryOutputs>; unplaced: Array<{ from: string[]; limits: number[]; outputs: QueryOutputs }> } {
  const found = new Map<number, QueryOutputs>();
  const unplaced: Array<{ from: string[]; limits: number[]; outputs: QueryOutputs }> = [];
  const visit = (v: TreeValue): void => {
    if (Array.isArray(v)) { for (const x of v) visit(x); return; }
    if (!isNode(v)) return;
    if (v._node === "QUERY" && Array.isArray(v.targetList) && !isNode(v.setOperations ?? null)) {
      const rtable = Array.isArray(v.rtable) ? v.rtable.filter(isNode) : [];
      const entries = v.targetList.filter(isNode).filter((t) => t.resjunk !== "true");
      const exprs = entries.map((t) => ungrouped(t.expr ?? null, rtable));
      const widths = new Map<string, number>();
      for (const rte of rtable) {
        const eref = rte.eref ?? null;
        if (isNode(eref) && typeof eref.aliasname === "string" && !widths.has(eref.aliasname)) widths.set(eref.aliasname, strings(eref.colnames).filter((c) => c !== "").length);
      }
      const joins = rtable.filter((rte) => num(rte.rtekind ?? null) === RTE_JOIN).map((rte) => {
        const eref = rte.eref ?? null;
        return isNode(eref) ? strings(eref.colnames).slice(0, num(rte.joinmergedcols ?? null) ?? 0) : [];
      });
      const outputs: QueryOutputs = {
        columns: exprs.map((e) => { const t = isNode(e) && e._node === "VAR" ? exprType(e) : null; return t === null ? null : typedOf(e as TreeNode, t, [rtable]); }),
        widths,
        joins,
        keys: keysOf(v.targetList, v.sortClause, v.distinctClause, rtable, v.windowClause),
      };
      let placed = false;
      const offsets = (x: TreeValue): void => {
        if (Array.isArray(x)) { x.forEach(offsets); return; }
        // (a subquery in a target is a query of its own, which registers its own offsets)
        if (!isNode(x) || x._node === "QUERY") return;
        const loc = num(x.location);
        if (loc !== null && loc >= 0) { placed = true; if (!found.has(loc)) found.set(loc, outputs); }
        const inner = ungrouped(x, rtable);
        if (inner !== x) { offsets(inner); return; }
        for (const [k, y] of Object.entries(x)) if (k !== "_node") offsets(y);
      };
      offsets(exprs);
      if (!placed) {
        const from = rtable.filter((rte) => num(rte.rtekind ?? null) !== RTE_JOIN).map((rte) => { const eref = rte.eref ?? null; return isNode(eref) && typeof eref.aliasname === "string" ? eref.aliasname : ""; });
        unplaced.push({ from, limits: limitOffsets(v), outputs });
      }
    }
    for (const [k, x] of Object.entries(v)) if (k !== "_node") visit(x);
  };
  visit(tree);
  return { byOffset: found, unplaced };
}

/** the offsets a query's own LIMIT and OFFSET hold (a count of `FETCH FIRST ROW` the grammar writes at none) */
function limitOffsets(q: TreeNode): number[] {
  const held = (x: TreeValue | undefined): number[] => {
    if (Array.isArray(x)) return x.flatMap(held);
    if (x === undefined || !isNode(x) || x._node === "QUERY") return [];
    const loc = num(x.location);
    return [...(loc !== null && loc >= 0 ? [loc] : []), ...Object.entries(x).flatMap(([k, y]) => k === "_node" ? [] : held(y))];
  };
  return [...held(q.limitCount), ...held(q.limitOffset)];
}

/**
 * EACH SET OPERATION'S OWN OUTPUTS, AS POSTGRES RESOLVED THEM: a column's type, typmod and collation are the set
 * operation's (`SELECT <citext> … UNION ALL SELECT <text> …` is text, its first SELECT's is citext), never its first
 * SELECT's. Each is known by the SELECTs it combines, in order: the offsets their outputs hold (a SELECT that is a set
 * operation of its own, with an ORDER BY or a LIMIT, is one of them, by its first SELECT's; a `TABLE t` by none, as
 * its outputs hold none), and the offsets its own LIMIT and OFFSET hold. Each column is typed as no table's column:
 * what is known of it is the set operation's alone.
 */
export function setOperationOutputs(tree: TreeValue): Array<{ arms: number[][]; limits: number[]; columns: Array<Typed | null>; armTypes: Array<number[] | null> }> {
  const found: Array<{ arms: number[][]; limits: number[]; columns: Array<Typed | null>; armTypes: Array<number[] | null> }> = [];
  const held = (x: TreeValue | undefined): number[] => {
    if (Array.isArray(x)) return x.flatMap(held);
    // (a subquery in an output is a query of its own)
    if (x === undefined || !isNode(x) || x._node === "QUERY") return [];
    const loc = num(x.location);
    return [...(loc !== null && loc >= 0 ? [loc] : []), ...Object.entries(x).flatMap(([k, y]) => k === "_node" ? [] : held(y))];
  };
  const visit = (v: TreeValue): void => {
    if (Array.isArray(v)) { for (const x of v) visit(x); return; }
    if (!isNode(v)) return;
    if (v._node === "QUERY" && isNode(v.setOperations ?? null) && Array.isArray(v.targetList)) {
      const rtable = Array.isArray(v.rtable) ? v.rtable : [];
      const arms: number[][] = [];
      // each arm's own output types, before the set operation coerced them to its columns' (null: not known)
      const armTypes: Array<number[] | null> = [];
      const leaves = (s: TreeValue | undefined): void => {
        if (s === undefined || !isNode(s)) return;
        if (s._node === "SETOPERATIONSTMT") { leaves(s.larg); leaves(s.rarg); return; }
        const rte = s._node === "RANGETBLREF" ? rtable[(num(s.rtindex ?? null) ?? 0) - 1] : undefined;
        const q = isNode(rte ?? null) ? (rte as TreeNode).subquery ?? null : null;
        if (!isNode(q)) { arms.push([]); armTypes.push(null); return; }
        armTypes.push(Array.isArray(q.targetList) ? q.targetList.filter((t) => isNode(t) && t.resjunk !== "true").map((t) => { const e = (t as TreeNode).expr ?? null; return isNode(e) ? exprType(e)?.type ?? 0 : 0; }) : null);
        const own = Array.isArray(q.targetList) ? held(q.targetList.filter((t) => isNode(t) && t.resjunk !== "true").map((t) => (t as TreeNode).expr ?? null)) : [];
        // (a VALUES's outputs read its rows at no offset of their own: it is known by its rows')
        const rows = own.length > 0 || !Array.isArray(q.rtable) ? [] : q.rtable.filter(isNode).flatMap((r) => held(r.values_lists));
        arms.push([...own, ...rows]);
      };
      leaves(v.setOperations);
      const columns = v.targetList.filter(isNode).filter((t) => t.resjunk !== "true").map((t) => {
        const e = t.expr ?? null;
        const type = isNode(e) ? exprType(e) : null;
        if (!isNode(e) || type === null) return null;
        const { relation: _r, column: _c, functionColumn: _f, ...own } = typedOf(e, type, [rtable.filter(isNode)]);
        return { ...own, qualifier: null, renamed: null };
      });
      found.push({ arms, limits: limitOffsets(v), columns, armTypes });
    }
    for (const [k, x] of Object.entries(v)) if (k !== "_node") visit(x);
  };
  visit(tree);
  return found;
}

/** an output as what it reads: a VAR of the query's RTE_GROUP is the expression it groups */
function ungrouped(v: TreeValue, rtable: TreeNode[]): TreeValue {
  if (!isNode(v) || v._node !== "VAR") return v;
  const rte = rtable[(num(v.varno ?? null) ?? 0) - 1];
  const exprs = rte !== undefined && num(rte.rtekind ?? null) === RTE_GROUP ? rte.groupexprs : undefined;
  return Array.isArray(exprs) ? exprs[(num(v.varattno ?? null) ?? 0) - 1] ?? v : v;
}

const RTE_JOIN = 2;
const RTE_GROUP = 9;
const RTE_RELATION = 0;
/** the FROM items whose name in the analysis (`unnamed_join`, `*VALUES*`, `unnamed_subquery`) no statement can say:
 *  RTE_SUBQUERY, RTE_JOIN, RTE_VALUES */
const UNNAMED = new Set([1, RTE_JOIN, 5]);

/** Typed.relation: the table a VAR's FROM item is, by the catalog's OID, and the column's number in it */
function relationOf(v: TreeNode, rtables: TreeNode[][]): { relid: number; attno: number } | null {
  const up = num(v.varlevelsup ?? null) ?? 0, varno = num(v.varno ?? null), attno = num(v.varattno ?? null);
  const rte = varno === null ? undefined : rtables[rtables.length - 1 - up]?.[varno - 1];
  const relid = rte === undefined ? null : num(rte.relid ?? null);
  return rte === undefined || attno === null || attno < 1 || num(rte.rtekind ?? null) !== RTE_RELATION || relid === null || relid === 0 ? null : { relid, attno };
}
/** Typed.column */
function columnOf(v: TreeNode, rtables: TreeNode[][]): NonNullable<Typed["column"]> | null {
  const up = num(v.varlevelsup ?? null) ?? 0, varno = num(v.varnosyn ?? null), attno = num(v.varattnosyn ?? null);
  const rte = varno === null ? undefined : rtables[rtables.length - 1 - up]?.[varno - 1];
  if (rte === undefined || attno === null || attno < 1 || !isNode(rte.eref ?? null)) return null;
  const eref = rte.eref as TreeNode;
  const columns = strings(eref.colnames), name = columns[attno - 1];
  if (name === undefined || typeof eref.aliasname !== "string" || /^\*SELECT\* \d+$/.test(eref.aliasname)) return null;
  const kind = num(rte.rtekind ?? null) ?? -1;
  const named = isNode(rte.alias ?? null);
  return { owner: UNNAMED.has(kind) && !named ? null : eref.aliasname, name,
    ...(kind === RTE_JOIN && named && columns.filter((c) => c === name).length > 1 ? { twin: true as const } : {}) };
}
const RTE_FUNCTION = 3;
/** Typed.functionColumn */
function functionColumnOf(v: TreeNode, rtables: TreeNode[][]): { alias: string; column: string } | null {
  const up = num(v.varlevelsup ?? null) ?? 0, varno = num(v.varno ?? null), attno = num(v.varattno ?? null);
  const rte = varno === null ? undefined : rtables[rtables.length - 1 - up]?.[varno - 1];
  if (rte === undefined || attno === null || attno < 1 || num(rte.rtekind ?? null) !== RTE_FUNCTION || !isNode(rte.eref ?? null)) return null;
  const eref = rte.eref as TreeNode;
  const column = strings(eref.colnames)[attno - 1];
  return typeof eref.aliasname === "string" && column !== undefined ? { alias: eref.aliasname, column } : null;
}
const strings = (v: TreeValue | undefined): string[] => Array.isArray(v) ? v.map((x) => typeof x === "string" ? x : "") : [];
/** Typed.qualifier: the name of a VAR's FROM item when another FROM item of its query has the column in another case,
 *  or when the VAR is an outer query's (a correlated subquery's bare `i4`, which DuckDB binds to the subquery's own
 *  output name `i4` first and refuses, 42703) */
function qualifierOf(v: TreeNode, rtables: TreeNode[][]): string | null {
  const up = num(v.varlevelsup ?? null) ?? 0, varno = num(v.varno ?? null), attno = num(v.varattno ?? null);
  const rtable = rtables[rtables.length - 1 - up];
  if (rtable === undefined || varno === null || attno === null || attno < 1) return null;
  const rte = rtable[varno - 1];
  const eref = rte !== undefined && isNode(rte.eref ?? null) ? rte.eref as TreeNode : null;
  if (rte === undefined || eref === null || num(rte.rtekind ?? null) === RTE_JOIN) return null;
  const alias = typeof eref.aliasname === "string" ? eref.aliasname : null;
  const column = strings(eref.colnames)[attno - 1];
  // a name the query cannot spell (an unnamed subquery, a VALUES list) cannot qualify anything
  if (alias === null || column === undefined || alias === "unnamed_subquery" || alias === "*VALUES*") return null;
  const lower = column.toLowerCase();
  // a FROM item of its own query, or of a query inside it the VAR is read from (a correlated subquery's, which DuckDB's
  // binder looks in first)
  const clash = rtables.slice(rtables.length - 1 - up).flat().some((other) => other !== rte && num(other.rtekind ?? null) !== RTE_JOIN
    && isNode(other.eref ?? null) && strings((other.eref as TreeNode).colnames).some((c) => c !== column && c.toLowerCase() === lower));
  // an outer column is qualified unless a query inside has a FROM item of the same name (the name would be that one)
  const outer = up > 0 && !rtables.slice(rtables.length - up).flat().some((other) => isNode(other.eref ?? null)
    && String((other.eref as TreeNode).aliasname ?? "").toLowerCase() === alias.toLowerCase());
  return clash || outer ? alias : null;
}

/** a FROM item's columns with each one that has a twin in another case renamed `<name>__mason_<n>`; null when none has */
function twinNames(rte: TreeNode): string[] | null {
  if (num(rte.rtekind ?? null) === RTE_JOIN || num(rte.rtekind ?? null) === 0 || !isNode(rte.eref ?? null)) return null;
  const cols = strings((rte.eref as TreeNode).colnames);
  const lower = cols.map((c) => c.toLowerCase());
  const twin = (i: number): boolean => lower.some((l, j) => j !== i && l === lower[i] && cols[j] !== cols[i]);
  return cols.some((_, i) => twin(i)) ? cols.map((c, i) => twin(i) ? `${c}__mason_${i + 1}` : c) : null;
}

/** Typed.renamed */
function renamedOf(v: TreeNode, rtables: TreeNode[][]): string | null {
  const up = num(v.varlevelsup ?? null) ?? 0, varno = num(v.varno ?? null), attno = num(v.varattno ?? null);
  const rte = varno === null ? undefined : rtables[rtables.length - 1 - up]?.[varno - 1];
  if (rte === undefined || attno === null || attno < 1) return null;
  const names = twinNames(rte);
  const own = isNode(rte.eref ?? null) ? strings((rte.eref as TreeNode).colnames)[attno - 1] : undefined;
  return names !== null && names[attno - 1] !== own ? names[attno - 1] ?? null : null;
}

/** Every subquery or CTE read in FROM whose columns have twins in another case (`"T"` beside `t`), by the name the
 *  query calls it: its columns as DuckDB is to name them (twinNames), every reference renamed alike (Typed.renamed) */
export function caseTwins(tree: TreeValue): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const visit = (v: TreeValue): void => {
    if (Array.isArray(v)) { for (const x of v) visit(x); return; }
    if (!isNode(v)) return;
    if (v._node === "RANGETBLENTRY" && isNode(v.eref ?? null)) {
      const names = twinNames(v);
      const alias = (v.eref as TreeNode).aliasname;
      if (names !== null && typeof alias === "string") out.set(alias, names);
    }
    for (const [k, x] of Object.entries(v)) if (k !== "_node") visit(x);
  };
  visit(tree);
  return out;
}

/**
 * Whether a JOIN … USING or a NATURAL JOIN of the analysed tree joins on a column of one of `types` (jsonb, jsonb[]):
 * Postgres equates the columns by that type's `=`, which DuckDB's USING would not (it compares the text). The join's
 * condition is Postgres's own (its `quals`), at no offset of the statement, so it is read here, not by the rewrite.
 */
export function joinsUsing(tree: TreeValue, types: ReadonlySet<number>): boolean {
  const compares = (v: TreeValue | undefined): boolean => {
    if (Array.isArray(v)) return v.some(compares);
    if (v === undefined || !isNode(v)) return false;
    if (v._node === "OPEXPR" && Array.isArray(v.args) && v.args.some((a) => isNode(a) && types.has(exprType(a)?.type ?? 0))) return true;
    return Object.entries(v).some(([k, x]) => k !== "_node" && compares(x));
  };
  const visit = (v: TreeValue | undefined): boolean => {
    if (Array.isArray(v)) return v.some(visit);
    if (v === undefined || !isNode(v)) return false;
    if (v._node === "JOINEXPR" && Array.isArray(v.usingClause) && v.usingClause.length > 0 && compares(v.quals)) return true;
    return Object.entries(v).some(([k, x]) => k !== "_node" && visit(x));
  };
  return visit(tree);
}

/**
 * The analysed expression of each output column, in order (resjunk ones left out): what computes its value, every node
 * with the type Postgres gave it, FOLLOWED wherever the analysis says a value comes from. A VAR that reads a FROM
 * subquery (a generated table's `order_by:` shell among them), a CTE, a set operation's arms (each arm's column), a join's
 * alias column or a grouped key carries what it reads as `followed`, itself followed; a sublink's subselect is followed
 * as a query of its own, its VARs read against the queries around it. A recursive CTE's reading of itself is not
 * followed again. Null for no query.
 *
 * LINEAR IN THE ANALYSED TREE, NEVER IN ITS EXPANSION (PR 202 round 14): a VAR's `followed` is the ONE followed node of
 * what it reads, by reference, shared by every VAR that reads it (`Follow`), so the result is a graph whose shared nodes
 * a reader visits once (src/duck/generated-plan.ts memoises by node). A copy per VAR grew 3^depth for a statement whose
 * levels each read the level below three times: 880 ms at depth 12, about 70 s at 16. The generated planner alone asks
 * for this (src/duck/plan.ts `PlanOptions.outputs`); a wire statement never pays for it.
 */
export function outputExpressions(tree: TreeValue): Array<TreeNode | null> | null {
  if (!isNode(tree) || tree._node !== "QUERY" || !Array.isArray(tree.targetList)) return null;
  const top = tree, list: TreeValue[] = tree.targetList, walk = new Follow();
  // a set operation's own column is a VAR of its leftmost arm's: it reads every arm's, and its location is the leftmost
  // arm's expression's, no column reference of its own (-1)
  const own = (e: TreeNode): TreeNode => isNode(top.setOperations ?? null)
    ? { ...e.expr as TreeNode, location: "-1", followed: walk.outputOf(top, num(e.resno ?? null) ?? 0, []) } : walk.followed(e.expr as TreeNode, [top]) as TreeNode;
  return list.filter((e): e is TreeNode => isNode(e) && e.resjunk !== "true").map((e) => isNode(e.expr ?? null) ? own(e) : null);
}

/** the followed walk of one analysed tree (`outputExpressions`): each analysed node followed ONCE and each query's output
 *  column found once, memoised by the analysed node, every VAR that reads one sharing the result. A node's stack (the
 *  queries around it) is where it stands in the tree, so one result serves every path to it; `open` is the queries being
 *  followed, so a recursive CTE's reading of itself reads nothing */
class Follow {
  private readonly nodes = new Map<TreeNode, TreeValue>();
  private readonly columns = new Map<TreeNode, Map<number, TreeNode[]>>();
  private readonly open = new Set<TreeNode>();

  /** `v` with every VAR it holds followed; `stack` the queries around it, its own last */
  followed(v: TreeValue, stack: readonly TreeNode[]): TreeValue {
    if (Array.isArray(v)) return v.map((x) => this.followed(x, stack));
    if (!isNode(v)) return v;
    const done = this.nodes.get(v);
    if (done !== undefined) return done;
    const result = this.follow(v, stack);
    this.nodes.set(v, result);
    return result;
  }

  private follow(v: TreeNode, stack: readonly TreeNode[]): TreeNode {
    const inner = v._node === "QUERY" ? [...stack, v] : stack;
    const out = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "_node" ? x : this.followed(x, inner)])) as TreeNode;
    if (v._node !== "VAR") return out;
    const up = num(v.varlevelsup ?? null) ?? 0, attno = num(v.varattno ?? null);
    const base = stack.slice(0, stack.length - up), q = base[base.length - 1];
    if (q === undefined || attno === null || attno < 1 || !Array.isArray(q.rtable)) return out;
    const rte = q.rtable[(num(v.varno ?? null) ?? 0) - 1];
    if (rte === undefined || !isNode(rte)) return out;
    const kind = num(rte.rtekind ?? null);
    let reads: TreeNode[] = [];
    if (kind === RTE_SUBQUERY && isNode(rte.subquery ?? null)) reads = this.outputOf(rte.subquery as TreeNode, attno, base);
    else if (kind === RTE_CTE) {
      // the CTE of the query `ctelevelsup` above, read with that query's own outer queries around it
      const levels = num(rte.ctelevelsup ?? null) ?? 0, owner = base[base.length - 1 - levels];
      const cte = owner !== undefined && Array.isArray(owner.cteList) ? owner.cteList.find((c) => isNode(c) && c.ctename === rte.ctename) : undefined;
      if (cte !== undefined && isNode(cte) && isNode(cte.ctequery ?? null)) reads = this.outputOf(cte.ctequery as TreeNode, attno, base.slice(0, base.length - levels));
    } else if (kind === RTE_JOIN || kind === RTE_GROUP) {
      const list = kind === RTE_JOIN ? rte.joinaliasvars : rte.groupexprs;
      const e = Array.isArray(list) ? list[attno - 1] : undefined;
      if (e !== undefined && isNode(e)) reads = [this.followed(e, base) as TreeNode];
    }
    return reads.length === 0 ? out : { ...out, followed: reads };
  }

  /** what output column `attno` of query `q` computes, followed: one expression, or a set operation's, one per arm */
  outputOf(q: TreeNode, attno: number, outer: readonly TreeNode[]): TreeNode[] {
    if (this.open.has(q)) return [];
    const known = this.columns.get(q)?.get(attno);
    if (known !== undefined) return known;
    this.open.add(q);
    let found: TreeNode[];
    try { found = this.outputFound(q, attno, [...outer, q]); } finally { this.open.delete(q); }
    const byColumn = this.columns.get(q) ?? new Map<number, TreeNode[]>();
    this.columns.set(q, byColumn.set(attno, found));
    return found;
  }

  private outputFound(q: TreeNode, attno: number, stack: readonly TreeNode[]): TreeNode[] {
    if (isNode(q.setOperations ?? null)) {
      const leaves: number[] = [];
      const walk = (s: TreeValue | undefined): void => {
        if (s === undefined || !isNode(s)) return;
        if (s._node === "RANGETBLREF") leaves.push(num(s.rtindex ?? null) ?? 0);
        else { walk(s.larg); walk(s.rarg); }
      };
      walk(q.setOperations);
      return leaves.flatMap((i) => {
        const rte = Array.isArray(q.rtable) ? q.rtable[i - 1] : undefined;
        return rte !== undefined && isNode(rte) && isNode(rte.subquery ?? null) ? this.outputOf(rte.subquery as TreeNode, attno, stack) : [];
      });
    }
    const entry = Array.isArray(q.targetList) ? q.targetList.find((t) => isNode(t) && num(t.resno ?? null) === attno) : undefined;
    return entry !== undefined && isNode(entry) && isNode(entry.expr ?? null) ? [this.followed(entry.expr as TreeNode, stack) as TreeNode] : [];
  }
}
const RTE_SUBQUERY = 1;
const RTE_CTE = 6;

/** The analysed query's output columns, in order (resjunk ones, which a sort may add, left out): their types. */
export function outputTypes(tree: TreeValue): Array<{ name: string | null; type: number; typmod: number }> | null {
  if (!isNode(tree) || tree._node !== "QUERY" || !Array.isArray(tree.targetList)) return null;
  return tree.targetList.filter((e): e is TreeNode => isNode(e) && e.resjunk !== "true").map((e) => {
    const t = isNode(e.expr ?? null) ? exprType(e.expr as TreeNode) : null;
    return { name: typeof e.resname === "string" ? e.resname : null, type: t?.type ?? 0, typmod: t?.typmod ?? -1 };
  });
}
