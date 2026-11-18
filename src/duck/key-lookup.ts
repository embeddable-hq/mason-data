/**
 * A LOOKUP BY KEY ON A TABLE WHOSE KEY IS SCATTERED (issue 1148; docs/DESIGN.md "A lookup by key"). A synced table has no
 * index, so `WHERE id = $1` is a scan of the key column that only the row groups' min and max can cut short. Where a
 * key's values lie in many row groups (a random UUID, an integer key a heavy update load has scattered) none is cut,
 * and one order by its key read 1.8 GB of keys on the cold benchmark at 100 M orders (13 s; Postgres 0.02 s).
 *
 * THE SIDE TABLE: `_mason."key_lookup:<schema>.<table>"`, `(k, rid)`, the key and the row's row id, sorted by key, so
 * its own min and max cut a lookup to one row group. A lookup reads the row ids there, then the table's rows by row id
 * (DuckDB pushes the ids into the table's scan, one row group a row). It is decided per table from the table's own
 * row groups (`keySpread`): how many row groups a key's value falls in, read for a sample of its keys. Few, and the
 * table's own min and max already find a key (an append-mostly serial key): no side table. Many: built.
 *
 * WHAT THE SIDE TABLE HOLDS, AND WHAT IT DOES NOT (the ledger `_mason.key_lookups`, its `covered`):
 *  - every row of the table whose row id is below `covered` has its entry, and an entry below `covered` names a row
 *    that holds its key or is deleted (a row id is never given to another row below `covered`: below);
 *  - the rows at and past `covered` (written since it was built) are read from the table itself, by row id, which
 *    DuckDB's row group ranges cut to those rows alone (the TAIL).
 * So no write path writes the side table: a write appends its rows past `covered`, where the tail finds them, and a
 * deleted or updated row's old entry names a deleted row, which no read sees. The side table is built again, sorted,
 * once its tail passes `LOOKUP_TAIL_SHARE` of the table (`tailDue`), on the rebuilds' connection, never in a write's
 * way or a read's.
 *
 * A ROW ID IS GIVEN AGAIN after the rows at the table's end are all deleted and a checkpoint drops their row groups:
 * the next row written takes the first row id past the rows left (measured on DuckDB 2.0.0, `max_vacuum_tasks` 0).
 * Such a row would fall below `covered` with no entry. So every transaction that may add a row to a table with a side
 * table first lowers `covered` to its rows' end (`lowerCovered`): an insert, and an UPDATE, which DuckDB writes as a
 * delete and an insert for a list or a struct column (measured). And a rebuild's own snapshot is taken at a moment
 * no write runs (the writer's turn), its end kept as `floor`, which every lowering lowers too, so the rebuilt side
 * table covers only what no row id given again since can contradict (`swapBuilt`). A table replaced whole (a copy, a
 * compaction) has new row ids: its side table covers nothing from that swap on (`coverNothing`), in the swap's own
 * transaction, until it is built again.
 *
 * DuckDB's own row ids of a transaction's own rows are its own (`MAX_ROW_ID` and up) until it commits, so the side
 * table cannot be written in a write's transaction; it needs not be.
 */
import type { DuckConnection } from "./executor.ts";
import { MASON_SCHEMA } from "./store.ts";

/** the ledger: a row per table with a side table (or one being built), its `covered` and its last build (a function:
 *  the store's module imports this one through the planner, so its schema's name is read when called) */
export const lookupLedger = (): string => `${MASON_SCHEMA}.key_lookups`;
/** DuckDB's first row id of a transaction's own rows (`MAX_ROW_ID`): rows at and past it are not committed yet */
export const MAX_ROW_ID = 36_028_797_018_960_000n;
/** a table is given a side table when a key's value falls in at least this many of its row groups, on average over a
 *  sample (`keySpread`): a lookup then reads at least this many row groups of keys (about a million keys) where the
 *  side table reads one. Measured in docs/DESIGN.md "A lookup by key" */
