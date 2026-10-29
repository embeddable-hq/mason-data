/**
 * THE POSTGRES LISTENER: Mason speaks Postgres's wire protocol, so any tool with a Postgres driver (JDBC, psql, Metabase,
 * Grafana, DBeaver, Power BI) queries the copied tables as a read replica (docs/POSTGRES-API.md). A statement a tool
 * sends is parsed by Postgres's own grammar (parser.ts) and classified (translate.ts): a SELECT over a copied table is
 * planned by the catalog Postgres and run by DuckDB (`DuckOptions`, src/duck/plan.ts; docs/DESIGN.md
 * "Postgres decides, DuckDB computes"), a catalog statement is the catalog Postgres's, and SET / SHOW / BEGIN are the
 * session's. What this module owns is the SESSION: the handshake, the password, the parameters a tool sets, the
 * prepared statements and portals, the catalog Postgres beside it (catalog.ts), and the bytes of every answer
 * (encode.ts).
 *
 * THE RULES THIS MODULE EMBODIES:
 *   - THE PASSWORD IS VERIFIED BY `authenticate` (a `mason user`'s password, or a token minted from the API key,
 *     src/duck/users.ts `listenerLogins`): a refused one is `28P01` as a wrong password is. The database a tool names
 *     must be the project's: a tool connecting to the wrong Mason learns so at once (`3D000`).
 *   - WHAT A TOOL SETS IS HONOURED OR REFUSED, never silently ignored: `TimeZone` moves every timestamptz the session
 *     sends; `extra_float_digits` below 1 would print a float with FEWER digits than this listener sends and is
 *     refused; a `client_encoding` other than UTF8 is refused; a `DateStyle` other than ISO is refused. A parameter
 *     Mason has no opinion on is given to the catalog Postgres to validate (so an unknown name is `42704`, as on
 *     Postgres) and kept by the session, so `SHOW` answers it.
 *   - A CATALOG STATEMENT IS ANSWERED BY POSTGRES. Anything that reads only `pg_catalog` / `information_schema`, or
 *     reads no table at all (`SELECT version()`, `SELECT 1`, `current_setting(…)`), is forwarded to the Postgres inside
 *     the process, whose catalog holds the copied tables as empty tables, and its reply is relayed byte for byte (less
 *     its ReadyForQuery, which is this session's to send). A prepared statement there is named per session, so two
 *     sessions' unnamed statements never meet.
 *   - A TRANSACTION IS POSTGRES'S: `BEGIN` opens one (ReadyForQuery says `T`), an error inside it aborts it (`E`,
 *     and every statement until `ROLLBACK` is `25P02`, as a driver with autocommit off expects), `COMMIT` of an
 *     aborted one is a `ROLLBACK`. Nothing is ever written, so a transaction holds nothing — the states exist because
 *     a driver reads them.
 *   - "NOW" IS THE TRANSACTION'S: the session holds the instant its transaction began (`txNow`), which a plan reads as
 *     a parameter (`DuckPlan.clock`). A transaction begins as Postgres's does: at a simple Query's arrival (every
 *     statement of one Query message is one implicit transaction, and a transaction begun by a later statement of it
 *     starts at the same arrival), or at the first Parse or Bind since the last Sync (an implicit transaction lasts
 *     until Sync); `BEGIN` keeps it until `COMMIT` / `ROLLBACK`. So two statements inside `BEGIN … COMMIT` see one
 *     "now", two outside it can see two, and a prepared statement re-run moves with the clock.
 *   - EVERY STATEMENT ANSWERED OR REFUSED IS RECORDED (`record`, src/duck/requests.ts `_mason.requests`).
 *
 * THE TRACE (`MASON_PG_TRACE=1`, `trace` here): every statement text a session receives — a simple Query's whole text
 * and each Parse's — is a log line, and so is every refusal with its SQLSTATE; nothing is persisted beyond the log. It
 * is how a tool's own statements are recorded for the corpus (tests/postgres-api/corpus/tools.ts): the password is
 * never in it (the password is no statement).
 *
 * TLS: with `MASON_PG_TLS_CERT` / `MASON_PG_TLS_KEY` the listener answers SSLRequest with `S`, takes a connection that
 * opens with a TLS ClientHello as TLS at once (`directTls`: `sslnegotiation=direct`, a terminator in front), and REQUIRES
 * one or the other (a plain startup is refused: the password travels in it). Without them it is plain, says so at
 * start, and closes a connection that opens with a ClientHello, saying why in the log.
 */
import type { ExactColumn } from "../../duck/rewrite.ts";
import type { PlannedSql } from "../../duck/plan.ts";
import { copyFacts, type CopyFacts } from "../../duck/explain.ts";
import type { CopyState } from "../../duck/sync.ts";
import { explainedText, explainOptions, type ExplainOptions } from "./explain.ts";
import * as crypto from "node:crypto";
import * as net from "node:net";
import * as tls from "node:tls";
import type { RawStmt } from "libpg-query";
import { ApiError } from "../error.ts";
import { hashCaller, outcomeOf, storedPayload, type ApiLogRow } from "../request-log.ts";
import { canonicalZone } from "../../lib/timezone.ts";
import { databaseNameSql, PgCatalog } from "./catalog.ts";
import { EncodeError, OID, fieldOf } from "./encode.ts";
import { numericFromBinary, NumericError } from "../../lib/pg-numeric.ts";
import { parseSql, PostgresSyntaxError, stopParser } from "./parser.ts";
import {
  FrontendDecoder, ProtocolError, authenticationCleartextPassword, authenticationOk, backendKeyData, bindComplete,
  closeComplete, commandComplete, dataRow, emptyQueryResponse, errorResponse, noData, noticeResponse, parameterDescription,
  parameterStatus, parseComplete, portalSuspended, readyForQuery, rowDescription, sslResponse, type ErrorFields,
  type FieldDescription, type FrontendMessage,
  cstr, int16, int32, frame, decodeNoticeFrame, splitFrames, MAX_MESSAGE_LENGTH,
} from "./protocol.ts";
import { typeNameParts, type PgApiType, type PgSchema } from "./schema.ts";
import { Unsupported, duckTranslate, type Translation } from "./translate.ts";

/** what a statement is: one the session or the catalog Postgres answers (translate.ts), one DuckDB answers, or an
 *  EXPLAIN of one */
type AnyTranslation = Translation | DuckTranslation | ExplainTranslation;
/** an EXPLAIN on the DuckDB path: the statement it explains, and its options as written (read by `explaining`) */
interface ExplainTranslation { kind: "explain"; query: NonNullable<RawStmt["stmt"]>; options: unknown[] }
/** an EXPLAIN read: its options, and the plan of the statement it explains (null: a catalog statement, the catalog
 *  Postgres's to explain) */
interface Explaining { options: ExplainOptions; plan: DuckPlan | null }

/** what an EXPLAIN of a catalog statement says first: whose plan it is */
const CATALOG_EXPLAINED = "Mason: answered by the catalog Postgres (Mason's own, PGlite), not DuckDB: a statement of pg_catalog or information_schema, or of no table, is the catalog's, and this is its plan";

/** an EXPLAIN's one column, Postgres's: text, or json for FORMAT JSON (ExplainResultDesc) */
const explainField = (o: ExplainOptions, format: 0 | 1): FieldDescription => ({ name: "QUERY PLAN", typeOid: o.format === "json" ? 114 : 25, typeSize: -1, typeModifier: -1, format });

/** a DataRow's values (null for NULL) */
function dataRowValues(frame: Buffer): (Buffer | null)[] {
  const n = frame.readInt16BE(5);
  const out: (Buffer | null)[] = [];
  let at = 7;
  for (let i = 0; i < n; i++) {
    const len = frame.readInt32BE(at); at += 4;
    out.push(len < 0 ? null : frame.subarray(at, at + len)); if (len > 0) at += len;
  }
  return out;
}

/** the catalog Postgres's EXPLAIN with the line that says whose it is: a first row of the text, a key of the JSON */
function catalogExplained(frames: Buffer[], o: ExplainOptions): Buffer[] {
  const first = frames.findIndex((f) => f[0] === 0x44 /* D */);
  if (first < 0) return frames;
  if (o.format === "text") return [...frames.slice(0, first), dataRow([Buffer.from(CATALOG_EXPLAINED)]), ...frames.slice(first)];
  const value = dataRowValues(frames[first]!)[0];
  if (value === null || value === undefined) return frames;
  const doc = JSON.parse(value.toString("utf8")) as Array<Record<string, unknown>>;
  if (doc[0] !== undefined) doc[0].Mason = { "Answered By": "the catalog Postgres (Mason's own, PGlite), not DuckDB", Why: "a statement of pg_catalog or information_schema, or of no table, is the catalog's" };
  return [...frames.slice(0, first), dataRow([Buffer.from(JSON.stringify(doc, null, 2))]), ...frames.slice(first + 1)];
}
/** a statement DuckDB answers as written: its text (the parser's slice of the message) */
interface DuckTranslation { kind: "duckdb"; sql: string; /** Postgres's names for the result columns (translate.ts pgColumnNames) */ names?: (string | null)[] | null }

/** Postgres's names over DuckDB's: each named column renamed, a `*` (null) spanning what DuckDB expanded it to */
export function postgresNames<T extends { name: string }>(columns: readonly T[], names: readonly (string | null)[] | null | undefined): T[] {
  if (names === null || names === undefined) return [...columns];
  const star = names.indexOf(null);
  const width = columns.length - (names.length - (star >= 0 ? 1 : 0));
  if (width < 0 || (star < 0 && names.length !== columns.length)) return [...columns];
  const out: T[] = [];
  let at = 0;
  for (const n of names) {
    if (n === null) { for (let i = 0; i < width; i++) out.push(columns[at++]!); continue; }
    out.push({ ...columns[at++]!, name: n });
  }
  return at === columns.length ? out : [...columns];
}

/**
 * THE DUCKDB SEAM (docs/DESIGN.md "Postgres decides, DuckDB computes"): a SELECT that reads a copied table is
 * analysed by the catalog Postgres and rewritten (src/duck/plan.ts), and DuckDB runs the plan's SQL — never the
 * statement's text — its values written as Postgres's columns. One runner per session: a session's zone and
 * search_path are its own.
 */
export interface DuckAnswer {
  columns: Array<{ name: string; oid: number; size: number }>;
  /** the next chunk's rows, encoded in the formats asked; null once the result is read to its end (it is then closed).
   *  A failure closes it too, and throws the statement's error */
  fetch(formats: readonly number[], session: { timeZone: string }): Promise<Buffer[] | null>;
  /** ends the result early (a portal closed half read, the session gone): interrupted, and released once the executor
   *  has let go of the main thread (src/duck/store.ts scalarCallsSettled); DuckDB's connection is free again then */
  close(): void;
}
export interface DuckRunner {
  /** `sql`: a plan's (src/duck/plan.ts PlannedSql), never a statement's text; `fields`: Postgres's columns for the
   *  result (the plan's), which DuckDB's values are written as */
  run(sql: PlannedSql, params: readonly (string | null)[], session: { timeZone: string; searchPath: string }, signal: AbortSignal,
    fields?: ReadonlyArray<{ name: string; oid: number; typmod?: number }> | null, exact?: readonly ExactColumn[]): Promise<DuckAnswer>;
  /** EXPLAIN of a plan (src/duck/explain.ts): its QUERY PLAN rows, a line each (FORMAT JSON: one document). ANALYZE runs
   *  it as `run` does, under the same `signal`, converting every row and sending none */
  explain(sql: PlannedSql, params: readonly (string | null)[], session: { timeZone: string; searchPath: string }, signal: AbortSignal,
    how: ExplainHow): Promise<string[]>;
  /** closes the connection once its answers are released: never under the executor (src/duck/store.ts) */
  close(): Promise<void>;
}
/** what an EXPLAIN is run with beside its plan: its options, the plan's columns and exact numerics, its planning times,
 *  and the sync's facts of every copy (`DuckOptions.copies`), which say how each copy it reads is kept current */
