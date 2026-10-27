/**
 * WHAT POSTGRES RESOLVED A STATEMENT TO, as keys the DuckDB endpoint admits only once the oracle has held them to
 * Postgres (docs/SQL-SUPPORT.md "What is verified"; src/duck/verified.ts). The analysed tree (src/duck/pgtree.ts) names
 * every function, operator and aggregate by the OID Postgres chose for its argument types — `round(numeric, integer)`,
 * not "round" — every cast by its two types, every value by its type, and every construct by its node and the field that
 * says which kind of it it is (a LEFT from an INNER join, a correlated EXISTS from a scalar subquery). A statement whose
 * keys are all verified is made only of pieces the oracle answered exactly as Postgres does; anything else is refused by
 * name rather than answered by a rewrite nobody checked (the class a review found: a construct the
 * rewrite did not know, run by DuckDB as DuckDB means it).
 *
 * A key is `kind:value`: `node:OPEXPR`, `function:1711`, `operator:96`, `aggregate:2108`, `window:3100`, `type:1700`,
 * `cast:25>1700` (a cast's input and result types), `field:JOINEXPR.jointype=1`. Built-in OIDs are fixed by Postgres's
 * catalog (pg_proc.dat and its siblings), the same in the catalog Postgres as in the source; a function a customer
 * defined is never in the catalog Postgres, so it never reaches here.
 */
import { exprType, type TreeNode, type TreeValue } from "./pgtree.ts";

const isNode = (v: TreeValue | undefined): v is TreeNode => v !== null && v !== undefined && typeof v === "object" && !Array.isArray(v);
/** an OID a customer's database made (an extension's type or operator, a table's row type) differs between databases:
 *  marked `u<oid>` here, and named by the catalog before it is a key (`nameUserKeys`: `ext:=(citext,citext)`) */
const oidKey = (oid: string | number): string => Number(oid) >= 16384 ? `u${oid}` : String(oid);
const USER = /^u(\d+)$/;

/**
 * The keys holding a user OID, named by what the catalog says it is — an operator as `ext:<regoperator>`, a function or
 * aggregate as `ext:<regprocedure>`, a type as `ext:<typname>` (a table's row type as `rowtype`, whatever the table) —
 * so a key is the same in every catalog that has the extension. Unknown to the catalog, it stays `u<oid>`.
 */
export async function nameUserKeys(rows: (sql: string) => Promise<(string | null)[][]>, keys: ReadonlySet<string>): Promise<Set<string>> {
  const list = [...keys];
  if (!list.some((k) => USER.test(k.slice(k.indexOf(":") + 1)) || /[>:]u\d+$/.test(k))) return new Set(list);
  const oids = { proc: new Set<string>(), op: new Set<string>(), type: new Set<string>() };
  for (const k of list) {
    const kind = k.slice(0, k.indexOf(":")), value = k.slice(k.indexOf(":") + 1);
    const parts = kind === "cast" ? value.split(">") : [value];
    for (const p of parts) {
      const m = USER.exec(p);
      if (m === null) continue;
      (kind === "operator" ? oids.op : kind === "type" || kind === "cast" ? oids.type : oids.proc).add(m[1]!);
    }
  }
  const read = async (set: Set<string>, sql: (l: string) => string): Promise<Map<string, string>> =>
    set.size === 0 ? new Map() : new Map((await rows(sql([...set].join(", ")))).map((r) => [r[0]!, r[1]!]));
  const proc = await read(oids.proc, (l) => `SELECT oid::text, 'ext:' || oid::regprocedure::text FROM pg_proc WHERE oid IN (${l})`);
  const op = await read(oids.op, (l) => `SELECT oid::text, 'ext:' || oid::regoperator::text FROM pg_operator WHERE oid IN (${l})`);
  const type = await read(oids.type, (l) => `SELECT oid::text, CASE WHEN typtype = 'c' THEN 'rowtype' ELSE 'ext:' || typname END FROM pg_type WHERE oid IN (${l})`);
  const name = (kind: string, p: string): string => { const m = USER.exec(p); return m === null ? p : (kind === "operator" ? op : kind === "type" || kind === "cast" ? type : proc).get(m[1]!) ?? p; };
  return new Set(list.map((k) => {
    const kind = k.slice(0, k.indexOf(":")), value = k.slice(k.indexOf(":") + 1);
    return kind === "cast" ? `cast:${value.split(">").map((p) => name(kind, p)).join(">")}` : `${kind}:${name(kind, value)}`;
  }));
}
const nonEmpty = (v: TreeValue | undefined): boolean => Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined && v !== "<>";

