/**
 * WHAT A COLLATION MEANS, IN ONE PLACE (issue 253, decision B; docs/DESIGN.md "Postgres decides, DuckDB computes"). WHICH
 * collation orders a text is Postgres's analysis: each analysed node carries the OID it resolved (src/duck/pgtree.ts
 * `Typed.collation`, exprCollation, and `Typed.inputCollation`, the one an operator, a GREATEST, an aggregate or a
 * window compared under), the explicit COLLATE, a column's own, a derived table's and a set operation's column alike,
 * and Postgres's own 42P21 / 42P22 / 42704 come from that analysis. WHAT that OID means is this module alone:
 *
 *   OID → the catalog's pg_collation row (its schema and name) → the SOURCE's pg_collation row of that name (read at the
 *   start, src/cli/preflight.ts `SourceFacts.collations`) → a `DuckCollation`: byte order, an ICU locale DuckDB has
 *   (through the ONE name mapper, `icuName`), or a libc order read from the source (src/duck/libc-order.ts), named by
 *   its collcollate so the engine keys each with its own order.
 *
 * The catalog declares the source's collations (src/api/postgres/catalog.ts `catalogDdl`), so a name the source has
 * resolves there and one it lacks is Postgres's 42704 there; a collation PGlite has of its own that the source lacks is
 * refused here with the same 42704, never answered as if the source had it. OID 100 is the database's collation, 0 none.
 *
 * REFUSED BY NAME, never another order (`collation-unknown`): a nondeterministic collation anywhere in a statement
 * (Postgres equates and groups under it: no equality key of the engine's is its), an ICU locale the engine cannot
 * follow exactly where it orders (a `-u-` keyword such as `und-u-kn`; a base language the engine has no collation
 * for), and a libc order that could not be read (`libc-locale-unread`).
 *
 * CASE MAPPING (issue 406) is the other fact a collation decides: upper, lower and initcap map under the call's input
 * collation (`Typed.inputCollation`), as that collation's CTYPE says (`caseMappingOf`: a libc collctype or the
 * database's datctype, an ICU or builtin locale), asked through `StatementCollations.caseOf`, apart from the order's
 * refusals. Refused by name (`case-mapping-unknown`): a Turkish or Azeri libc ctype, a builtin locale Mason does not know.
 */
import { Unrewritable } from "./rewrite.ts";
import type { LibcOrder } from "./libc-order.ts";

/** How text is ordered under one collation, as the engine can follow it. */
export type DuckCollation =
  /** byte order */
  | { kind: "bytes" }
  /** ICU: DuckDB's own ICU collation of that locale gives the same order (held to Postgres by tests/integration/duck-oracle.itest.ts) */
  | { kind: "icu"; name: string }
  /** a libc locale (glibc's en_US.UTF-8, RDS's default): the order read from the source for that collcollate
   *  (src/duck/libc-order.ts), which the engine's `__mason_libc_key` is told by name */
  | { kind: "libc"; collate: string };

/**
 * How text's case is mapped under one collation (upper, lower, initcap), as Postgres's ctype decides it: `ascii` for a
 * C or POSIX ctype and the builtin `C` locale (ASCII letters only); `libc` for a libc locale of glibc's shared i18n
 * LC_CTYPE (towupper / towlower per character: `ß` kept); `simple` for the builtin `C.UTF-8` (Unicode's simple
 * mappings); `full` for the builtin `PG_UNICODE_FAST` (Unicode's full mappings and titlecasing: `ß` is `SS`); `icu:<tag>`
 * for ICU, its locale as a BCP 47 tag (`icuLocale`): ICU's full mappings under its language (`tr`'s `i` is `İ`). What
 * each does is src/duck/functions.ts `pgCase` / `initcap`.
 */
export type CaseMapping = "ascii" | "libc" | "simple" | "full" | `icu:${string}`;

/** An ICU locale as the case mapping names it: its BCP 47 tag (`de_AT` is `de-AT`, ICU's `@` keywords dropped), `und`
 *  for the root's and for one that is no tag. ICU's casing reads the tag's language alone (`tr`'s `i`, `nl`'s `IJ`);
 *  initcap's word break reads the whole tag (`en-US-u-va-posix` breaks a word at a full stop) */