export const LOOKUP_MIN_ROW_GROUPS = 8;
/** the side table is built again once the rows written since its build pass this share of the table's rows */
export const LOOKUP_TAIL_SHARE = 0.01;
/** how many of a table's keys are read to measure their spread: one row id a step, across the table */
export const LOOKUP_SAMPLE_KEYS = 256;
/** a table found clustered is measured again at most this often (its spread can drift: an update load scatters it) */
export const LOOKUP_REMEASURE_MS = 60 * 60_000;
/** the DuckDB types a side table is built for: a single-column key DuckDB keeps a min and a max of per row group */
const KEY_TYPES = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|UUID|VARCHAR|DATE|TIMESTAMP|TIMESTAMP WITH TIME ZONE)$/;
const SIDE_PREFIX = "key_lookup:";
/** a side table being built, beside the one that serves, renamed over it (`swapBuilt`); dropped at every open */
const NEXT_SUFFIX = ":next";

const ident = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const literal = (s: string): string => `'${s.replaceAll("'", "''")}'`;

/** the side table of a synced table (`schema.table`, the source's spelling), quoted */
export const sideTableOf = (source: string): string => `${MASON_SCHEMA}.${ident(`${SIDE_PREFIX}${source}`)}`;
const nextTableOf = (source: string): string => `${MASON_SCHEMA}.${ident(`${SIDE_PREFIX}${source}${NEXT_SUFFIX}`)}`;

/** a synced table (`schema.table`, the source's spelling) as the engine names it, quoted */
export const targetOf = (source: string): string => { const at = source.indexOf("."); return `${ident(source.slice(0, at))}.${ident(source.slice(at + 1))}`; };

/** whether a key of this DuckDB type (as `duckdb_columns().data_type` spells it) can have a side table */
export const lookupKeyType = (type: string): boolean => KEY_TYPES.test(type);

/** The ledger, made at the open; a build a stop or a crash cut short is dropped, and its `floor` forgotten (no build
 *  runs at an open). Answers the tables whose side table is built, by source, with their key column. */
export async function openLookups(w: DuckConnection): Promise<Map<string, string>> {
  await w.run(`CREATE TABLE IF NOT EXISTS ${lookupLedger()} (source VARCHAR PRIMARY KEY, key_column VARCHAR, covered BIGINT, floor BIGINT, built_at TIMESTAMPTZ, ` +
    `build_seconds DOUBLE, entries BIGINT, spread DOUBLE, row_groups BIGINT)`);
  await w.run(`UPDATE ${lookupLedger()} SET floor = NULL WHERE floor IS NOT NULL`);
  const left = (await w.runAndReadAll(`SELECT table_name FROM duckdb_tables() WHERE database_name = current_database() AND schema_name = $1 AND starts_with(table_name, $2) AND ends_with(table_name, $3)`,
    [MASON_SCHEMA, SIDE_PREFIX, NEXT_SUFFIX])).getRowsJS() as Array<[string]>;
  for (const [name] of left) await w.run(`DROP TABLE IF EXISTS ${MASON_SCHEMA}.${ident(name)}`);
  const built = (await w.runAndReadAll(`SELECT source, key_column FROM ${lookupLedger()} WHERE built_at IS NOT NULL`)).getRowsJS() as Array<[string, string]>;
  return new Map(built);
}

/** What a table's key looks like in its row groups: how many row groups it has, and in how many of them a key's value
 *  falls (its row group's min and max hold it), on average over `LOOKUP_SAMPLE_KEYS` keys read one row id a step. */
export interface KeySpread { rowGroups: number; perKey: number }

/**
 * THE SPREAD OF A TABLE'S KEY, read on `c` from the table's own row groups: their min and max of the key column
 * (`pragma_storage_info`, metadata), and a sample of its keys (one row id a step across the table: a few vectors of
 * the key column, never a scan). Null when the table holds no row group or no key was read.
 */
