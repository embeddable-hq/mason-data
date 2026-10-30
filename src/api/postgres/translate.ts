/**
 * WHAT A STATEMENT IS, from Postgres 18's own parse tree (parser.ts), decided by node kind, never by text:
 *
 *   - a SELECT that reads any table outside pg_catalog / information_schema: DuckDB's (`duckdb`), planned by the
 *     catalog Postgres and rewritten (src/duck/plan.ts) — the text here is only what the plan is made from;
 *   - a CATALOG statement (one that reads only `pg_catalog` / `information_schema`, or no table at all: `SELECT
 *     version()`, `SELECT 1`): forwarded by the server to the Postgres inside the process (catalog.ts), which answers it
 *     as Postgres;
 *   - a SESSION statement (`SET`, `SHOW`, `BEGIN` / `COMMIT`, `DISCARD`, `DEALLOCATE`): the server's;
 *   - an EXPLAIN: the statement it explains, classified as it would be alone (src/api/postgres/explain.ts);
 *   - anything else: REFUSED BY NAME (`Unsupported`), with its position in the statement, a SQLSTATE and the way
 *     out, never passed through on a guess. The switch has no default branch that accepts.
 */
import { gapMark, type GapId } from "../../duck/gaps.ts";
import type { A_Const, ColumnRef, CommonTableExpr, Node, RangeVar, SelectStmt, TypeCast, VariableSetStmt } from "libpg-query";

/** A statement, or a part of one, this listener does not answer: named, placed, with a SQLSTATE and the way out. */
export class Unsupported extends Error {
  /** 0-based offset into the statement's text, or null when the whole statement is meant */
  readonly offset: number | null;
  /** `0A000` feature not supported; `42601` syntax; `25006` read only; `22023` an invalid value */
  readonly sqlstate: string;
  readonly hint: string | undefined;
  /** the registry entry that refused it (src/duck/gaps.ts): the request log's `gap`; null for any other refusal */
  readonly gap: GapId | null;
  constructor(message: string, offset: number | null, sqlstate = "0A000", hint?: string, gap: GapId | null = null) {
    super(message); this.offset = offset; this.sqlstate = sqlstate; this.hint = hint; this.gap = gap;
  }
}

/** A statement the session or the catalog Postgres answers (a SELECT over a table is `duckTranslate`'s `duckdb`). */
export type Translation =
  | { kind: "catalog" }
  /** `local`: for the transaction alone; `tag`: its CommandComplete, `SET x TO DEFAULT` being a SET whose value is null */
  | { kind: "set"; name: string; value: string | null; local: boolean; tag: "SET" | "RESET" }
  | { kind: "show"; name: string }
  | { kind: "set_config"; name: string; value: string; local: boolean; column: string }
  | { kind: "transaction"; tag: string }
  | { kind: "discard"; target: string }
  | { kind: "deallocate" }
  | { kind: "empty" };

// ------------------------------------------------------------------ the tree

type Any = Record<string, unknown>;
const kindOf = (n: Node): string => Object.keys(n)[0] ?? "";
const bodyOf = <T>(n: Node): T => (n as unknown as Record<string, T>)[kindOf(n)]!;
const strings = (nodes: Node[] | undefined): string[] => (nodes ?? []).map((n) => kindOf(n) === "String" ? String(bodyOf<{ sval?: string }>(n).sval ?? "") : "");
const loc = (n: Node | undefined): number | null => {
  if (n === undefined) return null;
  const b = bodyOf<{ location?: number } | undefined>(n);   // `{}` (a plain DISTINCT's entry) has no body
  return typeof b?.location === "number" && b.location >= 0 ? b.location : null;
};

/** every node of a kind, anywhere under `n` */
function collect(n: unknown, kind: string, out: Node[] = []): Node[] {
  if (Array.isArray(n)) { for (const x of n) collect(x, kind, out); return out; }
  if (n === null || typeof n !== "object") return out;
  const o = n as Any;
  for (const [k, v] of Object.entries(o)) {
    if (k === kind) out.push({ [k]: v } as unknown as Node);
    collect(v, kind, out);
  }
  return out;
}

