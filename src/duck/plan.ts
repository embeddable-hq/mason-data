/**
 * ONE STATEMENT'S DUCKDB PLAN (docs/DESIGN.md "Postgres decides, DuckDB computes"): Postgres's analysis of
 * it (src/duck/analyze.ts) — its refusal, or its result's columns and its parameters' types — and the DuckDB SQL that
 * computes the same answer (src/duck/rewrite.ts), printed (pgsql-deparser) and read back to be sure it is the tree the
 * rewrite meant. The Postgres listener asks for a plan at Parse (and for each statement of a simple query), and keeps it
 * per text until the schema changes.
 */
import { deparseSync, QuoteUtils } from "pgsql-deparser";
import type { Node } from "libpg-query";
import { gapRefusal, StatementError, type DuckPlan } from "../api/postgres/server.ts";
import { parseSql } from "../api/postgres/parser.ts";
import { analyze, catalogRows, readParameters } from "./analyze.ts";
import { describeKeys, nameUserKeys, resolvedKeys } from "./resolved.ts";
import { expandViews, MAX_VIEW_DEPTH, viewRefused } from "./views.ts";
import { selectListAfterLimit } from "./late.ts";
import { pgTyplen } from "./types.ts";
import type { CopyState } from "./sync.ts";
import { datumText, masonCalls, rewrite, treeDifference, Unrewritable, type DuckCollation, type EnumTypes, type RowColumn } from "./rewrite.ts";
import { exposes, hideKept, readKey, searchSchemas, type KeptLookup, type KeptRoutes } from "./kept-route.ts";

const JSON_OID = 114, JSONB_OID = 3802;

/** what the rewrite asks of the stored JSON paths (src/duck/kept-route.ts KeptLookup): the copied table and column of
 *  each json or jsonb column the statement reads from a table (Typed.relation), by the catalog's OIDs; null when it
 *  reads none */
async function keptLookup(catalog: (bytes: Uint8Array) => Promise<Uint8Array>, types: ReadonlyMap<number, ReadonlyArray<{ type: number; relation?: { relid: number; attno: number } }>>,
  kept: KeptRoutes): Promise<KeptLookup | null> {
  const wanted = new Map<string, { relid: number; attno: number }>();
  for (const t of [...types.values()].flat()) if (t.relation !== undefined && (t.type === JSON_OID || t.type === JSONB_OID)) wanted.set(`${t.relation.relid}.${t.relation.attno}`, t.relation);
  if (wanted.size === 0) return null;
  const pairs = [...wanted.values()].map((r) => `(${Math.trunc(r.relid)}, ${Math.trunc(r.attno)})`).join(", ");
  const rows = await catalogRows(catalog, `SELECT c.oid::text, a.attnum::text, n.nspname, c.relname, a.attname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace ` +
    `JOIN pg_attribute a ON a.attrelid = c.oid WHERE (c.oid::int8, a.attnum::int8) IN (${pairs}) AND c.relkind = 'r' AND NOT a.attisdropped`);
  const at = new Map(rows.map(([relid, attno, schema, table, column]) => [`${relid}.${attno}`, { source: `${schema}.${table}`, column: column! }]));
  return { at: (relid, attno) => at.get(`${relid}.${attno}`) ?? null, ready: (read) => kept.ready(read) };
}

/**
 * DuckDB's keywords that Postgres's are not: a column named `at` (DuckDB's AT TIME ZONE) or `qualify` is an identifier
 * the deparser writes bare, as Postgres reads it, and DuckDB refuses as a syntax error. The deparser's one quoting
 * function (`QuoteUtils.quoteIdentifier`, its every bare identifier) also quotes these, read from DuckDB itself
 * (`duckdb_keywords()`, every category but the unreserved) by the store at the listener's start.
 */
