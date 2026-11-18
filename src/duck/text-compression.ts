/**
 * HOW A SYNCED TABLE'S TEXT COLUMNS ARE COMPRESSED, column by column (issue 1140; docs/DESIGN.md "Text compression by
 * column"). The instance forces ZSTD (src/duck/store.ts `INSTANCE_SETTINGS`), because the engine's analyzer never picks
 * it and stored a large JSON column Uncompressed. But ZSTD stores short or repeated text many times larger than the
 * analyzer's dictionary does: a status of six values over 100 M rows took 645 MB, against 41 MB, and a count by it read
 * from disk took 4.03 s, against 0.17 s. So when a table's copy is made, each text column is given its own method
 * (`USING COMPRESSION`, which wins over the instance's), from a sample of its values (`textStorage`):
 *
 * - THE DICTIONARY (`dict_fsst`, the analyzer's own choice for text) for short values and for values that repeat;
 * - ZSTD for long values that do not repeat, and for a column holding a value too long for the dictionary.
 *
 * What a column was given is in its table's definition, so it holds for every row written later (the poll, the
 * stream), through a checkpoint and a restart. A column with no sample (an empty table) keeps the instance's ZSTD, as
 * does every table made before this rule: until it is synced again whole or compacted (src/duck/compact.ts `rewrite`
 * decides again from the table's own rows).
 */

/** at most this many rows are sampled */
export const TEXT_SAMPLE_ROWS = 10_000;
/** the source's pages a sample reads, about (`TABLESAMPLE SYSTEM`): a small table is read from its start instead */
export const TEXT_SAMPLE_PAGES = 100;
/** the bytes of values the source reads whole for a sample's distinct count, about: a column of large values is
 *  counted over fewer rows (`distinctRows`), never 10,000 values of a megabyte each */
export const DISTINCT_SAMPLE_BYTES = 16 * 2 ** 20;
/**
 * A VALUE THE DICTIONARY CANNOT HOLD, in bytes: one value this long in a row group, and the engine stores that row group
 * Uncompressed (DuckDB 2.0 at 256 KiB blocks: 16,383 bytes kept the dictionary, 16,384 did not). A large JSON column
 * with one such document in a hundred took 1,451 MB a million rows, against 312 MB under ZSTD.
 */
export const DICTIONARY_VALUE_LIMIT = 16_384;
/**
 * VALUES THIS LONG, ON AVERAGE, ARE STORED ZSTD UNLESS THEY REPEAT. Measured over a million rows of each
 * (docs/DESIGN.md "Text compression by column"): below 64 bytes the dictionary is smaller (a status 8.5 times, a name
 * 3.4 times, an email 1.5 times). From 64 bytes, of values that do not repeat, ZSTD was smaller in every shape but one:
 * the cold benchmark's jsonb of 156 bytes took 65.5 MB under ZSTD against 102.3 MB with the dictionary over 2 M rows,
 * and random words and JSON of 68 to 223 bytes 5 to 16 % less. Sentences of 175 bytes were 11 % larger. The dictionary
 * filters such a column faster when it is cached (the jsonb: 67 ms against 92 ms), but a dashboard filters and groups on
 * short codes, and a column's bytes are what a cold read pays for. At 256 bytes, the threshold first chosen, the
 * benchmark's synced data grew 7.5 %.
 */
export const LONG_TEXT_BYTES = 64;
/**
 * VALUES REPEAT when the sample's distinct values are at most this share of its values: the dictionary holds each once.
 * JSON documents of 700 bytes over a million rows, of 300 distinct, took 2.6 MB with the dictionary and 40.9 MB under
 * ZSTD; of 1,000 distinct, 87 MB against 99 MB; of 3,000 distinct, 231 MB against 158 MB (the dictionary is kept per
 * block, and too many distinct values no longer repeat in one). A sample of 10,000 rows sees 1,000 distinct at a tenth,
 * 3,000 at about three tenths.
 */
export const REPEATED_SHARE = 1 / 8;

/**
 * A VALUE STORED INLINE AND UNCOMPRESSED IS AT MOST THIS LONG, about: Postgres compresses or moves out of line the
 * values of a row past `TOAST_TUPLE_THRESHOLD` (2,032 bytes at 8 KB pages), so a sample whose every value is under this,
 * none compressed, has its stored sizes as its values' own.
 */
export const INLINE_BYTES = 2_000;
/**
 * A JSONB'S TEXT AGAINST ITS STORED BYTES, at most: a character Postgres stores in one byte is printed as six at worst (a
 * control character's `\u0001`). So a value stored in under `INLINE_BYTES`, uncompressed, prints in under 12,000
 * bytes, inside the dictionary's 16,384.
 */
export const TEXT_EXPANSION = 6;

