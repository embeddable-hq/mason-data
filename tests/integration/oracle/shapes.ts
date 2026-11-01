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
import { deparseSync } from "pgsql-deparser";
import { parseSql, PostgresSyntaxError } from "../../../src/api/postgres/parser.ts";
import { figureColname, sameTree } from "../../../src/duck/rewrite.ts";
import type { NewShapeName, ShapeName } from "./shape-names.ts";

export interface Shaped { shape: ShapeName; sql: string; values?: string[]; inOrder: boolean }
/** Postgres's answer to the statement: RowDescription's names, type OIDs and typmods, and its rows as text */
export interface SourceAnswer { names: string[]; oids: number[]; typmods: number[]; rows: (string | null)[][] }
/** a type as the SOURCE Postgres spells it (`format_type(oid, typmod)`) and its kind (`pg_type.typtype`); null: no such type */
export type TypeOf = (oid: number, typmod: number) => Promise<{ name: string; typtype: string } | null>;

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

/** the first six shapes (the head of this file), their texts and modes as they were */
async function firstShapes(sql: string, inOrder: boolean): Promise<Shaped[]> {
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

/*
 * THE SHAPES THAT VARY THE STATEMENT ITSELF (.claude/workflows/pr-loop.js VARIANT_FORMS, held on every push), each
 * built from Postgres's answers and never guessed from the text: the statement's STRUCTURE is its parse (parseSql); its
 * OUTPUT COLUMNS are the source's RowDescription (names, type OIDs, typmods) and its first row; a type's spelling is the
 * source's `format_type` (`typeOf`). A text is asked only once its parse holds the tree it was built to be (src/duck/
 * rewrite.ts sameTree, both ways, as the engine reads back what it prints); otherwise the shape is UNSPELLABLE for that
 * statement, counted and not asked. A modified tree (empty, the bounds) is printed by pgsql-deparser, the engine's
 * printer, from nodes taken from the parse of a template, never written by hand. The names, and how each lives, are
 * oracle/shape-names.ts's.
 *  - `table`, `table-arm`: `SELECT * FROM t <tail>` as `TABLE t <tail>`, and as a set operation's arm
 *    (`SELECT * FROM t UNION ALL TABLE t ORDER BY 1, …, n LIMIT 2`: issue 192's regression form);
 *  - `values-arm(-first)`, `null-arm(-first)`, `char-arm(-first)`, `integer-arm(-first)`: the statement beside an arm of
 *    its first row's values, of bare NULLs, of padded character values (UNION, so padding meets dedupe), of integers;
 *  - `empty`: the outermost SELECT with `false` as (or ANDed onto) its WHERE: the empty input reaches every aggregate,
 *    group, window and bound above it;
 *  - the bounds of the OUTERMOST query: `count-zero`, `count-negative`, `count-null`, `offset-negative`,
 *    `bound-expression`, `offset-zero` (none changes which rows a bound keeps: ties at a new boundary are undefined);
 *  - the numeric readers of every numeric output: `numeric-distinct`, `numeric-text`, `numeric-aggregate`,
 *    `numeric-ordered`.
 */
const CHAR = new Set([25, 1043, 1042]), INTEGER = new Set([21, 20, 700, 701, 1700]), NUMERIC = 1700, BPCHAR = 1042;

/** one statement's tree, `{SelectStmt: …}` and the like; null when the text is not ONE statement Postgres's grammar reads */
async function stmtOf(sql: string): Promise<Ast | null> {
  try {
    const parsed = await parseSql(sql);
    return parsed.stmts?.length === 1 ? parsed.stmts[0]!.stmt as unknown as Ast : null;
  } catch (e) {
    // a text the grammar refuses is an unspellable shape, said by the null and never asked: the refusal is the verdict
    if (e instanceof PostgresSyntaxError) return null;
    throw e;
  }
}
const same = (a: unknown, b: unknown): boolean => sameTree(a, b) && sameTree(b, a);
/** the parser's byte offset as an index into the text's UTF-16 units */
const charOffset = (sql: string, b: number): number => Buffer.from(sql, "utf8").subarray(0, b).toString("utf8").length;

type Templates = Record<"false" | "and" | "zero" | "minusOne" | "nullCount" | "offsetZero" | "offsetMinusOne" | "plusZero", Ast>;
let nodes: Templates | undefined;
/** the nodes the modified trees are made of, each from Postgres's parse of a template */
async function templates(): Promise<Templates> {
  const of = async (sql: string, key: string): Promise<Ast> => {
    const node = (await stmtOf(sql))?.SelectStmt?.[key];
    if (!isObject(node)) throw new Error(`oracle shapes: the template ${sql} has no ${key}`);
    return node as Ast;
  };
  return nodes ??= {
    false: await of("SELECT 1 WHERE false", "whereClause"),
    and: await of("SELECT 1 WHERE x AND false", "whereClause"),
    zero: await of("SELECT 1 LIMIT 0", "limitCount"),
    minusOne: await of("SELECT 1 LIMIT -1", "limitCount"),
    nullCount: await of("SELECT 1 LIMIT NULL", "limitCount"),
    offsetZero: await of("SELECT 1 OFFSET 0", "limitOffset"),
    offsetMinusOne: await of("SELECT 1 OFFSET -1", "limitOffset"),
    plusZero: await of("SELECT 1 LIMIT 1 + 0", "limitCount"),
  };
}

/** a modified SELECT printed by the engine's printer, or null when its text does not parse back to it */
async function printed(body: Node): Promise<string | null> {
  const tree = { SelectStmt: body };
  const text = deparseSync(tree as never, { pretty: false });
  const back = await stmtOf(text);
  return back !== null && same(back, tree) ? text : null;
}

/** `SELECT * FROM <one RangeVar, no alias, not ONLY>` with nothing after it but ORDER BY / LIMIT / OFFSET / FETCH */
function bareTable(body: Node): Node | null {
  if ((body.op !== undefined && body.op !== "SETOP_NONE") || ["whereClause", "groupClause", "groupDistinct", "havingClause", "distinctClause", "windowClause", "withClause", "lockingClause", "valuesLists", "intoClause"].some((k) => body[k] !== undefined)) return null;
  const targets = body.targetList, from = body.fromClause;
  if (!Array.isArray(targets) || targets.length !== 1 || !Array.isArray(from) || from.length !== 1) return null;
  const t = (targets[0] as Ast).ResTarget;
  const fields = (t?.val as Ast | undefined)?.ColumnRef?.fields;
  if (t === undefined || t.name !== undefined || !Array.isArray(fields) || fields.length !== 1 || !isObject(fields[0]) || fields[0].A_Star === undefined) return null;
  const rv = (from[0] as Ast).RangeVar;
  return rv !== undefined && rv.alias === undefined && rv.inh === true && typeof rv.location === "number" ? rv : null;
}

/** a literal of Postgres's output text, cast to the type the source spells (quotes doubled) */
const literal = (text: string | null, type: string): string => text === null ? `NULL::${type}` : `'${text.replace(/'/g, "''")}'::${type}`;

/**
 * Every shape of one statement both sides answered alike: the first six (none in the `copy` group), then the shapes that
 * vary the statement itself (only `table` and `table-arm` in the `copy` group). `answer` is the source's; `typeOf` the
 * source's type spelling. `unspellable`: each shape that reached the statement and whose text did not hold its tree.
 */
export async function shapes(sql: string, inOrder: boolean, group: string, answer: SourceAnswer, typeOf: TypeOf): Promise<{ shaped: Shaped[]; unspellable: NewShapeName[] }> {
  const shaped: Shaped[] = [], unspellable: NewShapeName[] = [];
  // (a row lock is never shaped; the first six keep their gate on the text, the new ones read the parse: a statement
  // that opens with a parenthesised set operation is one SELECT too)
  if (/\bFOR\s+(UPDATE|SHARE|NO KEY|KEY)\b/i.test(sql)) return { shaped, unspellable };
  if (group !== "copy" && /^\s*(SELECT|WITH|VALUES)\b/i.test(sql)) shaped.push(...await firstShapes(sql, inOrder));
  const stmt = await stmtOf(sql);
  const body = stmt?.SelectStmt;
  if (stmt === null || body === undefined || body.lockingClause !== undefined || body.intoClause !== undefined) return { shaped, unspellable };
  const put = (shape: NewShapeName, text: string | null, mode: boolean): void => { if (text === null) unspellable.push(shape); else shaped.push({ shape, sql: text, inOrder: mode }); };
  const n = answer.names.length;

  // TABLE: the written text from the relation on, which keeps its tail; and as a set operation's arm, the relation
  // spelt by this module's one quoting (`q`), each arm read back as the statement's relation
  const rel = bareTable(body);
  if (rel !== null && n > 0) {
    const text = `TABLE ${sql.slice(charOffset(sql, rel.location as number))}`;
    const back = await stmtOf(text);
    put("table", back !== null && same(back, stmt) ? text : null, inOrder);
    const name = (["catalogname", "schemaname", "relname"] as const).flatMap((k) => typeof rel[k] === "string" ? [q(rel[k] as string)] : []).join(".");
    const arm = `SELECT * FROM ${name} UNION ALL TABLE ${name} ORDER BY ${Array.from({ length: n }, (_, i) => i + 1).join(", ")} LIMIT 2`;
    const a = (await stmtOf(arm))?.SelectStmt;
    const relOf = (side: unknown): unknown => isObject(side) && Array.isArray(side.fromClause) ? (side.fromClause[0] as Ast | undefined)?.RangeVar : undefined;
    put("table-arm", a !== undefined && a.op === "SETOP_UNION" && a.all === true && same(relOf(a.larg), rel) && same(relOf(a.rarg), rel) ? arm : null, true);
  }
  if (group === "copy") return { shaped, unspellable };

  // THE ARMS: the statement beside a row of Postgres's own making, on either side; the statement's side must read back
  // as the statement's own tree
  const armed = async (shape: NewShapeName, op: "UNION ALL" | "UNION", arm: string, first: boolean): Promise<void> => {
    const text = first ? `${arm} ${op} (${sql})` : `(${sql}) ${op} ${arm}`;
    const a = (await stmtOf(text))?.SelectStmt;
    const ok = a !== undefined && a.op === "SETOP_UNION" && (a.all === true) === (op === "UNION ALL") && a.sortClause === undefined && a.limitCount === undefined && same(first ? a.rarg : a.larg, body);
    put(shape, ok ? text : null, false);
  };
  if (n > 0) {
    if (answer.rows.length > 0) {
      const types = await Promise.all(answer.oids.map((o, i) => typeOf(o, answer.typmods[i] ?? -1)));
      if (!types.some((t) => t?.typtype === "p")) {
        const values = types.every((t) => t !== null) ? `VALUES (${answer.rows[0]!.map((v, i) => literal(v, types[i]!.name)).join(", ")})` : null;
        for (const first of [false, true]) {
          const shape = first ? "values-arm-first" : "values-arm";
          if (values === null) unspellable.push(shape); else await armed(shape, "UNION ALL", values, first);
        }
      }
    }
    const nulls = `SELECT ${Array.from({ length: n }, () => "NULL").join(", ")}`;
    await armed("null-arm", "UNION ALL", nulls, false);
    await armed("null-arm-first", "UNION ALL", nulls, true);
    if (answer.oids.some((o) => CHAR.has(o))) {
      const chars = `SELECT ${answer.oids.map((o, i) => {
        if (!CHAR.has(o)) return "NULL";
        const v = answer.rows[0]?.[i] ?? "ab";
        return o === BPCHAR ? literal(v, "text") : literal(v, `character(${[...v].length + 2})`);
      }).join(", ")}`;
      await armed("char-arm", "UNION", chars, false);
      await armed("char-arm-first", "UNION", chars, true);
    }
    if (answer.oids.some((o) => INTEGER.has(o))) {
      const ints = `SELECT ${answer.oids.map((o) => INTEGER.has(o) ? "1" : "NULL").join(", ")}`;
      await armed("integer-arm", "UNION ALL", ints, false);
      await armed("integer-arm-first", "UNION ALL", ints, true);
    }
  }

  // EMPTY: the outermost SELECT over a FROM, its WHERE false, or false ANDed on as the grammar's makeAndExpr does it (an
  // AND's arguments grow by one)
  const t = await templates();
  if ((body.op === undefined || body.op === "SETOP_NONE") && Array.isArray(body.fromClause) && body.fromClause.length > 0 && body.valuesLists === undefined) {
    const where = body.whereClause as Ast | undefined;
    const no = (): Ast => structuredClone(t.false);
    const clause = where === undefined ? no()
      : where.BoolExpr?.boolop === "AND_EXPR" ? { BoolExpr: { ...where.BoolExpr, args: [...(where.BoolExpr.args as unknown[]), no()] } }
      : { BoolExpr: { ...t.and.BoolExpr!, args: [where, no()] } };
    put("empty", await printed({ ...body, whereClause: clause }), inOrder);
  }

  // THE BOUNDS of the outermost query (a SELECT or a set operation), LIMIT and FETCH alike
  const count = body.limitCount, offset = body.limitOffset;
  if (count !== undefined || offset !== undefined) {
    const bound = async (shape: NewShapeName, change: Node, mode: boolean): Promise<void> => put(shape, await printed({ ...body, ...structuredClone(change) }), mode);
    await bound("count-zero", { limitCount: t.zero }, false);
    if (count !== undefined) await bound("count-negative", { limitCount: t.minusOne }, false);
    await bound("count-null", { limitCount: t.nullCount, limitOffset: t.nullCount }, false);
    await bound("offset-negative", { limitOffset: t.offsetMinusOne }, false);
    const plus = (x: unknown): Ast => ({ A_Expr: { ...t.plusZero.A_Expr!, lexpr: x } });
    await bound("bound-expression", { ...(count === undefined ? {} : { limitCount: plus(count) }), ...(offset === undefined ? {} : { limitOffset: plus(offset) }) }, inOrder);
    if (offset === undefined) await bound("offset-zero", { limitOffset: t.offsetZero }, inOrder);
  }

  // THE NUMERIC READERS: every numeric output, by Postgres's names (unique), over a derived table or a CTE that must read
  // back as the statement's own tree
  const numeric = answer.names.filter((_, i) => answer.oids[i] === NUMERIC).map((name) => `mason_shape.${q(name)}`);
  if (numeric.length > 0 && new Set(answer.names).size === answer.names.length) {
    const derived = async (shape: NewShapeName, text: string, mode: boolean): Promise<void> => {
      const from = (await stmtOf(text))?.SelectStmt?.fromClause;
      const sub = Array.isArray(from) && from.length === 1 ? (from[0] as Ast).RangeSubselect?.subquery : undefined;
      put(shape, sub !== undefined && same(sub, stmt) ? text : null, mode);
    };
    await derived("numeric-distinct", `SELECT DISTINCT ${numeric.join(", ")} FROM (${sql}) AS mason_shape`, false);
    await derived("numeric-text", `SELECT ${numeric.map((c) => `${c}::text`).join(", ")} FROM (${sql}) AS mason_shape`, false);
    const cte = `WITH mason_shape AS (${sql}) SELECT ${numeric.map((c) => `sum(${c}), min(${c}), max(${c}), count(DISTINCT ${c})`).join(", ")} FROM mason_shape`;
    const ctes = ((await stmtOf(cte))?.SelectStmt?.withClause as Node | undefined)?.ctes;
    const query = Array.isArray(ctes) && ctes.length === 1 ? (ctes[0] as Ast).CommonTableExpr?.ctequery : undefined;
    put("numeric-aggregate", query !== undefined && same(query, stmt) ? cte : null, false);
    await derived("numeric-ordered", `SELECT ${numeric.join(", ")} FROM (${sql}) AS mason_shape ORDER BY ${numeric.map((c) => `${c}, ${c}::text COLLATE "C"`).join(", ")}`, true);
  }
  return { shaped, unspellable };
}
