/**
 * A STORED JSON PATH, AS A STATEMENT READS IT (docs/DESIGN.md "Stored JSON paths"; the keeper is
 * src/duck/kept.ts). A copied table's JSON column read by a path a statement names with literal steps — `payload ->>
 * 'customer_id'`, `payload #> '{a,0}'`, `jsonb_extract_path_text(payload, 'a')` — is computed by a JavaScript function
 * for every row of every statement (`__mason_json_get`, src/duck/functions.ts): a hop from DuckDB's thread to Node's
 * main thread, ~4.5 µs a row on the test server, 98 s over 22 M rows. A path statements keep reading is stored instead,
 * as a hidden column of the copy holding exactly what that function answers, computed once per row WRITTEN; the
 * rewrite (src/duck/rewrite.ts `keptRead`) reads the column in place of the call once every row of it is stored.
 *
 * This module is what a statement's plan needs of it, and nothing that writes: the names, the READ a rewrite records,
 * and `hideKept`, which keeps the hidden columns out of every answer — a hidden column is a column of the copied table
 * to DuckDB, so a `*`, a `t.*`, a whole row or a NATURAL JOIN would list it. Postgres's analysis (the catalog, PGlite)
 * never knows it, so a result's names, types and typmods are Postgres's whatever DuckDB holds.
 */
import { createHash } from "node:crypto";
import { pathIndex } from "./functions.ts";
import type { LibcOrder } from "./libc-order.ts";
import type { DuckCollation } from "./rewrite.ts";

/** A JSON read of a copied table's column, as the rewrite meets it: what `__mason_json_get` is called with. */
export interface JsonRead {
  /** the copied table, `<schema>.<table>` */
  source: string;
  column: string;
  /** the steps as `__mason_json_get` takes them: a JSON array of keys (strings) and indexes (numbers) */
  steps: string;
  /** a `#>` path's: each step a key of an object and, read as an integer, an index of an array */
  either: boolean;
  /** jsonb's canonical text (the operand is a jsonb), else json's text as the document has it */
  canonical: boolean;
  /** `->>`'s text (a string unquoted, JSON null as SQL NULL), else the value's json text */
  asText: boolean;
}

/**
 * A READ AS THE ONE PATH IT IS (the test server: `#>> '{order,status}'` and `-> 'order' ->> 'status'`
 * were two ledger rows, two columns and two whole-table backfills of one path). A `#>` path whose every element is a
 * key — none reads as an array index (`pathIndex`, the function's own definition) — reads what the same keys read by
 * `->`: on an object each is a key, on anything else the read is NULL either way. So it IS the keys' read, and is
 * written as one here: THE ONE PLACE every read passes through — the rewrite's (`keptRead`), the request log's key
 * (`readKey`), the hidden column's name (`hiddenName`), the ledger and `mason status` (the keeper's rows are written
 * from it). An element that reads as an index (`{arr,0}`) is not folded: on an array `#> '{arr,0}'` is its first
 * element where `-> 'arr' -> '0'` (a key) is NULL.
 */
export function canonicalRead<T extends Omit<JsonRead, "asText">>(r: T): T {
  if (!r.either) return r;
  const steps = JSON.parse(r.steps) as unknown[];
  return steps.every((s) => typeof s === "string" && pathIndex(s) === null) ? { ...r, either: false } : r;
}

/** a read as one string: the request log's key (its `->>` or `->` included: the policy counts both for one path) */
export const readKey = (r: JsonRead): string => { const c = canonicalRead(r); return JSON.stringify([c.source, c.column, c.steps, c.either, c.canonical, c.asText]); };

/** a read's key, back (null for a string that is not one) */
export function readOfKey(key: string): JsonRead | null {
  let v: unknown;
  try { v = JSON.parse(key); } catch { return null; }   // a key a later Mason wrote otherwise: not a read this one keeps
  if (!Array.isArray(v) || v.length !== 6) return null;
  const [source, column, steps, either, canonical, asText] = v as unknown[];
  if (typeof source !== "string" || typeof column !== "string" || typeof steps !== "string" || typeof either !== "boolean" || typeof canonical !== "boolean" || typeof asText !== "boolean") return null;
  return canonicalRead({ source, column, steps, either, canonical, asText });
}