/**
 * What a sample says of one text column: its values (not null), their average and longest length in bytes, and how
 * many distinct among `distinctOf` of them (null: not counted, as it is not needed for a short column). `exact`: the
 * lengths are the values' text (a text's own length, or a synced table's); else they are sizes as Postgres stores them (a
 * json's or jsonb's), and `compressed` says how many of the values it stored compressed (null: it cannot tell, before
 * Postgres 14).
 */
export interface TextSample { values: number; avgBytes: number; maxBytes: number; distinct: number | null; distinctOf: number; exact: boolean; compressed: number | null }
/** how a text column is stored */
export type TextStorage = "dictionary" | "zstd";

/**
 * WHETHER THE DICTIONARY CAN HOLD THE COLUMN'S VALUES, as far as the sample tells. A length that is the text's: its
 * longest under `DICTIONARY_VALUE_LIMIT`. A size as stored tells the text's length only for a value stored inline and
 * uncompressed, and then within `TEXT_EXPANSION`: every value under `INLINE_BYTES`, none compressed. A value Postgres
 * compressed or moved out of line says nothing of its text: a jsonb of 3,383 bytes stored was 51,892 bytes of text, and
 * given the dictionary every row group of it was stored Uncompressed (the review of PR 1141).
 */
export function dictionaryHolds(s: Pick<TextSample, "maxBytes" | "exact" | "compressed">): boolean {
  return s.exact ? s.maxBytes < DICTIONARY_VALUE_LIMIT : s.compressed === 0 && s.maxBytes < INLINE_BYTES;
}

/** whether the rule needs the column's distinct values: only for long values the dictionary can hold */
export const needsDistinct = (s: Pick<TextSample, "values" | "avgBytes" | "maxBytes" | "exact" | "compressed">): boolean =>
  s.values > 0 && dictionaryHolds(s) && s.avgBytes >= LONG_TEXT_BYTES;

/** THE RULE. Null: no value was sampled, and the column keeps the instance's method. */
export function textStorage(s: TextSample | null | undefined): TextStorage | null {
  if (s === null || s === undefined || s.values <= 0) return null;
  if (!dictionaryHolds(s)) return "zstd";
  if (s.avgBytes < LONG_TEXT_BYTES) return "dictionary";
  // not counted: as if they did not repeat, the instance's own ZSTD
  if (s.distinct !== null && s.distinctOf > 0 && s.distinct <= s.distinctOf * REPEATED_SHARE) return "dictionary";
  return "zstd";
}

/** a column definition's compression clause for `storage`: nothing when undecided (the instance's) */
export function compressionClause(storage: TextStorage | null): string {
  return storage === null ? "" : storage === "dictionary" ? " USING COMPRESSION dict_fsst" : " USING COMPRESSION zstd";
}

/** whether a column of this engine type is text whose compression is chosen (a JSON is held as text) */
export const isTextType = (duckType: string): boolean => duckType === "VARCHAR" || duckType === "JSON";

/** a sample's rows on the source: about `TEXT_SAMPLE_PAGES` of its `pages` pages chosen at random (`TABLESAMPLE
 *  SYSTEM`: only those pages are read), the same pages at every read of one copy (`REPEATABLE`), at most `rows` */
function sampled(pgFrom: string, columns: readonly string[], pages: number, rows: number): string {
  const percent = pages > TEXT_SAMPLE_PAGES ? (100 * TEXT_SAMPLE_PAGES) / pages : 100;
  // a fixed-point number: the clause takes no exponent
  const p = percent >= 100 ? "100" : percent.toFixed(12).replace(/0+$/, "");
  return `(SELECT ${columns.map((c, i) => `${c} AS c${i}`).join(", ")} FROM ${pgFrom} TABLESAMPLE SYSTEM (${p}) REPEATABLE (0) LIMIT ${rows}) s`;
}

/** whether a source column's length is its text's own (`octet_length` reads it from the value's header, however it is
 *  stored), else its size as stored (`pg_column_size`: a json or jsonb, whose text would have to be made whole).
 *  `type` is as `format_type` spells it. */
export const exactLength = (type: string): boolean => /^(text|character varying(\(\d+\))?|character(\(\d+\))?)$/.test(type);

/**
 * THE SAMPLE'S LENGTHS ON THE SOURCE, in the copy's transaction (its snapshot), never a large value taken out of its
 * TOAST table: per column its values, their average and longest length (`exactLength`), and for a size as stored how
 * many values Postgres stored compressed (`pg_column_compression`, from Postgres 14, `compressionKnown`; before it,
 * NULL: it cannot tell), one row back. `columns`: each quoted for Postgres, with its type.
 */