const duckKeywords = new Set<string>();
const pgQuote = QuoteUtils.quoteIdentifier.bind(QuoteUtils);
export function quoteDuckKeywords(words: Iterable<string>): void {
  for (const w of words) duckKeywords.add(w.toLowerCase());
  QuoteUtils.quoteIdentifier = (ident: string): string => {
    const q = pgQuote(ident);
    return q === ident && duckKeywords.has(ident) ? `"${ident}"` : q;
  };
}

/** a search_path as SET writes it: each schema quoted (`"$user"` kept) */
const pathSql = (searchPath: string): string => searchPath.split(",").map((s) => s.trim()).filter((s) => s !== "")
  .map((s) => s.startsWith('"') ? s : `"${s.replaceAll('"', '""')}"`).join(", ") || "public";

declare const PLANNED: unique symbol;
/**
 * DuckDB SQL made from a statement Postgres analysed, by the rewrite, and read back as itself: the ONLY SQL a session's
 * DuckDB connection runs (src/duck/store.ts `run`). Made here alone (tests/conventions.test.ts): a statement's own text
 * never reaches DuckDB — an EXPLAIN that did ran the write under it (a review finding).
 *
 * It carries the Mason functions its tree calls (`functions`, src/duck/rewrite.ts masonCalls), which decide how the
 * executor cancels it (src/duck/store.ts "HOW A STATEMENT IS CANCELLED") and what an EXPLAIN lists: decided once, here,
 * from the tree, and never read off `text` again (a text match took every `SELECT *` over a copy with a
 * stored JSON path for a calling statement, and none of them could be timed out or cancelled).
 */
export interface PlannedSql {
  readonly text: string;
  /** the `__mason_*` functions it calls, sorted; none: it is interrupted and closed at once when cancelled */
  readonly functions: readonly string[];
  readonly [PLANNED]: true;
}

/**
 * `verified`: what the oracle has held to Postgres (src/duck/verified.ts). A statement using anything else is REFUSED,
 * by name — never answered by a rewrite nobody checked. null only for the oracle itself, which records what it verifies.
 */
/**
 * A statement's parameter values as DuckDB must read them: what Postgres's input function made of each (readParameters,
 * src/duck/analyze.ts), written back in a form DuckDB reads to the same value. A value Postgres refuses is refused with
 * its error (`'1.5'` for a smallint: 22P02).
 */
export async function duckParameters(catalog: (bytes: Uint8Array) => Promise<Uint8Array>, oids: readonly number[], values: readonly (string | null)[],
  timeZone: string): Promise<(string | null)[]> {
  const read = await readParameters(catalog, oids, values, timeZone);
  if ("refused" in read) {
    const f = read.refused;
    throw new StatementError({ code: f.C ?? "22P02", message: f.M ?? "invalid parameter value", ...(f.D ? { detail: f.D } : {}), ...(f.H ? { hint: f.H } : {}) }, "");
  }
  return values.map((v, i) => {
    const r = read.values[i];
    if (v === null || r === undefined || r === null) return v;
    if (/^-?infinity$/.test(r.text)) return r.text;
    const le = (n: bigint, bytes: number): number[] => Array.from({ length: bytes }, (_, k) => Number((BigInt.asUintN(bytes * 8, n) >> BigInt(8 * k)) & 255n));
    if (r.oid === 1082) return datumText(1082, le(BigInt(r.text), 4));
    if (r.oid === 1114 || r.oid === 1184) return datumText(r.oid, le(BigInt(r.text), 8));
    if (r.oid === 1186) { const [m, d, us] = r.text.split(" "); return `${m} months ${d} days ${us} microseconds`; }
    return r.text;
  });
}

/**
 * THE WAY OUT OF `relation "x" does not exist`, from the sync's copy state (`Sync.state`, the one reader: a
 * table added and still copying was told "mason add x copies it", which it already was). A table the catalog does not
 * hold is one of: added and waiting its turn, added and copying (how far), added and failed (why, and when it is tried
 * again), copied a moment ago (the catalog is rebuilt as each copy commits), or not added — the one `mason add` away.
 * `relation` is the name as Postgres wrote it: qualified, or bare, which matches an added table of that name (public's first).
 */