export async function keySpread(c: Pick<DuckConnection, "runAndReadAll">, schema: string, table: string, column: string, type: string): Promise<KeySpread | null> {
  const target = `${ident(schema)}.${ident(table)}`;
  const end = Number((await c.runAndReadAll(`SELECT coalesce(max(rowid), -1) + 1 FROM ${target} WHERE rowid < ${MAX_ROW_ID}`)).getRowsJS()[0]![0]);
  if (end === 0) return null;
  const step = Math.max(1, Math.floor(end / LOOKUP_SAMPLE_KEYS));
  const rows = (await c.runAndReadAll(`WITH rg AS (SELECT row_group_id, min(variant_extract(stats, 'min')::${type}) AS lo, max(variant_extract(stats, 'max')::${type}) AS hi ` +
    `FROM pragma_storage_info($1) WHERE column_name = $2 AND segment_type <> 'VALIDITY' GROUP BY row_group_id), ` +
    `p AS (SELECT ${ident(column)} AS v FROM ${target} WHERE rowid IN (SELECT i * ${step} FROM range(${Math.ceil(end / step)}) r(i)) AND ${ident(column)} IS NOT NULL) ` +
    `SELECT (SELECT count(*) FROM rg), (SELECT avg((SELECT count(*) FROM rg WHERE p.v BETWEEN rg.lo AND rg.hi)) FROM p)`, [`${schema}.${table}`, column])).getRowsJS()[0]!;
  const rowGroups = Number(rows[0]);
  if (rowGroups === 0 || rows[1] === null) return null;
  return { rowGroups, perKey: Number(rows[1]) };
}

/** whether a key so spread is given a side table: a lookup by it reads at least `LOOKUP_MIN_ROW_GROUPS` row groups */
export const spreadWanted = (s: KeySpread | null, min = LOOKUP_MIN_ROW_GROUPS): boolean => s !== null && s.perKey >= min;

/**
 * BEFORE A TRANSACTION ADDS ROWS TO A TABLE, in that transaction and before any row of it (the module's header): the
 * table's side table `covered`, and a build's `floor`, lowered to the end of the rows it holds now, where its new
 * rows may begin. Nothing when the table has no side table, or its rows reach past both (the usual case: one row
 * group's range read).
 */
export async function lowerCovered(w: Pick<DuckConnection, "run" | "runAndReadAll">, source: string, target: string): Promise<void> {
  const r = (await w.runAndReadAll(`SELECT covered, floor FROM ${lookupLedger()} WHERE source = $1`, [source])).getRowsJS()[0] as [bigint, bigint | null] | undefined;
  if (r === undefined) return;
  const bound = r[1] !== null && r[1] > r[0] ? r[1] : r[0];
  if (bound <= 0n) return;
  // a row at or past `bound - 1`: the rows reach past both, and nothing can be given a row id below them
  const past = (await w.runAndReadAll(`SELECT max(rowid) FROM ${target} WHERE rowid >= ${bound - 1n} AND rowid < ${MAX_ROW_ID}`)).getRowsJS()[0]![0];
  if (past !== null) return;
  const end = BigInt((await w.runAndReadAll(`SELECT coalesce(max(rowid), -1) + 1 FROM ${target} WHERE rowid < ${MAX_ROW_ID}`)).getRowsJS()[0]![0] as bigint);
  await w.run(`UPDATE ${lookupLedger()} SET covered = least(covered, ${end}), floor = CASE WHEN floor IS NULL THEN NULL ELSE least(floor, ${end}) END WHERE source = $1`, [source]);
}

/** A TABLE REPLACED WHOLE (a copy's swap, a compaction's), in the swap's transaction: its row ids are new, so its side
 *  table covers nothing (every lookup reads the table itself) until it is built again; a build running covers nothing */
export async function coverNothing(w: Pick<DuckConnection, "run">, source: string): Promise<void> {
  await w.run(`UPDATE ${lookupLedger()} SET covered = 0, floor = CASE WHEN floor IS NULL THEN NULL ELSE 0 END WHERE source = $1`, [source]);
}

/** A removed table's side table and ledger row, dropped (the caller's turn) */
export async function dropLookup(w: Pick<DuckConnection, "run">, source: string): Promise<void> {
  await w.run(`DROP TABLE IF EXISTS ${sideTableOf(source)}`);
  await w.run(`DROP TABLE IF EXISTS ${nextTableOf(source)}`);
  await w.run(`DELETE FROM ${lookupLedger()} WHERE source = $1`, [source]);
}

/** what a table's side table is now: its `covered` against the rows its table holds, and whether its tail is due a
 *  rebuild (`LOOKUP_TAIL_SHARE`); null when it has none. Read on `c`, metadata and one row group's row ids */