const INFORMATION_SCHEMA = "information_schema";
const PG_CATALOG = "pg_catalog";

// ------------------------------------------------------------------ entry

/** A statement other than a SELECT or an EXPLAIN (`duckTranslate` takes those): the session's, or refused by name. */
function sessionStatement(stmt: Node): Translation {
  const kind = kindOf(stmt);
  switch (kind) {
    case "VariableSetStmt": return setStatement(bodyOf<VariableSetStmt>(stmt));
    case "VariableShowStmt": return { kind: "show", name: String(bodyOf<{ name?: string }>(stmt).name ?? "").toLowerCase() };
    case "TransactionStmt": {
      const k = bodyOf<{ kind?: string }>(stmt).kind;
      const tag = k === "TRANS_STMT_BEGIN" ? "BEGIN" : k === "TRANS_STMT_START" ? "START TRANSACTION" : k === "TRANS_STMT_COMMIT" ? "COMMIT" : k === "TRANS_STMT_ROLLBACK" ? "ROLLBACK" : null;
      if (tag === null) throw new Unsupported(`${String(k).replace("TRANS_STMT_", "").toLowerCase()}: this connection is read-only and has no savepoints or prepared transactions; BEGIN, COMMIT and ROLLBACK are accepted, and a ROLLBACK undoes the block's SETs`, null);
      return { kind: "transaction", tag };
    }
    case "DiscardStmt": return { kind: "discard", target: String(bodyOf<{ target?: string }>(stmt).target ?? "DISCARD_ALL").replace(/^DISCARD_/, "") };
    case "DeallocateStmt": return { kind: "deallocate" };
    case "InsertStmt": case "UpdateStmt": case "DeleteStmt": case "MergeStmt": case "CopyStmt": case "TruncateStmt":
    case "CreateStmt": case "DropStmt": case "AlterTableStmt": case "CreateTableAsStmt": case "ViewStmt": case "IndexStmt":
    case "GrantStmt": case "CreateRoleStmt": case "CreateFunctionStmt": case "CreateSchemaStmt": case "VacuumStmt":
      throw new Unsupported(`${kind.replace(/Stmt$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toUpperCase()}: these are the database's tables, synced and read-only; only SELECT, SET, SHOW and the transaction no-ops are accepted`, null, "25006");
    case "PrepareStmt": case "ExecuteStmt": throw new Unsupported(`${kind === "PrepareStmt" ? "PREPARE" : "EXECUTE"} is not supported: use the protocol's prepared statements (every driver does)`, null);
    default:
      throw new Unsupported(`${kind.replace(/Stmt$/, "")}: not a statement this listener answers (SELECT, EXPLAIN, a catalog query, SET, SHOW, BEGIN/COMMIT)`, null);
  }
}

/**
 * ONE STATEMENT CLASSIFIED (docs/DESIGN.md decision D): a SELECT that reads any table outside pg_catalog /
 * information_schema is DuckDB's (`text`, the parser's slice of the message, for the plan to be made from); one that
 * reads only the catalog, or no table at all (`SELECT version()`, `SELECT 1`), is the catalog Postgres's. Every other
 * statement is the session's or refused (`sessionStatement`), but an EXPLAIN, which is the statement it explains.
 * NOTHING reaches DuckDB but a SELECT Postgres analysed and the rewrite read back (src/duck/plan.ts): DuckDB's `EXPLAIN
 * ANALYZE` runs the statement under it, and its text, unanalysed, could write to the copy or read the attached source
 * (a review finding).
 */
