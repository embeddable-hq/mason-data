/**
 * THE SHAPES' NAMES, HOW EACH LIVES, AND ITS TALLY (oracle/shapes.ts builds them; tests/integration/duck-oracle.itest.ts
 * asks them; scripts/oracle-legs.ts holds the legs' tallies to this list). One module, so the names and what each is
 * expected to meet cannot drift apart. It imports no package: oracle-legs runs in CI's final jobs with no `npm ci`
 * (tests/conventions.test.ts "what CI's final jobs run needs no npm ci").
 *
 * A shape LIVES when the run shows Postgres answering it as the shape declares, and Mason agreeing or differing by a
 * DECIDED difference (oracle/known.ts): an ANSWER shape when some statement's shape Postgres answered was answered alike
 * or decided, a REFUSAL shape when some statement's shape Postgres refused with the declared SQLSTATE was refused alike
 * or decided. So every shape's liveness can be reached by recording a difference the base already has (a KNOWN entry
 * naming its `issue`), never only by fixing it, which a PR that finds it may not do. A refusal both share keeps no answer
 * shape alive, nor does a decided one; and a Postgres refusal under a SQLSTATE the shape does not declare is a MISSPELT
 * shape: its text says something other than what it was built to say.
 */

/** the six shapes of the first multiplier: tallied, not held to the rules below (their behaviour is out of scope) */
export const FIRST_SHAPES = ["subquery", "cte", "union", "parameters", "named", "ordered"] as const;

/** each new shape: how it lives, and the SQLSTATEs Postgres may answer it with (a refusal shape's first is its life) */
export const NEW_SHAPES = {
  "table": { life: "answer", may: [] },
  // ORDER BY every column: a type with no ordering operator (json, point, xml) is refused, 42883
  "table-arm": { life: "answer", may: ["42883"] },
  "values-arm": { life: "answer", may: [] },
  "values-arm-first": { life: "answer", may: [] },
  "null-arm": { life: "answer", may: [] },
  "null-arm-first": { life: "answer", may: [] },
  // UNION (distinct) beside an output of a type with no equality operator (json, point, xml): 42883
  "char-arm": { life: "answer", may: ["42883"] },
  "char-arm-first": { life: "answer", may: ["42883"] },
  "integer-arm": { life: "answer", may: [] },
  "integer-arm-first": { life: "answer", may: [] },
  "empty": { life: "answer", may: [] },
  "count-zero": { life: "answer", may: [] },
  "count-negative": { life: "refusal", may: ["2201W"] },
  // a NULL count under WITH TIES is Postgres's 2201W (unspellable today: the deparser drops WITH TIES). With no bound,
  // every row is computed: one past the base's bound that Postgres cannot compute is refused, a bad input (22P02, met
  // by PR 261's first run) or a division by zero (22012)
  "count-null": { life: "answer", may: ["2201W", "22P02", "22012"] },
  "offset-negative": { life: "refusal", may: ["2201X"] },
  "bound-expression": { life: "answer", may: [] },
  "offset-zero": { life: "answer", may: [] },
  "numeric-distinct": { life: "answer", may: [] },
  "numeric-text": { life: "answer", may: [] },
  "numeric-aggregate": { life: "answer", may: [] },
  "numeric-ordered": { life: "answer", may: [] },
} as const satisfies Record<string, { life: "answer" | "refusal"; may: readonly string[] }>;

export type NewShapeName = keyof typeof NEW_SHAPES;
export type ShapeName = (typeof FIRST_SHAPES)[number] | NewShapeName;
export const isNewShape = (s: string): s is NewShapeName => Object.hasOwn(NEW_SHAPES, s);

