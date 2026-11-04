/**
 * THE COLLATION RESOLVER'S STATEMENTS (issue 253, decision B; issues 121, 122, 125, 150, 213): which collation orders a
 * text is Postgres's analysis, what it means src/duck/collation.ts's. Over `colls`, whose columns carry a collation
 * each (the database's, C, ICU's root, glibc's en_US, a C varchar, an ICU char(n)), and values C, ICU (a space and a
 * '-' count) and glibc's en_US (both ignored at the first level) order three ways; a view of a collated column, a
 * collation with an ICU keyword (`mason_num`, refused) and a nondeterministic one (`mason_ci`, refused). Every name
 * begins "collation: ", so `IT_ORACLE_ONLY='^collation: '` asks them alone; CI asks them under an ICU and a C database
 * too (`IT_ORACLE_COLLATION`, .github/workflows/ci.yml `collation`), where en_US is a libc collation other than the
 * database's, read from the source on its first use.
 */

const VALUES: Array<[number, string | null]> = [[1, ""], [2, " alpha"], [3, "10"], [4, "Beta"], [5, "alpha"], [6, "b"], [7, "A"], [8, "a"], [9, "é"], [10, "e"], [11, "-x"], [12, "w"], [13, null]];
const lit = (v: string | null): string => v === null ? "NULL" : `'${v.replace(/'/g, "''")}'`;

export const COLLS_SCHEMA =
  "CREATE TABLE public.colls (id int PRIMARY KEY, d text, c text COLLATE \"C\", i text COLLATE \"und-x-icu\", l text COLLATE \"en_US\", v varchar(12) COLLATE \"C\", b char(6) COLLATE \"und-x-icu\"); " +
  `INSERT INTO public.colls SELECT id, x, x, x, x, x, x FROM (VALUES ${VALUES.map(([id, v]) => `(${id}, ${lit(v)})`).join(", ")}) AS s(id, x); ` +
  "CREATE VIEW public.colls_v AS SELECT id, i, d COLLATE \"und-x-icu\" AS n FROM public.colls; " +
  "CREATE COLLATION public.mason_num (provider = icu, locale = 'und-u-kn'); " +
  "CREATE COLLATION public.mason_ci (provider = icu, locale = 'und-u-ks-level2', deterministic = false); " +
  collsCaseSchema();

/**
 * CASE MAPPING (issue 406): `colls_case`, whose columns hold the same value under the database's collation, C, ICU's
 * root, glibc's en_US, ICU's Turkish and an ICU char(n), each value one whose case maps otherwise under one of them
 * (`ß`, `İ` and `ı`, the digraphs `ǅ`, an apostrophe in a word, a final sigma, the ligatures, a word's full stop and
 * underscore)
 */
function collsCaseSchema(): string {
  const values: Array<[number, string | null]> = [[1, "straße"], [2, "İstanbul"], [3, "ıi Iİ"], [4, "ǅemal ǆ Ǆ"], [5, "o'hara"], [6, "o'neil mcDONALD-smith"],
    [7, "ΟΔΟΣ σοφός"], [8, "ﬁne ŉ"], [9, "hello.world a_b x2y 1st"], [10, "élan ÉCOLE"], [11, null], [12, ""], [13, "ǉubljana"], [14, "'quoted' (paren) -dash"]];
  return "CREATE TABLE public.colls_case (id int PRIMARY KEY, d text, c text COLLATE \"C\", i text COLLATE \"und-x-icu\", l text COLLATE \"en_US\", t text COLLATE \"tr-x-icu\", b char(24) COLLATE \"und-x-icu\"); " +
    `INSERT INTO public.colls_case SELECT id, x, x, x, x, x, x FROM (VALUES ${values.map(([id, v]) => `(${id}, ${lit(v)})`).join(", ")}) AS s(id, x);`;
}

/** a round of changes the poll (and the stream) carries: a value moved, one added, one gone */
export function collsMutations(round: number): string {
  return round === 1
    ? "UPDATE public.colls SET d = 'Alpha', c = 'Alpha', i = 'Alpha', l = 'Alpha', v = 'Alpha', b = 'Alpha' WHERE id = 5; " +
      "INSERT INTO public.colls VALUES (14, '_y', '_y', '_y', '_y', '_y', '_y'), (15, 'ä', 'ä', 'ä', 'ä', 'ä', 'ä'); " +
      "UPDATE public.colls_case SET d = 'ßtraße', c = 'ßtraße', i = 'ßtraße', l = 'ßtraße', t = 'ßtraße', b = 'ßtraße' WHERE id = 1; " +
      "INSERT INTO public.colls_case VALUES (15, 'ǈ ǋ ǲ', 'ǈ ǋ ǲ', 'ǈ ǋ ǲ', 'ǈ ǋ ǲ', 'ǈ ǋ ǲ', 'ǈ ǋ ǲ');"
    : "DELETE FROM public.colls WHERE id = 14; UPDATE public.colls SET d = NULL, c = NULL, i = NULL, l = NULL, v = NULL, b = NULL WHERE id = 12; " +
      "INSERT INTO public.colls VALUES (16, 'B', 'B', 'B', 'B', 'B', 'B'); " +
      "DELETE FROM public.colls_case WHERE id = 14; UPDATE public.colls_case SET d = NULL, c = NULL, i = NULL, l = NULL, t = NULL, b = NULL WHERE id = 4;";
}

