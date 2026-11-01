---
paths:
  - "src/duck/analyze.ts"
  - "src/duck/distinct-key.ts"
  - "src/duck/explain.ts"
  - "src/duck/functions.ts"
  - "src/duck/gaps.ts"
  - "src/duck/grants.ts"
  - "src/duck/jsonb-order.ts"
  - "src/duck/jsonb.ts"
  - "src/duck/late.ts"
  - "src/duck/libc-order.ts"
  - "src/duck/pg-eval-worker.ts"
  - "src/duck/pg-eval.ts"
  - "src/duck/pgtree.ts"
  - "src/duck/plan.ts"
  - "src/duck/resolved.ts"
  - "src/duck/rewrite.ts"
  - "src/duck/row-filter.ts"
  - "src/duck/to-char.ts"
  - "src/duck/types.ts"
  - "src/duck/verified.ts"
  - "src/duck/views.ts"
  - "tests/duck-corpus.test.ts"
  - "tests/duck-distinct-key.test.ts"
  - "tests/duck-explain-options.test.ts"
  - "tests/duck-functions.test.ts"
  - "tests/duck-gaps.test.ts"
  - "tests/duck-jsonb-order.test.ts"
  - "tests/duck-libc-order.test.ts"
  - "tests/duck-plans.test.ts"
  - "tests/duck-row-filter.test.ts"
  - "tests/duck-wire.test.ts"
  - "tests/integration/duck-oracle.itest.ts"
  - "tests/integration/duck-to-char.itest.ts"
---

<!-- Loaded only when a matching file is read or edited (the paths above). CLAUDE.md lists every rules file. -->

## A statement

- **DuckDB runs only a `PlannedSql`, made in `src/duck/plan.ts` alone, after the read-back** (`tests/conventions.test.ts`):
  a statement's own text never reaches DuckDB, because an `EXPLAIN ANALYZE <write>` that did ran the write
  (docs/DESIGN.md "The review").
- **EXPLAIN's first line says how a copy is kept current from `Sync.keptOf`, never the poll's ledger** (`keptText`,
  src/duck/explain.ts; the rule is `.claude/rules/duck-sync.md`). ("EXPLAIN")