/** the fields whose value says which KIND of a node it is — each kind answered differently, so each verified apart */
const KIND_FIELDS: Record<string, string[]> = {
  BOOLEXPR: ["boolop"], NULLTEST: ["nulltesttype"], BOOLEANTEST: ["booltesttype"], SUBLINK: ["subLinkType"],
  SQLVALUEFUNCTION: ["op"], MINMAXEXPR: ["op"], SCALARARRAYOPEXPR: ["useOr"], ROWCOMPAREEXPR: ["cmptype", "rctype"],
  JOINEXPR: ["jointype"], RANGETBLENTRY: ["rtekind", "lateral"], SETOPERATIONSTMT: ["op", "all"], AGGREF: ["aggkind", "aggstar"],
  WINDOWCLAUSE: ["frameOptions"], QUERY: ["limitOption", "hasDistinctOn", "hasRecursive", "hasTargetSRFs", "hasForUpdate"],
  SORTGROUPCLAUSE: ["nulls_first"], GROUPINGSET: ["kind"], XMLEXPR: ["op"], FUNCEXPR: ["funcretset", "funcvariadic"],
  WINDOWFUNC: ["winstar", "winagg"], CTE: ["ctematerialized"], COMMONTABLEEXPR: ["ctematerialized"],
};
/** the flags whose false is a kind of its own */
const BOTH_WAYS = new Set(["SCALARARRAYOPEXPR.useOr", "SETOPERATIONSTMT.all", "SORTGROUPCLAUSE.nulls_first"]);
/** the casts: a node whose input is its `arg` and whose result is its own type */
const CASTS = new Set(["RELABELTYPE", "COERCEVIAIO", "ARRAYCOERCEEXPR", "COERCETODOMAIN"]);
/** fields that hold an OID of what Postgres resolved the node to */
const RESOLVED: Record<string, [string, string]> = {
  FUNCEXPR: ["funcid", "function"], OPEXPR: ["opno", "operator"], DISTINCTEXPR: ["opno", "operator"], NULLIFEXPR: ["opno", "operator"],
  SCALARARRAYOPEXPR: ["opno", "operator"], AGGREF: ["aggfnoid", "aggregate"], WINDOWFUNC: ["winfnoid", "window"],
};

/** Every key of an analysed tree (a QUERY and everything under it). */
export function resolvedKeys(tree: TreeValue): Set<string> {
  const keys = new Set<string>();
  const visit = (v: TreeValue | undefined): void => {
    if (Array.isArray(v)) { for (const x of v) visit(x); return; }
    if (!isNode(v)) return;
    const name = v._node;
    keys.add(`node:${name}`);
    const t = exprType(v);
    if (t !== null && t.type !== 0) keys.add(`type:${oidKey(t.type)}`);
    const resolved = RESOLVED[name];
    if (resolved) { const oid = v[resolved[0]]; if (typeof oid === "string") keys.add(`${resolved[1]}:${oidKey(oid)}`); }
    if (CASTS.has(name) && isNode(v.arg)) {
      const from = exprType(v.arg);
      if (from !== null && t !== null) keys.add(`cast:${oidKey(from.type)}>${oidKey(t.type)}`);
    }
    // a flag that is false is the plain node, which `node:` already names (but `<> ALL` is not `IN`, nor UNION UNION ALL)
    for (const f of KIND_FIELDS[name] ?? []) { const x = v[f]; if (typeof x === "string" && (x !== "false" || BOTH_WAYS.has(`${name}.${f}`))) keys.add(`field:${name}.${f}=${x}`); }
    // an aggregate's DISTINCT, ORDER BY and FILTER, and a window's PARTITION BY and ORDER BY, each change its answer
    if (name === "AGGREF") for (const f of ["aggdistinct", "aggorder", "aggfilter", "aggdirectargs"]) if (nonEmpty(v[f])) keys.add(`field:AGGREF.${f}`);
    if (name === "WINDOWFUNC" && nonEmpty(v.aggfilter)) keys.add("field:WINDOWFUNC.aggfilter");
    if (name === "QUERY") for (const f of ["distinctClause", "groupingSets", "havingQual", "limitCount", "limitOffset", "cteList", "setOperations", "windowClause"]) if (nonEmpty(v[f])) keys.add(`field:QUERY.${f}`);
    // a join's alias list names every column of both sides, used or not: a column nobody reads decides nothing
    for (const [k, x] of Object.entries(v)) if (k !== "_node" && k !== "joinaliasvars") visit(x);
  };
  visit(tree);
  return keys;
}

