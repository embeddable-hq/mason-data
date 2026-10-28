/**
 * THE WEB PAGE (src/web/app.js, `mason ui`) under node: what it WRITES from the command server's JSON, never geometry.
 * The fixtures are the server's own: `runState` (src/cli/run-server.ts) over synthetic copies — a run ready, one copying
 * with its chunks' progress, one whose copy failed, a table served but not kept current — and, for a run that stopped,
 * the answers a page gets then (nothing at all; the guard's 403 to a cookie of an earlier run). The page's words are
 * held equal to the commands' (`tableLines`, `copyingText`, `duration`, `sourceRows`, `tableFacts`, `addedLines`,
 * `removedReport`), so the two cannot drift; the
 * app is driven over a fake `fetch`, asserting on the parts of the page it writes and the state it keeps.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runState, type RunContext } from "../src/cli/run-server.ts";
import { parseSource, type SourceTable } from "../src/cli/preflight.ts";
import { parseSourceText } from "../src/cli/sources.ts";
import type { CopyProgressView, CopyState } from "../src/duck/sync.ts";
import type { RunState } from "../src/cli/commands.ts";
import * as commands from "../src/cli/commands.ts";

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "web");
// imported when the tests run: at a commit without the page the file still loads, and each test fails by name
const page = await import(path.join(WEB, "app.js") as string).catch(() => ({})) as Record<string, (...a: never[]) => unknown>;
type Fn<A extends unknown[], R> = (...a: A) => R;
const fn = <A extends unknown[], R>(name: string): Fn<A, R> => {
  const f = page[name];
  assert.equal(typeof f, "function", `src/web/app.js exports ${name}`);
  return f as unknown as Fn<A, R>;
};
interface Failure { code: string; message: string; why?: string; fix?: string; next?: Array<{ command: string; what?: string }> }
interface App {
  model: Record<string, unknown>;
  show(page: string): void; poll(): Promise<void>; addUser(name: string): Promise<boolean>; askRemove(name: string): void; cancelRemove(): void;
  confirmRemove(name: string): Promise<boolean>; dismissAdded(): void; view(): Record<string, string>;
  addTable(table: string, columns?: string[], key?: string[]): Promise<boolean>; choose(table: string): void; cancelChoose(): void;
  askRemoveTable(table: string): void; cancelRemoveTable(): void; confirmRemoveTable(table: string): Promise<boolean>; dismissOutcome(): void;
}

/** What a reader sees of some HTML: its text, tags gone and entities read, spaces collapsed. */
const textOf = (html: string): string => html.replace(/<[^>]*>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"")
  .replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

// ------------------------------------------------------------------ fixtures: the server's runState over synthetic copies

const col = (name: string, type = "text") => ({ name, type, notNull: false, comment: null });
const table = (name: string, rows: number): SourceTable => ({ source: `public.${name}`, schema: "public", table: name, key: ["id"], rows, bytes: 8192, comment: null,
  columns: [col("id", "bigint"), col("name")], foreignKeys: [] });
const TABLES = [table("customers", 1200), table("orders", 2_000_000), table("events", 30_000_000), table("audit", 50)];
const parsed = parseSource("postgres://shop:secret@db.example.com:5432/shop");
const source = "source" in parsed ? parsed.source : assert.fail(parsed.problem);
const parsedDemo = parseSource("postgres://demo@127.0.0.1:5434/demo");
const demoSource = "source" in parsedDemo ? parsedDemo.source : assert.fail(parsedDemo.problem);
const sourceFile = parseSourceText("kind: postgres\nurl: x\ntables:\n  customers: {}\n  orders: {}\n  events: {}\n", "shop", "/app/mason/sources/shop.yml");
assert.ok(!("problems" in sourceFile));

/** The state /api/state answers for these copies (src/cli/run-server.ts runState), as JSON travels. */
function stateOf(copies: CopyState[], o: { warnings?: string[]; replication?: boolean; tables?: SourceTable[]; sources?: typeof sourceFile; demo?: boolean } = {}): RunState {
  const ctx = {
    source: o.demo ? demoSource : source, ...(o.demo ? { demo: true } : {}),
    facts: () => ({ version: 160000, versionText: "16.4", standby: false, tables: o.tables ?? TABLES, systemIdentifier: null }),
    warnings: o.warnings ?? [], slot: o.replication ? "mason_dev_shop" : "", changes: o.replication ? "replication" : "poll",
    ...(o.replication ? { publication: { name: "app_pub", owned: false } } : {}),
    page: true, folder: () => "/app/mason", root: "/app", sources: () => ({ file: o.sources ?? sourceFile, problem: null }),
    duck: { file: "/app/.mason/duck.db", pollSeconds: 5 },
  } as unknown as RunContext;
  return JSON.parse(JSON.stringify(runState(ctx, copies, null))) as RunState;
}
const copied = (source: string, rows: number, at: string): CopyState => ({ source, phase: "copied", rows, bytes: 1, seconds: 1, copiedAt: at, error: null });
const progress: CopyProgressView = { chunksDone: 3, chunksTotal: 20, reading: 2, readingSeconds: 14, rowsReading: 41_000, rowsPerSecond: 52_300.4, bytesPerSecond: 1e6, secondsLeft: 340, share: 0.157 };
const RUNNING = stateOf([copied("public.customers", 1200, "2026-10-27T09:00:01.000Z"), copied("public.orders", 2_000_000, "2026-10-27T09:00:09.000Z"), copied("public.events", 30_000_000, "2026-10-27T09:04:00.000Z")]);
const COPYING = stateOf([copied("public.customers", 1200, "2026-10-27T09:00:01.000Z"),
  { source: "public.orders", phase: "copying", rows: null, bytes: null, seconds: null, copiedAt: null, error: null, rowsSoFar: 280_000, rowsEstimate: 2_000_000, progress },
  { source: "public.events", phase: "waiting", rows: null, bytes: null, seconds: null, copiedAt: null, error: null }]);
const FAILED = stateOf([copied("public.customers", 1200, "2026-10-27T09:00:01.000Z"),
  { source: "public.orders", phase: "failed", rows: null, bytes: null, seconds: null, copiedAt: null, error: "could not read the next chunk: connection reset\nthe sync tries it again in 5 min" },
  { ...copied("public.events", 30_000_000, "2026-10-27T09:04:00.000Z"), unsynced: { reason: "over the poll's row limit", asOf: "2026-10-27T09:04:00.000Z" } }],
  { warnings: ["mason/sources/shop.yml: tables.ordrs: no such table (Mason copies the tables it read before; mason start reads the file again)"], replication: true });
const NONE = stateOf([]);
for (const s of [NONE]) for (const t of s.tables) t.added = false;

// the tables section's database: beside the four, a table with a secret-looking column, one with no primary key (a unique
// index over two NOT NULL columns, which its reason names) and one never analysed (its rows unknown)
const KEYLESS: SourceTable = { source: "public.event_log", schema: "public", table: "event_log", key: [], rows: 900, bytes: 8192, comment: null,
  columns: [{ ...col("tenant_id", "bigint"), notNull: true }, { ...col("id", "bigint"), notNull: true }, col("payload", "jsonb")], foreignKeys: [],
  uniqueKeys: [{ name: "event_log_tenant_id_id_key", columns: ["tenant_id", "id"], constraint: true, nullsNotDistinct: false }] };
