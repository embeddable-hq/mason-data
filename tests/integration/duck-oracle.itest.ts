/**
 * THE DUCKDB ORACLE (docs/DESIGN.md): Mason's DuckDB-backed Postgres endpoint must answer EVERY statement
 * EXACTLY as the Postgres it copies from — the same column names, the same type OIDs, the same text, the same rows in
 * the same order, the same refusal (SQLSTATE) — because a customer's BI tool sends it the SQL it sends Postgres, and
 * reads the answer as Postgres's.
 *
 * The endpoint runs Postgres SQL as written, so the SAME TEXT goes to both and the answers are diffed. What is asked,
 * and over what:
 *  - THE ORACLE'S ADVERSARIAL DATA (oracle/data.ts: NULL beside '' beside a value, case variants, ties, bucket
 *    boundaries, 1970 and the far future, negatives, float-unfriendly decimals) in a fresh database of
 *    IT_POSTGRES_URL's server, added to a DuckDB store by the real copy (src/duck/sync.ts) and served by the real
 *    listener (src/api/postgres/server.ts with `duck`);
 *  - THE DIALECT CASES (postgres-cases.ts: ~250 expressions over edge-case literals, and whole statements over literal
 *    rows), each made to read a copied one-row table so DuckDB answers it (a statement that reads no table is the
 *    catalog Postgres's own answer, Postgres's by construction);
 *  - THE BI SHAPES (oracle/bi-shapes.ts): the structures saved reports use most that nothing above generates;
 *  - THE TYPE MATRIX (oracle/type-matrix.ts): every common column type sorted, grouped, compared, computed, cast and
 *    aggregated, over edge values (NaN, infinities, -0, a bigint past 2^53);
 *  - THE GAP CASES (oracle/gap-cases.ts): one statement for each entry of src/duck/gaps.ts nothing else meets;
 *  - every copied table, whole, as text: the copy itself is held to the source;
 * after the first copy, and again after each round of changes (oracle/data.ts `mutations`) the poll carries. After
 * the copy, each statement both answered alike is asked again in THE SHAPES a tool wraps it in (oracle/shapes.ts: a
 * subquery, a CTE, a UNION ALL, its filter's values as parameters, its columns by Postgres's names, its ORDER BY
 * outside the derived table; `IT_ORACLE_SHAPES=0` leaves them out).
 *
 * WHAT THE STATEMENTS ANSWERED ALIKE ARE MADE OF is what the endpoint admits (src/duck/verified.ts, rewritten by
 * `UPDATE_VERIFIED=1`; anything else is refused): this test fails while the file is not exactly that.
 *
 * A difference is a defect to fix, or a DECIDED one in `KNOWN` naming its `differs` gap, which must still differ in the
 * kind decided; a refusal where Postgres answers must name a `refused` gap, and a gap none of the statements meets is
 * dead (docs/SQL-SUPPORT.md). Every difference is written to `IT_LOG_DIR` (default: the OS temp dir) `duck-oracle-differences.txt`.
 *
 * Needs IT_POSTGRES_URL (any wal_level; a database of its own is created and dropped), psql on PATH, and DuckDB's
 * postgres extension (downloaded once per machine).
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { DuckStore } from "../../src/duck/store.ts";
import { readLibcOrder } from "../../src/duck/libc-order.ts";
import { isLibcCollation, nodesPlacedTwice } from "../../src/duck/rewrite.ts";
import { Sync } from "../../src/duck/sync.ts";
import { startPostgresApi, type PgApiServer } from "../../src/api/postgres/server.ts";
import { connectSource, parseSource, readSourceFacts } from "../../src/cli/preflight.ts";
import { mutations, KEY_OF, SCHEMA, STAMPING, seed, TABLES } from "./oracle/data.ts";
import { normalise, same } from "./oracle/compare.ts";
import { CASES, MIXED_SCALE, QUERY_CASES, REFUSED_CASES, T, U, Z } from "./postgres-cases.ts";
import { BI_SHAPES, META } from "./oracle/bi-shapes.ts";
import { TYPE_MATRIX, TYPED, typedMutations } from "./oracle/type-matrix.ts";
import { GAP_CASES } from "./oracle/gap-cases.ts";
import { staleDecisions, type Decided } from "./oracle/known.ts";
import { shapes as shapesOf } from "./oracle/shapes.ts";
import { VERIFIED } from "../../src/duck/verified.ts";
import { describeKeys } from "../../src/duck/resolved.ts";
import { GAP_MARK, GAPS, type GapId } from "../../src/duck/gaps.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const adminUrl = process.env.IT_POSTGRES_URL;
/** a regular expression over the statements' names: only those run (a fix's check, minutes faster than all of them) */
const ONLY = process.env.IT_ORACLE_ONLY === undefined ? null : new RegExp(process.env.IT_ORACLE_ONLY);
/** `IT_ORACLE_SHAPES=0` leaves the shape multiplier out (oracle/shapes.ts): a quicker run while fixing one statement */
const SHAPES = process.env.IT_ORACLE_SHAPES !== "0";
/** `IT_ORACLE_JSON_PATHS=eager` stores every JSON path a statement reads before it is planned (src/duck/kept.ts, the
 *  test's own option): every such read is then answered from its stored column, and must still answer as Postgres */