export function icuLocale(locale: string): string {
  const tag = locale.replace(/[.@].*$/, "").replace(/_/g, "-");
  if (!/^[A-Za-z]{2,3}([-][A-Za-z0-9]{1,8})*$/.test(tag)) return "und";
  // (a tag of that shape the runtime still finds invalid, such as a repeated variant, is Intl's RangeError: its
  // language alone then, which is all ICU's casing reads)
  try { return Intl.getCanonicalLocales(tag)[0] ?? "und"; }
  catch (e) { if (e instanceof RangeError) return tag.split("-")[0]!.toLowerCase(); throw e; }
}

/** the C or POSIX ctype exactly (Postgres's lc_ctype_is_c): `C.UTF-8` is glibc's own locale, which maps every letter */
const C_CTYPE = /^(C|POSIX)$/i;
/** a libc ctype whose towupper is not glibc's shared i18n one: Turkish's and Azeri's dotted and dotless i */
const TURKIC_CTYPE = /^(tr|az)([_.@-]|$)/i;

/**
 * THE CASE MAPPING OF A COLLATION, from what decides it in Postgres: the CTYPE side of its locale (`ctype`: a libc
 * one's collctype, the database's datctype), or its ICU or builtin locale (`locale`). Null where Mason cannot follow it:
 * a Turkish or Azeri libc ctype, a builtin locale it does not know. Never the collation's ORDER (its collcollate): a
 * database of datcollate C and datctype en_US.UTF-8 maps case as en_US.
 */
export function caseMappingOf(provider: string, ctype: string | null, locale: string | null): CaseMapping | null {
  if (provider === "i") return `icu:${icuLocale(locale ?? ctype ?? "")}`;
  if (provider === "b") {
    const l = (locale ?? "").toUpperCase();
    return l === "C" ? "ascii" : l === "C.UTF-8" || l === "C.UTF8" ? "simple" : l === "PG_UNICODE_FAST" ? "full" : null;
  }
  const c = ctype ?? "C";
  if (C_CTYPE.test(c)) return "ascii";
  return TURKIC_CTYPE.test(c) ? null : "libc";
}

/** A collation of the source (pg_collation), by the name a statement or a column names it. */
export interface SourceCollation {
  schema: string;
  name: string;
  /** collprovider: c libc, i ICU, b builtin, d default */
  provider: string;
  collate: string | null;
  /** collctype: a libc one's ctype, which decides its case mapping (`caseMappingOf`); absent, its collcollate */
  ctype?: string | null;
  /** colllocale (17+) / colliculocale (15–16): ICU's or builtin's locale */
  locale: string | null;
  deterministic: boolean;
  /** pg_collation_actual_version of a libc one, else collversion; null where none */
  version?: string | null;
}

const BYTE_LOCALE = /^(C|POSIX)([.].*)?$/i;

/** Whether a libc locale is one whose order is read from the source (not C or POSIX) */
export const isLibcCollation = (provider: string, collate: string): boolean =>
  provider !== "b" && provider !== "i" && provider !== "d" && !BYTE_LOCALE.test(collate);

/** THE ONE ICU NAME MAPPER: an ICU locale (`en-US`, `und`, `de_AT`) as the engine's collation name, its base language
 *  where the engine lacks the region; null where it has neither. Postgres's `und` (the root locale) is the engine's
 *  `en_us`, as `unicode` is. */
export function icuName(locale: string, known: ReadonlySet<string>): string | null {
  const lang = locale.replace(/[.@].*$/, "").replace(/-/g, "_").toLowerCase();
  if (lang === "und" || lang === "root" || lang === "") return known.has("en_us") ? "en_us" : null;
  if (known.has(lang)) return lang;
  const base = lang.split("_")[0]!;
  return known.has(base) ? base : null;
}

