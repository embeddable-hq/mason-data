/**
 * A JOIN ON A DECLARED REFERENCE READS HIDDEN INTEGER KEYS (issue 1144; docs/DESIGN.md "Joins on hidden integer keys").
 * A join of `orders` to `customers` on `customer_id`, a UUID, reads every order's UUID: random UUIDs barely compress, so
 * that column was the largest the query read (2.5 GB of a 100 M-row table). For each reference the sources file names
 * (`references:`, src/cli/sources.ts), where the referenced key is clearly larger than a small integer, the synced data
 * holds a DICTIONARY of the key's values, each given a number once, and both tables hold the number of their key's value
 * in a hidden column: the referenced table's (`customers.id`) and the referencing table's (`orders.customer_id`). The
 * rewrite joins on the two numbers (src/duck/rewrite.ts `referenceJoins`).
 *
 * WHY IT IS EXACT. A value's number is the dictionary's, given once and never changed, and two values never share one. So
 * the numbers of two rows are equal exactly when their keys are equal. That holds whether the referenced key is unique
 * or not, for a referencing row whose referenced row is missing (its key has a number no referenced row holds), for a
 * referenced row deleted and inserted again (its key keeps its number), and for a key updated (its row is written again,
 * and numbered again). Two rules keep it so, each decided from the store, never from what the numbering found before (a
 * swap, a compaction or a timer can leave that behind):
 * - A NUMBER IS OF ITS DICTIONARY, NAMED IN ITS COLUMN. A dictionary belongs to a key's table, columns and types
 *   (`dictionaryOf`), and a hidden column's name begins with its dictionary's (`NUMBER_RE`). A type changed at the source
 *   gives another dictionary and other hidden columns. A dictionary is dropped only once no column of the store holds
 *   its numbers (`ensure`), so it is never made again under numbers it gave. A row is numbered only where its key's
 *   columns and the dictionary are of the types their families give (`fits`): no cast can fail, or match two values.
 * - A WRITE THAT CHANGES A KEY UNNUMBERS ITS ROW, in its own statement: an insert writes no number, and an update in
 *   place sets each hidden key the table holds now whose columns it sets to NULL (`unnumberedSet`).
 * A NULL key (or a key of several columns with a NULL in it) is numbered 0 on the referencing side
 * and -1 on the referenced side, so it matches nothing, as `=` matches nothing there. That differs from `=` only in
 * telling FALSE from NULL, so the rewrite joins on the numbers only where a comparison's FALSE and NULL do the same: a
 * conjunct of a JOIN's ON or of a WHERE.
 *
 * A ROW NOT NUMBERED YET holds NULL in its hidden column: a write that does not number its rows (a first sync's rows
 * before they are numbered, a catch-up, a write that does not know the column) leaves them so, and they are numbered on
 * the writer's turn after (`fill`). The stream's batches and the writer's polls number theirs in their own transaction.
 * A statement that joins on the numbers first checks, in a transaction it then runs in, that no row of the tables it
 * reads numbers of is unnumbered (`unnumberedSql`, src/duck/store.ts `numbersHold`). One is, and the statement runs as
 * it was written, on the keys' own columns. So a write path that leaves a row unnumbered costs the faster join, never
 * an answer. The check is not in the statement itself: a condition of its WHERE is evaluated only on the rows that
 * reach it, and a join that finds no pair meets none (measured: an inner join of an unnumbered row answered no row).
 *
 * WHICH REFERENCES (`numberable`): the two columns' types must compare in the engine as Postgres compares them (uuid,
 * text and varchar, the integers), and the referenced key must be clearly larger than its number: a UUID, a text, a key
 * of several columns, or an integer key whose range is at least `SPARSE_RANGE` times its rows (snowflake ids, a sparse
 * sequence). A dense integer key (a serial) is bit-packed by the engine to as few bits as its number would take, so its
 * join is already as cheap, and gets no hidden key. That never decides whether a reference is in the sources file.
 *
 * The one module that names the hidden columns and the dictionaries, decides which references are numbered and writes
 * their numbers. The listener learns of a numbered reference from the schema (`PgSchema.references`), once both its
 * hidden columns are there.
 */
import { createHash } from "node:crypto";
import type { DuckConnection } from "./executor.ts";
import { hiddenColumns } from "./hidden-columns.ts";

/** the hidden column's name prefix, and its pattern: what tells its kind among the columns a copy's record does not
 *  name (src/duck/hidden-columns.ts), never alone whether a column is hidden. Its first part names the dictionary that
 *  numbered it (`dictionaryOfColumn`), so the store alone says which dictionary a column's numbers are of */
export const NUMBER_PREFIX = "__mason_ref_";
export const NUMBER_RE = /^__mason_ref_([0-9a-f]{12})_[0-9a-f]{12}$/;
/** the schema of Mason's own tables (src/duck/store.ts MASON_SCHEMA), spelled here so this module needs no store */
const OWN_SCHEMA = "_mason";
/** a dictionary's table name prefix, in `_mason` */
export const DICTIONARY_PREFIX = "ref_keys_";