/** what one shape met over a run: every ask, how both sides answered it, and the statements it could not be spelt for */
export interface ShapeCount {
  asked: number;
  /** both answered, alike */
  answeredAlike: number;
  /** both refused with one SQLSTATE, by that SQLSTATE */
  refusedAlike: Record<string, number>;
  /** every Postgres refusal of the shape, by SQLSTATE, whatever Mason answered */
  postgresRefused: Record<string, number>;
  /** Mason's 0A000 naming a refused gap */
  refusedByGap: number;
  /** a decided difference (oracle/known.ts), whatever Postgres answered */
  decided: number;
  /** of `decided`, those Postgres refused, by its SQLSTATE: what keeps a refusal shape alive, and no answer shape */
  decidedRefused: Record<string, number>;
  differs: number;
  /** a statement the shape reaches, whose text did not read back as the tree it was built to be: not asked */
  unspellable: number;
}
export type ShapeTally = Partial<Record<ShapeName, ShapeCount>>;

export const emptyShapeCount = (): ShapeCount => ({ asked: 0, answeredAlike: 0, refusedAlike: {}, postgresRefused: {}, decidedRefused: {}, refusedByGap: 0, decided: 0, differs: 0, unspellable: 0 });

/** the legs' tallies summed */
export function sumShapeTallies(tallies: readonly ShapeTally[]): ShapeTally {
  const sum: ShapeTally = {};
  const add = (into: Record<string, number>, from: Record<string, number>): void => { for (const [k, n] of Object.entries(from)) into[k] = (into[k] ?? 0) + n; };
  for (const t of tallies) for (const [name, c] of Object.entries(t) as Array<[ShapeName, ShapeCount]>) {
    const s = sum[name] ??= emptyShapeCount();
    for (const k of ["asked", "answeredAlike", "refusedByGap", "decided", "differs", "unspellable"] as const) s[k] += c[k];
    add(s.refusedAlike, c.refusedAlike);
    add(s.postgresRefused, c.postgresRefused);
    add(s.decidedRefused, c.decidedRefused);
  }
  return sum;
}

/** A dead or misspelt new shape, each said with what it met: none means every new shape did its work. */
export function shapeProblems(tally: ShapeTally): string[] {
  const problems: string[] = [];
  for (const [name, spec] of Object.entries(NEW_SHAPES) as Array<[NewShapeName, (typeof NEW_SHAPES)[NewShapeName]]>) {
    const c = tally[name] ?? emptyShapeCount();
    const may: readonly string[] = spec.may;
    const decidedRefused = Object.values(c.decidedRefused).reduce((a, n) => a + n, 0);
    const alive = spec.life === "answer" ? c.answeredAlike + c.decided - decidedRefused > 0 : (c.refusedAlike[may[0]!] ?? 0) + (c.decidedRefused[may[0]!] ?? 0) > 0;
    if (!alive) problems.push(`the shape ${name} is dead: ${spec.life === "answer" ? "no statement's shape Postgres answered was answered alike or decided" : `no statement's shape Postgres refused with ${may[0]} was refused alike or decided`} (${say(c)}). ` +
      "Read its differences in the differences file: a difference the base already has is filed once and recorded in KNOWN with `shape` and `issue`; otherwise find why it is never answered, or remove the shape from oracle/shape-names.ts");
    for (const [code, n] of Object.entries(c.postgresRefused)) if (!may.includes(code)) problems.push(`the shape ${name} is misspelt: Postgres refused it ${n} time(s) with ${code}, which it does not declare. Read the shape's text in the differences file, and fix the shape or declare the SQLSTATE in oracle/shape-names.ts`);
  }
  return problems;
}

/** one shape's tally, in a line */
export const say = (c: ShapeCount): string => `asked ${c.asked}, alike ${c.answeredAlike}, refused alike ${JSON.stringify(c.refusedAlike)}, refused by gap ${c.refusedByGap}, decided ${c.decided}${Object.keys(c.decidedRefused).length > 0 ? ` (of refusals ${JSON.stringify(c.decidedRefused)})` : ""}, differs ${c.differs}, unspellable ${c.unspellable}`;