export interface ExplainHow {
  options: ExplainOptions;
  fields: ReadonlyArray<{ name: string; oid: number; typmod?: number }> | null;
  exact: readonly ExactColumn[];
  planning: { analysisMs: number; rewriteMs: number };
  copies: readonly CopyFacts[];
}
/** A statement's DuckDB plan (src/duck/plan.ts): Postgres's analysis of it, and the DuckDB SQL that answers it alike. */
export interface DuckPlan {
  sql: PlannedSql;
  /** the parameters' types, Postgres's */
  params: number[];
  /** the result's columns, Postgres's RowDescription (size from pg_type) */
  fields: Array<{ name: string; oid: number; typmod: number; size: number }> | null;
  /** DuckDB answers one column after Postgres's (a WITH TIES rank), not sent */
  dropLast: boolean;
  /** the numeric columns computed as Postgres computes them, from cells DuckDB answers after Postgres's columns */
  exact?: ExactColumn[];
  /** what Postgres resolved the statement to (src/duck/resolved.ts): each one verified, or the statement was refused */
  resolved: readonly string[];
  /** the copied tables' JSON paths it reads by literal steps (src/duck/kept-route.ts readKey): the request log's
   *  `json_reads`, which decide the paths Mason stores (src/duck/kept.ts) */
  jsonReads?: readonly string[];
  /** the positions of the parameters DuckDB reads the transaction's start from, after the statement's own: `parse` the
   *  start as of the Parse (a relative literal, `'now'`, which Postgres reads then), `exec` as of the execution
   *  (now(), CURRENT_DATE …); each an instant the session sends */
  clock?: { parse?: number; exec?: number };
  /** how long Postgres's analysis took (its catalog reads with it) and Mason's rewrite (with its read-back), ms: an
   *  EXPLAIN ANALYZE's Planning Time */
  timing?: { analysisMs: number; rewriteMs: number };
}
/** the DuckDB halves the listener calls: a session's connection, and a statement's plan */
export interface DuckOptions {
  open(): Promise<DuckRunner>;
  /** Postgres's analysis (in the catalog Postgres, through `catalog`) and the DuckDB SQL; throws a StatementError for
   *  a statement Postgres refuses or DuckDB cannot answer alike */
  /** `timeZone`: the session's, which Postgres parses a literal under (a plan holds the values it parsed) */
  /** `wireBound`: the statement's rows are bounded by an Execute's row count (PlannedSql.unboundedLateral): planned as
   *  a LIMIT over its outermost SELECT would be, with no LIMIT in its SQL */
  plan(catalog: (bytes: Uint8Array) => Promise<Uint8Array>, text: string, stmt: NonNullable<RawStmt["stmt"]>, base: number, paramOids: readonly number[], searchPath: string,
    timeZone: string, userTypes: ReadonlyMap<string, number>, wireBound?: boolean): Promise<DuckPlan>;
  /** a Bind's values as DuckDB must read them: each through Postgres's input function for the plan's parameter type
   *  (a StatementError with Postgres's own error for a value it refuses) */
  parameters(catalog: (bytes: Uint8Array) => Promise<Uint8Array>, oids: readonly number[], values: readonly (string | null)[], timeZone: string): Promise<(string | null)[]>;
  /** moves when what a plan is made from moves outside the schema (a stored JSON path ready or gone, src/duck/kept.ts):
   *  the plans kept are made again */
  generation?(): number;
  /** the sync's state of every copy (src/duck/sync.ts `Sync.state`, what `mason status` reads): how EXPLAIN says each
   *  copy it reads is kept current. Absent: no sync, and EXPLAIN says it does not know */
  copies?(): readonly CopyState[];
}

/** a statement_timeout's value in ms, Postgres's units (a bare number is ms; `1.5s`, `5min`), 0 for none; null where
 *  it is no duration */
export function timeoutMs(value: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(us|ms|s|min|h|d)?\s*$/i.exec(value);
  if (m === null) return null;
  const per = { us: 0.001, ms: 1, s: 1000, min: 60_000, h: 3_600_000, d: 86_400_000 }[(m[2] ?? "ms").toLowerCase() as "ms"];
  return Math.round(Number(m[1]) * per);
}

/** A statement's error as Postgres raises it, from outside this module (the DuckDB runner's): the fields, and the SQL
 *  its position is in. */
export class StatementError extends Error {
  readonly fields: Omit<ErrorFields, "severity">;
  readonly sql: string;
  constructor(fields: Omit<ErrorFields, "severity">, sql = "") { super(fields.message); this.fields = fields; this.sql = sql; }
}
export const SERVER_VERSION = "18.6";
export const SERVER_VERSION_NUM = "180006";

/** `version()`'s whole text: `PostgreSQL 18.6` FIRST, since tools parse it (as Redshift and YugabyteDB keep it), then
 *  whose it is, then the machine in Postgres's own words (`aarch64`, `x86_64`, never Node's `arm64` / `x64`) */
export function versionText(product: string, version: string): string {
  const arch = ({ arm64: "aarch64", x64: "x86_64" } as Record<string, string>)[process.arch] ?? process.arch;
  return `PostgreSQL ${SERVER_VERSION} (${product} ${version}) on ${arch}-${process.platform}`;
}

/**
 * Who a session runs as: `user` a `mason user`'s name and `jti` its id (src/duck/users.ts), asked again before its
 * statements; a token's session is neither. Every session reads every copied table: there is no scope.
 * (`filters` and `subject` are always empty: src/duck/users.ts still writes them.)
 */
export interface PgToken { filters?: readonly []; subject?: undefined; jti?: string | undefined; user?: string | undefined }

/**
 * How often a user's session asks again whether its user is still live (`PgApiOptions.recheck`) when `recheckMs` is
 * absent: a removed user's NEW connections are refused at once, and a session it already holds — a BI tool's pool
 * keeps one for hours — ends at its first statement after this long.
 */
export const DEFAULT_RECHECK_MS = 30_000;

export interface PgApiOptions {
  port: number;
  host: string;
  /** THE DUCKDB PATH'S LIMIT FOR ONE STATEMENT, in ms (`MASON_STATEMENT_TIMEOUT`): a session's statement_timeout may
   *  only shorten it; absent or 0, none but the session's */
  statementTimeoutMs?: number;
  /** a catalog statement's deadline in ms (PgCatalogOptions.statementMs); default catalog.ts DEFAULT_STATEMENT_MS */
  catalogStatementMs?: number;
  /** PEM cert and key: offered on SSLRequest or a direct TLS start, and required of every connection; null for a plain listener */
  tls: { cert: Buffer; key: Buffer } | null;
  /** the database a tool must name: the project's name */
  database: string;
  /** what `version()` reports beside `PostgreSQL 18.6` (`versionText`): the release, `main-<sha>` or `dev` */
  masonVersion: string;
  /** whose version it is: `Mason` (the default) or `mason-data` (`mason serve`'s image and the CLI's run) */
  product?: string;
  /** the password verified (src/duck/users.ts `listenerLogins`): throws an ApiError (401) for the API key, an invalid
   *  token or a removed user, and rejects when it could not tell. `user` is the startup packet's: a token's session may
   *  send any, a `mason user`'s must send its own */
  authenticate(password: string, user: string): PgToken | Promise<PgToken>;
  /** asked again of a `mason user`'s session before a statement, at most every `recheckMs`: throws as authenticate does
   *  when the user was removed (the session ends), an ApiError 503 when it could not tell (the statement is refused, the
   *  session kept) */
  recheck?(token: PgToken): Promise<void>;
  /** how long a user's answer to `recheck` holds, in ms (DEFAULT_RECHECK_MS when absent): the run's users
   *  are a stat away, so 0 — every statement asks */
  recheckMs?: number | undefined;
  /** the copied tables (src/duck/sync.ts `schema()`); the SAME object until they change, so the server knows when to
   *  replace the catalog */
  schema(): PgSchema;
  /** the request log (src/duck/requests.ts): a row for every statement answered or refused, and every refused login */
  record(log: ApiLogRow): void;
  log?: ((line: string) => void) | undefined;
  /** log every statement text a session receives, and every refusal (`MASON_PG_TRACE=1`) */
  trace?: boolean | undefined;
  /** the clock "now" is read from, milliseconds since the epoch (`Date.now` when absent; a test pins it) */
  clock?: (() => number) | undefined;
  /** every statement over a table is DuckDB's: its plan and its run */
  duck: DuckOptions;
}

export interface PgApiServer {
  readonly port: number;
  close(): Promise<void>;
  /** sessions open now */
  readonly sessions: number;
}

// ---------------------------------------------------------------------------------------------------------------------
// bytes

/** the type byte of a RowDescription frame */
const ROW_DESCRIPTION = 0x54;
/** the first byte of a TLS handshake record (a ClientHello): never a startup packet's, whose length's high byte is 0
 *  under MAX_STARTUP_LENGTH, and never SSLRequest's (length 8) */
const TLS_HANDSHAKE = 0x16;

/** 1-based CHARACTER position of a byte offset into `sql`, as Postgres counts it. */
const positionOf = (sql: string, byteOffset: number | null): number | undefined =>
  byteOffset === null ? undefined : Buffer.from(sql, "utf8").subarray(0, byteOffset).toString("utf8").length + 1;

// ---------------------------------------------------------------------------------------------------------------------
// errors

/** A statement's failure as Postgres reports one. */
class PgError extends Error {
  readonly fields: ErrorFields;
  /** the HTTP-like status the request log records (400 for a refusal, 401 a refused login, 500 Mason's failure) */
  readonly status: number;
  constructor(fields: Omit<ErrorFields, "severity"> & { severity?: string }, status = 400) {
    super(fields.message);
    this.fields = { severity: "ERROR", ...fields };
    this.status = status;
  }
}

/** The SQLSTATE an ApiError's status is told as (a refused login's, src/duck/users.ts). */
function sqlstateOf(status: number, code: string | undefined): string {
  switch (status) {
    case 401: return "28000";
    case 403: return "42501";
    case 404: return "42P01";
    case 409: return "55000";
    case 413: return "54000";
    case 429: case 503: return "57P03";
    case 504: return "57014";
    case 400: return code === "unknown_model" ? "42P01" : code === "invalid_value" ? "22P02" : "0A000";
    default: return "XX000";
  }
}

/**
 * A refused or failed statement as its log line (`Session.refuse`): `failed` where the fault is Mason's or the
 * machine's (SQLSTATE classes XX internal, 53 resources, 57 a timeout or cancel, 58 system), `refused` for the
 * statement's own; the detail and the hint where there are, and the statement on one line, as the answered lines carry it.
 */
export function refusalLine(session: number, f: Omit<ErrorFields, "severity">, sql: string): string {
  const word = outcomeOf(f.code) === "failed" ? "failed" : "refused";
  const statement = sql.replace(/\s+/g, " ").trim();
  return `session ${session} ${word}: ${f.code} ${f.message}${f.detail ? `; detail: ${f.detail}` : ""}${f.hint ? `; hint: ${f.hint}` : ""}` +
    ` — ${statement === "" ? "(no statement)" : statement}`;
}

function asPgError(err: unknown, sql: string): PgError {
  if (err instanceof PgError) return err;
  if (err instanceof StatementError) return new PgError({ ...err.fields, position: err.fields.position ?? undefined }, err.fields.code.startsWith("XX") ? 500 : 400);
  if (err instanceof Unsupported) {
    return new PgError({ code: err.sqlstate, message: err.message, position: positionOf(sql, err.offset), hint: err.hint, detail: "Mason answers the Postgres subset in docs/POSTGRES-API.md" });
  }
  if (err instanceof PostgresSyntaxError) return new PgError({ code: "42601", message: err.message, position: positionOf(sql, err.offset) });
  if (err instanceof ApiError) return new PgError({ code: sqlstateOf(err.status, err.code), message: err.message, detail: `Mason: ${err.code}` }, err.status);
  // Postgres's own error for a numeric (a division by zero, 22012; a field overflow, 22003), raised as Postgres raises it
  if (err instanceof NumericError) return new PgError({ code: err.sqlstate, message: err.message }, err.sqlstate === "XX000" ? 500 : 400);
  if (err instanceof EncodeError) return err.code === "XX000"
    ? new PgError({ code: "XX000", message: err.message, detail: "Mason: a value the column's Postgres type cannot carry; report it" }, 500)
    : new PgError({ code: err.code, message: err.message }, 400);
  if (err instanceof ProtocolError) return new PgError({ code: "08P01", message: err.message }, 500);
  const message = err instanceof Error ? err.message : String(err);
  return new PgError({ code: "XX000", message }, 500);
}

// ---------------------------------------------------------------------------------------------------------------------
// the session's parameters

/** The parameters Postgres reports to the client (GUC_REPORT): a change is told as a ParameterStatus. */
const REPORTED = new Set(["application_name", "client_encoding", "datestyle", "intervalstyle", "timezone", "search_path", "standard_conforming_strings", "default_transaction_read_only", "in_hot_standby", "is_superuser", "session_authorization", "server_version", "server_encoding", "integer_datetimes"]);

/** Postgres's spelling of the parameters it reports, for the ParameterStatus name. */
const SPELLING: Record<string, string> = { datestyle: "DateStyle", intervalstyle: "IntervalStyle", timezone: "TimeZone" };
const spell = (name: string): string => SPELLING[name] ?? name;

interface Vars {
  timeZone: string;
  applicationName: string;
  searchPath: string;
  /** every other parameter the session set, validated by the catalog Postgres; SHOW answers from here */
  other: Map<string, string>;
}

const defaultVars = (): Vars => ({ timeZone: "UTC", applicationName: "", searchPath: '"$user", public', other: new Map() });

/** What `SHOW` / `current_setting` answer for the parameters this server fixes. */
function fixedParameter(name: string, vars: Vars, user: string): string | null {
  switch (name) {
    case "server_version": return SERVER_VERSION;
    case "server_version_num": return SERVER_VERSION_NUM;
    case "server_encoding": case "client_encoding": return "UTF8";
    case "datestyle": return "ISO, MDY";
    case "intervalstyle": return "postgres";
    case "timezone": return vars.timeZone;
    case "application_name": return vars.applicationName;
    case "search_path": return vars.searchPath;
    case "integer_datetimes": case "standard_conforming_strings": case "default_transaction_read_only": case "transaction_read_only": case "in_hot_standby": return "on";
    case "is_superuser": return "off";
    case "session_authorization": case "role": return user;
    case "transaction_isolation": case "default_transaction_isolation": return "read committed";
    case "extra_float_digits": return "1";
    case "max_identifier_length": return "63";
    default: return null;
  }
}