/** a referenced key's number for a NULL key (any of its columns NULL), and a referencing key's: never equal, so a NULL
 *  matches nothing, and never a dictionary's number (those start at 1) */
export const REFERENCED_NULL = -1;
export const REFERENCING_NULL = 0;

/**
 * A REFERENCED INTEGER KEY IS NUMBERED ONLY WHEN SPARSE: its range (max - min + 1) at least this many times its rows. The
 * engine bit-packs integers as an offset from their row group's minimum, so a dense key of N rows takes about log2(N)
 * bits a value, as its number would. At 64 times the number saves at least 6 bits a value. A 60-bit key over 5 M rows
 * took 0.79 GiB in 100 M orders, its numbers 0.31 GiB (docs/DESIGN.md "Joins on hidden integer keys"). The bound is a
 * choice, not a measured edge.
 */
export const SPARSE_RANGE = 64;

/** the rows a chunk of a fill numbers on one writer's turn (`fill`), and a side table's chunk (`fillSide`) */
export const FILL_CHUNK_ROWS = 2_000_000;


const SQL_TYPES: Record<string, string> = { uuid: "uuid", text: "text", "character varying": "text", bigint: "integer", integer: "integer", smallint: "integer" };
/** the family of a source type whose equality the engine computes as Postgres does, or null: uuid, text (and varchar,
 *  under a deterministic collation, which is byte equality), an integer. Not char(n) (its padding), citext, a domain */
export function keyFamily(type: string): Family | null {
  const f = SQL_TYPES[type.replace(/\(\d+\)$/, "")];
  return f === undefined ? null : f as Family;
}

/** a hidden column's name: its dictionary's hash (the part of `dictionary` after `DICTIONARY_PREFIX`), then a hash of
 *  what it numbers, hashed again with a count where the table (`columns`, the source's column names) holds a column of
 *  that name itself — as src/duck/scale-column.ts `scaleColumn` */
