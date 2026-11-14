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
  - "src/duck/libc-bound.ts"
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
  - **a GROUP BY of a numeric bin, `floor(e / c)` or `ceil(e / c)` of a constant c, or a one-to-one function of one
    (`bin * width + min`), groups by the engine's integer where the types prove it Postgres's integer** (`nativeBin`,
    `nativeKey`, issues 464, 465: keyed a row by `__mason_numeric_program_key`, Metabase's binned card was ×16–25 of
    Postgres over 12 M rows): e·10^(c's scale) floored in a DECIMAL, divided in HUGEINT, and every reader of the value
    computed per group from its program. Postgres floors the quotient ROUNDED to `select_div_scale`'s rscale, so the
    bin is the engine's only where no quotient that is not whole can round to one (2·|c|·10^S < 10^rscale, rscale at
    least 16 − 4·the quotient's largest base-10000 weight), only where e is + and − of columns of a bounded type
    (numeric(p ≤ 38, s), the integers) and constants, whose magnitude and display scale are read from the types, c is
    at most 18 places, and e·10^(c's scale) and the bin fit 38 places. A bigint by 12.5 is not (1000000000000000012 /
    12.5 floors to …01), nor a numeric of no typmod: the program's key, as before. **The bin is the KEY only**, never a
    value `duckExact` calls exact (the review of PR 922): read as the engine's DECIMAL(38, 0) beside another DECIMAL in a
    UNION, an IN, a CASE or a comparison it was cast to a type that rounds the other's decimals, and a product of it
    passed 38 places where Postgres answers. `tests/duck-wire.test.ts` "issues 464, 465", the plan fixture's BINS, the
    oracle's `bin:` statements over `bins`;
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
    chosen alone (`limit-errors`). A LIMIT with no ORDER BY takes the same path, its row numbers chosen with NO SORT,
    inside or out, a join of keys included, which keeps the memory win and stops early; its pages CAN OVERLAP, as SQL
    and Postgres allow (issue 824, the owner's decision of 2026-11-10): a sort by row number for stable pages is a top
    N over every joined row, 19.8–46.6 s for a 100-row preview of a 25 k × 153 M-row LEFT JOIN, and its exact cheaper
    form (the preserved side limited first) still reads the big table's whole join column. OFFSET alone and LIMIT ALL
    stay as they were, and `afterLimit` still needs a sort. The plan fixture and `tests/duck-wire.test.ts` hold the
    form, `oracle/unordered-limit.ts` the rows. **A sort whose every key and WHERE read the side an outer join
    preserves limits that side first** (`preservedFirst`, issue 824 part 2): its first OFFSET + LIMIT rows by the same
    keys (each yields at least one joined row, each key is its row's), then the join, sort and limit as written. Never
    through an INNER, FULL or comma join, a WHERE or key of another side or a merged column, a volatile key or WHERE, a
    DISTINCT ON, a LATERAL item or a LIMIT that is a parameter; a schema-qualified column of the item is read by its
    name inside (`shortened`). It still reads the other side's whole join column (about 20 s cold at 153 M rows): an
    index or clustering is the owner's to decide. `tests/duck-wire.test.ts` "the preserved side of an outer join …",
    the oracle's `preserved first:` and the plan fixture hold it ("A top N over joined tables");
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
    for every form sent; an appended key is bound as its ON expression is, by the one resolver over the DISTINCT
    ON's list, never through the analysis's sort list, which holds the ORDER BY as written), and keys a jsonb ON named by its output's number or name alike (`keyedDistinct`, through
    the one resolver, `keysBound`). A numeric computed exactly rides its cells beside a DISTINCT ON, and a plain DISTINCT with one is sent as
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
  Its second instance (PR 170): a key Postgres binds to an output or another clause's key by EQUALITY OF THE ANALYSED
  EXPRESSIONS (`'1.5'::numeric` to `1.5::numeric AS v`) leaves no node at its offset, so whether such a key is constant is
  read by one resolver, `keysConstant` (src/duck/constant-key.ts), from the analysis's own sort lists (`Keys`,
  src/duck/pgtree.ts), never from a syntactic match. Detector: tests/duck-wire.test.ts "a key equal to an output …".
  Its third (PR 170, the fourth round): the binding decides how a key is WRITTEN, not only whether it is constant. Every
  ORDER BY and DISTINCT ON key, by name, number or equal expression, is bound by `Rewriter.keysBound` (GROUP BY's by
  `groupOutput`), and a key bound to an output IS that output: a jsonb's, citext's or collation's key built over it,
  and a key bound by equality to a computed output written as its ordinal, never a second evaluation of a volatile
  one. Detector: tests/duck-wire.test.ts "a key bound to an output is that output …".
  Its fifth (issue 192): FETCH … WITH TIES's rank window read a number by a rule of its own, so one beside a `*` was a
  constant. Its keys are bound by `keysBound` too (a set operation's by number or name, all Postgres takes there), and a
  key bound to an output reads that output's COLUMN by its place (`withTies`: the statement is a derived table whose
  columns are named by place), never its expression again, so a window's, a set-returning function's or a volatile
  output is one value; a key no output is is computed once, as a column of its own. A set operation's key, under WITH
  TIES or a plain ORDER BY, is typed as Postgres resolved the column (`setOperationColumns` over
  `setOperationOutputs`, src/duck/pgtree.ts: `citext UNION ALL text` is text), never as its first SELECT's. A key bound
  to a ROW output is refused by `row-value` (`rowKey`), as a row written as a key is: the list writes a row as its
  text, which sorts unlike the row. Detector: tests/duck-wire.test.ts "FETCH … WITH TIES answers as Postgres does …"
  and "a set operation's ORDER BY sorts its column as Postgres resolved it …".
  PR 231's second round named three more decisions. First, **a part of the statement is found in Postgres's analysis by
  the evidence both hold, never by an offset alone** (`picked`). `TABLE t` writes its `*` at no offset, so its query is
  told by the FROM it reads and its limits' offsets, and a set operation of it by its arms where they hold offsets.
  Second, **a set operation's SELECTs are its column as Postgres resolved it** (`castArms`, before anything reads the
  arms): a char(n) arm of a text column is cast to text, so its padding is gone from the union, the ties and the text;
  an integer arm of a numeric column is exact as it is (`exactArms`). Third, **FETCH … WITH TIES reads its count and
  offset where no row is**: the bound is a materialized WITH query, and the ranked rows are UNIONed with the bound's own
  row where its count is negative (never, past its CASE), so DuckDB cannot skip the bound when the rows are none (2201W
  over `WHERE false`).
  Detector: tests/duck-wire.test.ts "a TABLE statement is found …", "a set operation's SELECTs are the column Postgres
  resolved …", "… reads its count and offset where no row is …" and "… keeps the exact numbers' cells it passes through".
  Its third round named two more. **WITH TIES ties on the statement's own ORDER BY** (`writtenKeys`, marked before any
  rule runs): Postgres's sortClause is the ORDER BY written (a DISTINCT ON's keys go to its distinctClause), so a key a
  rule adds for its own sort (`distinctOnSorted`, which a DISTINCT over an exact numeric reaches) never reaches the rank.
  **The cells a statement's exact columns read are one record** (`cellsOf`, `exactThrough`'s `derived`): the wrapper
  passes that many through, whether its list writes them or a `*` passes them (a FROM item, a WITH query, a set
  operation's arms, nested), and never counts them; a pass-through that carries no exact column selects none, and a
  UNION ALL arm's record is what `exactArms` makes it select. A UNION ALL of its own WITH, ORDER BY or limit is one arm
  of the UNION ALL around it (`ownClauses`), as `setOperationArms` reads it. Detector: tests/duck-wire.test.ts
  "… carries every cell its exact numbers have …" and "… ties on the ORDER BY Postgres sorts by …".
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
    `DuckStore.functionCalls`) and by the oracle. **A copied jsonb's `->`, a `->`/`#>` read's nullness and an `@>` of a
    constant object of scalars are DuckDB's own too** (issue 130: over 20 kB documents each vector of the function held
    every other session's statement ~200 ms, a small `SELECT` 10 s and more): `jsonValueRead` (an integer, a boolean,
    a JSON null, a string DuckDB writes alike; the rest the ELSE's), `jsonNullTest` (`json_extract(doc, path) IS
    NULL`), `nativeContains` (the AND over the template's leaves, a DOUBLE equal to the template's double the ELSE's).
    Every key path is written by ONE writer, `duckJsonPath`, from steps read by ONE reader, `stepKeys`; the template is
    read as the function reads it (`jsonbText`, `parseJson`); each document is extracted ONCE (`json_extract(doc,
    [p1, …])` through a lambda, `bound`: every json_* call parses the whole document again). Held by
    `tests/duck-wire.test.ts` "a -> and an @> of a copied jsonb are DuckDB's own read", the plan fixture's FUNCTION_ROWS
    0 and `tests/duck-executor-starve.test.ts` "wide jsonb". A test that must EXERCISE the function (a cancel, a
    timeout) reads `CALLED` (tests/duck-executor-harness.ts: an array element's `->>`, an index step, one call a row), which
    the harness holds to a call — never a string's or an integer's `->`, a `->>` of a string, or a read's nullness. **A lambda's
    parameter is the rewrite's own name** (`__mason_*`), never a table's column to src/duck/late.ts (`ownName`): a late
    page carried `__mason_v` as a column (42703, PR for issue 130). **A constant path has one route however it is spelled**
    (`Rewriter.jsonPath`, `constRead`; issue 130): `'{a,b}'`, `ARRAY['a', 'b']`, either cast to `text[]`, `'a'::text`, the
    json_extract_path family, read from the analysis (`Typed.text`, `Typed.textArray`, the Const's own bytes), never
    the statement's text, so array_in's reading of a literal is Postgres's own. **A path bound as a parameter is read as
    its value** (issues 465, 466: Metabase binds every JSON field's path, `col #>> array[?]::text[]`; a grouped field
    was ×18 of Postgres, a sync's nested fingerprint ×45–63): the Parse's plan computes it and names the parameters
    (`PlannedSql.pathParams`, `foldParam`: a text or varchar key or element, a text[] path, an int2 or int4 index, bare or
    cast to its own type with no length), and each Execute runs the statement planned again with their values as
    Postgres read them (`Session.pathsBound`, EXPLAIN too), kept by those values and each folded read guarded by them
    (`folded`: `CASE WHEN $n::varchar = '<value>' THEN <the read> ELSE <the read as at the Parse> END`, so a value it was
    not planned for is read by the function, never another path's; never DuckDB's `error()` there, which DuckDB holds
    volatile and refuses as a window's key; the guard also keeps the parameter in the SQL, which DuckDB numbers by the
    ones it meets). A folded read is never read from a stored column nor counted as a read by the policy (`keptRead`)
    until a stored path read under a late select list or a keyed GROUP BY names its column (issue 919). A NULL value,
    another type and a row's element stay computed; a text[] parameter is bound as the JSON Postgres read it to (`readParameters`, `from_json`); a cast
    that changes the text (`varchar(n)[]`, `char(n)[]`, `name[]`) is refused, `json-path-type`. The oracle's
    `jsonPathCases` holds every spelling on both types, its setting scripts every bound one, `tests/duck-wire.test.ts`
    "a json path bound as a parameter …" the hops;
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
  refuse what it never had to order). **Which collation orders is Postgres's analysis, what it means the resolver's**
  (src/duck/collation.ts, issue 253 decision B): every reader asks `collationOf` / `inputCollationOf` /
  `orderedUnder` for the node's exprCollation or inputcollid, resolved through the catalog's pg_collation row to the
  source's, never the database's for every text, a COLLATE's name read off the raw tree, or a constant on a synthetic
  node (which carries the collation of the node it stands for); `tests/conventions.test.ts` "collation resolver".
  A collation of no determinate kind where text is ordered is Postgres's 42P22; a nondeterministic one anywhere, or an
  ICU keyword where text is ordered, is refused by name (`collation-unknown`); a libc one other than the database's is
  keyed by its own collcollate (`__mason_libc_key(s, collate)`), its order read from the source on its first use. Under C and ICU the order's key equates exactly and never refuses, so
  `equalKey` is it (and may be stored); under libc it is the C key, stored as a column of its own (`EQUAL_STEPS`, `.claude/rules/duck-stored-json.md`)
  or computed. A node the rewrite typed as another (`typedLike`) keeps
  that type through `clone`. `tests/duck-jsonb-order.test.ts` holds the key to
  Postgres's order under C, ICU and libc, and the oracle's `jorder` every form. ("jsonb's order")