/** The source DATABASE's collation as the engine follows it, from pg_database: `provider` c (libc), i (ICU) or b (builtin). */
export function duckCollation(provider: string, collate: string, locale: string | null, known: ReadonlySet<string>): DuckCollation {
  if (provider === "b") return { kind: "bytes" };
  if (BYTE_LOCALE.test(collate) && provider !== "i") return { kind: "bytes" };
  if (provider === "i") {
    const name = icuName(locale ?? collate, known);
    if (name === null) throw new Error(`the source database's ICU locale ${JSON.stringify(locale ?? collate)} has no collation in the engine: Mason cannot sort text as it does`);
    return { kind: "icu", name };
  }
  return { kind: "libc", collate };
}

/** A pg_collation row as the catalog holds it, by OID */
export interface CatalogCollation { oid: number; schema: string; name: string; provider: string; collate: string | null; ctype: string | null; locale: string | null; deterministic: boolean }

/** what the resolver reads the catalog with: rows of text, as src/duck/analyze.ts `catalogRows` answers */
export type CatalogRows = (sql: string) => Promise<Array<Array<string | null>>>;

/** One statement's collations, resolved before its rewrite (`CollationResolver.prepare`): the rewrite asks `resolve`
 *  where it orders and `caseOf` where it maps case. */
export interface StatementCollations {
  /** the database's collation (OID 100): a jsonb's strings, a citext's order */
  readonly database: DuckCollation;
  /** the collation an OID names, as the engine follows it: null for 0 (no collation); a refusal where it orders and
   *  the engine cannot follow it */
  resolve(oid: number): DuckCollation | null;
  /** THE CASE MAPPING an OID names (upper, lower, initcap; a citext's fold, under the database's, OID 100): never its
   *  order's refusals (an ICU keyword, a language the engine has no order for, a libc order unread map case as their
   *  ctype says); a refusal (`case-mapping-unknown`) where Mason cannot follow it */
  caseOf(oid: number): CaseMapping;
}

const refused = (message: string, hint: string): Unrewritable => new Unrewritable(message, hint, "collation-unknown");

/** the refusal of a case mapping Mason cannot follow, of the collation it names */
const caseRefused = (what: string, ctype: string): Unrewritable => new Unrewritable(
  `upper, lower and initcap under ${what} (its ctype ${JSON.stringify(ctype)}) are not supported by Mason: its case mapping is not one Mason follows (Turkish's and Azeri's i under libc, or a builtin locale Mason does not know)`,
  `write COLLATE "C" for ASCII letters only, or COLLATE "und-x-icu" for Unicode's mapping`, "case-mapping-unknown");

/**
 * THE RESOLVER, built once per listener (src/duck/store.ts `listener`). `source` is null in the unit world (no source
 * read): the catalog's own row is then the source's. `readLibc` reads a libc order of a collcollate the source has
 * (src/cli/dev.ts: from the source, under a bound, kept in the synced data), on its first use.
 */
export class CollationResolver {
  readonly database: DuckCollation;
  /** the database's case mapping (pg_database's datctype, or its ICU or builtin locale): null where Mason cannot follow it */
  readonly #databaseCase: { mapping: CaseMapping | null; ctype: string };
  readonly #databaseCollate: string | null;
  readonly #source: Map<string, SourceCollation> | null;
  readonly #known: ReadonlySet<string>;
  readonly #libc = new Map<string, LibcOrder>();
  readonly #reading = new Map<string, Promise<LibcOrder>>();
  readonly #readLibc: ((c: SourceCollation) => Promise<LibcOrder>) | null;

  /** `databaseCollate`: the database's datcollate where its provider is libc (a libc collation of that locale is the
   *  database's order), else null. `databaseCase`: the database's case mapping (`caseMappingOf` its datctype or locale)
   *  and the ctype it was read from; absent (a unit test, a store with no source), glibc's, or ICU's root's where the
   *  database orders by ICU */
  constructor(o: { database: DuckCollation; databaseCollate?: string | null; databaseCase?: { mapping: CaseMapping | null; ctype: string };
    source?: readonly SourceCollation[] | null; known: ReadonlySet<string>; libc?: ReadonlyMap<string, LibcOrder>; readLibc?: ((c: SourceCollation) => Promise<LibcOrder>) | null }) {
    this.database = o.database;
    this.#databaseCase = o.databaseCase ?? (o.database.kind === "icu" ? { mapping: "icu:und", ctype: "und" } : { mapping: "libc", ctype: "en_US.UTF-8" });
    this.#databaseCollate = o.databaseCollate ?? null;
    this.#source = o.source === undefined || o.source === null ? null : new Map(o.source.map((c) => [`${c.schema}\u0000${c.name}`, c]));
    this.#known = o.known;
    for (const [k, v] of o.libc ?? []) this.#libc.set(k, v);
    this.#readLibc = o.readLibc ?? null;
  }