export function missingRelationHint(relation: string, copies: readonly CopyState[]): string {
  const matches = copies.filter((c) => c.source === relation || (!relation.includes(".") && c.source.endsWith(`.${relation}`)))
    .sort((a, b) => Number(b.source.startsWith("public.")) - Number(a.source.startsWith("public.")));
  const c = matches[0];
  const served = "it is served once its copy commits; mason wait waits for it (mason status shows how far it is)";
  if (c === undefined) return `a table is in Mason once it is added: mason add ${relation} copies it (mason tables lists the database's)`;
  switch (c.phase) {
    case "waiting": return `${c.source} is added and waits its turn to be copied: ${served}`;
    case "copying": {
      // the share is of the heap's PAGES read (`CopyProgressView.share`: exact, so it never moves backwards), the count
      // the rows the committed chunks and the ones reading have in; a copy can outrun the source's estimate (Postgres's
      // statistics lag the table) and then says so, never a share that fell to 0 (the same class as mason
      // wait's bar: a share derived from an estimate must never move backwards)
      const p = c.progress;
      const so = c.rowsSoFar === null || c.rowsSoFar === undefined ? null : c.rowsSoFar + (p?.rowsReading ?? 0), of = c.rowsEstimate ?? null;
      const share = p === undefined ? "" : `${Math.floor(p.share * 100)}% of its pages read, `;
      const how = so === null ? `${share}its rows are being read`
        : of === null || of <= 0 ? `${share}about ${so} rows so far`
        : so > of ? `${share}${so} rows so far, past the ~${of} estimated`
        : `${share}about ${so} of ~${of} rows so far${p === undefined ? `, ${Math.min(99, Math.floor((so / of) * 100))}%` : ""}`;
      return `${c.source} is added and being copied (${how}): ${served}`;
    }
    case "failed": return `${c.source} is added, but its copy failed: ${c.error ?? "no reason recorded"}; mason logs says more`;
    case "copied": return `${c.source} was just copied and joins the catalog as it is rebuilt: run the statement again in a moment (if it stays missing, mason logs says why)`;
  }
}