function hiddenName(dictionary: string, what: string, columns: readonly string[]): string {
  const taken = new Set(columns.map((c) => c.toLowerCase()));
  for (let n = 0; ; n++) {
    const name = `${NUMBER_PREFIX}${dictionary.slice(DICTIONARY_PREFIX.length)}_${createHash("sha256").update(n === 0 ? what : `${what}\u0000${n}`).digest("hex").slice(0, 12)}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/** the dictionary a hidden column's numbers are of (its name's first part), or null for a name not of one */
export function dictionaryOfColumn(name: string): string | null {
  const m = NUMBER_RE.exec(name);
  return m === null ? null : `${DICTIONARY_PREFIX}${m[1]}`;
}

/** a referenced key: its table (`schema.table`) and its columns */
export interface KeyOf { source: string; schema: string; table: string; columns: string[] }
/** one side of a numbered reference: its key and the hidden column holding its number */
export interface NumberedSide extends KeyOf { hidden: string }
/** A REFERENCE NUMBERED: the referencing side (`from`, `orders.customer_id`), the referenced side (`to`, `customers.id`)
 *  and the dictionary they share (`_mason.ref_keys_<hash>`, one per referenced key) */
export interface NumberedReference { from: NumberedSide; to: NumberedSide; dictionary: string; families: Family[] }
export type Family = "uuid" | "text" | "integer";
/** the engine's type a dictionary holds a family's values in: an integer of any width as a BIGINT, so a referencing
 *  bigint's value fits a referenced integer's dictionary */
const FAMILY_TYPE: Record<Family, string> = { uuid: "UUID", text: "VARCHAR", integer: "BIGINT" };

/** one side as the listener tells the plan of it (src/api/postgres/schema.ts `PgNumberedSide`) */
export interface ToldSide { schema: string; table: string; columns: string[]; hidden: string }
/** HOW THE LISTENER TELLS THE PLAN A REFERENCE IS NUMBERED (`userTypes`, src/api/postgres/server.ts): this prefix, then
 *  the JSON of its two sides (`numberedKey`, `numberedOf`) */
export const NUMBERED_KEY = "numbered:";
export const numberedKey = (r: { from: ToldSide; to: ToldSide }): string => `${NUMBERED_KEY}${JSON.stringify([r.from, r.to])}`;
/** a `numberedKey`'s sides, or null for any other key */
export function numberedOf(key: string): { from: ToldSide; to: ToldSide } | null {
  if (!key.startsWith(NUMBERED_KEY)) return null;
  const parts = JSON.parse(key.slice(NUMBERED_KEY.length)) as unknown;
  const side = (x: unknown): x is ToldSide => typeof x === "object" && x !== null && typeof (x as ToldSide).schema === "string" && typeof (x as ToldSide).table === "string"
    && typeof (x as ToldSide).hidden === "string" && Array.isArray((x as ToldSide).columns) && (x as ToldSide).columns.every((c) => typeof c === "string");
  if (!Array.isArray(parts) || parts.length !== 2 || !side(parts[0]) || !side(parts[1])) return null;
  return { from: parts[0], to: parts[1] };
}

/** a numbered reference as the rewrite reads it: each side's table, its key's columns by the catalog's numbers (in the
 *  reference's order) and its hidden column */
export interface NumberedRead { schema: string; table: string; attnos: number[]; hidden: string }
/** THE NUMBERED REFERENCES A STATEMENT MAY JOIN ON (src/duck/plan.ts `numberedLookup`), by the catalog's OIDs */
export interface NumberedLookup {
  /** the references from the table `fromRelid` (the referencing side) to the table `toRelid` */
  between(fromRelid: number, toRelid: number): ReadonlyArray<{ from: NumberedRead; to: NumberedRead }>;
}

/** Postgres's equality operators whose answer the engine's `=` gives for the families numbered (`keyFamily`): uuid,
 *  text (varchar's too), and every pair of integers. Text's compares bytes under every collation Mason answers: a
 *  nondeterministic one, whose `=` does not, is refused wherever a statement names it (src/duck/collation.ts) */
export const NUMBERED_EQUALITY = new Set([2972, 98, 94, 96, 410, 532, 533, 15, 416, 1862, 1868]);

/** the dictionary of a referenced key of these families: one per key and type, shared by every reference to it. A type
 *  changed at the source gives another dictionary, and so other hidden columns: a number is never read against a
 *  dictionary of other values */
export function dictionaryOf(to: KeyOf, families: readonly Family[]): string {
  return `${DICTIONARY_PREFIX}${createHash("sha256").update(`${to.source}\u0000${to.columns.join("\u0000")}\u0000\u0000${families.join("\u0000")}`).digest("hex").slice(0, 12)}`;
}

/** the table a reference is drawn over, as the sync holds it: its source columns and their types, and its foreign keys */
export interface ReferencingTable {
  source: string; schema: string; table: string;
  columns: ReadonlyArray<{ name: string; type: string }>;
  fileReferences?: ReadonlyArray<{ columns: string[]; table: string; targetColumns: string[] }> | undefined;
}

/**
 * THE REFERENCES A SET OF TABLES CAN NUMBER (`numberable`): each `references:` entry between two of them whose columns'
 * types compare as Postgres's do pairwise (`keyFamily`). Whether an integer key is sparse enough is decided apart, from
 * the referenced table's synced data (`sparseSql`): `integerKey` says which need it.
 */
export function numberable(tables: readonly ReferencingTable[]): Array<NumberedReference & { integerKey: boolean }> {
  const bySource = new Map(tables.map((t) => [t.source, t]));
  const out: Array<NumberedReference & { integerKey: boolean }> = [];
  const seen = new Set<string>();
  for (const t of tables) {
    for (const r of t.fileReferences ?? []) {
      const p = bySource.get(r.table);
      if (p === undefined || r.columns.length === 0 || r.columns.length !== r.targetColumns.length) continue;
      const families = r.columns.map((c, i) => {
        const a = t.columns.find((x) => x.name === c), b = p.columns.find((x) => x.name === r.targetColumns[i]);
        if (a === undefined || b === undefined) return null;
        const fa = keyFamily(a.type), fb = keyFamily(b.type);
        return fa !== null && fa === fb ? fa : null;
      });
      if (families.some((f) => f === null)) continue;
      const id = `${t.source}\u0000${r.columns.join("\u0000")}\u0000${p.source}\u0000${r.targetColumns.join("\u0000")}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const to: KeyOf = { source: p.source, schema: p.schema, table: p.table, columns: [...r.targetColumns] };
      const from: KeyOf = { source: t.source, schema: t.schema, table: t.table, columns: [...r.columns] };
      const dictionary = dictionaryOf(to, families as Family[]);
      out.push({
        to: { ...to, hidden: hiddenName(dictionary, `to\u0000${to.source}\u0000${to.columns.join("\u0000")}`, p.columns.map((c) => c.name)) },
        from: { ...from, hidden: hiddenName(dictionary, `from\u0000${to.source}\u0000${to.columns.join("\u0000")}\u0000${from.source}\u0000${from.columns.join("\u0000")}`, t.columns.map((c) => c.name)) },
        dictionary,
        families: families as Family[],
        integerKey: families.length === 1 && families[0] === "integer",
      });
    }
  }
  return out;
}

const ident = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const tableSql = (schema: string, table: string): string => `${ident(schema)}.${ident(table)}`;
const dictionarySql = (d: string): string => `${OWN_SCHEMA}.${ident(d)}`;
const keyCol = (i: number): string => ident(`k${i}`);