export async function lookupTail(c: Pick<DuckConnection, "runAndReadAll">, source: string, target: string, rows: number, share = LOOKUP_TAIL_SHARE): Promise<{ covered: number; tail: number; due: boolean } | null> {
  const r = (await c.runAndReadAll(`SELECT covered FROM ${lookupLedger()} WHERE source = $1 AND built_at IS NOT NULL`, [source])).getRowsJS()[0] as [bigint] | undefined;
  if (r === undefined) return null;
  const end = Number((await c.runAndReadAll(`SELECT coalesce(max(rowid), -1) + 1 FROM ${target} WHERE rowid >= ${r[0]} AND rowid < ${MAX_ROW_ID}`)).getRowsJS()[0]![0]);
  const covered = Number(r[0]), tail = Math.max(0, end - covered);
  return { covered, tail, due: covered === 0 || tail > Math.max(1, rows) * share };
}

/**
 * A SIDE TABLE BUILT, step one, ON THE WRITER'S TURN (the caller's, so no write runs): the ledger's row made or kept,
 * its `floor` set to the table's rows' end now, and the build's transaction begun on `c` (the rebuilds' connection)
 * with its snapshot taken now, by reading that same end in it. The caller then runs `fillBuilt` off the turn.
 */
export async function beginBuild(w: Pick<DuckConnection, "run" | "runAndReadAll">, c: Pick<DuckConnection, "run" | "runAndReadAll">, source: string, target: string, column: string): Promise<bigint> {
  const end = BigInt((await w.runAndReadAll(`SELECT coalesce(max(rowid), -1) + 1 FROM ${target} WHERE rowid < ${MAX_ROW_ID}`)).getRowsJS()[0]![0] as bigint);
  await w.run(`INSERT INTO ${lookupLedger()} (source, key_column, covered, floor) VALUES ($1, $2, 0, $3) ON CONFLICT (source) DO UPDATE SET key_column = excluded.key_column, floor = excluded.floor`,
    [source, column, end]);
  await c.run("BEGIN TRANSACTION");
  // its snapshot: the same rows the writer sees, as nothing writes on this turn
  const seen = BigInt((await c.runAndReadAll(`SELECT coalesce(max(rowid), -1) + 1 FROM ${target} WHERE rowid < ${MAX_ROW_ID}`)).getRowsJS()[0]![0] as bigint);
  if (seen !== end) throw new Error(`its key lookup's build saw ${seen} row ids where the writer saw ${end} (Mason bug: report it, with mason logs)`);
  return end;
}

/** step two, OFF THE WRITER'S TURN, in the transaction `beginBuild` began on `c`: the side table's next version, every
 *  row's key and row id sorted by key, committed. `run` runs the build (the sync's interruptible lane). Answers its
 *  entries. A failure is the caller's to roll back (`abandonBuild`) */
export async function fillBuilt(c: Pick<DuckConnection, "run" | "runAndReadAll">, source: string, target: string, column: string, run: (sql: string) => Promise<void>): Promise<number> {
  await run(`CREATE OR REPLACE TABLE ${nextTableOf(source)} AS SELECT ${ident(column)} AS k, rowid AS rid FROM ${target} WHERE rowid < ${MAX_ROW_ID} ORDER BY ${ident(column)}`);
  const entries = Number((await c.runAndReadAll(`SELECT count(*) FROM ${nextTableOf(source)}`)).getRowsJS()[0]![0]);
  await run("COMMIT");
  return entries;
}

/** a build that failed or stopped: its transaction rolled back (when still open) and its next version dropped */
export async function abandonBuild(c: Pick<DuckConnection, "run">, source: string, open: boolean): Promise<void> {
  if (open) await c.run("ROLLBACK");
  await c.run(`DROP TABLE IF EXISTS ${nextTableOf(source)}`);
}

/**
 * step three, ON THE WRITER'S TURN, in one transaction: the next version swapped in, `covered` set to the build's
 * `floor` (its rows' end, lowered by every write that may have given a row id again since), `floor` cleared and the
 * build recorded. A session reads the old side table or the new one, with the `covered` that goes with it. Answers
 * `covered`; null when the ledger's row went meanwhile (the table removed): nothing swapped, the next version dropped.
 */