/** issue 406's statements: upper, lower and initcap under each column's collation, a COLLATE's, a derived table's,
 *  and of no table, in the forms .claude/rules/duck-rewrite.md asks of a rewrite */
const CASE_CASES: Array<{ name: string; sql: string }> = [
  { name: "the BI shape initcap", sql: "SELECT c.id, initcap(c.name) AS n FROM customers c ORDER BY c.id" },
  ...["d", "c", "i", "l", "t", "b"].map((col) => ({ name: `the ${col} column`, sql: `SELECT id, upper(${col}), lower(${col}), initcap(${col}) FROM colls_case ORDER BY id` })),
  { name: "lengths", sql: "SELECT id, length(lower(i)), octet_length(lower(i)), length(lower(l)), octet_length(upper(i)), length(upper(c)) FROM colls_case ORDER BY id" },
  { name: "upper under a COLLATE", sql: "SELECT id, upper(d COLLATE \"C\"), upper(d COLLATE \"und-x-icu\"), upper(d COLLATE \"en_US\"), upper(d COLLATE \"tr-x-icu\") FROM colls_case ORDER BY id" },
  { name: "lower under a COLLATE", sql: "SELECT id, lower(d COLLATE \"C\"), lower(d COLLATE \"und-x-icu\"), lower(d COLLATE \"en_US\"), lower(d COLLATE \"tr-x-icu\") FROM colls_case ORDER BY id" },
  { name: "initcap under a COLLATE", sql: "SELECT id, initcap(d COLLATE \"C\"), initcap(d COLLATE \"und-x-icu\"), initcap(d COLLATE \"en_US\"), initcap(d COLLATE \"tr-x-icu\") FROM colls_case ORDER BY id" },
  { name: "a COLLATE over a column's own", sql: "SELECT id, upper(i COLLATE \"C\"), initcap(l COLLATE \"und-x-icu\"), initcap(c COLLATE \"en_US\"), lower(t COLLATE \"und-x-icu\") FROM colls_case ORDER BY id" },
  { name: "a COLLATE on the result", sql: "SELECT id, upper(d) COLLATE \"C\", upper(d COLLATE \"C\"), initcap(i) COLLATE \"C\" FROM colls_case ORDER BY id" },
  { name: "a concatenation", sql: "SELECT id, upper(i || 'ß'), initcap(l || ' o''hara'), lower(c || 'İ') FROM colls_case ORDER BY id" },
  { name: "two implicit collations (42P22)", sql: "SELECT id, upper(CASE WHEN id > 3 THEN i ELSE l END) FROM colls_case ORDER BY id" },
  { name: "an implicit ICU beside the default", sql: "SELECT id, upper(CASE WHEN id > 3 THEN i ELSE d END) FROM colls_case ORDER BY id" },
  { name: "compared", sql: "SELECT id FROM colls_case WHERE lower(i) = lower('İSTANBUL') ORDER BY id" },
  { name: "LIKE", sql: "SELECT id FROM colls_case WHERE upper(l) LIKE 'STRA%' OR upper(i) LIKE 'STRA%' ORDER BY id" },
  { name: "grouped, ordered by number", sql: "SELECT upper(i) AS u, count(*) FROM colls_case GROUP BY 1 ORDER BY 1" },
  { name: "grouped, ordered by name", sql: "SELECT upper(i) AS u, count(*) FROM colls_case GROUP BY 1 ORDER BY u" },
  { name: "grouped, ordered by expression", sql: "SELECT upper(i), count(*) FROM colls_case GROUP BY upper(i) ORDER BY upper(i)" },
  { name: "grouped by the qualified column", sql: "SELECT upper(colls_case.c), count(*) FROM colls_case GROUP BY upper(colls_case.c) ORDER BY upper(colls_case.c)" },
  { name: "ordered by initcap", sql: "SELECT id, initcap(i) FROM colls_case ORDER BY initcap(i), id" },
  { name: "the nulls idiom with a bare output name", sql: "SELECT id, upper(i) AS u FROM colls_case ORDER BY u IS NULL, u, id" },
  { name: "DISTINCT ON", sql: "SELECT DISTINCT ON (lower(i)) lower(i), id FROM colls_case ORDER BY lower(i), id" },
  { name: "aggregated", sql: "SELECT string_agg(initcap(i), '|' ORDER BY id), string_agg(upper(l), '|' ORDER BY id), max(upper(c)) FROM colls_case" },
  { name: "a window", sql: "SELECT id, first_value(initcap(i)) OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) FROM colls_case ORDER BY id" },
  { name: "a star beside the named column", sql: "SELECT *, initcap(i) FROM colls_case ORDER BY id" },
  { name: "a derived table's COLLATE", sql: "SELECT upper(n), initcap(n) FROM (SELECT id, d COLLATE \"und-x-icu\" AS n FROM colls_case) s ORDER BY id" },
  { name: "a CTE's COLLATE", sql: "WITH s AS (SELECT id, d COLLATE \"C\" AS n FROM colls_case) SELECT id, upper(n), initcap(n) FROM s ORDER BY id" },
  { name: "a derived table not folded", sql: "SELECT id, initcap(i) FROM (SELECT id, i FROM colls_case OFFSET 0) s ORDER BY id" },
  { name: "a derived UNION ALL", sql: "SELECT upper(n) FROM (SELECT i AS n, id FROM colls_case UNION ALL SELECT i, id + 100 FROM colls_case) s ORDER BY id" },
  { name: "a view's COLLATE", sql: "SELECT id, upper(n), initcap(n), lower(i) FROM colls_v ORDER BY id" },
  { name: "a UNION ALL of two mappings (42P22)", sql: "SELECT upper(i) FROM colls_case UNION ALL SELECT upper(l) FROM colls_case ORDER BY 1" },
  { name: "a scalar subquery and ARRAY(…)", sql: "SELECT (SELECT upper(i) FROM colls_case WHERE id = 1), ARRAY(SELECT initcap(i) FROM colls_case ORDER BY id LIMIT 6)" },
  { name: "a join", sql: "SELECT a.id, upper(a.i), initcap(b.l) FROM colls_case a JOIN colls_case b ON b.id = a.id ORDER BY a.id LIMIT 4" },
  { name: "a join's top N by the mapped column", sql: "SELECT a.id, upper(a.i) AS u FROM colls_case a JOIN colls_case b ON b.id = a.id ORDER BY u, a.id LIMIT 4" },
  { name: "a NULL", sql: "SELECT upper(NULL::text COLLATE \"und-x-icu\"), initcap(NULL::text), lower(i) FROM colls_case WHERE id = 11" },
  { name: "a char(n) and a varchar", sql: "SELECT id, upper(b), initcap(b), length(upper(b)), upper(l::varchar(30)), initcap(i::char(30)) FROM colls_case ORDER BY id" },
  // no table: the synced data's, never the catalog's own mapping
  { name: "no table, the issue's statement", sql: "SELECT initcap('o''neil mcDONALD-smith'), upper('ß'), lower('İ')" },
  { name: "no table, ICU", sql: "SELECT upper('ß' COLLATE \"und-x-icu\"), lower('İ' COLLATE \"und-x-icu\"), initcap('o''hara' COLLATE \"und-x-icu\"), initcap('ǆemal ßtraße' COLLATE \"und-x-icu\")" },
  { name: "no table, C and en_US", sql: "SELECT upper('é' COLLATE \"C\"), lower('É' COLLATE \"C\"), initcap('élan x2y' COLLATE \"C\"), upper('ß' COLLATE \"en_US\")" },
  { name: "no table, Turkish", sql: "SELECT upper('i' COLLATE \"tr-x-icu\"), lower('I' COLLATE \"tr-x-icu\"), initcap('istanbul' COLLATE \"tr-x-icu\")" },
  { name: "no table, a dotted I and a final sigma", sql: "SELECT length(lower('İ')), octet_length(lower('İ' COLLATE \"und-x-icu\")), lower('ΟΔΟΣ'), lower('ΟΔΟΣ' COLLATE \"und-x-icu\"), upper('ﬁ'), upper('ﬁ' COLLATE \"und-x-icu\")" },
  { name: "no table, VALUES", sql: "SELECT initcap(x), upper(x), lower(x) FROM (VALUES ('ǆemal'), ('o''hara'), ('ΟΔΟΣ'), ('ß'), (NULL)) AS v(x)" },
  { name: "no table, the builtin collations", sql: "SELECT upper('ß' COLLATE pg_unicode_fast), upper('ß' COLLATE pg_c_utf8), initcap('ǆa ßb' COLLATE pg_c_utf8), initcap('ǆa ßb' COLLATE pg_unicode_fast), upper('é' COLLATE ucs_basic)" },
  { name: "no table, ASCII", sql: "SELECT upper('abc'), lower('ABC'), initcap('abc def')" },
  // no table, what the synced data does not run as written: the catalog's, never the engine's error (review r1 of PR 568)
  // (no initcap of a word with an apostrophe: the catalog's own mapping makes O'Hara where ICU's makes O'hara, the listed
  // fromless-numeric-text-order; ASCII words whose case every mapping agrees on)
  { name: "no table, a pg_catalog-qualified name", sql: "SELECT pg_catalog.lower('ABC'), pg_catalog.upper('abc'), pg_catalog.length('abc'), pg_catalog.initcap('abc def')" },
  // a value of the server, which the synced data would answer with its own: the catalog's (review r2 of PR 568)
  { name: "no table, a value of the server", sql: "SELECT upper(version()) LIKE 'POSTGRES%', upper(substr(version(), 1, 10)), upper(split_part(version(), ' ', 1)), upper(format_type(23, NULL)), (SELECT count(*) FROM (SELECT upper(version()) AS v) s WHERE v LIKE 'POSTGRES%')" },
  { name: "no table, a typed literal", sql: "SELECT upper(char 'abc'), upper(character 'abc'), initcap(char 'abc'), upper(n'abc'), upper('abc'::unknown)" },
  { name: "no table, a char VALUES list", sql: "SELECT upper(x) FROM (VALUES (char 'abc')) v(x)" },
  { name: "no table, an empty select list", sql: "SELECT upper('abc') FROM (SELECT) s" },
  { name: "no table, no case function stays the catalog's", sql: "SELECT 'a' = 'A', version() IS NOT NULL" },
].map((q) => ({ name: `collation: case ${q.name}`, sql: q.sql }));