const CATALOG = [...TABLES, { ...table("accounts", 300), columns: [col("id", "bigint"), col("email"), col("password_hash")] }, KEYLESS, { ...table("staging", 0), rows: null }];
const THREE_COPIED = () => [copied("public.customers", 1200, "2026-10-27T09:00:01.000Z"), copied("public.orders", 2_000_000, "2026-10-27T09:00:09.000Z"),
  copied("public.events", 30_000_000, "2026-10-27T09:04:00.000Z")];
const CATALOG_STATE = stateOf(THREE_COPIED(), { tables: CATALOG });
// the same database once public.accounts is added: its copy not yet started
const withAccounts = parseSourceText("kind: postgres\nurl: x\ntables:\n  customers: {}\n  orders: {}\n  events: {}\n  accounts: { exclude: [password_hash] }\n", "shop", "/app/mason/sources/shop.yml");
assert.ok(!("problems" in withAccounts));
const ACCOUNTS_ADDED = stateOf(THREE_COPIED(), { tables: CATALOG, sources: withAccounts });
const FILE = "/app/mason/sources/shop.yml";
/** `/api/pick`'s answers (src/cli/run-server.ts PickResult): every column with a secret left out, a --columns list
 *  the key was added to, a table with no primary key added by --key, one the file named so already. */
const PICKED = {
  secret: { table: "public.accounts", file: FILE, entry: "accounts", columns: null, exclude: ["password_hash"], key: null, addedKey: [], skippedSecrets: ["password_hash"], already: false },
  columns: { table: "public.audit", file: FILE, entry: "audit", columns: ["id", "name"], exclude: [], key: null, addedKey: ["id"], skippedSecrets: [], already: false },
  keyed: { table: "public.event_log", file: FILE, entry: "event_log", columns: null, exclude: [], key: ["tenant_id", "id"], addedKey: [], skippedSecrets: [], already: false },
  already: { table: "public.customers", file: FILE, entry: "customers", columns: null, exclude: [], key: null, addedKey: [], skippedSecrets: [], already: true },
};
const answer = (v: unknown, status = 200) => () => new Response(JSON.stringify(v), { status });

const SLOW = { slow: [{ route: "postgres", payload: "SELECT count(*) FROM orders", runs: 2, medianMs: 1500, maxMs: 2000, latestMs: 2000, last: "2026-10-27T09:03:00.000Z" }], slowMs: 1000 };
const REFUSED = { total: 7, refused: [{ route: "postgres", code: "42P01", message: "relation \"nope\" does not exist", runs: 7, last: "2026-10-27T09:04:00.000Z", payload: "SELECT * FROM nope" }] };

// ------------------------------------------------------------------ the DOM-free helpers, held to the commands'

test("the helpers: a share as the commands' percent, seconds left and a span as theirs, every value escaped", () => {
  const percent = fn<[number], string>("percent"), leftText = fn<[number | null], string>("leftText"), duration = fn<[number], string>("duration"), esc = fn<[unknown], string>("esc");
  assert.deepEqual([0, 0.157, 0.999, 1, 1.4, -1].map(percent), ["0%", "15%", "99%", "100%", "100%", "0%"]);
  assert.deepEqual([45, 340, 7500].map(leftText), ["~45 s left", "~6 min left", "~2 h 5 min left"]);
  assert.equal(leftText(null), "");
  for (const s of [0, 0.4, 1, 44.6, 89, 90, 600, 5399, 5400, 7500, 86_400]) assert.equal(duration(s), commands.duration(s), `duration(${s}) is the commands'`);
  assert.equal(esc(`<script>"a" & 'b'</script>`), "&lt;script&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/script&gt;");
});

test("a copy's line is the commands' line, word for word: copying with its chunks, resumed, past its estimate, every chunk in", () => {
  const copyingText = fn<[number, number | null, unknown?], { fraction: number | null; text: string }>("copyingText");
  const cases: Array<[number, number | null, typeof progress | undefined]> = [
    [280_000, 2_000_000, progress], [0, 2_000_000, { ...progress, chunksDone: 0, reading: 0, rowsPerSecond: null, secondsLeft: null, readingSeconds: null, share: 0 }],
    [120_000, 2_000_000, { ...progress, reading: 1, rowsPerSecond: null, readingSeconds: 3 }], [2_400_000, 2_000_000, { ...progress, reading: 0, chunksDone: 20 }],
    [0, null, undefined], [500, 1000, undefined], [1500, 1000, undefined],
  ];
  for (const [c, est, p] of cases) assert.deepEqual(copyingText(c, est, p), commands.copyingText(c, est, p), JSON.stringify([c, est, p?.reading]));
});

test("each added table's line is mason status's: the table, its percent and what it says, in the commands' order", () => {
  const tableLine = fn<[unknown], { state: string; fraction: number; what: string }>("tableLine");
  const percent = fn<[number], string>("percent");
  for (const s of [RUNNING, COPYING, FAILED]) {
    // tableLines: `<table>  <bar> <pct>  <what>`
    const cli = commands.tableLines(s).map((l) => /^(\S+)\s+[█░]+\s+(\d+%) {2}(.*)$/.exec(l)!.slice(1));
    const ours = s.tables.filter((t) => t.added).map((t) => { const l = tableLine(t); return [t.table, percent(l.fraction), l.what]; });
    assert.deepEqual([...ours].sort(), [...cli].sort());
    // and renderStatus writes them in the commands' order
    const html = fn<[unknown, unknown?], string>("renderStatus")(s);
    const at = cli.map(([t]) => html.indexOf(`<code>${t}</code>`));
    assert.deepEqual(at, [...at].sort((a, b) => a - b), "the order mason status lists them in");
  }
});

test("the database's rows are mason status's: its sources file, its URL as the run masked it, how its changes arrive", () => {
  const sourceRows = (commands as unknown as { sourceRows?: (s: RunState) => Array<[string, string]> }).sourceRows;
  assert.equal(typeof sourceRows, "function", "src/cli/commands.ts exports sourceRows");
  for (const s of [RUNNING, FAILED]) assert.deepEqual(fn<[unknown], unknown>("sourceRows")(s), sourceRows!(s));
});

test("a table's line is mason tables': its size, its key, and added or why it cannot be added as it is", () => {
  const cli = (commands as unknown as { tableFacts?: (t: unknown) => unknown }).tableFacts;
  assert.equal(typeof cli, "function", "src/cli/commands.ts exports tableFacts");
  const tableFacts = fn<[unknown], { size: string; key: string; state: string | null }>("tableFacts");
  for (const t of CATALOG_STATE.tables) assert.deepEqual(tableFacts(t), cli!(t), t.table);
  assert.deepEqual(tableFacts(CATALOG_STATE.tables.find((t) => t.table === "public.event_log")), { size: "~900 rows", key: "no key",
    state: "cannot be added as it is: no primary key: name the columns that tell its rows apart, mason add event_log --key tenant_id,id (its unique index event_log_tenant_id_id_key)" });
});