- **A node is placed ONCE in the rewritten tree**: the walker runs a node's rule at its first place only, so a rule that
  uses a node twice clones it per use (`this.cp`, a helper's `copy`), or the second place is Postgres's text (a json
  read's column qualified in one arm of its CASE: DuckDB's 42804, a review finding). The walker records a node
  of the statement met twice outside its own rule's answer (`nodesPlacedTwice`, src/duck/rewrite.ts), and
  `tests/duck-wire.test.ts`, `tests/duck-corpus.test.ts` and the oracle hold it to none. ("A `->>` is DuckDB's own read")
- **A rewrite the deparser cannot spell is a refusal, never a different statement**: the rewritten tree is deparsed,
  parsed again and compared node for node (`treeDifference`). ("How a statement is answered")
- **No DuckDB macro**: with the `postgres` extension loaded, a macro with a lambda or calling a macro
  fails; every helper is a JavaScript scalar function (`src/duck/functions.ts`) or SQL written inline.
  A statement's every `__mason_*` call carries `getvariable('__mason_session')` first (`fn`; `.claude/rules/duck-executor.md`).
  ("How a statement is answered")
- **What DuckDB is sent is the form it computes natively, where that is Postgres's answer** (each was a BI tool's slow
  path on the test server, and two were not Postgres's answer either; "What DuckDB is sent"):
  - **a truncation of a timestamptz is the instant's arithmetic** (`truncInstant`: `epoch_us` floored, `make_timestamptz`),
    never ICU's calendar where the arithmetic is Postgres's: every part in UTC, a second or less in any zone, a minute or
    an hour elsewhere with the instant's offset kept (ICU re-read the wall clock: 02:30 CEST truncated to 02:00 +01). A
    day or more in another zone stays DuckDB's `date_trunc` in the session's zone. ICU is ~45 ns a row even in UTC, the
    arithmetic ~8; a TIMESTAMP ↔ TIMESTAMPTZ cast is ICU's too, so never "cast, truncate, cast back". The session's
    zone is read where the statement executes (`current_setting('TimeZone')`), never the rewriter's: a prepared
    statement's plan is made at its Parse and run after a later `SET TimeZone`;
  - **a LEFT JOIN of a list's rows ON TRUE is an INNER lateral of a list never empty only where its rows' order
    decides the answer** (`leftLateral`, `markBounds`, `limitBounds`, the functions' `orNull`): DuckDB's LEFT lateral is
    a delimiter join over the whole base, whose LIMIT read every row (37.9 s for a 100-row preview) and whose order
    kept other rows than Postgres's; the INNER one is its streaming UNNEST. But the UNNEST calls the function per ROW,
    the delimiter join per DISTINCT argument, so where every row is read anyway (a count, a GROUP BY, a DISTINCT, a
    window, a whole result, a sort by the lateral's column) DuckDB's own join stays (a count over 22 M rows: 79 s joined,
    over 200 s streamed). Bounded: a LIMIT or OFFSET over the join, passing down through a derived table, a CTE and a
    UNION ALL's arms; under an ORDER BY only a LIMIT (never WITH TIES), and only when its first key, the nulls idiom
    folded, is a table's column sorted bare (no collation keys, citext, char(n), jsonb: the top N's filter reaches the
    scan); and an order-sensitive aggregate or window (string_agg, array_agg, row_number …) with no ORDER BY of its
    own. **DuckDB streams the INNER lateral only where its list reads ONE column of the row or an array column**; two
    or more and no array is its delimiter join again (a scalar enum, domain or citext counts as a column; a user
    type's array as an array). So such an argument (any list function's), and an unnest's
    expression of any columns, is computed ONCE by a step of its own before it, `CROSS JOIN LATERAL (SELECT e AS __mason_arg<n>)
    AS __mason_arg<n>` (a projection under the UNNEST, free; the never-empty CASE names the step's column twice) —
    never where e reads an array (DuckDB plans THAT step as its join: an unnest's e is then computed once inside,
    `list_transform(list_value(e), l -> CASE … l … END)[1]`, a list copy a row, 12–23 ms a million rows), nor where
    a `*` or a join's name reads the join (`markWholeReads`: the step's column would be read). Decided in a pre-pass
    over the whole statement (the walk meets a CTE before the SELECT that reads it). Bounding too much costs time, too
    little an answer; where DuckDB itself falls back to the delimiter join, the difference is registered: under a
    filter it does not push down (`limit-lateral-filter`), an argument holding a subquery or two columns under a `*`
    (`limit-lateral-argument`). **A row count an Execute sets on the wire is a bound the Parse's plan cannot see**: the plan says where a lateral was left joined that such a bound
    would stream (`PlannedSql.unboundedLateral`, the pre-pass run again with the outermost SELECT bounded — never a
    re-parse), and the portal's first Execute with a row count runs the statement planned again with `wireBound`
    (`Session.boundOnWire`), under its Parse's settings, kept on the statement and in the plans by text; a suspended
    portal reads on from its one result, never re-runs (`tests/duck-wire.test.ts` "an Execute's row count");
  - **equivalent order keys are canonicalised: `x IS [NOT] NULL, x` is one key on `x` with its NULLS placed**
    (`nullsKeyFolded`): an expression key stops DuckDB's top N pruning the scan (6.4 s and 91 s for a 100-row page).
    Equivalent means READ alike too: a bare key that is an integer or an output column's name is the output's
    (findTargetlistEntrySQL92), the same tree inside an expression the input's (`bareKeyIsInput`);
  - **a count(DISTINCT x) of a key is count(x)** (`src/duck/distinct-key.ts`): x alone its table's PRIMARY KEY in
    the CATALOG's pg_index (the key the copy is written by; never a sources file's `key:`, and NEVER another UNIQUE
    index — the copy may hold its value twice for a moment, and the catalog's indexes are the source's as of the start
    and `mason add` / `remove` only), and the FROM repeating no row of its table (its table alone, or joined only to
    base tables each on an equality with THAT table's primary key) — all read from the analysed tree and pg_index, never a column's name;
    when unsure the DISTINCT stays (DuckDB's count(DISTINCT) is a second hash aggregate: 120 s against 9 s over 197 M
    rows). Only count; an ORDER BY repeating it drops it with its twin in the same SELECT only. `tests/duck-distinct-key.test.ts`,
    the plan fixture's `KEY_COUNTS` and the oracle's `count of distinct keys` / `keyed` hold it ("A count of distinct keys");
  - **a top N over joined tables chooses its rows by row number** (`joinRows`, src/duck/late.ts, issue 105): DuckDB's own
    late materialization stops at a join, so the join and the top N are run on each table's `rowid` and the sort keys, and
    the list is read from a LEFT JOIN of each table it reads on that `rowid`, the keys sorted again outside. Only joined
    by no join's own name, no table with a column named `rowid` in any case, and never over a whole row of a table; a `*` is
    written out from the analysis, because a copy's view of its visible columns has no `rowid`. Same rows; equal keys
    are in no defined order. **Every FROM item is a table, a plain derived read or carried** (issue 134, step 2): a
    derived table, a view or a WITH query read once and not MATERIALIZED, a projection and a WHERE over one table with
    nothing volatile (pg_proc's `provolatile`) or from outside it, exposes its row number (`__mason_rid`) and is fetched
    in its DERIVED form without its WHERE, because a NULL row number must read NULL where `1 AS one` would read 1;
    anything else derived (an aggregate, a window, DISTINCT, a LIMIT, a set operation, volatile, LATERAL, a WITH read twice
    or MATERIALIZED, a join) has its read columns carried through as `__mason_c<i>`; a function or VALUES item leaves the
    statement as it was. A query of one such FROM item over a projection and a WHERE is FOLDED into it first (`fold`: a
    wrapper, a view of a join, a WITH of a join, a view of a view), each column read as its expression, and only as a
    whole: a form it cannot write stays as it was. **`USING` and `NATURAL` stay as written inside** (issue 134, step 3): a
    merged column of the list is read through Postgres's join alias variables (left for INNER and LEFT, right for RIGHT,
    `coalesce` for FULL, the join's own cast added), never a column the fetch guesses, a NATURAL arrives as the USING of
    the columns Postgres merged (`ON true` for none: the rewrite's `naturalWritten`, in EVERY statement), and a cast `mergedRead` cannot write is carried. **A computed output
    that is a sort key is one key by name, number or repeated expression, shown from `__mason_o<i>`, one value**; a
    volatile key (`computedSorts`, pg_proc's `provolatile`) is sorted by its output's name inside, and one a collation's
    keys would repeat stays as it was. Over one table a computed output's sort stays as it was. **A role's filtered read is WALLED, never folded, flattened or
    carried** (issue 134, step 4): its row number is exposed inside the barrier (`__mason_rid` beside its `*`), and its
    rows are fetched through the same filter, LIMIT barrier and statistics wall, never the bare table, so a list
    expression meets only the rows the filter keeps and none of the table-wide statistics the wall hides; one whose
    filter holds a volatile function keeps its form, since read twice it could keep other rows, and each walled read
    fetched is one more wall `wallStatistics` is told of (`LateContext.wall`), so every one is still walled. A list of a derived read now raises on the rows
    chosen alone (`limit-errors`). A LIMIT with no ORDER BY takes the same path: sorted by the row numbers of the
    tables read ONLY where `fanOutBounded` (src/duck/distinct-key.ts) proves the join bounded, from the analysis and the
    catalog's pg_index (every join equates a whole primary key of a table, or of a plain read of one by a bare output
    column, its side holds once, so a key the first join repeats proves nothing the second time), because a parallel join's rows change order each run and an unsorted LIMIT's
    pages overlap, and the sort makes the LIMIT a full join (74 s against milliseconds at 100 billion joined rows); else
    row numbers with no sort at all, which keeps the memory win and stops early, and whose pages CAN OVERLAP, as before
    PR 118. The proof decides cost and pages, never an answer, so what it cannot show goes unsorted. OFFSET alone and
    LIMIT ALL stay as they were, and `afterLimit` still needs a sort. `tests/duck-distinct-key.test.ts` holds the proof,
    the plan fixture and `tests/duck-wire.test.ts` each side, `oracle/unordered-limit.ts` the rows. ("A top N over joined tables");
  - **a grouped top N on a whole primary key reads its table's columns after the LIMIT** (`keyFirst`, src/duck/late.ts,
    issue 134, step 6): where the analysis proves a table's WHOLE primary key grouped (`keyGrouped`, pg_index's primary
    key only), the groups are formed as written with `any_value(t.rowid)`, the HAVING, ORDER BY and LIMIT applied, and
    only then is each kept group's row of that table fetched by its row number, so no wide value goes through the hash
    aggregate. It groups by the key, never by `rowid`: a key the copy holds twice for a moment is one group. What stays
    as it was: grouping sets, a DISTINCT beside a GROUP BY, a row lock, no LIMIT, a partial key or no key, a FROM item a
    join names (an aliased JoinExpr, which `fromItems` refuses), and a `*` in the list. Only a plain table is FETCHED (a
    `RangeVar` the analysis reads as a table, `r?.kind === "table"`): a walled read, a derived item and a table with a
    column named `rowid` never are, but a statement that mixes one with a keyed plain table is still rewritten and only
    the plain table is fetched; with no such table, or no output read of one, it stays as it was. A `SELECT DISTINCT`
    whose list holds a table's whole primary key is the same grouping (`distinctGrouping`: never a DISTINCT ON, a UNION,
    nor a DISTINCT over an aggregate, a window, a set-returning function or a subquery), written as a GROUP BY of each
    output (the rewrite's key of a jsonb one, which must then be fetched), the key's other columns left out of it.
    `tests/duck-wire.test.ts`
    holds each side over `late`, `late_p` (the composite and partial keys) and `late_d`; `oracle/bi-shapes.ts` the rows
    ("Key-first grouping", docs/DESIGN.md).
  - **a DISTINCT ON with a LIMIT chooses its kept rows by row number** (`joinRows`, src/duck/late.ts, issue 134, task E):
    a DISTINCT ON keeps ONE WHOLE ROW of its FROM per group, so the inner query keeps the DISTINCT ON (its ordinals and
    output names resolved to clones of the outputs' expressions, as the sort keys are), the ORDER BY and the LIMIT, and
    lists each FROM item's row number; the list is read from the kept rows. The sort it is sent is the one Postgres
    runs: the rewrite appends each ON expression the ORDER BY lacks, ASC NULLS LAST (`distinctOnSorted`, src/duck/rewrite.ts,
    for every form sent), and keys a jsonb ON named by its output's number or name alike (`keyedDistinct`, through
    `outputOf`). A numeric computed exactly rides its cells beside a DISTINCT ON, and a plain DISTINCT with one is sent as
    the DISTINCT ON of every output's number (`exactColumns`); over a pass-through (`SELECT DISTINCT * FROM (…) s`) the
    DISTINCT ON keys an exact column by its program over the inner query's cells (`distinctThrough`). It is exact for ANY ON expressions, a key or not, so no primary key is asked and never `any_value` (which would answer an arbitrary row of the group for another
    table's columns). One table is written so too. `keyFirst` refuses it (`first.distinct` is false), so the two never
    both write one SELECT. What stays as it was: no LIMIT in fact, an aggregate, window or set-returning function, a
    GROUP BY, a volatile ON expression (`volatileOn`), a column named `rowid`, WITH TIES (`with-ties-distinct`). A test
    statement compared row for row ends its sort in a key total within the group, or lists the ON table's columns alone;
    any other is counted. `tests/duck-wire.test.ts` "task E", `oracle/bi-shapes.ts` "key-first DISTINCT ON:".
  A new such form is held to Postgres by the oracle in more than one session zone and its SQL by `tests/duck-wire.test.ts`,
  **in the shapes a BI tool sends, each of which broke a rewrite that passed its author's oracle** (2026-10-28, "The
  independent review"): the value grouped, then ORDER BY its ordinal, its output name and the qualified column; the
  nulls idiom with a bare name an output alias shadows, and with an integer constant; a prepared statement executed
  after a later `SET`; `SELECT *` beside the named columns; each collation kind (C, ICU, a libc order) where a string
  is compared, and equality apart from order (equality needs no collation); a NULL or a row-held argument where
  Postgres is strict.
- **An output's number or bare name is read through `Rewriter.outputs` alone** (issue 112): a target is one output, a `*`
  one per column from Postgres's expansion (`Typed.column`), so every rule meets a star's column as the column named. A
  `targets[n - 1]` of a number is the wrong column beside a `*` (the class: an output not resolved to its column).
  A `*` is written out from that list where DuckDB's own differs: over USING / NATURAL (Postgres lists the merged column
  first) and beside a GROUP BY. The order of a `*` is its query's `targetList` (`outputsByLocation`), never the order its
  VARs are met in the tree or their offsets: a grouped key's output is a VAR of RTE_GROUP at no offset, and its
  `groupexprs` come first, in the GROUP BY's order. A rewrite over a `*` is held by a GROUP BY whose keys are not the
  star's leading columns in order. `tests/duck-wire.test.ts`, `tests/duck-libc-order.test.ts`, the oracle's `star sort:`.
- **A new rewrite for speed is held by the PLAN fixture too** (`tests/duck-plans.test.ts`, `tests/fixtures/duck-plans.json`):
  its statement in the tool's own spelling, over the shop's million orders, its plan's skeleton in the fixture (the
  operators, a top N's count of sort keys, each scan's table and top-N / zone-map filter, the Mason functions, what it sorts by beyond a value —
  ICU's key, a stored column —, a delimiter join, a full sort; a form that reads a stored column, held both stored
  and not, over a copy of the shop whose keeper stored it), and
  where the skeleton cannot show the gain an invariant DuckDB's EXPLAIN ANALYZE measures (the row groups or rows a
  scan read). The oracle is blind to the plan: each of the three forms above was a BI tool's slow path with every
  answer right. A diff of the fixture is a plan changed: a regression is fixed, a better plan regenerated
  (`UPDATE_FIXTURE=1 npm run check`) and said so in the commit. DuckDB's EXPLAIN names a projection by its alias, so what
  an expression costs (ICU's date_trunc against the arithmetic) is read from the SQL sent: the skeleton lists the time
  functions it calls. DuckDB 2.0 plans a delimiter join as a CTE (`__duckdb_delim_<n>`) joined back to a hash group by
  of its own scan, no operator named DELIM (`delimiterJoin`). ("The plan fixture")
- **A result's names, types and typmods are Postgres's**, from the analysis, and a numeric Postgres computes exactly is
  computed by `src/lib/pg-numeric.ts`, never DuckDB's double or HUGEINT. ("How a statement is answered")
- **Whether a statement calls a Mason function is its PLAN's, never its text's** (a review finding: a `*` over a
  copy reads `__mason_visible`, which calls nothing, and a text match left every such statement uncancellable — 82 s
  past a 300 ms timeout): `PlannedSql.functions`, the `__mason_*` calls of the rewritten tree (`masonCalls`,
  src/duck/rewrite.ts), carried from the planner to the executor and listed by EXPLAIN. `tests/conventions.test.ts`
  refuses a text match in `src/`, and `tests/duck-corpus.test.ts` holds the list equal to the calls in the text.
- **A statement that calls a Mason function starves the executor worker for its whole run, and with it every other
  statement on the copy**: DuckDB's threads queue their calls faster than the worker answers, and Node's
  threadsafe-function loop runs up to a thousand calls between two turns of anything else (4.5 µs a row on the test
  server, ~9 ms a call), so a DuckDB statement of another session, a stream batch, a poll and a request-log write each
  wait about that long per round trip — in practice until the calling statement ends. The listener, the catalog, logins,
  the commands and cancels do not (`tests/duck-executor-starve.test.ts`). The way out is FEWER CALLS, two ways:
  - **a `->>` / `#>>` of a COLUMN is DuckDB's own read where that read is Postgres's answer** (`jsonGet` in
    src/duck/rewrite.ts: a string value, a missing path, a JSON null; a chain of reads off one column folded into one,
    `jsonChain`), and the function answers only the rows it must (a number's digits, an object, an array, an index, a
    document holding a key twice) — the CASE's ELSE, which DuckDB evaluates on those rows alone. Only a COPIED table's
    jsonb column (`Typed.relation`) is read without checking each object's keys are held once: a jsonb the statement
    computes (`jsonb_object_agg`, `jsonb_build_object`) is the rewrite's text and may hold a key twice, whose `->>` is
    the last (a review finding). A `#>` element is an index by ONE definition, `pathIndex` (Postgres's
    `strtoint`), which the function and the native read both ask (`tests/conventions.test.ts`). Measured, 5 M
    rows: 0.21 s native, 8.8 s through the function. A new native read is held to Postgres by `tests/duck-wire.test.ts`
    "a ->> of a column is DuckDB's own read" (every shape, against PGlite, and the hops counted:
    `DuckStore.functionCalls`) and by the oracle. A test that must EXERCISE the function (a cancel, a timeout) reads
    with `->` or a number, never a string's `->>`. **A constant path has one route however it is spelled**
    (`Rewriter.jsonPath`, `constRead`; issue 130): `'{a,b}'`, `ARRAY['a', 'b']`, either cast to `text[]`, `'a'::text`, the
    json_extract_path family, read from the analysis (`Typed.text`, `Typed.textArray`, the Const's own bytes), never
    the statement's text, so array_in's reading of a literal is Postgres's own. A path the Parse cannot see (a parameter,
    a row's element) is computed; a text[] parameter is bound as the JSON Postgres read it to (`readParameters`,
    `from_json`); a cast that changes the text (`varchar(n)[]`, `char(n)[]`, `name[]`) is refused, `json-path-type`.
    The oracle's `jsonPathCases` holds every spelling on both types;
  - **the JSON paths statements keep reading are stored as columns** (`.claude/rules/duck-stored-json.md`), which answers a number's digits and
    the rest from a plain column. ("The executor worker", "A `->>` is DuckDB's own read")
- **A jsonb is sorted, grouped and compared by ONE key, `jsonbKey` (src/duck/jsonb-order.ts), never by its text**:
  Postgres orders jsonb by its own rules (`[] < 1 < [1]`, objects by size first) and equates `1.0` with `1.00`, so
  every form that compares two jsonb — ORDER BY, GROUP BY, DISTINCT [ON], PARTITION BY, =, <, IN, BETWEEN, IS DISTINCT
  FROM, NULLIF, CASE x WHEN, count(DISTINCT) — is rewritten to compare `__mason_jsonb_key*` (`jsonbKey` in
  src/duck/rewrite.ts), and every other form refuses with `jsonb-compare`. A rule that compares values (a new
  construct, a sort) asks `comparable`, which refuses a jsonb, or keys it; the allowlist does not see a sort's or a
  group's operator, so nothing else stops DuckDB's text equality. **Equality reads the C key, an order the
  collation's**: the database's collation is deterministic (equal strings are equal bytes), so =, IN, GROUP BY,
  DISTINCT, PARTITION BY … read `equalKey`, and only ORDER BY, <, >, BETWEEN must read the collation's key of each
  string (ICU's, or the measured libc order's, which refuses a character it does not cover: equality must never
  refuse what it never had to order). Under C and ICU the order's key equates exactly and never refuses, so
  `equalKey` is it (and may be stored); under libc it is the C key, stored as a column of its own (`EQUAL_STEPS`, `.claude/rules/duck-stored-json.md`)
  or computed. A node the rewrite typed as another (`typedLike`) keeps
  that type through `clone`. `tests/duck-jsonb-order.test.ts` holds the key to
  Postgres's order under C, ICU and libc, and the oracle's `jorder` every form. ("jsonb's order")

- **A numeric the plan decides exactly is compared by its EXACT KEY, never its double** (`exactKey`, src/duck/rewrite.ts;
  PR 207's class round): a quotient or an avg the engine holds as a double equates values Postgres tells apart past 17
  digits, so DISTINCT, DISTINCT ON, GROUP BY (beside the value), PARTITION BY, count(DISTINCT), `=` and `<>` read the
  program's value without trailing zeros (`__mason_numeric_key`); a form where no key can be placed (a grouping set,
  another aggregate's DISTINCT, a set operation without ALL) is refused, `numeric-quotient-equality`; IN, IS DISTINCT
  FROM, NULLIF, CASE x WHEN and every ORDER are the listed difference `numeric-quotient-compare`. A new context that
  equates values asks `exactKey` as it asks `equalKey` for a jsonb. `tests/duck-wire.test.ts` "class round".

## What a column is

- **A column is the source's type, whatever the copy holds** (`src/duck/held-types.ts`, the only place that says what the
  copy holds, issues 126 and 129): the catalog declares `format_type`'s spelling and the wire sends its OID, so Postgres's
  analysis decides every statement; a type that is not `NATIVE` is held as its text (`c::text`, an array as `c::text[]`),
  a type added to Postgres or made by a user included, so nothing falls through to what DuckDB's reader made of it.
  The one exception is a numeric past DuckDB's DECIMAL, double on the catalog and the wire (`numeric-over-38-digits`).
  `tests/duck-held-types.test.ts` holds `HELD` to pg_type, so a Postgres type nobody decided fails it, and the oracle's
  `MAPPED` (`oracle/type-matrix.ts`) reads each column every way a tool does. A new held type gets a column there.
- **What needs the type's own value of a held column is refused by name, in one place** (`heldRefusal` in src/duck/plan.ts over
  `heldUses`, src/duck/resolved.ts: an operator but `=` / `<>` of a `textEqual` type, a function, a cast to another type, a
  subscript), and a sort in the rewrite (`held-type-compare`). It is held after the analysis because the oracle runs with
  the allowlist off: "unverified" alone would have answered `length(lseg)` as the length of its text.