export async function planDuck(catalog: (bytes: Uint8Array) => Promise<Uint8Array>, text: string, stmt: Node, base: number,
  paramOids: readonly number[], searchPath: string, timeZone: string, collation: DuckCollation, verified: ReadonlyMap<string, string> | null,
  userTypes: ReadonlyMap<string, number> = new Map(), copies: () => readonly CopyState[] = () => [], depth = 0, kept: KeptRoutes | null = null): Promise<DuckPlan> {
  const started = performance.now();
  const analysis = await analyze(catalog, text, paramOids, pathSql(searchPath), timeZone);
  if ("refused" in analysis) {
    const f = analysis.refused;
    // a table the catalog does not hold: where its copy is, or the `mason add` away
    const missing = f.C === "42P01" ? /^relation "([^"]+)" does not exist$/.exec(f.M ?? "")?.[1] : undefined;
    const hint = missing !== undefined ? missingRelationHint(missing, copies()) : f.H;
    throw new StatementError({ code: f.C ?? "XX000", message: f.M ?? "Postgres refused the statement", ...(f.D ? { detail: f.D } : {}), ...(hint ? { hint } : {}),
      ...(f.P ? { position: Number(f.P) } : {}) }, text);
  }
  // A VIEW is answered as Postgres answers it, by its definition in its place (src/duck/views.ts): the statement so
  // written is planned from the start, its parameters typed as this one's were. Its errors are the expanded text's, so
  // they carry no position into this one
  const expanded = await expandViews(catalog, stmt, analysis, pathSql(searchPath));
  if (expanded !== null) {
    if (depth >= MAX_VIEW_DEPTH) throw viewRefused(`Mason cannot yet answer views read through more than ${MAX_VIEW_DEPTH} other views`, "read the tables the views read");
    try { return await planDuck(catalog, expanded.text, expanded.stmt, 0, analysis.params, searchPath, timeZone, collation, verified, userTypes, copies, depth + 1, kept); }
    catch (e) {
      if (!(e instanceof StatementError)) throw e;
      const { position: _p, ...fields } = e.fields;
      throw new StatementError(fields, text, e.gap);
    }
  }
  // the catalog's own OIDs for the types an extension made (citext): the rewrite knows a few by name, and the wire sends
  // the SOURCE's OID for them (`userTypes`, from the copy), never the catalog's
  let resolved = resolvedKeys(analysis.tree);
  const catalogTypes = new Map<number, string>();
  const enumLabels = new Map<number, string[]>(), enumArrays = new Map<number, number>();
  const enums: EnumTypes = { labels: enumLabels, arrays: enumArrays };
  const fields = analysis.fields === null ? null : analysis.fields.map((f) => ({ ...f }));
  // a table's row type (a whole row, `SELECT t FROM t`): its columns, which the rewrite writes the row from, and the
  // name the wire maps to the source's OID (`rowtype:<schema>.<table>`)
  const rowTypes = new Map<number, RowColumn[]>();
  const used = new Set([...analysis.types.values()].flat().map((t) => t.type).filter((o) => o >= 16384));
  if ([...resolved].some((k) => /\bu\d+/.test(k)) || fields?.some((f) => f.oid >= 16384) || used.size > 0) {
    for (const [oid, name] of await catalogRows(catalog, "SELECT oid::text, typname FROM pg_type WHERE oid >= 16384 AND typtype IN ('b', 'd', 'e')")) catalogTypes.set(Number(oid), name!);
    // an enum's labels in their declared order, by its OID and its array type's: DuckDB is handed each value as its ENUM
    for (const [oid, array, label] of await catalogRows(catalog, "SELECT t.oid::text, t.typarray::text, e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid ORDER BY t.oid, e.enumsortorder")) {
      const labels = enumLabels.get(Number(oid)) ?? [];
      labels.push(label!);
      enumLabels.set(Number(oid), labels);
      if (Number(array) > 0) enumArrays.set(Number(array), Number(oid));
    }
    for (const [oid, name] of await catalogRows(catalog, "SELECT t.oid::text, 'rowtype:' || n.nspname || '.' || t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.oid >= 16384 AND t.typtype = 'c'")) {
      catalogTypes.set(Number(oid), name!);
      if (!used.has(Number(oid))) continue;
      const columns = await catalogRows(catalog, `SELECT a.attname, a.atttypid::text, a.atttypmod::text FROM pg_attribute a JOIN pg_type t ON t.typrelid = a.attrelid WHERE t.oid = ${Number(oid)} AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`);
      rowTypes.set(Number(oid), columns.map(([n, type, typmod]) => ({ name: n!, type: Number(type), typmod: Number(typmod) })));
    }
    resolved = await nameUserKeys((sql) => catalogRows(catalog, sql), resolved);
    for (const f of fields ?? []) {
      const source = f.oid >= 16384 ? userTypes.get(catalogTypes.get(f.oid) ?? "") : undefined;
      if (source !== undefined) f.oid = source;
    }
  }
  let tree, dropLast, exact, clock, jsonReads;
  // a table's row the source has otherwise (copied in part: no source OID for it) is not the source's row
  const sourceRows = new Map([...rowTypes].filter(([oid]) => userTypes.has(catalogTypes.get(oid) ?? "")));
  // the stored JSON paths the statement's JSON reads may be answered from (src/duck/kept-route.ts)
  const lookup = kept === null ? null : await keptLookup(catalog, analysis.types, kept);
  const analysed = performance.now();
  const rewritten = (l = lookup): ReturnType<typeof rewrite> => rewrite(stmt as unknown as Record<string, Record<string, unknown>>, base, analysis, collation, catalogTypes, sourceRows, timeZone, enums, l);
  try {
    ({ tree, dropLast, exact, clock, jsonReads } = rewritten());
    // the oracle's (`eager`): every read stored before the plan is made, and the plan made again over them
    if (kept?.keepNow != null && lookup !== null && jsonReads.some((r) => kept.ready(r) === null)) {
      await kept.keepNow(jsonReads);
      ({ tree, dropLast, exact, clock, jsonReads } = rewritten());
    }
    // a statement that lists a copy's columns without naming them reads none from a stored column (hideKept): made
    // again with every read its call, the reads still recorded
    if (lookup !== null && exposes(tree)) ({ tree, dropLast, exact, clock, jsonReads } = rewritten({ at: (relid, attno) => lookup.at(relid, attno), ready: () => null }));
  }
  catch (e) {
    // a gap says its id (docs/SQL-SUPPORT.md); Postgres's own refusal is its SQLSTATE, and no gap
    if (e instanceof Unrewritable) {
      throw typeof e.gap === "string" ? gapRefusal(e.gap, e.message, e.hint, text)
        : new StatementError({ code: e.gap.postgres, message: e.message, hint: e.hint }, text);
    }
    throw e;
  }
  // a statement that lists a copy's columns without naming them reads its visible ones (src/duck/kept-route.ts); before
  // the late select list, which then reads the columns this leaves
  if (kept !== null) hideKept(tree, { visible: kept.visible(), searchPath: searchSchemas(searchPath) });
  // a sorted, limited select list is computed over the rows the limit keeps (src/duck/late.ts)
  tree = selectListAfterLimit(tree as Record<string, unknown>, analysis.tree) ?? tree;
  // ONLY WHAT THE ORACLE VERIFIED: after the rewrite, so a construct the rewrite refuses by name (with its own way out)
  // says so first
  const keys = [...resolved].sort();
  const unverified = verified === null ? [] : keys.filter((k) => !verified.has(k));
  if (unverified.length > 0) {
    const names = await describeKeys((sql) => catalogRows(catalog, sql), unverified);
    const listed = unverified.map((k) => names.get(k) ?? k);
    throw gapRefusal("unverified",
      `Mason cannot yet answer this statement exactly as Postgres would: it uses ${listed.slice(0, 5).join("; ")}${listed.length > 5 ? ` and ${listed.length - 5} more` : ""}, which Mason has not verified`,
      "write the statement without it (docs/SQL-SUPPORT.md lists what is verified), or report it: a statement Mason has not verified is refused rather than answered differently",
      text, `: ${unverified.join(", ")}`);
  }
  // DuckDB's COLUMNS(t.*) (decidedByKey's star) is an expression only unquoted; the deparser quotes the keyword. No
  // statement Postgres accepted calls a function "columns" (Postgres has none), and the read-back below checks the text
  const sql = deparseSync(tree as Node, { pretty: false }).replaceAll('any_value("columns"(', "any_value(COLUMNS(");
  // THE PRINTED TEXT MUST READ BACK AS THE TREE: a printing gap (the deparser drops or respells something) would run
  // another statement than the one Postgres analysed — refused instead, by name
  const back = (await parseSql(sql)).stmts?.[0]?.stmt;
  const difference = back === undefined ? "nothing" : treeDifference(back, tree);
  if (difference !== null) {
    throw new StatementError({ code: "0A000", message: "Mason cannot run this statement exactly: its rewritten form does not read back as itself (a Mason gap: report it, with the statement)",
      detail: `read back: ${difference}; the rewritten SQL: ${sql}` }, text);
  }
  const planned = { text: sql, functions: masonCalls(tree) } as unknown as PlannedSql;
  return { sql: planned, params: analysis.params, fields: fields?.map((f) => ({ ...f, size: pgTyplen(f.oid) })) ?? null, dropLast, ...(exact.length > 0 ? { exact } : {}), resolved: keys,
    ...(Object.keys(clock).length > 0 ? { clock } : {}), ...(jsonReads.length > 0 ? { jsonReads: jsonReads.map(readKey) } : {}), timing: { analysisMs: analysed - started, rewriteMs: performance.now() - analysed } };
}