export async function swapBuilt(w: Pick<DuckConnection, "run" | "runAndReadAll">, source: string, facts: { seconds: number; entries: number; spread: KeySpread | null }): Promise<bigint | null> {
  await w.run("BEGIN TRANSACTION");
  try {
    const r = (await w.runAndReadAll(`SELECT floor FROM ${lookupLedger()} WHERE source = $1`, [source])).getRowsJS()[0] as [bigint | null] | undefined;
    if (r === undefined || r[0] === null) {
      await w.run(`DROP TABLE IF EXISTS ${nextTableOf(source)}`);
      await w.run("COMMIT");
      return null;
    }
    const covered = r[0];
    await w.run(`DROP TABLE IF EXISTS ${sideTableOf(source)}`);
    await w.run(`ALTER TABLE ${nextTableOf(source)} RENAME TO ${ident(`${SIDE_PREFIX}${source}`)}`);
    await w.run(`UPDATE ${lookupLedger()} SET covered = $2, floor = NULL, built_at = now(), build_seconds = $3, entries = $4, spread = $5, row_groups = $6 WHERE source = $1`,
      [source, covered, facts.seconds, facts.entries, facts.spread?.perKey ?? null, facts.spread?.rowGroups ?? null]);
    await w.run("COMMIT");
    return covered;
  } catch (e) {
    await w.run("ROLLBACK");
    throw e;
  }
}

// ------------------------------------------------------------------------------------------------- the planner's route

type Node = Record<string, unknown>;
const kindOf = (n: unknown): string | null => n !== null && typeof n === "object" && !Array.isArray(n) && Object.keys(n).length === 1 ? Object.keys(n)[0]! : null;
const bodyOf = (n: unknown): Node => (n as Record<string, Node>)[kindOf(n)!]!;
const svals = (fields: unknown): string[] | null => Array.isArray(fields) && fields.every((f) => kindOf(f) === "String") ? fields.map((f) => String(bodyOf(f).sval ?? "")) : null;

/** a value the conjunct compares the key with that is the same for every row: a literal, a parameter, a cast of either */
function constantValue(n: unknown): boolean {
  const k = kindOf(n);
  if (k === "A_Const" || k === "ParamRef") return true;
  return k === "TypeCast" && constantValue(bodyOf(n).arg);
}

/** the tables whose side table is built, by source: their key column (`CopyState.lookup`), and the columns their
 *  synced data holds, in order (`CopyState.syncedColumns`: what its view of its visible columns lists) */
export type Lookups = ReadonlyMap<string, { column: string; columns: readonly string[] | null }>;

/** what the route needs of the statement: the tables with a side table, the schemas a bare name is looked up in, the
 *  catalog of the copies' views of their visible columns (src/duck/kept-route.ts `VISIBLE_CATALOG`), and the prefix
 *  of the names Mason invents for it (src/duck/own-names.ts) */
export interface LookupContext { lookups: Lookups; schemas: readonly string[]; visible: string; own: string; parse: (sql: string) => Promise<unknown> }

interface Found { select: Node; at: number; values: Node[]; alias: string; source: string; column: string; schema: string; table: string;
  /** read through its view of its visible columns (`hideKept`): the columns that view lists, else null */
  view: readonly string[] | null }

/**
 * THE ROUTE (the module's header): in every SELECT that reads ONE table with a side table, alone in its FROM, a
 * top-level conjunct of its WHERE `key = <constant>` or `key IN (<constants>)` — the key as a bare column, compared by
 * DuckDB's own `=`, so the side table's column of the same type compares the same — is replaced by
 * `<table>.rowid IN (<its side table's row ids below covered> UNION ALL <the tail's>)`: the same rows, by the module's
 * invariant. Kept as a conjunct beside it, the comparison would be pushed into the table's scan, and DuckDB would read
 * the table first (measured: every row group) — so it is replaced. A table read through its view of its visible
 * columns (a `*` over a copy with a hidden column, src/duck/kept-route.ts `hideKept`) has no row ids: it is read as a
 * derived table of those columns, under its name, of the rows so routed, and the conjunct goes. Answers whether
 * anything was routed. A table the statement names by a WITH query's name is never one.
 */
