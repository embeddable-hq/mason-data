/**
 * A PUBLICATION THE OPERATOR NAMED, READ AS IT IS: `publication: <name>` at the top of the sources file
 * (or `PG_PUBLICATION`) streams through a publication that is the database owner's, never Mason's — on a read replica
 * Mason could not make one (CREATE PUBLICATION is refused on a standby), and on a customer's primary the one object
 * Mason creates is its slot (CLAUDE.md "We are read-only on a customer's Postgres"). So it is VERIFIED, never created,
 * altered or dropped, over the live catalog (`readNamedPublication`, one read-only statement), with the copy's columns
 * as what it must carry (`checkPublication`).
 *
 * Refused for the whole run: a publication that does not exist (the database's others listed, to catch a typo), and one
 * that does not publish insert, update AND delete. Refused per table, the others streaming on: a table it does not
 * carry (`FOR ALL TABLES` carries every one), a column list without a copied column, a row filter (a filtered row's
 * delete never arrives). Each refusal is the publication EXPECTED — the found one plus the gap, as the `ALTER
 * PUBLICATION … ADD TABLE …` its owner runs — and the one FOUND. TRUNCATE not published is allowed and said once.
 */
import type { PgConnection } from "../cdc/pg-wire.ts";

/** What a copied table needs the publication to carry: its name, and the columns the copy holds. */
export interface CopiedTable { source: string; columns: ReadonlyArray<{ name: string; generated?: boolean }> }

/** One table as the catalog describes it: every column in the catalog's order, and what the publication carries. */
export interface PublishedTable {
  columns: string[];
  /** the columns the publication streams (every column when it carries no column list, or before Postgres 15); null
   *  when it does not publish the table at all */
  published: string[] | null;
  /** the publication's row filter on the table (Postgres 15+), or null */
  rowFilter: string | null;
}

/** The named publication and the tables it carries or the copy holds, as `readNamedPublication` read them. */
export interface DescribedPublication {
  publication: {
    name: string;
    exists: boolean;
    /** which changes it publishes, of insert, update, delete, truncate */
    publish: string[];
    /** `FOR ALL TABLES` */
    allTables: boolean;
    /** the database's other publications, named when this one does not exist (a typo in its name) */
    others: string[];
  };
  /** keyed `schema.table` */
  tables: Map<string, PublishedTable>;
  /** `server_version_num`: column lists and row filters need 150000 */
  serverVersion: number;
}

/** What a named publication allows: a refusal of the whole run, else each table it does not carry with why. */
export interface NamedPublicationVerdict {
  /** the publication cannot be read through at all (it does not exist, or does not publish every insert, update and
   *  delete): the run's refusal, every table's */
  refused: string | null;
  /** per table: what the publication lacks of it, as one message with the way out */
  tables: Map<string, string>;
  /** the publication does not publish TRUNCATE: a TRUNCATE on the database does not reach the copy */
  noTruncate: boolean;
}

/** what the copy reads of each table: its columns but a generated one (not published before Postgres 18; the stream
 *  reads it from the source by the row's key) */
type Required = Map<string, string[]>;
const requiredOf = (t: CopiedTable): string[] => t.columns.filter((c) => !c.generated).map((c) => c.name);

/** what follows every refusal: Mason waits for the owner, and when it looks again */
const NEVER_ALTERED = "Mason reads a publication it is given as it is, never altering it: once its owner has run that, the next mason start " +
  "(or mason add) checks it again. Or give the table's entry sync: poll <interval> in the sources file, which needs no publication; " +
  "or write publication: null in it, where Mason makes its own, carrying the replicated tables alone (not on a read replica).";

/**
 * The verdict over a described publication (pure: `described` is what `readNamedPublication` read). `identities` are
 * the tables' `relreplident`: a table whose identity is not its key is expected WHOLE (a column list missing an
 * identity column would make the app's UPDATEs fail).
 */