export function duckTranslate(stmt: Node, text: string): Translation | { kind: "duckdb"; sql: string; names?: (string | null)[] | null }
  | { kind: "explain"; query: Node; options: unknown[] } {
  const configured = setConfig(stmt);
  if (configured !== null) return configured;
  const kind = kindOf(stmt);
  // an EXPLAIN is the statement it explains (src/api/postgres/explain.ts, src/duck/explain.ts): its options read, then
  // that statement classified as it would be alone, by the server
  if (kind === "ExplainStmt") {
    const e = bodyOf<{ query?: Node; options?: unknown[] }>(stmt);
    if (e.query === undefined) throw new Unsupported("EXPLAIN of nothing", null, "42601");
    return { kind: "explain", query: e.query, options: e.options ?? [] };
  }
  if (kind !== "SelectStmt") return sessionStatement(stmt);
  const s = bodyOf<SelectStmt>(stmt);
  const ctes = (s.withClause?.ctes ?? []).map((n) => bodyOf<CommonTableExpr>(n));
  const names = new Set(ctes.map((c) => String(c.ctename ?? "")));
  const relations = collect(s, "RangeVar").map((n) => bodyOf<RangeVar>(n)).filter((r) => r.schemaname !== undefined || !names.has(String(r.relname ?? "")));
  if (relations.every(isCatalogRelation)) return { kind: "catalog" };
  return { kind: "duckdb", sql: text, names: pgColumnNames(s) };
}

/**
 * `set_config(name, value, is_local)` IS A SET, and a session's SET is the listener's: forwarded, it ran on the catalog's
 * ONE connection, as its superuser, outside any transaction, so its value stayed for EVERY session — `set_config(
 * 'search_path', 'zzz', false)` moved the catalog's resolution of `current_setting` and `version()` to Postgres's own,
 * and a `myapp.x` one session set another read (a review finding of #46). So every call of it is the session's or
 * refused, wherever it is in the statement (an EXPLAIN ANALYZE's included): alone in a SELECT of no table, its
 * arguments literals (what a tool sends: pgAdmin's `bytea_output`, an ORM's `search_path`), it is `SET name = value`,
 * or `SET LOCAL` under `is_local`, answered as the function's row; any other form is the `set-config-forms` gap. null:
 * no call of it.
 */
function setConfig(stmt: Node): { kind: "set_config"; name: string; value: string; local: boolean; column: string } | null {
  const named = (n: Node): boolean => {
    const parts = strings(bodyOf<{ funcname?: Node[] }>(n).funcname);
    return parts[parts.length - 1] === "set_config" && (parts.length === 1 || (parts.length === 2 && parts[0] === PG_CATALOG));
  };
  const calls = collect(stmt, "FuncCall").filter(named);
  if (calls.length === 0) return null;
  const refuse = (at: number | null): never => {
    throw new Unsupported(`set_config() is answered by Mason only alone in a SELECT, with literal arguments (${gapMark("set-config-forms")})`,
      at, "0A000", "write SET name = 'value', or SELECT set_config('name', 'value', false) on its own", "set-config-forms");
  };
  const at = loc(calls[0]);
  if (kindOf(stmt) !== "SelectStmt") return refuse(at);
  const s = bodyOf<Any>(stmt);
  if (Object.keys(s).some((k) => k !== "targetList" && k !== "limitOption" && k !== "op") || s.op !== "SETOP_NONE") return refuse(at);
  const targets = (s.targetList ?? []) as Node[];
  const target = targets.length === 1 ? bodyOf<{ name?: string; val?: Node }>(targets[0]!) : null;
  if (target?.val === undefined || kindOf(target.val) !== "FuncCall" || !named(target.val)) return refuse(at);
  const call = bodyOf<Any>(target.val);
  if (Object.keys(call).some((k) => k !== "funcname" && k !== "args" && k !== "funcformat" && k !== "location")) return refuse(at);
  const args = ((call.args ?? []) as Node[]).map((a) => kindOf(a) === "A_Const" ? bodyOf<Any>(a) : null);
  const text = (c: Any | null): string | null => typeof (c?.sval as { sval?: unknown } | undefined)?.sval === "string" ? (c!.sval as { sval: string }).sval : null;
  const [name, value, local] = [text(args[0] ?? null), text(args[1] ?? null), args[2]?.boolval as { boolval?: boolean } | undefined];
  if (args.length !== 3 || name === null || value === null || local === undefined) return refuse(at);
  return { kind: "set_config", name: name.toLowerCase(), value, local: local.boolval === true, column: target.name ?? "set_config" };
}