/** the read of an integer key's range against its rows, on its synced table: one row of count, min and max */
export function sparseSql(to: KeyOf): string {
  const c = ident(to.columns[0]!);
  return `SELECT count(${c}), min(${c}), max(${c}) FROM ${tableSql(to.schema, to.table)}`;
}
/** whether an integer key of these facts is sparse enough to number (`SPARSE_RANGE`); null: no rows yet to tell */
export function sparseEnough(count: bigint | number, min: bigint | number | null, max: bigint | number | null): boolean | null {
  const n = BigInt(count);
  if (n === 0n || min === null || max === null) return null;
  return BigInt(max) - BigInt(min) + 1n >= n * BigInt(SPARSE_RANGE);
}

/** the dictionary's table: the key's columns in their families' types, and each value's number */
export function dictionaryDdl(r: Pick<NumberedReference, "dictionary" | "families">): string {
  return `CREATE TABLE IF NOT EXISTS ${dictionarySql(r.dictionary)} (${r.families.map((f, i) => `${keyCol(i)} ${FAMILY_TYPE[f]}`).join(", ")}, num BIGINT NOT NULL)`;
}

/** the engine types a family's key column may have in a copy: each compared with its dictionary's column with no cast
 *  that can fail (an integer widened to the dictionary's BIGINT) */
const ENGINE_TYPES: Record<Family, readonly string[]> = { uuid: ["UUID"], text: ["VARCHAR"], integer: ["TINYINT", "SMALLINT", "INTEGER", "BIGINT"] };

/** a table's columns as the engine holds them now (`table` as SQL names it), each with its type, read on `c`: in the
 *  caller's transaction when it has one, so what the store holds there, never what an earlier read found */
export async function engineColumns(c: DuckConnection, table: string): Promise<Map<string, string>> {
  const r = await c.runAndReadAll(`SELECT * FROM ${table} LIMIT 0`);
  return new Map(r.columnNames.map((n, i) => [n, r.columnType(i).toString()]));
}

/** whether the store holds `r`'s dictionary, of the types its families give, read on `c` */
async function dictionaryThere(c: DuckConnection, r: Pick<NumberedReference, "dictionary" | "families">): Promise<boolean> {
  const types = (await c.runAndReadAll(`SELECT data_type FROM duckdb_columns() WHERE database_name = current_database() AND schema_name = '${OWN_SCHEMA}' ` +
    `AND table_name = '${r.dictionary}' ORDER BY column_index`)).getRowsJS().map((x) => String(x[0]));
  const want = [...r.families.map((f) => FAMILY_TYPE[f]), "BIGINT"];
  return types.length === want.length && types.every((x, i) => x === want[i]);
}

/** whether a table whose columns are `columns` (`engineColumns`) can have `side`'s numbers written: its hidden column
 *  there, and each key column of the type its family gives */
function fits(r: Pick<NumberedReference, "families">, side: Pick<Side, "columns" | "hidden">, columns: ReadonlyMap<string, string>): boolean {
  return columns.has(side.hidden) && side.columns.every((c, i) => ENGINE_TYPES[r.families[i]!].includes(columns.get(c) ?? ""));
}

/** one side's key columns, the hidden column holding their number, and a NULL key's number */
export interface Side { schema: string; table: string; source: string; columns: readonly string[]; hidden: string; nullNumber: number }
/** a reference's two sides: the referenced one first */
export const sidesOf = (r: NumberedReference): [Side, Side] => [
  { ...r.to, nullNumber: REFERENCED_NULL },
  { ...r.from, nullNumber: REFERENCING_NULL },
];

/** the temp table a fill reads the keys of one table's unnumbered rows into */
const UNNUMBERED_TEMP = "__mason_unnumbered";

/**
 * NUMBERS A TABLE'S UNNUMBERED ROWS FOR ONE SIDE, in the caller's transaction, ON THE WRITER — the only connection that
 * gives a value a number, so the dictionary never holds one value twice: the distinct keys of its unnumbered rows read,
 * those new to the dictionary given the next numbers, then every unnumbered row its key's number, joined on the key's
 * own columns (a NULL key its side's NULL number). `range` narrows the rows to row ids [lo, hi). Answers the rows
 * numbered. Never a join on the row id: the engine's join filter on a row id read past the scan's vector (measured:
 * DuckDB 2.0.0 crashed the process in 1 run of 4 of a stream's batch, heap corruption)
 */