const EAGER_JSON = process.env.IT_ORACLE_JSON_PATHS === "eager";
/** the DuckDB-alone pass's tallies (`duckdbAlone`, below): what README.md's comparison renders (tests/duck-gaps.test.ts) */
const ALONE_FIXTURE = path.join(REPO, "tests", "fixtures", "oracle-duckdb-alone.json");
const UPDATE_FIXTURE = process.env.UPDATE_FIXTURE === "1";
// the DuckDB-alone pass reads a timestamptz's JSON text in the process's zone (the client's conversion, not DuckDB's
// answer): UTC, as the session's TimeZone is, so that pass is not charged for the machine's clock
process.env.TZ = "UTC";
const tag = `it_duckoracle_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const dbUrl = adminUrl ? (() => { const u = new URL(adminUrl); u.pathname = `/${tag}`; return u.toString(); })() : "";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "it-duck-oracle-"));
const report = path.join(process.env.IT_LOG_DIR ?? os.tmpdir(), "duck-oracle-differences.txt");

function psql(url: string, sql: string): string {
  const r = spawnSync("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", url], { input: sql, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim()}\n  in: ${sql.slice(0, 300)}`);
  return r.stdout.trim();
}

/** every table the oracle copies: the shop's, `one`, and the type matrix's (oracle/type-matrix.ts TYPED) */
const COPIED = [...TABLES, "one", "typed", "typed_arrays", "castable", "cased", "jcased", "coll", "moods", "defaults", "late", "late_c", "instants", "docs", "nullish", "jorder", "keyed", "pairs"];

/** the one-row table every dialect case reads, so DuckDB (not the catalog Postgres) answers it */
const ONE = "CREATE TABLE public.one (id int PRIMARY KEY); INSERT INTO public.one VALUES (1);";
/** a relation of literal rows, read through `one`: `(…) AS t` becomes `(SELECT t.* FROM public.one CROSS JOIN (…) AS t) AS t` */
const viaOne = (rel: string): string => {
  const alias = /\) AS (\w+)$/.exec(rel)?.[1];
  assert.ok(alias, `a relation of literal rows ends with its alias: ${rel.slice(-40)}`);
  return `(SELECT ${alias}.* FROM public.one CROSS JOIN ${rel}) AS ${alias}`;
};
const throughOne = (sql: string): string => sql.replaceAll(T, viaOne(T)).replaceAll(U, viaOne(U)).replaceAll(Z, viaOne(Z));

type Answer = { names: string[]; oids: number[]; rows: (string | null)[][] } | { code: string; message: string; detail?: string | undefined };
const raw = { getTypeParser: () => (v: string) => v };
async function ask(c: pg.Client, sql: string, values?: string[]): Promise<Answer> {
  try {
    const r = await c.query({ text: sql, ...(values === undefined ? {} : { values }), rowMode: "array", types: raw } as pg.QueryConfig);
    return { names: r.fields.map((f) => f.name), oids: r.fields.map((f) => f.dataTypeID), rows: r.rows as (string | null)[][] };
  } catch (e) {
    const d = e as pg.DatabaseError;
    if (d.code === undefined) throw e;
    return { code: d.code, message: d.message, detail: d.detail };
  }
}

/** a statement sorts its result when its OUTERMOST query has an ORDER BY (a parenthesised one inside does not count) */
const ordered = (sql: string): boolean => { let s = sql, prev = ""; while (s !== prev) { prev = s; s = s.replace(/\([^()]*\)/g, ""); } return /\border\s+by\b/i.test(s); };

/**
 * THE VERDICT ON ONE STATEMENT, as the kinds of difference a tool can see, worst first: a wrong VALUE (normalised as
 * the oracle does: `1.50` and `1.5` are one value), a different TEXT of the same value, a different TYPE (OID), a
 * different NAME, a refusal where Postgres answered (or the reverse, or another SQLSTATE). null when identical.
 */