// --------------------------------------------------------------------------------------------- what a key names

/** each kind field's values in SQL's words (the enums of Postgres 18's primnodes.h / parsenodes.h, as outfuncs.c writes them) */
const VALUES: Record<string, Record<string, string>> = {
  "BOOLEXPR.boolop": { and: "AND", or: "OR", not: "NOT" },
  "NULLTEST.nulltesttype": { 0: "IS NULL", 1: "IS NOT NULL" },
  "BOOLEANTEST.booltesttype": { 0: "IS TRUE", 1: "IS NOT TRUE", 2: "IS FALSE", 3: "IS NOT FALSE", 4: "IS UNKNOWN", 5: "IS NOT UNKNOWN" },
  "SUBLINK.subLinkType": { 0: "EXISTS (subquery)", 1: "op ALL (subquery)", 2: "IN / op ANY (subquery)", 3: "a row compared with a subquery", 4: "a scalar subquery", 5: "a multi-column assignment", 6: "ARRAY(subquery)", 7: "a WITH subquery" },
  "SQLVALUEFUNCTION.op": { 0: "CURRENT_DATE", 1: "CURRENT_TIME", 2: "CURRENT_TIME(n)", 3: "CURRENT_TIMESTAMP", 4: "CURRENT_TIMESTAMP(n)", 5: "LOCALTIME", 6: "LOCALTIME(n)", 7: "LOCALTIMESTAMP", 8: "LOCALTIMESTAMP(n)", 9: "CURRENT_ROLE", 10: "CURRENT_USER", 11: "USER", 12: "SESSION_USER", 13: "CURRENT_CATALOG", 14: "CURRENT_SCHEMA" },
  "MINMAXEXPR.op": { 0: "GREATEST", 1: "LEAST" },
  "SCALARARRAYOPEXPR.useOr": { true: "op ANY (array) / IN (list)", false: "op ALL (array)" },
  "JOINEXPR.jointype": { 0: "INNER JOIN", 1: "LEFT JOIN", 2: "FULL JOIN", 3: "RIGHT JOIN", 4: "a semi-join", 5: "an anti-join" },
  "RANGETBLENTRY.rtekind": { 0: "a table", 1: "a subquery in FROM", 2: "a join", 3: "a function in FROM", 4: "a table function", 5: "VALUES", 6: "a WITH query", 7: "a named tuplestore", 8: "an empty FROM", 9: "GROUP BY" },
  "RANGETBLENTRY.lateral": { true: "LATERAL" },
  "SETOPERATIONSTMT.op": { 1: "UNION", 2: "INTERSECT", 3: "EXCEPT" },
  "SETOPERATIONSTMT.all": { true: "UNION / INTERSECT / EXCEPT ALL", false: "UNION / INTERSECT / EXCEPT without ALL" },
  "AGGREF.aggkind": { n: "an aggregate", o: "an ordered-set aggregate (WITHIN GROUP)", h: "a hypothetical-set aggregate" },
  "AGGREF.aggstar": { true: "an aggregate of * (count(*))" },
  "QUERY.limitOption": { 0: "LIMIT / FETCH FIRST … ONLY", 1: "FETCH FIRST … WITH TIES" },
  "QUERY.hasDistinctOn": { true: "DISTINCT ON" }, "QUERY.hasRecursive": { true: "WITH RECURSIVE" },
  "QUERY.hasTargetSRFs": { true: "a set-returning function in the SELECT list" }, "QUERY.hasForUpdate": { true: "FOR UPDATE / FOR SHARE" },
  "SORTGROUPCLAUSE.nulls_first": { true: "NULLs first (NULLS FIRST, or DESC)", false: "NULLs last (NULLS LAST, or ASC)" },
  "GROUPINGSET.kind": { 0: "an empty grouping set ()", 1: "a grouping set's column", 2: "ROLLUP", 3: "CUBE", 4: "GROUPING SETS" },
  "FUNCEXPR.funcretset": { true: "a set-returning function" }, "FUNCEXPR.funcvariadic": { true: "a VARIADIC argument" },
  "WINDOWFUNC.winstar": { true: "a window function of *" }, "WINDOWFUNC.winagg": { true: "an aggregate OVER a window" },
  "CTE.ctematerialized": { 0: "WITH", 1: "WITH … AS MATERIALIZED", 2: "WITH … AS NOT MATERIALIZED" },
  "COMMONTABLEEXPR.ctematerialized": { 0: "WITH", 1: "WITH … AS MATERIALIZED", 2: "WITH … AS NOT MATERIALIZED" },
};
const FLAGS: Record<string, string> = {
  "AGGREF.aggdistinct": "an aggregate of DISTINCT values", "AGGREF.aggorder": "an aggregate's own ORDER BY", "AGGREF.aggfilter": "an aggregate's FILTER (WHERE …)",
  "AGGREF.aggdirectargs": "an ordered-set aggregate's direct argument", "WINDOWFUNC.aggfilter": "a window aggregate's FILTER (WHERE …)",
  "QUERY.distinctClause": "SELECT DISTINCT", "QUERY.groupingSets": "GROUPING SETS / ROLLUP / CUBE", "QUERY.havingQual": "HAVING",
  "QUERY.limitCount": "LIMIT", "QUERY.limitOffset": "OFFSET", "QUERY.cteList": "WITH", "QUERY.setOperations": "UNION / INTERSECT / EXCEPT", "QUERY.windowClause": "a window (OVER)",
};
const NODES: Record<string, string> = {
  AGGREF: "an aggregate", WINDOWFUNC: "a window function", SUBLINK: "a subquery", CASEEXPR: "CASE", CASEWHEN: "CASE's WHEN", CASETESTEXPR: "CASE x WHEN …",
  COALESCEEXPR: "COALESCE", NULLIFEXPR: "NULLIF", DISTINCTEXPR: "IS DISTINCT FROM", MINMAXEXPR: "GREATEST / LEAST", ARRAYEXPR: "ARRAY[…]",
  ROWEXPR: "ROW(…)", ROWCOMPAREEXPR: "a row comparison", SUBSCRIPTINGREF: "a subscript (a[i], a[i:j])", FIELDSELECT: "a field of a row value",
  COLLATEEXPR: "COLLATE", GROUPINGFUNC: "GROUPING()", XMLEXPR: "an XML function", SQLVALUEFUNCTION: "CURRENT_DATE and its kin",
  NULLTEST: "IS [NOT] NULL", BOOLEANTEST: "IS [NOT] TRUE / FALSE / UNKNOWN", BOOLEXPR: "AND / OR / NOT", SCALARARRAYOPEXPR: "IN (list) / op ANY|ALL (array)",
  OPEXPR: "an operator", FUNCEXPR: "a function call", CONST: "a literal", PARAM: "a parameter ($n)", VAR: "a column", JOINEXPR: "a JOIN",
  SETOPERATIONSTMT: "UNION / INTERSECT / EXCEPT", COMMONTABLEEXPR: "a WITH query", WINDOWCLAUSE: "a window (OVER)", GROUPINGSET: "a grouping set",
  RELABELTYPE: "a binary-compatible cast", COERCEVIAIO: "a cast through text", ARRAYCOERCEEXPR: "a cast of an array's elements", COERCETODOMAIN: "a cast to a domain",
  JSONEXPR: "a SQL/JSON function", JSONCONSTRUCTOREXPR: "a SQL/JSON constructor", JSONISPREDICATE: "IS JSON", MERGESUPPORTFUNC: "MERGE's support function",
  ALIAS: "an alias", FROMEXPR: "FROM and WHERE", NAMEDARGEXPR: "a named argument (name => value)", QUERY: "a query", RANGETBLENTRY: "an item of FROM",
  RANGETBLFUNCTION: "a function in FROM", RANGETBLREF: "an item of FROM", RTEPERMISSIONINFO: "a table read", SORTGROUPCLAUSE: "ORDER BY / GROUP BY / DISTINCT",
  TARGETENTRY: "an item of the SELECT list", WINDOWFUNCRUNCONDITION: "a window function's run condition",
  NEXTVALUEEXPR: "NEXT VALUE FOR", CURRENTOFEXPR: "CURRENT OF", INFERENCEELEM: "ON CONFLICT", TABLEFUNC: "a table function (XMLTABLE / JSON_TABLE)",
};