export async function routeLookups(tree: unknown, ctx: LookupContext): Promise<boolean> {
  if (ctx.lookups.size === 0) return false;
  const found: Found[] = [];
  // a SELECT's body: its own WITH queries in scope (for it and all below it), then each part of it; a set operation's
  // arms (`larg`, `rarg`) are bodies held without their `SelectStmt` wrapper
  const select = (o: Node, ctes: ReadonlySet<string>): void => {
    const list = ((o.withClause as Node | undefined)?.ctes as unknown[] | undefined);
    const scope = list === undefined ? ctes : new Set([...ctes, ...list.map((c) => String((c as { CommonTableExpr?: { ctename?: string } }).CommonTableExpr?.ctename ?? "").toLowerCase())]);
    const f = lookupIn(o, scope, ctx);
    if (f !== null) found.push(f);
    for (const [k, x] of Object.entries(o)) {
      if ((k === "larg" || k === "rarg") && x !== null && typeof x === "object") select(x as Node, scope);
      else walk(x, scope);
    }
  };
  const walk = (v: unknown, ctes: ReadonlySet<string>): void => {
    if (Array.isArray(v)) { for (const x of v) walk(x, ctes); return; }
    if (v === null || typeof v !== "object") return;
    if (kindOf(v) === "SelectStmt") { select(bodyOf(v), ctes); return; }
    for (const x of Object.values(v as Node)) walk(x, ctes);
  };
  walk(tree, new Set());
  for (const f of found) {
    const where = f.select.whereClause;
    const and = kindOf(where) === "BoolExpr" && bodyOf(where).boolop === "AND_EXPR";
    if (f.view === null) {
      const conjunct = await routed(f, ctx, `${ident(f.alias)}.rowid`);
      if (and) (bodyOf(where).args as unknown[])[f.at] = conjunct;
      else f.select.whereClause = conjunct;
      continue;
    }
    // through its view: a derived table of the view's columns, of the routed rows, under the name it was read by
    const inner = ident(`${ctx.own}r`);
    const conjunct = await routed(f, ctx, `${inner}.rowid`);
    const parsed = await ctx.parse(`SELECT FROM (SELECT ${f.view.map(ident).join(", ")} FROM ${ident(f.schema)}.${ident(f.table)} AS ${inner} WHERE true) AS ${ident(f.alias)}`) as
      { stmts?: Array<{ stmt?: { SelectStmt?: Node } }> };
    const item = (parsed.stmts?.[0]?.stmt?.SelectStmt?.fromClause as unknown[] | undefined)?.[0];
    if (item === undefined || kindOf(item) !== "RangeSubselect") throw new Error(`the key lookup's derived table did not parse (Mason bug: report it): ${f.source}`);
    bodyOf(bodyOf(item).subquery).whereClause = conjunct;
    (f.select.fromClause as unknown[])[0] = item;
    if (!and) delete f.select.whereClause;
    else {
      const args = (bodyOf(where).args as unknown[]).filter((_, i) => i !== f.at);
      f.select.whereClause = args.length === 1 ? args[0] : { BoolExpr: { ...bodyOf(where), args } };
    }
  }
  return found.length > 0;
}

/** whether `v` names a column by three or more names (`public.orders.id`): a derived table, which binds no schema,
 *  would not hold it */
const schemaQualified = (v: unknown): boolean => {
  if (Array.isArray(v)) return v.some(schemaQualified);
  if (v === null || typeof v !== "object") return false;
  if (kindOf(v) === "ColumnRef" && Array.isArray(bodyOf(v).fields) && (bodyOf(v).fields as unknown[]).length >= 3) return true;
  return Object.values(v as Node).some(schemaQualified);
};