export function namedPublicationVerdict(described: DescribedPublication, tables: readonly CopiedTable[], identities: ReadonlyMap<string, string>): NamedPublicationVerdict {
  const whole = new Set(tables.filter((t) => identities.get(t.source) !== "d").map((t) => t.source));
  const pub = described.publication;
  const noTruncate = pub.exists && !pub.publish.includes("truncate");
  if (!pub.exists || !["insert", "update", "delete"].every((k) => pub.publish.includes(k))) {
    const all: Required = new Map(tables.map((t) => [t.source, requiredOf(t)]));
    const m = checkPublication(all, described, whole) ?? `publication ${pub.name} cannot be read (Mason bug: report it)`;
    return { refused: `${m}\n\n${NEVER_ALTERED}`, tables: new Map(), noTruncate };
  }
  const out = new Map<string, string>();
  for (const t of tables) {
    const m = checkPublication(new Map([[t.source, requiredOf(t)]]), described, whole);
    if (m !== null) out.set(t.source, `${m}\n\n${NEVER_ALTERED}`);
  }
  return { refused: null, tables: out, noTruncate };
}

// ------------------------------------------------------------------ the check

const q = (s: string): string => /^[a-z_][a-z0-9_]*$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`;
const qualified = (t: string): string => t.split(".").map(q).join(".");

/** `schema.table (a, b, c)`, one per line, as a publication's table list reads. */
function tableLines(tables: Map<string, string[] | null>, columnLists: boolean): string[] {
  return [...tables.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([t, cols]) => `    ${qualified(t)}${columnLists && cols !== null ? ` (${cols.map(q).join(", ")})` : ""}`);
}

/** A table's columns in the catalog's order. */
const inCatalogOrder = (d: PublishedTable | undefined, cols: Iterable<string>): string[] => {
  const want = new Set(cols);
  return d === undefined ? [...want] : d.columns.filter((c) => want.has(c));
};

/**
 * What the publication lacks of the copy's tables and columns, as the message that refuses them, or null when it
 * lacks nothing: each missing table or column, the publication EXPECTED (what it streams now PLUS what is missing,
 * never less: the publication is the owner's "replicate this"), and the one FOUND. Refused besides a missing piece: a
 * publication that does not publish every insert, update and delete, and a row filter on a copied table. A table the
 * database does not have is no concern of the publication's (the copy refuses it).
 */
function checkPublication(required: Required, described: DescribedPublication, whole: ReadonlySet<string>): string | null {
  const pub = described.publication;
  const columnLists = described.serverVersion >= 150000;
  const problems: string[] = [];
  const missingLines: string[] = [];
  for (const [table, cols] of [...required.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const d = described.tables.get(table);
    if (d === undefined || !pub.exists) continue;
    if (d.published === null) {
      problems.push(`${table} is not published`);
      missingLines.push(`  missing: ${table} (read by Mason's sync)`);
      continue;
    }
    const lacking = inCatalogOrder(d, cols).filter((c) => !d.published!.includes(c));
    if (lacking.length) {
      problems.push(`${table} columns ${lacking.join(", ")} are not published`);
      missingLines.push(`  missing: ${table} columns ${lacking.join(", ")} (read by Mason's sync)`);
    }
    if (d.rowFilter !== null) {
      problems.push(`${table} is published with a row filter`);
      missingLines.push(`  row filter: ${table} is published WHERE ${d.rowFilter}; a row the filter leaves out never ` +
        `arrives, and neither does its delete. Publish the whole table.`);
    }
  }
  if (!pub.exists) problems.push(`publication ${pub.name} does not exist`);
  const publishes = ["insert", "update", "delete"].filter((k) => !pub.publish.includes(k));
  if (pub.exists && publishes.length) problems.push(`publication ${pub.name} does not publish ${publishes.join(", ")}`);
  if (problems.length === 0) return null;

  // EXPECTED: what it streams now, plus what the copy needs
  const expected = new Map<string, string[] | null>();
  for (const [t, d] of described.tables) if (d.published !== null) expected.set(t, [...d.published]);
  for (const [table, cols] of required) {
    const d = described.tables.get(table);
    if (d === undefined) continue;
    expected.set(table, inCatalogOrder(d, [...(expected.get(table) ?? []), ...cols]));
  }
  for (const t of whole) if (expected.has(t)) expected.set(t, null);
  const expectedSql = !pub.exists
    ? [`  CREATE PUBLICATION ${q(pub.name)} FOR TABLE`, tableLines(expected, columnLists).join(",\n"), `  WITH (publish = 'insert, update, delete');`]
    : addStatements(pub, required, described, expected, columnLists, publishes);
  const found = new Map<string, string[] | null>();
  for (const [t, d] of described.tables) if (d.published !== null) found.set(t, d.published);
  const foundSql = pub.exists
    ? [`Found: publication ${pub.name} (publish = '${pub.publish.join(", ")}'${pub.allTables ? ", FOR ALL TABLES" : ""})`,
       (found.size ? tableLines(found, columnLists).join(",\n") : "    (no tables)")]
    : [`Found: no publication named ${pub.name}. Publications on this database: ${pub.others.length ? pub.others.join(", ") : "none"}.`];
  return [
    `publication ${pub.name} does not carry what Mason's synced table holds.`,
    "",
    ...(missingLines.length ? [...missingLines, ""] : []),
    ...(publishes.length && pub.exists ? [`  it publishes ${pub.publish.join(", ") || "nothing"}; the change reader needs insert, update and delete`, ""] : []),
    `Expected (run as the tables' owner, or add it to your migrations):`,
    ...expectedSql,
    ...(columnLists ? [] : [`  (Postgres ${described.serverVersion} publishes whole tables: column lists need Postgres 15)`]),
    "",
    ...foundSql,
  ].join("\n");
}