/**
 * WHAT `SHOW` / `current_setting` SAY ABOUT TLS (`SHOW ssl` once said `off` on a TLS session, the catalog
 * Postgres's answer — PGlite is built without TLS and serves none). The session's own: `on` with the parameters a server
 * with ssl on answers where this listener knows better (its library, protocol versions, ciphers and groups: Node's, which
 * the secure context is made with), else the catalog's — the certificate's and key's file names mean nothing to a client
 * and the operator's paths are not a token holder's. Postgres's `ssl` is the SERVER's setting, and here it is each
 * session's too: a TLS listener refuses a plain startup and a plain one serves no TLS, so the two never differ.
 */
export function tlsParameters(on: boolean): Readonly<Record<string, string>> {
  if (!on) return { ssl: "off" };
  return {
    ssl: "on", ssl_library: "OpenSSL", ssl_min_protocol_version: tls.DEFAULT_MIN_VERSION, ssl_max_protocol_version: tls.DEFAULT_MAX_VERSION,
    ssl_ciphers: tls.DEFAULT_CIPHERS, ssl_groups: tls.DEFAULT_ECDH_CURVE, ssl_prefer_server_ciphers: "off",
  };
}

/** The catalog's `current_setting(name[, missing_ok])`, answering the TLS parameters first (`tlsParameters`) and the rest
 *  as Postgres's own: the `version()` override's way (search_path lists pg_catalog after public), so a statement reading
 *  no table and calling it is forwarded as ever, and one table answers SHOW and current_setting alike. */
export function currentSettingSql(params: Readonly<Record<string, string>>): string[] {
  const cases = Object.entries(params).map(([name, value]) => `WHEN ${quoteLiteral(name)} THEN ${quoteLiteral(value)}`).join(" ");
  return [
    `CREATE OR REPLACE FUNCTION public.current_setting(text) RETURNS text LANGUAGE sql STABLE AS $$ SELECT CASE lower($1) ${cases} ELSE pg_catalog.current_setting($1) END $$`,
    `CREATE OR REPLACE FUNCTION public.current_setting(text, boolean) RETURNS text LANGUAGE sql STABLE AS $$ SELECT CASE lower($1) ${cases} ELSE pg_catalog.current_setting($1, $2) END $$`,
  ];
}

// ---------------------------------------------------------------------------------------------------------------------
// prepared statements and portals

interface Statement {
  sql: string;
  /** the one statement of the text, null for an empty text */
  raw: RawStmt | null;
  /** the OIDs the Parse declared (0 = unspecified), each resolved at Parse */
  paramOids: number[];
  /** the shape at Parse: a query's columns and parameter types; `catalog` for one the sidecar holds */
  shape: AnyTranslation | null;
  /** the sidecar holds it under this name */
  catalogName: string | null;
  /** a DuckDB statement's plan, made at Parse */
  duck?: DuckPlan;
  /** the session's search_path and TimeZone it was planned under at its Parse: a plan made again for it is made
   *  under them, never a later SET's */
  plannedUnder?: { searchPath: string; timeZone: string };
  /** its plan for an Execute with a row count, made at the first such Execute when its plan has a LEFT lateral only
   *  a bound streams (PlannedSql.unboundedLateral, `boundOnWire`) */
  duckOnWire?: DuckPlan;
  /** an EXPLAIN of a DuckDB statement: its options and that statement's plan, made at Parse */
  explain?: { options: ExplainOptions; plan: DuckPlan };
  /** an EXPLAIN of a catalog statement (the sidecar's): its options, for the line its rows begin with */
  explainCatalog?: ExplainOptions;
  /** the transaction's start as of the Parse: what a relative literal (`'now'`) of it means, as Postgres reads it then */
  parsedNow?: number;
}

interface Portal {
  statement: Statement;
  /** the bound values as text (binary ones decoded by their type), null for NULL */
  params: (string | null)[];
  /** the instant of the Bind: the statement's (`statement_timestamp()`) */
  boundAt: number;
  resultFormats: number[];
  /**
   * A CATALOG statement's portal, RUN AT ITS BIND in one call to the sidecar that ends in its own Sync: its
   * RowDescription (or NoData), its rows and its tag, kept here for the Describe and the Execute(s) that follow. The
   * sidecar is one connection every session shares, and a Sync ends its implicit transaction, which closes every
   * portal in it: a portal left open there between calls was lost to another session's Sync.
   */
  catalog?: { description: Buffer; rows: Buffer[]; sent: number; done: Buffer };
  /** an EXPLAIN's answer, once executed: its QUERY PLAN rows */
  rows: Buffer[] | null;
  /** a DuckDB statement's answer, once executed: read a chunk at a time (DuckCursor) */
  cursor?: DuckCursor;
  sent: number;
  fields: FieldDescription[] | null;
}

type TxState = "none" | "open" | "failed";

/**
 * A DuckDB result being sent: read from DuckDB a chunk at a time, so a result of any size holds one chunk (`pending`,
 * the rows read and not yet sent: an Execute's row limit, or a portal read aside while another statement ran). `sent`
 * counts what the client was sent (its CommandComplete's tag); `failed` is a failure met while it was read aside,
 * said when the portal is executed.
 */
interface DuckCursor { answer: DuckAnswer; formats: readonly number[]; controller: AbortController; pending: Buffer[]; sent: number; done: boolean; failed?: unknown;
  /** when its statement began (the request log's duration runs from it, however many Executes page the rows) */
  startedAt: number;
  /** its row of the request log is written: at its last row, by its refusal, or when it was dropped suspended */
  recorded?: boolean;
  /** an Execute's row count stopped it with rows left (PortalSuspended), and no Execute runs on it now: a portal
   *  dropped so is recorded by the drop, one dropped mid-Execute by that Execute (its rows or its error) */
  suspended?: boolean }

// ---------------------------------------------------------------------------------------------------------------------
// one connection

let nextSessionId = 1;

class Session {
  readonly id = nextSessionId++;
  readonly secret = crypto.randomInt(1, 2 ** 31);
  socket: net.Socket;
  readonly decoder = new FrontendDecoder();
  phase: "startup" | "password" | "ready" | "closed" = "startup";
  user = "";
  token: PgToken | null = null;
  presented: string | null = null;
  /** when the user was last found live (a user's session is asked again, `recheckMs`) */
  verifiedAt = 0;
  vars: Vars = defaultVars();
  tx: TxState = "none";
  /** the instant the transaction began (Postgres's `now()`), null between transactions */
  txNow: number | null = null;
  /** the instant of the statement being run (`statement_timestamp()`): its Query's arrival or its Bind */
  statementNow = 0;
  statements = new Map<string, Statement>();
  portals = new Map<string, Portal>();
  /** after an error in the extended protocol: every message until Sync is dropped */
  skipToSync = false;
  /** the query running now, for a CancelRequest and the socket closing */
  running: AbortController | null = null;
  /** this session's DuckDB connection, opened at its first statement over a table */
  private duckRunner: DuckRunner | null = null;

  /** Closes the session's DuckDB connection, when it has one: only ever with no statement running on it (`end`, `settled`). */
  private closeRunner(): void {
    if (this.duckRunner === null) return;
    const runner = this.duckRunner;
    this.duckRunner = null;
    runner.close().catch((e: unknown) => { this.server.log(`session ${this.id}: closing its DuckDB connection failed: ${e instanceof Error ? e.message : String(e)}`); });
  }

  /** A statement ended, however: the session's next one may run, and a session closed meanwhile closes its connection now. */
  private settled(): void {
    this.running = null;
    if (this.phase === "closed") this.closeRunner();
  }
  /** THE STATEMENT BEING ASKED, for the request log (`recordRequest`): set as each message arrives, its
   *  text narrowed to one statement of a simple Query as each is run */
  private asked: { sql: string; method: string; startedAt: number; jsonReads?: readonly string[] } | null = null;
  /** messages are handled one at a time, in order: a parse is asynchronous */
  private draining = false;
  /** the connection's first bytes have been read, and told a TLS ClientHello from a startup packet */
  private sniffed = false;
  private closedBy: string | null = null;

  private readonly server: Server;

  constructor(socket: net.Socket, server: Server) {
    this.server = server;
    this.socket = socket;
    this.attach(socket);
  }

  private attach(socket: net.Socket): void {
    socket.on("data", (chunk: Buffer) => {
      // the connection's first byte says how it starts: a TLS ClientHello is TLS at once (`directTls`), anything else
      // the protocol's startup phase, SSLRequest included
      if (!this.sniffed) { this.sniffed = true; if (chunk[0] === TLS_HANDSHAKE) { this.directTls(chunk); return; } }
      this.decoder.push(chunk); void this.drain();
    });
    socket.on("error", (err: Error) => { this.server.log(`session ${this.id}: socket error: ${err.message}`); this.end("socket error"); });
    socket.on("close", () => this.end("closed by the client"));
  }

  send(...parts: Buffer[]): void { this.sendAll(parts); }

  /** the frames as one write; an answer's rows are many (150,000 spread into a call's arguments overflow the stack) */
  sendAll(parts: readonly Buffer[]): void {
    if (this.phase === "closed") return;
    this.socket.write(Buffer.concat(parts));
  }