export function verdict(want: Answer, got: Answer, inOrder: boolean): { kind: "value" | "rows" | "text" | "type" | "name" | "refused" | "answered" | "sqlstate"; detail: string } | null {
  if ("code" in want && "code" in got) return want.code === got.code ? null : { kind: "sqlstate", detail: `${got.code} ${got.message} where Postgres refuses ${want.code} ${want.message}` };
  if ("code" in want) return { kind: "answered", detail: `answered where Postgres refuses ${want.code} ${want.message}` };
  if ("code" in got) return { kind: "refused", detail: `${got.code} ${got.message}${got.detail ? ` (${got.detail})` : ""}` };
  if (want.rows.length !== got.rows.length) return { kind: "rows", detail: `${got.rows.length} row(s) where Postgres has ${want.rows.length}` };
  const key = (r: (string | null)[]): string => JSON.stringify(r);
  const sorted = (rs: (string | null)[][]): (string | null)[][] => [...rs].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  const [w, g] = inOrder ? [want.rows, got.rows] : [sorted(want.rows), sorted(got.rows)];
  let text: string | null = null;
  for (let i = 0; i < w.length; i++) {
    for (let j = 0; j < w[i]!.length; j++) {
      const a = w[i]![j]!, b = g[i]![j]!;
      if (a === b) continue;
      const loc = `row ${i + 1}, ${JSON.stringify(want.names[j])}: ${JSON.stringify(b)} where Postgres has ${JSON.stringify(a)}`;
      if (!same(normalise(a), normalise(b))) {
        // the rows may be the same SET in another order: a sort difference, not a value
        if (inOrder && key(sorted(w).flat()) === key(sorted(g).flat())) return { kind: "rows", detail: `the same rows in another ORDER (first at ${loc})` };
        return { kind: "value", detail: loc };
      }
      text ??= loc;
    }
  }
  if (text !== null) return { kind: "text", detail: text };
  const types = want.oids.map((o, i) => o === got.oids[i] ? null : `${JSON.stringify(want.names[i])} OID ${got.oids[i]} where Postgres sends ${o}`).filter((x) => x !== null);
  if (types.length) return { kind: "type", detail: types.join(", ") };
  if (want.names.join("\u0000") !== got.names.join("\u0000")) return { kind: "name", detail: `${JSON.stringify(got.names)} where Postgres names ${JSON.stringify(want.names)}` };
  return null;
}

/**
 * DECIDED DIFFERENCES: what the endpoint answers differently from Postgres on purpose, or cannot answer alike, each
 * with why. Each must STILL differ (a fixed one is removed), but one whose truth depends on the machine's floating-point
 * arithmetic (`machineFloat`, oracle/known.ts) may agree on this machine; nothing else may differ.
 */