/**
 * The gap alone, as statements on the publication as it is: a table it lacks ADDED; one whose column list lacks a
 * column, or that carries a row filter, dropped and added again with the found columns plus the missing ones, in one
 * transaction (no statement widens one table's column list or drops its filter); the publish list widened by what is
 * missing, what it published kept — never a restatement of the whole list, which could drop what the owner published.
 */
function addStatements(pub: DescribedPublication["publication"], required: Required, described: DescribedPublication, expected: Map<string, string[] | null>,
                       columnLists: boolean, publishes: string[]): string[] {
  const missing: string[] = [], changed: string[] = [];
  for (const [table, cols] of [...required.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const d = described.tables.get(table);
    if (d === undefined) continue;
    if (d.published === null) missing.push(table);
    else if (d.rowFilter !== null || cols.some((c) => !d.published!.includes(c))) changed.push(table);
  }
  const added = new Map([...changed, ...missing].map((t) => [t, expected.get(t) ?? null]));
  const publish = ["insert", "update", "delete", "truncate"].filter((k) => pub.publish.includes(k) || publishes.includes(k));
  return [
    ...(changed.length ? ["  BEGIN;", `  ALTER PUBLICATION ${q(pub.name)} DROP TABLE ${changed.map(qualified).join(", ")};`] : []),
    ...(added.size ? [`  ALTER PUBLICATION ${q(pub.name)} ADD TABLE`, tableLines(added, columnLists).join(",\n") + ";"] : []),
    ...(publishes.length ? [`  ALTER PUBLICATION ${q(pub.name)} SET (publish = '${publish.join(", ")}');`] : []),
    ...(changed.length ? ["  COMMIT;"] : []),
  ];
}

// ------------------------------------------------------------------ the catalog

const lit = (s: string): string => "'" + s.replace(/'/g, "''") + "'";

/**
 * The one catalog query: the publication, and every table it streams or the copy holds (by `schema.table`), each with
 * its columns in the catalog's order and what the publication carries of it, in one JSON value. Column lists and row
 * filters exist from Postgres 15. Read-only: the catalog, never a row of data.
 */
export function publicationQuery(publication: string, tables: readonly string[], version: number): string {
  const modern = version >= 150000;
  const names = tables.length === 0 ? "NULL" : tables.map(lit).join(", ");
  return `WITH pt AS (
  SELECT schemaname || '.' || tablename AS t, ${modern ? "to_json(attnames::text[])" : "NULL::json"} AS cols, ${modern ? "rowfilter" : "NULL::text"} AS rf
  FROM pg_publication_tables WHERE pubname = ${lit(publication)}
), wanted AS (
  SELECT c.oid, n.nspname || '.' || c.relname AS t
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p') AND (n.nspname || '.' || c.relname IN (SELECT t FROM pt) OR n.nspname || '.' || c.relname IN (${names}))
)
SELECT json_build_object(
  'version', current_setting('server_version_num')::int,
  'publication', (SELECT json_build_object('all_tables', puballtables, 'publish', to_json(array_remove(ARRAY[
      CASE WHEN pubinsert THEN 'insert' END, CASE WHEN pubupdate THEN 'update' END,
      CASE WHEN pubdelete THEN 'delete' END, CASE WHEN pubtruncate THEN 'truncate' END], NULL)))
    FROM pg_publication WHERE pubname = ${lit(publication)}),
  'others', (SELECT coalesce(json_agg(pubname ORDER BY pubname), '[]'::json) FROM pg_publication WHERE pubname <> ${lit(publication)}),
  'tables', (SELECT coalesce(json_agg(json_build_object(
    't', w.t,
    'columns', (SELECT coalesce(json_agg(a.attname ORDER BY a.attnum), '[]'::json)
      FROM pg_attribute a WHERE a.attrelid = w.oid AND a.attnum > 0 AND NOT a.attisdropped),
    'in_publication', EXISTS (SELECT 1 FROM pt WHERE pt.t = w.t),
    'published', (SELECT pt.cols FROM pt WHERE pt.t = w.t),
    'row_filter', (SELECT pt.rf FROM pt WHERE pt.t = w.t)
  ) ORDER BY w.t), '[]'::json) FROM wanted w)
)::text`;
}

/** the query's answer, as Postgres's json_build_object wrote it */
export interface PublicationAnswer {
  version: number;
  publication: { all_tables: boolean; publish: string[] } | null;
  others: string[];
  tables: Array<{ t: string; columns: string[]; in_publication: boolean; published: string[] | null; row_filter: string | null }>;
}

/** A catalog answer described: before Postgres 15 a publication carries whole rows, every column of a table it names. */
export function describedOf(answer: PublicationAnswer, publication: string): DescribedPublication {
  return {
    publication: { name: publication, exists: answer.publication !== null, publish: answer.publication?.publish ?? [], allTables: answer.publication?.all_tables ?? false, others: answer.others },
    tables: new Map(answer.tables.map((t) => [t.t, { columns: t.columns, published: t.in_publication ? (t.published ?? t.columns) : null, rowFilter: t.row_filter }])),
    serverVersion: answer.version,
  };
}

/** The named publication and the copied tables as the live catalog describes them: read-only, two statements.
 *  (`_project`, the project's name, is unused: the tables are found by their own names.) */
export async function readNamedPublication(pg: PgConnection, publication: string, tables: readonly CopiedTable[]): Promise<DescribedPublication> {
  const one = async (sql: string): Promise<string> => {
    const v = (await pg.query(sql)).rows[0]?.[0];
    if (typeof v !== "string") throw new Error("a catalog query answered no value");
    return v;
  };
  const version = Number(await one("SELECT current_setting('server_version_num')"));
  if (!Number.isInteger(version) || version <= 0) throw new Error("the server's version did not read as a number");
  const text = await one(publicationQuery(publication, tables.map((t) => t.source), version));
  let answer: PublicationAnswer;
  try { answer = JSON.parse(text) as PublicationAnswer; }
  catch (e) { throw new Error(`the publication's catalog query did not answer JSON (${(e as Error).message}): ${text.slice(0, 200)}`); }
  return describedOf(answer, publication);
}