  end(why: string): void {
    if (this.phase === "closed") return;
    const wasReady = this.phase === "ready";
    this.phase = "closed";
    this.closedBy = why;
    if (wasReady) this.server.log(`session ${this.id} closed: ${why}`);
    this.running?.abort();
    this.socket.destroy();
    this.server.forget(this);
    this.dropPortals();
    // its DuckDB connection: closed now when no statement runs on it, else by `settled` once the interrupted statement
    // has ended (the test server: a close under a running statement that calls a JavaScript scalar function
    // hung the process for good — the close waits for the executor, and the executor waits for the main thread to run
    // the function; tests/duck-wire.test.ts "a client leaving mid-statement")
    if (this.running === null) this.closeRunner();
    // the sidecar's statements of this session, if any: closed so nothing of a gone session stays there
    const held = [...this.statements.values()].filter((s) => s.catalogName !== null).map((s) => s.catalogName!);
    if (held.length) {
      void this.server.catalog.run(Buffer.concat([...held.map((n) => frame("C", Buffer.from("S"), cstr(n))), frame("S")])).catch((e: unknown) => {
        this.server.log(`session ${this.id}: closing its ${held.length} catalog statement(s) failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
  }

  /** the connection's end as the log sees it */
  get closeReason(): string | null { return this.closedBy; }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.phase !== "closed") {
        let m: FrontendMessage | null;
        try { m = this.decoder.next(); } catch (err) {
          const e = asPgError(err, "");
          this.send(errorResponse({ ...e.fields, severity: "FATAL" }));
          this.end(`protocol error: ${e.message}`);
          return;
        }
        if (m === null) return;
        try {
          await this.handle(m);
        } catch (err) {
          // nothing below may reject (each handler answers its own errors); one that does would be an unhandled
          // rejection, which exits the API (review of #480) — it ends THIS session instead, FATAL, with the reason
          const e = asPgError(err, "");
          this.server.log(`session ${this.id}: ${e.message}`);
          this.send(errorResponse({ ...e.fields, severity: "FATAL" }));
          this.end(`internal error: ${e.message}`);
          return;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async handle(m: FrontendMessage): Promise<void> {
    if (this.phase === "startup") return this.startup(m);
    if (this.phase === "password") return this.password(m);
    if (this.server.options.trace === true && (m.type === "Query" || m.type === "Parse")) {
      this.server.log(`trace ${this.id} ${JSON.stringify(this.vars.applicationName)} ${m.type}: ${JSON.stringify(m.sql)}`);
    }
    if (m.type === "Query" || m.type === "Parse" || m.type === "Bind" || m.type === "Describe" || m.type === "Execute") {
      this.asked = { sql: m.type === "Query" || m.type === "Parse" ? m.sql : this.sqlOf(m), method: m.type.toUpperCase(), startedAt: Date.now() };
    }
    // EVERY statement of a user's session is held to its removal (review of #507: a check inside the answer let a pool's
    // keep-alive, its catalog reads, SET and SHOW go on for ever after a revocation)
    if ((m.type === "Query" || m.type === "Parse" || m.type === "Execute") && !(m.type !== "Query" && this.skipToSync)) {
      const refused = await this.stillLive(m.type);
      if (this.phase === "closed") return;
      if (refused !== null) {
        this.refuse(refused, m.type === "Execute" ? this.sqlOf(m) : m.sql);
        if (this.tx === "open") this.tx = "failed";
        if (m.type === "Query") this.send(readyForQuery(this.txStatus()));
        else this.skipToSync = true;
        return;
      }
    }
    switch (m.type) {
      case "Query": return this.simpleQuery(m.sql);
      case "Parse": case "Bind": case "Describe": case "Execute": case "Close": case "Sync": case "Flush": return this.extended(m);
      case "Terminate": this.end("terminated by the client"); return;
      case "Password": case "Startup": case "SSLRequest": case "GSSENCRequest": case "CancelRequest":
        this.fatal("08P01", `a ${m.type} message after the session started`);
        return;
      case "Unknown":
        this.fatal("08P01", `unsupported frontend message type '${m.code}' (a FunctionCall or COPY message): this API answers the simple and extended query protocols only`);
        return;
    }
  }

  private fatal(code: string, message: string, hint?: string): void {
    this.send(errorResponse({ severity: "FATAL", code, message, hint }));
    this.end(`fatal: ${message}`);
  }

  // ---------------------------------------------------------------- startup

  private startup(m: FrontendMessage): void {
    switch (m.type) {
      case "SSLRequest": {
        if (this.server.tls === null) { this.send(sslResponse(false)); return; }
        this.send(sslResponse(true));
        this.startTls(this.server.tls, null);
        return;
      }
      case "GSSENCRequest": this.send(sslResponse(false)); return;
      case "CancelRequest": {
        this.server.cancel(m.pid, m.secret);
        this.end("cancel request");
        return;
      }
      case "Startup": {
        if (m.major !== 3 || m.minor !== 0) { this.fatal("0A000", `unsupported frontend protocol ${m.major}.${m.minor}: server supports 3.0`); return; }
        if (this.server.tls !== null && !(this.socket instanceof tls.TLSSocket)) {
          this.fatal("28000", "this server requires TLS: the password must not travel in clear (connect with sslmode=require)");
          return;
        }
        const user = m.params.user;
        if (user === undefined || user === "") { this.fatal("28000", "no PostgreSQL user name specified in startup packet"); return; }
        this.user = user;
        const database = m.params.database ?? user;
        if (database !== this.server.database) {
          this.fatal("3D000", `database "${database}" does not exist`, `this Mason serves the project "${this.server.database}": connect with database=${this.server.database}`);
          return;
        }
        const encoding = m.params.client_encoding;
        if (encoding !== undefined && !isUtf8(encoding)) { this.fatal("22023", `client_encoding ${encoding} is not supported: this API sends UTF8 only`); return; }
        if (m.params.application_name !== undefined) this.vars.applicationName = m.params.application_name;
        try {
          if (m.params.options !== undefined) this.commandLineOptions(m.params.options);
          for (const [k, v] of Object.entries(m.params)) {
            if (["user", "database", "client_encoding", "application_name", "options", "replication"].includes(k)) continue;
            if (k === "replication") continue;
            this.setParameter(k.toLowerCase(), v, true);
          }
        } catch (err) {
          const e = asPgError(err, "");
          this.fatal(e.fields.code, e.message, e.fields.hint);
          return;
        }
        this.phase = "password";
        this.send(authenticationCleartextPassword());
        return;
      }
      default:
        this.fatal("08P01", `expected a startup message, got ${m.type}`);
    }
  }

  /**
   * TLS over this connection's socket, from its next byte: after SSLRequest's `S` (`early` null), or at once for a
   * connection whose first bytes were a ClientHello (`early`: those bytes, handed back to the socket WHOLE — a TLSSocket
   * reads what its socket holds before its handle, so the handshake sees every byte the client sent). ALPN `postgresql`
   * as Postgres 17 offers it: libpq's `sslnegotiation=direct` requires the server to choose it.
   */
  private startTls(context: tls.SecureContext, early: Buffer | null): void {
    const plain = this.socket;
    plain.removeAllListeners("data");
    plain.removeAllListeners("close");
    plain.removeAllListeners("error");
    if (early !== null) { plain.pause(); plain.unshift(early); }
    const secure = new tls.TLSSocket(plain, { isServer: true, secureContext: context, ALPNProtocols: ["postgresql"] });
    this.socket = secure;
    this.decoder.expectStartup();
    this.attach(secure);
  }

  /**
   * A DIRECT TLS START: a client that opens with a TLS ClientHello instead of SSLRequest — Postgres 17's
   * `sslnegotiation=direct`, or a platform's generic TLS terminator re-encrypting to the listener — is TLS at once, and
   * its startup packet comes inside. A plain listener cannot answer one on the wire (the client waits for a TLS record,
   * and this listener has no certificate to send), so it is refused in the log, naming the way out, and closed.
   */
  private directTls(first: Buffer): void {
    if (this.server.tls === null) {
      this.server.log(`session ${this.id} refused: a direct TLS start (a TLS ClientHello as its first bytes: sslnegotiation=direct, or a TLS ` +
        `terminator re-encrypting to Mason) on a plain listener — set MASON_PG_TLS_CERT and MASON_PG_TLS_KEY to serve TLS, or terminate TLS ` +
        `in front and send Mason the plain protocol (docs/POSTGRES-API.md "Connecting")`);
      this.end("a direct TLS start on a plain listener");
      return;
    }
    this.startTls(this.server.tls, first);
  }

  /** libpq's `options=-c name=value …` (JDBC's `options`): each a SET before the session starts */
  private commandLineOptions(options: string): void {
    const re = /(?:--|-c\s+)([A-Za-z_][A-Za-z0-9_.]*)=(\S+)/g;
    let m: RegExpExecArray | null;
    let any = false;
    while ((m = re.exec(options)) !== null) { any = true; this.setParameter(m[1]!.toLowerCase(), m[2]!.replaceAll("\\ ", " "), true); }
    if (!any && options.trim() !== "") throw new PgError({ code: "0A000", message: `startup options ${JSON.stringify(options)}: only -c name=value is supported` });
  }

  private async password(m: FrontendMessage): Promise<void> {
    if (m.type !== "Password") { this.fatal("08P01", `expected a password message, got ${m.type}`); return; }
    let token: PgToken;
    try {
      token = await this.server.options.authenticate(m.password, this.user);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // a revocation record that could not be read is no wrong password: the server could not tell, said as such
      const unknown = err instanceof ApiError && err.status === 503;
      const refused = new PgError({ code: unknown ? "57P03" : "28P01",
        message: unknown ? `the password could not be checked for user "${this.user}": ${message}` : `password authentication failed for user "${this.user}": ${message}`,
        hint: unknown ? "connect again once Mason can read its list of users"
          : "a tool that keeps one password connects as a user: mason user add <name> prints its password and URL" }, 401);
      // a tool that cannot connect is the first thing to look for in the request log
      this.asked = { sql: "", method: "CONNECT", startedAt: Date.now() };
      this.recordRequest(refused, undefined, err instanceof ApiError ? err.userName : undefined);
      this.send(errorResponse({ ...refused.fields, severity: "FATAL" }));
      this.end("authentication failed");
      return;
    }
    if (this.phase !== "password") return;   // the socket closed while the ledger was read
    this.token = token;
    this.presented = m.password;
    this.verifiedAt = this.server.now();
    this.phase = "ready";
    this.decoder.maxLength = MAX_MESSAGE_LENGTH;   // authenticated: a statement may be as long as the protocol allows
    // what is happening, as it happens (mason logs once showed little): who connected, and (end) who left
    this.server.log(`session ${this.id} connected: ${this.vars.applicationName === "" ? "a client with no application_name" : JSON.stringify(this.vars.applicationName)} as ${JSON.stringify(this.user)}` +
      (token.user !== undefined ? " (a mason user)" : ""));
    const status: Buffer[] = [authenticationOk()];
    for (const [name, value] of this.reportedParameters()) status.push(parameterStatus(name, value));
    status.push(backendKeyData(this.id, this.secret), readyForQuery("I"));
    this.sendAll(status);
  }

  private reportedParameters(): Array<[string, string]> {
    return [
      ["application_name", this.vars.applicationName], ["client_encoding", "UTF8"], ["DateStyle", "ISO, MDY"],
      ["default_transaction_read_only", "on"], ["in_hot_standby", "on"], ["integer_datetimes", "on"], ["IntervalStyle", "postgres"],
      ["is_superuser", "off"], ["search_path", this.vars.searchPath], ["server_encoding", "UTF8"], ["server_version", SERVER_VERSION],
      ["session_authorization", this.user], ["standard_conforming_strings", "on"], ["TimeZone", this.vars.timeZone],
    ];
  }

  // ---------------------------------------------------------------- session parameters

  /**
   * SET of one parameter. Returns the ParameterStatus to send when it is one Postgres reports. The parameters this
   * server has an opinion on are decided here; the rest go to the catalog Postgres for validation and are kept.
   */
  private setParameter(name: string, value: string | null, atStartup = false): Buffer[] {
    const report = (n: string, v: string): Buffer[] => REPORTED.has(n) ? [parameterStatus(spell(n), v)] : [];
    switch (name) {
      case "timezone": case "time zone": {
        const zone = value === null || /^(default|local|localtime)$/i.test(value) ? "UTC" : canonicalZone(value);
        if (zone === null) throw new PgError({ code: "22023", message: `invalid value for parameter "TimeZone": "${value}"`, hint: "an IANA zone name (Europe/London) or UTC: this API knows no abbreviation or fixed offset" });
        this.vars.timeZone = zone;
        return report("timezone", zone);
      }
      case "application_name": this.vars.applicationName = value ?? ""; return report(name, this.vars.applicationName);
      case "search_path": this.vars.searchPath = value ?? '"$user", public'; return report(name, this.vars.searchPath);
      case "client_encoding": case "names":
        if (value !== null && !isUtf8(value)) throw new PgError({ code: "22023", message: `invalid value for parameter "client_encoding": "${value}"`, hint: "this API sends UTF8 only" });
        return report("client_encoding", "UTF8");
      case "datestyle":
        if (value !== null && !/^\s*iso\b/i.test(value) && !/,\s*iso\s*$/i.test(value) && value.trim() !== "") {
          throw new PgError({ code: "0A000", message: `DateStyle ${value} is not supported: this API writes every date and time in ISO 8601 (DateStyle ISO)` });
        }
        return report("datestyle", "ISO, MDY");
      case "extra_float_digits": {
        const n = value === null ? 1 : Number(value);
        if (!Number.isInteger(n) || n < -15 || n > 3) throw new PgError({ code: "22023", message: `${n} is outside the valid range for parameter "extra_float_digits" (-15 .. 3)` });
        if (n < 1) throw new PgError({ code: "0A000", message: `extra_float_digits ${n} is not supported: this API sends every float as the shortest text that reads back exactly (Postgres's extra_float_digits >= 1, the default since Postgres 12); fewer digits would be a different number` });
        return [];
      }
      case "standard_conforming_strings":
        if (value !== null && !/^(on|true|yes|1)$/i.test(value)) throw new PgError({ code: "0A000", message: "standard_conforming_strings off is not supported: a string literal is read as Postgres reads it by default" });
        return report(name, "on");
      case "intervalstyle": return report(name, "postgres");
      case "transaction_isolation": case "default_transaction_isolation": case "transaction": case "session characteristics":
        // read committed on a store that is never written: every level answers the same rows
        return [];
      case "default_transaction_read_only": case "transaction_read_only":
        if (value !== null && /^(off|false|no|0)$/i.test(value)) throw new PgError({ code: "25006", message: "cannot set transaction read-write mode: this API is read-only" });
        return report(name, "on");
      case "statement_timeout": case "lock_timeout": case "idle_in_transaction_session_timeout": case "idle_session_timeout":
      case "transaction_timeout": case "client_min_messages": case "log_min_messages": case "bytea_output":
      case "default_transaction_deferrable": case "xmloption": case "backslash_quote": case "escape_string_warning":
      case "synchronize_seqscans": case "work_mem": case "max_parallel_workers_per_gather": case "jit": case "row_security":
      case "lc_messages": case "lc_monetary": case "lc_numeric": case "lc_time": case "check_function_bodies":
        // accepted and remembered; none changes an answer (statement_timeout is honoured, armTimeout: it may only shorten
        // the run's own limit, MASON_STATEMENT_TIMEOUT)
        if (value === null) this.vars.other.delete(name); else this.vars.other.set(name, value);
        return [];
      default: {
        // a parameter Mason knows nothing of: the catalog Postgres decides whether it exists
        if (atStartup) throw new PgError({ code: "42704", message: `unrecognized configuration parameter "${name}" in the startup packet` });
        if (value === null) this.vars.other.delete(name); else this.vars.other.set(name, value);
        return [];
      }
    }
  }

  /** The catalog Postgres validates a parameter this server has no opinion on; its own error is the answer. Inside a
   *  transaction that is ROLLED BACK: the sidecar is one connection every session shares, and a SET that stuck there
   *  was every session's (review of #480). The value itself lives in this session's `vars.other`. */
  private async validateElsewhere(name: string, value: string | null): Promise<void> {
    const sql = value === null ? `RESET ${quoteIdent(name)}` : `SET LOCAL ${quoteIdent(name)} = ${quoteLiteral(value)}`;
    // one batch, so no other session's statement lands inside the transaction: the ROLLBACK in the first query is not
    // reached when the SET fails (an error ends a simple query's string), so a second query rolls back for that case
    // (a WARNING "no transaction in progress" when the first one did, never an error)
    const reply = splitFrames(await this.server.catalog.run(Buffer.concat([frame("Q", cstr(`BEGIN; ${sql}; ROLLBACK`)), frame("Q", cstr("ROLLBACK"))])));
    const err = reply.find((f) => f.type === "E");
    if (err !== undefined) throw relayedError(err.frame);
  }

  // ---------------------------------------------------------------- the simple protocol

  private async simpleQuery(sql: string): Promise<void> {
    // the Query's arrival is its statements' instant, and the start of the implicit transaction they run in
    this.statementNow = this.server.now();
    try {
      await this.simpleStatements(sql);
    } finally {
      if (this.tx === "none") this.txNow = null;
    }
  }

  /** the transaction's "now", the transaction begun at `statementNow` when none is open */
  private txStart(statementNow: number): number {
    this.txNow ??= statementNow;
    return this.txNow;
  }

  private async simpleStatements(sql: string): Promise<void> {
    let stmts: RawStmt[];
    try {
      stmts = (await parseSql(sql)).stmts ?? [];
    } catch (err) {
      const e = asPgError(err, sql);
      this.refuse(e, sql);
      if (this.tx === "open") this.tx = "failed";
      this.send(readyForQuery(this.txStatus()));
      return;
    }
    if (stmts.length === 0) { this.send(emptyQueryResponse(), readyForQuery(this.txStatus())); return; }
    for (const raw of stmts) {
      const text = statementText(sql, raw);
      this.asked = { sql: text, method: "QUERY", startedAt: Date.now() };
      try {
        const out = await this.runSimple(raw, text, sql);
        this.sendAll(out);
      } catch (err) {
        const e = asPgError(err, sql);
        this.refuse(e, text);
        if (this.tx === "open") this.tx = "failed";
        break;
      }
    }
    this.send(readyForQuery(this.txStatus()));
  }

  /**
   * EVERY STATEMENT'S ErrorResponse goes out here, and is logged here at the normal level (a BI tool met an
   * error on the test server and the log said only that its session connected and closed — the one refusal line was the trace's).
   * One line, `session <id> refused: <SQLSTATE> <message> — <sql>` (`failed` for Mason's own failure, `refusalLine`),
   * so `mason logs` answers "why did my query fail"; the trace adds its own line beside it. A FATAL that ends the session
   * is said by its close (`end`), not here; tests/postgres-api/server.test.ts holds this to being the only other sender.
   */
  private refuse(e: PgError, sql: string, at?: string): void {
    this.server.log(refusalLine(this.id, e.fields, sql));
    this.recordRequest(e, sql);
    this.traceRefusal(e, at);
    this.send(errorResponse(e.fields));
  }

  private traceRefusal(e: PgError, at?: string): void {
    if (this.server.options.trace !== true) return;
    this.server.log(`trace ${this.id} refused${at === undefined ? "" : ` at ${at}`}: ${e.fields.code} ${JSON.stringify(e.fields.message)}`);
  }
  /**
   * THE REQUEST LOG (src/duck/requests.ts; a BI tool met an error on the test server and nothing could be found
   * afterwards): a row for every statement DuckDB answered — its rows sent, its time from arrival to the last row — for
   * every refused or failed statement, with its SQLSTATE, message, DETAIL and HINT (from `refuse`, the one place a
   * statement's ErrorResponse goes out), and for a refused password (CONNECT), through `options.record`. A catalog
   * read, a SET or a SHOW answered is the protocol's chatter, not recorded. Never throws: `record` buffers.
   */
  private recordRequest(answer: PgError | { rows: number; startedAt?: number }, sql?: string, refusedUser?: string,
    of?: { method: string; jsonReads: readonly string[] | undefined }): void {
    // `of`: a statement recorded after its own messages (a portal dropped suspended), not the one being asked now
    const asked = of === undefined ? this.asked : { sql: sql ?? "", method: of.method, startedAt: Date.now(), ...(of.jsonReads !== undefined ? { jsonReads: of.jsonReads } : {}) };
    const startedAt = (!(answer instanceof PgError) ? answer.startedAt : undefined) ?? asked?.startedAt ?? Date.now();
    // a refusal's statement is the one refuse() names (a simple Query's own statement, an Execute's portal's)
    const stored = storedPayload(sql ?? asked?.sql ?? "");
    const user = this.token?.user ?? refusedUser;
    this.server.options.record({
      requestId: crypto.randomUUID(), at: new Date(startedAt), method: asked?.method ?? "QUERY", durationMs: Date.now() - startedAt,
      client: `postgres:${this.vars.applicationName || "unnamed"}`, session: this.id, payload: stored.text, payloadTruncated: stored.truncated,
      caller: hashCaller(this.presented),
      ...(user !== undefined ? { user } : {}),
      ...(asked?.jsonReads !== undefined && asked.jsonReads.length > 0 ? { jsonReads: asked.jsonReads } : {}),
      ...(answer instanceof PgError
        ? { status: answer.status, sqlstate: answer.fields.code, error: answer.fields.message,
            ...(answer.fields.detail ? { detail: answer.fields.detail } : {}), ...(answer.fields.hint ? { hint: answer.fields.hint } : {}) }
        : { status: 200, rows: answer.rows }),
    });
  }


  private txStatus(): "I" | "T" | "E" { return this.tx === "none" ? "I" : this.tx === "open" ? "T" : "E"; }

  /** A statement classified (translate.ts `duckTranslate`), the catalog replaced first when the copied tables changed
   *  (`Server.schema`), so the plan made next is made over them. */
  private classify(stmt: NonNullable<RawStmt["stmt"]>, text: string): AnyTranslation {
    this.server.schema();
    return duckTranslate(stmt, text);
  }

  /** One statement of a simple query: the whole reply but the ReadyForQuery. */
  private async runSimple(raw: RawStmt, text: string, whole: string): Promise<Buffer[]> {
    if (raw.stmt === undefined) return [emptyQueryResponse()];
    const now = this.txStart(this.statementNow);
    const t = this.classify(raw.stmt, text);
    if (this.tx === "failed" && !(t.kind === "transaction" && t.tag !== "BEGIN" && t.tag !== "START TRANSACTION")) {
      throw new PgError({ code: "25P02", message: "current transaction is aborted, commands ignored until end of transaction block" });
    }
    switch (t.kind) {
      case "empty": return [emptyQueryResponse()];
      case "explain": {
        const e = await this.explaining(raw, whole, t, []);
        if (e.plan === null) return catalogExplained(await this.forwardSimple(text), e.options);
        const controller = new AbortController();
        const disarm = this.armTimeout(controller);
        try {
          const { field, rows } = await this.duckExplain({ options: e.options, plan: e.plan }, [], [], { parse: now, exec: now }, controller);
          this.recordRequest({ rows: rows.length });
          return [rowDescription([field]), ...rows, commandComplete("EXPLAIN")];
        } finally { disarm(); }
      }
      case "catalog": return this.forwardSimple(text);
      case "set": return this.setStatement(t);
      case "show": return this.showStatement(t.name);
      case "transaction": return [...this.transaction(t.tag)];
      case "discard": this.statements.clear(); this.dropPortals(); this.vars = { ...defaultVars(), applicationName: this.vars.applicationName }; return [commandComplete("DISCARD ALL")];
      case "deallocate": this.statements.clear(); return [commandComplete("DEALLOCATE ALL")];
      case "duckdb": {
        const plan = await this.duckPlan(raw, whole, []);
        // a simple Query's statement is parsed and run at once, in the transaction its arrival began (or the open one)
        const controller = new AbortController();
        const disarm = this.armTimeout(controller);
        try {
          const { fields, cursor } = await this.duckAnswer(plan, [], [], { parse: now, exec: now }, controller);
          try {
            this.send(rowDescription(fields));
            await this.streamRest(cursor);
          } finally { cursor.answer.close(); }
          this.recordRequest({ rows: cursor.sent });
          return [commandComplete(`SELECT ${cursor.sent}`)];
        } finally { disarm(); }
      }
    }
  }

  /** A DuckDB statement's plan (Postgres's analysis and the DuckDB SQL), kept per text, search_path, TimeZone and
   *  declared parameter types until the schema changes. Every statement DuckDB runs has one: never its text as written. */
  private async duckPlan(raw: RawStmt, whole: string, paramOids: readonly number[], under: { searchPath: string; timeZone: string } = this.vars, wireBound = false): Promise<DuckPlan> {
    const stmt = raw.stmt!;
    const bytes = Buffer.from(whole, "utf8");
    const base = raw.stmt_location ?? 0;
    const text = bytes.subarray(base, raw.stmt_len ? base + raw.stmt_len : bytes.length).toString("utf8");
    const { searchPath, timeZone } = under;
    return this.server.duckPlan(text, paramOids, searchPath, timeZone, wireBound, () =>
      this.server.options.duck.plan((b) => this.server.catalog.run(b), text, stmt, base, paramOids, searchPath, timeZone, this.server.userTypes(), wireBound));
  }

  /**
   * A ROW COUNT ON THE WIRE IS A BOUND THE PLAN AT PARSE COULD NOT SEE (docs/DESIGN.md "A LEFT lateral of a list"): an
   * Execute's row count (JDBC's setMaxRows or fetch size, DBeaver's, a native question's) arrives after the Parse, so a
   * LEFT lateral of a list with no LIMIT in its SQL was left DuckDB's delimiter join, which reads the whole base before
   * the first row and hands its rows back in its own order — the first rows sent were not Postgres's. Where the plan
   * says such a lateral was left so (PlannedSql.unboundedLateral), the statement is planned again with the bound
   * asserted, under the search_path and TimeZone of its Parse, kept on the statement and in the plans by text. The
   * portal's result is begun ONCE, from whichever plan its first Execute picked; an Execute after a PortalSuspended
   * reads on from that result, never runs it again. A plan made again over a schema moved since the Parse, whose
   * result or parameters are not the ones the Parse described, is not run: the Parse's plan is (what a client was told
   * of the result stands). Planning again is the statement's own time: a CancelRequest landing meanwhile aborts its
   * controller (`running`, answered 57014 as the statement begins), and a session closed meanwhile runs nothing. A
   * plan made again that Postgres or the rewrite refuses (a StatementError, never a cancel's or a timeout's 57014) is
   * logged and the Parse's plan runs, kept: the Parse answered, and a row count must not make it fail.
   */
  private async boundOnWire(statement: Statement, plan: DuckPlan, controller: AbortController): Promise<DuckPlan> {
    if (plan.sql.unboundedLateral !== true || statement.raw === null) return plan;
    if (statement.duckOnWire === undefined) {
      this.running = controller;
      let bounded: DuckPlan;
      try { bounded = await this.duckPlan(statement.raw, statement.sql, statement.paramOids, statement.plannedUnder ?? this.vars, true); }
      catch (e) {
        if (!(e instanceof StatementError) || e.fields.code === "57014") throw e;
        this.server.log(`session ${this.id}: a statement planned again for an Execute's row count was refused (${e.fields.code}: ${e.fields.message}): its Parse's plan runs`);
        bounded = plan;
      }
      finally { this.settled(); }
      const shape = (p: DuckPlan): string => JSON.stringify([p.params, p.fields?.map((f) => [f.name, f.oid, f.typmod]) ?? null]);
      statement.duckOnWire = shape(bounded) === shape(plan) ? bounded : plan;
      if (statement.duckOnWire === plan && bounded !== plan) this.server.log(`session ${this.id}: a statement planned again for an Execute's row count answers other columns than its Parse said (the schema moved): its Parse's plan runs`);
    }
    if (this.phase === "closed") {
      this.server.log(`session ${this.id}: closed while its statement was planned again for an Execute's row count: it runs nothing`);
      throw new PgError({ code: "08006", message: "the session closed while its statement was planned" });
    }
    return statement.duckOnWire;
  }

  /**
   * AN EXPLAIN (src/api/postgres/explain.ts, src/duck/explain.ts): its options read as Postgres reads them, then the
   * statement it explains classified as that statement alone would be — refused with that statement's own error — and,
   * for DuckDB's, planned afresh (an ANALYZE's Planning Time is this one's), never from the plans kept per text.
   */
  private async explaining(raw: RawStmt, whole: string, t: ExplainTranslation, paramOids: readonly number[]): Promise<Explaining> {
    const options = explainOptions(t.options);
    const inner = this.classify(t.query, "");
    if (inner.kind === "catalog") return { options, plan: null };
    if (inner.kind !== "duckdb") throw new PgError({ code: "0A000", message: "EXPLAIN of this statement is not supported: a SELECT is explained" });
    const bytes = Buffer.from(whole, "utf8");
    const base = raw.stmt_location ?? 0;
    const text = bytes.subarray(base, raw.stmt_len ? base + raw.stmt_len : bytes.length).toString("utf8");
    const found = await explainedText(text, t.query);
    if (found === null) throw new PgError({ code: "0A000", message: "Mason cannot find the statement this EXPLAIN explains in its text (a Mason gap: report it, with the statement)" });
    let plan: DuckPlan;
    try {
      plan = await this.server.options.duck.plan((b) => this.server.catalog.run(b), found.text, t.query, base + Buffer.byteLength(text.slice(0, found.offset)), paramOids,
        this.vars.searchPath, this.vars.timeZone, this.server.userTypes());
    } catch (e) {
      // a refusal of the statement explained is placed as Postgres places it: in the whole text, past `EXPLAIN …`
      if (!(e instanceof StatementError) || e.fields.position === undefined) throw e;
      const before = bytes.subarray(0, base).toString("utf8").length + found.offset;
      throw new StatementError({ ...e.fields, position: e.fields.position + before }, whole);
    }
    return { options, plan };
  }

  /** an EXPLAIN of a DuckDB statement, run: its QUERY PLAN rows (ANALYZE runs the statement and sends none of its rows) */
  private async duckExplain(e: { options: ExplainOptions; plan: DuckPlan }, params: readonly (string | null)[], resultFormats: number[], clock: { parse: number; exec: number },
    controller: AbortController): Promise<{ field: FieldDescription; rows: Buffer[] }> {
    await this.readAside();
    const runner = await this.duck();
    this.running = controller;
    try {
      const values = await this.duckValues(e.plan, params, clock);
      const lines = await runner.explain(e.plan.sql, values, this.duckSession(), controller.signal,
        { options: e.options, fields: e.plan.fields, exact: e.plan.exact ?? [], planning: e.plan.timing ?? { analysisMs: 0, rewriteMs: 0 },
          // how each copy is kept current, as the sync says it to mason status, read now (src/duck/sync.ts KeptCurrent)
          copies: copyFacts(this.server.options.duck.copies?.() ?? []) });
      return { field: explainField(e.options, formatAt(resultFormats, 0)), rows: lines.map((l) => dataRow([Buffer.from(l)])) };
    } finally { this.settled(); }
  }

  /** a plan's parameter values as DuckDB reads them: the bound ones through Postgres's input functions, then the
   *  transaction's start where the plan reads it (its positions follow the statement's own parameters) */
  private async duckValues(plan: DuckPlan, params: readonly (string | null)[], clock: { parse: number; exec: number }): Promise<(string | null)[]> {
    const own = params.length === 0 ? params
      : await this.server.options.duck.parameters((b) => this.server.catalog.run(b), plan.params, params, this.vars.timeZone);
    const values = [...own];
    for (const [which, at] of Object.entries(plan.clock ?? {}) as Array<["parse" | "exec", number]>) values[at - 1] = new Date(clock[which]).toISOString();
    return values;
  }

  private async duck(): Promise<DuckRunner> {
    this.duckRunner ??= await this.server.options.duck.open();
    return this.duckRunner;
  }

  private duckSession(): { timeZone: string; searchPath: string } { return { timeZone: this.vars.timeZone, searchPath: this.vars.searchPath }; }

  /** A DuckDB statement run: its columns (Postgres's, where it has a plan), and its rows to read, encoded in the
   *  formats asked */
  private async duckAnswer(plan: DuckPlan, params: readonly (string | null)[], resultFormats: number[], clock: { parse: number; exec: number },
    controller: AbortController): Promise<{ fields: FieldDescription[]; cursor: DuckCursor }> {
    this.readsOf(plan);
    await this.readAside();
    const runner = await this.duck();
    this.running = controller;
    try {
      const values = await this.duckValues(plan, params, clock);
      const a = await runner.run(plan.sql, values, this.duckSession(), controller.signal, plan.fields, plan.exact ?? []);
      // a SELECT's analysis always has its RowDescription; without one, DuckDB's own columns are said as they are
      const fields = plan.fields !== null
        ? plan.fields.map((f, i) => ({ name: f.name, typeOid: a.columns[i]!.oid, typeSize: f.size, typeModifier: a.columns[i]!.oid === f.oid ? f.typmod : -1, format: formatAt(resultFormats, i) }))
        : a.columns.map((c, i) => ({ name: c.name, typeOid: c.oid, typeSize: c.size, typeModifier: -1, format: formatAt(resultFormats, i) }));
      return { fields, cursor: { answer: a, formats: resultFormats, controller, pending: [], sent: 0, done: false, startedAt: this.asked?.startedAt ?? Date.now() } };
    } finally { this.settled(); }
  }

  /**
   * THE STATEMENT'S TIME LIMIT, armed for one simple Query's statement or one Execute (as Postgres's statement_timeout
   * times each): the session's statement_timeout or the server's, the shorter. When it fires the statement's
   * controller is aborted with the timeout as its reason, so DuckDB is interrupted (or the wait for the client woken)
   * and the client is told 57014 "canceling statement due to statement timeout". Returns the disarm.
   */
  private armTimeout(controller: AbortController): () => void {
    const own = timeoutMs(this.vars.other.get("statement_timeout") ?? "0") ?? 0;
    const server = this.server.options.statementTimeoutMs ?? 0;
    const ms = [own, server].filter((x) => x > 0);
    if (ms.length === 0) return () => undefined;
    const limit = Math.min(...ms);
    const byServer = server > 0 && limit === server && !(own > 0 && own <= server);
    const t = setTimeout(() => controller.abort(new StatementError({ code: "57014", message: "canceling statement due to statement timeout",
      ...(byServer ? { hint: `Mason runs one statement for at most ${limit / 1000} s (MASON_STATEMENT_TIMEOUT): ask for less at once (a filter, a LIMIT, a coarser GROUP BY), or raise it and start mason again` } : {}) })), limit);
    return () => clearTimeout(t);
  }

  /** the next chunk of a cursor into its `pending` rows (none at its end, then `done`); a cancel interrupts it */
  private async fill(c: DuckCursor): Promise<void> {
    if (c.done) return;
    const mine = this.running === null;
    if (mine) this.running = c.controller;
    try {
      const rows = await c.answer.fetch(c.formats, { timeZone: this.vars.timeZone });
      if (rows === null) c.done = true;
      else for (const r of rows) c.pending.push(r);
    } catch (e) { c.done = true; throw e; }
    finally { if (mine) this.settled(); }
  }

  /** what is pending of a cursor, sent */
  private flushPending(c: DuckCursor): void {
    if (c.pending.length === 0) return;
    c.sent += c.pending.length;
    this.sendAll(c.pending);
    c.pending = [];
  }

  /**
   * EVERY ROW LEFT OF A CURSOR, WRITTEN AS IT IS READ, a chunk at a time: the next chunk is read only once the socket
   * has room (`writable`), so a client that reads slowly slows the reading and never fills this process's memory. A
   * session that ends meanwhile closes it.
   */
  private async streamRest(c: DuckCursor): Promise<void> {
    // a CancelRequest is the statement's until its last row is written, the waits for the client included (Postgres
    // cancels a backend blocked on its socket too)
    this.running = c.controller;
    try {
      for (;;) {
        this.flushPending(c);
        await this.writable(c.controller.signal);
        if (this.phase === "closed") { c.answer.close(); c.done = true; return; }
        if (c.done) return;
        await this.fill(c);
      }
    } finally { this.settled(); }
  }

  /** resolves once the socket can take more, is gone, or the statement is cancelled */
  private async writable(signal: AbortSignal): Promise<void> {
    if (this.phase === "closed" || !this.socket.writableNeedDrain || signal.aborted) return;
    const socket = this.socket;
    await new Promise<void>((resolve) => {
      const done = (): void => { socket.off("drain", done); socket.off("close", done); signal.removeEventListener("abort", done); resolve(); };
      socket.on("drain", done);
      socket.on("close", done);
      signal.addEventListener("abort", done);
    });
  }

  /**
   * DuckDB starts nothing on a connection whose streamed result is half read: before a statement, a portal suspended
   * part way (an Execute's row limit) is read to its end into its `pending` rows, and its failure kept for its next
   * Execute. Rare — one statement at a time is what clients do — and the one case that holds a whole result.
   */
  private async readAside(): Promise<void> {
    for (const p of this.portals.values()) {
      const c = p.cursor;
      if (c === undefined) continue;
      try { while (!c.done) await this.fill(c); }
      catch (e) { c.failed = e; }
    }
  }

  /**
   * A portal gone (Close, Sync, a Bind of its name, DISCARD, the session's end): its DuckDB result with it. One the
   * client stopped reading at a row count (an Execute's: JDBC's setMaxRows, `mason mcp`'s max_rows) was never read to
   * its end, so its row of the request log is written here, with the rows it sent: a statement answered is in the log
   * however far it was read.
   */
  private dropPortal(name: string): void {
    const portal = this.portals.get(name);
    const c = portal?.cursor;
    if (portal !== undefined && c !== undefined && c.suspended === true && c.recorded !== true && c.failed === undefined) {
      c.recorded = true;
      this.recordRequest({ rows: c.sent, startedAt: c.startedAt }, portal.statement.sql, undefined, { method: "EXECUTE", jsonReads: portal.statement.duck?.jsonReads });
    }
    c?.answer.close();
    this.portals.delete(name);
  }

  private dropPortals(): void { for (const name of [...this.portals.keys()]) this.dropPortal(name); }

  private async forwardSimple(text: string): Promise<Buffer[]> {
    const reply = splitFrames(await this.server.catalog.run(frame("Q", cstr(text))));
    const err = reply.find((f) => f.type === "E");
    if (err !== undefined) throw relayedError(err.frame);
    return reply.filter((f) => f.type !== "Z").map((f) => f.frame);
  }

  private async setStatement(t: Extract<Translation, { kind: "set" }>): Promise<Buffer[]> {
    if (t.name === "all") { this.vars = { ...defaultVars(), applicationName: this.vars.applicationName }; return [commandComplete("RESET")]; }
    const tag = t.value === null ? "RESET" : "SET";
    if (!this.decidesHere(t.name)) await this.validateElsewhere(t.name, t.value);
    const status = this.setParameter(t.name, t.value);
    return [...status, commandComplete(tag)];
  }

  private decidesHere(name: string): boolean {
    return ["timezone", "time zone", "application_name", "search_path", "client_encoding", "names", "datestyle", "extra_float_digits",
      "standard_conforming_strings", "intervalstyle", "transaction_isolation", "default_transaction_isolation", "transaction", "session characteristics",
      "default_transaction_read_only", "transaction_read_only"].includes(name);
  }

  private async showStatement(name: string): Promise<Buffer[]> {
    if (name === "all") throw new PgError({ code: "0A000", message: "SHOW ALL is not supported: SHOW one parameter" });
    const value = tlsParameters(this.socket instanceof tls.TLSSocket)[name] ?? fixedParameter(name, this.vars, this.user) ?? this.vars.other.get(name) ?? null;
    if (value === null) {
      const reply = splitFrames(await this.server.catalog.run(frame("Q", cstr(`SHOW ${quoteIdent(name)}`))));
      const err = reply.find((f) => f.type === "E");
      if (err !== undefined) throw relayedError(err.frame);
      return reply.filter((f) => f.type !== "Z").map((f) => f.frame);
    }
    return [rowDescription([fieldOf(spell(name), "text", 0)]), dataRow([Buffer.from(value, "utf8")]), commandComplete("SHOW")];
  }

  /** a SHOW's RowDescription, for a Describe: the frame its answer starts with (the column is named by the parameter) */
  private async showDescription(name: string): Promise<Buffer[]> {
    return (await this.showStatement(name)).filter((f) => f[0] === ROW_DESCRIPTION);
  }

  private transaction(tag: string): Buffer[] {
    if (tag === "BEGIN" || tag === "START TRANSACTION") {
      if (this.tx !== "none") return [noticeResponse({ severity: "WARNING", code: "25001", message: "there is already a transaction in progress" }), commandComplete(tag)];
      this.tx = "open";
      return [commandComplete(tag)];
    }
    if (this.tx === "none") { return [noticeResponse({ severity: "WARNING", code: "25P01", message: "there is no transaction in progress" }), commandComplete(tag)]; }
    const wasFailed = this.tx === "failed";
    this.tx = "none";
    // the transaction's "now" ends with it; a statement after it in the same Query begins the next at the Query's arrival
    this.txNow = null;
    return [commandComplete(tag === "COMMIT" && wasFailed ? "ROLLBACK" : tag)];
  }

  // ---------------------------------------------------------------- the extended protocol

  private async extended(m: Extract<FrontendMessage, { type: "Parse" | "Bind" | "Describe" | "Execute" | "Close" | "Sync" | "Flush" }>): Promise<void> {
    if (m.type === "Sync") {
      // the unnamed portal ends with the transaction, as Postgres's does (a catalog statement's holds nothing in the
      // sidecar: it was run and closed at its Bind)
      this.dropPortal("");
      this.skipToSync = false;
      // an implicit transaction ends at Sync; an open one keeps its "now"
      if (this.tx === "none") this.txNow = null;
      this.send(readyForQuery(this.txStatus()));
      return;
    }
    if (this.skipToSync || m.type === "Flush") return;
    // its statement, read as the message arrives: a portal dropped while it runs (the session ended under a cancelled
    // statement) leaves the refusal its statement, never ""
    const sql = m.type === "Parse" ? m.sql : this.sqlOf(m);
    try {
      switch (m.type) {
        case "Parse": return this.sendAll(await this.parseMessage(m));
        case "Bind": return this.sendAll(await this.bindMessage(m));
        case "Describe": return this.sendAll(await this.describeMessage(m));
        case "Execute": return this.sendAll(await this.executeMessage(m));
        case "Close": return this.sendAll(await this.closeMessage(m));
      }
    } catch (err) {
      const e = asPgError(err, sql);
      this.refuse(e, sql, m.type);
      this.skipToSync = true;
      if (this.tx === "open") this.tx = "failed";
    }
  }

  private sqlOf(m: Extract<FrontendMessage, { type: "Bind" | "Describe" | "Execute" | "Close" }>): string {
    if (m.type === "Bind") return this.statements.get(m.statement)?.sql ?? "";
    if (m.type === "Close") return "";
    if (m.type === "Execute") return this.portals.get(m.portal)?.statement.sql ?? "";
    return (m.kind === "S" ? this.statements.get(m.name)?.sql : this.portals.get(m.name)?.statement.sql) ?? "";
  }

  /** the sidecar's names for this session's statements and portals: unnamed ones get a name of their own, so two
   *  sessions' unnamed statements never meet in the one Postgres */
  private catalogName(kind: "S" | "P", name: string): string {
    return `${kind === "S" ? "s" : "p"}${this.id}${name === "" ? "" : `_${name}`}`;
  }

  /** runs frames in the sidecar; throws the first ErrorResponse; returns the rest, less ReadyForQuery */
  private async catalogRun(...parts: Buffer[]): Promise<Buffer[]> {
    const reply = splitFrames(await this.server.catalog.run(Buffer.concat(parts)));
    // the sidecar answered NOTHING to a batch: it is ignoring everything until a Sync (an earlier error nobody synced)
    // — a protocol state this server must never leave it in; said, never relayed as an empty answer
    if (reply.length === 0) throw new PgError({ code: "XX000", message: "the catalog Postgres answered nothing: report it (its extended-protocol state is out of step)" }, 500);
    const err = reply.find((f) => f.type === "E");
    if (err !== undefined) {
      // AFTER AN ERROR IN THE EXTENDED PROTOCOL POSTGRES IGNORES EVERY MESSAGE UNTIL A SYNC (ignore_till_sync), and the
      // sidecar is one connection every session shares: without this Sync one refused Parse silenced the catalog for
      // every session until a restart (review of #480). The Sync's own ReadyForQuery is consumed here.
      if (!parts.some((p) => p[0] === 0x53 /* S */)) await this.server.catalog.run(frame("S"));
      throw relayedError(err.frame);
    }
    return reply.filter((f) => f.type !== "Z").map((f) => f.frame);
  }

  private async parseMessage(m: Extract<FrontendMessage, { type: "Parse" }>): Promise<Buffer[]> {
    if (m.name !== "" && this.statements.has(m.name)) throw new PgError({ code: "42P05", message: `prepared statement "${m.name}" already exists` });
    const stmts = (await parseSql(m.sql)).stmts ?? [];
    if (stmts.length > 1) throw new PgError({ code: "42601", message: "cannot insert multiple commands into a prepared statement" });
    const raw = stmts[0] ?? null;
    const statement: Statement = { sql: m.sql, raw, paramOids: [...m.paramTypes], shape: null, catalogName: null };
    if (raw?.stmt !== undefined) {
      statement.shape = this.classify(raw.stmt, statementText(m.sql, raw));
      if (statement.shape.kind === "explain") {
        const e = await this.explaining(raw, m.sql, statement.shape, m.paramTypes);
        if (e.plan === null) statement.explainCatalog = e.options;
        else { statement.explain = { options: e.options, plan: e.plan }; statement.parsedNow = this.txNow ??= this.server.now(); }
      }
      // Postgres's analysis says the result's columns and the parameters' types, and DuckDB's SQL is made from it
      if (statement.shape.kind === "duckdb") {
        statement.duck = await this.duckPlan(raw, m.sql, m.paramTypes);
        statement.plannedUnder = { searchPath: this.vars.searchPath, timeZone: this.vars.timeZone };
        // the implicit transaction begins with the Parse, as Postgres's does (start_xact_command): its literals read it
        statement.parsedNow = this.txNow ??= this.server.now();
      }
      if (statement.shape.kind === "catalog" || statement.explainCatalog !== undefined) {
        statement.catalogName = this.catalogName("S", m.name);
        const own = this.statements.get(m.name);
        // the unnamed statement is replaced by a Parse; the sidecar's must be closed first
        const close = own?.catalogName !== null && own !== undefined ? [frame("C", Buffer.from("S"), cstr(own.catalogName))] : m.name === "" ? [frame("C", Buffer.from("S"), cstr(statement.catalogName))] : [];
        const reply = await this.catalogRun(...close, frame("P", cstr(statement.catalogName), cstr(m.sql), int16(m.paramTypes.length), ...m.paramTypes.map(int32)));
        this.statements.set(m.name, statement);
        // the CloseComplete of the close this server added is not the client's
        return reply.slice(close.length);
      }
    }
    this.statements.set(m.name, statement);
    return [parseComplete()];
  }

  private async bindMessage(m: Extract<FrontendMessage, { type: "Bind" }>): Promise<Buffer[]> {
    const statement = this.statements.get(m.statement);
    if (statement === undefined) throw new PgError({ code: "26000", message: `prepared statement "${m.statement}" does not exist` });
    if (m.portal !== "" && this.portals.has(m.portal)) throw new PgError({ code: "42P03", message: `cursor "${m.portal}" already exists` });
    if (statement.catalogName !== null) {
      // bound, described, run whole and closed in one call, Sync included (the Portal's `catalog`): nothing of this
      // session's is left open in the sidecar for another session's Sync to close
      const catalogName = this.catalogName("P", m.portal);
      const values = m.params.map((p) => p === null ? int32(-1) : Buffer.concat([int32(p.length), p]));
      const reply = await this.catalogRun(frame("B", cstr(catalogName), cstr(statement.catalogName), int16(m.paramFormats.length), ...m.paramFormats.map(int16),
        int16(m.params.length), ...values, int16(m.resultFormats.length), ...m.resultFormats.map(int16)),
        frame("D", Buffer.from("P"), cstr(catalogName)), frame("E", cstr(catalogName), int32(0)), frame("C", Buffer.from("P"), cstr(catalogName)), frame("S"));
      // BindComplete, RowDescription | NoData, DataRow…, CommandComplete | EmptyQueryResponse, CloseComplete
      const [bound, description] = [reply[0], reply[1]];
      const done = reply[reply.length - 2];
      if (bound?.[0] !== 0x32 || description === undefined || done === undefined || reply[reply.length - 1]?.[0] !== 0x33) {
        throw new PgError({ code: "XX000", message: `the catalog Postgres answered a portal out of step (${reply.map((f) => String.fromCharCode(f[0]!)).join("")}): report it` }, 500);
      }
      this.dropPortal(m.portal);
      const rows = reply.slice(2, -2);
      this.portals.set(m.portal, { statement, params: [], boundAt: this.server.now(), resultFormats: m.resultFormats, rows: null, sent: 0, fields: null,
        catalog: { description, rows: statement.explainCatalog === undefined ? rows : catalogExplained(rows, statement.explainCatalog), sent: 0, done } });
      return [bound];
    }
    const planned = statement.duck ?? statement.explain?.plan;
    const expected = planned !== undefined ? planned.params.length : 0;
    if (m.params.length !== expected) throw new PgError({ code: "08P01", message: `bind message supplies ${m.params.length} parameters, but prepared statement "${m.statement}" requires ${expected}` });
    const params = m.params.map((p, i) => {
      if (p === null) return null;
      const format = m.paramFormats.length === 0 ? 0 : m.paramFormats.length === 1 ? m.paramFormats[0]! : m.paramFormats[i] ?? 0;
      if (format === 0) return p.toString("utf8");
      const type = oidOf(statement.paramOids[i] ?? 0) ?? (planned !== undefined ? oidOf(planned.params[i] ?? 0) : undefined) ?? "text";
      return decodeBinaryParam(type, p, i);
    });
    // the Bind is the statement's instant, and begins the implicit transaction when none is open
    const boundAt = this.server.now();
    this.txNow ??= boundAt;
    this.dropPortal(m.portal);
    this.portals.set(m.portal, { statement, params, boundAt, resultFormats: m.resultFormats, rows: null, sent: 0, fields: null });
    return [bindComplete()];
  }

  private async describeMessage(m: Extract<FrontendMessage, { type: "Describe" }>): Promise<Buffer[]> {
    if (m.kind === "S") {
      const statement = this.statements.get(m.name);
      if (statement === undefined) throw new PgError({ code: "26000", message: `prepared statement "${m.name}" does not exist` });
      if (statement.catalogName !== null) return this.catalogRun(frame("D", Buffer.from("S"), cstr(statement.catalogName)));
      const shape = statement.shape;
      if (shape?.kind === "show") return [parameterDescription([]), ...await this.showDescription(shape.name)];
      if (statement.explain !== undefined) {
        const e = statement.explain;
        return [parameterDescription(e.plan.params.map((o, i) => { const given = statement.paramOids[i] ?? 0; return given !== 0 ? given : o; })), rowDescription([explainField(e.options, 0)])];
      }
      if (statement.duck !== undefined) {
        const d = statement.duck;
        const oids = d.params.map((o, i) => { const given = statement.paramOids[i] ?? 0; return given !== 0 ? given : o; });
        return [parameterDescription(oids), d.fields !== null && d.fields.length ? rowDescription(d.fields.map((c) => ({ name: c.name, typeOid: c.oid, typeSize: c.size, typeModifier: c.typmod, format: 0 }))) : noData()];
      }
      return [parameterDescription([]), noData()];
    }
    const portal = this.portals.get(m.name);
    if (portal === undefined) throw new PgError({ code: "34000", message: `portal "${m.name}" does not exist` });
    if (portal.catalog !== undefined) return [portal.catalog.description];
    const shape = portal.statement.shape;
    if (shape?.kind === "show") return this.showDescription(shape.name);
    if (portal.statement.explain !== undefined) return [rowDescription([explainField(portal.statement.explain.options, formatAt(portal.resultFormats, 0))])];
    const d = portal.statement.duck;
    if (d !== undefined) return [d.fields !== null && d.fields.length ? rowDescription(d.fields.map((c, i) => ({ name: c.name, typeOid: c.oid, typeSize: c.size, typeModifier: c.typmod, format: formatAt(portal.resultFormats, i) }))) : noData()];
    return [noData()];
  }

  private async executeMessage(m: Extract<FrontendMessage, { type: "Execute" }>): Promise<Buffer[]> {
    const portal = this.portals.get(m.portal);
    if (portal === undefined) throw new PgError({ code: "34000", message: `portal "${m.portal}" does not exist` });
    if (portal.catalog !== undefined) {
      const c = portal.catalog;
      const take = m.maxRows > 0 ? Math.min(m.maxRows, c.rows.length - c.sent) : c.rows.length - c.sent;
      const out = c.rows.slice(c.sent, c.sent + take);
      c.sent += take;
      return c.sent < c.rows.length ? [...out, portalSuspended()] : [...out, c.done];
    }
    const statement = portal.statement;
    if (statement.raw?.stmt === undefined) return [emptyQueryResponse()];
    const t = statement.shape ?? this.classify(statement.raw.stmt, statementText(statement.sql, statement.raw));
    if (this.tx === "failed" && !(t.kind === "transaction" && t.tag !== "BEGIN" && t.tag !== "START TRANSACTION")) {
      throw new PgError({ code: "25P02", message: "current transaction is aborted, commands ignored until end of transaction block" });
    }
    switch (t.kind) {
      case "empty": return [emptyQueryResponse()];
      case "catalog": throw new PgError({ code: "XX000", message: "a catalog statement bound as a query (Mason bug: report it)" }, 500);
      case "set": return this.setStatement(t);
      // as Postgres: the extended protocol's Execute sends the rows and the tag, the RowDescription is the Describe's
      case "show": return (await this.showStatement(t.name)).filter((f) => f[0] !== ROW_DESCRIPTION);
      case "transaction": return this.transaction(t.tag);
      case "discard": this.statements.clear(); this.dropPortals(); return [commandComplete("DISCARD ALL")];
      case "deallocate": this.statements.clear(); return [commandComplete("DEALLOCATE ALL")];
      case "duckdb": {
        const controller = portal.cursor?.controller ?? new AbortController();
        const disarm = this.armTimeout(controller);
        try { return await this.executeDuck(m, portal, statement, controller); }
        finally { disarm(); }
      }
      case "explain": {
        if (statement.explain === undefined) throw new PgError({ code: "XX000", message: "an EXPLAIN without its plan: report it (Mason's Postgres listener)" });
        if (portal.rows === null) {
          const controller = new AbortController();
          const disarm = this.armTimeout(controller);
          try {
            const exec = this.txNow ??= this.server.now();
            portal.rows = (await this.duckExplain(statement.explain, portal.params, portal.resultFormats, { parse: statement.parsedNow ?? exec, exec }, controller)).rows;
            portal.sent = 0;
          } finally { disarm(); }
        }
        const rows = portal.rows;
        const take = m.maxRows > 0 ? Math.min(m.maxRows, rows.length - portal.sent) : rows.length - portal.sent;
        const out = rows.slice(portal.sent, portal.sent + take);
        portal.sent += take;
        if (portal.sent < rows.length) return [...out, portalSuspended()];
        this.recordRequest({ rows: rows.length });
        return [...out, commandComplete("EXPLAIN")];
      }
    }
  }

  /** the statement being answered reads these JSON paths: its request log row says so, answered or failed */
  private readsOf(plan: DuckPlan): void {
    if (this.asked !== null && plan.jsonReads !== undefined) this.asked.jsonReads = plan.jsonReads;
  }

  /** an Execute of a DuckDB statement's portal: its cursor begun at the first, then paged or streamed */
  private async executeDuck(m: Extract<FrontendMessage, { type: "Execute" }>, portal: Portal, statement: Statement, controller: AbortController): Promise<Buffer[]> {
    // each Execute of a paged portal is a message of its own: the last one's row in the request log carries the reads
    if (statement.duck !== undefined) this.readsOf(statement.duck);
    if (portal.cursor === undefined) {
      if (statement.duck === undefined) throw new PgError({ code: "XX000", message: "a DuckDB statement without its plan: report it (Mason's Postgres listener)" });
      // a row count on the wire bounds the rows: the plan made for it where it differs (boundOnWire)
      const plan = m.maxRows > 0 ? await this.boundOnWire(statement, statement.duck, controller) : statement.duck;
      const exec = this.txNow ??= this.server.now();
      const answer = await this.duckAnswer(plan, portal.params, portal.resultFormats, { parse: statement.parsedNow ?? exec, exec }, controller);
      portal.cursor = answer.cursor;
      portal.fields = answer.fields;
    }
    const c = portal.cursor;
    if (c.failed !== undefined) throw c.failed;
    c.suspended = false;
    try {
      // every row: streamed
      if (m.maxRows <= 0) {
        try { await this.streamRest(c); } finally { c.answer.close(); }
        c.recorded = true;
        this.recordRequest({ rows: c.sent, startedAt: c.startedAt });
        return [commandComplete(`SELECT ${c.sent}`)];
      }
      // at most maxRows (JDBC's fetch size, a cursor): suspended while a row is left, read one chunk ahead to know it
      while (!c.done && c.pending.length <= m.maxRows) await this.fill(c);
      const out = c.pending.splice(0, m.maxRows);
      c.sent += out.length;
      // suspended: its row is written at its last Execute, or when it is dropped (dropPortal)
      if (c.pending.length > 0) { c.suspended = true; return [...out, portalSuspended()]; }
      c.answer.close();
      c.recorded = true;
      this.recordRequest({ rows: c.sent, startedAt: c.startedAt });
      return [...out, commandComplete(`SELECT ${c.sent}`)];
    } catch (e) {
      // its refusal is its row (refuse)
      c.recorded = true;
      throw e;
    }
  }

  private async closeMessage(m: Extract<FrontendMessage, { type: "Close" }>): Promise<Buffer[]> {
    if (m.kind === "S") {
      const s = this.statements.get(m.name);
      this.statements.delete(m.name);
      if (s?.catalogName !== null && s !== undefined) return this.catalogRun(frame("C", Buffer.from("S"), cstr(s.catalogName)));
    } else {
      this.dropPortal(m.name);
    }
    return [closeComplete()];
  }

  // ---------------------------------------------------------------- a query

  /**
   * A `mason user` is asked again while its session lasts (`recheckMs`, DEFAULT_RECHECK_MS by default): removed, the
   * session ends FATAL with the reason, as a new connection would be refused; a list of users that cannot be read
   * refuses this statement only (recorded by `refuse`).
   */
  private async stillLive(asked: string): Promise<PgError | null> {
    const recheck = this.server.options.recheck;
    const user = this.token?.user;
    if (recheck === undefined || user === undefined) return null;
    const now = this.server.now();
    if (now - this.verifiedAt < (this.server.options.recheckMs ?? DEFAULT_RECHECK_MS)) return null;
    try {
      await recheck(this.token!);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // could not tell: this statement is refused, the session kept, and the next statement asks again
      if (err instanceof ApiError && err.status === 503) return new PgError({ code: "57P03", message, hint: "run the statement again once Mason can read its list of users" }, 503);
      if (err instanceof ApiError) this.recordRefusal(asked.toUpperCase(), err);
      this.fatal("28000", `the session's user is no longer accepted: ${message}`, `a removed user's sessions end at their next statement; mason user add ${user} makes it again, with a new password`);
      return null;
    }
    this.verifiedAt = now;
    return null;
  }

  /** A removed user's session ended, as a row of the request log: who, when, why, and the statement it was ended at. */
  private recordRefusal(method: string, err: ApiError): void {
    const user = err.userName ?? this.token?.user;
    const stored = this.asked !== null ? storedPayload(this.asked.sql) : null;
    this.server.log(`session ${this.id}: ${method} refused for the user ${JSON.stringify(user ?? "")}: ${err.message}`);
    this.server.options.record({
      requestId: crypto.randomUUID(), at: new Date(), method, status: err.status, durationMs: 0,
      client: `postgres:${this.vars.applicationName || "unnamed"}`, caller: hashCaller(this.presented),
      error: err.message, sqlstate: "28000", session: this.id, ...(stored !== null ? { payload: stored.text, payloadTruncated: stored.truncated } : {}), ...(user !== undefined ? { user } : {}),
    });
  }
}

/** The result format of column `i`: none given is text, one given applies to all, else each its own. */
const formatAt = (formats: number[], i: number): 0 | 1 =>
  (formats.length === 0 ? 0 : formats.length === 1 ? formats[0]! : formats[i] ?? 0) === 1 ? 1 : 0;

const isUtf8 = (encoding: string): boolean => /^(utf-?8|unicode)$/i.test(encoding.trim());

const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const quoteLiteral = (text: string): string => `'${text.replaceAll("'", "''")}'`;

/** the text of one statement of a simple query, from the parser's byte offsets */
function statementText(sql: string, raw: RawStmt): string {
  const bytes = Buffer.from(sql, "utf8");
  const from = raw.stmt_location ?? 0;
  const len = raw.stmt_len ?? 0;
  return bytes.subarray(from, len === 0 ? bytes.length : from + len).toString("utf8").trim();
}

const oidOf = (oid: number): PgApiType | undefined => (Object.keys(OID) as PgApiType[]).find((t) => OID[t].oid === oid);

const PG_EPOCH_MS = Date.UTC(2000, 0, 1);

/** A binary-format parameter, as text Postgres's input function reads (DuckOptions.parameters). */
function decodeBinaryParam(type: PgApiType, bytes: Buffer, i: number): string {
  const need = (n: number): void => {
    if (bytes.length !== n) throw new PgError({ code: "22P03", message: `incorrect binary data format in bind parameter ${i + 1}: ${bytes.length} byte(s) for ${type}` });
  };
  switch (type) {
    case "int2": need(2); return String(bytes.readInt16BE(0));
    case "int4": need(4); return String(bytes.readInt32BE(0));
    case "int8": need(8); return bytes.readBigInt64BE(0).toString();
    case "float4": need(4); return String(bytes.readFloatBE(0));
    case "float8": need(8); return String(bytes.readDoubleBE(0));
    case "numeric": {
      try {
        return numericFromBinary(bytes);
      } catch (err) {
        // numericFromBinary throws exactly NumericError on bytes that are no numeric: the Bind's 22P03, naming the parameter
        if (err instanceof NumericError) throw new PgError({ code: err.sqlstate, message: `${err.message} in bind parameter ${i + 1}` });
        throw err;
      }
    }
    case "bool": need(1); return bytes[0] === 0 ? "f" : "t";
    case "uuid": { need(16); const h = bytes.toString("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; }
    case "date": { need(4); return new Date(PG_EPOCH_MS + bytes.readInt32BE(0) * 86_400_000).toISOString().slice(0, 10); }
    case "timestamptz": {
      need(8);
      const micros = bytes.readBigInt64BE(0);
      const ms = Number(micros / 1000n) + PG_EPOCH_MS;
      const rest = Number(micros % 1000n);
      return new Date(ms).toISOString().replace("Z", `${rest ? String(rest).padStart(3, "0") : ""}Z`);
    }
    case "text": return bytes.toString("utf8");
    case "jsonb": return bytes.subarray(bytes[0] === 1 ? 1 : 0).toString("utf8");
  }
}

/** The catalog Postgres's ErrorResponse, as this session's: its fields, less the source-file ones. */
function relayedError(frame: Buffer): PgError {
  const fields = decodeNoticeFrame(frame);
  return new PgError({
    severity: fields.V ?? fields.S ?? "ERROR", code: fields.C ?? "XX000", message: fields.M ?? "the catalog Postgres refused the statement",
    detail: fields.D, hint: fields.H, position: fields.P !== undefined ? Number(fields.P) : undefined,
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// the listener

class Server {
  readonly sessions = new Map<number, Session>();
  /** the DuckDB plans by text, search_path, TimeZone, declared parameter types and an Execute's bound (Session.boundOnWire), for
   *  the schema they were made under */
  private duckPlans = new Map<string, DuckPlan>();
  private duckPlansOf: PgSchema | null = null;
  private duckPlansAt = 0;

  /** the source's OIDs for the types an extension made, by name (a copied citext column's), from the schema */
  userTypes(): ReadonlyMap<string, number> {
    const out = new Map<string, number>();
    for (const t of this.options.schema().tables) {
      // a table's row type, by its schema and name (src/duck/plan.ts names the catalog's alike)
      if (t.rowTypeOid !== undefined) out.set(`rowtype:${t.schema ?? "public"}.${t.name}`, t.rowTypeOid);
    }
    for (const t of this.options.schema().tables) for (const c of t.columns) {
      if (c.typeOid === undefined || c.spelled === undefined) continue;
      // the type's name as pg_type holds it (`other.level` is `level`, `"My Mood"` is `My Mood`)
      const name = typeNameParts(c.spelled.replace(/\[\]$/, "")).name;
      // the element type and its array type, as pg_type names them (`citext`, `_citext`); an array column's own OID is
      // its array type's (pg_attribute.atttypid), and it has none of its own (an array type's typarray is 0)
      if (c.spelled.endsWith("[]")) out.set(`_${name}`, c.typeOid);
      else { out.set(name, c.typeOid); if (c.typeArrayOid !== undefined) out.set(`_${name}`, c.typeArrayOid); }
    }
    return out;
  }

  /**
   * EVERY PLAN IS MADE OVER THE CATALOG OF THE SCHEMA IT IS KEPT UNDER: the catalog is replaced here (`schema`), not
   * only at a statement's classify, because a plan is also made at an Execute (Session.boundOnWire) — a re-plan that
   * read the schema raw analysed against the old catalog and was kept under the new one (a review finding of #23).
   * The ordering relied on: `schema()` calls `catalog.replace` synchronously, which queues the old instance's close on
   * the catalog's one chain (src/api/postgres/catalog.ts "SERIALISED") before `make` queues its analysis, so the
   * analysis starts the instance with the new DDL. A plan whose schema or generation moved while it was made is
   * returned to its caller and not kept.
   */
  async duckPlan(text: string, paramOids: readonly number[], searchPath: string, timeZone: string, wireBound: boolean, make: () => Promise<DuckPlan>): Promise<DuckPlan> {
    const schema = this.schema();
    const generation = this.options.duck?.generation?.() ?? 0;
    if (schema !== this.duckPlansOf || generation !== this.duckPlansAt) { this.duckPlans.clear(); this.duckPlansOf = schema; this.duckPlansAt = generation; }
    // the zone too: a plan holds the values Postgres parsed its literals to, under the session's zone
    // and the bound: an Execute's row count plans a LEFT lateral of a list otherwise (Session.boundOnWire), kept beside
    const key = `${searchPath}\u0000${timeZone}\u0000${paramOids.join(",")}\u0000${wireBound ? "wire" : ""}\u0000${text}`;
    const hit = this.duckPlans.get(key);
    if (hit !== undefined) return hit;
    const plan = await make();
    if (this.duckPlansOf !== schema || this.duckPlansAt !== generation) return plan;
    // bounded: a tool that inlines its values sends a new text per value
    if (this.duckPlans.size >= 2000) this.duckPlans.delete(this.duckPlans.keys().next().value!);
    this.duckPlans.set(key, plan);
    return plan;
  }
  readonly tls: tls.SecureContext | null;
  readonly catalog: PgCatalog;
  private lastSchema: PgSchema;
  options: PgApiOptions;
  constructor(options: PgApiOptions) {
    this.options = options;
    this.tls = options.tls === null ? null : tls.createSecureContext({ cert: options.tls.cert, key: options.tls.key });
    this.lastSchema = options.schema();
    const version = versionText(options.product ?? "Mason", options.masonVersion);
    this.catalog = new PgCatalog(this.lastSchema, {
      log: (line) => this.log(line),
      setup: [
        // `version()` says whose Postgres this is; search_path lists pg_catalog AFTER public so the override wins
        `CREATE OR REPLACE FUNCTION public.version() RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT '${version.replaceAll("'", "''")}' $$`,
        // `current_setting('ssl')` says what every session of this listener is (tlsParameters), as SHOW does
        ...currentSettingSql(tlsParameters(options.tls !== null)),
        "SET search_path = public, pg_catalog",
        ...databaseNameSql(options.database),
      ],
      ...(options.catalogStatementMs !== undefined ? { statementMs: options.catalogStatementMs } : {}),
      ...(options.trace === true ? { trace: true } : {}),
    });
  }
  get database(): string { return this.options.database; }
  /** the clock "now" is read from */
  now(): number { return (this.options.clock ?? Date.now)(); }
  log(line: string): void { (this.options.log ?? ((l: string) => console.log(l)))(`[postgres] ${line}`); }

  /** the schema as of now; the catalog Postgres is replaced when it changed */
  schema(): PgSchema {
    const s = this.options.schema();
    if (s !== this.lastSchema) {
      this.lastSchema = s;
      void this.catalog.replace(s).catch((e: unknown) => this.log(`replacing the catalog failed: ${e instanceof Error ? e.message : String(e)}`));
    }
    return s;
  }

  forget(s: Session): void { this.sessions.delete(s.id); }

  cancel(pid: number, secret: number): void {
    const s = this.sessions.get(pid);
    if (s === undefined || s.secret !== secret) return;   // as Postgres: a wrong key is ignored, never answered
    s.running?.abort();
  }
}

export async function startPostgresApi(options: PgApiOptions): Promise<PgApiServer> {
  const server = new Server(options);
  const listener = net.createServer((socket) => {
    socket.setNoDelay(true);
    const session = new Session(socket, server);
    server.sessions.set(session.id, session);
  });
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(options.port, options.host, () => { listener.off("error", reject); resolve(); });
  });
  listener.on("error", (err: Error) => server.log(`listener error: ${err.message}`));
  const address = listener.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;
  return {
    port,
    get sessions() { return server.sessions.size; },
    async close() {
      for (const s of [...server.sessions.values()]) s.end("server closing");
      await new Promise<void>((resolve) => listener.close(() => resolve()));
      await server.catalog.stop();
      await stopParser();
    },
  };
}