export function sourceLengthsSql(pgFrom: string, columns: ReadonlyArray<{ column: string; type: string }>, pages: number, compressionKnown: boolean): string {
  const of = (c: { type: string }, i: number): string => {
    const v = `c${i}`, length = exactLength(c.type) ? `octet_length(${v})` : `pg_column_size(${v})`;
    const compressed = exactLength(c.type) ? "0" : compressionKnown ? `count(*) FILTER (WHERE pg_column_compression(${v}) IS NOT NULL)` : "NULL";
    return `count(${v}), avg(${length}), max(${length}), ${compressed}`;
  };
  return `SELECT ${columns.map(of).join(", ")} FROM ${sampled(pgFrom, columns.map((c) => c.column), pages, TEXT_SAMPLE_ROWS)}`;
}

/** how many rows a distinct count reads, about `DISTINCT_SAMPLE_BYTES` of text the source hashes: a length as stored
 *  counted at its text's most (`TEXT_EXPANSION`) */
export const distinctRows = (s: Pick<TextSample, "avgBytes" | "exact">): number =>
  Math.max(1, Math.min(TEXT_SAMPLE_ROWS, Math.floor(DISTINCT_SAMPLE_BYTES / Math.max(1, s.avgBytes * (s.exact ? 1 : TEXT_EXPANSION)))));

/** THE SAMPLE'S DISTINCT VALUES ON THE SOURCE, on the same pages as its lengths: per column its values and its distinct
 *  ones among the first `rows` rows, by a hash of its text (`hashtextextended`, Postgres 11: no cryptographic hash, which
 *  a server in FIPS mode refuses), so the sort is small. */
export function sourceDistinctSql(pgFrom: string, columns: readonly string[], pages: number, rows: number): string {
  return `SELECT ${columns.map((_, i) => `count(c${i}), count(DISTINCT hashtextextended(c${i}::text, 0))`).join(", ")} FROM ${sampled(pgFrom, columns, pages, rows)}`;
}

/** a synced table's rows by row id alone: eight runs spread up to `end`, `rows` rows in all, each column as text */
function syncedRows(table: string, columns: readonly string[], end: number, rows: number): string {
  const want = Math.max(1, Math.min(rows, TEXT_SAMPLE_ROWS));
  const runs = end <= want ? 1 : Math.min(8, want);
  const each = end <= want ? Math.max(end, 1) : Math.ceil(want / runs);
  const starts = runs === 1 ? [0] : Array.from({ length: runs }, (_, k) => Math.floor((k * (end - each)) / (runs - 1)));
  return `(${starts.map((x) => `SELECT ${columns.map((c, i) => `${c}::VARCHAR AS c${i}`).join(", ")} FROM ${table} WHERE rowid >= ${x} AND rowid < ${x + each}`).join(" UNION ALL ")}) s`;
}

/**
 * THE SAMPLE OF A SYNCED TABLE ITSELF (a compaction's, src/duck/compact.ts), as the source's is read: its lengths over
 * `rows` rows (a compaction's piece, which the memory holds), then its long columns' distinct values over about
 * `DISTINCT_SAMPLE_BYTES` of them (`syncedDistinctSql`, the same runs' first rows). `columns` are quoted for the engine.
 */
export function syncedLengthsSql(table: string, columns: readonly string[], end: number, rows: number = TEXT_SAMPLE_ROWS): string {
  return `SELECT ${columns.map((_, i) => `count(c${i}), avg(strlen(c${i})), max(strlen(c${i})), 0`).join(", ")} FROM ${syncedRows(table, columns, end, rows)}`;
}
export function syncedDistinctSql(table: string, columns: readonly string[], end: number, rows: number): string {
  return `SELECT ${columns.map((_, i) => `count(c${i}), count(DISTINCT c${i})`).join(", ")} FROM ${syncedRows(table, columns, end, rows)}`;
}

const num = (x: unknown): number => x === null || x === undefined ? 0 : Number(x);

/** a sample's lengths (`sourceLengthsSql`, `syncedLengthsSql`) as each column's `TextSample`, the distinct count not
 *  yet read; `exact` per column (a synced table's lengths are all its text's) */
export function lengthSamplesOf(names: readonly string[], row: readonly unknown[], exact: readonly boolean[] = names.map(() => true)): Map<string, TextSample> {
  return new Map(names.map((name, i) => [name, { values: num(row[4 * i]), avgBytes: num(row[4 * i + 1]), maxBytes: num(row[4 * i + 2]), distinct: null, distinctOf: 0,
    exact: exact[i] ?? true, compressed: row[4 * i + 3] === null || row[4 * i + 3] === undefined ? null : Number(row[4 * i + 3]) }]));
}

/** the distinct counts (`sourceDistinctSql`, `syncedDistinctSql`, over `names`) set on their samples */
export function withDistinct(samples: Map<string, TextSample>, names: readonly string[], row: readonly unknown[]): void {
  names.forEach((name, i) => {
    const s = samples.get(name);
    if (s !== undefined) samples.set(name, { ...s, distinctOf: num(row[2 * i]), distinct: num(row[2 * i + 1]) });
  });
}
