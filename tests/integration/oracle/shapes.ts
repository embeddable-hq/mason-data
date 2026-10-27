/**
 * THE SHAPE MULTIPLIER (tests/integration/duck-oracle.itest.ts): each statement the oracle asks, asked again in the
 * shapes a BI tool wraps a question in — the rewrite meets every expression at another depth, beside a copy of
 * itself, or with its values arriving as parameters, and a rule that holds only at the top of a statement shows:
 *  - `subquery`: `SELECT * FROM (<statement>) AS s` (Metabase's nested questions, a filter over a saved one);
 *  - `cte`: `WITH s AS (<statement>) SELECT * FROM s` (dbt, Grafana's macros);
 *  - `union`: `(<statement>) UNION ALL (<statement>)`;
 *  - `parameters`: every literal of its WHERE and HAVING sent as `$n` over the extended protocol, as a driver binds
 *    a filter's value (pgjdbc, node-postgres, Metabase's prepared statements) — Postgres infers each one's type;
 *  - `named`: `SELECT s.<a>, s.<b> FROM (<statement>) AS s`, each column by the name POSTGRES gives it (`count` for
 *    count(*), `?column?` for 1 + 1), the names a tool reads back and writes into its wrapper;
 *  - `ordered`: `SELECT * FROM (<statement>) AS s ORDER BY s.<key>…`, the statement's own ORDER BY repeated OUTSIDE the
 *    derived table by column name (the wrapper a tool puts around hand-written SQL), compared IN ORDER.
 * The first three and `named` are compared as a set of rows (a subquery's order is no promise); `parameters` and
 * `ordered` as the statement. A review found both of the last two's classes in a real corpus: the
 * first run's shapes compared every wrapped statement as a set and read its columns by `*` alone.
 */
import { parseSql } from "../../../src/api/postgres/parser.ts";
import { figureColname } from "../../../src/duck/rewrite.ts";

export interface Shaped { shape: "subquery" | "cte" | "union" | "parameters" | "named" | "ordered"; sql: string; values?: string[]; inOrder: boolean }

type Ast = Record<string, Record<string, unknown>>;
const q = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** the statement's output column names as Postgres names them, when it is one SELECT without a star; else null */
async function outputNames(sql: string): Promise<{ names: string[]; sort: Array<{ name: string; dir: string; nulls: string }> | null } | null> {
  const parsed = await parseSql(sql);
  const stmt = parsed.stmts?.length === 1 ? parsed.stmts[0]!.stmt as Ast | undefined : undefined;
  const body = stmt?.SelectStmt;
  if (body === undefined || (body.op !== undefined && body.op !== "SETOP_NONE") || !Array.isArray(body.targetList)) return null;
  const targets = body.targetList as Array<{ ResTarget: { name?: string; val: Ast } }>;
  const isStar = (v: Ast): boolean => v.ColumnRef !== undefined && (v.ColumnRef.fields as Ast[]).some((f) => f.A_Star !== undefined);
  if (targets.some((t) => isStar(t.ResTarget.val))) return null;
  const names = targets.map((t) => t.ResTarget.name ?? figureColname(t.ResTarget.val as never));
  if (new Set(names).size !== names.length) return null;
  // the ORDER BY's keys by output name: an ordinal, an output name, or a target's own expression repeated
  const keyOf = (node: Ast): string | null => {
    if (node.A_Const?.ival !== undefined) { const n = Number((node.A_Const.ival as { ival?: number }).ival ?? 0); return n >= 1 && n <= names.length ? names[n - 1]! : null; }
    const shape = JSON.stringify(node, (k, v: unknown) => k === "location" ? undefined : v);
    const at = targets.findIndex((t) => JSON.stringify(t.ResTarget.val, (k, v: unknown) => k === "location" ? undefined : v) === shape);
    if (at >= 0) return names[at]!;
    if (node.ColumnRef !== undefined) { const f = node.ColumnRef.fields as Ast[]; const last = f[f.length - 1]?.String?.sval; return typeof last === "string" && f.length === 1 && names.includes(last) ? last : null; }
    return null;
  };
  const sort = Array.isArray(body.sortClause) ? (body.sortClause as Array<{ SortBy: { node: Ast; sortby_dir: string; sortby_nulls: string } }>).map((s) => {
    const name = keyOf(s.SortBy.node);
    return name === null ? null : { name, dir: s.SortBy.sortby_dir, nulls: s.SortBy.sortby_nulls };
  }) : null;
  return { names, sort: sort === null || sort.some((x) => x === null) ? null : sort as Array<{ name: string; dir: string; nulls: string }> };
}

type Node = Record<string, unknown>;
const isObject = (v: unknown): v is Node => v !== null && typeof v === "object" && !Array.isArray(v);