/**
 * THE STORED PATH A READ IS ANSWERED FROM: its canonical read (`canonicalRead`) without `->>`. One column serves a
 * path's `->` and its `->>` (the test server: a popular key was stored twice, as `-> 'k'` and `->> 'k'`, two
 * whole-table backfills): it holds the `->` answer, the value's JSON text, from which the `->>` answer is derived
 * without the document (src/duck/rewrite.ts `keptRead`) — a string unquoted, a JSON null NULL, anything else its text,
 * which is what `->>` answers (a jsonb number's text is numeric's either way, src/duck/jsonb.ts writeJson). The other
 * way would lose what `->` answers: `->>` reads the string "5" and the number 5 alike.
 */
export const pathKey = (r: Omit<JsonRead, "asText">): string => { const c = canonicalRead(r); return JSON.stringify([c.source, c.column, c.steps, c.either, c.canonical]); };

/**
 * THE HIDDEN COLUMN'S NAME: `__mason_json_` and 12 hex digits of the stored path's hash (`pathKey`), over the table too, so two tables'
 * columns never share a name (a NATURAL JOIN of two tables would join on it). Mason's prefix: a source column of that
 * very name is refused by the keeper (DuckDB names are case-insensitive), never shadowed.
 */
export const HIDDEN_PREFIX = "__mason_json_";
export const HIDDEN_RE = /^__mason_json_[0-9a-f]{12}$/;
export const hiddenName = (r: Omit<JsonRead, "asText">): string => `${HIDDEN_PREFIX}${createHash("sha256").update(pathKey(r)).digest("hex").slice(0, 12)}`;

/**
 * THE VIEWS OF THE COPIES' VISIBLE COLUMNS: an attached in-memory DuckDB database of this name holds, for every served
 * copy `<schema>.<table>`, a view `<schema>.<table>` of its visible columns in their order — the copy as it was before
 * any column was stored. A statement that lists every column of a copy reads it there (`hideKept`): the same schema and
 * table name, so `public.orders.id` and `orders.id` still bind.
 */
export const VISIBLE_CATALOG = "__mason_visible";

/**
 * A JSONB'S ORDER, AS A READ (src/duck/jsonb-order.ts; docs/DESIGN.md "jsonb's order"): `ORDER BY j`, `GROUP BY j`,
 * `j = k` compare a key of the whole document, computed per row by a function — 19 s for `ORDER BY j LIMIT 100` over
 * 20 M rows under C, 83 s under a libc locale, where the same sort from a stored key takes 0.1 s. So the key is a read
 * like a path's, recorded, weighed and stored by the same keeper: its `steps` is `ORDER_STEPS` (never a path's, which
 * is a JSON array). The rewrite records it as `ORDER_STEPS`; the keeper stores it as `ORDER_STEPS:<the collation's
 * id>` (src/duck/kept.ts `own`), because a string's key is its collation's, so a key stored under another collation is
 * another column, never read.
 */
export const ORDER_STEPS = "order";
/** a stored key's marks (hex, DuckDB's `unhex`): a NULL document's, and a row whose key raised, computed when read. No
 *  key begins with a 0x00 (src/duck/jsonb-order.ts: every key starts with an array's or an object's tag) */
export const KEY_NULL_HEX = "00";
export const KEY_RECOMPUTE_HEX = "0021";
export const isOrderRead = (r: { steps: string }): boolean => r.steps === ORDER_STEPS || r.steps.startsWith(`${ORDER_STEPS}:`);
/**
 * A JSONB'S EQUALITY, AS A READ, under a LIBC collation alone (src/duck/rewrite.ts `equalKey`): `GROUP BY j`, `DISTINCT
 * j`, `j = k`, `j IN (…)`, a join on `=`, `count(DISTINCT j)` compare the C key — a libc order's key refuses a string
 * its measured order does not cover, where equality never needed an order (docs/DESIGN.md "jsonb's order"), so the
 * order's stored key cannot serve them, and over 20 M rows a GROUP BY computed the C key per row for ~20 s. So the C key
 * is a read of its own, stored beside the order's as `EQUAL_STEPS:<id>` (src/duck/kept.ts `equalId`). Under C and ICU
 * the order's key equates exactly and never refuses, so equality reads IT and this read is never recorded nor stored
 * (src/duck/kept.ts `own` folds one into the order's).
 */
