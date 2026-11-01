/**
 * WHAT THE POSTGRES LISTENER SHOWS A TOOL: the copied tables, each column with the Postgres type the source spells it
 * as, each foreign key between two copied tables as a foreign key, the source's views. One shape, built by the sync
 * from the copy (src/duck/sync.ts `schema()`) and read by the catalog sidecar (src/api/postgres/catalog.ts creates
 * these tables, empty, in a Postgres inside the process, so a tool's introspection is Postgres's own) and the wire
 * encoders (src/api/postgres/encode.ts: the type decides the OID and the format).
 *
 * Pure and dependency-free: the tests build one by hand.
 */

/** The Postgres types the encoders know by name, by their `pg_type.typname` (encode.ts); a copied column of another
 *  type carries the source's own spelling and OID (`spelled`, `typeOid`). */
export const PG_API_TYPES = ["int2", "int4", "int8", "float4", "float8", "numeric", "text", "bool", "uuid", "date", "timestamptz", "jsonb"] as const;
export type PgApiType = typeof PG_API_TYPES[number];
export const isPgApiType = (t: unknown): t is PgApiType => typeof t === "string" && (PG_API_TYPES as readonly string[]).includes(t);

/** How each type is SPELLED in `format_type` / a CREATE TABLE, the catalog's own words. */
export const PG_API_TYPE_SPELLING: Record<PgApiType, string> = {
  int2: "smallint", int4: "integer", int8: "bigint", float4: "real", float8: "double precision", numeric: "numeric", text: "text",
  bool: "boolean", uuid: "uuid", date: "date", timestamptz: "timestamp with time zone", jsonb: "jsonb",
};

export interface PgColumn {
  name: string;
  type: PgApiType;
  /** the source's column comment, a `COMMENT ON COLUMN` in the catalog */
  description?: string | undefined;
  /** the column's type as the SOURCE spells it (`format_type`: `numeric(12,2)`, `character
   *  varying(255)`), which the catalog creates in place of `type`'s spelling — a tool sees the source's own types */
  spelled?: string | undefined;
  /** the SOURCE's OID for a type an extension made (citext), which the wire sends in place of
   *  the catalog Postgres's own OID for it (src/duck/plan.ts) */
  typeOid?: number | undefined;
  typeArrayOid?: number | undefined;
  /** the source's NOT NULL, DEFAULT, identity and owned sequence (src/cli/preflight.ts
   *  SourceColumnInfo), which the catalog declares so a tool reads them as the source's (`information_schema.columns`,
   *  `pg_get_serial_sequence`) */
  notNull?: boolean | undefined;
  default?: string | undefined;
  identity?: "a" | "d" | undefined;
  sequence?: string | undefined;
  /** an enum's labels in their declared order (a column, or an array's element, of the source's
   *  enum type), which the catalog creates the type with: Postgres orders and compares an enum by them */
  enumLabels?: readonly string[] | undefined;
  /** a type a database made that the copy holds as its text (a composite, a range, an extension's: src/duck/held-types.ts):
   *  the catalog declares it under its name, with nothing defined over it, so a tool reads the source's type */
  made?: boolean | "row" | undefined;
}

/** the input function's name of a type the catalog declares for a `made` column: what the planner tells one by */
export const HELD_TYPE_INPUT = "mason_held_in";
/** a composite's: its input function's name holds `HELD_TYPE_INPUT` too */
export const HELD_ROW_INPUT = "row_mason_held_in";
/** the name a `made` type is declared under, its typmod and `[]` left off (`vector(3)`, `pair[]`) */
export const madeTypeName = (spelled: string): string => spelled.replace(/\[\]$/, "").replace(/\(\d+(,\d+)?\)$/, "");

/**
 * A type as format_type spells it (`mood`, `other.level`, `"My Mood"`, `"a.b"."c"`, an array's `[]` left off): its
 * schema as written (null when it is not qualified) and its name as pg_type.typname holds it (unquoted).
 */
export function typeNameParts(spelled: string): { schema: string | null; name: string } {
  const parts: string[] = [];
  let at = 0;
  while (at < spelled.length) {
    if (spelled[at] === '"') {
      let end = at + 1, out = "";
      for (; end < spelled.length; end++) {
        if (spelled[end] === '"') { if (spelled[end + 1] === '"') { out += '"'; end++; continue; } break; }
        out += spelled[end];
      }
      parts.push(`"${out}`);
      at = end + 1;
    } else {
      const dot = spelled.indexOf(".", at);
      parts.push(spelled.slice(at, dot < 0 ? undefined : dot));
      at = dot < 0 ? spelled.length : dot;
    }
    if (spelled[at] === ".") at++;
  }
  const bare = (p: string): string => p.startsWith('"') ? p.slice(1) : p;
  const quoted = (p: string): string => p.startsWith('"') ? `"${p.slice(1).replaceAll('"', '""')}"` : p;
  return parts.length > 1 ? { schema: quoted(parts[parts.length - 2]!), name: bare(parts[parts.length - 1]!) } : { schema: null, name: bare(parts[0] ?? "") };
}

export type PgRelationship = "one_to_one" | "one_to_many" | "many_to_one";

/** A foreign key between two copied tables (src/duck/sync.ts): a foreign key in the catalog where Postgres takes one
 *  (catalog.ts `isForeignKey`), else a note on its column. */
export interface PgJoin {
  /** the table it reads, by its own name */
  name: string;
  /** the table it reads, `<schema>.<table>` */
  table: string;
  /** [this table's column, the target's column] */
  on: [string, string];
  relationship: PgRelationship;
}

import type { UniqueKey } from "../../cli/preflight.ts";

export interface PgTable {
  name: string;
  /** the source's OID for the table's row type, where every column of it is copied (a whole row
   *  of a table copied in part is not the source's row, and is refused) */
  rowTypeOid?: number | undefined;
  /** the Postgres schema the table is in (a source table keeps its own, decision C); absent: public */
  schema?: string | undefined;
  description?: string | undefined;
  /** the source table's primary key's column names, in order */
  primaryKey: string[];
  /** the source table's unique indexes over plain columns (src/cli/preflight.ts `UniqueKey`) */
  uniqueKeys?: UniqueKey[] | undefined;
  /** the copied columns, in the source's order */
  columns: PgColumn[];
  joins: PgJoin[];
}

export interface PgSchema {
  /** what a connection's `database` must be (src/lib/database-name.ts) */
  database: string;
  tables: PgTable[];
  /** the source's views, created in the catalog after the tables (catalog.ts `catalogViews`) and
   *  answered over the copied tables (src/duck/views.ts) */
  views?: PgView[] | undefined;
}

/** A source view: its definition with every name outside pg_catalog qualified (src/cli/preflight.ts VIEWS_SQL) */
export interface PgView { schema: string; name: string; definition: string; description?: string | undefined }