const DERIVED = "(SELECT d COLLATE \"und-x-icu\" AS n FROM colls)";

export const COLLATION_CASES: Array<{ name: string; sql: string }> = [
  // #121 a column's own collation, through a star, by number and by name
  ...["c", "i", "l", "d"].map((col) => ({ name: `collation: a star sorted by its ${col}`, sql: `SELECT * FROM colls ORDER BY ${col}, id` })),
  { name: "collation: a star sorted by number", sql: "SELECT * FROM colls ORDER BY 3, 1" },
  { name: "collation: a star sorted by number, DESC NULLS LAST, LIMIT", sql: "SELECT * FROM colls ORDER BY 4 DESC NULLS LAST, 1 LIMIT 5" },
  { name: "collation: an ICU column DESC LIMIT", sql: "SELECT id, i FROM colls ORDER BY i DESC, id LIMIT 4" },
  { name: "collation: an ICU char(n)", sql: "SELECT id, b FROM colls ORDER BY b, id" },
  { name: "collation: a C varchar NULLS FIRST", sql: "SELECT v FROM colls ORDER BY v NULLS FIRST" },
  // #121 an explicit COLLATE over the column's own
  { name: "collation: COLLATE ICU over a C column", sql: "SELECT id FROM colls ORDER BY c COLLATE \"und-x-icu\", id" },
  { name: "collation: COLLATE C over an ICU column", sql: "SELECT id FROM colls ORDER BY i COLLATE \"C\", id" },
  { name: "collation: COLLATE default over an en_US column", sql: "SELECT id FROM colls ORDER BY l COLLATE \"default\", id" },
  // #121 compared under the column's own
  { name: "collation: an ICU column compared", sql: "SELECT id FROM colls WHERE i > 'b' ORDER BY id" },
  { name: "collation: an en_US column compared", sql: "SELECT id FROM colls WHERE l < 'B' ORDER BY id" },
  { name: "collation: a C column BETWEEN", sql: "SELECT id FROM colls WHERE c BETWEEN 'A' AND 'a' ORDER BY id" },
  { name: "collation: an ICU char(n) compared", sql: "SELECT id FROM colls WHERE b > 'alpha' ORDER BY id" },
  // #121 min, max, GREATEST, LEAST, a window's max
  { name: "collation: min and max of each column", sql: "SELECT min(c), max(c), min(i), max(i), min(l), max(l), min(d), max(d) FROM colls" },
  // issue 666: a column's own en_US under an ICU or C database, its top N and min / max keyed for their candidates alone
  // (src/duck/libc-bound.ts), and a COLLATE of it
  { name: "collation: a top N of an en_US column", sql: "SELECT id, l FROM colls ORDER BY l, id LIMIT 3" },
  { name: "collation: a top N under COLLATE en_US, descending", sql: "SELECT id FROM colls ORDER BY d COLLATE \"en_US\" DESC, id LIMIT 3" },
  { name: "collation: min and max of an en_US column", sql: "SELECT min(l), max(l) FROM colls" },
  // (and equal char(n) values of another padding under byte order: the first argument; #253 B, CI fix 2, char-n-minmax
  // retired. One statement, so the legs' fixture counts stay those of the run they were written from)
  { name: "collation: GREATEST and LEAST of an ICU char(n)", sql: "SELECT id, greatest(b, 'b'), least(b, 'B'), greatest(b COLLATE \"C\", 'b'), least(b COLLATE \"C\", d), least(d::char(4) COLLATE \"C\", d::char(8)) FROM colls ORDER BY id" },
  { name: "collation: GREATEST and LEAST of collated columns", sql: "SELECT id, greatest(i, 'b'), least(l, 'B'), greatest(c, 'B') FROM colls ORDER BY id" },
  { name: "collation: a window's max of an ICU column", sql: "SELECT id, max(i) OVER (ORDER BY id) FROM colls ORDER BY id" },
  // #121 an aggregate's ORDER BY, WITHIN GROUP
  { name: "collation: string_agg and array_agg ordered", sql: "SELECT string_agg(i, ',' ORDER BY i), array_agg(l ORDER BY l DESC) FROM colls" },
  { name: "collation: percentile_disc and mode of collated columns", sql: "SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY i), percentile_disc(0.5) WITHIN GROUP (ORDER BY l), mode() WITHIN GROUP (ORDER BY i) FROM colls" },
  // #121 grouped, DISTINCT ON, a window
  { name: "collation: grouped, ordered by number", sql: "SELECT i, count(*) FROM colls GROUP BY i ORDER BY 1" },
  { name: "collation: grouped, ordered by name", sql: "SELECT i, count(*) FROM colls GROUP BY i ORDER BY i" },
  { name: "collation: grouped, ordered by the qualified column", sql: "SELECT i, count(*) FROM colls GROUP BY i ORDER BY colls.i" },
  { name: "collation: DISTINCT ON an ICU column", sql: "SELECT DISTINCT ON (i) i, id FROM colls ORDER BY i, id" },
  { name: "collation: row_number over an en_US column", sql: "SELECT id, row_number() OVER (ORDER BY l, id) FROM colls ORDER BY id" },
  { name: "collation: rank partitioned by C, ordered by ICU", sql: "SELECT id, rank() OVER (PARTITION BY c ORDER BY i) FROM colls ORDER BY id" },
  // #121 a LIMIT over a join (late.ts carries the column)
  { name: "collation: a join's top N by an ICU column", sql: "SELECT a.i, b.id FROM colls a JOIN colls b ON b.id = a.id ORDER BY a.i, b.id LIMIT 4" },
  { name: "collation: a LEFT join's top N by an en_US column", sql: "SELECT a.l, a.id FROM colls a LEFT JOIN colls b ON b.id = a.id + 1 ORDER BY a.l NULLS FIRST, a.id LIMIT 5" },
  { name: "collation: a USING join's top N by a C column", sql: "SELECT a.c FROM colls a JOIN colls b USING (id) ORDER BY a.c DESC LIMIT 3" },
  // #121 the catalog holds the column's collation
  { name: "collation: information_schema.columns' collation_name", sql: "SELECT column_name, collation_name FROM information_schema.columns WHERE table_name = 'colls' ORDER BY ordinal_position" },
  { name: "collation: pg_attribute's attcollation", sql: "SELECT a.attname, co.collname FROM pg_attribute a JOIN pg_collation co ON co.oid = a.attcollation WHERE a.attrelid = 'public.colls'::regclass AND a.attnum > 0 ORDER BY a.attnum" },
  // #121 a set operation's column collation (Postgres's combination rules)
  { name: "collation: UNION ALL of an ICU column", sql: "SELECT i FROM colls UNION ALL SELECT i FROM colls ORDER BY 1" },
  { name: "collation: UNION of C and default (C wins)", sql: "SELECT c FROM colls UNION SELECT d FROM colls ORDER BY 1" },
  { name: "collation: UNION ALL of C and ICU (Postgres's error)", sql: "SELECT c FROM colls UNION ALL SELECT i FROM colls ORDER BY 1" },
  // #150 a COLLATE on the right, the left and both
  { name: "collation: COLLATE on the right", sql: "SELECT id FROM colls WHERE d > 'b' COLLATE \"und-x-icu\" ORDER BY id" },
  { name: "collation: COLLATE on the left", sql: "SELECT id FROM colls WHERE d COLLATE \"und-x-icu\" > 'b' ORDER BY id" },
  { name: "collation: COLLATE on both", sql: "SELECT id FROM colls WHERE d COLLATE \"und-x-icu\" > 'b' COLLATE \"und-x-icu\" ORDER BY id" },
  { name: "collation: COLLATE C on the right", sql: "SELECT id FROM colls WHERE d > 'b' COLLATE \"C\" ORDER BY id" },
  { name: "collation: COLLATE en_US on the right", sql: "SELECT id FROM colls WHERE d < '-x' COLLATE \"en_US\" ORDER BY id" },
  { name: "collation: COLLATE ICU on the right of a C column", sql: "SELECT id FROM colls WHERE c > 'b' COLLATE \"und-x-icu\" ORDER BY id" },
  { name: "collation: COLLATE C on the right of an ICU column", sql: "SELECT id FROM colls WHERE i <= 'B' COLLATE \"C\" ORDER BY id" },
  { name: "collation: BETWEEN with a COLLATE on the upper bound", sql: "SELECT id FROM colls WHERE d BETWEEN 'A' AND 'b' COLLATE \"und-x-icu\" ORDER BY id" },
  { name: "collation: NOT BETWEEN with a COLLATE on the lower bound", sql: "SELECT id FROM colls WHERE d NOT BETWEEN (' a' COLLATE \"C\") AND 'z' ORDER BY id" },
  { name: "collation: a COLLATE on the right in CASE", sql: "SELECT id, CASE WHEN d > 'b' COLLATE \"und-x-icu\" THEN 1 ELSE 0 END FROM colls ORDER BY id" },
  { name: "collation: a COLLATE on the left in CASE", sql: "SELECT id, CASE WHEN 'b' COLLATE \"C\" < d THEN 1 ELSE 0 END FROM colls ORDER BY id" },
  { name: "collation: a comparison under a COLLATE as a sort key", sql: "SELECT id FROM colls ORDER BY d < 'b' COLLATE \"und-x-icu\", id" },
  { name: "collation: GREATEST and LEAST with a COLLATE on one argument", sql: "SELECT id, greatest(d, 'b' COLLATE \"und-x-icu\"), least(d COLLATE \"C\", 'B') FROM colls ORDER BY id" },
  { name: "collation: min and max under a COLLATE", sql: "SELECT min(d COLLATE \"und-x-icu\"), max(d COLLATE \"C\") FROM colls" },
  // #150 conflicts: Postgres's errors from the analysis
  { name: "collation: two explicit COLLATEs (42P21)", sql: "SELECT id FROM colls WHERE c COLLATE \"C\" > i COLLATE \"und-x-icu\"" },
  { name: "collation: two implicit collations (42P22)", sql: "SELECT id FROM colls WHERE c > i" },
  { name: "collation: two explicit COLLATEs of no table (42P21)", sql: "SELECT 'a' COLLATE \"C\" < 'B' COLLATE \"und-x-icu\"" },
  // #150 equality apart from order: no collation key
  { name: "collation: equality under a COLLATE", sql: "SELECT id FROM colls WHERE d = 'b' COLLATE \"und-x-icu\" ORDER BY id" },
  { name: "collation: IN under a COLLATE", sql: "SELECT id FROM colls WHERE d IN ('b' COLLATE \"und-x-icu\", 'A') ORDER BY id" },
  { name: "collation: grouped by ICU, ordered under C", sql: "SELECT i, count(*) FROM colls GROUP BY i ORDER BY i COLLATE \"C\"" },
  { name: "collation: DISTINCT en_US, ordered under C", sql: "SELECT DISTINCT l FROM colls ORDER BY l COLLATE \"C\" NULLS FIRST" },
  // #213 a derived table's collated column
  { name: "collation: the issue's statement", sql: "SELECT * FROM (SELECT a.d COLLATE \"und-x-icu\" AS n FROM colls a ORDER BY 1 LIMIT 8) s ORDER BY s.n" },
  { name: "collation: a derived grouped column by qualified name", sql: "SELECT * FROM (SELECT d COLLATE \"und-x-icu\" AS n, count(*) AS k FROM colls GROUP BY 1) s ORDER BY s.n" },
  { name: "collation: a derived grouped column by number", sql: "SELECT * FROM (SELECT d COLLATE \"und-x-icu\" AS n, count(*) AS k FROM colls GROUP BY 1) s ORDER BY 1" },
  { name: "collation: a derived grouped column by name", sql: "SELECT * FROM (SELECT d COLLATE \"und-x-icu\" AS n, count(*) AS k FROM colls GROUP BY 1) s ORDER BY n" },
  { name: "collation: a derived grouped top N", sql: "SELECT * FROM (SELECT d COLLATE \"und-x-icu\" AS n, count(*) AS k FROM colls GROUP BY 1 ORDER BY 1 LIMIT 8) s ORDER BY n, k" },
  { name: "collation: a derived C column through s.*", sql: "SELECT s.* FROM (SELECT c FROM colls) s ORDER BY s.c" },
  { name: "collation: a derived ICU column through *", sql: "SELECT * FROM (SELECT i FROM colls) s ORDER BY i" },
  { name: "collation: a derived ICU column not folded", sql: "SELECT s.i FROM (SELECT i FROM colls OFFSET 0) s ORDER BY 1" },
  { name: "collation: a derived COLLATE through s.*", sql: "SELECT s.* FROM (SELECT id, d COLLATE \"und-x-icu\" AS n FROM colls) s ORDER BY s.n, s.id" },
  { name: "collation: a CTE's COLLATE", sql: "WITH s AS (SELECT d COLLATE \"und-x-icu\" AS n, id FROM colls) SELECT n FROM s ORDER BY n, id" },
  { name: "collation: a MATERIALIZED CTE's COLLATE C", sql: "WITH s AS MATERIALIZED (SELECT d COLLATE \"C\" AS n FROM colls) SELECT n FROM s ORDER BY n" },
  { name: "collation: a view's COLLATE", sql: "SELECT * FROM colls_v ORDER BY n, id" },
  { name: "collation: a view's ICU column", sql: "SELECT * FROM colls_v ORDER BY i, id" },
  { name: "collation: a derived UNION ALL's column", sql: "SELECT n FROM (SELECT i AS n FROM colls UNION ALL SELECT i FROM colls) s ORDER BY n" },
  { name: "collation: a UNION ALL of COLLATEs by number", sql: "SELECT d COLLATE \"und-x-icu\" AS n FROM colls UNION ALL SELECT d COLLATE \"und-x-icu\" FROM colls ORDER BY 1" },
  { name: "collation: a LATERAL's COLLATE", sql: "SELECT a.id, x.n FROM colls a, LATERAL (SELECT a.d COLLATE \"und-x-icu\" AS n) x ORDER BY x.n, a.id" },
  { name: "collation: a derived COLLATE compared", sql: `SELECT n FROM ${DERIVED} s WHERE n < 'b' ORDER BY n` },
  { name: "collation: a derived COLLATE's max and min", sql: `SELECT max(n), min(n) FROM ${DERIVED} s` },
  { name: "collation: a derived COLLATE grouped", sql: `SELECT n, count(*) FROM ${DERIVED} s GROUP BY n ORDER BY n` },
  { name: "collation: a derived COLLATE as DISTINCT ON's key", sql: "SELECT DISTINCT ON (n) n, id FROM (SELECT id, d COLLATE \"und-x-icu\" AS n FROM colls) s ORDER BY n, id" },
  { name: "collation: a subquery's ICU min compared", sql: "SELECT id FROM colls WHERE d > (SELECT min(i) FROM colls) ORDER BY id" },
  { name: "collation: a subquery's en_US max compared", sql: "SELECT id, (SELECT max(l) FROM colls) > d FROM colls ORDER BY id" },
  // #122 no table: compared, under a COLLATE, sorted, aggregated and nested
  { name: "collation: no table, compared", sql: "SELECT 'a' < 'B', 'a' > 'B', 'B' <= 'a', 'b' BETWEEN 'A' AND 'c'" },
  { name: "collation: no table, a space and a dash compared", sql: "SELECT ' alpha' < '10', '-x' < 'w'" },
  { name: "collation: no table, under a COLLATE", sql: "SELECT 'a' COLLATE \"C\" < 'B', 'a' < 'B' COLLATE \"und-x-icu\", 'a' < 'B' COLLATE \"en_US\"" },
  { name: "collation: no table, VALUES sorted", sql: "SELECT * FROM (VALUES ('b'), ('A'), (' a'), ('10'), ('é'), ('e'), (NULL)) AS v ORDER BY 1" },
  { name: "collation: no table, VALUES DESC LIMIT", sql: "SELECT * FROM (VALUES ('b'), ('A'), (' a'), ('10')) AS v(x) ORDER BY x DESC NULLS LAST LIMIT 2" },
  { name: "collation: no table, grouped", sql: "SELECT x FROM (VALUES ('b'), ('A'), ('b')) AS v(x) GROUP BY x ORDER BY 1" },
  { name: "collation: no table, DISTINCT", sql: "SELECT DISTINCT x FROM (VALUES ('b'), ('A'), ('a')) AS v(x) ORDER BY x" },
  { name: "collation: no table, UNION ALL", sql: "SELECT x FROM (VALUES ('b')) AS v(x) UNION ALL SELECT 'A' ORDER BY 1" },
  { name: "collation: no table, UNION", sql: "SELECT 'b' UNION SELECT 'A' ORDER BY 1" },
  { name: "collation: no table, min and max", sql: "SELECT min(x), max(x) FROM (VALUES ('b'), ('A'), (' a')) AS v(x)" },
  { name: "collation: no table, GREATEST and LEAST", sql: "SELECT greatest('a', 'B'), least(' a', '10')" },
  { name: "collation: no table, string_agg ordered", sql: "SELECT string_agg(x, ',' ORDER BY x) FROM (VALUES ('b'), ('A'), ('10')) AS v(x)" },
  { name: "collation: no table, a window's ORDER BY", sql: "SELECT x, row_number() OVER (ORDER BY x) FROM (VALUES ('b'), ('A')) AS v(x) ORDER BY 2" },
  { name: "collation: no table, ARRAY of a sorted subquery", sql: "SELECT ARRAY(SELECT x FROM (VALUES ('b'), ('A')) AS v(x) ORDER BY x)" },
  { name: "collation: no table, a scalar subquery's max", sql: "SELECT (SELECT max(x) FROM (VALUES ('b'), ('A')) AS v(x))" },
  // a statement of no table that names a nondeterministic collation, though nothing in it orders: refused by name,
  // never the catalog's copy of the collation (#253 B, review r1)
  { name: "collation: no table, equal under a nondeterministic collation", sql: "SELECT 'a' = 'A' COLLATE mason_ci" },
  { name: "collation: no table, grouped under a nondeterministic collation", sql: "SELECT count(*) FROM (VALUES ('a'), ('A')) AS v(x) GROUP BY x COLLATE mason_ci" },
  // a statement of no table that computes a numeric: the catalog's exact digits, its text order the catalog's
  { name: "collation: no table, a numeric quotient's text sorted", sql: "SELECT length((v.x / 1)::text), (v.x / 1)::text || '' FROM (VALUES (1.00000000000000000001::numeric(30,20)), (2.5)) AS v(x) ORDER BY 1, 2" },
  { name: "collation: no table, percentile_disc", sql: "SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY x) FROM (VALUES ('b'), ('A'), (' a')) AS v(x)" },
  // #122 stays the catalog's
  { name: "collation: no table, equality stays the catalog's", sql: "SELECT 'a' = 'A'" },
  { name: "collation: no table, under C stays the catalog's", sql: "SELECT 'a' COLLATE \"C\" < 'B'" },
  { name: "collation: a catalog table stays the catalog's", sql: "SELECT relname FROM pg_class WHERE relname = 'colls'" },
  // #125 under ICU and libc
  { name: "collation: percentile_disc of the database's collation", sql: "SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY d) FROM colls" },
  { name: "collation: percentile_disc of an array of fractions", sql: "SELECT percentile_disc(ARRAY[0.25, 0.75]) WITHIN GROUP (ORDER BY d) FROM colls" },
  // the array form is the overload Postgres chose, whatever text type the key is: a char(n) answers a bpchar[] (#253 B, review r2)
  // (a char(n) under byte order, as d::char(4) is on a C database, loses its padding at main too: issue 420)
  { name: "collation: percentile_disc of an array of fractions over a char(n)", sql: "SELECT percentile_disc(ARRAY[0.25, 0.75]) WITHIN GROUP (ORDER BY b), percentile_disc(ARRAY[0.5]) WITHIN GROUP (ORDER BY d::char(4) COLLATE \"und-x-icu\") FROM colls" },
  { name: "collation: percentile_disc of an array of fractions over a char(n), grouped", sql: "SELECT id % 3, percentile_disc(ARRAY[0.5]) WITHIN GROUP (ORDER BY b) FROM colls GROUP BY 1 ORDER BY 1" },
  { name: "collation: percentile_disc of an array of fractions over a char(n), no row", sql: "SELECT percentile_disc(ARRAY[0.5]) WITHIN GROUP (ORDER BY b) FROM colls WHERE false" },
  { name: "collation: mode() of the database's collation", sql: "SELECT mode() WITHIN GROUP (ORDER BY d) FROM colls" },
  { name: "collation: GREATEST and LEAST of the database's collation", sql: "SELECT id, greatest(d, 'b'), least(d || 'x', 'B') FROM colls ORDER BY id" },
  // refused by name, never another order
  { name: "collation: an ICU keyword (refused)", sql: "SELECT id FROM colls ORDER BY d COLLATE mason_num, id" },
  { name: "collation: a nondeterministic equality (refused)", sql: "SELECT id FROM colls WHERE d = 'B' COLLATE mason_ci ORDER BY id" },
  { name: "collation: a nondeterministic grouping (refused)", sql: "SELECT d COLLATE mason_ci, count(*) FROM colls GROUP BY 1" },
  { name: "collation: a collation that does not exist (42704)", sql: "SELECT id FROM colls ORDER BY d COLLATE \"no_such\", id" },
  // now answered: en_US is never refused
  { name: "collation: COLLATE en_US.utf8", sql: "SELECT id FROM typed ORDER BY t COLLATE \"en_US.utf8\", id" },
  { name: "collation: COLLATE en_US", sql: "SELECT id FROM colls ORDER BY d COLLATE \"en_US\", id" },
  // duck-rewrite.md's BI forms
  { name: "collation: a grouped COLLATE by number", sql: "SELECT d COLLATE \"und-x-icu\" AS n, count(*) FROM colls GROUP BY 1 ORDER BY 1" },
  { name: "collation: a grouped COLLATE by name", sql: "SELECT d COLLATE \"und-x-icu\" AS n, count(*) FROM colls GROUP BY 1 ORDER BY n" },
  { name: "collation: a grouped COLLATE by expression", sql: "SELECT d COLLATE \"und-x-icu\" AS n, count(*) FROM colls GROUP BY 1 ORDER BY d COLLATE \"und-x-icu\"" },
  { name: "collation: the nulls idiom with a shadowing alias", sql: "SELECT d AS i, id FROM colls ORDER BY i IS NULL, i, id" },
  { name: "collation: the nulls idiom with an integer constant", sql: "SELECT i, id FROM colls ORDER BY CASE WHEN i IS NULL THEN 1 ELSE 0 END, 1, 2" },
  { name: "collation: a star beside the named column", sql: "SELECT *, i FROM colls ORDER BY i, id" },
  // duck-rewrite.md: a NULL and a row-held argument
  { name: "collation: GREATEST and LEAST with a NULL", sql: "SELECT id, greatest(i, NULL), least(NULL::text, l) FROM colls ORDER BY id" },
  { name: "collation: compared with NULL", sql: "SELECT id FROM colls WHERE i > NULL" },
  // (no row comparison: it stays unverified, so refused, until issue 284 gives it Postgres's NULLs; a statement here
  // would verify it. Its collations are read from Postgres's analysis already: `rowCompared`, src/duck/rewrite.ts)
  // duck-rewrite.md probes
  { name: "collation: inside a scalar subquery and ARRAY(…)", sql: "SELECT (SELECT i FROM colls ORDER BY i LIMIT 1), ARRAY(SELECT l FROM colls ORDER BY 1 LIMIT 3)" },
  { name: "collation: by number through UNION ALL", sql: "SELECT id, i FROM colls UNION ALL SELECT id, i FROM colls ORDER BY 2, 1" },
  { name: "collation: WITH TIES", sql: "SELECT i FROM colls ORDER BY i FETCH FIRST 2 ROWS WITH TIES" },
  { name: "collation: ROLLUP ordered by itself", sql: "SELECT i, count(*) FROM colls GROUP BY ROLLUP (i) ORDER BY i, 2" },
  // the fallbacks: what sorts as stored stays as written
  { name: "collation: a C column's top N", sql: "SELECT id FROM colls ORDER BY c, id LIMIT 3" },
  { name: "collation: LIKE of an ICU column", sql: "SELECT id FROM colls WHERE i LIKE 'b%' ORDER BY id" },
  { name: "collation: equality of an ICU column", sql: "SELECT id FROM colls WHERE i = 'b' ORDER BY id" },
  { name: "collation: PARTITION BY an ICU column", sql: "SELECT id, count(*) OVER (PARTITION BY i) FROM colls ORDER BY id" },
  ...CASE_CASES,
];