export const EQUAL_STEPS = "equal";
export const isEqualRead = (r: { steps: string }): boolean => r.steps === EQUAL_STEPS || r.steps.startsWith(`${EQUAL_STEPS}:`);
/** a jsonb's key, the order's or the equality's: a BLOB column of the key's bytes, its marks `KEY_NULL_HEX` and
 *  `KEY_RECOMPUTE_HEX`, stored under an id of what its bytes depend on */
export const isKeyRead = (r: { steps: string }): boolean => isOrderRead(r) || isEqualRead(r);

/** a read as a developer writes it: `payload ->> 'customer_id'`, `payload #> '{a,0}'`; a stored path (no `asText`) as
 *  its `->` read; a jsonb's order and equality as what reads each (under libc the order's key sorts and the C key
 *  equates, two columns: `mason status` names each by its own) */
export function pathText(r: Omit<JsonRead, "asText" | "source"> & { asText?: boolean }): string {
  if (isEqualRead(r)) return `GROUP BY ${r.column} (its jsonb equality: grouped, DISTINCT, = and IN)`;
  if (isOrderRead(r)) return r.steps.startsWith(`${ORDER_STEPS}:libc:`) ? `ORDER BY ${r.column} (its jsonb order: sorted, and compared by < and >)`
    : `ORDER BY ${r.column} (its jsonb order: sorted, grouped and compared)`;
  const steps = JSON.parse(r.steps) as Array<string | number>;
  const op = (one: boolean): string => one ? (r.asText ? "->>" : "->") : (r.asText ? "#>>" : "#>");
  if (steps.length === 1 && !r.either) {
    const s = steps[0]!;
    return `${r.column} ${op(true)} ${typeof s === "number" ? String(s) : `'${s.replaceAll("'", "''")}'`}`;
  }
  const element = (s: string | number): string => typeof s === "number" || /^[A-Za-z0-9_]+$/.test(s) ? String(s) : `"${String(s).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  return `${r.column} ${op(false)} '{${steps.map(element).join(",").replaceAll("'", "''")}}'`;
}

/**
 * A READY PATH, AS A PLAN READS IT (`KeptRoutes.ready`): its hidden column, and whether the column ALONE answers the
 * read (`exact`) — every row holds the `->` answer or the mark of a NULL one (`KEPT_NULL`), none is unset or marked to
 * be computed (src/duck/kept.ts "READY"). Not exact, the read is a CASE that computes the marked rows from the document.
 */
export interface ReadyPath { name: string; exact: boolean }

/**
 * WHAT AN EXACT READ RAISES AT A MARK (src/duck/rewrite.ts `keptRead`, `keptKey`): a row marked to be computed
 * (`KEPT_RECOMPUTE`, `KEY_RECOMPUTE_HEX`) written AFTER the path was counted exact — by the stream, the poll or a copy's
 * side table, before the detector (src/duck/kept.ts `check`) counts it and turns the reads to the CASE — is never read
 * as a value: the exact read raises at it, by the column alone. A jsonb's key under a libc collation is marked where
 * its strings hold a character the measured order does not cover, the gap the statement's own key refuses by name
 * (`libc-uncovered`); any other mark is a Mason bug. Once counted (a minute at most), the CASE computes the row from its
 * document, and raises the function's own error (the character named) or answers. Raised by `MARKED_FUNCTIONS`, never
 * DuckDB's `error()`, which is volatile (a window's ORDER BY refuses it: the eager oracle's `rank() OVER (ORDER BY j)`).
 */
export function markedError(r: Omit<JsonRead, "source">, libc: boolean): { code: string; message: string } {
  if (isOrderRead(r) && libc) {
    return { code: "0A000", message: "a jsonb compared or sorted here holds a string Mason cannot order as the database's collation does (a combining mark, a Thai or " +
      "Lao vowel written before its consonant, a private-use or unassigned code point), in a row written since its stored keys were counted; asked again " +
      "in a minute, the error names the character (Mason gap libc-uncovered)" };
  }
  return { code: "XX000", message: `a stored value of ${pathText(r)} could not be computed when its row was written (a Mason bug: report it, with mason logs); ` +
    "asked again in a minute, it is computed from the row's document" };
}
/** the functions that raise `markedError` at a marked row (src/duck/functions.ts): of the column read (a key as its hex,
 *  so neither is a constant DuckDB would fold), the code and the message; a key's answers a BLOB, a path's a VARCHAR */