test("a table added and tables removed are said as mason add and mason remove print them: the key added, a secret left out", () => {
  const cli = commands as unknown as { addedLines?: (b: unknown, file: string) => unknown; removedReport?: (r: string[], file: string) => unknown };
  assert.equal(typeof cli.addedLines, "function", "src/cli/commands.ts exports addedLines");
  assert.equal(typeof cli.removedReport, "function", "src/cli/commands.ts exports removedReport");
  const addedLines = fn<[unknown, string], unknown>("addedLines"), removedReport = fn<[string[], string], unknown>("removedReport");
  for (const b of Object.values(PICKED)) assert.deepEqual(addedLines(b, FILE), cli.addedLines!(b, FILE), b.table);
  for (const r of [["public.orders"], ["public.orders", "billing.invoices"]]) assert.deepEqual(removedReport(r, FILE), cli.removedReport!(r, FILE));
  const added = (b: unknown) => textOf(fn<[unknown], string>("renderTableAdded")(b));
  assert.equal(added(PICKED.secret), "Added public.accounts to /app/mason/sources/shop.yml: every column but password_hash " +
    "left out password_hash: it looks like a secret, which anyone with a user's password could read (--include password_hash adds it) Dismiss");
  assert.equal(added(PICKED.columns), "Added public.audit to /app/mason/sources/shop.yml: id, name key added: id (a copy always has its key) Dismiss");
  assert.equal(added(PICKED.keyed), "Added public.event_log to /app/mason/sources/shop.yml: every column, copied by tenant_id, id Dismiss");
  assert.equal(added(PICKED.already), "Added public.customers to /app/mason/sources/shop.yml: every column (already so) Dismiss");
  assert.equal(textOf(fn<[unknown], string>("renderTablesRemoved")({ removed: ["public.orders"], file: FILE })),
    "Removed public.orders from /app/mason/sources/shop.yml Tip: Mason stops copying it and drops its copy Dismiss");
});

test("a demo project's database row says it is the demo database Mason hosts, polled only: the page and mason status alike", () => {
  const sourceRows = (commands as unknown as { sourceRows?: (s: RunState) => Array<[string, string]> }).sourceRows!;
  const DEMO = stateOf([copied("public.customers", 1200, "2026-10-27T09:00:01.000Z")], { demo: true });
  assert.equal((DEMO.source as { demo?: boolean }).demo, true, "the run's state says it");
  assert.equal((RUNNING.source as { demo?: boolean }).demo, false);
  const rows = sourceRows(DEMO);
  assert.deepEqual(rows.find(([k]) => k === "Database"), ["Database", "the demo database Mason hosts (postgres://demo@127.0.0.1:5434/demo · Postgres 16.4)"]);
  assert.deepEqual(rows.find(([k]) => k === "Changes"), ["Changes", "polling with SELECTs (xmin), every 5 s · the demo database is read by polling only"]);
  assert.deepEqual(fn<[unknown], unknown>("sourceRows")(DEMO), rows);
});

// ------------------------------------------------------------------ what the page writes

test("running: the database masked, each table copied with its rows, the counts, Ready — and never the engine's name", () => {
  const html = fn<[unknown, unknown?], string>("renderStatus")(RUNNING, { slow: SLOW, refused: REFUSED });
  const text = textOf(html);
  assert.match(text, /Database postgres:\/\/shop:\*\*\*\*@db\.example\.com:5432\/shop · Postgres 16\.4/);
  assert.ok(!text.includes("secret"), "the password is the run's to mask, and it did");
  assert.match(text, /Changes polling with SELECTs \(xmin\), every 5 s/);
  assert.match(text, /Tables \(3 of 4 added\)/);
  assert.match(text, /public\.customers 100% 1,200 rows · copied/);
  assert.match(text, /public\.events 100% 30,000,000 rows · copied/);
  assert.ok(!text.includes("public.audit"), "a table not added is not a line");
  assert.match(text, /Slow queries: 1 in the last day \(1 s or more\)/);
  assert.match(text, /Refused queries: 7 in the last day/);
  assert.match(text, /Ready: every added table is copied and served\./);
  assert.ok(!/duckdb/i.test(html), "the engine is named in the code and the docs, never on the page");
  assert.ok(!/model/i.test(text), "a table is a table");
});

test("copying: the bar's share, the rows, the chunks, the rate and the time left; one waiting; Under way", () => {
  const html = fn<[unknown, unknown?], string>("renderStatus")(COPYING, { slow: { slow: [], slowMs: 1000 }, refused: { total: 0, refused: [] } });
  const text = textOf(html);
  assert.match(html, /<tr class="t-copying"><th scope="row"><code>public\.orders<\/code><\/th><td class="bar"><progress max="100" value="15"><\/progress>/);
  assert.match(text, /public\.orders 15% copying 321,000 of ~2,000,000 rows · 2 chunks reading \(14 s\), 3 of ~20 in · 52,300 rows\/s · ~6 min left/);
  assert.match(text, /public\.events 0% waiting for its copy to start/);
  assert.match(text, /Under way: public\.orders: copying 15% · 321,000 of ~2,000,000 rows .* public\.events: waiting for its copy to start/);
});