const KNOWN: Decided[] = [
  // A NUMERIC COLUMN OF VALUES OF SEVERAL SCALES: Postgres keeps each value's (`1` beside `1.5`), a DuckDB DECIMAL
  // column has one (`1.0`). Only where values of two scales meet in ONE column — a UNION of an integer and a numeric,
  // a window function's default — which the exact programs (src/duck/rewrite.ts ExactColumn) cannot reach
  { sql: /^SELECT v FROM \(SELECT 1 AS v FROM public\.one UNION ALL SELECT 1\.5 FROM public\.one\)/, kind: "text", gap: "mixed-scale-numeric", why: "a DuckDB DECIMAL column has one scale; Postgres's numeric keeps each value's" },
  { sql: /^SELECT id AS v FROM \(SELECT t\.\* FROM public\.one CROSS JOIN \(SELECT 1 AS id, 'Ab' AS name, 1\.5 AS x/, kind: "text", gap: "mixed-scale-numeric", why: "an integer UNION ALL a numeric: Postgres's `1`, DuckDB's DECIMAL `1.0`" },
  { sql: /lead\(x, 1, 0\) OVER/, kind: "text", gap: "mixed-scale-numeric", why: "lead's default 0 beside numeric(2,1) values: Postgres's `0`, DuckDB's DECIMAL `0.0`" },
  // THE TYPE MATRIX'S DECIDED ONES (oracle/type-matrix.ts): what a double's bits, -0 and an overflow do
  { sql: /greatest\((\w+, f4|f4, \w+)\), least/, kind: "text", gap: "negative-zero", why: "least(-0, 0): Postgres keeps the first, DuckDB the other" },
  { sql: /percentile_disc\(0\.25\) WITHIN GROUP \(ORDER BY f[48]\)/, kind: "text", gap: "negative-zero", why: "percentile_disc picks -0 or 0 of equal values" },
  { sql: /stddev\(f4\)/, kind: "text", gap: "float-last-digit", why: "a float's stddev: Youngs-Cramer in Postgres, another accumulation in DuckDB" },
  // (a double's stddev, the 17th digit, differed after the polls' writes while the copy was in key order; now the
  // copy is in the heap's order and the oracle's rows meet DuckDB's accumulation in Postgres's order. A real heap's
  // updates may still part the two orders: float-last-digit says that last digit may differ). In that order it is
  // alike on aarch64, Linux or macOS, and differs on CI's x86_64 runner (variance 1.6935087641981325e+15 where Postgres
  // has …328e+15): the machine's arithmetic decides, so `machineFloat`. Its pieces are verified by the rounded one,
  // "stddev / variance of a double" (oracle/type-matrix.ts), alike on every machine
  { sql: /^SELECT stddev\(f8\), stddev_samp\(f8\), stddev_pop\(f8\), variance\(f8\), var_samp\(f8\), var_pop\(f8\) FROM typed/, kind: "text", gap: "float-last-digit", why: "a double's variance, the 17th digit: Youngs-Cramer in Postgres, DuckDB's accumulation, apart on x86_64", machineFloat: true },
  // (log10's last digit: it differs with Postgres in a Linux container and Mason on macOS, and agrees with both on
  // Linux, as in CI, or both on macOS: the machines' math libraries decide, so `machineFloat`)
  { sql: /sqrt\(abs\((i2|f4)\)\)/, kind: "text", gap: "float-last-digit", why: "log10's last digit: libm's against DuckDB's", machineFloat: true },
  { sql: /sqrt\(abs\((i4|i8|f8)\)\)/, kind: "answered", gap: "float-overflow", why: "exp past a double's range: Postgres's error, DuckDB's Infinity (or 0 below it)" },
  { sql: /stddev\(DISTINCT (i4|n2)\)|stddev\(n\)/, kind: "text", gap: "numeric-stddev", why: "Postgres's numeric stddev of DISTINCT values, or of an unconstrained numeric, is exact to its scale; DuckDB's a double" },
  { sql: /greatest\(ch, (t|vc)\)/, kind: "value", gap: "char-n-minmax", why: "least(char(5) '', text ''): Postgres compares without the padding" },
  { sql: /^SELECT min\(a \/ b\), max\(a \/ b\) FROM public\.one, \(VALUES/, kind: "text", gap: "min-max-scale-tie", why: "min of 0 / 7 and 0 / 1000000, equal values at two scales: Postgres keeps the last it reads, Mason the least operands" },
  { sql: /^SELECT x \* 2 FROM \(SELECT 7 \/ 3\.0 AS x/, kind: "text", gap: "nested-exact-numeric", why: "the subquery's 7 / 3.0 is DuckDB's double where the outer query computes with it" },
  { sql: /^SELECT upper\('\u{10D70}'\)/u, kind: "value", gap: "unicode-16-case", why: "a Garay letter (Unicode 16): DuckDB's ICU predates it" },
  { sql: /^SELECT l\.id, \(l\.j ->> 'n'\)::int, c\.name FROM late l LEFT JOIN late_c c ON c\.id = l\.c ORDER BY l\.k DESC LIMIT 3$/, kind: "answered", gap: "limit-errors", why: "row 2000's 'x' is no integer, and the limit leaves it out: Postgres sorts every row (no index on k) and raises, Mason computes the list for the kept rows" },
  { sql: /^SELECT x\.id, x\.e FROM \(SELECT s\.id, s\.e::text AS e FROM \(SELECT q\.id, e FROM docs q LEFT JOIN jsonb_array_elements\(.*\) e ON TRUE\) s WHERE s\.id > \$1\) x LIMIT/, kind: "value", gap: "limit-lateral-filter", why: "a parameter in the filter around the lateral: DuckDB plans the streamed UNNEST as a delimiter join, and the LIMIT keeps other rows (the same statement with the literal keeps Postgres's)" },
  { sql: /\), b AS \(SELECT \* FROM a WHERE a\.id > 3\) SELECT \* FROM b LIMIT 40 OFFSET 23$/, kind: "value", gap: "limit-lateral-filter", why: "a filter in the CTE that reads the lateral's CTE: DuckDB plans the streamed UNNEST as a delimiter join, and the LIMIT keeps other rows" },
  { sql: /^SELECT q\.id, d\.key FROM docs q LEFT JOIN jsonb_each\(.*\) d ON TRUE WHERE d\.key <> 'n' LIMIT 40$/, kind: "value", gap: "limit-lateral-filter", why: "a filter on the lateral's own column: DuckDB plans the streamed UNNEST as a delimiter join, and the LIMIT keeps other rows" },
  { sql: /^SELECT q\.id, d\.key, row_number\(\) OVER (\(PARTITION BY q\.id\)|w) AS r/, kind: "value", gap: "window-partition-order", why: "row_number / lag / first_value over PARTITION BY with no ORDER BY: DuckDB's partitioning hands a partition's rows back in its own order, streamed lateral or not" },
  { sql: /^SELECT s FROM coll WHERE id BETWEEN 50 AND 59 ORDER BY s$/, kind: "rows", gap: "libc-symbol-punctuation", why: "glibc's 1-X < 1x: punctuation after a digit outranks the case; Mason's 1x < 1-X" },
];

let server: PgApiServer | null = null;
let store: DuckStore | null = null;
let sync: Sync | null = null;
const clients: pg.Client[] = [];
after(async () => {
  for (const c of clients) await c.end().catch((e: Error) => console.error(`a client's end: ${e.message}`));
  if (server) await server.close();
  // the sync's next pass is a timer: left running, it holds the process open after a failed assertion
  await sync?.stop();
  store?.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (adminUrl) psql(adminUrl, `DROP DATABASE IF EXISTS ${tag} WITH (FORCE)`);
});

test("the DuckDB endpoint answers every statement exactly as Postgres does, before and after changes", { skip: adminUrl ? false : "IT_POSTGRES_URL is not set", timeout: 1_800_000 }, async () => {
  psql(adminUrl!, `CREATE DATABASE ${tag}`);
  psql(dbUrl, SCHEMA);
  const s = seed();
  psql(dbUrl, s.sql);
  psql(dbUrl, STAMPING);
  psql(dbUrl, ONE);
  psql(dbUrl, META);
  psql(dbUrl, TYPED);
  const collation = psql(dbUrl, "SELECT datcollate || ' (' || datlocprovider::text || ')' FROM pg_database WHERE datname = current_database()");
  console.log(`duck oracle: database ${tag}, collation ${collation}`);

  // ---- the copy and the listener, as `mason start` runs them ----------------------------------------------------
  const parsed = parseSource(dbUrl);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const conn = await connectSource(parsed.source);
  if ("failure" in conn) throw new Error(`connect: ${JSON.stringify(conn.failure)}`);
  const facts = await readSourceFacts(conn.pg);
  conn.pg.close();
  const added = facts.tables.filter((t) => COPIED.includes(t.table) && t.schema === "public");
  assert.equal(added.length, COPIED.length, `the oracle's tables in the catalog: ${facts.tables.map((t) => t.source).join(", ")}`);
  const log: string[] = [];
  store = await DuckStore.open(path.join(dir, "duck.db"), (l) => log.push(l));
  sync = new Sync(store, parsed.source, tag, (l) => log.push(l), 3_600_000, "poll", null, EAGER_JSON ? { json: { eager: true } } : {});
  await sync.open();
  sync.setTables(added);
  sync.setViews(facts.views ?? []);
  await sync.once();
  assert.deepEqual(sync.state().filter((x) => x.phase !== "copied").map((x) => `${x.source} ${x.phase} ${x.error}`), [], "every table copied");
  const theStore = store, theSync = sync;
  // WHAT EACH STATEMENT WAS MADE OF (src/duck/resolved.ts), recorded as it is planned — with nothing refused for being
  // unverified, since this run is what verifies it
  // a libc collation's order, read from the database as `mason start` reads it (src/duck/libc-order.ts)
  const coll = facts.collation;
  const libc = coll !== undefined && isLibcCollation(coll.provider, coll.collate) ? (await theStore.libcOrder(coll.collate, coll.version ?? null, async () => {
    const c = await connectSource(parsed.source);
    if ("failure" in c) throw new Error(`connect: ${JSON.stringify(c.failure)}`);
    try { return await readLibcOrder(async (sql) => (await c.pg.query(sql)).rows, coll.collate, coll.version ?? null); } finally { c.pg.close(); }
  })).order : undefined;
  // the stored JSON paths as mason start serves them (on by default): a `*` reads each copy's visible columns
  const duck = await theStore.listener(facts.collation, null, libc, () => [], theSync.kept);
  /**
   * DUCKDB ALONE (why a user would not just use DuckDB by itself): the same statement, as written, to
   * a plain connection of the same copy — no analysis, no rewrite, no Mason function — scored by the oracle's own
   * verdict (names, rows, text; the OIDs taken as Postgres's, since DuckDB has none). The tallies are
   * tests/fixtures/oracle-duckdb-alone.json, which README.md's comparison renders; UPDATE_FIXTURE=1 rewrites it, and
   * a run whose tallies moved by more than a percentage point of the statements fails until it is.
   */
  const alone = await theStore.instance.connect();
  await alone.run("SET search_path = 'public'");
  await alone.run("SET TimeZone = 'UTC'");
  const askAlone = async (sql: string): Promise<Answer> => {
    try {
      const r = await alone.runAndReadAll(sql);
      const rows = r.getRowsJson().map((row) => row.map((v) => v === null ? null : typeof v === "string" ? v : typeof v === "boolean" ? (v ? "t" : "f") : typeof v === "object" ? JSON.stringify(v) : String(v)));
      return { names: [...r.columnNames], oids: [], rows };
    } catch (e) { return { code: "XX000", message: (e as Error).message.split("\n")[0] ?? "" }; }
  };
  if (EAGER_JSON) console.log("duck oracle: every JSON path a statement reads is stored before it is planned (IT_ORACLE_JSON_PATHS=eager)");
  const resolvedOf = new Map<string, readonly string[]>();
  const planOf = duck.plan.bind(duck);
  duck.plan = async (...a) => { const p = await planOf(...a); resolvedOf.set(a[1], p.resolved); return p; };
  server = await startPostgresApi({
    port: 0, host: "127.0.0.1", tls: null, database: tag, masonVersion: "oracle",
    authenticate: () => ({}),
    schema: () => theSync.schema(),
    record: () => undefined, log: (l) => log.push(l),
    duck,
  });
  const source = new pg.Client({ connectionString: dbUrl, application_name: "duck-oracle" });
  const mason = new pg.Client({ host: "127.0.0.1", port: server.port, database: tag, user: "oracle", password: "x", application_name: "duck-oracle" });
  for (const c of [source, mason]) { await c.connect(); clients.push(c); await c.query("SET TimeZone = 'UTC'"); }

  // ---- every statement, both ways -------------------------------------------------------------------------------
  const tableSql = (t: string): string => `SELECT * FROM public.${t} ORDER BY ${KEY_OF[t] ?? "id"} COLLATE "C"`;
  const all = (): Array<{ group: string; name: string; sql: string; inOrder?: boolean; zone?: string }> => [
    ...COPIED.map((t) => ({ group: "copy", name: `the table ${t}, whole`, sql: tableSql(t) })),
    ...CASES.map((c) => ({ group: "dialect", name: c, sql: `SELECT ${c} FROM public.one` })),
    ...QUERY_CASES.map((q) => ({ group: "query case", name: q.slice(0, 80), sql: throughOne(q) })),
    ...REFUSED_CASES.map((q) => ({ group: "refused case", name: q.sql.slice(0, 80), sql: throughOne(q.sql) })),
    ...BI_SHAPES.map((q) => ({ group: "BI shape", name: q.name, sql: q.sql })),
    ...TYPE_MATRIX.map((q) => ({ group: "type matrix", name: q.name, sql: q.sql, ...(q.zone === undefined ? {} : { zone: q.zone }) })),
    ...GAP_CASES.map((q) => ({ group: "gap case", name: `gap case: ${q.gap}`, sql: q.sql })),
    { group: "decided", name: "numeric values of several scales", sql: MIXED_SCALE },
  ].filter((q) => ONLY === null || ONLY.test(q.name));
  const differences: Array<{ phase: string; group: string; kind: string; name: string; detail: string; sql: string }> = [];
  // the decided differences a statement differed by, and those that decided a statement asked (oracle/known.ts)
  const known = new Set<Decided>(), decided = new Set<Decided>();
  // a statement verifies what it is made of when DuckDB answered it with rows, exactly as Postgres, in every phase
  const unproven = new Set<string>();
  // the gaps (src/duck/gaps.ts) the statements met: a refusal that names one, a decided difference
  const met = new Map<GapId, number>();
  const meet = (g: GapId): void => { met.set(g, (met.get(g) ?? 0) + 1); };
  /** A REFUSAL BY NAME: Mason's 0A000 naming a refused gap, where Postgres answers (or refuses otherwise) */
  const namedGap = (got: Answer): GapId | null => {
    const named = "code" in got && got.code === "0A000" ? GAP_MARK.exec(`${got.message} ${got.detail ?? ""}`)?.[1] : undefined;
    return named !== undefined && named in GAPS && GAPS[named as GapId].kind === "refused" ? named as GapId : null;
  };
  let shaped = 0;
  /** the copy phase's tallies: how Mason answered each statement, and how DuckDB alone did (`duckdbAlone`) */
  const tallies = { statements: 0, mason: { exact: 0, decided: 0, refused: 0, differs: 0 }, duckdb: { exact: 0, name: 0, refused: 0, value: 0, rows: 0, text: 0, other: 0 } };
  // the sessions' TimeZone: UTC, as set at their start, until a statement asks for another
  let zone = "UTC";
  const run = async (phase: string): Promise<void> => {
    const first = phase === "after the copy";
    for (const q of all()) {
      // A STATEMENT ASKED IN A SESSION ZONE OF ITS OWN (`zone`; UTC otherwise): both sessions, and DuckDB alone, set to it
      if ((q.zone ?? "UTC") !== zone) {
        zone = q.zone ?? "UTC";
        for (const c of [source, mason]) await c.query(`SET TimeZone = '${zone}'`);
        if (first) await alone.run(`SET TimeZone = '${zone}'`);
      }
      const [want, got] = [await ask(source, q.sql), await ask(mason, q.sql)];
      const v = verdict(want, got, q.inOrder ?? ordered(q.sql));
      if (first) {
        tallies.statements++;
        const a = verdict(want, await askAlone(q.sql).then((x) => "code" in x || "code" in want ? x : { ...x, oids: want.oids }), q.inOrder ?? ordered(q.sql));
        const kind = a === null ? "exact" : a.kind === "name" ? "name" : a.kind === "refused" ? "refused" : a.kind === "value" ? "value" : a.kind === "rows" ? "rows" : a.kind === "text" ? "text" : "other";
        tallies.duckdb[kind]++;
      }
      if (v !== null || "code" in got) unproven.add(q.sql);
      const k = KNOWN.find((x) => x.sql.test(q.sql));
      if (k) decided.add(k);
      // a decided case differing in ANOTHER way than decided is a difference like any other
      if (k && (v === null || v.kind === k.kind)) { unproven.add(q.sql); if (first) { if (v === null) tallies.mason.exact++; else tallies.mason.decided++; } if (v !== null) { known.add(k); meet(k.gap); } continue; }
      const gap = v === null ? null : namedGap(got);
      if (gap !== null) { if (first) tallies.mason.refused++; meet(gap); continue; }
      if (v !== null) { if (first) tallies.mason.differs++; differences.push({ phase, group: q.group, kind: v.kind, name: q.name, detail: v.detail, sql: q.sql }); continue; }
      if (first) tallies.mason.exact++;
      // THE SHAPES (oracle/shapes.ts), once, of what both answered alike with rows: the same answer at another depth
      if (phase !== "after the copy" || "code" in want || q.group === "copy" || SHAPES === false) continue;
      for (const s of await shapesOf(q.sql, q.inOrder ?? ordered(q.sql))) {
        shaped++;
        const [sw, sg] = [await ask(source, s.sql, s.values), await ask(mason, s.sql, s.values)];
        const sv = verdict(sw, sg, s.inOrder);
        // a decided difference a shape alone meets (a filter's literal sent as a parameter: limit-lateral-filter),
        // decided before an agreement so one that no longer differs is said so (staleDecisions)
        const sk = KNOWN.find((x) => x.sql.test(s.sql));
        if (sk) decided.add(sk);
        if (sv === null) continue;
        const sgap = namedGap(sg);
        if (sgap !== null) { meet(sgap); continue; }
        if (sk && sv.kind === sk.kind) { known.add(sk); meet(sk.gap); continue; }
        differences.push({ phase, group: `${q.group} [${s.shape}]`, kind: sv.kind, name: `${q.name} [${s.shape}]`, detail: sv.detail,
          sql: s.values === undefined ? s.sql : `${s.sql} -- with ${JSON.stringify(s.values)}` });
      }
    }
  };
  await run("after the copy");
  alone.closeSync();
  // the DuckDB-alone tallies, held to the fixture README.md renders (a percentage point of the statements of play)
  if (ONLY === null) {
    const fixture = { ...tallies, measured: "the copy phase of tests/integration/duck-oracle.itest.ts, each statement as written to a plain DuckDB connection over the same copy" };
    const pct = (n: number): string => `${(100 * n / tallies.statements).toFixed(1)}%`;
    console.log(`duck oracle, DuckDB alone: ${tallies.statements} statements: exact ${pct(tallies.duckdb.exact)}, the rows under its own names ${pct(tallies.duckdb.name)}, refused ${pct(tallies.duckdb.refused)}, ` +
      `a wrong value ${pct(tallies.duckdb.value)}, wrong rows ${pct(tallies.duckdb.rows)}, other text ${pct(tallies.duckdb.text)}, other ${pct(tallies.duckdb.other)}; ` +
      `Mason: exact ${pct(tallies.mason.exact)}, decided ${pct(tallies.mason.decided)}, refused by name ${pct(tallies.mason.refused)}, differs ${pct(tallies.mason.differs)}`);
    if (UPDATE_FIXTURE) { fs.writeFileSync(ALONE_FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`); console.log(`UPDATE_FIXTURE=1: wrote ${ALONE_FIXTURE}`); }
    else {
      const was = JSON.parse(fs.readFileSync(ALONE_FIXTURE, "utf8")) as typeof fixture;
      const moved = (["mason", "duckdb"] as const).flatMap((side) => Object.entries(fixture[side]).filter(([k, n]) => Math.abs(n - (was[side] as Record<string, number>)[k]!) > tallies.statements / 100)
        .map(([k, n]) => `${side}.${k}: ${n} where the fixture has ${(was[side] as Record<string, number>)[k]}`));
      assert.deepEqual(moved, [], `${ALONE_FIXTURE} is not what this run measured (README.md's comparison renders it): regenerate with UPDATE_FIXTURE=1 and read the diff`);
    }
  }
  for (const round of [1, 2]) {
    psql(dbUrl, mutations(round) + typedMutations(round));
    await sync.once();
    await run(`after changes round ${round}`);
  }

  // ---- the verdict ----------------------------------------------------------------------------------------------
  const counted = new Map<string, number>();
  for (const d of differences) counted.set(`${d.group} / ${d.kind}`, (counted.get(`${d.group} / ${d.kind}`) ?? 0) + 1);
  const asked = all().length * 3 + shaped;
  fs.writeFileSync(report, `${asked} statements asked (${all().length} × 3 phases, and ${shaped} in other shapes); ${differences.length} differ\n` +
    [...counted].sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${n} × ${k}`).join("\n") + "\n\n" +
    differences.map((d) => `[${d.phase}] ${d.group} / ${d.kind}: ${d.name}\n  ${d.detail}\n  ${d.sql.replace(/\s+/g, " ")}`).join("\n\n") + "\n");
  console.log(`duck oracle: ${asked} statements asked, ${differences.length} differ (${report}): ${[...counted].map(([k, n]) => `${n} ${k}`).join(", ")}`);
  // the first differences in the log too, whichever assertion below fails first (a difference can be why a decision
  // is stale or a verified entry dropped, and CI keeps only the log)
  for (const d of differences.slice(0, 5)) console.log(`duck oracle: differs: [${d.phase}] ${d.group} / ${d.kind}: ${d.name}\n  ${d.detail}\n  ${d.sql.replace(/\s+/g, " ")}`);
  console.log(`duck oracle: ${nodesPlacedTwice().length} node(s) a rewrite placed twice${nodesPlacedTwice().length > 0 ? `: ${nodesPlacedTwice().slice(0, 10).join(" | ")}` : ""}`);
  if (EAGER_JSON) {
    // the run read JSON from stored columns: how many paths, and none left unfilled
    const paths = theSync.kept.status();
    const orders = paths.filter((p) => p.state === "ready" && p.steps.startsWith("order:"));
    console.log(`duck oracle: ${paths.filter((p) => p.state === "ready").length} JSON path(s) stored and read from their columns, over ${new Set(paths.map((p) => p.table)).size} table(s); ` +
      `${orders.length} of them a jsonb's order (${orders.map((p) => `${p.table}.${p.column}`).join(", ")})`);
    assert.ok(paths.some((p) => p.state === "ready"), "IT_ORACLE_JSON_PATHS=eager stored no JSON path: the run did not exercise them");
    // a jsonb sorted, grouped or compared is read from its stored key (src/duck/kept-route.ts ORDER_STEPS)
    assert.ok(orders.some((p) => p.table === "public.jorder"), "IT_ORACLE_JSON_PATHS=eager stored no jsonb's order: the run did not exercise it");
    // under a libc collation a jsonb's equality is read from its stored C key, a second column (EQUAL_STEPS); under C
    // and ICU the order's key serves it, and no second column is ever made
    const equals = paths.filter((p) => p.steps.startsWith("equal:"));
    console.log(`duck oracle: ${equals.filter((p) => p.state === "ready").length} jsonb equality key(s) stored (${equals.map((p) => `${p.table}.${p.column} ${p.state}`).join(", ")})`);
    if (libc !== undefined) assert.ok(equals.some((p) => p.table === "public.jorder" && p.state === "ready"), "IT_ORACLE_JSON_PATHS=eager under libc stored no jsonb's C key: the run did not exercise it");
    else assert.deepEqual(equals.map((p) => `${p.table}.${p.column} ${p.steps} ${p.state}`), [], "under C or ICU no jsonb's C key is stored: the order's key equates");
    assert.deepEqual(paths.filter((p) => p.state !== "ready").map((p) => `${p.table} ${p.column} ${p.steps}: ${p.state} ${p.why}`), [], "every path stored is ready");
  }
  // a filtered run asks only some statements: a decision it did not meet is not stale
  const stale = ONLY !== null ? [] : staleDecisions(KNOWN, known, decided);
  assert.deepEqual(stale, [], "a decided difference that no longer differs");
  console.log(`duck oracle: gaps met: ${[...met].sort().map(([g, n]) => `${g} ${n}`).join(", ")}`);
  // A DEAD GAP: a refused or decided entry no statement meets (removed, or held by a test it names)
  const dead = ONLY !== null ? [] : (Object.entries(GAPS) as Array<[GapId, (typeof GAPS)[GapId]]>)
    .filter(([id, g]) => g.kind !== "limit" && !("heldBy" in g) && !met.has(id)).map(([id]) => id);
  assert.deepEqual(dead, [], "src/duck/gaps.ts entries no oracle statement meets: add a statement that does (oracle/gap-cases.ts), or remove the entry");

  // ---- what is verified (src/duck/verified.ts): exactly what the statements answered alike were made of ----------
  const verified = new Set<string>();
  for (const q of all()) if (!unproven.has(q.sql)) for (const k of resolvedOf.get(q.sql) ?? []) verified.add(k);
  const newly = [...verified].filter((k) => !VERIFIED.has(k)).sort(), dropped = [...VERIFIED.keys()].filter((k) => !verified.has(k)).sort();
  if (process.env.UPDATE_VERIFIED === "1" && ONLY === null) {
    const names = await describeKeys(async (sql) => (await source.query({ text: sql, rowMode: "array" })).rows as (string | null)[][], verified);
    const file = path.join(REPO, "src", "duck", "verified.ts");
    const head = fs.readFileSync(file, "utf8").split("export const VERIFIED")[0]!;
    fs.writeFileSync(file, `${head}export const VERIFIED: ReadonlyMap<string, string> = new Map([\n` +
      [...verified].sort().map((k) => `  [${JSON.stringify(k)}, ${JSON.stringify(names.get(k) ?? k)}],\n`).join("") + "]);\n");
    console.log(`duck oracle: src/duck/verified.ts rewritten: ${verified.size} verified (${newly.length} added, ${dropped.length} dropped)`);
  } else if (ONLY === null) {
    assert.deepEqual({ added: newly, dropped }, { added: [], dropped: [] }, "src/duck/verified.ts is not what the oracle verifies: `added` were answered " +
      "exactly and are refused until listed, `dropped` are listed and no statement answered alike uses them. Regenerate with UPDATE_VERIFIED=1 and read the diff");
  }
  assert.equal(differences.length, 0, `the endpoint answered ${differences.length} statement(s) differently from Postgres; ${report} lists them. The first:\n` +
    differences.slice(0, 5).map((d) => `[${d.phase}] ${d.group} / ${d.kind}: ${d.name}\n  ${d.detail}`).join("\n"));
  // ONE PLACE PER NODE (src/duck/rewrite.ts nodesPlacedTwice): a rule that put a node in two places rewrote it in one
  assert.deepEqual(nodesPlacedTwice(), [], "a rule placed a node in two places: clone it per use (Rewriter.cp)");
});
