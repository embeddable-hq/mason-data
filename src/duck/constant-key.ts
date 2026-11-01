import type { Keys, TreeValue } from "./pgtree.ts";

/**
 * A CONSTANT SORT KEY (the class, issue 134: a fact derived in several places, whether a sort key is constant). A
 * constant orders no row, and written into the engine's sort as a bare literal it is an ordinal (an integer) or refused
 * (42804, a non-integer literal). Five findings on PR 170 were each a spelling a syntactic matcher took or missed
 * (`1.5::numeric`, a Const to Postgres, written as the bare 1.5), so it is decided from Postgres's ANALYSIS, here alone:
 * an expression is constant where the analysis put a Const (under a COLLATE, which changes no value). The analysis has
 * folded a cast of an untyped literal and a cast to the type the value has (`'x'::text`, `NULL::int`, `1.5::numeric`)
 * and checked them; anything else is a node Postgres evaluates (`1::bigint`, `2147483648::int`, `12345::numeric(3)`,
 * `'abc'::text::int`, `1 / 0`, `$1`), at planning where it may raise, so it is a key the engine evaluates too.
 *
 * Read by `typesByLocation` (src/duck/pgtree.ts: `Typed.constant`, what src/duck/rewrite.ts drops a SELECT's key by,
 * resolved through its output's name or number) and by src/duck/late.ts (a derived table's column, folded into the
 * query around it).
 */
export function constantExpression(v: TreeValue | undefined): boolean {
  if (v === null || v === undefined || typeof v !== "object" || Array.isArray(v)) return false;
  return v._node === "CONST" || (v._node === "COLLATEEXPR" && constantExpression(v.arg));
}

/**
 * WHETHER EACH KEY OF A CLAUSE IS CONSTANT, BY THE ENTRY POSTGRES BOUND IT TO (the class "an output not resolved to its
 * column", its second instance: a key spelled unlike the output it equals, `'1.5'::numeric` beside `1.5::numeric AS v`,
 * was matched by syntax, missed, and written bare). Postgres binds a key to an entry by its number or output name, or by
 * EQUALITY OF THE ANALYSED EXPRESSIONS (findTargetlistEntrySQL99, the first equal entry), and only a key it bound to a
 * new entry leaves a node at its own offset. So `known` is each key's entry where the caller can tell it (a number, an
 * output name, an entry at the key's own offset) and null where Postgres bound it by equality; such a key is one of
 * the clause's entries the analysis lists, and is resolved as the ways the clause reads that way: ORDER BY lists
 * its keys' entries in order, each once (`sorted`); DISTINCT ON compares the set of them (`distinct`). What is known of
 * such a key narrows them (`Unbound`). A key is constant when every way agrees it is; null where no way fits, or the
 * ways disagree (the caller's own reading stands).
 */
export function keysConstant(keys: Keys, clause: "sorted" | "distinct", known: ReadonlyArray<number | Unbound>): Array<boolean | null> {
  return keysBound(keys, clause, known).map((k) => k.constant);
}

/**
 * EACH KEY'S ENTRY, AS POSTGRES BOUND IT (the class "an output not resolved to its column", its fourth round: the binding
 * decides how a key is WRITTEN, not only whether it is constant). `entry` is the target entry every way the clause can
 * read agrees the key is bound to (null where they disagree, or none fits); `constant` as `keysConstant`. A key bound to
 * an entry below the outputs' count IS that output (src/duck/rewrite.ts `keysBound`, which writes it so).
 */
export function keysBound(keys: Keys, clause: "sorted" | "distinct", known: ReadonlyArray<number | Unbound>): Array<{ entry: number | null; constant: boolean | null }> {
  const listed = keys[clause];
  const constant = (e: number): boolean | null => keys.entries[e]?.constant ?? null;
  const open = known.flatMap((k, i) => typeof k === "number" ? [] : [i]);
  // a key bound by equality is bound to the FIRST entry equal to it, and one equal to it: alike in reading a column, and
  // in being a Const where its own analysis is known
  const first = [...new Set(listed.filter((e) => keys.entries[e]?.first === e))];
  const choices = open.map((i) => {
    const k = known[i] as Unbound;
    return first.filter((e) => (k.reads === null || keys.entries[e]!.reads === k.reads) && (k.constant === null || keys.entries[e]!.constant === k.constant));
  });
  const agreed = known.map((k) => typeof k === "number" ? { entry: k as number | null, constant: constant(k) } : { entry: null, constant: null });
  if (open.length === 0) return agreed;
  const fits = (entries: number[]): boolean => {
    if (clause === "distinct") return new Set(entries).size === new Set(listed).size && listed.every((e) => entries.includes(e));
    const read: number[] = [];
    for (const e of entries) if (!read.includes(e)) read.push(e);
    return read.length === listed.length && read.every((e, i) => e === listed[i]);
  };
  // every way the open keys can be bound (a clause has a handful of keys; past the bound, the caller's reading stands)
  const ways = choices.reduce((n, c) => n * c.length, 1);
  if (ways > 4096) return agreed;
  const seen: Array<Set<boolean | null>> = open.map(() => new Set());
  const bound: Array<Set<number>> = open.map(() => new Set());
  const choice = open.map(() => 0);
  for (let n = 0; n < ways; n++) {
    let at = n;
    choices.forEach((c, i) => { choice[i] = c[at % c.length]!; at = Math.floor(at / c.length); });
    const entries = known.map((k, i) => typeof k === "number" ? k : choice[open.indexOf(i)]!);
    if (fits(entries)) open.forEach((_, i) => { seen[i]!.add(constant(choice[i]!)); bound[i]!.add(choice[i]!); });
  }
  open.forEach((key, i) => {
    agreed[key] = { entry: bound[i]!.size === 1 ? [...bound[i]!][0]! : null, constant: seen[i]!.size === 1 ? [...seen[i]!][0]! : null };
  });
  return agreed;
}

/** what is known of a key Postgres bound by equality, from its own text: whether it reads a column (null for unknown),
 *  and whether it is a Const where an expression of the same text was analysed elsewhere (null for none) */
export interface Unbound { reads: boolean | null; constant: boolean | null }

/**
 * A KEY WRITTEN AS A BARE LITERAL that the analysis did not call constant (a rewrite that wrote a value it computed):
 * the engine would read it as an ordinal or refuse it, so it is written as an expression the engine evaluates, which
 * orders nothing, as the value does in Postgres. A literal cannot raise, and its text never fails a cast.
 */
export function evaluated<T>(n: T): T {
  const kind = typeof n === "object" && n !== null && !Array.isArray(n) ? Object.keys(n)[0] : undefined;
  return kind === "A_Const"
    ? { TypeCast: { arg: n, typeName: { names: [{ String: { sval: "varchar" } }], typemod: -1 } } } as T
    : n;
}