export const MARKED_FUNCTIONS = { key: "__mason_marked_key", value: "__mason_marked_value" } as const;

/** What a statement's plan asks of the stored JSON paths (src/duck/kept.ts `KeptJsonPaths`). */
export interface KeptRoutes {
  /** the hidden column of this read's path when every row of it is stored (READY), else null */
  ready(read: JsonRead): ReadyPath | null;
  /** the copies served now, each with its view of its visible columns (`VISIBLE_CATALOG`) */
  visible(): ReadonlySet<string>;
  /** moves whenever a path becomes ready or goes: the listener's plans made before it are made again */
  generation(): number;
  /** the oracle's (`eager`): every read a plan meets stored before the plan is made, so every read is answered from its
   *  column; null when the policy decides (src/duck/kept.ts `review`) */
  keepNow: ((reads: readonly JsonRead[]) => Promise<void>) | null;
  /** the collation the listener sorts text by, told once it is known (src/duck/store.ts `listener`): a jsonb's order
   *  is stored under it alone (`ORDER_STEPS`), and one stored under another is dropped */
  orderBy(collation: DuckCollation, libc: LibcOrder | undefined): Promise<void>;
}

/** what the rewrite consults (src/duck/rewrite.ts `keptRead`): a table's column by the catalog's OIDs, and its routes */
export interface KeptLookup {
  /** the copied table and column a VAR of the analysis reads (Typed.relation), when it is a json or jsonb column */
  at(relid: number, attno: number): { source: string; column: string } | null;
  ready(read: JsonRead): ReadyPath | null;
}

type Body = Record<string, unknown>;
type Node = Record<string, Body>;
const isObject = (v: unknown): v is Body => typeof v === "object" && v !== null && !Array.isArray(v);
const kindOf = (n: unknown): string | null => isObject(n) && Object.keys(n).length === 1 && /^[A-Z]/.test(Object.keys(n)[0]!) ? Object.keys(n)[0]! : null;
const bodyOf = (n: unknown): Body => (n as Node)[kindOf(n)!]!;
const sval = (n: unknown): string | null => kindOf(n) === "String" ? String(bodyOf(n).sval ?? "") : null;

/** the schemas a bare table name is looked up in, as the session's search_path says (`"$user"` names none here) */
export function searchSchemas(searchPath: string): string[] {
  return searchPath.split(",").map((s) => s.trim()).filter((s) => s !== "" && s !== '"$user"' && s !== "$user")
    .map((s) => s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replaceAll('""', '"') : s.toLowerCase());
}

/** the RangeVars a FROM list names itself, through its joins (never inside a subquery: its columns are its list's) */
function directTables(from: unknown): Body[] {
  const out: Body[] = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(visit); return; }
    const k = kindOf(v);
    if (k === "RangeVar") out.push(bodyOf(v));
    else if (k === "JoinExpr") { visit(bodyOf(v).larg); visit(bodyOf(v).rarg); }
  };
  visit(from);
  return out;
}

/** the name a FROM item's columns are qualified by: its alias, else its table's name */
const aliasOf = (rv: Body): string => isObject(rv.alias) ? String(rv.alias.aliasname ?? "") : String(rv.relname ?? "");

/**
 * WHETHER A STATEMENT LISTS A TABLE'S COLUMNS WITHOUT NAMING THEM (`hideKept`): a SELECT whose list holds a bare `*`
 * and whose FROM names a table itself (a `*` over a subquery lists the subquery's columns); a `t.*` anywhere whose `t`
 * is a table's name or alias in the statement; a NATURAL JOIN with a table on either side; or one bare name equal to a
 * table's name or alias (a whole row — `row_to_json(t)`, `SELECT t FROM t` — or a column of that name, taken as one).
 */