/**
 * THE NAMES POSTGRES GIVES A SELECT'S RESULT COLUMNS (`FigureColname`, src/backend/parser/parse_target.c), where DuckDB
 * gives others (`count(*)` is `count_star()`, `sum(x)` is `sum(x)`; Postgres says `count`, `sum`): an alias as written,
 * a column's name, a function's, a cast's inner name or else its type's, `case`, `coalesce` …, and `?column?` for the
 * rest. A `*` is DuckDB's (its width is known only from the result: `null` there, one star at most). A set operation's
 * names are its first arm's. Null when the list cannot be named (two stars): DuckDB's names stand.
 */
export function pgColumnNames(s: SelectStmt): (string | null)[] | null {
  if (s.op !== undefined && s.op !== "SETOP_NONE" && s.larg !== undefined) return pgColumnNames(s.larg);
  if (s.valuesLists !== undefined && s.valuesLists.length > 0) {
    const first = s.valuesLists[0]!;
    const width = kindOf(first) === "List" ? (bodyOf<{ items?: Node[] }>(first).items ?? []).length : 0;
    return Array.from({ length: width }, (_, i) => `column${i + 1}`);
  }
  const names: (string | null)[] = [];
  let stars = 0;
  for (const t of s.targetList ?? []) {
    const rt = bodyOf<{ name?: string; val?: Node }>(t);
    if (rt.name !== undefined) { names.push(rt.name); continue; }
    if (rt.val !== undefined && kindOf(rt.val) === "ColumnRef" && (bodyOf<ColumnRef>(rt.val).fields ?? []).some((f) => kindOf(f) === "A_Star")) {
      stars++; names.push(null); continue;
    }
    names.push(rt.val === undefined ? "?column?" : figureColname(rt.val)[0] ?? "?column?");
  }
  return stars > 1 ? null : names;
}

const SQL_VALUE_NAMES: Record<string, string> = {
  SVFOP_CURRENT_DATE: "current_date", SVFOP_CURRENT_TIME: "current_time", SVFOP_CURRENT_TIME_N: "current_time", SVFOP_CURRENT_TIMESTAMP: "current_timestamp",
  SVFOP_CURRENT_TIMESTAMP_N: "current_timestamp", SVFOP_LOCALTIME: "localtime", SVFOP_LOCALTIME_N: "localtime", SVFOP_LOCALTIMESTAMP: "localtimestamp",
  SVFOP_LOCALTIMESTAMP_N: "localtimestamp", SVFOP_CURRENT_ROLE: "current_role", SVFOP_CURRENT_USER: "current_user", SVFOP_USER: "user",
  SVFOP_SESSION_USER: "session_user", SVFOP_CURRENT_CATALOG: "current_catalog", SVFOP_CURRENT_SCHEMA: "current_schema",
};