- **A numeric the plan decides exactly is compared by its EXACT KEY, never its double** (`exactKey`, src/duck/rewrite.ts;
  PR 207's class round): a quotient or an avg the engine holds as a double equates values Postgres tells apart past 17
  digits, so DISTINCT, DISTINCT ON, GROUP BY, PARTITION BY, count(DISTINCT), `=` and `<>` read the
  program's value without trailing zeros (`__mason_numeric_key`). **A GROUP BY groups by the key ALONE, computed in ONE
  call a row** (`__mason_numeric_program_key`, issue 665: beside the value, the double, the program and the key were
  three calls a row, 3x the time): the expression is recorded `cells` (`grouping`), and decidedByKey marks its columns
  (`readPerGroup`) so the walk reads each through any_value once every rule above it has read the expression as
  Postgres's analysis typed its shape — the list's double, a cast, its text, HAVING, the ORDER BY's exact order key,
  WITH TIES and a carried program's cells are each computed per GROUP, never inside any_value per row
  (`tests/duck-plans.test.ts` "issue 665", FUNCTION_ROWS); a form where no key can be placed (a grouping set,
  another aggregate's DISTINCT, a set operation without ALL, a JOIN … USING or NATURAL JOIN on a subquery's quotient,
  `refuseMergedExact`) is refused, `numeric-quotient-equality`; IN a list keys every item (issue 358); = ANY, IS
  DISTINCT FROM, NULLIF, CASE x WHEN, < and > are the listed difference `numeric-quotient-compare`. A new context that
  equates values asks `exactKey` as it asks `equalKey` for a jsonb. `tests/duck-wire.test.ts` "class round".
  **Every other READER asks the same two (issue 252, `exact-numeric-leaves-exact-path`)**: an ORDER BY, a window's
  ORDER BY, FETCH … WITH TIES and min / max sort by `exactOrderKey` (`__mason_numeric_order`, numeric_cmp's order); a
  sum, avg or window sum adds the program's text (`summed`); a cast to text, varchar, float8 or an integer reads the
  program's text (`typeCast`); a `*` beside a program is written out (`starsWrittenForExact`) so its cells ride. Each
  asks `duckExact` first, so a DECIMAL column, an integer or a sum of one keeps its native plan with no `__mason_*`
  call. The hidden cells are named by `cellPrefix`, which no name the statement writes begins with.
  `tests/duck-wire.test.ts` "exact path: …". Round 2 (issue 358) adds: a set operation's ORDER BY, LIMIT and WITH TIES
  key each output by its record (`recordOrderKey`, `setOperationExactKeys`); a VALUES or nested arm is typed by
  Postgres's analysis and wrapped to the one cell count (`exactArms`, `armWrapped`); a numeric column whose arms write
  several scales is each arm's own (`armScales`, `scalesDiffer`, read outside the union through `carry`); a scalar
  subquery is ONE text cell, its program's text built inside it (`subqueryText`); a window's min / max pick by
  `arg_min` / `arg_max` over the window and first_value, last_value, nth_value, lag and lead pick each cell (lag /
  lead's default by the row's existence); array_agg of a quotient is refused, `array-subquery-element`, never a
  float8[]; a grouped query's ORDER BY of an output is keyed by its analysed expression (`sortBy`).
  `tests/duck-wire.test.ts` "exact path round 2: …"; oracle shapes `numeric-set-ordered`, `numeric-scalar`.
  **"Decided exactly" is a property of the value's PROGRAM, never of its syntax or its type** (PR 207's third round):
  a column of a subquery or WITH query that holds one is that query's program over its cells, which ride as hidden
  columns of the FROM item (`carry`, decided once per item before the walk, `carryAll`), so it is printed and keyed
  outside it however it is read; a cast of one to numeric(p, s), its text (`exactNumericText`), a scalar subquery of
  one and a parameter (its bound text) are keyed alike; `duckExact` is true only where every numeric an expression is
  computed from is DuckDB's exact value. Each UNION ALL arm carries its own program (`exactArms`, `pick`). Where the
  cells cannot ride (the item read by a `*` beside other columns, a NATURAL JOIN, its whole row) an equality refuses
  by name and a print is the listed `nested-exact-numeric`; a row holding one is refused, `row-value`.
  `tests/duck-wire.test.ts` "third round".
  **A numeric PARAMETER compared with a value the engine holds exactly is never its double** (issue 214, the class
  `numeric-parameter-as-double`; `numericParamComparison`): `=`, `<>`, `<` … `>=`, IS [NOT] DISTINCT FROM, NULLIF, IN,
  [NOT] BETWEEN and CASE x WHEN of a `duckExact` value and plain parameters are `CASE WHEN __mason_numeric_fits(typeof(x),
  $n::text) THEN <the comparison, its parameters bare> ELSE <every operand by its exact key> END`. The guard reads the
  ENGINE's type (`typeof`, never Postgres's typmod: a numeric(65,30) is DECIMAL(38, the scale its values use)) and the
  bound text, through the copy's own rule of what a DECIMAL holds (src/lib/pg-numeric.ts `numericWiderThan`,
  `fitsEngineType`): both constants, so DuckDB folds it once at Execute and a value the type holds is the scan's own
  filter (DuckDB casts a bare parameter into x's type, which ROUNDS past its scale and fails past its digits: never
  unguarded). A value past the scale or the digits, NaN, ±Infinity, a cast with a typmod on the parameter (Postgres
  rounds it first) and more than one exact operand are keyed (`__mason_numeric_key` to equate, `__mason_numeric_order`
  to order). `tests/duck-wire.test.ts` "issue 214", the plan fixture's bound parameters, the oracle's "numeric parameter"
  setting scripts.