export async function numberRows(w: DuckConnection, r: NumberedReference, side: Side, range?: readonly [number, number]): Promise<number> {
  const table = tableSql(side.schema, side.table);
  const within = range === undefined ? "" : ` AND t.rowid >= ${range[0]} AND t.rowid < ${range[1]}`;
  const unnumbered = `t.${ident(side.hidden)} IS NULL${within}`;
  const present = side.columns.map((c) => `t.${ident(c)} IS NOT NULL`).join(" AND ");
  // the distinct keys of its unnumbered rows, none NULL
  const keys = side.columns.map((c, i) => `t.${ident(c)} AS ${keyCol(i)}`).join(", ");
  const n = Number((await w.run(`CREATE OR REPLACE TEMP TABLE ${UNNUMBERED_TEMP} AS SELECT DISTINCT ${keys} FROM ${table} AS t WHERE ${unnumbered} AND ${present}`)).rowsChanged);
  let numbered = 0;
  if (n > 0) {
    const on = side.columns.map((_, i) => `d.${keyCol(i)} = u.${keyCol(i)}`).join(" AND ");
    const list = side.columns.map((_, i) => keyCol(i)).join(", ");
    const d = dictionarySql(r.dictionary);
    // its values new to the dictionary, numbered after its last
    await w.run(`INSERT INTO ${d} SELECT ${list}, (SELECT coalesce(max(num), 0) FROM ${d}) + row_number() OVER () FROM ` +
      `(SELECT ${side.columns.map((_, i) => `u.${keyCol(i)}`).join(", ")} FROM ${UNNUMBERED_TEMP} u WHERE NOT EXISTS (SELECT 1 FROM ${d} d WHERE ${on})) AS u`);
    // each row its key's number: the keys and numbers of the batch (its own key's values, so its own types) the small side
    const match = side.columns.map((c, i) => `t.${ident(c)} = n.${keyCol(i)}`).join(" AND ");
    numbered += Number((await w.run(`UPDATE ${table} AS t SET ${ident(side.hidden)} = n.num FROM (SELECT ${side.columns.map((_, i) => `u.${keyCol(i)}`).join(", ")}, d.num ` +
      `FROM ${UNNUMBERED_TEMP} u JOIN ${d} d ON ${on}) AS n WHERE ${unnumbered} AND ${match}`)).rowsChanged);
  }
  await w.run(`DROP TABLE ${UNNUMBERED_TEMP}`);
  // a NULL key (any of its columns NULL): its side's NULL number
  numbered += Number((await w.run(`UPDATE ${table} AS t SET ${ident(side.hidden)} = ${side.nullNumber} WHERE ${unnumbered} AND NOT (${present})`)).rowsChanged);
  return numbered;
}

/**
 * A SIDE TABLE'S NUMBERS, BEFORE ITS SWAP, on the rebuilds' connection (`table` the side table): the hidden column added,
 * and every row whose key the dictionary has numbered, a chunk at a time — the dictionary only READ here, never given a
 * value (the writer alone gives numbers). A key new to it is left unnumbered, numbered on the writer's turn after the
 * swap (`ReferenceNumbers.fill`). `run` is the sync's interruptible statement. Numbered only where the store holds the
 * dictionary and the side table's key columns are of its types (`fits`): else every row is left unnumbered, and a join
 * on it reads the keys. Answers whether its rows were numbered.
 */