/** the one conjunct a SELECT may route, or null */
function lookupIn(select: Node, ctes: ReadonlySet<string>, ctx: LookupContext): Found | null {
  if (select.op !== undefined && select.op !== "SETOP_NONE") return null;
  const from = select.fromClause;
  if (!Array.isArray(from) || from.length !== 1 || kindOf(from[0]) !== "RangeVar") return null;
  const rv = bodyOf(from[0]);
  const relname = String(rv.relname ?? "");
  const catalog = typeof rv.catalogname === "string" && rv.catalogname !== "" ? rv.catalogname : null;
  if (rv.inh === false || (catalog !== null && catalog !== ctx.visible)) return null;
  // a bare name a WITH query holds is the WITH query (DuckDB binds names without case: src/duck/cte-names.ts)
  if (catalog === null && rv.schemaname === undefined && ctes.has(relname.toLowerCase())) return null;
  const schema = rv.schemaname !== undefined ? String(rv.schemaname) : ctx.schemas.find((s) => ctx.lookups.has(`${s}.${relname}`));
  if (schema === undefined) return null;
  const source = `${schema}.${relname}`;
  const lookup = ctx.lookups.get(source);
  if (lookup === undefined) return null;
  const column = lookup.column;
  const alias = (rv.alias as Node | undefined) ?? null;
  // through its view: with the columns it lists, under no column aliases, and no column named by its schema
  if (catalog !== null && (lookup.columns === null || alias?.colnames !== undefined || schemaQualified(select))) return null;
  const name = String(alias?.aliasname ?? relname);
  const isKey = (n: unknown): boolean => {
    if (kindOf(n) !== "ColumnRef") return false;
    const f = svals(bodyOf(n).fields);
    if (f === null) return false;
    if (f.length === 1) return f[0]!.toLowerCase() === column.toLowerCase();
    return f.length === 2 && f[0]!.toLowerCase() === name.toLowerCase() && f[1]!.toLowerCase() === column.toLowerCase();
  };
  const where = select.whereClause;
  if (where === undefined || where === null) return null;
  const conjuncts = kindOf(where) === "BoolExpr" && bodyOf(where).boolop === "AND_EXPR" ? bodyOf(where).args as unknown[] : [where];
  const found = (at: number, values: Node[]): Found => ({ select, at, values, alias: name, source, column, schema, table: relname, view: catalog === null ? null : lookup.columns });
  for (let at = 0; at < conjuncts.length; at++) {
    const c = conjuncts[at];
    if (kindOf(c) !== "A_Expr") continue;
    const e = bodyOf(c), op = svals(e.name);
    if (op === null || op.length !== 1 || op[0] !== "=") continue;
    if (e.kind === "AEXPR_OP") {
      const value = isKey(e.lexpr) && constantValue(e.rexpr) ? e.rexpr : isKey(e.rexpr) && constantValue(e.lexpr) ? e.lexpr : null;
      if (value !== null) return found(at, [value as Node]);
      continue;
    }
    if (e.kind === "AEXPR_IN" && isKey(e.lexpr) && kindOf(e.rexpr) === "List") {
      const items = bodyOf(e.rexpr).items as Node[];
      if (items.length > 0 && items.every(constantValue)) return found(at, items);
    }
  }
  return null;
}

/** the conjunct that replaces `f`'s: parsed from its text with a placeholder for each value, each replaced by the
 *  value's own node (a clone: a node is placed once, docs/DESIGN.md "A `->>` is DuckDB's own read") */
async function routed(f: Found, ctx: LookupContext, rowid: string): Promise<unknown> {
  const own = ctx.own, tail = ident(`${own}k`);
  const holes = f.values.map((_, i) => ident(`${own}v${i}`));
  const test = (col: string): string => holes.length === 1 ? `${col} = ${holes[0]}` : `${col} IN (${holes.join(", ")})`;
  const covered = `coalesce((SELECT covered FROM ${lookupLedger()} WHERE source = ${literal(f.source)}), 0)`;
  const sql = `SELECT FROM x WHERE ${rowid} IN (SELECT rid FROM ${sideTableOf(f.source)} WHERE ${test("k")} AND rid < ${covered} ` +
    `UNION ALL SELECT ${tail}.rowid FROM ${ident(f.schema)}.${ident(f.table)} AS ${tail} WHERE ${tail}.rowid >= ${covered} AND ${test(`${tail}.${ident(f.column)}`)})`;
  const parsed = await ctx.parse(sql) as { stmts?: Array<{ stmt?: { SelectStmt?: Node } }> };
  const where = parsed.stmts?.[0]?.stmt?.SelectStmt?.whereClause;
  if (where === undefined) throw new Error(`the key lookup's route did not parse (Mason bug: report it): ${sql}`);
  const names = new Map(f.values.map((v, i) => [`${own}v${i}`, v]));
  const fill = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(fill);
    if (v === null || typeof v !== "object") return v;
    if (kindOf(v) === "ColumnRef") {
      const f1 = svals(bodyOf(v).fields);
      const value = f1 !== null && f1.length === 1 ? names.get(f1[0]!) : undefined;
      if (value !== undefined) return structuredClone(value);
    }
    return Object.fromEntries(Object.entries(v as Node).map(([k, x]) => [k, fill(x)]));
  };
  return fill(where);
}