/** a window frame's options (FRAMEOPTION_* in parsenodes.h) as the clause that sets them */
export function frameText(options: number): string {
  if ((options & 1) === 0) return "the default window frame";
  const mode = options & 4 ? "ROWS" : options & 8 ? "GROUPS" : "RANGE";
  const bound = (unboundedPreceding: number, unboundedFollowing: number, current: number, offsetPreceding: number, offsetFollowing: number): string =>
    options & unboundedPreceding ? "UNBOUNDED PRECEDING" : options & unboundedFollowing ? "UNBOUNDED FOLLOWING" : options & current ? "CURRENT ROW"
      : options & offsetPreceding ? "n PRECEDING" : options & offsetFollowing ? "n FOLLOWING" : "?";
  const start = bound(32, 128, 512, 2048, 8192);
  const text = options & 16 ? `${mode} BETWEEN ${start} AND ${bound(64, 256, 1024, 4096, 16384)}` : `${mode} ${start}`;
  const exclude = options & 32768 ? " EXCLUDE CURRENT ROW" : options & 65536 ? " EXCLUDE GROUP" : options & 131072 ? " EXCLUDE TIES" : "";
  return text + exclude;
}

/**
 * What each key names, in SQL's words: a function's, operator's or type's from the catalog through `rows` (the catalog
 * Postgres's, or any Postgres 18's: built-in OIDs are the same in every one), a construct's from the tables above.
 */