export function exposes(tree: unknown): boolean {
  const aliases = new Set<string>();
  const collect = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(collect); return; }
    if (!isObject(v)) return;
    const k = kindOf(v);
    if (k === "RangeVar") aliases.add(aliasOf(bodyOf(v)));
    for (const x of Object.values(k === null ? v : bodyOf(v))) collect(x);
  };
  collect(tree);
  const star = (n: unknown): boolean => kindOf(n) === "ColumnRef" && Array.isArray(bodyOf(n).fields) && (bodyOf(n).fields as unknown[]).length === 1 && kindOf((bodyOf(n).fields as unknown[])[0]) === "A_Star";
  const found = (v: unknown): boolean => {
    if (Array.isArray(v)) return v.some(found);
    if (!isObject(v)) return false;
    const k = kindOf(v);
    const b = k === null ? v : bodyOf(v);
    if (k === "SelectStmt" && Array.isArray(b.targetList) && directTables(b.fromClause).length > 0
      && b.targetList.some((t) => kindOf(t) === "ResTarget" && star(bodyOf(t).val))) return true;
    if (k === "JoinExpr" && b.isNatural === true && directTables([b.larg, b.rarg]).length > 0) return true;
    if (k === "ColumnRef" && Array.isArray(b.fields)) {
      const fields = b.fields as unknown[];
      const last = fields[fields.length - 1];
      if (fields.length >= 2 && kindOf(last) === "A_Star" && aliases.has(sval(fields[fields.length - 2]) ?? "")) return true;
      if (fields.length === 1 && aliases.has(sval(fields[0]) ?? "\u0000")) return true;
    }
    return Object.values(b).some(found);
  };
  return found(tree);
}

/**
 * THE HIDDEN COLUMNS KEPT OUT OF THE ANSWER (the rewritten tree, before it is printed). A statement that lists a table's
 * columns without naming them (`exposes`) — a hidden column is a column to DuckDB, and would be listed — reads every
 * copy it names through that copy's view of its visible columns (`VISIBLE_CATALOG`), and is rewritten with no stored
 * read at all (src/duck/plan.ts: a stored read names no document to fall back on, so it cannot be turned back into its
 * call here), so it answers exactly what it answered before any column was stored — a plan kept from before a table's
 * first stored column included. Every other statement reads the copies themselves, naming only what it reads.
 *
 * A table name is resolved as Postgres resolved it: a qualified one is that table; a bare one is a WITH query of that
 * name in scope (left alone), else the first schema on the search path that has a served copy of it. Answers whether the
 * statement exposed its columns. The tree is changed in place.
 */
export function hideKept(tree: unknown, ctx: { visible: ReadonlySet<string>; searchPath: readonly string[] }): boolean {
  if (!exposes(tree)) return false;
  // every copy it names, read through its view; a WITH query's name in scope is the WITH query's
  const redirect = (v: unknown, ctes: ReadonlySet<string>): void => {
    if (Array.isArray(v)) { for (const x of v) redirect(x, ctes); return; }
    if (!isObject(v)) return;
    const k = kindOf(v);
    if (k === "RangeVar") {
      const b = bodyOf(v);
      if (typeof b.catalogname === "string" && b.catalogname !== "") return;
      const name = String(b.relname ?? "");
      const schema = typeof b.schemaname === "string" && b.schemaname !== "" ? b.schemaname
        : ctes.has(name) ? null : ctx.searchPath.find((s) => ctx.visible.has(`${s}.${name}`)) ?? null;
      if (schema !== null && ctx.visible.has(`${schema}.${name}`)) { b.catalogname = VISIBLE_CATALOG; b.schemaname = schema; }
      return;
    }
    if (k === "SelectStmt") {
      const b = bodyOf(v);
      const w = isObject(b.withClause) ? b.withClause : null;
      const list = w !== null && Array.isArray(w.ctes) ? w.ctes.filter((c) => kindOf(c) === "CommonTableExpr").map(bodyOf) : [];
      const all = new Set([...ctes, ...list.map((c) => String(c.ctename ?? ""))]);
      // a WITH query sees the ones before it (all of them, RECURSIVE); the rest of the statement sees all
      list.forEach((c, i) => redirect(c.ctequery, w?.recursive === true ? all : new Set([...ctes, ...list.slice(0, i).map((x) => String(x.ctename ?? ""))])));
      for (const [key, x] of Object.entries(b)) if (key !== "withClause") redirect(x, all);
      return;
    }
    for (const x of Object.values(k === null ? v : bodyOf(v))) redirect(x, ctes);
  };
  redirect(tree, new Set());
  return true;
}