- **A literal or a parameter of a held type is Postgres's text of it** (`pgEvalSync`, `readParameters`), so `'0800.2b01.0203'`
  equals the column. A money's text is the source's lc_monetary's, which no other Postgres writes, so its literal
  is refused (`literal: false`).
- **A type a database made is declared in the catalog under its name, with nothing over it** (`PgColumn.made`, `catalogDdl`):
  a tool reads its name, and what Postgres's analysis cannot find over it is the gap, never Postgres's 42883
  (`madeTypeRefusal`). All such types are one allowlist key (`made`). A domain's column is its base type (`domain-column`).
- **A value written in the session's zone is written where it is sent** (`ZONED_HELD`): a tstzrange's stored text is the zone it
  was read in; the wire and `x::text` ask Postgres's own output under the session's zone at the Execute.

## What is not supported, and how the list stays true

- **An allowlist, not a blocklist**: DuckDB answers only a statement whose every resolved piece is in
  `src/duck/verified.ts`, regenerated from what CI's oracle legs answered exactly (`node scripts/oracle-legs.ts --write
  <run-id>`; no session runs the whole oracle, CLAUDE.md "Local gates"); anything
  else is refused naming the piece (0A000, `Mason gap unverified`). **A piece is as wide as every statement that
  uses it**: one the oracle verified over its scalar forms answers the others too, so a new piece added by
  the regeneration is read in the diff for the forms it unlocks, and a form not exact is refused by name in the rewrite
  (ARRAY(SELECT …) of a numeric, an array, a row: `array-subquery-element`).
- **A libc order is read, never assumed** (`src/duck/libc-order.ts`; "A libc order, read level by level"): all four of
  glibc's levels from comparisons alone, a spelling kept only when the source says it is equal, the result held to the
  source (`holdLibcOrder`, a verdict that is a branch): an `en_*` locale is never refused, of any character, what differs
  recorded (mason status) and listed as a decided difference; another locale loses the rare characters that differ, and is
  `libc-locale-unread` where ASCII or Latin does. No ICU in it: a new case the read does not follow is a refusal by
  name, a decided difference, or a read of it. `tests/duck-libc-order.test.ts` holds the key's mechanics,
  `tests/integration/duck-libc-read.itest.ts` the order against the source, the oracle's `every value` the statements.
- **A tie under ICU is two strings, ordered by their bytes** (U+FE0F is ignorable there): every order under ICU ends in
  the bytes, `sortKeys`, `icuKey`, `textMinMax`.
- **A refusal raised at a row never quotes the row** (issue 128): it reaches any user, in a tool's error box and the
  request log, of a row a role may hide, so a `PgEvalError` or `NumericError` of 0A000 and a 0A000 of `postgresWording`
  say the gap and words alone, not the value nor one of its characters, and the engine's text stays out of their DETAIL.
  Postgres's own errors (22P02 …) quote what Postgres quotes. `tests/conventions.test.ts` holds the source,
  `tests/duck-refusal-values.test.ts` the wire under a filtered role.
- **Every refusal names its entry**: `Unrewritable` takes a `GapId` from `src/duck/gaps.ts`, so a refusal without one
  does not compile; `docs/SQL-SUPPORT.md` is rendered from the registry, and `tests/duck-gaps.test.ts` fails when it is not.
- **No dead entries**: the oracle fails when a `refused` or `differs` entry is met by none of its statements
  (`oracle/gap-cases.ts`), so an entry no longer true is removed, not left to mislead. ("What is not supported")