/** FigureColnameInternal: the name and its strength (0 none, 1 a fallback such as a cast's type or `case`, 2 a real one) */
function figureColname(n: Node): [string | null, number] {
  const k = kindOf(n);
  const b = bodyOf<Any>(n);
  switch (k) {
    case "ColumnRef": {
      const last = strings(b.fields as Node[] | undefined).filter((x) => x !== "").pop();
      return last === undefined ? [null, 0] : [last, 2];
    }
    case "A_Indirection": {
      const ind = (b.indirection as Node[] | undefined) ?? [];
      const last = ind[ind.length - 1];
      if (last !== undefined && kindOf(last) === "String") return [String(bodyOf<{ sval?: string }>(last).sval ?? ""), 2];
      return b.arg ? figureColname(b.arg as Node) : [null, 0];
    }
    case "FuncCall": {
      const last = strings(b.funcname as Node[] | undefined).pop();
      return last === undefined ? [null, 0] : [last, 2];
    }
    case "A_Expr": return b.kind === "AEXPR_NULLIF" ? ["nullif", 2] : [null, 0];
    case "TypeCast": {
      const inner = b.arg ? figureColname(b.arg as Node) : [null, 0] as [string | null, number];
      if (inner[1] > 0) return inner;
      const typeName = strings((b.typeName as { names?: Node[] } | undefined)?.names).pop();
      return typeName === undefined ? [null, 0] : [typeName, 1];
    }
    case "CollateClause": return b.arg ? figureColname(b.arg as Node) : [null, 0];
    case "GroupingFunc": return ["grouping", 2];
    case "SubLink": {
      if (b.subLinkType === "EXISTS_SUBLINK") return ["exists", 2];
      if (b.subLinkType === "ARRAY_SUBLINK") return ["array", 2];
      if (b.subLinkType === "EXPR_SUBLINK" && b.subselect !== undefined && kindOf(b.subselect as Node) === "SelectStmt") {
        const first = bodyOf<SelectStmt>(b.subselect as Node).targetList?.[0];
        if (first !== undefined) {
          const rt = bodyOf<{ name?: string; val?: Node }>(first);
          if (rt.name !== undefined) return [rt.name, 2];
          if (rt.val !== undefined) return figureColname(rt.val);
        }
      }
      return [null, 0];
    }
    case "CaseExpr": {
      const d = b.defresult ? figureColname(b.defresult as Node) : [null, 0] as [string | null, number];
      return d[1] <= 1 ? ["case", 1] : d;
    }
    case "A_ArrayExpr": return ["array", 2];
    case "RowExpr": return ["row", 2];
    case "CoalesceExpr": return ["coalesce", 2];
    case "MinMaxExpr": return [b.op === "IS_LEAST" ? "least" : "greatest", 2];
    case "SQLValueFunction": { const v = SQL_VALUE_NAMES[String(b.op)]; return v === undefined ? [null, 0] : [v, 2]; }
  }
  // every other expression has no name of its own: Postgres calls it ?column? (a naming rule, not an accepting one)
  return [null, 0];
}

function setStatement(s: VariableSetStmt): Translation {
  const name = String(s.name ?? "").toLowerCase();
  if (s.kind === "VAR_RESET") return { kind: "set", name, value: null, local: false, tag: "RESET" };
  if (s.kind === "VAR_SET_DEFAULT") return { kind: "set", name, value: null, local: s.is_local === true, tag: "SET" };
  if (s.kind === "VAR_RESET_ALL") return { kind: "set", name: "all", value: null, local: false, tag: "RESET" };
  // SET TRANSACTION is for the transaction alone, whichever way it is spelt; SET SESSION CHARACTERISTICS is the session's
  if (s.kind === "VAR_SET_MULTI") return { kind: "set", name, value: "", local: name === "transaction", tag: "SET" };
  if (s.kind !== "VAR_SET_VALUE") throw new Unsupported(`SET ${name}: ${String(s.kind)} is not supported`, s.location ?? null);
  const parts = (s.args ?? []).map((a) => {
    if (kindOf(a) === "A_Const") return constText(bodyOf<A_Const>(a));
    if (kindOf(a) === "TypeCast") { const c = bodyOf<TypeCast>(a); if (c.arg !== undefined && kindOf(c.arg) === "A_Const") return constText(bodyOf<A_Const>(c.arg)); }
    throw new Unsupported(`SET ${name}: a value of kind ${kindOf(a)} is not supported (a literal is)`, loc(a));
  });
  return { kind: "set", name, value: parts.join(", "), local: s.is_local === true, tag: "SET" };
}

function constText(c: A_Const): string {
  if (c.sval !== undefined) return String(c.sval.sval ?? "");
  if (c.ival !== undefined) return String(c.ival.ival ?? 0);
  if (c.fval !== undefined) return String(c.fval.fval ?? "0");
  if (c.boolval !== undefined) return c.boolval.boolval ? "on" : "off";
  if (c.isnull === true) return "";
  return "";
}

const isCatalogRelation = (r: RangeVar): boolean =>
  r.schemaname === PG_CATALOG || r.schemaname === INFORMATION_SCHEMA || (r.schemaname === undefined && String(r.relname ?? "").startsWith("pg_"));
