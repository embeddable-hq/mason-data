/**
 * THE WEB PAGE (src/web/app.js, `mason ui`) under node: what it WRITES from the command server's JSON, never geometry.
 * The fixtures are the server's own: `runState` (src/cli/run-server.ts) over synthetic copies — a run ready, one copying
 * with its chunks' progress, one whose copy failed, a table served but not kept current — and, for a run that stopped,
 * the answers a page gets then (nothing at all; the guard's 403 to a cookie of an earlier run). The page's words are
 * held equal to the commands' (`tableLines`, `copyingText`, `duration`, `sourceRows`), so the two cannot drift; the
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
  poll(): Promise<void>; addUser(name: string): Promise<boolean>; askRemove(name: string): void; cancelRemove(): void;
  confirmRemove(name: string): Promise<boolean>; dismissAdded(): void; view(): Record<string, string>;
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
function stateOf(copies: CopyState[], o: { warnings?: string[]; replication?: boolean; demo?: boolean } = {}): RunState {
  const ctx = {
    source: o.demo ? demoSource : source, ...(o.demo ? { demo: true } : {}), facts: () => ({ version: 160000, versionText: "16.4", standby: false, tables: TABLES, systemIdentifier: null }),
    warnings: o.warnings ?? [], slot: o.replication ? "mason_dev_shop" : "", changes: o.replication ? "replication" : "poll",
    ...(o.replication ? { publication: { name: "app_pub", owned: false } } : {}),
    page: true, folder: () => "/app/mason", root: "/app", sources: () => ({ file: sourceFile, problem: null }),
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

test("the app: a poll writes the status and the users and when; a poll that fails keeps what it knew and says what to do", async () => {
  const run = fakeRun();
  const app = fn<[unknown, () => Date], App>("createApp")(run.fetch, () => new Date(2026, 9, 27, 14, 3, 5));
  assert.match(app.view().status!, /Asking Mason/);
  await app.poll();
  let v = app.view();
  assert.equal(v.where, "shop", "the database; its source's name only when it is another");
  assert.equal(v.updated, "Updated 14:03:05");
  assert.equal(v.poll, "");
  assert.match(textOf(v.status!), /public\.orders 15% copying/);
  assert.match(textOf(v.users!), /^User Added metabase 2026-10-27 09:10 UTC/);
  assert.deepEqual(run.asked, ["GET /api/state", "GET /api/slow", "GET /api/refused", "GET /api/users"]);
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

// ------------------------------------------------------------------ the files: under the CSP, never the token

test("the page's files fetch nothing from elsewhere and never touch the token: the address, the cookie, storage", () => {
  const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  const js = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
  const css = fs.readFileSync(path.join(WEB, "app.css"), "utf8");
  assert.deepEqual([...html.matchAll(/(?:src|href)="([^"]*)"/g)].map((m) => m[1]), ["data:,", "/app.css", "/app.js"], "every file the page loads is the server's allowlist (or inline)");
  for (const [f, text] of [["index.html", html], ["app.js", js], ["app.css", css]] as const) {
    assert.ok(!/https?:\/\//.test(text), `${f} names no other site: a CDN or a font would break the CSP`);
    assert.ok(!/@import|url\(/.test(text), `${f} loads no stylesheet or font`);
  }
  const code = js.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  assert.ok(!/\blocation\b|document\.cookie|localStorage|sessionStorage|[?&]token=|\.token\b/.test(code), "the cookie carries the token; the page's script never reads it, the address or storage");
  assert.ok(!/duckdb/i.test(html + code + css), "never the engine's name");
});

test("in the browser: each part is written when what it shows changes, never at every poll (a click must find its button)", async () => {
  const start = fn<[unknown, unknown], void>("start");
  const run = fakeRun();
  /** An element whose innerHTML reads back as a browser serialises it: a bare data-x attribute as data-x="", an
   *  apostrophe in text as itself. */
  const els = new Map<string, { writes: number; html: string; innerHTML: string; addEventListener: () => void }>();
  const el = (id: string) => els.get(id) ?? (els.set(id, { writes: 0, html: "", addEventListener: () => undefined,
    get innerHTML() { return this.html.replace(/ (data-[a-z-]+)(?=[ >])/g, ' $1=""').replace(/&#39;/g, "'"); },
    set innerHTML(v: string) { this.html = v; this.writes++; } }), els.get(id)!);
  let tick: (() => void) | null = null;
  const on = new Map<string, (e: unknown) => Promise<void> | void>();
  const doc = { visibilityState: "visible", getElementById: el, addEventListener: (type: string, f: (e: unknown) => void) => { on.set(type, f); } };
  const win = { fetch: run.fetch, setInterval: (f: () => void) => { tick = f; return 1; } };
  const settle = () => new Promise((r) => setTimeout(r, 20));
  start(doc, win);
  await settle();
  assert.match(textOf(el("status").html), /public\.orders 15% copying/);
  // Remove clicked: the user's row holds the confirm, whose Cancel is a bare data- attribute
  await on.get("click")!({ target: { closest: () => ({ dataset: { remove: "metabase" } }) } });
  const users = el("users");
  assert.match(textOf(users.html), /Remove metabase\? It connects no more/);
  const [usersWrites, statusWrites] = [users.writes, el("status").writes];
  tick!(); await settle();
  tick!(); await settle();
  assert.equal(users.writes, usersWrites, "the users, unchanged, are not written again: the confirm's button stays the one clicked");
  assert.equal(el("status").writes, statusWrites, "the status, unchanged, is not written again");
  // a hidden tab asks nothing
  doc.visibilityState = "hidden";
  run.asked.length = 0;
  tick!(); await settle();
  assert.deepEqual(run.asked, [], "no poll while the tab is hidden");
});