export async function describeKeys(rows: (sql: string) => Promise<(string | null)[][]>, keys: Iterable<string>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const procs = new Set<string>(), ops = new Set<string>(), types = new Set<string>();
  const list = [...keys];
  for (const k of list) {
    const [kind, value] = [k.slice(0, k.indexOf(":")), k.slice(k.indexOf(":") + 1)];
    if (kind === "function" || kind === "aggregate" || kind === "window") procs.add(value);
    else if (kind === "operator") ops.add(value);
    else if (kind === "type") types.add(value);
    else if (kind === "cast") for (const t of value.split(">")) types.add(t);
  }
  const read = async (oids: Set<string>, sql: (list: string) => string): Promise<Map<string, string>> => {
    const valid = [...oids].filter((o) => /^\d+$/.test(o));
    return valid.length === 0 ? new Map() : new Map((await rows(sql(valid.join(", ")))).map((r) => [r[0]!, r[1]!]));
  };
  const proc = await read(procs, (l) => `SELECT oid::text, oid::regprocedure::text FROM pg_proc WHERE oid IN (${l})`);
  const op = await read(ops, (l) => `SELECT oid::text, oid::regoperator::text FROM pg_operator WHERE oid IN (${l})`);
  const type = await read(types, (l) => `SELECT oid::text, format_type(oid, NULL) FROM pg_type WHERE oid IN (${l})`);
  const typeName = (t: string): string => t === "rowtype" ? "a table's row type" : t.startsWith("ext:") ? `${t.slice(4)} (an extension's)` : type.get(t) ?? `type OID ${t}`;
  const extName = (v: string): string => v.startsWith("ext:") ? `${v.slice(4)} (an extension's)` : `OID ${v}`;
  for (const k of list) {
    const kind = k.slice(0, k.indexOf(":")), value = k.slice(k.indexOf(":") + 1);
    switch (kind) {
      case "node": out.set(k, NODES[value] ?? `Postgres's ${value} node`); break;
      case "function": out.set(k, `the function ${proc.get(value) ?? extName(value)}`); break;
      case "aggregate": out.set(k, `the aggregate ${proc.get(value) ?? extName(value)}`); break;
      case "window": out.set(k, `the window function ${proc.get(value) ?? extName(value)}`); break;
      case "operator": out.set(k, `the operator ${op.get(value) ?? extName(value)}`); break;
      case "type": out.set(k, `a value of type ${typeName(value)}`); break;
      case "cast": { const [from, to] = value.split(">") as [string, string]; out.set(k, `a cast from ${typeName(from)} to ${typeName(to)}`); break; }
      case "field": {
        const eq = value.indexOf("=");
        const field = eq < 0 ? value : value.slice(0, eq), v = eq < 0 ? "" : value.slice(eq + 1);
        out.set(k, eq < 0 ? FLAGS[field] ?? field : field === "WINDOWCLAUSE.frameOptions" ? `a window frame: ${frameText(Number(v))}` : VALUES[field]?.[v] ?? `${field} = ${v}`);
        break;
      }
      default: out.set(k, k);
    }
  }
  return out;
}