- **Whether a numeric is exact is ONE decision, `duckExact`, by how the value is WRITTEN for the engine** (PR 207's fourth
  round, a class round: a literal past 38 digits called exact where `decimalConst` writes a double; a variance's cells
  called inexact where the rewrite's own hugeint casts hold them; a program skipped over a double): a constant and a
  cast to numeric are decided by the writer's own decision (`engineReadsExactly`, `numericCastWrite`, which `typeCast`
  follows), the rest by what DuckDB computes from exact operands. Every place that asks — a program's cells
  (`programOf`, the one builder of a program), whether a program is the engine's own answer (`exactColumns`, min /
  max), a FROM item's column (`carry`), a key (`exactKey`), a union arm's value, a function's argument (`pgNumeric`) —
  asks it, never a property of its own (a declared scale, a column's kind). Unknown is not exact. A WITH query a FROM
  name reads is resolved by one resolver (`cteOf`), and a carry is decided from the cells its item EXPOSES, as written
  (`exposedCells`). `tests/duck-wire.test.ts` "fourth round". A FROM item's column is decided ONCE per (query body,
  output index) — `outputExact`, `approximateAt`, `scalesDiffer`, one record (`decided`) copied by `clone` as `derived`
  is — never recorded from inside an open recursive cycle (`over`'s provisional answer) or from `carry`'s walk-time
  guard, and dropped when a `*` is written out in place; issue 244 (#483), detector tests/duck-plan-time.test.ts and
  `tests/duck-wire.test.ts` "issue 244". **A carried column's PROGRAM is SHARED by its references, never copied** (#484):
  every reference to one (FROM item, column) within one program's build is the same node (`carried`, memoised by the
  build's `cell`), a program is an immutable value (`NumericProgram`'s fields are read-only, so the compiler refuses a
  write to a shared node), and every consumer is linear in its DISTINCT nodes, through src/lib/pg-numeric.ts, the one
  authority: the one text a program leaves the planner in (`programJson`, a node table that is also its structural
  identity, so arms are compared as trees), `parseProgram`, `cellsOf`, `mapCells` (sharing kept), evaluation (each node
  once a row, a CASE's untaken arm and a COALESCE's later argument never), and a stored numeric
  (src/duck/generated-plan.ts `storedProgram`: each node judged once, a shared one written once as a layer's column).
  Never `JSON.stringify` a program, nor recurse over one without a memo: a DAG's tree is k^depth. Detector:
  tests/duck-plan-time.test.ts (`numericShapes` at depth 32 within the bound, the record linear), `tests/duck-wire.test.ts`
  "issue 484", tests/pg-numeric.test.ts "a shared program", tests/duck-generated-round11-13-14.test.ts "round 14, a numeric".

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
- **Every type OID Mason sends is the CATALOG's, a type a database made included: one OID space, never a map** (issue
  861, the owner's decision; docs/DESIGN.md "One OID for a type the source made"): the RowDescription, the
  ParameterDescription and any OID a statement answers are the analysis's, so a client's pg_type lookup of one
  (JDBC's getColumnTypeName) names its type and a Parse naming it binds. Never the source's OID, which the catalog may
  hold as another type (both count from 16384), and nothing in the catalog's system tables is rewritten to make the two
  agree (a `pg_node_tree` and the opclass cache keep the old number). `pg_typeof` of one is the catalog's regtype under
  the session's search_path (`typeNames`, src/duck/plan.ts). The oracle holds a made type's OID by what each server's
  pg_type names it (tests/integration/oracle/made-types.ts). Detector: tests/duck-type-oids.test.ts (the collision forced).
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
- **A libc key is computed for a top N's and a min / max's candidates alone** (`src/duck/libc-bound.ts`, issue 666: the
  JavaScript key on every row was 10-15 s over 5 M rows, past the timeout at 93 M). Each value's two NATIVE bounds
  (`regexp_extract`, `lower`, `regexp_replace`) are written from the `LibcOrder` read for that collcollate, never a
  table by hand: an order whose printable ASCII's folded bytes do not order its weights has none. Their marks (the
  text's end, below and above every weight) are written after the weights and never read from the value: whether it
  ended in the run is decided from the value itself, since a value may hold any control character (PR 675). The proof obligation,
  hi(a) < lo(b) implies libcKey(a) < libcKey(b) at the first level, lo <= hi, equal strings equal bounds, is held over the
  ENGINE's expressions by `holdBounds` (tests/libc-order-fixture.ts): the hand order's `l·`, U+212A, U+0130 and marks in
  `libc bound:`, the source's order in the read test's `bound`. The threshold's subquery clones the SELECT's one FROM
  item and WHERE, so it holds only where they read the same rows twice: nothing volatile, no window or set-returning
  list, no aggregate but the min / max's own, no LIMIT, DISTINCT ON or sample inside but a role's barrier; a cloned
  walled read is counted as a wall. **The bounds and the key are computed once a DISTINCT value, never a row** (`Values`,
  the second round of issue 666: three native passes of the bounds over 4.5 M rows took 6 s, and a status 98 % one value
  left those rows candidates, 19 s of keys): the SELECT's distinct values of x are a MATERIALIZED WITH query of its own,
  a min / max is `any_value` of the least key of the values its bounds keep, and a top N is LEFT JOINed to the keys of
  the values its bounds keep (the n-th distinct value's hi), sorted by the joined key, its `*` written as its item's.
  A SELECT inside a subquery expression or a LATERAL item, which may read the query around it, keeps the row-by-row
  threshold (`correlatable`). **A letter of Latin weighed as a mapped character is folded into the run** (`folds`: É by
  `strip_accents`, Ø and ł by a `replace`, a mark of no first-level weight dropped), each read from the order and
  `strip_accents` held to `stripped` over every character of `FOLD_BLOCKS`; a head of ASCII alone is read unfolded,
  since folding every value doubled a unique wide column's time. Anything else is sent as written (a join, GROUP BY, DISTINCT, WITH TIES, a set
  operation, a window, FILTER). Detector: `libc top N:` (tests/duck-wire.test.ts) and the `text under libc:` plan
  entries and rows test (tests/duck-plans.test.ts), the oracle's `text top N:` and `text min/max:`.
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

## What review probes

Run each probe that applies: the implementer before each push, and the fresh reviewer at each review (CLAUDE.md
"How work is done here"). A new probe is proposed to the owner; each bullet names the PR or issue it was met in.

- A constant as a key in ORDER BY, DISTINCT ON, WITH TIES and a window, by name, by number and as itself (`1 AS one`,
  `1.5::numeric`, `'1.5'::numeric`, `2147483648::int`, `'abc'::text::int`, every key a constant): a literal the engine
  reads as an ordinal or refuses (42804), or a cast Postgres raises at planning dropped (PR 170, 197).
- A key equal to an output but spelled otherwise (`'1.5'::numeric` beside `1.5::numeric AS v`, `0 + l.c` beside `l.c +
  0`), named by a bare output name, or by number beside a `*`: an output resolved by syntax, not by Postgres's analysed
  equality (PR 170, 207).
- A type-dependent key (jsonb, citext, a collated text) as a DISTINCT ON or sort key by bare output name, by number and
  as the expression: a rule applied to one spelling only (PR 170, 207).
- A volatile output as a key (`random() AS r … ORDER BY random()`, `ORDER BY r`, `ORDER BY 1`), also under WITH TIES:
  evaluated twice (PR 170).
- `SELECT * … GROUP BY name, id` (keys not the star's leading columns in order), `b.*, count(*)`, a `*` beside a
  computed output ordered by number: outputs taken in the tree's order, not the target list's (PR 120, 170).
- Each shape above inside a scalar subquery, `ARRAY(…)`, `EXISTS` or `IN` in the SELECT list: the inner query resolved
  against the outer (PR 120).
- A citext, collated or jsonb column ordered by number through `UNION ALL … ORDER BY 2`: sorted as bytes (PR 120).
- A numeric quotient or text-read numeric (`o.amount / 3`, `l.k / 7.0`, `t::numeric`) under DISTINCT, DISTINCT ON, GROUP
  BY, UNION ALL, USING, `::text`, a row value, `= $1`, `= (SELECT …)`, through a derived table or CTE: approximate
  printed or compared as exact (PR 197, 207; issues 212, 218).
- A numeric past the engine's 38 digits (`x * x` over `numeric(30,20)`, `power(x, 400)`): the engine's error or its
  double (PR 207; issues 214, 217).
- A form the change fixes under a LIMIT, tried with no LIMIT, no ORDER BY and a list that reads no table (`SELECT
  count(*) FROM late_c l NATURAL JOIN late_p lc`): fixed in one path only (PR 155).
- A LIMIT over a join (late.ts) with a CTE read only by a list subquery, a LATERAL plain read, `schema.table.column`,
  the keyed table on a LEFT or FULL join's nullable side, OFFSET past the end, LIMIT 0, a DISTINCT ON whose ON list the
  ORDER BY lacks: a scope moved, or a sort narrower than Postgres's (PR 146, 163, 164, 207).
- No ORDER BY, a deep `OFFSET 2000000`, a small table LEFT JOINed to a 50 M-row one: a sort over the whole join where
  the old plan stopped early (PR 118, 146; issue 824: no sort by row number at all).
- A coercion Postgres adds that the raw tree lacks (`tm = '12:30-04'::timetz`, a UNION of time and timetz, `CASE …
  tm::timetz ELSE tm END`), and every spelling of one cast (`timetz(tm)`, `tm::timetz`, `ARRAY[tm]::timetz[]`): the
  analysed node unread; one input through two paths (PR 166; issue 167).
- A type's edge values (`'24:00'::time`, NaN, ±Infinity, a bigint sum past 2^53 under `floor`/`ceil`, `1e400`): a value
  rolled over, or a double's digits (PR 166, 202; issue 203).
- An engine error a statement can meet (`ORDER BY x USING <`, a scalar subquery returning two rows, a CASE mixing time
  and timetz, `l.k::numeric(2,0)` overflowing from a column, `'NaN'::float8::numeric(5,0)`): an error in the engine's
  words or the wrong SQLSTATE (PR 164, 166, 170; issues 165, 204, 208).
- A set operation under a clause written for a plain SELECT (`… UNION ALL … ORDER BY 1 FETCH FIRST 3 ROWS WITH
  TIES`), a collated output under ROLLUP ordered by itself: a crash, or the engine's GROUP BY error (PR 170; issue
  211).
- A libc collation: en_US over symbols (`㊿`, `€`, `½`), private use and NFD marks (`E'ä6ß'`), a non-glibc en_US,
  the source's glibc upgraded; tr_TR and sv_SE over ASCII pairs: en_US refused, or another locale differing unsaid
  (PR 135).
- The PR's diff against its own base, read for deletions it did not mean (`git diff --stat <base>...HEAD`, then each
  `-` under `src/`, `tests/`, `.claude/rules/` and `release-notes/`), and a statement a merged PR just fixed, run at the
  base and the head (over `t(id int primary key, a int, b text, c numeric(10,2), d char(4))`: `SELECT * FROM t UNION ALL
  TABLE t ORDER BY 2 FETCH FIRST 2 ROWS WITH TIES`, `SELECT b FROM t UNION ALL SELECT d FROM t ORDER BY 1`, `SELECT
  DISTINCT a FROM t ORDER BY a FETCH FIRST 2 ROWS WITH TIES`): a commit built from a stale tree, overwriting files
  whole and undoing a merged PR's code, tests, rules bullets and release notes; `branch-reverts-merged-work` (PR 272).
- A change to `src/duck/verified.ts` or `tests/fixtures/oracle-duckdb-alone.json` (a hand edit, or `node
  scripts/oracle-legs.ts --write <run-id>`), then `node --test --test-timeout=120000 --test-force-exit
  tests/duck-gaps.test.ts`: README.md's block and docs/SQL-SUPPORT.md left as the old registry rendered them, so `checks`
  is red; a source rewritten without `UPDATE_FIXTURE=1 npm run check` and its diff read;
  `generated-fixture-not-regenerated` (PR 333).
- An exact numeric key (a quotient over `numeric(30,20)`, `x / 1`, `c / 3`) in a GROUPED query, under each rule that
  builds one: ORDER BY, FETCH FIRST … WITH TIES, min / max, DISTINCT ON (`SELECT x / 1 AS q, count(*) FROM bigdec GROUP
  BY 1 ORDER BY 2 DESC, 1 FETCH FIRST 1 ROWS WITH TIES`, also by `GROUP BY x / 1`, `GROUP BY q`, with HAVING, a rank()
  OVER beside it, two keys, an empty table): the key built without its query's groups, reading the ungrouped column
  (42803 where Postgres answers); `exact-key-built-outside-its-group` (PR 341).
- A set operation whose one arm reads a numeric's text (`(c / 3)::text`, `avg(c)::text`, `c::text`) beside an arm of
  arbitrary text (`SELECT b FROM t`, the char(4) `d`, a literal `'abc'`), over `t(id int primary key, a int, b text, c
  numeric(10,2), d char(4))`: `SELECT (c / 3)::text FROM t UNION ALL SELECT b FROM t ORDER BY 1`, the arms swapped, no
  ORDER BY, through a derived table: a cell of conv "text" (by contract a NUMERIC's text) given to an arm's plain text and
  parsed as numeric, 22P02 where the base answered; `text-cell-parsed-as-numeric` (PR 415).
- A VALUES arm beside a column recorded as a numeric's text (`SELECT (c / 3)::text FROM t UNION ALL VALUES
  (NULL::text) ORDER BY 1`, `VALUES (NULL)`, `VALUES ((1.5 / 7)::text)`, either arm first, with a quotient column beside
  it: `SELECT (c / 3)::text, c / 7 FROM t UNION ALL VALUES (NULL::text, 1.5) ORDER BY 2, 1`, through `SELECT * FROM (…)
  s`): the wrapper's column count and the VALUES rows' appended items derived in two places that disagree, 42804 "has 1
  columns available but 2 columns specified"; `texts-column-beside-values-arm-width` (PR 415).
- A collation that is not the database's, in every reader: a column's own (`b text COLLATE "C"` on an ICU or en_US
  database) through `*`, by number and in a join's top N; a `COLLATE` on the RIGHT of `<`, BETWEEN's upper bound, one
  argument of GREATEST, inside min(); a derived table's or a view's `COLLATE` read through `s.n`, `1`, `n` and a
  grouped one; two libc collations in one statement; a set operation of a C and an ICU column ordered by number (42P22):
  a sort or comparison under the database's collation, or a byte order where the COLLATE said otherwise;
  `collation-read-twice` (issue 253, decision B).
- A row comparison whose one side is a char(n) column and whose other is an unknown literal Postgres coerced to bpchar
  (over `t(id int, b text, d char(4))`, a row with `d = 'b   '`: `SELECT id FROM t WHERE (d, id) < ('b', 3) ORDER BY
  id`, `(d, id) <= ('b', 1)`, `(b::char(2), id) < ('b', 3)`, `(b, d) <= ('b', 'b')`, a char(6) column under
  `COLLATE "und-x-icu"`), beside the literal cast (`('b'::char(4), 3)`): the two sides of one column keyed in different
  shapes (trimmed bpchar on one, plain text on the other) because the shape was read from each raw node's own type, not
  from the analysed ROWCOMPAREEXPR's coerced argument types, so equal values never compare equal;
  `row-key-shape-from-raw-type` (PR 413).
- An ordered-set aggregate with an array of fractions over every text type its key handles (`SELECT
  percentile_disc(ARRAY[0.25, 0.75]) WITHIN GROUP (ORDER BY d) FROM t` with `d char(4)`, the same under `COLLATE
  "und-x-icu"`, over an empty table, grouped by another column), beside the text form: whether the answer is an array
  decided from a list of element types (`TEXT_ARRAY`, `VARCHAR_ARRAY`) instead of from Postgres's analysis of the call
  (the float8[] overload, an array result type), so bpchar[] (1014) is read as one scalar and the engine's error
  escapes; `percentile-array-recognised-by-element-type-list` (PR 413).
- A change that newly answers a piece (an operator such as `^(numeric,numeric)`, a function by OID) or registers a gap,
  run on the wire with the allowlist in force (`tests/duck-wire.test.ts`, not `scripts/duck-repro.ts`, which has none):
  over `t(id int primary key, a int, b text, c numeric(10,2), d char(4))`, `SELECT id, (c ^ 2)::float8, exp(c)::float8,
  sqrt(c)::float8 FROM t WHERE c > 0 ORDER BY 1`, and `node --test --test-timeout=120000 --test-force-exit
  tests/oracle-legs.test.ts`; then compare `src/duck/verified.ts` and `tests/fixtures/oracle-duckdb-alone.json` with what
  the push's own `integration (oracle)` leg printed: the allowlist and fixture left from an older run, so the wire refuses
  the PR's own shape (0A000 "which Mason has not verified") and a new gap no fixture statement meets fails
  oracle-legs.test.ts; `allowlist-not-regenerated-from-push-ci` (PR 519).
- A refusal added for a value an aggregate or call cannot answer exactly, read by each reader that never reads the value:
  over the same `t`, `SELECT a FROM t GROUP BY a HAVING percentile_disc(0.5) WITHIN GROUP (ORDER BY c / 3) IS NOT NULL
  ORDER BY a NULLS FIRST`, `SELECT a, mode() WITHIN GROUP (ORDER BY c / 3) IS NULL FROM t GROUP BY a ORDER BY 1`, inside
  CASE, NOT, count(), EXISTS and a derived table read as `s.p IS NULL`, each run at the base and the head: the refusal
  placed at the call instead of where the value's bytes are read, so a nullness-only read the base answered is now
  refused; `refusal-at-the-call-not-the-reader` (PR 519).
- A refusal placed where an aggregate or value is BUILT (an ordered-set aggregate over an exact quotient, a numeric
  key), each reader of that value run at the head and the base over `t (a int, c numeric(10,2), d char(4))` with
  NULLs and ties: the value only ORDERED BY (`SELECT d FROM t GROUP BY d ORDER BY percentile_disc(0.5) WITHIN GROUP
  (ORDER BY c / 1.6), d`), under FETCH FIRST … WITH TIES, in DISTINCT ON, tested for NULL (`… HAVING
  percentile_disc(0.5) WITHIN GROUP (ORDER BY c / 3) IS NOT NULL`), compared with a value of its own kind, grouped,
  partitioned or joined on: a refusal keyed on the value's presence or its place in the statement refuses every
  reader, including those the base answered right (a statement the base answered and the head refuses blocks). The
  decision: refuse only where the value's bytes are read as a value, or answer it, decided by ONE reader, never a
  list of places; `refusal-wider-than-the-wrong-answer` (PR 506).
- A new entry in `src/duck/gaps.ts` (or a statement added under `tests/integration/oracle/`): run `node --test
  --test-timeout=300000 --test-force-exit tests/oracle-legs.test.ts` and name, for each new entry, the statement in
  `oracle/gap-cases.ts` that meets it; then check `tests/fixtures/oracle-duckdb-alone.json` and `src/duck/verified.ts`
  came from the push's CI legs (`node scripts/oracle-legs.ts --write <run-id>`, then `UPDATE_FIXTURE=1` over
  `tests/duck-gaps.test.ts`): a gap with no oracle statement meeting it, or a fixture not regenerated, keeps
  `integration (oracle)` red on every push; `gap-added-without-its-oracle-fixture` (PR 506).
- A NULLIF over an exact numeric program read OUTSIDE its subquery or CTE, over `t (id int primary key, a int, b text,
  c numeric(10,2), d char(4))` with a row `c = 0.00`, each run at the head and the base: `SELECT x FROM (SELECT
  nullif(c / 1.6, 0) AS x FROM t) s GROUP BY x ORDER BY 1`, `nullif(c / 1.6, 2.5)`, nested `nullif(nullif(c / 1.6, 0),
  2.5)`, `nullif(c / 1.6, 0) * 2`, under an outer GROUP BY, `HAVING x IS NULL`, `WHERE x IS NULL`, `WITH q AS (SELECT
  id, nullif(c / 1.6, 0) AS x FROM t) SELECT coalesce(x, -1) FROM q GROUP BY x`, a JOIN, a second CTE, `x::text`,
  `x::float8`: the NULL a pick carries as an index past its last arm is honoured by the inner reader and not by the one
  that regroups it, so the NULL group prints the first operand's exact value (`0.00000000000000000000`,
  `2.5000000000000000`) where Postgres prints NULL, and `coalesce(x, -1)` the operand, not -1. The decision: one
  representation of a program's NULL that every reader of a carried program honours;
  `nullif-pick-null-lost-outside-subquery` (PR 506).
- A refusal of a value "held as a double", run at the head and the base over the same `t` (and an empty one): `SELECT
  (percentile_disc(0.5) WITHIN GROUP (ORDER BY c))::int FROM t` of a plain numeric(10,2) column, `::int8`, `::int2`,
  `(mode() WITHIN GROUP (ORDER BY c))::int8`, `SELECT max(c ^ 2)::int, min(c ^ 2)::int FROM t`, `max(x)::int` of
  `sqrt(abs(c))` through a derived table, `WITH q AS (SELECT c ^ 2 AS x FROM t) SELECT sum(x)::int, max(x)::int, x::int
  FROM q GROUP BY x ORDER BY 3`: the refusal decided by a syntactic list of forms known exact (`WRITTEN_EXACT`,
  `VALUE_KEEPING`) instead of the type the engine holds (the prepared statement's DECIMAL, DOUBLE or BLOB), so
  0A000 `numeric-double-integer` refuses at the head what the base answered with Postgres's integer. The decision:
  refuse only where the engine's own type IS a double; `double-refusal-gated-by-exactness-allowlist` (PR 506).
- A refusal moved from the rewrite to the run (a function testing `typeof(arg)` per row), its argument wrapped, at the
  head and the base over the same `t`: `SELECT (percentile_disc(0.5) WITHIN GROUP (ORDER BY c / 1.6) * 2)::int FROM
  t`, `(… + 0)::int`, `round(…)::int`, `abs(…)::int`, `coalesce(percentile_disc(0.5) WITHIN GROUP (ORDER BY c / 1.6),
  0)::int`, `nullif(…, 0)::int`, `SELECT (x * 2)::int FROM (SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY c / 1.6)
  AS x FROM t) s`, the same with mode(), FROM an empty table, GROUP BY d, in a UNION ALL arm, under `greatest(…, 0)`:
  the engine evaluates the wrapper over the held bytes before the check is reached, so the reader gets 42883
  `*(BLOB, INTEGER_LITERAL)`, 42804 or 22P02 in the engine's words, no gap and no HINT, where the base refused by name
  (`numeric-double-integer`). The decision: raise a refusal at the earliest module that knows its fact (the rewrite,
  from the engine's type), the run's check only for what the rewrite cannot type;
  `runtime-refusal-preempted-by-engine-error` (PR 506).
- An ordered-set aggregate whose WITHIN GROUP expression is an exact order key, at the head and the base over the same
  `t`: `SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY c ^ 2) FROM t`, `ORDER BY exp(ln(2.5)) * sign(c)`, `SELECT
  (percentile_disc(0.5) WITHIN GROUP (ORDER BY c / 1.6))::text FROM t`, `::text::numeric`, `SELECT d, mode() WITHIN
  GROUP (ORDER BY nullif(c / 1.6, 0)) FROM t GROUP BY d ORDER BY 1`, `SELECT (percentile_disc(ARRAY[0.5]) WITHIN GROUP
  (ORDER BY c / 1.6))[1] FROM t`, each through derived tables: the expression is both the sort key and the result, so
  ordering by the key answers the key's bytes, a bytea (OID 17) or its digits as text (`3050000075625`), where Postgres
  answers the picked row's numeric (OID 1700, `16.000000000000000`, `0.75625000000000000000`). The decision: order by
  the exact key, answer the picked row's value, never the key, while the readers that only order or test nullness stay
  answered (`refusal-wider-than-the-wrong-answer` above); `order-key-bytes-as-result` (PR 506; issues 486, 538).
- A value holding the very byte a bound, key or run uses to mark its own end, at the head and the base over a synthetic
  `t (id int PRIMARY KEY, a int, b text)` under a libc collation, with rows `'abc'`, `'ab' || chr(2) || 'cd'`,
  `chr(2) || 'zz'`, `'a' || chr(2) || 'z'` beside `'aa'`, `'aaz'`, `'b'`, `'zzz'`: `SELECT id, b FROM t ORDER BY b, id
  LIMIT 2`, `ORDER BY b DESC, id LIMIT 5`, `ORDER BY b DESC NULLS LAST`, `ORDER BY b || 'x'`, an alias, a CTE, `b IN
  (SELECT b … ORDER BY b DESC LIMIT 5)`, `SELECT min(b), max(b) FROM t`, a correlated `(SELECT min(b) …)`; and the same
  with chr(1) and chr(127): a control character glibc ignores at the first levels is read as the end-of-text mark, so
  the row sorts by its prefix alone, is dropped from a DESC top N, or swaps min and max, silently. The decision: no
  in-band sentinel; the end of a value is known from the value itself (the run's length against the text's, or an
  anchored pattern), and the property test's strings are drawn from a pool holding every byte the bounds use;
  `sentinel-byte-the-data-can-hold` (PR 675).
- GROUPING() of an expression the engine groups by a key in its place (an exact quotient), in every clause that can
  hold one, at the head and the base over `t (id int primary key, a int, b text, c numeric(10,2), d char(4))` with
  NULLs, duplicates and ties: `SELECT c / 3 AS q, grouping(c / 3), count(*) FROM t GROUP BY 1 ORDER BY 1`, by `GROUP BY
  c / 3`, two arguments `grouping(c / 3, a)`, in HAVING (`HAVING grouping(c / 3) = 0`), in ORDER BY, in DISTINCT ON
  (`SELECT DISTINCT ON (grouping(c / 3)) c / 3 AS q FROM t GROUP BY 1 ORDER BY grouping(c / 3), 1`), in a named WINDOW
  (`WINDOW w AS (ORDER BY grouping(c / 3), c / 3)`), the same over `ceil(c / 7.0)` and a jsonb keyed column: the
  argument written as the expression's value, which is no engine group column, or rewritten in a list of clauses that
  misses one, 42804 "GROUPING child … must be a grouping column". The decision: every GroupingFunc of the SELECT, found
  by walking its whole body (not a list of clauses), reads its arguments' engine GROUP BY entries from the one record
  keyedGroups placed; `grouping-of-keyed-expression-reads-value` (PR 674).
- A SubLink's test expression over a grouped expression, at the head and the base over the same `t`: `SELECT c / 3 AS
  q, count(*) FROM t GROUP BY 1 HAVING c / 3 IN (SELECT c / 5 FROM t) ORDER BY 1`, `= ANY (…)`, `NOT IN (…)`, `(c / 3)
  > ALL (…)`, in the list (`c / 3 IN (SELECT c / 5 FROM t) AS listed`), in the ORDER BY, correlated (`… HAVING c / 3 IN
  (SELECT e.c / 3 FROM e WHERE e.a = t.a)`): the test expression walked at the subselect's depth, so its column of this
  query is left unmarked and sent bare, 42803 where Postgres answers. The decision: a SubLink's test expression belongs
  to the query holding the SubLink and is walked at that query's depth, only the subselect one deeper;
  `sublink-testexpr-walked-at-inner-depth` (PR 674).
- A char(n) compared through a SubLink (IN, = ANY, < ALL, a row IN) with a subselect of every form, at the head and the
  base over the same `t` with `d` 'ab' in some rows, 'cd' and NULL in others, ungrouped and under `GROUP BY id`: `SELECT
  id, d IN (SELECT 'ab') AS m FROM t ORDER BY 1`, `(b, d) IN (SELECT 'x', 'ab')`, `d = ANY (SELECT 'ab')`, `d IN (VALUES
  ('ab'::char(4)))`, `d IN (SELECT s.* FROM (SELECT d FROM t WHERE id = 1) s)`, `(id, a, b, c, d) IN (TABLE t)`, `d IN
  (SELECT d … UNION / UNION ALL / INTERSECT / EXCEPT SELECT d …)`, `d IN (SELECT d … UNION SELECT 'zz')`, `d < ALL
  (SELECT d … UNION SELECT d …)`: the char(n) side trimmed (or kept padded) on one operand only, because the subselect's
  side is written only when its plain target list is reachable, so equal values never compare equal, a silent wrong
  answer. The decision: the two operands are compared under the one type Postgres's analysis of the SubLink's operator
  resolved, written together or not at all, the subselect's side over its output columns whatever its form;
  `char-padding-in-sublink-test` (PR 674).