export async function numberSideTable(c: DuckConnection, r: NumberedReference, side: Side, table: string, run: (sql: string) => Promise<number>): Promise<boolean> {
  await c.run(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${ident(side.hidden)} BIGINT`);
  if (!fits(r, side, await engineColumns(c, table)) || !await dictionaryThere(c, r)) return false;
  const end = Number((await c.runAndReadAll(`SELECT coalesce(max(rowid), -1) + 1 FROM ${table}`)).getRowsJS()[0]![0]);
  const all = side.columns.map((col) => `t.${ident(col)} IS NOT NULL`).join(" AND ");
  const on = side.columns.map((col, i) => `d.${keyCol(i)} = t.${ident(col)}`).join(" AND ");
  for (let lo = 0; lo < end; lo += FILL_CHUNK_ROWS) {
    const within = `t.rowid >= ${lo} AND t.rowid < ${lo + FILL_CHUNK_ROWS} AND t.${ident(side.hidden)} IS NULL`;
    await run(`UPDATE ${table} AS t SET ${ident(side.hidden)} = d.num FROM ${dictionarySql(r.dictionary)} d WHERE ${within} AND ${on}`);
    await run(`UPDATE ${table} AS t SET ${ident(side.hidden)} = ${side.nullNumber} WHERE ${within} AND NOT (${all})`);
  }
  return true;
}

/**
 * THE CHECK A STATEMENT THAT JOINS ON NUMBERS MAKES FIRST, IN THE TRANSACTION IT THEN RUNS IN (src/duck/store.ts
 * `numbersHold`): one row, TRUE when a row of a table it reads numbers of is not numbered. A hidden column gone (its
 * table synced again) fails it, which runs the statement as it was written too. A row group whose statistics say its
 * hidden column holds no NULL is skipped, so it reads only the rows written since the last fill (0.2 ms over 100 M
 * numbered rows, measured).
 */
export function unnumberedSql(sides: ReadonlyArray<{ schema: string; table: string; hidden: string }>): string {
  const unique = [...new Map(sides.map((s) => [JSON.stringify([s.schema, s.table, s.hidden]), s])).values()];
  return `SELECT ${unique.map((s) => `EXISTS (SELECT 1 FROM ${tableSql(s.schema, s.table)} WHERE ${ident(s.hidden)} IS NULL)`).join(" OR ")}`;
}

/** what the numbering asks of the sync (src/duck/sync.ts) */
export interface NumberingHost {
  /** the table is being rebuilt, compacted or caught up: never numbered beside that */
  busy(source: string): boolean;
  /** the source columns its copy records (src/duck/hidden-columns.ts), or undefined while it is not served */
  recorded(source: string): readonly string[] | undefined;
  log(line: string): void;
  /** an error as a log line may say it (src/duck/sync.ts `errorText`) */
  errorText(e: unknown): string;
}

/**
 * THE SYNC'S NUMBERING (`Sync.numbers`): which references are numbered; their dictionaries and hidden columns made and
 * dropped on the writer's turn (`ensure`); their rows numbered in a write's own transaction (`fillIn`), on a writer's
 * turn of their own (`fill`), and in a side table before its swap (`fillSide`).
 */
export class ReferenceNumbers {
  private readonly host: NumberingHost;
  /** the references the tables draw that can be numbered, an integer key's sparseness aside */
  private candidates: Array<NumberedReference & { integerKey: boolean }> = [];
  /** an integer key's decision, by its dictionary: numbered (sparse) or not (dense), once its table has rows */
  private readonly sparse = new Map<string, boolean>();
  /** each served table's hidden number columns, as the last `ensure` found them; a table swapped since is forgotten.
   *  What the schema offers the rewrite (`published`), never what decides a write: a write reads the store */
  private readonly present = new Map<string, Set<string>>();
  /** the dictionaries the store held at the last `ensure`, for `published` alone, as `present` */
  private readonly dictionaries = new Set<string>();
  /** the tables written since their rows were last numbered (`fill`) */
  private readonly dirty = new Set<string>();
  /** each numbered reference said once a run, when its hidden keys are first whole */
  private readonly said = new Set<string>();
  constructor(host: NumberingHost) { this.host = host; }

  /** the tables the sync keeps: their references read again (`ensure` makes and drops what changed) */
  set(tables: readonly ReferencingTable[]): void {
    this.candidates = numberable(tables);
    for (const r of this.candidates) { this.dirty.add(r.from.source); this.dirty.add(r.to.source); }
  }

  /** the references numbered now: every candidate but an integer key not known to be sparse */
  wanted(): NumberedReference[] {
    return this.candidates.filter((r) => !r.integerKey || this.sparse.get(r.dictionary) === true).map(({ integerKey: _i, ...r }) => r);
  }

  /** the sides a table holds a hidden number column for, one a column (a key several references reference is one) */
  sidesIn(source: string): Array<{ r: NumberedReference; side: Side }> {
    const out = new Map<string, { r: NumberedReference; side: Side }>();
    for (const r of this.wanted()) {
      const [to, from] = sidesOf(r);
      if (to.source === source && !out.has(to.hidden)) out.set(to.hidden, { r, side: to });
      if (from.source === source && !out.has(from.hidden)) out.set(from.hidden, { r, side: from });
    }
    return [...out.values()];
  }

  /** a table was written: its unnumbered rows are numbered at the next fill */
  written(source: string): void { if (this.candidates.some((r) => r.from.source === source || r.to.source === source)) this.dirty.add(source); }

  /** a table swapped or dropped: its hidden columns are found again at the next `ensure` */
  forget(source: string): void { this.present.delete(source); this.written(source); }

  /**
   * ON THE WRITER'S TURN: an integer key's sparseness read once its table has rows, every dictionary made, every served
   * table given the hidden columns it lacks (with no default: its NULL is "not numbered", and an ADD COLUMN writes no row)
   * and its hidden number columns that no reference numbers now dropped. Never a table being rebuilt. A dictionary no
   * reference numbers now is dropped once no table of the store holds a column of its numbers (`dictionaryOfColumn`): a
   * busy table's, a side table's. So a dictionary is never dropped and made again under numbers it gave, and a number
   * always reads against the dictionary that gave it. Answers whether a hidden column was added or dropped (the
   * catalog's schema is built again).
   */
  async ensure(w: DuckConnection): Promise<boolean> {
    for (const r of this.candidates) {
      if (!r.integerKey || this.sparse.has(r.dictionary) || this.host.recorded(r.to.source) === undefined || this.host.busy(r.to.source)) continue;
      const [count, min, max] = (await w.runAndReadAll(sparseSql(r.to))).getRowsJS()[0] as [bigint, bigint | number | null, bigint | number | null];
      const verdict = sparseEnough(count, min, max);
      if (verdict === null) continue;
      this.sparse.set(r.dictionary, verdict);
      if (!verdict) this.host.log(`${r.from.source} (${r.from.columns.join(", ")}) references ${r.to.source} (${r.to.columns.join(", ")}), a dense integer key: its joins read the key itself, which is as small as a hidden key would be`);
    }
    const wanted = this.wanted();
    let changed = false;
    // every table's columns as the engine holds them, its hidden number columns among them
    const physical = new Map<string, string[]>();
    for (const [table, column] of (await w.runAndReadAll(`SELECT schema_name || '.' || table_name, column_name FROM duckdb_columns() WHERE database_name = current_database() ` +
      `AND schema_name <> '${OWN_SCHEMA}' ORDER BY table_oid, column_index`)).getRowsJS() as Array<[string, string]>) {
      const cols = physical.get(table) ?? [];
      cols.push(column);
      physical.set(table, cols);
    }
    for (const r of wanted) await w.run(dictionaryDdl(r));
    // the dictionaries whose numbers a column of the store still holds, as it is after the drops below
    const named = new Set<string>();
    this.present.clear();
    for (const [source, cols] of physical) {
      const recorded = this.host.recorded(source);
      // a table not served (a side table, a table being added): every column of a hidden key's name keeps its dictionary
      if (recorded === undefined) {
        for (const c of cols) { const d = dictionaryOfColumn(c); if (d !== null) named.add(d); }
        continue;
      }
      // a column is hidden only where the copy's record does not name it (src/duck/hidden-columns.ts, issue 998)
      const here = new Set(hiddenColumns(cols, recorded).filter((h) => h.kind === "number").map((h) => h.name));
      const want = this.sidesIn(source).map((s) => s.side.hidden);
      if (!this.host.busy(source)) {
        const target = tableSql(source.slice(0, source.indexOf(".")), source.slice(source.indexOf(".") + 1));
        for (const h of [...here].filter((x) => !want.includes(x))) {
          await w.run(`ALTER TABLE ${target} DROP COLUMN ${ident(h)}`);
          here.delete(h);
          changed = true;
          this.host.log(`${source}: dropped its hidden key ${h}: no reference the sources file names reads it now`);
        }
        for (const h of want.filter((x) => !here.has(x))) {
          await w.run(`ALTER TABLE ${target} ADD COLUMN ${ident(h)} BIGINT`);
          here.add(h);
          changed = true;
          this.dirty.add(source);
        }
      }
      for (const h of here) { const d = dictionaryOfColumn(h); if (d !== null) named.add(d); }
      this.present.set(source, here);
    }
    // the dictionaries no reference numbers now, and no column holds numbers of
    this.dictionaries.clear();
    for (const [name] of (await w.runAndReadAll(`SELECT table_name FROM duckdb_tables() WHERE database_name = current_database() AND schema_name = '${OWN_SCHEMA}' AND starts_with(table_name, '${DICTIONARY_PREFIX}')`)).getRowsJS() as Array<[string]>) {
      if (wanted.some((r) => r.dictionary === name) || named.has(name)) { this.dictionaries.add(name); continue; }
      await w.run(`DROP TABLE ${dictionarySql(name)}`);
    }
    return changed;
  }

  /** the references both of whose hidden columns are there, and their dictionary, as the last `ensure` found them: which
   *  the schema offers the rewrite. A statement that joins on them checks the store first (`unnumberedSql`) */
  published(): NumberedReference[] {
    return this.wanted().filter((r) => this.dictionaries.has(r.dictionary) && this.present.get(r.from.source)?.has(r.from.hidden) === true && this.present.get(r.to.source)?.has(r.to.hidden) === true);
  }

  /** whether a fill has rows to number */
  due(): boolean { return this.dirty.size > 0; }

  /**
   * THE SIDES OF `source` WHOSE ROWS CAN BE NUMBERED NOW, decided from the store on `w`, in the caller's transaction: the
   * table not busy, its hidden column there, its key columns of the types their families give, and the dictionary there
   * of those types (`fits`, `dictionaryThere`). Never from what an earlier `ensure` found, which a swap or a compaction
   * since can have made wrong.
   */
  private async writable(w: DuckConnection, source: string): Promise<Array<{ r: NumberedReference; side: Side }>> {
    if (this.host.busy(source) || this.host.recorded(source) === undefined) return [];
    const sides = this.sidesIn(source);
    if (sides.length === 0) return [];
    const columns = await engineColumns(w, tableSql(sides[0]!.side.schema, sides[0]!.side.table));
    const out: Array<{ r: NumberedReference; side: Side }> = [];
    for (const s of sides) if (fits(s.r, s.side, columns) && await dictionaryThere(w, s.r)) out.push(s);
    return out;
  }

  /**
   * IN THE CALLER'S TRANSACTION, ON THE WRITER: `source`'s unnumbered rows numbered (a stream batch's, a writer's poll's),
   * so they commit numbered. Answers the rows numbered.
   */
  async fillIn(w: DuckConnection, source: string): Promise<number> {
    let n = 0;
    for (const { r, side } of await this.writable(w, source)) n += await numberRows(w, r, side);
    return n;
  }

  /**
   * AN UPDATE IN PLACE OF `target` THAT SETS `set` (src/duck/sync.ts `updateCarried`), `own` its source columns: each
   * hidden key the table holds whose key columns it sets made unnumbered, as assignments of its UPDATE, so the write's
   * `fillIn` numbers it again by its new key. Decided from the store on `w`, in the write's own transaction: the hidden
   * columns the table holds now, whatever an earlier `ensure` found. One whose key columns this Mason does not know (no
   * reference numbers it now) is made unnumbered by every such write.
   */
  async unnumberedSet(w: DuckConnection, source: string, target: string, own: readonly string[], set: readonly string[]): Promise<string[]> {
    if (set.length === 0) return [];
    const held = hiddenColumns([...(await engineColumns(w, target)).keys()], own).filter((h) => h.kind === "number");
    if (held.length === 0) return [];
    const known = new Map(this.sidesIn(source).map((s) => [s.side.hidden, s.side.columns]));
    return held.filter((h) => known.get(h.name)?.some((c) => set.includes(c)) ?? true).map((h) => `${ident(h.name)} = NULL`);
  }

  /**
   * ON THE WRITER'S TURN, IN A TRANSACTION OF ITS OWN: up to `FILL_CHUNK_ROWS` of each written table's unnumbered rows
   * numbered, the rest left for the next turn. Answers whether rows are left, and how many it numbered.
   */
  async fill(w: DuckConnection): Promise<{ left: boolean; numbered: number }> {
    let left = false, numbered = 0;
    for (const source of [...this.dirty]) {
      if (this.host.recorded(source) === undefined) { this.dirty.delete(source); continue; }
      if (this.host.busy(source)) { left = true; continue; }
      let more = false;
      await w.run("BEGIN TRANSACTION");
      try {
        for (const { r, side } of await this.writable(w, source)) {
          const table = tableSql(side.schema, side.table);
          const from = (await w.runAndReadAll(`SELECT min(rowid) FROM ${table} WHERE ${ident(side.hidden)} IS NULL`)).getRowsJS()[0]![0];
          if (from === null || from === undefined) continue;
          const lo = Number(from);
          numbered += await numberRows(w, r, side, [lo, lo + FILL_CHUNK_ROWS]);
          if ((await w.runAndReadAll(`SELECT EXISTS (SELECT 1 FROM ${table} WHERE ${ident(side.hidden)} IS NULL)`)).getRowsJS()[0]![0] === true) more = true;
        }
        await w.run("COMMIT");
      } catch (e) {
        await w.run("ROLLBACK");
        throw e;
      }
      if (more) left = true; else this.dirty.delete(source);
    }
    for (const r of this.published()) {
      const key = `${r.from.source}\u0000${r.from.hidden}`;
      if (this.said.has(key) || this.dirty.has(r.from.source) || this.dirty.has(r.to.source)) continue;
      this.said.add(key);
      this.host.log(`${r.from.source} (${r.from.columns.join(", ")}) references ${r.to.source} (${r.to.columns.join(", ")}): a join on it reads hidden integer keys`);
    }
    return { left, numbered };
  }

  /**
   * A SIDE TABLE'S NUMBERS, BEFORE ITS SWAP, on the rebuilds' connection (src/duck/sync.ts `copy`): every hidden number
   * column its table holds for a reference numbered now, added and filled from the dictionaries as the store holds them
   * (`numberSideTable`). A side whose key columns or dictionary are not of its types is left unnumbered. Its numbering
   * never fails the sync: a failure (`stopping` aside, the sync's stop) drops the side's hidden column, so no number it
   * wrote outlives it, and the writer adds it again after the swap. `run` is the sync's interruptible statement.
   */
  async fillSide(c: DuckConnection, source: string, side: string, run: (sql: string) => Promise<number>, stopping: (e: unknown) => boolean): Promise<void> {
    // (`side` is the side table as SQL names it, src/duck/sync.ts `copy`)
    for (const { r, side: s } of this.sidesIn(source)) {
      try {
        if (!await numberSideTable(c, r, s, side, run)) this.host.log(`${source}: its hidden key ${s.hidden} is left unnumbered at its sync: its dictionary is not made yet, or its key's columns are not of its types`);
      } catch (e) {
        if (stopping(e)) throw e;
        // tolerable: a join on it reads the keys until the writer numbers it after the swap. The column goes, with what
        // it holds, and a failure of that fails the sync as before
        await c.run(`ALTER TABLE ${side} DROP COLUMN IF EXISTS ${ident(s.hidden)}`);
        this.host.log(`${source}: its hidden key ${s.hidden} could not be numbered at its sync, and is numbered after the swap: ${this.host.errorText(e)}`);
      }
    }
  }
}