  /** A resolver of the database's collation alone, for a caller with no catalog collations to name (a unit test's
   *  `planDuck`): every other OID is resolved from the catalog's own row. */
  static of(database: DuckCollation, known: ReadonlySet<string> = new Set(["en_us", "en", "de", "fr", "sv", "tr", "da", "es", "ja", "zh"]),
    databaseCase?: { mapping: CaseMapping | null; ctype: string }): CollationResolver {
    return new CollationResolver({ database, known, ...(databaseCase === undefined ? {} : { databaseCase }) });
  }

  /** the database's case mapping (OID 100), or its refusal */
  #databaseMapping(): CaseMapping {
    if (this.#databaseCase.mapping === null) throw caseRefused("the database's collation", this.#databaseCase.ctype);
    return this.#databaseCase.mapping;
  }

  /** a libc order held (read at the start, or on first use), by collcollate */
  libcOrder(collate: string): LibcOrder | undefined { return this.#libc.get(collate); }

  /** the libc orders held, by collcollate */
  libcOrders(): ReadonlyMap<string, LibcOrder> { return this.#libc; }

  /** Holds a libc order read elsewhere (the database's, at the start) */
  hold(collate: string, order: LibcOrder): void { this.#libc.set(collate, order); }

  /**
   * ONE STATEMENT'S COLLATIONS: each OID its analysis uses (`oids`) read from the catalog once, the source's row of its
   * name found, a nondeterministic one refused (anywhere: the statement may equate under it), and a libc order not yet
   * held read before the plan is made. What `resolve` refuses is decided here and raised where it orders.
   */
  async prepare(rows: CatalogRows, oids: Iterable<number>): Promise<StatementCollations> {
    const wanted = [...new Set(oids)].filter((o) => o !== 0 && o !== 100 && Number.isInteger(o)).sort((a, b) => a - b);
    const meant = new Map<number, DuckCollation | Unrewritable>();
    const cased = new Map<number, CaseMapping | Unrewritable>();
    if (wanted.length > 0) {
      const read = await rows(`SELECT c.oid::text, n.nspname, c.collname, c.collprovider::text, c.collcollate, c.collctype, c.colllocale, c.collisdeterministic::text ` +
        `FROM pg_catalog.pg_collation c JOIN pg_catalog.pg_namespace n ON n.oid = c.collnamespace WHERE c.oid IN (${wanted.join(", ")})`);
      for (const [oid, schema, name, provider, collate, ctype, locale, deterministic] of read) {
        const own: CatalogCollation = { oid: Number(oid), schema: schema!, name: name!, provider: provider!, collate: collate ?? null, ctype: ctype ?? null, locale: locale ?? null, deterministic: deterministic === "true" };
        meant.set(own.oid, await this.#meaning(own));
        cased.set(own.oid, this.#caseMeaning(own));
      }
    }
    for (const o of wanted) if (!meant.has(o)) throw new Error(`the collation ${o} of a statement's analysis is not in the catalog (Mason bug: report it)`);
    return {
      database: this.database,
      resolve: (oid: number): DuckCollation | null => {
        if (oid === 0) return null;
        if (oid === 100) return this.database;
        const m = meant.get(oid);
        if (m === undefined) throw new Error(`the collation ${oid} was not prepared for the statement (Mason bug: report it)`);
        if (m instanceof Unrewritable) throw m;
        return m;
      },
      caseOf: (oid: number): CaseMapping => {
        if (oid === 100) return this.#databaseMapping();
        const m = cased.get(oid);
        if (m === undefined) throw new Error(`the collation ${oid} was not prepared for the statement (Mason bug: report it)`);
        if (m instanceof Unrewritable) throw m;
        return m;
      },
    };
  }

  /** one catalog collation's case mapping: its SOURCE row's ctype or locale (`#meaning` refused a collation the source
   *  lacks, and a nondeterministic one, before this is asked) */
  #caseMeaning(own: CatalogCollation): CaseMapping | Unrewritable {
    const c = this.#sourceRow(own)!;
    if (c.provider === "d") return this.#databaseCase.mapping ?? caseRefused("the database's collation", this.#databaseCase.ctype);
    const ctype = c.provider === "c" ? c.ctype ?? c.collate ?? "C" : c.locale ?? c.collate ?? "";
    return caseMappingOf(c.provider, ctype, c.locale) ?? caseRefused(`the collation "${own.name.replaceAll('"', '""')}"`, ctype);
  }

  /** the source's row of a catalog collation (the catalog's own in the unit world); undefined where the source lacks it */
  #sourceRow(own: CatalogCollation): SourceCollation | undefined {
    return this.#source === null ? { ...own } : this.#source.get(`${own.schema}\u0000${own.name}`);
  }

  /** what one catalog collation means to the engine, or the refusal it raises where it orders */
  async #meaning(own: CatalogCollation): Promise<DuckCollation | Unrewritable> {
    const quoted = `"${own.name.replaceAll('"', '""')}"`;
    const c = this.#sourceRow(own);
    // a collation PGlite has that the source lacks: the source's own error
    if (c === undefined) throw new Unrewritable(`collation ${quoted} for encoding "UTF8" does not exist`, "", { postgres: "42704" });
    if (!c.deterministic) {
      throw refused(`the collation ${quoted} is nondeterministic: Mason cannot follow it (Postgres equates, groups and sorts strings it holds equal, which Mason's equality does not)`,
        `write COLLATE "C" for byte order, or a deterministic collation`);
    }
    if (c.provider === "d") return this.database;
    if (c.provider === "b") return { kind: "bytes" };
    if (c.provider === "c") {
      const collate = c.collate ?? "C";
      if (BYTE_LOCALE.test(collate)) return { kind: "bytes" };
      // the database's own locale: its order, read at the start (bytes where the source's strcoll is)
      if (collate === this.#databaseCollate) return this.database;
      return this.#libcOf(c, collate, quoted);
    }
    if (c.provider === "i") {
      const locale = c.locale ?? c.collate ?? "";
      // a keyword (`-u-kn`, `@colNumeric=yes`) changes the order in ways the engine's collation of the language does not
      if (/-u-|-t-|@/i.test(locale)) {
        return refused(`the collation ${quoted} (ICU locale ${JSON.stringify(locale)}) sets an ICU keyword Mason cannot follow`, `write COLLATE "C" for byte order, or COLLATE "und-x-icu"`);
      }
      const name = icuName(locale, this.#known);
      if (name === null) return refused(`the collation ${quoted} (ICU locale ${JSON.stringify(locale)}) is not one Mason can follow`, `write COLLATE "C" for byte order, or COLLATE "und-x-icu"`);
      return { kind: "icu", name };
    }
    return refused(`the collation ${quoted} is not one Mason can follow`, `write COLLATE "C" for byte order, or leave the COLLATE out for the database's`);
  }

  /** a libc collation other than the database's: its order held, else read once (a statement waits for it) */
  async #libcOf(c: SourceCollation, collate: string, quoted: string): Promise<DuckCollation | Unrewritable> {
    let order = this.#libc.get(collate);
    if (order === undefined && this.#readLibc !== null) {
      let reading = this.#reading.get(collate);
      if (reading === undefined) { reading = this.#readLibc(c); this.#reading.set(collate, reading); }
      try { order = await reading; this.#libc.set(collate, order); }
      catch (e) {
        this.#reading.delete(collate);
        return new Unrewritable(`the order of the collation ${quoted} (${collate}) could not be read from the source: ${(e as Error).message}`, `write COLLATE "C" for byte order, or COLLATE "und-x-icu"`, "libc-locale-unread");
      }
    }
    if (order === undefined) return new Unrewritable(`the order of the collation ${quoted} (${collate}) was not read from the source`, `write COLLATE "C" for byte order, or COLLATE "und-x-icu"`, "libc-locale-unread");
    if (order.bytes) return { kind: "bytes" };
    return { kind: "libc", collate };
  }
}