test("failed: its error on its line and in full, the warning, a table not kept current, Failed — and a request count that could not be read", () => {
  const html = fn<[unknown, unknown?], string>("renderStatus")(FAILED, { slow: { failure: { code: "failed", message: "the request log cannot be read\nmore" } }, refused: REFUSED });
  const text = textOf(html);
  assert.match(text, /public\.orders 100% its copy failed: could not read the next chunk: connection reset/);
  assert.match(html, /<details><summary>the whole error<\/summary><pre>could not read the next chunk: connection reset\nthe sync tries it again in 5 min<\/pre><\/details>/);
  assert.match(text, /public\.events 100% 30,000,000 rows · copied, NOT kept current \(over the poll's row limit; as of 2026-10-27 09:04 UTC\) — mason sync events, or mason start --replication/);
  assert.match(text, /Warning mason\/sources\/shop\.yml: tables\.ordrs: no such table/);
  assert.match(text, /Changes logical replication: slot mason_dev_shop, publication app_pub \(named: read as it is, never altered\)/);
  assert.match(text, /Slow queries: could not read them \(the request log cannot be read; mason logs has the detail\)/);
  assert.match(text, /Failed: public\.orders: could not read the next chunk: connection reset/);
});

test("no table added: the commands' sentence, and what adds one", () => {
  assert.match(textOf(fn<[unknown, unknown?], string>("renderStatus")(NONE)), /^Source .* No table added yet \(4 in the database\)\. mason tables lists them; mason add <table> copies one\.$/);
});

test("the tables: each of the database's, added, not added or cannot be added with its reason and no Add; Remove asks first", () => {
  type Ui = { removing?: string | null; choosing?: string | null; outcome?: unknown };
  const renderTables = fn<[unknown, Ui?], string>("renderTables");
  const html = renderTables(CATALOG_STATE);
  const text = textOf(html);
  assert.match(text, /^3 of 7 added Table Rows Key /);
  assert.match(text, /public\.customers ~1,200 rows key id added Remove public\.orders /);
  assert.match(text, /public\.audit ~50 rows key id Add Columns… public\.accounts /);
  assert.match(text, /public\.event_log ~900 rows no key cannot be added as it is: no primary key: name the columns that tell its rows apart, mason add event_log --key tenant_id,id \(its unique index event_log_tenant_id_id_key\) Name its key… public\.staging /);
  assert.match(text, /public\.staging rows unknown key id Add Columns…$/);
  assert.match(html, /<button type="button" data-add-table="public\.audit">Add<\/button>/);
  assert.ok(!/data-add-table="public\.(event_log|customers)"/.test(html), "no Add for a table that cannot be added as it is, nor for one added");
  assert.match(html, /<button type="button" data-remove-table="public\.customers">Remove<\/button>/);
  assert.ok(!/duckdb/i.test(html), "never the engine's name");
  // Remove asks first, on its own line only
  const asking = renderTables(CATALOG_STATE, { removing: "public.customers" });
  assert.match(textOf(asking), /public\.customers ~1,200 rows key id added Remove customers\? Mason stops copying it and drops its copy\. Remove customers Cancel public\.orders /);
  assert.match(asking, /data-confirm-remove-table="public\.customers"/);
  assert.ok(!/data-confirm-remove-table="public\.orders"/.test(asking), "only the one asked");
  // the form: a table with no primary key ticks its key and its columns, one with a key its columns only
  const keyForm = renderTables(CATALOG_STATE, { choosing: "public.event_log" });
  assert.match(keyForm, /<form class="pick" data-pick-form="public\.event_log"/);
  assert.match(textOf(keyForm), /Its key: the columns that tell its rows apart, as mason add event_log --key tenant_id bigint id bigint payload jsonb Its columns, as mason add event_log --columns \(none ticked: as mason add event_log ?, every column\) tenant_id bigint id bigint payload jsonb Add event_log Cancel/);
  assert.deepEqual([...keyForm.matchAll(/name="(key|columns)" value="([^"]*)"/g)].map((m) => `${m[1]}=${m[2]}`),
    ["key=tenant_id", "key=id", "key=payload", "columns=tenant_id", "columns=id", "columns=payload"]);
  const columnsForm = renderTables(CATALOG_STATE, { choosing: "public.accounts" });
  assert.ok(!/name="key"/.test(columnsForm) && !/Its key/.test(columnsForm), "a table with a primary key is copied by it: no key to name");
  assert.deepEqual([...columnsForm.matchAll(/name="columns" value="([^"]*)"/g)].map((m) => m[1]), ["id", "email", "password_hash"]);
  assert.ok(!/pattern=|required/.test(keyForm + columnsForm), "the server judges what is sent, never the page");
  // what an add or a remove answered is said under its table; a refusal for a table the list lacks, above the list
  const said = renderTables(CATALOG_STATE, { outcome: { table: "public.accounts", added: PICKED.secret } });
  assert.match(textOf(said), /public\.accounts ~300 rows key id Add Columns… Added public\.accounts to \/app\/mason\/sources\/shop\.yml: every column but password_hash .* public\.event_log /);
  const gone = renderTables(CATALOG_STATE, { outcome: { table: "public.gone", failure: { code: "not_found", message: "public.gone is not a table of shop that this user can read" } } });
  assert.match(textOf(gone), /^✗ public\.gone is not a table of shop that this user can read 3 of 7 added/);
  assert.equal(textOf(renderTables({ ...NONE, tables: [] })), "shop has no table this user can read.");
});

test("a Failure renders as the CLI's four parts: ✗ what is wrong, why, fix, then Next with each command and what it does", () => {
  const html = fn<[Failure], string>("renderFailure")({ code: "refused", message: "there is already a user \"metabase\"", why: "a name names one user", fix: "mason user remove metabase, then mason user add metabase",
    next: [{ command: "mason user list", what: "the users" }, { command: "mason user remove metabase" }] });
  assert.equal(textOf(html), "✗ there is already a user \"metabase\" why a name names one user fix mason user remove metabase, then mason user add metabase Next: mason user list the users mason user remove metabase");
  assert.match(html, /^<div class="failure" role="alert">/);
  assert.equal(textOf(fn<[Failure], string>("renderFailure")({ code: "failed", message: "only this" })), "✗ only this", "no empty why, fix or Next");
});

test("the users: a line each with when it was added, one rotated away said so; Remove asks first; none is said", () => {
  const renderUsers = fn<[unknown, string | null], string>("renderUsers");
  const list = { users: [{ name: "metabase", id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z", live: true },
    { name: "grafana", id: "fedcba9876543210", addedAt: "2026-10-20T08:00:00.000Z", live: false }] };
  const html = renderUsers(list, null);
  assert.match(textOf(html), /metabase 2026-10-27 09:10 UTC · id 0123456789abcdef Remove grafana does not connect: the API key was rotated since it was added 2026-10-20 08:00 UTC/);
  assert.match(html, /<button type="button" data-remove="metabase">Remove<\/button>/);
  const asking = renderUsers(list, "metabase");
  assert.match(textOf(asking), /Remove metabase\? It connects no more, and the sessions it holds end at their next statement\. Remove metabase Cancel/);
  assert.match(asking, /data-confirm-remove="metabase"/);
  assert.ok(!/data-confirm-remove="grafana"/.test(asking), "only the one asked");
  assert.equal(textOf(renderUsers({ users: [] }, null)), "No users yet.");
  assert.equal(textOf(renderUsers({ users: [{ name: "old", id: "0123456789abcdef", addedAt: "2026-10-01T10:00:00.000Z", removedAt: "2026-10-02T10:00:00.000Z", live: false }] }, null)), "No users yet.", "a removed user is not listed as one");
});

test("a user just added: the password and the URL to paste, each with a copy button, and that it will not be shown again", () => {
  const html = fn<[unknown], string>("renderAdded")({ user: "metabase", id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z", password: "mason_0123456789abcdef_" + "a".repeat(32),
    database: "shop", url: `postgres://metabase:mason_0123456789abcdef_${"a".repeat(32)}@127.0.0.1:5433/shop`, host: "127.0.0.1", port: 5433, sslmode: "disable" });
  const text = textOf(html);
  assert.match(text, /^The user metabase added: its password is shown this once url postgres:\/\/metabase:mason_0123456789abcdef_a{32}@127\.0\.0\.1:5433\/shop Copy user metabase password mason_0123456789abcdef_a{32} Copy database shop host 127\.0\.0\.1 port 5433 /);
  assert.match(text, /Paste it into the tool now: Mason keeps no copy of the password, and this page will not show it again\./);
  assert.match(html, /<code id="added-password">mason_0123456789abcdef_a{32}<\/code> <button type="button" data-copy="added-password">Copy<\/button>/);
  assert.ok(!/ssl mode/.test(text), "disable is said by leaving it out, as mason user add does");
});

test("a run that stopped, or a cookie of an earlier run: a plain Failure that says what to do", () => {
  const failureOf = fn<[number | null, string], Failure>("failureOf");
  const gone = failureOf(null, "fetch failed");
  assert.equal(gone.message, "Mason does not answer at this address");
  assert.match(gone.fix!, /^mason start in the project's folder, then mason ui opens this page again/);
  assert.deepEqual(gone.next!.map((s) => s.command), ["mason status", "mason start", "mason ui"]);
  const stale = failureOf(403, "this is mason start's command server for the mason command: a request carries the run's token (Authorization: Bearer, from .mason/config.json)\n");
  assert.equal(stale.message, "this page's cookie is not the running Mason's");
  assert.match(stale.why!, /^this is mason start's command server/);
  assert.deepEqual(stale.next!.map((s) => s.command), ["mason ui"]);
  // the server's own Failure, as it sent it
  const own = { code: "usage", message: "limit is a whole number of requests, 1 to 10000", next: [] };
  assert.deepEqual(failureOf(400, JSON.stringify({ error: own.message, failure: own })), own);
});

// ------------------------------------------------------------------ the app, over a fake fetch

/** A fake run: its answers by method and path, and every request the page made. */
function fakeRun(): { fetch: (p: string, init?: { method?: string; body?: string }) => Promise<Response>; asked: string[]; answers: Map<string, () => Response> } {
  const answers = new Map<string, () => Response>();
  const asked: string[] = [];
  const json = (v: unknown, status = 200) => () => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
  answers.set("GET /api/state", json(COPYING));
  answers.set("GET /api/slow", json(SLOW));
  answers.set("GET /api/refused", json(REFUSED));
  answers.set("GET /api/users", json({ users: [{ name: "metabase", id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z", live: true }] }));
  return {
    asked, answers,
    fetch: async (p, init) => {
      const key = `${init?.method ?? "GET"} ${p}`;
      asked.push(init?.body ? `${key} ${init.body}` : key);
      const a = answers.get(key);
      if (a === undefined) throw new TypeError("fetch failed");
      return a();
    },
  };
}

test("the app: a poll writes the shown page and when, reading only its endpoints; a poll that fails keeps what it knew and says what to do", async () => {
  const run = fakeRun();
  const app = fn<[unknown, () => Date], App>("createApp")(run.fetch, () => new Date(2026, 9, 27, 14, 3, 5));
  assert.match(app.view().status!, /Asking Mason/);
  await app.poll();
  let v = app.view();
  assert.equal(v.where, "shop", "the database; its source's name only when it is another");
  assert.equal(v.updated, "Updated 14:03:05");
  assert.equal(v.poll, "");
  assert.match(textOf(v.status!), /public\.orders 15% copying/);
  assert.deepEqual(run.asked, ["GET /api/state", "GET /api/slow", "GET /api/refused"], "the Status page's reads, no other page's");
  assert.equal(v.users, "", "the users are not read while Status is shown");
  // the Users page shown: its read alone
  app.show("users");
  run.asked.length = 0;
  await app.poll();
  assert.deepEqual(run.asked, ["GET /api/users"]);
  assert.match(textOf(app.view().users!), /^User Added metabase 2026-10-27 09:10 UTC/);
  app.show("status");
  // the run stops
  run.answers.clear();
  await app.poll();
  v = app.view();
  assert.match(textOf(v.poll!), /^✗ Mason does not answer at this address why the run stopped, or runs on another port now \(fetch failed\) fix mason start/);
  assert.match(textOf(v.status!), /public\.orders 15% copying/, "the last status stays, under the failure");
  assert.equal(v.updated, "Updated 14:03:05", "when it last heard, not now");
  for (const part of Object.values(v)) assert.ok(!/duckdb/i.test(part), "never the engine's name");
});

test("the app: an added user's password is written once, gone once dismissed and never again; a refusal renders the Failure", async () => {
  const run = fakeRun();
  const app = fn<[unknown], App>("createApp")(run.fetch);
  const password = `mason_0123456789abcdef_${"b".repeat(32)}`;
  run.answers.set("POST /api/users", () => new Response(JSON.stringify({ user: "grafana", id: "0123456789abcdef", addedAt: "2026-10-27T09:11:00.000Z", password, database: "shop",
    url: `postgres://grafana:${password}@127.0.0.1:5433/shop`, host: "127.0.0.1", port: 5433, sslmode: "disable", next: [] }), { status: 200 }));
  assert.equal(await app.addUser("grafana"), true);
  assert.ok(run.asked.includes(`POST /api/users ${JSON.stringify({ name: "grafana" })}`));
  assert.ok(app.view().added!.includes(password));
  await app.poll();
  assert.ok(app.view().added!.includes(password), "a poll does not take it away before it is copied");
  app.dismissAdded();
  await app.poll();
  assert.ok(Object.values(app.view()).every((part) => !part.includes(password)), "once dismissed, nowhere on the page");
  assert.equal(app.model.added, null, "and not kept");

  run.answers.set("POST /api/users", () => new Response(JSON.stringify({ error: "there is already a user \"grafana\"",
    failure: { code: "refused", message: "there is already a user \"grafana\"", why: "a name names one user", fix: "mason user remove grafana, then mason user add grafana", next: [{ command: "mason user list", what: "the users" }] } }), { status: 409 }));
  assert.equal(await app.addUser("grafana"), false);
  assert.equal(textOf(app.view().action!), "✗ there is already a user \"grafana\" why a name names one user fix mason user remove grafana, then mason user add grafana Next: mason user list the users");
  assert.equal(app.view().added, "");
});

test("the app: Remove asks first, Cancel takes it back, the confirm sends DELETE /api/users/<name> and reads the users again", async () => {
  const run = fakeRun();
  const app = fn<[unknown], App>("createApp")(run.fetch);
  app.show("users");
  await app.poll();
  app.askRemove("metabase");
  assert.match(textOf(app.view().users!), /Remove metabase\? It connects no more/);
  app.cancelRemove();
  assert.ok(!/It connects no more/.test(app.view().users!));
  app.askRemove("metabase");
  run.answers.set("DELETE /api/users/metabase", () => new Response(JSON.stringify({ removed: { name: "metabase", id: "0123456789abcdef", addedAt: "2026-10-27T09:10:11.000Z" }, next: [] }), { status: 200 }));
  run.answers.set("GET /api/users", () => new Response(JSON.stringify({ users: [] }), { status: 200 }));
  run.asked.length = 0;
  assert.equal(await app.confirmRemove("metabase"), true);
  assert.deepEqual(run.asked, ["DELETE /api/users/metabase", "GET /api/users"]);
  assert.equal(textOf(app.view().users!), "No users yet.");
  assert.equal(app.model.confirming, null);
});

test("the app: Add sends POST /api/pick, says what was added under its table, and reads the state again: the copy shows starting", async () => {
  const run = fakeRun();
  run.answers.set("GET /api/state", answer(CATALOG_STATE));
  const app = fn<[unknown], App>("createApp")(run.fetch);
  app.show("tables");
  await app.poll();
  run.answers.set("POST /api/pick", () => {
    // the run writes the sources file: from now on its state has the table added
    run.answers.set("GET /api/state", answer(ACCOUNTS_ADDED));
    return answer({ ...PICKED.secret, state: ACCOUNTS_ADDED })();
  });
  run.asked.length = 0;
  assert.equal(await app.addTable("public.accounts"), true);
  assert.deepEqual(run.asked, [`POST /api/pick ${JSON.stringify({ table: "public.accounts", picked: true })}`, "GET /api/state"],
    "every column, as mason add accounts asks; then the state again (the page's own read: nothing else)");
  const v = app.view();
  assert.match(textOf(v.tables!), /public\.accounts ~300 rows key id added Remove Added public\.accounts to \/app\/mason\/sources\/shop\.yml: every column but password_hash left out password_hash: it looks like a secret/);
  assert.match(textOf(v.status!), /public\.accounts 0% waiting for its copy to start/, "the Status shows the copy starting");
  app.dismissOutcome();
  assert.ok(!/Added public\.accounts/.test(app.view().tables!));
});

test("the app: the form sends the columns ticked as columns and the key's as key, nothing when none is ticked", async () => {
  const run = fakeRun();
  const app = fn<[unknown], App>("createApp")(run.fetch);
  run.answers.set("POST /api/pick", answer({ ...PICKED.keyed, state: COPYING }));
  assert.deepEqual(fn<[string, string[]?, string[]?], unknown>("pickBody")("public.audit", [], []), { table: "public.audit", picked: true });
  app.choose("public.event_log");
  assert.equal(app.model.choosing, "public.event_log");
  assert.equal(await app.addTable("public.event_log", ["payload"], ["tenant_id", "id"]), true);
  assert.equal(run.asked[0], `POST /api/pick ${JSON.stringify({ table: "public.event_log", picked: true, columns: ["payload"], key: ["tenant_id", "id"] })}`);
  assert.equal(app.model.choosing, null, "added: the form closes");
  run.asked.length = 0;
  await app.addTable("public.event_log", [], ["tenant_id", "id"]);
  assert.equal(run.asked[0], `POST /api/pick ${JSON.stringify({ table: "public.event_log", picked: true, key: ["tenant_id", "id"] })}`, "no column ticked: every column");
});

test("the app: a refusal to add renders the server's Failure under its table, in its words, and the form stays open", async () => {
  const run = fakeRun();
  run.answers.set("GET /api/state", answer(CATALOG_STATE));
  const app = fn<[unknown], App>("createApp")(run.fetch);
  await app.poll();
  const message = "public.event_log cannot be added: no primary key: name the columns that tell its rows apart, mason add event_log --key tenant_id,id (its unique index event_log_tenant_id_id_key)";
  run.answers.set("POST /api/pick", answer({ error: message, failure: { code: "refused", message, next: [] } }, 409));
  app.choose("public.event_log");
  run.asked.length = 0;
  assert.equal(await app.addTable("public.event_log"), false);
  assert.deepEqual(run.asked, [`POST /api/pick ${JSON.stringify({ table: "public.event_log", picked: true })}`], "nothing read again: nothing changed");
  const tables = app.view().tables!;
  assert.ok(tables.includes(`<div class="failure" role="alert"><p class="message"><span class="mark" aria-hidden="true">✗</span> ${message}</p></div>`), "the server's words, as renderFailure says them");
  assert.match(tables, /data-pick-form="public\.event_log"/, "the form stays, to name its key");
  // refused with boxes ticked: the form written again under its refusal keeps them ticked
  await app.addTable("public.event_log", ["payload"], ["id"]);
  assert.deepEqual([...app.view().tables!.matchAll(/name="(key|columns)" value="([^"]*)" checked/g)].map((m) => `${m[1]}=${m[2]}`), ["key=id", "columns=payload"]);
  app.cancelChoose();
  // a sources file the run cannot edit: the server's Failure as it sent it
  const file = "mason/sources/ has 2 source files: one source per project for now";
  run.answers.set("POST /api/pick", answer({ error: file, failure: { code: "refused", message: file, next: [] } }, 409));
  await app.addTable("public.audit");
  assert.match(textOf(app.view().tables!), /public\.audit ~50 rows key id Add Columns… ✗ mason\/sources\/ has 2 source files: one source per project for now public\.accounts/);
});

test("the app: Remove asks first, Cancel takes it back, the confirm sends POST /api/remove and reads the state again", async () => {
  const run = fakeRun();
  run.answers.set("GET /api/state", answer(ACCOUNTS_ADDED));
  const app = fn<[unknown], App>("createApp")(run.fetch);
  await app.poll();
  app.askRemoveTable("public.accounts");
  assert.match(textOf(app.view().tables!), /Remove accounts\? Mason stops copying it and drops its copy\. Remove accounts Cancel/);
  app.cancelRemoveTable();
  assert.ok(!/Mason stops copying it/.test(app.view().tables!));
  assert.equal(app.model.removing, null);
  app.askRemoveTable("public.accounts");
  run.answers.set("POST /api/remove", () => {
    run.answers.set("GET /api/state", answer(CATALOG_STATE));
    return answer({ removed: ["public.accounts"], file: FILE, state: CATALOG_STATE })();
  });
  run.asked.length = 0;
  assert.equal(await app.confirmRemoveTable("public.accounts"), true);
  assert.deepEqual(run.asked, [`POST /api/remove ${JSON.stringify({ tables: ["public.accounts"] })}`, "GET /api/state"]);
  assert.match(textOf(app.view().tables!), /public\.accounts ~300 rows key id Add Columns… Removed public\.accounts from \/app\/mason\/sources\/shop\.yml Tip: Mason stops copying it and drops its copy/);
  assert.equal(app.model.removing, null);
  // refused: the server's words
  const message = "shop.yml names no table orders — did you mean `orders`? (it names customers)";
  run.answers.set("POST /api/remove", answer({ error: message, failure: { code: "not_found", message, next: [] } }, 404));
  assert.equal(await app.confirmRemoveTable("public.orders"), false);
  assert.match(textOf(app.view().tables!), /public\.orders .* ✗ shop\.yml names no table orders — did you mean `orders`\? \(it names customers\)/);
});

// ------------------------------------------------------------------ the files: under the CSP, never the token

/** Every file under src/web/ (relative to it): the shell, the shared module, each page's module, the stylesheet. */
const webFiles = (dir = WEB): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? webFiles(path.join(dir, e.name)) : [path.relative(WEB, path.join(dir, e.name))]);

test("the page's files fetch nothing from elsewhere and never touch the token: the address but its hash, the cookie, storage", () => {
  const files = webFiles().sort();
  assert.ok(files.includes(path.join("pages", "status.js")) && files.includes("shared.js"), "the pages' modules are checked with the rest");
  const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  // the nav's links are the page's own hash (#tables): nothing is loaded by them
  assert.deepEqual([...html.matchAll(/(?:src|href)="([^"]*)"/g)].map((m) => m[1]!).filter((u) => !u.startsWith("#")), ["data:,", "/app.css", "/app.js"],
    "every file the page loads is the server's allowlist (or inline); the modules are imported by app.js");
  for (const f of files) {
    const text = fs.readFileSync(path.join(WEB, f), "utf8");
    assert.ok(!/https?:\/\//.test(text), `${f} names no other site: a CDN or a font would break the CSP`);
    assert.ok(!/@import|url\(/.test(text), `${f} loads no stylesheet or font`);
    assert.ok(!/duckdb/i.test(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")), `${f}: never the engine's name`);
    if (!f.endsWith(".js")) continue;
    const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    // the hash chooses the page shown (#status): it never holds the token, which the first request traded for the cookie
    // and dropped from the address; every other part of `location` (search, href) is refused, as the cookie and storage are
    assert.ok(!/\blocation\b(?!\.hash\b)|document\.cookie|localStorage|sessionStorage|indexedDB|[?&]token=|\.token\b/.test(code),
      `${f}: the cookie carries the token; the page's script never reads it, the address (but its hash) or storage`);
    // every module it imports is the page's own, a route of PAGE_ROUTES (tests/cli-run-server.test.ts serves each)
    for (const m of code.matchAll(/\bfrom\s+"([^"]+)"|\bimport\s*\(\s*"([^"]+)"/g)) assert.match(m[1] ?? m[2]!, /^\.\.?\/[\w/.-]+\.js$/, `${f} imports ${m[1] ?? m[2]} by a relative path`);
  }
});

/** The page in a fake browser: elements whose innerHTML reads back as a browser serialises it (a bare data-x attribute
 *  as data-x="", an apostrophe in text as itself), the listeners `start` adds, the interval it sets, and a FormData
 *  that reads a form's ticked boxes from the fake form. */
function fakeBrowser(run: ReturnType<typeof fakeRun>, hash = "") {
  const els = new Map<string, { writes: number; html: string; innerHTML: string; addEventListener: () => void }>();
  const el = (id: string) => els.get(id) ?? (els.set(id, { writes: 0, html: "", addEventListener: () => undefined,
    get innerHTML() { return this.html.replace(/ (data-[a-z-]+)(?=[ >])/g, ' $1=""').replace(/&#39;/g, "'"); },
    set innerHTML(v: string) { this.html = v; this.writes++; } }), els.get(id)!);
  const on = new Map<string, (e: unknown) => Promise<void> | void>();
  const doc = { visibilityState: "visible", getElementById: el, addEventListener: (type: string, f: (e: unknown) => void) => { on.set(type, f); } };
  const location = { hash };
  const onWin = new Map<string, () => void>();
  let tick: (() => void) | null = null;
  class FormData { readonly ticked: Record<string, string[]>; constructor(form: { ticked: Record<string, string[]> }) { this.ticked = form.ticked; } getAll(name: string) { return this.ticked[name] ?? []; } }
  fn<[unknown, unknown], void>("start")(doc, { fetch: run.fetch, FormData, location, addEventListener: (type: string, f: () => void) => { onWin.set(type, f); },
    setInterval: (f: () => void) => { tick = f; return 1; }, setTimeout: (f: () => void, ms: number) => setTimeout(f, ms) });
  /** the reader follows a link of the nav: the hash changes, and the browser says so */
  const go = (to: string) => { location.hash = to; onWin.get("hashchange")!(); };
  return { el, on, doc, go, tick: () => tick!(), settle: () => new Promise((r) => setTimeout(r, 20)) };
}

test("in the browser: each part is written when what it shows changes, never at every poll (a click must find its button)", async () => {
  const run = fakeRun();
  const { el, on, doc, go, tick, settle } = fakeBrowser(run);
  await settle();
  assert.match(textOf(el("status").html), /public\.orders 15% copying/);
  go("#users"); await settle();
  // Remove clicked: the user's row holds the confirm, whose Cancel is a bare data- attribute
  await on.get("click")!({ target: { closest: () => ({ dataset: { remove: "metabase" } }) } });
  const users = el("users");
  assert.match(textOf(users.html), /Remove metabase\? It connects no more/);
  const [usersWrites, statusWrites] = [users.writes, el("status").writes];
  tick(); await settle();
  tick(); await settle();
  assert.equal(users.writes, usersWrites, "the users, unchanged, are not written again: the confirm's button stays the one clicked");
  assert.equal(el("status").writes, statusWrites, "the status, unchanged, is not written again");
  // a hidden tab asks nothing
  doc.visibilityState = "hidden";
  run.asked.length = 0;
  tick(); await settle();
  assert.deepEqual(run.asked, [], "no poll while the tab is hidden");
});

test("in the browser: the tables are written when they change, never at every poll — a Remove's confirm and a form's ticks stay", async () => {
  const run = fakeRun();
  const { el, on, tick, settle } = fakeBrowser(run, "#tables");
  await settle();
  const tables = el("tables");
  assert.match(textOf(tables.html), /public\.orders ~2,000,000 rows key id added Remove/);
  await on.get("click")!({ target: { closest: () => ({ dataset: { removeTable: "public.orders" } }) } });
  assert.match(textOf(tables.html), /Remove orders\? Mason stops copying it and drops its copy\. Remove orders Cancel/);
  let writes = tables.writes;
  tick(); await settle();
  tick(); await settle();
  assert.equal(tables.writes, writes, "the tables, unchanged while a copy moves, are not written again: the confirm stays the one clicked");
  // the run reads the catalog again every few seconds, and a live database's row estimates move (pg_class.reltuples)
  const rowsOf = (orders: number) => answer({ ...COPYING, tables: COPYING.tables.map((t) => t.table === "public.orders" ? { ...t, rows: orders } : t) });
  run.answers.set("GET /api/state", rowsOf(2_000_350));
  tick(); await settle();
  assert.equal(tables.writes, writes, "rows that moved while a Remove asks do not write the tables again: the confirm stays the one clicked");
  assert.match(textOf(tables.html), /public\.orders ~2,000,000 rows key id added Remove orders\? /);
  await on.get("click")!({ target: { closest: () => ({ dataset: { cancelRemoveTable: "" } }) } });
  assert.match(textOf(tables.html), /public\.orders ~2,000,350 rows key id added Remove public\.events/, "Cancel writes the rows as they are now");
  await on.get("click")!({ target: { closest: () => ({ dataset: { choose: "public.audit" } }) } });
  assert.match(tables.html, /data-pick-form="public\.audit"/);
  writes = tables.writes;
  tick(); await settle();
  assert.equal(tables.writes, writes, "the form is not written again under the reader's ticks");
  run.answers.set("GET /api/state", rowsOf(2_000_700));
  tick(); await settle();
  tick(); await settle();
  assert.equal(tables.writes, writes, "nor when the rows moved: the ticks stay");
  assert.match(textOf(tables.html), /public\.orders ~2,000,350 rows /);
  await on.get("click")!({ target: { closest: () => ({ dataset: { cancelChoose: "" } }) } });
  run.answers.set("GET /api/state", rowsOf(2_001_000));
  writes = tables.writes;
  tick(); await settle();
  assert.ok(tables.writes > writes, "the form cancelled, the next poll writes the tables again");
  assert.match(textOf(tables.html), /public\.orders ~2,001,000 rows /);
  run.answers.set("GET /api/state", answer(COPYING));
  await on.get("click")!({ target: { closest: () => ({ dataset: { choose: "public.audit" } }) } });
  // the form submitted: the ticked boxes, as FormData reads them, sent as the columns
  run.answers.set("POST /api/pick", answer({ ...PICKED.columns, state: COPYING }));
  let prevented = false;
  await on.get("submit")!({ target: { dataset: { pickForm: "public.audit" }, ticked: { columns: ["name"] } }, preventDefault: () => { prevented = true; } });
  assert.ok(prevented, "the page posts it, not the browser");
  assert.ok(run.asked.includes(`POST /api/pick ${JSON.stringify({ table: "public.audit", picked: true, columns: ["name"] })}`), run.asked.join("\n"));
  assert.match(textOf(tables.html), /Added public\.audit to \/app\/mason\/sources\/shop\.yml: id, name key added: id/);
});

// ------------------------------------------------------------------ the shell: a page per hash, each polling its own

test("the shell: a page per hash (#status the default, an unknown hash Status), each a module with a section and a route", async () => {
  const routeOf = fn<[string | undefined], string>("routeOf");
  assert.deepEqual(["#status", "#tables", "#queries", "#users", "#usage", "#logs", "", undefined, "#", "#nope", "#Tables", "#tables?x=1"].map(routeOf),
    ["status", "tables", "queries", "users", "usage", "logs", "status", "status", "status", "status", "status", "status"]);
  const pages = (page as unknown as { PAGES?: Array<{ id: string; title: string; create: unknown }> }).PAGES;
  assert.ok(Array.isArray(pages), "src/web/app.js exports PAGES");
  assert.deepEqual(pages!.map((p) => [p.id, p.title]), [["status", "Status"], ["tables", "Tables"], ["queries", "Queries"], ["users", "Users"], ["usage", "Usage"], ["logs", "Logs"]]);
  const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  const { PAGE_ROUTES } = await import("../src/cli/run-server.ts") as { PAGE_ROUTES: Record<string, readonly [string, string]> };
  for (const p of pages!) {
    assert.match(html, new RegExp(`<section id="page-${p.id}" aria-labelledby="${p.id}-h"`), `index.html has ${p.id}'s section`);
    assert.deepEqual(PAGE_ROUTES[`/pages/${p.id}.js`], [`pages/${p.id}.js`, "text/javascript; charset=utf-8"], `${p.id}'s module is a route`);
    // what the page module itself exports: its id and title, as the shell registers it
    const mod = await import(path.join(WEB, "pages", `${p.id}.js`)) as { page: { id: string } };
    assert.equal(mod.page.id, p.id);
  }
  const nav = fn<[string], string>("renderNav")("tables");
  assert.equal(textOf(nav), "Status Tables Queries Users Usage Logs");
  assert.deepEqual([...nav.matchAll(/<a href="(#\w+)"( aria-current="page")?>/g)].filter((m) => m[2]).map((m) => m[1]), ["#tables"], "the page shown is the current one");
  // a page not built yet says so in one line, with the command that shows it today
  const app = fn<[unknown], App>("createApp")(fakeRun().fetch);
  assert.equal(textOf(app.view().queries!), "The statements running now and the request log: not built yet. mason logs --requests shows it in a terminal.");
  assert.match(textOf(app.view().usage!), /not built yet\. mason usage shows it/);
  assert.match(textOf(app.view().logs!), /not built yet\. mason logs --events shows it/);
});

test("the shell: only the page shown is asked, each endpoint at its own rate — the state every poll, the slower ones when due", async () => {
  const run = fakeRun();
  let t = Date.UTC(2026, 9, 27, 9, 0, 0);
  const app = fn<[unknown, () => Date], App>("createApp")(run.fetch, () => new Date(t));
  const asked = async () => { run.asked.length = 0; await app.poll(); return [...run.asked]; };
  assert.deepEqual(await asked(), ["GET /api/state", "GET /api/slow", "GET /api/refused"], "Status, first: everything it reads");
  t += 2000;
  assert.deepEqual(await asked(), ["GET /api/state"], "2 s on: the state alone; the request log's counts are read every 30 s");
  t += 28_000;
  assert.deepEqual(await asked(), ["GET /api/state", "GET /api/slow", "GET /api/refused"], "30 s on: the counts again");
  app.show("tables");
  assert.deepEqual(await asked(), ["GET /api/state"], "Tables: its own reads");
  app.show("users");
  assert.deepEqual(await asked(), ["GET /api/users"]);
  app.show("queries");
  assert.deepEqual(await asked(), [], "a page not built reads nothing");
  // the page's own read failing is the banner; a slower one failing is said where it is shown, never as the banner
  app.show("status");
  run.answers.set("GET /api/slow", answer({ error: "the request log cannot be read", failure: { code: "failed", message: "the request log cannot be read", next: [] } }, 500));
  t += 30_000;
  await app.poll();
  assert.equal(app.view().poll, "");
  assert.match(textOf(app.view().status!), /Slow queries: could not read them \(the request log cannot be read; mason logs has the detail\)/);
});

test("in the browser: the hash chooses the section shown and the page asked; a link followed asks the new page at once", async () => {
  const run = fakeRun();
  const { el, go, settle, tick } = fakeBrowser(run, "#nope");
  await settle();
  const shown = () => ["status", "tables", "queries", "users", "usage", "logs"].filter((id) => (el(`page-${id}`) as unknown as { hidden: boolean }).hidden === false);
  assert.deepEqual(shown(), ["status"], "an unknown hash shows Status");
  assert.match(el("nav").html, /<a href="#status" aria-current="page">Status<\/a>/);
  run.asked.length = 0;
  go("#users"); await settle();
  assert.deepEqual(shown(), ["users"]);
  assert.deepEqual(run.asked, ["GET /api/users"], "the users at once, not at the next tick");
  assert.match(el("nav").html, /<a href="#users" aria-current="page">Users<\/a>/);
  run.asked.length = 0;
  tick(); await settle();
  assert.deepEqual(run.asked, ["GET /api/users"], "and only they while Users is shown");
});

test("in the browser: no part is written while a pointer is pressed — a row that moves every poll keeps the button under the press", async () => {
  const run = fakeRun();
  const { el, on, settle, tick } = fakeBrowser(run);
  await settle();
  const status = el("status");
  const writes = status.writes;
  await on.get("pointerdown")!({});
  run.answers.set("GET /api/state", answer(RUNNING));
  tick(); await settle();
  assert.equal(status.writes, writes, "pressed: the new state waits");
  assert.match(textOf(status.html), /public\.orders 15% copying/);
  // released: written (the shell writes once the release has been handled)
  await on.get("pointerup")!({});
  await settle();
  assert.ok(status.writes > writes);
  assert.match(textOf(status.html), /Ready: every added table is copied and served/);
});