/** a literal's text at an offset: a quoted string ('' doubled) or a number, the minus of a negative one included */
function literalEnd(sql: string, at: number): number | null {
  if (sql[at] === "'") {
    for (let i = at + 1; i < sql.length; i++) {
      if (sql[i] !== "'") continue;
      if (sql[i + 1] === "'") { i++; continue; }
      return i + 1;
    }
    return null;
  }
  const m = /^-?\s*(\d[\d_]*(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(sql.slice(at));
  return m ? at + m[0].length : null;
}

/** the literals of a WHERE / HAVING, as [offset, end, value]; a typed literal (`date '…'`) stays, it cannot be a $n */
async function filterLiterals(sql: string): Promise<Array<[number, number, string]> | null> {
  const parsed = await parseSql(sql);
  const stmt = parsed.stmts?.length === 1 ? parsed.stmts[0]!.stmt : undefined;
  if (stmt === undefined) return null;
  const out: Array<[number, number, string]> = [];
  // the parser's offsets count bytes; the text is indexed by UTF-16 units
  const bytes = Buffer.from(sql, "utf8");
  const offset = (b: number): number => bytes.subarray(0, b).toString("utf8").length;
  // `date '…'` and `interval '1' day` are the type's syntax around a literal (the cast before it), `'…'::date` a cast
  // after one: only the second can take a $n
  const typeSyntax = new WeakSet<object>();
  const visit = (v: unknown, inFilter: boolean): void => {
    if (Array.isArray(v)) { for (const x of v) visit(x, inFilter); return; }
    if (!isObject(v)) return;
    for (const [k, x] of Object.entries(v)) {
      if (k === "A_Const" && inFilter && isObject(x) && typeof x.location === "number" && x.isnull !== true && x.boolval === undefined) {
        if (typeSyntax.has(x)) continue;
        const at = offset(x.location);
        const end = literalEnd(sql, at);
        if (end === null) return;
        const text = sql.slice(at, end);
        const value = text.startsWith("'") ? text.slice(1, -1).replace(/''/g, "'") : text.replace(/\s+/g, "");
        out.push([at, end, value]);
        continue;
      }
      if (k === "TypeCast" && isObject(x) && isObject(x.arg) && isObject(x.arg.A_Const)) {
        const lit = x.arg.A_Const;
        if (typeof x.location === "number" && typeof lit.location === "number" && x.location < lit.location) typeSyntax.add(lit);
      }
      visit(x, inFilter || k === "whereClause" || k === "havingClause");
    }
  };
  visit(stmt, false);
  // a string literal with a backslash or an E'' prefix reads otherwise than its text: left as written
  return out.filter(([at]) => sql[at - 1] !== "E" && sql[at - 1] !== "e");
}

export async function shapes(sql: string, inOrder: boolean): Promise<Shaped[]> {
  if (!/^\s*(SELECT|WITH|VALUES)\b/i.test(sql) || /\bFOR\s+(UPDATE|SHARE|NO KEY|KEY)\b/i.test(sql)) return [];
  const out: Shaped[] = [
    { shape: "subquery", sql: `SELECT * FROM (${sql}) AS mason_shape`, inOrder: false },
    { shape: "cte", sql: `WITH mason_shape AS (${sql}) SELECT * FROM mason_shape`, inOrder: false },
    { shape: "union", sql: `(${sql}) UNION ALL (${sql})`, inOrder: false },
  ];
  const outputs = await outputNames(sql);
  if (outputs !== null) {
    out.push({ shape: "named", sql: `SELECT ${outputs.names.map((n) => `mason_shape.${q(n)}`).join(", ")} FROM (${sql}) AS mason_shape`, inOrder: false });
    if (outputs.sort !== null && outputs.sort.length > 0) {
      const dir = (d: string): string => d === "SORTBY_DESC" ? " DESC" : d === "SORTBY_ASC" ? " ASC" : "";
      const nulls = (n: string): string => n === "SORTBY_NULLS_FIRST" ? " NULLS FIRST" : n === "SORTBY_NULLS_LAST" ? " NULLS LAST" : "";
      out.push({ shape: "ordered", sql: `SELECT * FROM (${sql}) AS mason_shape ORDER BY ${outputs.sort.map((k) => `mason_shape.${q(k.name)}${dir(k.dir)}${nulls(k.nulls)}`).join(", ")}`, inOrder: true });
    }
  }
  const literals = await filterLiterals(sql);
  if (literals !== null && literals.length > 0) {
    let text = "", from = 0;
    literals.sort((a, b) => a[0] - b[0]).forEach(([at, end], i) => { text += `${sql.slice(from, at)}$${i + 1}`; from = end; });
    out.push({ shape: "parameters", sql: text + sql.slice(from), values: literals.map(([, , v]) => v), inOrder });
  }
  return out;
}
