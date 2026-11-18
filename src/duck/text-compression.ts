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
 * VALUES THIS LONG, ON AVERAGE, ARE DOCUMENTS (JSON, descriptions, free text), stored ZSTD unless they repeat. Measured
 * over a million rows of each (docs/DESIGN.md "Text compression by column"): below 64 bytes the dictionary is smaller
 * (a status 8.5 times, a name 3.4 times, an email 1.5 times); from 64 to 230 bytes of values that do not repeat ZSTD is
 * within 18 % either way (smaller for random words, larger for sentences) but reads them 1.5 to 3 times slower; at 700
 * bytes and over it is 24 % smaller.
 */
export const LONG_TEXT_BYTES = 256;
/**
 * VALUES REPEAT when the sample's distinct values are at most this share of its values: the dictionary holds each once.
 * JSON documents of 700 bytes over a million rows, of 300 distinct, took 2.6 MB with the dictionary and 40.9 MB under
 * ZSTD; of 1,000 distinct, 87 MB against 99 MB; of 3,000 distinct, 231 MB against 158 MB (the dictionary is kept per
 * block, and too many distinct values no longer repeat in one). A sample of 10,000 rows sees 1,000 distinct at a tenth,
 * 3,000 at about three tenths.
 */
export const REPEATED_SHARE = 1 / 8;

/** what a sample says of one text column: its values (not null), their average and longest length in bytes, and how
 *  many distinct among `distinctOf` of them (null: not counted, as it is not needed for a short column) */
export interface TextSample { values: number; avgBytes: number; maxBytes: number; distinct: number | null; distinctOf: number }
/** how a text column is stored */
export type TextStorage = "dictionary" | "zstd";

/** whether the rule needs the column's distinct values: only for long values the dictionary can hold */
export const needsDistinct = (s: Pick<TextSample, "values" | "avgBytes" | "maxBytes">): boolean =>
  s.values > 0 && s.maxBytes < DICTIONARY_VALUE_LIMIT && s.avgBytes >= LONG_TEXT_BYTES;

/** THE RULE. Null: no value was sampled, and the column keeps the instance's method. */
export function textStorage(s: TextSample | null | undefined): TextStorage | null {
  if (s === null || s === undefined || s.values <= 0) return null;
  if (s.maxBytes >= DICTIONARY_VALUE_LIMIT) return "zstd";
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

/**
 * A SOURCE COLUMN'S LENGTH IN BYTES, read without taking a large value out of its TOAST table: a text's own length
 * (`octet_length` reads it from the value's header), else its size as stored (`pg_column_size`: a json or jsonb, whose
 * text would have to be made whole; for one compressed, less than its text). `type` is as `format_type` spells it.
 */
export function sourceLength(column: string, type: string): string {
  return /^(text|character varying(\(\d+\))?|character(\(\d+\))?)$/.test(type) ? `octet_length(${column})` : `pg_column_size(${column})`;
}

/** THE SAMPLE'S LENGTHS ON THE SOURCE, in the copy's transaction (its snapshot): per column its values, their average
 *  and longest length (`sourceLength`), one row back. `columns`: each quoted for Postgres, with its type. */
export function sourceLengthsSql(pgFrom: string, columns: ReadonlyArray<{ column: string; type: string }>, pages: number): string {
  return `SELECT ${columns.map((c, i) => `count(c${i}), avg(${sourceLength(`c${i}`, c.type)}), max(${sourceLength(`c${i}`, c.type)})`).join(", ")} ` +
    `FROM ${sampled(pgFrom, columns.map((c) => c.column), pages, TEXT_SAMPLE_ROWS)}`;
}

/** how many rows a distinct count reads of values of `avgBytes` on average: about `DISTINCT_SAMPLE_BYTES` of them */
export const distinctRows = (avgBytes: number): number => Math.max(1, Math.min(TEXT_SAMPLE_ROWS, Math.floor(DISTINCT_SAMPLE_BYTES / Math.max(1, avgBytes))));

/** THE SAMPLE'S DISTINCT VALUES ON THE SOURCE, on the same pages as its lengths: per column its values and its distinct
 *  ones (by a hash of its text, so the sort is small) among the first `rows` rows. */
export function sourceDistinctSql(pgFrom: string, columns: readonly string[], pages: number, rows: number): string {
  return `SELECT ${columns.map((_, i) => `count(c${i}), count(DISTINCT md5(c${i}::text))`).join(", ")} FROM ${sampled(pgFrom, columns, pages, rows)}`;
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
  return `SELECT ${columns.map((_, i) => `count(c${i}), avg(strlen(c${i})), max(strlen(c${i}))`).join(", ")} FROM ${syncedRows(table, columns, end, rows)}`;
}
export function syncedDistinctSql(table: string, columns: readonly string[], end: number, rows: number): string {
  return `SELECT ${columns.map((_, i) => `count(c${i}), count(DISTINCT c${i})`).join(", ")} FROM ${syncedRows(table, columns, end, rows)}`;
}

const num = (x: unknown): number => x === null || x === undefined ? 0 : Number(x);

/** a sample's lengths (`sourceLengthsSql`, `syncedLengthsSql`) as each column's `TextSample`, the distinct count not
 *  yet read */
export function lengthSamplesOf(names: readonly string[], row: readonly unknown[]): Map<string, TextSample> {
  return new Map(names.map((name, i) => [name, { values: num(row[3 * i]), avgBytes: num(row[3 * i + 1]), maxBytes: num(row[3 * i + 2]), distinct: null, distinctOf: 0 }]));
}

/** the distinct counts (`sourceDistinctSql`, `syncedDistinctSql`, over `names`) set on their samples */
export function withDistinct(samples: Map<string, TextSample>, names: readonly string[], row: readonly unknown[]): void {
  names.forEach((name, i) => {
    const s = samples.get(name);
    if (s !== undefined) samples.set(name, { ...s, distinctOf: num(row[2 * i]), distinct: num(row[2 * i + 1]) });
  });
}
