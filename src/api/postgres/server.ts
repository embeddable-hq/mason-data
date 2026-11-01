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
 *     src/duck/users.ts `listenerLogins`): a refused one is `28P01` as a wrong password is; a DISABLED user's (its
 *     password right) is `28000`, as Postgres refuses a role without LOGIN. The database a tool names
 *     must be the one this Mason answers as (src/lib/database-name.ts): a tool connecting with another learns so at once (`3D000`).
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
 *     aborted one is a `ROLLBACK`. Nothing is ever written, so all a transaction holds is the session's settings
 *     (`settingsTx`): its end, explicit or implicit, keeps or undoes them; the states exist because a driver reads them.
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
 *
 * TWO SOCKETS, ONE SERVER (`mason share`, `PgApiServer.openShare`): what a connection may do is a property of the socket
 * it arrived on (`Door`), carried into its session, never of the server: the same sessions, store, roles and request
 * log, with TLS required and a login of its own on the share's socket alone, so opening one drops no session and
 * changes nothing for a local tool.
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
import { catalogRows } from "../../duck/analyze.ts";
import type { Planner } from "../../duck/generated-plan.ts";
import { ApiError, USER_DISABLED } from "../error.ts";
import { hashCaller, outcomeOf, storedPayload, type ApiLogRow } from "../request-log.ts";
import type { GapId } from "../../duck/gaps.ts";
import { gapRefusal, StatementError, type DuckPlan } from "../../duck/statement.ts";
import { canonicalZone } from "../../lib/timezone.ts";
import { catalogRolesOf, exampleRole, grantRefusal, NO_ROLE_CATALOG, NO_ROLES, type RoleGrants, type RolesLive } from "../../duck/grants.ts";
import { asRole, asSession, catalogPolicies, currentSettingSql, databaseNameSql, LATEST_SQL, PgCatalog, unwrapRole, unwrapSession } from "./catalog.ts";
import { wrongDatabaseHint } from "../../lib/database-name.ts";
import { attributeSetting, bindFilter, filterProbe, filterTypes, missingAttributes, type AttributeValues, type BoundFilter } from "../../duck/row-filter.ts";
import { EncodeError, OID, fieldOf } from "./encode.ts";
import { numericFromBinary, NumericError } from "../../lib/pg-numeric.ts";
import { parseSql, PostgresSyntaxError, stopParser } from "./parser.ts";
import {
  FrontendDecoder, ProtocolError, authenticationCleartextPassword, authenticationOk, backendKeyData, bindComplete,
  closeComplete, commandComplete, dataRow, emptyQueryResponse, errorResponse, noData, noticeResponse, parameterDescription,
  parameterStatus, parseComplete, portalSuspended, readyForQuery, rowDescription, sslResponse, type ErrorFields,
  type FieldDescription, type FrontendMessage,
  cstr, int16, int32, frame, decodeBackend, decodeNoticeFrame, splitFrames, MAX_MESSAGE_LENGTH,
} from "./protocol.ts";
import { madeTypeName, typeNameParts, type PgApiType, type PgSchema } from "./schema.ts";
import { Unsupported, duckTranslate, endsFailedBlock, type Translation } from "./translate.ts";
import type { Node } from "libpg-query";

/** what a statement is: one the session or the catalog Postgres answers (translate.ts), one DuckDB answers, or an
 *  EXPLAIN of one */
type AnyTranslation = Translation | DuckTranslation | ExplainTranslation;
/** an EXPLAIN on the DuckDB path: the statement it explains, and its options as written (read by `explaining`) */
interface ExplainTranslation { kind: "explain"; query: NonNullable<RawStmt["stmt"]>; options: unknown[] }
/** an EXPLAIN read: its options, and the plan of the statement it explains (null: a catalog statement, the catalog
 *  Postgres's to explain) */
interface Explaining { options: ExplainOptions; plan: DuckPlan | null }

/** what an EXPLAIN of a catalog statement says first: whose plan it is */
const CATALOG_EXPLAINED = "Mason: answered by the catalog Postgres (Mason's own, PGlite), not the synced data: a statement of pg_catalog or information_schema, or of no table, is the catalog's, and this is its plan";

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
  if (doc[0] !== undefined) doc[0].Mason = { "Answered By": "the catalog Postgres (Mason's own, PGlite), not the synced data", Why: "a statement of pg_catalog or information_schema, or of no table, is the catalog's" };
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
/** what a DuckDB statement of a session runs under (`Session.duckSession`): its TimeZone and search_path, and every
 *  setting `current_setting(name)` reads beside a copied table (src/duck/rewrite.ts, src/duck/store.ts settle) */
export interface DuckSession { timeZone: string; searchPath: string; settings: Readonly<Record<string, string>> }
export interface DuckRunner {
  /** `sql`: a plan's (src/duck/plan.ts PlannedSql), never a statement's text; `fields`: Postgres's columns for the
   *  result (the plan's), which DuckDB's values are written as */
  run(sql: PlannedSql, params: readonly (string | null)[], session: DuckSession, signal: AbortSignal,
    fields?: ReadonlyArray<{ name: string; oid: number; typmod?: number }> | null, exact?: readonly ExactColumn[]): Promise<DuckAnswer>;
  /** EXPLAIN of a plan (src/duck/explain.ts): its QUERY PLAN rows, a line each (FORMAT JSON: one document). ANALYZE runs
   *  it as `run` does, under the same `signal`, converting every row and sending none */
  explain(sql: PlannedSql, params: readonly (string | null)[], session: DuckSession, signal: AbortSignal,
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
  /** the tables the session's role filters that the statement reads, the filter in words (DuckPlan.rowFilters): none
   *  given, the engine's plan is said; given, the statement is not shown to the engine at all (`Explained.filtered`) */
  rowFilters?: ReadonlyArray<{ table: string; words: string }>;
  /** every table the statement reads, for a statement with row filters: its table lines, never the engine's plan's */
  reads?: readonly string[];
}
/** whether any role of the file filters rows (src/duck/row-filter.ts): nothing is checked, bound or keyed where none does */
const filtersRows = (live: RolesLive): boolean => [...live.grants.values()].some((g) => g.filters !== undefined && g.filters.size > 0);

/** the row filters a session's role holds, bound to its user's values, as one string: a plan's key and its `rowsKey`;
 *  "" where it holds none */
function rowsKeyOf(g: RoleGrants | null | undefined): string {
  if (g?.rows === undefined || g.rows.size === 0) return "";
  return JSON.stringify([...g.rows.values()].map((f) => [f.table, f.predicate ?? null, f.through ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}
/** the DuckDB halves the listener calls: a session's connection, and a statement's plan */
export interface DuckOptions {
  open(): Promise<DuckRunner>;
  /** Postgres's analysis (in the catalog Postgres, through `catalog`) and the DuckDB SQL; throws a StatementError for
   *  a statement Postgres refuses or DuckDB cannot answer alike */
  /** `timeZone`: the session's, which Postgres parses a literal under (a plan holds the values it parsed) */
  /** `wireBound`: the statement's rows are bounded by an Execute's row count (PlannedSql.unboundedLateral): planned as
   *  a LIMIT over its outermost SELECT would be, with no LIMIT in its SQL */
  /** `grants`: the session's role, held after Postgres's analysis (src/duck/grants.ts): a 42501 StatementError where
   *  it reads what the role may not; null for a session with no role beside roles; undefined where no roles exist.
   *  `outputs`: the generated planner's alone (src/duck/plan.ts `PlanOptions.outputs`), never a wire statement's */
  plan(catalog: (bytes: Uint8Array) => Promise<Uint8Array>, text: string, stmt: NonNullable<RawStmt["stmt"]>, base: number, paramOids: readonly number[], searchPath: string,
    timeZone: string, userTypes: ReadonlyMap<string, number>, wireBound?: boolean, grants?: RoleGrants | null, relations?: ReadonlyMap<string, string>, outputs?: boolean): Promise<DuckPlan>;
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
 * statements; a token's session is neither. `role`: the user's role (the project's roles file, src/duck/grants.ts),
 * which every statement over a table and every catalog read is held to; a session with none reads every copied table.
 * (`filters` and `subject` are always empty: src/duck/users.ts still writes them.)
 */
export interface PgToken { filters?: readonly []; subject?: undefined; jti?: string | undefined; user?: string | undefined; role?: string | undefined;
  /** the user's attribute values (`mason user add … --set tenant=42`), which its role's row filters read (src/duck/row-filter.ts) */
  attributes?: AttributeValues | undefined }

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
  /** the database a tool must name (src/lib/database-name.ts) */
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
   *  session kept); answers the token as the user is NOW (its role given or taken since), which the session keeps */
  recheck?(token: PgToken): Promise<PgToken | void>;
  /** the roles (src/duck/grants.ts RolesLive; the project's roles file, src/cli/roles.ts), the SAME object until they
   *  change: a session with a role is held to its grants at every statement, its catalog reads run under the role,
   *  and the catalog is rebuilt with the roles when they move. Absent: no roles, every session reads every copied table */
  roles?: () => RolesLive;
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

/**
 * A SECOND SOCKET ON THE SAME SERVER (`mason share`, src/cli/share-run.ts): on loopback, because a tunnel's client is on
 * this machine, and treated as public, because what is on the tunnel's other end is not. TLS is required of every
 * connection, however the plain listener is set; only `authenticate` logs in (a `mason user` and a token are refused
 * by not being asked); and every connection that has not logged in is one of at most `pendingLimit`, for at most
 * `pendingMs`. A tunnel hides who connects, so nothing here can tell a scanner from the BI tool: when the limit is met
 * the OLDEST connection still logging in makes way (`LoginQueue`), so a connection held open cannot keep a login out.
 */
export interface ShareDoor {
  tls: { cert: Buffer; key: Buffer };
  authenticate(password: string, user: string): PgToken | Promise<PgToken>;
  /** asked before every statement, as `PgApiOptions.recheck` is: throws once the session's login is gone */
  recheck(token: PgToken): Promise<PgToken | void>;
  /** what a refused login is told, and a session ended by `recheck` */
  loginHint: string;
  /** default DEFAULT_PENDING_LIMIT */
  pendingLimit?: number;
  /** default DEFAULT_PENDING_MS */
  pendingMs?: number;
  /** a login refused here: the startup packet's user (the socket's peer is the tunnel's client: no source to name).
   *  false: it is counted, and no row of the request log, whose growth a stranger would otherwise set */
  refused?(user: string): boolean;
  /** a connection dropped without logging in: `why`, in a few words */
  dropped?(why: string): void;
}

/** How many connections may be logging in on a share's socket at once: more than a pool opens at a time. */
export const DEFAULT_PENDING_LIMIT = 32;
/** How long one may take to log in: a tunnel's round trips and a TLS handshake are seconds, Postgres allows 60. */
export const DEFAULT_PENDING_MS = 15_000;

/** A share's socket, open (`PgApiServer.openShare`). */
export interface ShareSocket {
  readonly port: number;
  /** the sessions logged in on it now */
  readonly sessions: number;
  /** ends the sessions of one login (`PgToken.jti`) at once; how many */
  endSessions(jti: string, why: string): number;
  /** every session on it ended, and the socket closed; every other session untouched */
  close(): Promise<void>;
}

export interface PgApiServer {
  readonly port: number;
  close(): Promise<void>;
  /** opens a second socket (`ShareDoor`); closed by its own `close`, or with the server's */
  openShare(door: ShareDoor): Promise<ShareSocket>;
  /** what a generated table's SQL is asked of (src/duck/generated-plan.ts `Planner`): a statement planned as a session with
   *  no role, in UTC under `public`, by this listener's catalog as of now */
  planner(): Planner;
  /** the roles as the listener holds them now, their row filters checked by the catalog Postgres (`checkRoles`): a filter
   *  Postgres refuses is the roles' `problem`. What `/api/state` says of the roles, and `mason user add` is held to */
  roles(): RolesLive;
  /** the roles with every row filter checked by the catalog Postgres now (it starts it where needed): `mason start`'s line */
  checkRoles(): Promise<RolesLive>;
  /** sessions open now (every connection, its login under way included) */
  readonly sessions: number;
  /** the sessions logged in now, by user and client, and how many of each run a statement (`/api/state` `sessions`) */
  openSessions(): SessionsOpen;
  /** the statements running now, one per session, oldest first (`/api/running`, `mason logs --running`) */
  running(): RunningStatement[];
  /** cancels a session's statement exactly as a CancelRequest does (`POST /api/cancel`, `mason cancel`); `statement`
   *  (RunningStatement.statement): only while the session runs that one, else nothing is cancelled (`other`) */
  cancel(session: number, statement?: number): CancelAnswer;
}

/**
 * THE SESSIONS LOGGED IN NOW (`openSessions`; `/api/state` `sessions`, mason status, the usage samples): how many, and
 * by user and client — the `mason user` ('' for a token's session) and the application_name ('' when it sent none) —
 * with how many of them run a statement now. Read from the sessions in memory: no query, no ledger.
 */
export interface SessionsOpen { open: number; byClient: Array<{ user: string; client: string; open: number; running: number }> }

/**
 * A statement running now: one a session's DuckDB is running, or whose rows it is sending — what a CancelRequest (and
 * `mason cancel`) stops. A statement being parsed or planned, a catalog read, and a portal suspended between two
 * Executes (the client's turn) are not running.
 */
export interface RunningStatement {
  /** the listener's session number (the log's `session <n>`, the request log's `session`): what `mason cancel` names */
  session: number;
  /** the statement's number in this run (`statementIdOf`; one across the Executes that page a portal's rows): what
   *  `mason cancel <session> --statement <n>` names, so the cancel stops the statement listed, never the next one */
  statement: number;
  /** the `mason user` the session logged in as ('' for a token's session) */
  user: string;
  /** the client's application_name ('' when it sent none) */
  applicationName: string;
  /** QUERY (a simple Query's statement) or EXECUTE */
  method: string;
  /** when the statement arrived, ISO 8601 UTC, and how long ago */
  startedAt: string;
  runningMs: number;
  /** the rows sent so far */
  rows: number;
  /** the statement as the tool sent it, capped as the request log caps it (`queryTruncated`) */
  query: string;
  queryTruncated: boolean;
}

/** What a cancel did: asked the statement to stop (it ends with 57014, as Postgres's does), found the session idle,
 *  found no such session, or — asked for one statement — found the session running another (`other`), cancelling none.
 *  Without a statement it stops whatever the session runs, as a CancelRequest does (Postgres's own semantics). */
export type CancelAnswer = { cancelled: RunningStatement } | { idle: number } | { unknown: number } | { other: RunningStatement; asked: number };

/** EACH STATEMENT'S NUMBER IN THIS RUN, by the controller that runs it — the thing a cancel aborts, so a cursor's is one
 *  number across the Executes that page its rows — given when first asked (`runningNow`), never reused */
const statementIds = new WeakMap<AbortController, number>();
let nextStatementId = 1;
function statementIdOf(c: AbortController): number {
  let id = statementIds.get(c);
  if (id === undefined) { id = nextStatementId++; statementIds.set(c, id); }
  return id;
}

// ---------------------------------------------------------------------------------------------------------------------
// bytes

/** the type byte of a RowDescription frame */
const ROW_DESCRIPTION = 0x54;
const DATA_ROW = 0x44;
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
  /** the registry entry that refused it (StatementError.gap): the request log's `gap` */
  readonly gap: GapId | null;
  constructor(fields: Omit<ErrorFields, "severity"> & { severity?: string }, status = 400, gap: GapId | null = null) {
    super(fields.message);
    this.fields = { severity: "ERROR", ...fields };
    this.status = status;
    this.gap = gap;
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
 * A refused or failed statement as its log line (`Session.refuse`): its outcome (src/api/request-log.ts outcomeOf) —
 * `cancelled` for 57014 (a cancel or a timeout), `failed` where the fault is Mason's or the machine's (SQLSTATE classes
 * XX internal, 53 resources, 57, 58 system), `refused` for the statement's own; the detail and the hint where there
 * are, and the statement on one line, as the answered lines carry it.
 */
export function refusalLine(session: number, f: Omit<ErrorFields, "severity">, sql: string): string {
  const o = outcomeOf(f.code);
  const word = o === "ok" ? "refused" : o;
  const statement = sql.replace(/\s+/g, " ").trim();
  return `session ${session} ${word}: ${f.code} ${f.message}${f.detail ? `; detail: ${f.detail}` : ""}${f.hint ? `; hint: ${f.hint}` : ""}` +
    ` — ${statement === "" ? "(no statement)" : statement}`;
}

function asPgError(err: unknown, sql: string): PgError {
  if (err instanceof PgError) return err;
  if (err instanceof StatementError) return new PgError({ ...err.fields, position: err.fields.position ?? undefined }, err.fields.code.startsWith("XX") ? 500 : 400, err.gap);
  if (err instanceof Unsupported) {
    return new PgError({ code: err.sqlstate, message: err.message, position: positionOf(sql, err.offset), hint: err.hint, detail: "Mason answers the Postgres subset in docs/POSTGRES-API.md" }, 400, err.gap);
  }
  if (err instanceof PostgresSyntaxError) return new PgError({ code: "42601", message: err.message, position: positionOf(sql, err.offset) });
  if (err instanceof ApiError) return new PgError({ code: sqlstateOf(err.status, err.code), message: err.message, detail: `Mason: ${err.code}` }, err.status);
  // Postgres's own error for a numeric (a division by zero, 22012; a field overflow, 22003), raised as Postgres raises it
  if (err instanceof NumericError) return new PgError({ code: err.sqlstate, message: err.message, ...(err.detail === null ? {} : { detail: err.detail }) }, err.sqlstate === "XX000" ? 500 : 400, err.gap);
  if (err instanceof EncodeError) return err.code === "XX000"
    ? new PgError({ code: "XX000", message: err.message, detail: "Mason: a value the column's Postgres type cannot carry; report it" }, 500)
    : new PgError({ code: err.code, message: err.message }, 400, err.gap);
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
const copyVars = (v: Vars): Vars => ({ ...v, other: new Map(v.other) });

/** One parameter's value carried from one set of values to another, from where `setParameter` keeps it. */
function copySetting(name: string, from: Vars, to: Vars): void {
  switch (name) {
    case "timezone": case "time zone": to.timeZone = from.timeZone; return;
    case "application_name": to.applicationName = from.applicationName; return;
    case "search_path": to.searchPath = from.searchPath; return;
  }
  const value = from.other.get(name);
  if (value === undefined) to.other.delete(name); else to.other.set(name, value);
}

/** A placeholder's name as Postgres's `valid_custom_variable_name` reads it: two or more simple identifiers, dotted. */
function placeholderName(name: string): void {
  if (/^[A-Za-z_\u0080-\uffff][A-Za-z0-9_$\u0080-\uffff]*(\.[A-Za-z_\u0080-\uffff][A-Za-z0-9_$\u0080-\uffff]*)+$/.test(name)) return;
  throw new PgError({ code: "42602", message: `invalid configuration parameter name "${name}"`, detail: "Custom parameter names must be two or more simple identifiers separated by dots." });
}

/** What `SHOW` / `current_setting` answer for the parameters this server fixes, by name: read by `fixedParameter` alone. */
const FIXED = new Map<string, (vars: Vars, user: string) => string>([
  ["server_version", () => SERVER_VERSION], ["server_version_num", () => SERVER_VERSION_NUM],
  ["server_encoding", () => "UTF8"], ["client_encoding", () => "UTF8"],
  ["datestyle", () => "ISO, MDY"], ["intervalstyle", () => "postgres"],
  ["timezone", (v) => v.timeZone], ["application_name", (v) => v.applicationName], ["search_path", (v) => v.searchPath],
  ...["integer_datetimes", "standard_conforming_strings", "default_transaction_read_only", "transaction_read_only", "in_hot_standby"].map((n): [string, () => string] => [n, () => "on"]),
  ["is_superuser", () => "off"],
  // the session's user, and no role SET over it (SET ROLE is its own name or NONE, setStatement): Postgres's `none`
  ["session_authorization", (_v, user) => user], ["role", () => "none"],
  ["transaction_isolation", () => "read committed"], ["default_transaction_isolation", () => "read committed"],
  ["extra_float_digits", () => "1"], ["max_identifier_length", () => "63"],
]);
function fixedParameter(name: string, vars: Vars, user: string): string | null {
  return FIXED.get(name)?.(vars, user) ?? null;
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
  /** THE BYTES ITS EARLIER EXECUTES SENT (a paged portal's pages, `pageSent`): its request log row, written at its
   *  last, counts them with that one's — never the session's bytes since its first Execute, which held every other
   *  statement's sent between two of its Executes */
  bytes: number;
}

type TxState = "none" | "open" | "failed";

/** Postgres's answer to anything but a failed block's end */
const aborted = (): PgError => new PgError({ code: "25P02", message: "current transaction is aborted, commands ignored until end of transaction block" });

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

/** THE STATEMENT BEING ASKED (`Session.asked`): its text, its message, when it arrived and the session's bytes sent by
 *  then (what this message sends is counted from there: one message is handled at a time, so nothing else is sent
 *  meanwhile), what its portal's earlier Executes sent (`carried`, `Portal.bytes`), the JSON paths it reads, and the
 *  rows sent so far while it runs */
interface Asked { sql: string; method: string; startedAt: number; sentAt: number; carried?: number; jsonReads?: readonly string[]; rows?: number }

// ---------------------------------------------------------------------------------------------------------------------
// one connection

/** A name as Postgres takes one from a startup packet: its first 63 bytes (NAMEDATALEN - 1). */
const nameLength = (name: string | undefined): string | undefined => name === undefined ? undefined : Buffer.from(name, "utf8").subarray(0, 63).toString("utf8");

/** The hint a refused login is told on the run's own listener. */
const USER_LOGIN_HINT = "a tool that keeps one password connects as a user: mason user add <name> prints its password and URL";

/**
 * WHAT A CONNECTION MAY DO IS ITS SOCKET'S (`ShareDoor`): how it starts and who logs in, read from here, so the run's
 * listener and a share's differ by what their door holds, never by a branch in the session.
 */
interface Door {
  /** offered, and required of every connection; null: a plain socket */
  tls: tls.SecureContext | null;
  authenticate: PgApiOptions["authenticate"];
  recheck: PgApiOptions["recheck"];
  recheckMs: number;
  /** what the session's login is, in the log's line */
  who: string;
  loginHint: string;
  /** reachable by anyone: nothing about the project is said before a login, and a CancelRequest reaches its own sessions alone */
  public: boolean;
  logins: LoginQueue | null;
  refused?: ((user: string) => boolean) | undefined;
}

/**
 * THE CONNECTIONS STILL LOGGING IN ON A PUBLIC SOCKET (`ShareDoor`): at most `limit`, each for at most `ms`, the oldest
 * making way for a new one. A limit that refused the NEW connection would hand the socket to whoever opened `limit`
 * connections first and sat on them, which is the attack; every connection through a tunnel comes from 127.0.0.1, so
 * a limit per source cannot exist.
 */
class LoginQueue {
  private readonly waiting = new Map<Session, NodeJS.Timeout>();
  private readonly limit: number;
  private readonly ms: number;
  private readonly dropped: ((why: string) => void) | undefined;
  constructor(limit: number, ms: number, dropped: ((why: string) => void) | undefined) { this.limit = limit; this.ms = ms; this.dropped = dropped; }

  admit(s: Session): void {
    if (this.waiting.size >= this.limit) {
      const oldest = this.waiting.keys().next().value!;
      this.dropped?.("made way for a newer connection");
      oldest.end("made way for a newer connection");
    }
    const timer = setTimeout(() => { this.dropped?.("did not log in in time"); s.end("did not log in in time"); }, this.ms);
    timer.unref();
    this.waiting.set(s, timer);
  }

  settled(s: Session): void {
    const timer = this.waiting.get(s);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.waiting.delete(s);
  }
}

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
  /** the database a public socket's startup named that is not this one: refused once the login is good */
  private wrongDatabase: string | null = null;
  /** when the user was last found live (a user's session is asked again, `recheckMs`) */
  verifiedAt = 0;
  vars: Vars = defaultVars();
  /** the session's parameters as its startup left them (its packet's `application_name` and `options`): what RESET restores */
  startupVars: Vars = defaultVars();
  /** each reported parameter's value as the client was last told it (`reportChanges`) */
  readonly reported = new Map<string, string>();
  tx: TxState = "none";
  /**
   * WHAT THE TRANSACTION WOULD LEAVE OF THE SESSION'S SETTINGS, from its first SET: `rollback`, the values it found, and
   * `commit`, those with its SETs and none of its LOCALs. Neither is ever read for an answer: `vars` is what is in force,
   * and `endTransaction` replaces it with one of these. Null: nothing was set since the transaction began.
   */
  settingsTx: { rollback: Vars; commit: Vars } | null = null;
  /** the statement runs in an IMPLICIT transaction block, as Postgres's IsTransactionBlock reads one: a Query of several
   *  statements, or a Sync's batch once an Execute completed (`extended`). A plain transaction of one statement is none */
  implicitBlock = false;
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
  /** the bytes written to the client so far: a message's are this less its mark (`Asked.sentAt`; `bytesFor`) */
  sentBytes = 0;
  /** this session's DuckDB connection, opened at its first statement over a table */
  private duckRunner: DuckRunner | null = null;

  /** Closes the session's DuckDB connection, when it has one: only ever with no statement running on it (`end`, `settled`). */
  private closeRunner(): void {
    if (this.duckRunner === null) return;
    const runner = this.duckRunner;
    this.duckRunner = null;
    runner.close().catch((e: unknown) => { this.server.log(`session ${this.id}: closing its connection to the engine failed: ${e instanceof Error ? e.message : String(e)}`); });
  }

  /** A statement ended, however: the session's next one may run, and a session closed meanwhile closes its connection now. */
  private settled(): void {
    this.running = null;
    if (this.phase === "closed") this.closeRunner();
  }
  /** THE STATEMENT BEING ASKED, for the request log (`recordRequest`): set as each message arrives, its
   *  text narrowed to one statement of a simple Query as each is run */
  private asked: Asked | null = null;
  /** messages are handled one at a time, in order: a parse is asynchronous */
  private draining = false;
  /** the connection's first bytes have been read, and told a TLS ClientHello from a startup packet */
  private sniffed = false;
  private closedBy: string | null = null;

  private readonly server: Server;
  /** the socket it arrived on: how it may start, and who may log in */
  readonly door: Door;

  constructor(socket: net.Socket, server: Server, door: Door) {
    this.server = server;
    this.door = door;
    this.socket = socket;
    this.attach(socket);
    door.logins?.admit(this);
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
    const bytes = Buffer.concat(parts);
    this.sentBytes += bytes.length;
    this.socket.write(bytes);
  }

  /** The statement running now (RunningStatement), or null: one DuckDB runs or sends, so a cancel would stop it. */
  runningNow(now: number): RunningStatement | null {
    if (this.running === null || this.asked === null || this.phase !== "ready") return null;
    const stored = storedPayload(this.asked.sql);
    return { session: this.id, statement: statementIdOf(this.running), user: this.token?.user ?? "", applicationName: this.vars.applicationName, method: this.asked.method,
      startedAt: new Date(this.asked.startedAt).toISOString(), runningMs: now - this.asked.startedAt, rows: this.asked.rows ?? 0,
      query: stored.text, queryTruncated: stored.truncated };
  }

  end(why: string): void {
    if (this.phase === "closed") return;
    const wasReady = this.phase === "ready";
    this.phase = "closed";
    this.closedBy = why;
    this.door.logins?.settled(this);
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
      this.asked = { sql: m.type === "Query" || m.type === "Parse" ? m.sql : this.sqlOf(m), method: m.type.toUpperCase(), startedAt: Date.now(), sentAt: this.sentBytes };
    }
    // EVERY statement of a user's session is held to its removal (review of #507: a check inside the answer let a pool's
    // keep-alive, its catalog reads, SET and SHOW go on for ever after a revocation)
    if ((m.type === "Query" || m.type === "Parse" || m.type === "Execute") && !(m.type !== "Query" && this.skipToSync)) {
      const refused = await this.stillLive(m.type);
      if (this.phase === "closed") return;
      // the roles' row filters checked by the catalog Postgres for the roles as they are now, before any statement is
      // held to them (Server.checkRoles: once per roles file and copied tables; nothing to do where no role filters rows)
      await this.server.checkRoles();
      if ((this.phase as string) === "closed") return;
      if (refused !== null) {
        this.refuse(refused, m.type === "Execute" ? this.sqlOf(m) : m.sql);
        this.abortTransaction();
        if (m.type === "Query") this.send(...this.ready());
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
        if (this.door.tls === null) { this.send(sslResponse(false)); return; }
        this.send(sslResponse(true));
        this.startTls(this.door.tls, null);
        return;
      }
      case "GSSENCRequest": this.send(sslResponse(false)); return;
      case "CancelRequest": {
        this.server.cancel(m.pid, m.secret, this.door);
        this.end("cancel request");
        return;
      }
      case "Startup": {
        if (m.major !== 3 || m.minor !== 0) { this.fatal("0A000", `unsupported frontend protocol ${m.major}.${m.minor}: server supports 3.0`); return; }
        if (this.door.tls !== null && !(this.socket instanceof tls.TLSSocket)) {
          this.fatal("28000", "this server requires TLS: the password must not travel in clear (connect with sslmode=require)");
          return;
        }
        // a public socket's refused logins are rows of the request log: what a stranger names is a name's length there
        const user = this.door.public ? nameLength(m.params.user) : m.params.user;
        if (user === undefined || user === "") { this.fatal("28000", "no PostgreSQL user name specified in startup packet"); return; }
        this.user = user;
        const database = m.params.database ?? user;
        if (database !== this.server.database) {
          // a share's socket is public: refused here, a wrong name and the right one would answer apart before any
          // password, so a stranger could guess the project's. It is refused after the login, as Postgres does
          if (!this.door.public) { this.fatal("3D000", `database "${database}" does not exist`, wrongDatabaseHint(this.server.database)); return; }
          this.wrongDatabase = database;
        }
        const encoding = m.params.client_encoding;
        if (encoding !== undefined && !isUtf8(encoding)) { this.fatal("22023", `client_encoding ${encoding} is not supported: this API sends UTF8 only`); return; }
        if (m.params.application_name !== undefined) this.vars.applicationName = (this.door.public ? nameLength(m.params.application_name) : m.params.application_name)!;
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
        // what RESET and RESET ALL restore: the startup packet's values beside the defaults
        this.startupVars = copyVars(this.vars);
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
    if (this.door.tls === null) {
      this.server.log(`session ${this.id} refused: a direct TLS start (a TLS ClientHello as its first bytes: sslnegotiation=direct, or a TLS ` +
        `terminator re-encrypting to Mason) on a plain listener — set MASON_PG_TLS_CERT and MASON_PG_TLS_KEY to serve TLS, or terminate TLS ` +
        `in front and send Mason the plain protocol (docs/POSTGRES-API.md "Connecting")`);
      this.end("a direct TLS start on a plain listener");
      return;
    }
    this.startTls(this.door.tls, first);
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
      token = await this.door.authenticate(m.password, this.user);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // a revocation record that could not be read is no wrong password: the server could not tell, said as such
      const unknown = err instanceof ApiError && err.status === 503;
      // a disabled user (`mason user disable`): its password was right, so it is no wrong password but a role that may
      // not log in, which Postgres refuses 28000 "role … is not permitted to log in": that sentence alone, why in DETAIL,
      // the way out in HINT, as Postgres splits them
      const disabled = err instanceof ApiError && err.code === USER_DISABLED;
      const refused = disabled
        ? new PgError({ code: "28000", message, detail: `the user "${this.user}" is disabled (mason user disable). Mason: ${USER_DISABLED}`, hint: `mason user enable ${this.user} lets it connect again, with the same password` }, 401)
        : new PgError({ code: unknown ? "57P03" : "28P01",
          message: unknown ? `the password could not be checked for user "${this.user}": ${message}` : `password authentication failed for user "${this.user}": ${message}`,
          hint: unknown ? "connect again once Mason can read its list of users"
            : this.door.loginHint }, 401);
      // a tool that cannot connect is the first thing to look for in the request log
      this.asked = { sql: "", method: "CONNECT", startedAt: Date.now(), sentAt: this.sentBytes };
      const response = errorResponse({ ...refused.fields, severity: "FATAL" });
      if (this.door.refused?.(this.user) !== false) this.recordRequest(refused, undefined, err instanceof ApiError ? err.userName : undefined, [response]);
      this.send(response);
      this.end("authentication failed");
      return;
    }
    if (this.phase !== "password") return;   // the socket closed while the ledger was read
    this.door.logins?.settled(this);
    if (this.wrongDatabase !== null) { this.fatal("3D000", `database "${this.wrongDatabase}" does not exist`, wrongDatabaseHint(this.server.database)); return; }
    this.token = token;
    this.presented = m.password;
    this.verifiedAt = this.server.now();
    this.phase = "ready";
    this.decoder.maxLength = MAX_MESSAGE_LENGTH;   // authenticated: a statement may be as long as the protocol allows
    // what is happening, as it happens (mason logs once showed little): who connected, and (end) who left
    this.server.log(`session ${this.id} connected: ${this.vars.applicationName === "" ? "a client with no application_name" : JSON.stringify(this.vars.applicationName)} as ${JSON.stringify(this.user)}` +
      (token.user !== undefined ? ` (${this.door.who})` : ""));
    this.sendAll([authenticationOk(), ...this.reportChanges(), backendKeyData(this.id, this.secret), readyForQuery("I")]);
  }

  private reportedParameters(): Array<[string, string]> {
    // each value `sessionSetting`'s, the one SHOW and SHOW ALL answer: a reported value and a shown one never part
    return [...REPORTED].sort().map((name): [string, string] => {
      const value = this.sessionSetting(name);
      if (value === null) throw new PgError({ code: "XX000", message: `the reported parameter ${name} has no value of this session's (Mason bug: report it)` }, 500);
      return [spell(name), value];
    });
  }

  // ---------------------------------------------------------------- session parameters

  /**
   * SET of one parameter (`value` null: its default). The parameters this server has an opinion on are decided here;
   * the rest go to the catalog Postgres for validation and are kept. What a client is told of it is `reportChanges`'s.
   */
  private setParameter(name: string, value: string | null, atStartup = false): void {
    switch (name) {
      case "timezone": case "time zone": {
        const zone = value === null || /^(default|local|localtime)$/i.test(value) ? "UTC" : canonicalZone(value);
        if (zone === null) throw new PgError({ code: "22023", message: `invalid value for parameter "TimeZone": "${value}"`, hint: "an IANA zone name (Europe/London) or UTC: this API knows no abbreviation or fixed offset" });
        this.vars.timeZone = zone;
        return;
      }
      case "application_name": this.vars.applicationName = value ?? ""; return;
      case "search_path": this.vars.searchPath = value ?? '"$user", public'; return;
      case "client_encoding": case "names":
        if (value !== null && !isUtf8(value)) throw new PgError({ code: "22023", message: `invalid value for parameter "client_encoding": "${value}"`, hint: "this API sends UTF8 only" });
        return;
      case "datestyle":
        if (value !== null && !/^\s*iso\b/i.test(value) && !/,\s*iso\s*$/i.test(value) && value.trim() !== "") {
          throw new PgError({ code: "0A000", message: `DateStyle ${value} is not supported: this API writes every date and time in ISO 8601 (DateStyle ISO)` });
        }
        return;
      case "extra_float_digits": {
        const n = value === null ? 1 : Number(value);
        if (!Number.isInteger(n) || n < -15 || n > 3) throw new PgError({ code: "22023", message: `${n} is outside the valid range for parameter "extra_float_digits" (-15 .. 3)` });
        if (n < 1) throw new PgError({ code: "0A000", message: `extra_float_digits ${n} is not supported: this API sends every float as the shortest text that reads back exactly (Postgres's extra_float_digits >= 1, the default since Postgres 12); fewer digits would be a different number` });
        return;
      }
      case "standard_conforming_strings":
        if (value !== null && !/^(on|true|yes|1)$/i.test(value)) throw new PgError({ code: "0A000", message: "standard_conforming_strings off is not supported: a string literal is read as Postgres reads it by default" });
        return;
      case "intervalstyle": return;
      case "transaction_isolation": case "default_transaction_isolation": case "transaction": case "session characteristics":
        // read committed on a store that is never written: every level answers the same rows
        return;
      case "default_transaction_read_only": case "transaction_read_only":
        if (value !== null && /^(off|false|no|0)$/i.test(value)) throw new PgError({ code: "25006", message: "cannot set transaction read-write mode: this API is read-only" });
        return;
      case "statement_timeout": case "lock_timeout": case "idle_in_transaction_session_timeout": case "idle_session_timeout":
      case "transaction_timeout": case "client_min_messages": case "log_min_messages": case "bytea_output":
      case "default_transaction_deferrable": case "xmloption": case "backslash_quote": case "escape_string_warning":
      case "synchronize_seqscans": case "work_mem": case "max_parallel_workers_per_gather": case "jit": case "row_security":
      case "lc_messages": case "lc_monetary": case "lc_numeric": case "lc_time": case "check_function_bodies":
        // accepted and remembered; none changes an answer (statement_timeout is honoured, armTimeout: it may only shorten
        // the run's own limit, MASON_STATEMENT_TIMEOUT)
        if (value === null) this.vars.other.delete(name); else this.vars.other.set(name, value);
        return;
      default: {
        // a parameter Mason knows nothing of: the catalog Postgres decides whether it exists
        if (atStartup) throw new PgError({ code: "42704", message: `unrecognized configuration parameter "${name}" in the startup packet` });
        if (value === null) this.vars.other.delete(name); else this.vars.other.set(name, value);
        return;
      }
    }
  }

  /**
   * RESET of one parameter: the value the session STARTED with — its startup packet's (`application_name`, `options`'s
   * `-c`) where it set one, else the default — as Postgres's RESET restores a parameter's session default. A placeholder
   * (`myapp.x`, a dotted name Postgres does not list) has '' for its default and stays defined, as on Postgres.
   */
  private async resetParameter(name: string): Promise<void> {
    const start = this.startupVars;
    switch (name) {
      case "timezone": case "time zone": this.vars.timeZone = start.timeZone; return;
      case "application_name": this.vars.applicationName = start.applicationName; return;
      case "search_path": this.vars.searchPath = start.searchPath; return;
    }
    this.setParameter(name, null);
    const was = start.other.get(name) ?? (await this.isPlaceholder(name) ? "" : undefined);
    if (was !== undefined) this.vars.other.set(name, was);
  }

  /** RESET ALL (and DISCARD ALL's): every parameter back to the session's start, the startup packet's included; a
   *  placeholder the session SET stays defined, '' (`resetParameter`) */
  private async resetAll(): Promise<void> {
    const placeholders: string[] = [];
    for (const name of this.vars.other.keys()) if (await this.isPlaceholder(name)) placeholders.push(name);
    const tx = this.settingsAtStart();
    this.vars = copyVars(this.startupVars);
    for (const name of placeholders) if (!this.vars.other.has(name)) this.vars.other.set(name, "");
    // a SET of every parameter: it overrides each LOCAL before it, and a ROLLBACK undoes it
    tx.commit = copyVars(this.vars);
  }

  /** a custom placeholder (`SET myapp.x`): a dotted name the catalog Postgres does not list (an extension's, `plpgsql.*`, it lists) */
  private async isPlaceholder(name: string): Promise<boolean> {
    return name.includes(".") && !(await this.server.catalogSettings()).has(name.toLowerCase());
  }

  /**
   * WHAT THE CLIENT IS TOLD OF ITS REPORTED PARAMETERS (GUC_REPORT): a ParameterStatus for each whose value is not the one
   * last reported — all of them at the startup, those a SET, a RESET, RESET ALL or DISCARD ALL moved after it — as
   * Postgres reports a changed one (`ReportChangedGUCOptions`), each value `sessionSetting`'s through `reportedParameters`.
   * A driver that caches them (pgjdbc, npgsql) was left with a SET's value after RESET ALL (GitHub issue 41). After the
   * startup, `ready` alone calls it: what a request moved is told once, before its ReadyForQuery.
   */
  private reportChanges(): Buffer[] {
    const out: Buffer[] = [];
    for (const [name, value] of this.reportedParameters()) {
      if (this.reported.get(name) === value) continue;
      this.reported.set(name, value);
      out.push(parameterStatus(name, value));
    }
    return out;
  }

  /**
   * A REQUEST'S END: the reported parameters it changed, then its ReadyForQuery — where Postgres 14+ reports them
   * (`ReportChangedGUCOptions` in PostgresMain, just before ReadyForQuery): after the statement's CommandComplete, and
   * ONCE per parameter per Query string or Sync, its last value (`SET application_name = 'a'; SET application_name =
   * 'b'` reports 'b' alone). With no block open the request's implicit transaction ends here, so what it reverted is
   * what is reported: a SET LOCAL told nothing, a block's revert is told by the ReadyForQuery that ends the block.
   */
  private ready(): Buffer[] {
    if (this.tx === "none") this.endTransaction(true);
    return [...this.reportChanges(), readyForQuery(this.txStatus())];
  }

  /**
   * A TRANSACTION'S END, explicit or implicit: the session's settings become what it leaves (`settingsTx`), as Postgres's
   * AtEOXact_GUC restores them, one level, since a SAVEPOINT is refused here. A placeholder a transaction defined stays
   * defined (`applySetting`); a transaction that set nothing changes nothing.
   */
  private endTransaction(committed: boolean): void {
    this.implicitBlock = false;
    if (this.settingsTx === null) return;
    this.vars = committed ? this.settingsTx.commit : this.settingsTx.rollback;
    this.settingsTx = null;
  }

  /**
   * A FAILED BLOCK ACCEPTS NOTHING BUT ITS END, on every message: Postgres checks a Query's statement, a Parse, a Bind and
   * an Execute (`IsTransactionExitStmt`), each before the statement is classified or sent anywhere, so 25P02 is said
   * where Mason's own refusal of it (an INSERT's 25006) or the catalog's answer would be. Undefined: an empty statement,
   * which a Bind refuses as it refuses any other. A Parse of an empty string passes (`parseMessage`), a Describe has its
   * own rule (`describedInFailedBlock`), and a Close always runs.
   */
  private heldToFailedBlock(stmt: Node | undefined): void {
    if (this.tx === "failed" && (stmt === undefined || !endsFailedBlock(stmt))) throw aborted();
  }

  /** A Describe in a failed block: refused where it would describe a result (Postgres reads the catalog for a
   *  RowDescription, which an aborted transaction cannot), answered otherwise, so a driver that describes all it sends
   *  can still send its ROLLBACK. */
  private describedInFailedBlock(statement: Statement): void {
    const kind = statement.shape?.kind;
    if (this.tx === "failed" && kind !== undefined && ["catalog", "duckdb", "explain", "show", "set_config"].includes(kind)) throw aborted();
  }

  /**
   * A STATEMENT FAILED, the one way a transaction fails: an open block is failed (25P02 until its end), and in every
   * case what the transaction set is undone NOW, as Postgres's AbortTransaction does at the error, never at the ROLLBACK
   * that follows — so the failed block's own ReadyForQuery reports the revert, and an implicit transaction's SET (`SET a;
   * SELECT 1/0`, or a pipeline's before its Sync) never took.
   */
  private abortTransaction(): void {
    if (this.tx === "open") this.tx = "failed";
    this.endTransaction(false);
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
      this.implicitBlock = false;
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
      this.abortTransaction();
      this.send(...this.ready());
      return;
    }
    if (stmts.length === 0) { this.send(emptyQueryResponse(), ...this.ready()); return; }
    for (const raw of stmts) {
      const text = statementText(sql, raw);
      this.asked = { sql: text, method: "QUERY", startedAt: Date.now(), sentAt: this.sentBytes };
      // at every statement, as Postgres's BeginImplicitTransactionBlock: a COMMIT among them ended the block before it
      if (stmts.length > 1) this.implicitBlock = true;
      try {
        const out = await this.runSimple(raw, text, sql);
        this.sendAll(out);
      } catch (err) {
        const e = asPgError(err, sql);
        this.refuse(e, text);
        this.abortTransaction();
        break;
      }
    }
    this.send(...this.ready());
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
    const response = errorResponse(e.fields);
    this.recordRequest(e, sql, undefined, [response]);
    this.traceRefusal(e, at);
    this.send(response);
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
  private recordRequest(answer: PgError | { rows: number; startedAt?: number }, sql?: string, refusedUser?: string, then: readonly Buffer[] = [],
    of?: { method: string; jsonReads: readonly string[] | undefined; carried: number }): void {
    // `of`: a statement recorded after its own messages (a portal dropped suspended), not the one being asked now: what
    // it sent is what its pages sent (`carried`), nothing since
    const asked: Asked | null = of === undefined ? this.asked
      : { sql: sql ?? "", method: of.method, startedAt: Date.now(), sentAt: this.sentBytes, carried: of.carried, ...(of.jsonReads !== undefined ? { jsonReads: of.jsonReads } : {}) };
    const startedAt = (!(answer instanceof PgError) ? answer.startedAt : undefined) ?? asked?.startedAt ?? Date.now();
    const bytesSent = this.bytesFor(then, asked);
    // a refusal's statement is the one refuse() names (a simple Query's own statement, an Execute's portal's)
    const stored = storedPayload(sql ?? asked?.sql ?? "");
    const user = this.token?.user ?? refusedUser;
    // the EFFECTIVE role: the user's own, else the roles file's default (what the statement was held to)
    const role = this.roleName();
    this.server.options.record({
      requestId: crypto.randomUUID(), at: new Date(startedAt), method: asked?.method ?? "QUERY", durationMs: Date.now() - startedAt,
      client: `postgres:${this.vars.applicationName || "unnamed"}`, session: this.id, payload: stored.text, payloadTruncated: stored.truncated,
      caller: hashCaller(this.presented), bytesSent,
      ...(user !== undefined ? { user } : {}),
      ...(role !== undefined ? { role } : {}),
      ...(this.token?.attributes !== undefined && Object.keys(this.token.attributes).length > 0 ? { attributes: this.token.attributes } : {}),
      ...(asked?.jsonReads !== undefined && asked.jsonReads.length > 0 ? { jsonReads: asked.jsonReads } : {}),
      ...(answer instanceof PgError
        ? { status: answer.status, sqlstate: answer.fields.code, error: answer.fields.message,
            ...(answer.fields.detail ? { detail: answer.fields.detail } : {}), ...(answer.fields.hint ? { hint: answer.fields.hint } : {}),
            ...(answer.gap !== null ? { gap: answer.gap } : {}) }
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
    this.heldToFailedBlock(raw.stmt);
    const t = this.classify(raw.stmt, text);
    switch (t.kind) {
      case "empty": return [emptyQueryResponse()];
      case "explain": {
        const e = await this.explaining(raw, whole, t, []);
        if (e.plan === null) return catalogExplained(await this.forwardSimple(this.spliced(text, raw)), e.options);
        const controller = new AbortController();
        const disarm = this.armTimeout(controller);
        try {
          const { field, rows } = await this.duckExplain({ options: e.options, plan: e.plan }, [], [], { parse: now, exec: now }, controller);
          const out = [rowDescription([field]), ...rows, commandComplete("EXPLAIN")];
          this.recordRequest({ rows: rows.length }, undefined, undefined, out);
          return out;
        } finally { disarm(); }
      }
      case "catalog": return this.forwardSimple(this.spliced(text, raw));
      case "set": return this.setStatement(t);
      // its RowDescription first, as Postgres's: a value it refuses is refused after it
      case "set_config": this.send(this.setConfigDescription(t, 0)); return this.setConfigStatement(t);
      case "show": return this.showStatement(t.name);
      case "transaction": return [...this.transaction(t.tag)];
      case "discard": return this.discard(t.target);
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
          const done = [commandComplete(`SELECT ${cursor.sent}`)];
          this.recordRequest({ rows: cursor.sent }, undefined, undefined, done);
          return done;
        } finally { disarm(); }
      }
    }
  }

  /** A DuckDB statement's plan (Postgres's analysis and the DuckDB SQL), kept per text, search_path, TimeZone,
   *  declared parameter types and the session's role until the schema or the roles change. Every statement DuckDB
   *  runs has one: never its text as written. */
  private async duckPlan(raw: RawStmt, whole: string, paramOids: readonly number[], under: { searchPath: string; timeZone: string } = this.vars, wireBound = false): Promise<DuckPlan> {
    const stmt = raw.stmt!;
    const bytes = Buffer.from(whole, "utf8");
    const base = raw.stmt_location ?? 0;
    const text = bytes.subarray(base, raw.stmt_len ? base + raw.stmt_len : bytes.length).toString("utf8");
    const { searchPath, timeZone } = under;
    const grants = this.grants();
    // the plan cache's key is the role the plan is held to: the effective one (a default's plans are that role's), and
    // a user with no role under a file with no default its own key, never a token's ("") — and, where the role filters
    // rows, the filters bound to the user's values (a plan holds them as literals)
    const rowsKey = rowsKeyOf(grants);
    const key = `${grants?.noRole !== undefined ? "\u0000no role" : this.roleName() ?? ""}${rowsKey === "" ? "" : `\u0000${rowsKey}`}`;
    return this.server.duckPlan(text, paramOids, searchPath, timeZone, wireBound, key, async () => {
      const plan = await this.server.options.duck.plan((b) => this.server.catalog.run(b), text, stmt, base, paramOids, searchPath, timeZone, this.server.userTypes(), wireBound, grants);
      return rowsKey === "" ? plan : { ...plan, rowsKey };
    });
  }

  /**
   * THE SESSION'S ROLE NOW (src/duck/grants.ts; docs/POSTGRES-API.md "Roles"): what its user's role may read, asked at
   * every plan, every Execute and every catalog read — the user's role is re-read with the user before each statement
   * (`stillLive`), the roles file whenever it changes (`PgApiOptions.roles`), so a role given, taken or edited applies at
   * the next statement, with no restart. undefined: no roles anywhere (nothing to hold, and no reads to record);
   * null: a session held to nothing beside roles — a token's (its plan still names its reads). FAIL CLOSED: a role the
   * file no longer names, or a file that cannot be read as it is now, refuses the statement by name, never widens.
   *
   * A USER WITH NO ROLE OF ITS OWN IS HELD TO WHAT THE FILE SAYS (stage 1b, never a default in the code): no roles file,
   * every copied table; the file's `default:`, that role (read here at every statement, so an edit of `default:` applies
   * at the next one); a file with no `default:`, nothing (`RoleGrants.noRole`: every statement that reads a copied table
   * refused with the two ways out, src/duck/grants.ts noRoleRefusal). A token, which is no user, reads every copied table.
   */
  private grants(): RoleGrants | null | undefined {
    const g = this.ownGrants();
    return g === null || g === undefined ? g : this.withRows(g);
  }

  /**
   * THE ROLE'S ROW FILTERS BOUND TO THIS SESSION'S USER (src/duck/row-filter.ts): each table's `where:` with the user's
   * attribute values as literals of the types the catalog inferred (`Server.checkRoles`), each `through:` read through
   * its parent. A USER WITHOUT A VALUE ITS ROLE'S FILTERS READ IS REFUSED, LOUDLY, at every statement — never answered
   * with no rows (a user added before the roles file gained the attribute): 42501, the attribute and the filter in the
   * DETAIL, the exact commands in the HINT. A filter not checked yet (the catalog a step behind the file) refuses the
   * statement, said: fail closed.
   */
  private withRows(g: RoleGrants): RoleGrants {
    if (g.filters === undefined || g.filters.size === 0) return g;
    const values = this.token?.attributes ?? {};
    const cached = this.boundRows;
    if (cached !== null && cached.of === g && cached.values === values) return cached.bound;
    const user = this.token?.user ?? this.user;
    const missing = missingAttributes(g.filters.values(), values);
    if (missing.length > 0) {
      const sets = missing.map((m) => `--set ${m.attr}=<value>`).join(" ");
      const shapes = g.attributes ?? new Map();
      throw new PgError({ code: "42501", message: `permission denied: the user ${JSON.stringify(user)} has no value for the attribute ${missing.map((m) => m.attr).join(", ")}, which the role ${g.name} filters rows by`,
        detail: missing.map((m) => `${m.at} reads :${m.attr} (${m.where})${shapes.get(m.attr) === "list" ? `, a list: one --set ${m.attr}=… per value` : ""}`).join("; ") + `; the user was added without it, and Mason refuses rather than answer no rows`,
        hint: `mason user remove ${user} && mason user add ${user} --role ${g.name} ${sets}` }, 403);
    }
    const rows = new Map<string, BoundFilter>();
    for (const f of g.filters.values()) {
      if (f.where === undefined) { rows.set(f.table, bindFilter(f, new Map(), values)); continue; }
      const types = g.filterTypes?.get(f.table);
      // a table not copied yet has no types (nothing reads it: the statement is Postgres's 42P01); a copied one must
      if (types === undefined) {
        if (g.filterTypes === undefined) {
          throw new PgError({ code: "57P03", message: `the role ${g.name}'s row filters are being checked by the catalog: run the statement again in a moment`, hint: "the catalog Postgres checks each where: of the roles file as it changes" }, 503);
        }
        continue;
      }
      rows.set(f.table, bindFilter(f, types, values));
    }
    const bound = { ...g, rows, ...(user !== undefined ? { rowsUser: user } : {}) };
    this.boundRows = { of: g, values, bound };
    return bound;
  }
  private boundRows: { of: RoleGrants; values: AttributeValues; bound: RoleGrants } | null = null;

  /** the role the session is held to now, its filters unbound (`grants` binds them) */
  private ownGrants(): RoleGrants | null | undefined {
    const live = this.server.rolesChecked();
    const own = this.token?.role;
    const user = this.token?.user ?? this.user;
    if (own === undefined) {
      if (this.token?.user === undefined || live.file === null) return live.grants.size === 0 ? undefined : null;
      if (live.problem !== null) {
        throw new PgError({ code: "57P03", message: `the roles file cannot be read as it is now, so the statements of the user ${JSON.stringify(user)} are refused: the user has no role of its own and the file's default cannot be read: ${live.problem}`,
          hint: `fix ${live.file}: a user with no role is held to its default: line` }, 503);
      }
      if (live.default !== null) return live.grants.get(live.default) ?? this.notInFile(live, live.default, user);
      return { name: "", file: live.file, tables: new Map(), all: false, noRole: { user, example: exampleRole(live) } };
    }
    if (live.problem !== null) {
      throw new PgError({ code: "57P03", message: `the roles file cannot be read as it is now, so the role ${own}'s statements are refused: ${live.problem}`,
        hint: `fix ${live.file ?? "the roles file"}: the role ${own} is the user ${JSON.stringify(user)}'s` }, 503);
    }
    return live.grants.get(own) ?? this.notInFile(live, own, user);
  }

  /** a role the roles file does not name (now): refused by name, never widened */
  private notInFile(live: RolesLive, role: string, user: string): never {
    const named = [...live.grants.keys()];
    throw new PgError({ code: "42501", message: `permission denied: the role ${role} of the user ${JSON.stringify(user)} is not in ${live.file ?? "the project's roles file (mason/roles.yml)"}`,
      detail: `the user keeps the role it was added with; a role the file no longer names reads nothing until it is added again or the user is made again${named.length ? ` (the roles: ${named.join(", ")})` : " (the file names no role)"}`,
      hint: `add the role ${role} to ${live.file ?? "mason/roles.yml"}, or mason user remove ${user} and mason user add ${user}${named.length ? ` --role ${named[0]}` : ""}` }, 403);
  }

  /**
   * THE ROLE THE SESSION IS HELD TO NOW, by name — the user's own, else (a user with none) the roles file's `default:`;
   * undefined for a token, with no roles file, under a file with no default, or one that cannot be read (`grants`
   * refuses that). Read by the catalog's `SET ROLE` (`catalogAs`), the plan cache's key and the request log's `role`,
   * so each says the role the statement was held to. Never throws (the request log reads it).
   */
  private roleName(): string | undefined {
    const own = this.token?.role;
    if (own !== undefined) return own;
    if (this.token?.user === undefined) return undefined;
    const live = this.server.rolesNow();
    return live.file !== null && live.problem === null ? live.default ?? undefined : undefined;
  }

  /**
   * THE CATALOG'S ROLE OF THIS SESSION NOW: the effective role (`roleName`), or — for a user the file holds to nothing
   * (no role, no `default:`) — `NO_ROLE_CATALOG`, a role with no grant, so information_schema lists it nothing and every
   * privilege function is false, as on Postgres for a login with no grant. Undefined: the catalog's own (a token, no
   * roles file). Throws where `grants` refuses (fail closed).
   */
  private catalogRole(): string | undefined {
    return this.grants()?.noRole !== undefined ? NO_ROLE_CATALOG : this.roleName();
  }

  /** a user the roles file holds to nothing (no role of its own, no `default:`), read without throwing: its catalog
   *  statements answer `current_user`, `current_role` and `user` as its own name (`userSpliced`), as Postgres does for
   *  a login with no grant, never the catalog role's */
  private heldToNothing(): boolean {
    if (this.token?.role !== undefined || this.token?.user === undefined) return false;
    const live = this.server.rolesNow();
    return live.file !== null && live.problem === null && live.default === null;
  }

  /** the statement as the catalog runs it for this session: the user's name spliced for the keywords that name it */
  private spliced(text: string, raw: RawStmt): string {
    return userSpliced(text, raw.stmt, raw.stmt_location ?? 0, this.user, this.heldToNothing() ? HELD_TO_NOTHING_OPS : SESSION_OPS);
  }

  /** a plan's reads held to the session's role of THIS moment (a role given or taken since the Parse): refused as the
   *  Parse would have refused it; a plan made before any role existed has no reads, and is planned again at its next Parse */
  private heldToRole(plan: DuckPlan): void {
    const grants = this.grants();
    if (grants === null || grants === undefined) return;
    if (plan.reads === undefined && grants.noRole === undefined) {
      throw new PgError({ code: "42501", message: `permission denied: the statement was prepared before the user ${JSON.stringify(this.token?.user ?? this.user)} had the role ${grants.name}`,
        hint: "prepare the statement again: its reads are then held to the role" }, 403);
    }
    if (plan.reads === undefined) {
      // a plan made before any roles file existed, for a user the file now holds to nothing: prepared again, held then
      throw new PgError({ code: "42501", message: `permission denied: the statement was prepared before ${grants.file} held the user ${JSON.stringify(grants.noRole!.user)} to a role`,
        hint: "prepare the statement again: its reads are then held to the roles file" }, 403);
    }
    const refused = grantRefusal(plan.reads, grants);
    if (refused !== null) throw refused;
    // a plan holds the filters it was made under as literals: one made under others (the roles file edited since its
    // Parse) never runs — executeDuck plans it again first, so this is the last guard
    if ((plan.rowsKey ?? "") !== rowsKeyOf(grants)) {
      throw new PgError({ code: "42501", message: "permission denied: the statement was prepared under other row filters of its role", hint: "prepare the statement again: it is then held to the role's filters as they are now" }, 403);
    }
  }

  /**
   * A CATALOG REQUEST OF THIS SESSION, WITH ITS SETTINGS AND AS ITS ROLE (src/api/postgres/catalog.ts asSession, asRole):
   * every request carries the session's settings (`sessionSettings`), so `current_setting(name)` answers what `SHOW`
   * does, and a session with a role runs its catalog statements under `SET ROLE`, RESET after, each in the one request
   * the catalog runs whole, so `information_schema`,
   * `has_table_privilege` and `has_column_privilege` answer for the role and no other session's request meets it. A
   * role the catalog has not made yet (its rebuild a moment behind the file) refuses the statement, said; a role the
   * file no longer names is refused before it reaches the catalog (`grants`).
   */
  private async catalogAs(message: Buffer): Promise<Array<{ type: string; frame: Buffer }>> {
    // fail closed first (a role the file lacks, a file that cannot be read), then the catalog's role of the session
    // (`catalogRole`; both read the roles once, with no await between)
    const role = this.catalogRole();
    const reply = unwrapSession(splitFrames(await this.server.catalog.run(asSession(role === undefined ? message : asRole(message, role), this.sessionSettings()))));
    if (role === undefined) return reply;
    const { frames, setRoleRefused } = unwrapRole(reply);
    if (setRoleRefused !== null) {
      const e = relayedError(setRoleRefused);
      throw new PgError({ code: "42501", message: `permission denied: the catalog has no role ${role} yet (${e.message})`, hint: "run the statement again: the catalog is rebuilt with the roles as the roles file changes" }, 403);
    }
    return frames;
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
      const grants = this.grants();
      plan = await this.server.options.duck.plan((b) => this.server.catalog.run(b), found.text, t.query, base + Buffer.byteLength(text.slice(0, found.offset)), paramOids,
        this.vars.searchPath, this.vars.timeZone, this.server.userTypes(), false, grants);
      // the row filters it was made under, as every plan of a session carries them (Session.duckPlan)
      const rowsKey = rowsKeyOf(grants);
      if (rowsKey !== "") plan = { ...plan, rowsKey };
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
    this.heldToRole(e.plan);
    // ANALYZE RUNS THE STATEMENT AND REPORTS WHAT THE ENGINE DID, which is a count of what it read and what it proved
    // of the whole table: nothing of it can be said to a filtered user, so there is nothing left to run it for
    const filtered = e.plan.rowFilters ?? [];
    if (e.options.analyze && filtered.length > 0) {
      throw gapRefusal("roles", `EXPLAIN ANALYZE is not answered for a statement that reads a table the role filters (${filtered.map((f) => f.table).join(", ")})`,
        "EXPLAIN without ANALYZE says the tables and what is sent to the engine; a user with no row filter reads the full plan and its rows");
    }
    await this.readAside();
    const runner = await this.duck();
    this.running = controller;
    try {
      const values = filtered.length > 0 ? [] : await this.duckValues(e.plan, params, clock);
      const lines = await runner.explain(e.plan.sql, values, await this.duckSession(), controller.signal,
        { options: e.options, fields: e.plan.fields, exact: e.plan.exact ?? [], planning: e.plan.timing ?? { analysisMs: 0, rewriteMs: 0 },
          // how each copy is kept current, as the sync says it to mason status, read now (src/duck/sync.ts KeptCurrent)
          copies: copyFacts(this.server.options.duck.copies?.() ?? []), ...(filtered.length > 0 ? { rowFilters: filtered, reads: (e.plan.reads ?? []).map((r) => r.table) } : {}) });
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

  /**
   * WHAT A DUCKDB STATEMENT OF THIS SESSION RUNS UNDER: its TimeZone and search_path, and every setting
   * `current_setting(name)` reads beside a copied table (src/duck/rewrite.ts) — the catalog Postgres's own
   * (`Server.catalogSettings`) with the session's laid over (`sessionSettings`), as the catalog's `current_setting`
   * answers them, never DuckDB's own settings.
   */
  private async duckSession(): Promise<DuckSession> {
    const settings = new Map([...await this.server.catalogSettings(), ...this.sessionSettings()]);
    return { timeZone: settings.get("timezone") ?? "UTC", searchPath: settings.get("search_path") ?? "", settings: Object.fromEntries(settings) };
  }

  /** A DuckDB statement run: its columns (Postgres's, where it has a plan), and its rows to read, encoded in the
   *  formats asked */
  private async duckAnswer(plan: DuckPlan, params: readonly (string | null)[], resultFormats: number[], clock: { parse: number; exec: number },
    controller: AbortController): Promise<{ fields: FieldDescription[]; cursor: DuckCursor }> {
    this.readsOf(plan);
    this.heldToRole(plan);
    await this.readAside();
    const runner = await this.duck();
    this.running = controller;
    try {
      const values = await this.duckValues(plan, params, clock);
      const a = await runner.run(plan.sql, values, await this.duckSession(), controller.signal, plan.fields, plan.exact ?? []);
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
    if (this.asked !== null) this.asked.rows = c.sent;
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
      this.recordRequest({ rows: c.sent, startedAt: c.startedAt }, portal.statement.sql, undefined, [], { method: "EXECUTE", jsonReads: portal.statement.duck?.jsonReads, carried: portal.bytes });
    }
    c?.answer.close();
    this.portals.delete(name);
  }

  private dropPortals(): void { for (const name of [...this.portals.keys()]) this.dropPortal(name); }

  private async forwardSimple(text: string): Promise<Buffer[]> {
    const reply = await this.catalogAs(frame("Q", cstr(text)));
    const err = reply.find((f) => f.type === "E");
    if (err !== undefined) throw relayedError(err.frame);
    return reply.filter((f) => f.type !== "Z").map((f) => f.frame);
  }

  /** SET and RESET as statements. SET LOCAL and SET TRANSACTION (`local`) outside a block are Postgres's WARNING, said
   *  before the value is read, so an invalid value is refused after it. The value still holds to the end of its own
   *  transaction: to the Sync, in a batch. */
  private async setStatement(t: Extract<Translation, { kind: "set" }>): Promise<Buffer[]> {
    if (t.local && this.tx === "none" && !this.implicitBlock) {
      this.send(noticeResponse({ severity: "WARNING", code: "25P01", message: `${t.name === "transaction" ? "SET TRANSACTION" : "SET LOCAL"} can only be used in transaction blocks` }));
    }
    return this.applySetting(t);
  }

  /** A SET's effect, whoever asked (a statement, `set_config`): `vars` is moved, and a plain SET stays for the
   *  transaction's COMMIT (`settingsTx`, the transaction's first one snapshots it). */
  private async applySetting(t: Extract<Translation, { kind: "set" }>): Promise<Buffer[]> {
    if (t.name === "all") { await this.resetAll(); return [commandComplete("RESET")]; }
    // SET ROLE and SET SESSION AUTHORIZATION: a session is its user and becomes no one else — RESET, NONE and its own
    // name are Postgres's no-ops, any other name Postgres's refusal. Never the catalog's to validate: that is one
    // superuser connection, which accepted `SET ROLE postgres` silently (a review finding of #35)
    if (t.name === "role" || t.name === "session_authorization") {
      // its own name, NONE, RESET — and SET ROLE to the role it already is (its own, or the roles file's default: what
      // current_user says), which Postgres always allows; SET SESSION AUTHORIZATION is the login's name alone
      const own = t.value === null || t.value === this.user || (t.name === "role" && (t.value.toLowerCase() === "none" || t.value === this.roleName()));
      if (!own) throw new PgError({ code: "42501", message: `permission denied to set ${t.name === "role" ? "role" : "session authorization"} "${t.value}"` }, 403);
      return [commandComplete(t.tag)];
    }
    // a user's attributes are the users file's (mason user add --set), never the session's to change: Postgres's refusal
    // of a parameter a role may not set
    if (t.name.toLowerCase().startsWith("mason.attr.")) throw new PgError({ code: "42501", message: `permission denied to set parameter "${t.name}"`, hint: "a user's attributes are set by mason user add --set, never by the session" }, 403);
    // a placeholder (`myapp.x`) is validated here: a SET the catalog validated left it DEFINED there, with '', for every
    // session (a `current_setting` of it answered '' where Postgres's is 42704) — its rollback undoes the value, not that
    const placeholder = await this.isPlaceholder(t.name);
    if (placeholder) placeholderName(t.name);
    else if (!this.decidesHere(t.name)) await this.validateElsewhere(t.name, t.value);
    const tx = this.settingsAtStart();
    if (t.value === null) await this.resetParameter(t.name); else this.setParameter(t.name, t.value);
    if (!t.local) copySetting(t.name, this.vars, tx.commit);
    // once named a placeholder stays defined, '', whichever way the transaction ends: its definition is no value it undoes
    if (placeholder) for (const v of [tx.rollback, tx.commit]) if (!v.other.has(t.name)) v.other.set(t.name, "");
    return [commandComplete(t.tag)];
  }

  /** what the transaction found, kept at its first SET (`settingsTx`) */
  private settingsAtStart(): { rollback: Vars; commit: Vars } {
    return this.settingsTx ??= { rollback: copyVars(this.vars), commit: copyVars(this.vars) };
  }

  /** `SELECT set_config(name, value, is_local)` alone (translate.ts setConfig): the session's SET or SET LOCAL, answered
   *  as Postgres answers the function — one text row, the value as `SHOW` then answers it (its own DataRow: one reader),
   *  the column named `set_config` or as aliased. Its RowDescription is the caller's: a Query's, an Execute's Describe's.
   *  Unlike SET LOCAL it warns of nothing outside a block: Postgres's function does not. */
  private async setConfigStatement(t: Extract<Translation, { kind: "set_config" }>): Promise<Buffer[]> {
    await this.applySetting({ kind: "set", name: t.name, value: t.value, local: t.local, tag: "SET" });
    const row = (await this.showStatement(t.name)).find((f) => f[0] === DATA_ROW);
    if (row === undefined) throw new PgError({ code: "XX000", message: `SHOW ${t.name} answered no row after set_config (Mason bug: report it)` }, 500);
    return [row, commandComplete("SELECT 1")];
  }

  private setConfigDescription(t: Extract<Translation, { kind: "set_config" }>, format: 0 | 1): Buffer {
    return rowDescription([fieldOf(t.column, "text", format)]);
  }

  /** DISCARD ALL is Postgres's CLOSE ALL, DEALLOCATE ALL and RESET ALL (its ParameterStatus with it) in one; PLANS,
   *  SEQUENCES and TEMP find nothing of theirs here */
  private async discard(target: string): Promise<Buffer[]> {
    if (target !== "ALL") return [commandComplete(`DISCARD ${target}`)];
    if (this.tx !== "none" || this.implicitBlock) throw new PgError({ code: "25001", message: "DISCARD ALL cannot run inside a transaction block" });
    this.statements.clear();
    this.dropPortals();
    await this.resetAll();
    // it commits at once, what follows it in a batch being a transaction of its own (XACT_FLAGS_NEEDIMMEDIATECOMMIT)
    this.endTransaction(true);
    return [commandComplete("DISCARD ALL")];
  }

  private decidesHere(name: string): boolean {
    return ["timezone", "time zone", "application_name", "search_path", "client_encoding", "names", "datestyle", "extra_float_digits",
      "standard_conforming_strings", "intervalstyle", "transaction_isolation", "default_transaction_isolation", "transaction", "session characteristics",
      "default_transaction_read_only", "transaction_read_only"].includes(name);
  }

  /**
   * WHAT THIS SESSION ANSWERS FOR ONE PARAMETER, by its name in any case: `SHOW <name>`, SHOW ALL's row of that name and
   * the ParameterStatus the startup reports all read it, so a tool reads ONE string however it asks. The TLS parameters
   * first (`tlsParameters`), then those this server fixes (`fixedParameter`), then the session's own SETs (`vars.other`);
   * null for one the catalog Postgres answers as its own.
   */
  private sessionSetting(name: string): string | null {
    const n = name.toLowerCase();
    return tlsParameters(this.socket instanceof tls.TLSSocket)[n] ?? fixedParameter(n, this.vars, this.user) ?? attributeSetting(n, this.token?.attributes) ?? this.vars.other.get(n) ?? null;
  }

  /**
   * EVERY PARAMETER THIS SESSION HOLDS, each `sessionSetting`'s: what `current_setting(name)` answers, in the catalog
   * (`catalogAs`, src/api/postgres/catalog.ts asSession) and beside a copied table (`duckSession`) — so it is the string
   * `SHOW <name>` answers, however a tool asks (GitHub issue 40). The names are those `sessionSetting` reads from.
   */
  private sessionSettings(): Map<string, string> {
    const names = new Set([...Object.keys(tlsParameters(this.socket instanceof tls.TLSSocket)), ...FIXED.keys(), ...this.vars.other.keys(),
      // the user's attributes, as `mason.attr.<name>` (a list's values joined by commas): what the catalog's row security
      // policies read (catalog.ts catalogPolicies), as Postgres's read `current_setting('mason.attr.tenant')`
      ...Object.keys(this.token?.attributes ?? {}).map((a) => `mason.attr.${a}`)]);
    const out = new Map<string, string>();
    for (const n of names) { const v = this.sessionSetting(n); if (v !== null) out.set(n, v); }
    return out;
  }

  private async showStatement(name: string): Promise<Buffer[]> {
    if (name === "all") return this.showAll();
    const value = this.sessionSetting(name);
    if (value === null) {
      // a placeholder this session never SET is none of its settings, whatever the one catalog every session shares
      // has defined (a forwarded `set_config` defines one there): Postgres's 42704
      if (await this.isPlaceholder(name)) throw new PgError({ code: "42704", message: `unrecognized configuration parameter "${name}"` });
      const reply = splitFrames(await this.server.catalog.run(frame("Q", cstr(`SHOW ${quoteIdent(name)}`))));
      const err = reply.find((f) => f.type === "E");
      if (err !== undefined) throw relayedError(err.frame);
      return reply.filter((f) => f.type !== "Z").map((f) => f.frame);
    }
    return [rowDescription([fieldOf(spell(name), "text", 0)]), dataRow([Buffer.from(value, "utf8")]), commandComplete("SHOW")];
  }

  /**
   * SHOW ALL (Postico sends it at every connection): the catalog Postgres's own answer — its RowDescription relayed as it
   * is (name, setting, description: text, as Postgres's), a row per parameter in its order — with the setting of each row
   * this session decides replaced by `sessionSetting`'s, so the row and `SHOW <name>` are one string. Mason's settings,
   * never the source database's (Mason gap show-all). A parameter Postgres's SHOW ALL leaves out is left out here too,
   * though the session set it or reports it: a placeholder (`SET myapp.x`), session_authorization, is_superuser, role
   * (GUC_NO_SHOW_ALL) — the catalog, a Postgres, lists exactly the names Postgres lists.
   */
  private async showAll(): Promise<Buffer[]> {
    const reply = splitFrames(await this.server.catalog.run(frame("Q", cstr("SHOW ALL"))));
    const err = reply.find((f) => f.type === "E");
    if (err !== undefined) throw relayedError(err.frame);
    return reply.filter((f) => f.type !== "Z").map((f) => {
      if (f.type !== "D") return f.frame;
      const [row] = decodeBackend(f.frame);
      const name = row?.type === "DataRow" && row.values.length === 3 ? row.values[0] : null;
      if (row?.type !== "DataRow" || name === null || name === undefined) {
        throw new PgError({ code: "XX000", message: "the catalog Postgres answered SHOW ALL with a row other than name, setting, description (Mason bug: report it)" }, 500);
      }
      const value = this.sessionSetting(name.toString("utf8"));
      return value === null ? f.frame : dataRow([name, Buffer.from(value, "utf8"), row.values[2] ?? null]);
    });
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
    // the implicit transaction's end too: `SET a; ROLLBACK` in one Query undoes the SET, with the same warning
    const wasFailed = this.tx === "failed";
    this.endTransaction(tag === "COMMIT" && !wasFailed);
    if (this.tx === "none") { return [noticeResponse({ severity: "WARNING", code: "25P01", message: "there is no transaction in progress" }), commandComplete(tag)]; }
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
      this.send(...this.ready());
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
        case "Execute": {
          const out = await this.executeMessage(m);
          this.sendAll(out);
          // AN EXECUTE LEAVES ITS TRANSACTION OPEN UNTIL THE SYNC, and what follows it runs in an implicit block, as
          // Postgres 18's does, a portal suspended at a row count included: a later SET LOCAL warns of nothing, a later
          // DISCARD ALL is refused. Not after a transaction statement, which ended it, nor a DISCARD ALL, whose portal
          // it dropped
          const kind = this.portals.get(m.portal)?.statement.shape?.kind;
          if (kind !== undefined && kind !== "transaction") this.implicitBlock = true;
          return;
        }
        case "Close": return this.sendAll(await this.closeMessage(m));
      }
    } catch (err) {
      const e = asPgError(err, sql);
      this.refuse(e, sql, m.type);
      this.skipToSync = true;
      this.abortTransaction();
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
    const reply = await this.catalogAs(Buffer.concat(parts));
    // the sidecar answered NOTHING to a batch: it is ignoring everything until a Sync (an earlier error nobody synced)
    // — a protocol state this server must never leave it in; said, never relayed as an empty answer
    if (reply.length === 0) throw new PgError({ code: "XX000", message: "the catalog Postgres answered nothing: report it (its extended-protocol state is out of step)" }, 500);
    const err = reply.find((f) => f.type === "E");
    if (err !== undefined) {
      // AFTER AN ERROR IN THE EXTENDED PROTOCOL POSTGRES IGNORES EVERY MESSAGE UNTIL A SYNC (ignore_till_sync), and the
      // sidecar is one connection every session shares: one refused Parse with no Sync after it silenced the catalog for
      // every session until a restart (review of #480). Every request carries one (catalog.ts asSession: the RESET of
      // the session's settings after it must run), its ReadyForQuery dropped here
      throw relayedError(err.frame);
    }
    return reply.filter((f) => f.type !== "Z").map((f) => f.frame);
  }

  private async parseMessage(m: Extract<FrontendMessage, { type: "Parse" }>): Promise<Buffer[]> {
    const stmts = (await parseSql(m.sql)).stmts ?? [];
    if (stmts.length > 1) throw new PgError({ code: "42601", message: "cannot insert multiple commands into a prepared statement" });
    const raw = stmts[0] ?? null;
    if (raw?.stmt !== undefined) this.heldToFailedBlock(raw.stmt);
    if (m.name !== "" && this.statements.has(m.name)) throw new PgError({ code: "42P05", message: `prepared statement "${m.name}" already exists` });
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
        const reply = await this.catalogRun(...close, frame("P", cstr(statement.catalogName), cstr(this.spliced(m.sql, raw)),
          int16(m.paramTypes.length), ...m.paramTypes.map(int32)));
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
    // before anything runs: a catalog statement is run whole at its Bind
    this.heldToFailedBlock(statement.raw?.stmt);
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
      this.portals.set(m.portal, { statement, params: [], boundAt: this.server.now(), resultFormats: m.resultFormats, rows: null, sent: 0, fields: null, bytes: 0,
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
      const oid = statement.paramOids[i] || planned?.params[i] || 0;
      if (TEXT_ARRAYS.has(oid)) return textArrayFromBinary(p, i, oid === 1015 ? 1043 : 25);
      const type = oidOf(statement.paramOids[i] ?? 0) ?? (planned !== undefined ? oidOf(planned.params[i] ?? 0) : undefined) ?? "text";
      return decodeBinaryParam(type, p, i);
    });
    // the Bind is the statement's instant, and begins the implicit transaction when none is open
    const boundAt = this.server.now();
    this.txNow ??= boundAt;
    this.dropPortal(m.portal);
    this.portals.set(m.portal, { statement, params, boundAt, resultFormats: m.resultFormats, rows: null, sent: 0, fields: null, bytes: 0 });
    return [bindComplete()];
  }

  private async describeMessage(m: Extract<FrontendMessage, { type: "Describe" }>): Promise<Buffer[]> {
    if (m.kind === "S") {
      const statement = this.statements.get(m.name);
      if (statement === undefined) throw new PgError({ code: "26000", message: `prepared statement "${m.name}" does not exist` });
      this.describedInFailedBlock(statement);
      if (statement.catalogName !== null) return this.catalogRun(frame("D", Buffer.from("S"), cstr(statement.catalogName)));
      const shape = statement.shape;
      if (shape?.kind === "show") return [parameterDescription([]), ...await this.showDescription(shape.name)];
      if (shape?.kind === "set_config") return [parameterDescription([]), this.setConfigDescription(shape, 0)];
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
    this.describedInFailedBlock(portal.statement);
    if (portal.catalog !== undefined) return [portal.catalog.description];
    const shape = portal.statement.shape;
    if (shape?.kind === "show") return this.showDescription(shape.name);
    if (shape?.kind === "set_config") return [this.setConfigDescription(shape, formatAt(portal.resultFormats, 0))];
    if (portal.statement.explain !== undefined) return [rowDescription([explainField(portal.statement.explain.options, formatAt(portal.resultFormats, 0))])];
    const d = portal.statement.duck;
    if (d !== undefined) return [d.fields !== null && d.fields.length ? rowDescription(d.fields.map((c, i) => ({ name: c.name, typeOid: c.oid, typeSize: c.size, typeModifier: c.typmod, format: formatAt(portal.resultFormats, i) }))) : noData()];
    return [noData()];
  }

  private async executeMessage(m: Extract<FrontendMessage, { type: "Execute" }>): Promise<Buffer[]> {
    const portal = this.portals.get(m.portal);
    if (portal === undefined) throw new PgError({ code: "34000", message: `portal "${m.portal}" does not exist` });
    const statement = portal.statement;
    if (statement.raw?.stmt === undefined) return [emptyQueryResponse()];
    // a catalog portal's rows are held here since its Bind: a block that failed after it answers none of them
    this.heldToFailedBlock(statement.raw.stmt);
    if (portal.catalog !== undefined) {
      const c = portal.catalog;
      const take = m.maxRows > 0 ? Math.min(m.maxRows, c.rows.length - c.sent) : c.rows.length - c.sent;
      const out = c.rows.slice(c.sent, c.sent + take);
      c.sent += take;
      return c.sent < c.rows.length ? [...out, portalSuspended()] : [...out, c.done];
    }
    // what its earlier Executes sent is this one's row's too (`bytesFor`)
    if (this.asked !== null) this.asked.carried = portal.bytes;
    const t = statement.shape ?? this.classify(statement.raw.stmt, statementText(statement.sql, statement.raw));
    switch (t.kind) {
      case "empty": return [emptyQueryResponse()];
      case "catalog": throw new PgError({ code: "XX000", message: "a catalog statement bound as a query (Mason bug: report it)" }, 500);
      case "set": return this.setStatement(t);
      case "set_config": return this.setConfigStatement(t);
      // as Postgres: the extended protocol's Execute sends the rows and the tag, the RowDescription is the Describe's
      case "show": return (await this.showStatement(t.name)).filter((f) => f[0] !== ROW_DESCRIPTION);
      case "transaction": return this.transaction(t.tag);
      case "discard": return this.discard(t.target);
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
        if (portal.sent < rows.length) return this.pageSent(portal, [...out, portalSuspended()]);
        const done = [...out, commandComplete("EXPLAIN")];
        this.recordRequest({ rows: rows.length }, undefined, undefined, done);
        return done;
      }
    }
  }

  /**
   * THE BYTES SENT FOR THE STATEMENT BEING ASKED, `then` (the frames that end it, sent just after) among them: what its
   * portal's earlier Executes sent (`carried`), and what the session was written since this message arrived — exact,
   * since one message is handled at a time and a portal read aside meanwhile is read, never sent (`readAside`). Never
   * the session's bytes since a portal's first Execute: another portal's rows sent between two of its Executes were
   * counted in both rows.
   */
  private bytesFor(then: readonly Buffer[], asked: Asked | null = this.asked): number {
    return (asked?.carried ?? 0) + this.sentBytes - (asked?.sentAt ?? this.sentBytes) + then.reduce((n, b) => n + b.length, 0);
  }

  /** a page of a portal, suspended: what it sends is kept on the portal (`Portal.bytes`) for its last Execute's row */
  private pageSent(portal: Portal, frames: Buffer[]): Buffer[] {
    portal.bytes = this.bytesFor(frames);
    return frames;
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
      if (statement.duck === undefined) throw new PgError({ code: "XX000", message: "a statement without its plan: report it (Mason's Postgres listener)" });
      // A ROLE'S ROW FILTERS MOVED SINCE THE PARSE (the roles file edited): planned again under them, as Postgres plans a
      // prepared statement again after its policies change — where its columns and parameters are what the Parse said
      if (statement.raw !== null && (statement.duck.rowsKey ?? "") !== rowsKeyOf(this.grants())) {
        const again = await this.duckPlan(statement.raw, statement.sql, statement.paramOids, statement.plannedUnder ?? this.vars);
        const shape = (p: DuckPlan): string => JSON.stringify([p.params, p.fields?.map((f) => [f.name, f.oid, f.typmod]) ?? null]);
        if (shape(again) === shape(statement.duck)) { statement.duck = again; delete statement.duckOnWire; }
      }
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
        const done = [commandComplete(`SELECT ${c.sent}`)];
        this.recordRequest({ rows: c.sent, startedAt: c.startedAt }, undefined, undefined, done);
        return done;
      }
      // at most maxRows (JDBC's fetch size, a cursor): suspended while a row is left, read one chunk ahead to know it
      while (!c.done && c.pending.length <= m.maxRows) await this.fill(c);
      const out = c.pending.splice(0, m.maxRows);
      c.sent += out.length;
      // suspended: its row is written at its last Execute, or when it is dropped (dropPortal), with what its pages sent
      if (c.pending.length > 0) { c.suspended = true; return this.pageSent(portal, [...out, portalSuspended()]); }
      c.answer.close();
      c.recorded = true;
      const done = [...out, commandComplete(`SELECT ${c.sent}`)];
      this.recordRequest({ rows: c.sent, startedAt: c.startedAt }, undefined, undefined, done);
      return done;
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
    const recheck = this.door.recheck;
    const user = this.token?.user;
    if (recheck === undefined || user === undefined) return null;
    const now = this.server.now();
    if (now - this.verifiedAt < this.door.recheckMs) return null;
    try {
      // the user as the file has it NOW: its role given or taken since applies to this statement
      const fresh = await recheck(this.token!);
      if (fresh !== undefined && this.token !== null) this.token = fresh;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // could not tell: this statement is refused, the session kept, and the next statement asks again
      if (err instanceof ApiError && err.status === 503) return new PgError({ code: "57P03", message, hint: "run the statement again once Mason can read its list of users" }, 503);
      if (err instanceof ApiError) this.recordRefusal(asked.toUpperCase(), err);
      this.fatal("28000", `the session's user is no longer accepted: ${message}`, this.door.public ? this.door.loginHint : err instanceof ApiError && err.code === USER_DISABLED
        ? `a disabled user's sessions end at their next statement; mason user enable ${user} lets it connect again, with the same password`
        : `a removed user's sessions end at their next statement; mason user add ${user} makes it again, with a new password`);
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

/** the SQLValueFunction ops that name a user, each with its keyword (the text at its location, and its column's name) */
const USER_OPS: Readonly<Record<string, string>> = { SVFOP_SESSION_USER: "session_user", SVFOP_CURRENT_USER: "current_user", SVFOP_CURRENT_ROLE: "current_role", SVFOP_USER: "user" };
/** every session: `session_user` alone (`current_user` is the catalog's role: the session's role under SET ROLE) */
const SESSION_OPS: ReadonlySet<string> = new Set(["SVFOP_SESSION_USER"]);
/** a user the roles file holds to nothing: its catalog role is `NO_ROLE_CATALOG`, never a name it should answer */
const HELD_TO_NOTHING_OPS: ReadonlySet<string> = new Set(Object.keys(USER_OPS));
/** `userSpliced`'s mark for the `pg_catalog.` of a qualified `current_setting`, never a keyword's text */
const SETTING = "\u0000setting";

/**
 * WHAT A STATEMENT THE CATALOG ANSWERS READS OF ITS SESSION, spliced in its text at the parse tree's locations:
 * - `session_user` IS THIS SESSION'S USER, never the catalog's superuser (it answered `postgres` for every session while
 *   `SHOW session_authorization` said the user's name: a review finding of #35). The keyword cannot be overridden as
 *   `version()` and `current_setting` are, so each one of `ops` is spliced with a scalar subquery named as the keyword
 *   names its column, `(SELECT 'agent'::name AS session_user)`: the name, the type and every expression around it stay
 *   Postgres's. `current_user`, `current_role` and `user` are the catalog's role (the session's role under SET ROLE,
 *   src/api/postgres/catalog.ts asRole), spliced only for a user the roles file holds to nothing
 *   (`HELD_TO_NOTHING_OPS`), whose catalog role is `NO_ROLE_CATALOG`: Postgres answers its own name for all three to a
 *   login with no grant.
 * - `pg_catalog.current_setting(…)`, so written, is the session's override (`public.current_setting`, catalog.ts
 *   currentSettingSql): Postgres's own is called by its OID's C function whatever its catalog row says, so it cannot be
 *   replaced, and so qualified it answered the catalog's values after a SET (GitHub issue 40).
 * `base`: the statement's offset in the text the parse tree's locations count from.
 */
function userSpliced(text: string, stmt: unknown, base: number, user: string, ops: ReadonlySet<string>): string {
  // a user keyword by its location, or `setting`: the `pg_catalog.` of a qualified current_setting
  const at = new Map<number, string>();
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) { for (const x of n) walk(x); return; }
    if (typeof n !== "object" || n === null) return;
    const f = (n as { SQLValueFunction?: { op?: string; location?: number } }).SQLValueFunction;
    if (f !== undefined && f.op !== undefined && ops.has(f.op) && typeof f.location === "number") at.set(f.location, USER_OPS[f.op]!);
    const c = (n as { FuncCall?: { funcname?: Array<{ String?: { sval?: string } }>; location?: number } }).FuncCall;
    const name = c?.funcname?.map((x) => x.String?.sval ?? "");
    if (c !== undefined && typeof c.location === "number" && name?.length === 2 && name[0] === "pg_catalog" && name[1] === "current_setting") at.set(c.location, SETTING);
    for (const v of Object.values(n)) walk(v);
  };
  walk(stmt);
  if (at.size === 0) return text;
  const bytes = Buffer.from(text, "utf8");
  const parts: Buffer[] = [];
  let end = bytes.length;
  for (const loc of [...at.keys()].sort((a, b) => b - a)) {
    const keyword = at.get(loc)!;
    const from = loc - base;
    if (from < 0) continue;
    let written: string;
    if (keyword === SETTING) {
      // the qualifier as written (`pg_catalog.`, `"pg_catalog" .`): what is spliced is its span, never a guess at it
      const q = /^(?:pg_catalog|"pg_catalog")\s*\.\s*/i.exec(bytes.subarray(from, from + 64).toString("utf8"));
      if (q === null) continue;
      written = q[0];
    } else {
      if (bytes.subarray(from, from + keyword.length).toString("utf8").toLowerCase() !== keyword) continue;
      // the keyword must end there (`user` is the start of `user_name`): the parser placed it, so a word character after is not it
      if (/^[A-Za-z0-9_$]/.test(bytes.subarray(from + keyword.length, from + keyword.length + 1).toString("utf8"))) continue;
      written = keyword;
    }
    parts.unshift(bytes.subarray(from + Buffer.byteLength(written), end));
    parts.unshift(Buffer.from(keyword === SETTING ? "public." : `(SELECT ${quoteLiteral(user)}::name AS ${keyword})`, "utf8"));
    end = from;
  }
  parts.unshift(bytes.subarray(0, end));
  return Buffer.concat(parts).toString("utf8");
}

/** the text of one statement of a simple query, from the parser's byte offsets */
function statementText(sql: string, raw: RawStmt): string {
  const bytes = Buffer.from(sql, "utf8");
  const from = raw.stmt_location ?? 0;
  const len = raw.stmt_len ?? 0;
  return bytes.subarray(from, len === 0 ? bytes.length : from + len).toString("utf8").trim();
}

const oidOf = (oid: number): PgApiType | undefined => (Object.keys(OID) as PgApiType[]).find((t) => OID[t].oid === oid);

const PG_EPOCH_MS = Date.UTC(2000, 0, 1);

/** an element type's name, as array_recv's 42804 says it */
const ELEMENT_NAMES: Record<number, string> = { 25: "text", 1043: "character varying", 16: "boolean", 20: "bigint", 21: "smallint", 23: "integer", 700: "real", 701: "double precision", 1700: "numeric", 2950: "uuid", 1082: "date", 1114: "timestamp without time zone", 1184: "timestamp with time zone", 3802: "jsonb", 114: "json" };

/** text[] and varchar[], the array types whose binary form a Bind is decoded from (textArrayFromBinary) */
const TEXT_ARRAYS = new Set([1009, 1015]);

/**
 * A BINARY text[] (or varchar[]) PARAMETER, as the literal array_in reads to the same array (Npgsql sends every
 * parameter binary): array_send's form, its dimensions, a NULL flag, the element type, each dimension's length and lower
 * bound, then each element's length (-1 a NULL) and bytes. Every element is quoted, so any character is itself; a lower
 * bound other than 1 and a second dimension are written as array_in reads them, and refused where every text[] value is
 * (src/duck/analyze.ts readParameters). Bytes that are no such array are refused as array_recv refuses them, in its
 * order: too few 08P01 (22P03 within an element), flags other than 0 or 1 22P03, an element type other than the
 * parameter's own 42804, a negative or too large dimension 54000, an element that is no UTF-8 or holds a NUL 22021, too
 * many bytes 22P03 naming the parameter.
 */
function textArrayFromBinary(bytes: Buffer, i: number, expected: 25 | 1043): string {
  const bad = (): PgError => new PgError({ code: "22P03", message: `incorrect binary data format in bind parameter ${i + 1}` });
  const short = (): PgError => new PgError({ code: "08P01", message: "insufficient data left in message" });
  let at = 0;
  const int = (): number => { if (at + 4 > bytes.length) throw short(); const v = bytes.readInt32BE(at); at += 4; return v; };
  const ndim = int();
  if (ndim < 0 || ndim > 6) throw new PgError({ code: ndim < 0 ? "22P03" : "54000", message: ndim < 0 ? `invalid number of dimensions: ${ndim}` : `number of array dimensions (${ndim}) exceeds the maximum allowed (6)` });
  // array_recv's order: the dimensions, the flags, the element type, then each dimension's size
  const flags = int();
  if (flags !== 0 && flags !== 1) throw new PgError({ code: "22P03", message: "invalid array flags" });
  const element = int() >>> 0;
  if (element !== expected) {
    throw new PgError({ code: "42804", message: `binary data has array element type ${element} (${ELEMENT_NAMES[element] ?? "another type"}) instead of expected ${expected} (${ELEMENT_NAMES[expected]})` });
  }
  const dims: Array<{ length: number; lower: number }> = [];
  for (let d = 0; d < ndim; d++) { const length = int(); dims.push({ length, lower: int() }); }
  // ArrayGetNItems: a negative dimension, a product past an int32 at any step, or past MaxArraySize at the end
  const MAX_ARRAY_SIZE = 268435455;
  const tooBig = (): PgError => new PgError({ code: "54000", message: `array size exceeds the maximum allowed (${MAX_ARRAY_SIZE})` });
  let items = 1;
  for (const d of dims) {
    if (d.length < 0) throw tooBig();
    items *= d.length;
    if (items > 0x7fffffff) throw tooBig();
  }
  if (items > MAX_ARRAY_SIZE) throw tooBig();
  const elementText = (): string => {
    const length = int();
    if (length === -1) return "NULL";
    // ReadArrayBinary's own check is 22P03, where reading a length past the end is pq_getmsgint's 08P01
    if (length < 0 || at + length > bytes.length) throw new PgError({ code: "22P03", message: "insufficient data left in message" });
    const text = utf8Element(bytes.subarray(at, at + length)); at += length;
    return `"${text.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
  };
  const level = (d: number): string => `{${Array.from({ length: dims[d]!.length }, () => d === ndim - 1 ? elementText() : level(d + 1)).join(",")}}`;
  const body = ndim === 0 || dims.some((d) => d.length === 0) ? "{}" : level(0);
  if (at !== bytes.length) throw bad();
  const bounds = dims.every((d) => d.lower === 1) || body === "{}" ? "" : `${dims.map((d) => `[${d.lower}:${d.lower + d.length - 1}]`).join("")}=`;
  return bounds + body;
}

const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * An element's text, as textrecv reads it (pg_verify_mbstr): bytes that are no UTF-8, or a NUL, are refused 22021 naming
 * the first bad character's bytes (report_invalid_encoding: as many as its lead byte says, as many as are left), never
 * decoded with a replacement character.
 */
function utf8Element(bytes: Uint8Array): string {
  if (!bytes.includes(0)) {
    // a fatal TextDecoder throws exactly TypeError on bytes that are no UTF-8: the scan below names them
    try { return fatalUtf8.decode(bytes); } catch (err) { if (!(err instanceof TypeError)) throw err; }
  }
  // find the first character Postgres refuses: a NUL, or a character no UTF-8 decoder reads alone
  for (let at = 0; at < bytes.length;) {
    const b = bytes[at]!;
    const length = b < 0x80 ? 1 : (b & 0xe0) === 0xc0 ? 2 : (b & 0xf0) === 0xe0 ? 3 : (b & 0xf8) === 0xf0 ? 4 : 1;
    const char = bytes.subarray(at, at + length);
    let legal = b !== 0 && char.length === length;
    if (legal && b >= 0x80) { try { fatalUtf8.decode(char); } catch (err) { if (!(err instanceof TypeError)) throw err; legal = false; } }
    if (!legal) {
      const shown = Array.from(char, (c) => `0x${c.toString(16).padStart(2, "0")}`).join(" ");
      throw new PgError({ code: "22021", message: `invalid byte sequence for encoding "UTF8": ${shown}` });
    }
    at += length;
  }
  throw new PgError({ code: "XX000", message: "a text[] element failed to decode as UTF-8 at no character: report it" });
}

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
  /** the catalog Postgres's own settings, by name (`catalogSettings`), read once */
  private baseSettings: Promise<ReadonlyMap<string, string>> | null = null;
  /** the DuckDB plans by text, search_path, TimeZone, declared parameter types and an Execute's bound (Session.boundOnWire), for
   *  the schema they were made under */
  private duckPlans = new Map<string, DuckPlan>();
  private duckPlansOf: PgSchema | null = null;
  private duckPlansAt = 0;
  private duckPlansRoles: RolesLive | null = null;

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
      const name = typeNameParts(madeTypeName(c.spelled)).name;
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
  async duckPlan(text: string, paramOids: readonly number[], searchPath: string, timeZone: string, wireBound: boolean, role: string, make: () => Promise<DuckPlan>): Promise<DuckPlan> {
    const schema = this.schema();
    const roles = this.rolesNow();
    const generation = this.options.duck?.generation?.() ?? 0;
    if (schema !== this.duckPlansOf || generation !== this.duckPlansAt || roles !== this.duckPlansRoles) { this.duckPlans.clear(); this.duckPlansOf = schema; this.duckPlansAt = generation; this.duckPlansRoles = roles; }
    // the zone too: a plan holds the values Postgres parsed its literals to, under the session's zone
    // and the bound: an Execute's row count plans a LEFT lateral of a list otherwise (Session.boundOnWire), kept beside
    // and the role: a plan is held to it as it is made (src/duck/grants.ts), so a role's plans are its own
    const key = `${searchPath}\u0000${timeZone}\u0000${paramOids.join(",")}\u0000${wireBound ? "wire" : ""}\u0000${role}\u0000${text}`;
    const hit = this.duckPlans.get(key);
    if (hit !== undefined) return hit;
    const plan = await make();
    if (this.duckPlansOf !== schema || this.duckPlansAt !== generation || this.duckPlansRoles !== roles) return plan;
    // bounded: a tool that inlines its values sends a new text per value
    if (this.duckPlans.size >= 2000) this.duckPlans.delete(this.duckPlans.keys().next().value!);
    this.duckPlans.set(key, plan);
    return plan;
  }
  /** the run's own listener's door */
  readonly door: Door;
  readonly catalog: PgCatalog;
  private lastSchema: PgSchema;
  private lastRoles: RolesLive;
  options: PgApiOptions;
  constructor(options: PgApiOptions) {
    this.options = options;
    this.door = { tls: options.tls === null ? null : tls.createSecureContext({ cert: options.tls.cert, key: options.tls.key }), authenticate: options.authenticate,
      recheck: options.recheck, recheckMs: options.recheckMs ?? DEFAULT_RECHECK_MS, who: "a mason user", loginHint: USER_LOGIN_HINT, public: false, logins: null };
    this.lastSchema = options.schema();
    this.lastRoles = options.roles?.() ?? NO_ROLES;
    const version = versionText(options.product ?? "Mason", options.masonVersion);
    this.catalog = new PgCatalog(this.lastSchema, {
      roles: catalogRolesOf(this.lastRoles),
      log: (line) => this.log(line),
      setup: [
        // `version()` says whose Postgres this is; search_path lists pg_catalog AFTER public so the override wins
        `CREATE OR REPLACE FUNCTION public.version() RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT '${version.replaceAll("'", "''")}' $$`,
        // `current_setting(name)` answers the session's settings, carried in by each of its requests (catalog.ts asSession)
        ...currentSettingSql(),
        // latest(x ORDER BY …), Mason's aggregate, analysed as Postgres's own (catalog.ts LATEST_SQL)
        ...LATEST_SQL,
        "SET search_path = public, pg_catalog",
        ...databaseNameSql(options.database),
      ],
      ...(options.catalogStatementMs !== undefined ? { statementMs: options.catalogStatementMs } : {}),
      ...(options.trace === true ? { trace: true } : {}),
    });
  }
  get database(): string { return this.options.database; }

  /**
   * THE CATALOG POSTGRES'S OWN SETTINGS, every name its `current_setting` knows with the value it answers (`block_size`,
   * `server_version_num` …), read once (they are the catalog's build's and its setup's, the same at every start): what a
   * session's `current_setting` answers beside a copied table for a name the session does not hold (`duckSession`).
   */
  catalogSettings(): Promise<ReadonlyMap<string, string>> {
    this.baseSettings ??= (async () => {
      const reply = decodeBackend(Buffer.from(await this.catalog.run(frame("Q", cstr("SELECT name, pg_catalog.current_setting(name) FROM pg_catalog.pg_settings")))));
      const err = reply.find((m) => m.type === "ErrorResponse");
      if (err?.type === "ErrorResponse") throw new PgError({ code: "XX000", message: `the catalog Postgres's settings could not be read: ${err.fields.M} (Mason bug: report it)` }, 500);
      return new Map(reply.flatMap((m) => m.type === "DataRow" ? [[m.values[0]!.toString("utf8").toLowerCase(), m.values[1]?.toString("utf8") ?? ""] as [string, string]] : []));
    })();
    // a read that failed is read again at the next statement, never kept
    this.baseSettings.catch(() => { this.baseSettings = null; });
    return this.baseSettings;
  }
  /** the clock "now" is read from */
  now(): number { return (this.options.clock ?? Date.now)(); }
  log(line: string): void { (this.options.log ?? ((l: string) => console.log(l)))(`[postgres] ${line}`); }

  /** the schema as of now; the catalog Postgres is replaced when it changed (or the roles did: `rolesNow`) */
  schema(): PgSchema {
    const s = this.options.schema();
    const r = this.options.roles?.() ?? NO_ROLES;
    if (s !== this.lastSchema || r !== this.lastRoles) {
      this.lastSchema = s;
      this.lastRoles = r;
      void this.catalog.replace(s, catalogRolesOf(r)).catch((e: unknown) => this.log(`replacing the catalog failed: ${e instanceof Error ? e.message : String(e)}`));
    }
    return s;
  }

  /** src/duck/generated-plan.ts `Planner`: null `grants` so the plan names what it reads, under no role */
  planner(): Planner {
    const duck = this.options.duck;
    if (duck === undefined) throw new Error("a generated table needs the listener's engine (Mason bug: report it)");
    const catalog = (b: Uint8Array): Promise<Uint8Array> => this.catalog.run(b);
    return {
      plan: (text, stmt, relations) => { this.schema(); return duck.plan(catalog, text, stmt as NonNullable<RawStmt["stmt"]>, 0, [], "public", "UTC", this.userTypes(), false, null, relations, true); },
      rows: (sql) => { this.schema(); return catalogRows(catalog, sql); },
    };
  }

  /** the roles as of now (src/duck/grants.ts RolesLive); the catalog is replaced when they changed, as for the schema */
  rolesNow(): RolesLive {
    this.schema();
    return this.lastRoles;
  }

  /**
   * THE ROLES WITH THEIR ROW FILTERS CHECKED BY THE CATALOG POSTGRES (src/duck/row-filter.ts filterTypes): each `where:`
   * of a copied table analysed as `SELECT 1 FROM <table> WHERE <it>`, the type of each attribute it reads taken from
   * Postgres's inference (the ONE derivation: every binding and the catalog's policies read it), and a filter Postgres
   * refuses made the roles' `problem` — said once in the log, at its key, and every statement of a user held to a role
   * refused until it is fixed (fail closed, as for any mistake of the file). The catalog's row security policies are
   * written from the same types (catalog.ts catalogPolicies). Once per roles object and copied tables; nothing where no
   * role filters rows. A check that could not run (the catalog failed) is said as the problem and tried again next time.
   */
  async checkRoles(): Promise<RolesLive> {
    const raw = this.rolesNow();
    const schema = this.lastSchema;
    if (!filtersRows(raw)) return raw;
    if (this.checked?.of === raw && this.checked.schema === schema) return this.checked.live;
    if (this.checking?.of === raw && this.checking.schema === schema) return this.checking.done;
    const done = (async (): Promise<RolesLive> => {
      const copied = new Set(schema.tables.map((t) => `${t.schema ?? "public"}.${t.name}`));
      const problems: string[] = [];
      const typed = new Map<string, RoleGrants>();
      try {
        for (const g of raw.grants.values()) {
          if (g.filters === undefined) { typed.set(g.name, g); continue; }
          const types = new Map<string, ReadonlyMap<string, string>>();
          for (const f of g.filters.values()) {
            if (f.where === undefined || !copied.has(f.table)) continue;
            const r = await filterTypes((b) => this.catalog.run(b), f, g.attributes ?? new Map());
            if ("problem" in r) { problems.push(r.problem); continue; }
            types.set(f.table, r.types);
            // Postgres read it; the rewrite must too, or each of the role's users would meet the refusal, statement by statement
            const probe = filterProbe(f, r.types, g.attributes ?? new Map());
            const stmt = (await parseSql(probe)).stmts?.[0]?.stmt;
            if (stmt === undefined) throw new Error(`a filter's read does not parse: ${probe}`);
            try { await this.options.duck.plan((b) => this.catalog.run(b), probe, stmt, 0, [], "public", "UTC", this.userTypes(), false, undefined); }
            catch (e) {
              if (!(e instanceof StatementError)) throw e;
              problems.push(`${f.at}.where: ${e.fields.message}${e.fields.hint !== undefined ? ` (${e.fields.hint})` : ""} — the predicate is read as SELECT 1 FROM ${f.table} WHERE ${f.where.text}`);
            }
          }
          typed.set(g.name, { ...g, filterTypes: types });
        }
        await this.catalog.policies(catalogPolicies(schema, catalogRolesOf({ ...raw, grants: typed })));
      } catch (e) {
        const problem = `the roles' row filters could not be checked by the catalog: ${e instanceof Error ? e.message : String(e)}`;
        // tried again at every statement of every session, so said once a streak: the line a streak's end answers
        if (!this.rolesCheckFailing) { this.rolesCheckFailing = true; this.log(`roles: ${problem} — tried again at each statement, every statement of a user held to a role refused until then`); }
        return raw.problem !== null ? raw : { ...raw, problem, checkFailed: true };
      }
      if (this.rolesCheckFailing) { this.rolesCheckFailing = false; this.log("roles: the catalog checks the row filters again"); }
      const problem = raw.problem ?? (problems.length === 0 ? null : `${raw.file ?? "the roles file"}: ${problems.join("; ")}`);
      if (problem !== null && raw.problem === null && problem !== this.saidProblem) {
        this.saidProblem = problem;
        this.log(`roles: ${problem} — every statement of a user held to a role is refused until it is fixed`);
      }
      const live: RolesLive = { ...raw, grants: typed, problem };
      if (this.lastRoles === raw && this.lastSchema === schema) this.checked = { of: raw, schema, live };
      return live;
    })();
    this.checking = { of: raw, schema, done };
    try { return await done; }
    finally { if (this.checking?.done === done) this.checking = null; }
  }
  private checked: { of: RolesLive; schema: PgSchema; live: RolesLive } | null = null;
  private checking: { of: RolesLive; schema: PgSchema; done: Promise<RolesLive> } | null = null;
  private saidProblem: string | null = null;
  private rolesCheckFailing = false;

  /** the roles now, their row filters checked where the check for them is done (`checkRoles`), else as read: a
   *  session's `grants` refuses a filter not checked yet */
  rolesChecked(): RolesLive {
    const raw = this.rolesNow();
    if (!filtersRows(raw)) return raw;
    return this.checked?.of === raw && this.checked.schema === this.lastSchema ? this.checked.live : raw;
  }

  forget(s: Session): void { this.sessions.delete(s.id); }

  /** A CancelRequest: the session's statement stopped when the key is the session's (`interrupt`) and it arrived on
   *  the session's own socket (a driver's cancel opens a connection to the address it logged in at; a public socket
   *  reaches its own sessions alone). */
  cancel(pid: number, secret: number, door: Door): void {
    const s = this.sessions.get(pid);
    if (s === undefined || s.secret !== secret || s.door !== door) return;   // as Postgres: a wrong key is ignored, never answered
    this.interrupt(s);
  }

  /**
   * THE ONE WAY A SESSION'S STATEMENT IS CANCELLED, for a CancelRequest and `mason cancel` alike: its controller aborted
   * with no reason, so DuckDB is interrupted (or the wait for the client woken) and the client is told 57014 "canceling
   * statement due to user request", recorded as cancelled. Answers what it stopped, or null when nothing ran.
   */
  interrupt(s: Session): RunningStatement | null {
    const running = s.runningNow(Date.now());
    s.running?.abort();
    return running;
  }

  /** `mason cancel <session>` (`POST /api/cancel`): the session's statement stopped as a CancelRequest stops it — with
   *  `statement`, only while it is the one the session runs (a listing's statement may have ended, and the session
   *  begun another, by the time the cancel arrives) */
  cancelSession(id: number, statement?: number): CancelAnswer {
    const s = this.sessions.get(id);
    if (s === undefined) return { unknown: id };
    if (statement !== undefined) {
      const now = s.runningNow(Date.now());
      if (now !== null && now.statement !== statement) return { other: now, asked: statement };
    }
    const stopped = this.interrupt(s);
    if (stopped === null) return { idle: id };
    this.log(`session ${id}: its statement cancelled by mason cancel`);
    return { cancelled: stopped };
  }

  /** The sessions logged in now, by user and client, the most open first (`SessionsOpen`). */
  openSessions(): SessionsOpen {
    const now = Date.now();
    const by = new Map<string, { user: string; client: string; open: number; running: number }>();
    let open = 0;
    for (const s of this.sessions.values()) {
      if (s.phase !== "ready") continue;
      open++;
      const user = s.token?.user ?? "", client = s.vars.applicationName;
      const k = JSON.stringify([user, client]);
      const g = by.get(k) ?? { user, client, open: 0, running: 0 };
      g.open++;
      if (s.runningNow(now) !== null) g.running++;
      by.set(k, g);
    }
    return { open, byClient: [...by.values()].sort((a, b) => b.open - a.open || (a.user < b.user ? -1 : a.user > b.user ? 1 : a.client < b.client ? -1 : a.client > b.client ? 1 : 0)) };
  }

  /** The statements running now, oldest first. */
  running(): RunningStatement[] {
    const now = Date.now();
    return [...this.sessions.values()].map((s) => s.runningNow(now)).filter((r): r is RunningStatement => r !== null)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.session - b.session);
  }
}

/** A socket that takes connections through `door`, listening; its port. Two of these are one server's two sockets. */
async function listenOn(server: Server, door: Door, port: number, host: string): Promise<{ listener: net.Server; port: number }> {
  const listener = net.createServer((socket) => {
    socket.setNoDelay(true);
    const session = new Session(socket, server, door);
    server.sessions.set(session.id, session);
  });
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(port, host, () => { listener.off("error", reject); resolve(); });
  });
  listener.on("error", (err: Error) => server.log(`listener error: ${err.message}`));
  const address = listener.address();
  return { listener, port: typeof address === "object" && address !== null ? address.port : port };
}

const closeListener = (listener: net.Server): Promise<void> => new Promise((resolve) => listener.close(() => resolve()));

export async function startPostgresApi(options: PgApiOptions): Promise<PgApiServer> {
  const server = new Server(options);
  const { listener, port } = await listenOn(server, server.door, options.port, options.host);
  const shares = new Set<net.Server>();
  const sessionsOf = (door: Door): Session[] => [...server.sessions.values()].filter((s) => s.door === door);
  return {
    port,
    async openShare(o) {
      const door: Door = { tls: tls.createSecureContext({ cert: o.tls.cert, key: o.tls.key }), authenticate: o.authenticate, recheck: o.recheck, recheckMs: 0, who: "a share",
        loginHint: o.loginHint, public: true, logins: new LoginQueue(o.pendingLimit ?? DEFAULT_PENDING_LIMIT, o.pendingMs ?? DEFAULT_PENDING_MS, o.dropped), refused: o.refused };
      // loopback whatever the run's own listener is bound to: a tunnel's client is on this machine
      const share = await listenOn(server, door, 0, "127.0.0.1");
      shares.add(share.listener);
      return {
        port: share.port,
        get sessions() { return sessionsOf(door).filter((s) => s.phase === "ready").length; },
        endSessions: (jti, why) => {
          const ended = sessionsOf(door).filter((s) => s.token?.jti === jti);
          for (const s of ended) s.end(why);
          return ended.length;
        },
        async close() {
          if (!shares.delete(share.listener)) return;
          for (const s of sessionsOf(door)) s.end("the share ended");
          await closeListener(share.listener);
        },
      };
    },
    get sessions() { return server.sessions.size; },
    roles: () => server.rolesChecked(),
    checkRoles: () => server.checkRoles(),
    planner: () => server.planner(),
    openSessions: () => server.openSessions(),
    running: () => server.running(),
    cancel: (session, statement) => server.cancelSession(session, statement),
    async close() {
      for (const s of [...server.sessions.values()]) s.end("server closing");
      await Promise.all([listener, ...shares].map(closeListener));
      shares.clear();
      await server.catalog.stop();
      await stopParser();
    },
  };
}
