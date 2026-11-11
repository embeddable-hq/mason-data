/**
 * A TABLE'S SYNC CHOICE ON THE SERVER (issue 840; src/cli/sync-choice.ts, src/cli/run-server.ts): what the web page
 * reads when a table's Sync choice opens — `GET /api/tables/<table>/sync`, behind the run's guard: each poll's cost, the
 * table's sync now, and Live's checks, the table's own and the database's (`replicationChecks`, the checks `mason
 * start` holds a replicating file to), each failing one named with its fix; the database's read over ONE connection
 * that reads settings and the catalog, never a row; one check at a time for the run — and `/api/pick` reading them
 * AGAIN at save, so a database that changed in between is refused, the file untouched.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { createRunServer, type RunContext } from "../src/cli/run-server.ts";
import { parseSource, type SourceTable } from "../src/cli/preflight.ts";
import { readSource } from "../src/cli/sources.ts";
import type { PgConnection } from "../src/cdc/pg-wire.ts";
// imported when the tests run: at a commit without the module the file still loads, and each test fails by name
const choice = await import("../src/cli/sync-choice.ts" as string).catch(() => ({})) as Partial<typeof import("../src/cli/sync-choice.ts")>;
type LiveCheck = { name: string; state: "ok" | "warn" | "refused"; detail: string; sql?: string };

const col = (name: string, type = "text") => ({ name, type, notNull: false, comment: null });
const table = (o: Partial<SourceTable> & { table: string }): SourceTable => ({
  source: `public.${o.table}`, schema: "public", key: ["id"], rows: 3, bytes: 8192, comment: null,
  columns: [col("id", "bigint"), col("name")], foreignKeys: [], ...o,
});
const TABLES = [table({ table: "orders" }), table({ table: "events", rows: 40_000_000 }), table({ table: "logs", key: [], columns: [{ ...col("id", "bigint"), notNull: true }, col("name")], uniqueKeys: [{ name: "logs_id_key", columns: ["id"], constraint: true, nullsNotDistinct: false }] }), table({ table: "audit", replicaIdentity: "n" })];

// ------------------------------------------------------------------ the database's checks, over a fake connection

/** The server's settings as SERVER_FACTS_SQL answers them (src/cli/replication-checks.ts), a passing primary by default. */
const FACTS = { version: 160004, version_text: "16.4", standby: false, user: "mason_reader", wal_level: "logical", slot_wal_keep_mb: 4096,
  max_slots: 10, slots_used: 2, max_senders: 10, senders_used: 2, superuser: false, replication: true, rds: null, cloud_sql: false,
  hot_standby_feedback: true, idle_in_transaction_ms: 0, statement_timeout_ms: 0 };
/** A connection that answers the checks' statements and records each one sent (every statement, as text). */
function fakePg(facts: Record<string, unknown>, slot: string[] | null = null): { pg: PgConnection; sent: string[] } {
  const sent: string[] = [];
  const pg = { query: async (sql: string) => {
    sent.push(sql);
    if (sql.includes("json_build_object")) return { rows: [[JSON.stringify({ ...FACTS, ...facts })]] };
    if (sql.includes("pg_stat_wal")) return { rows: [["1000000", "100"]] };
    if (sql.includes("pg_replication_slots")) return { rows: slot ? [slot] : [] };
    throw new Error(`a statement the checks do not send: ${sql}`);
  } } as unknown as PgConnection;
  return { pg, sent };
}
const OWN = { slot: "mason_app_app", publication: "mason_app_app", owned: true };
const live = async (facts: Record<string, unknown>, o: { slot?: string[] | null; streaming?: boolean } = {}): Promise<{ checks: LiveCheck[]; sent: string[] }> => {
  assert.equal(typeof choice.sourceLiveChecks, "function", "src/cli/sync-choice.ts exports sourceLiveChecks");
  const f = fakePg(facts, o.slot ?? null);
  return { checks: await choice.sourceLiveChecks!(f.pg, TABLES[0]!, { repl: OWN, streaming: o.streaming ?? false, file: null, shown: "mason/sources/app.yml" }), sent: f.sent };
};
const refusedNames = (checks: LiveCheck[]): string[] => checks.filter((c) => c.state === "refused").map((c) => c.name);

test("Live's checks of the database: each failing one named in mason start's words with its fix — wal_level, no REPLICATION, no free slot, a standby before 16 — and none when they pass", async () => {
  const pass = await live({});
  assert.deepEqual(refusedNames(pass.checks), [], JSON.stringify(pass.checks));
  assert.deepEqual(pass.checks.map((c) => c.name), ["wal_level", "replication role", "slot", "wal senders", "WAL cap", "publication"]);
  assert.match(pass.checks.at(-1)!.detail, /mason_app_app, Mason's own: Mason adds orders to it/);

  const wal = await live({ wal_level: "replica" });
  assert.deepEqual(refusedNames(wal.checks), ["wal_level"]);
  assert.match(wal.checks[0]!.detail, /^replica: logical replication needs logical\. To fix: set wal_level = logical/);

  const role = await live({ replication: false });
  assert.deepEqual(refusedNames(role.checks), ["replication role"]);
  const r = role.checks.find((c) => c.name === "replication role")!;
  assert.equal(r.detail, "mason_reader may not open a replication connection");
  assert.equal(r.sql, "ALTER ROLE mason_reader WITH REPLICATION;", "the SQL that fixes it");

  const slots = await live({ slots_used: 10 });
  assert.deepEqual(refusedNames(slots.checks), ["slot"]);
  assert.match(slots.checks.find((c) => c.name === "slot")!.detail, /^every replication slot is taken \(10 of max_replication_slots 10\): raise max_replication_slots/);

  const senders = await live({ senders_used: 10 });
  assert.deepEqual(refusedNames(senders.checks), ["wal senders"]);

  const old = await live({ standby: true, version: 150004, version_text: "15.4" });
  assert.ok(refusedNames(old.checks).includes("standby"), JSON.stringify(old.checks));
  assert.match(old.checks.find((c) => c.name === "standby")!.detail, /logical decoding on a standby needs Postgres 16/);
  // a standby on 16 decodes, but takes no CREATE PUBLICATION: Mason's own cannot be made there
  const standby16 = await live({ standby: true });
  assert.deepEqual(refusedNames(standby16.checks), ["publication"]);
  const noFeedback = await live({ standby: true, hot_standby_feedback: false });
  assert.equal(noFeedback.checks.find((c) => c.name === "standby")!.state, "warn", "hot_standby_feedback off: said, and acknowledged");
});

test("Live's checks: no WAL cap is a warning, never a refusal; the slot this run reads is its own, another reader's refuses", async () => {
  const uncapped = await live({ slot_wal_keep_mb: -1 });
  assert.deepEqual(refusedNames(uncapped.checks), []);
  const cap = uncapped.checks.find((c) => c.name === "WAL cap")!;
  assert.equal(cap.state, "warn");
  assert.match(cap.detail, /^max_slot_wal_keep_size is unlimited: while Mason is stopped its slot holds every byte of WAL/);
  assert.match(cap.sql ?? "", /^ALTER SYSTEM SET max_slot_wal_keep_size = '\d+GB';/);
  const held = ["true", "4242", "reserved", "pgoutput"];
  assert.deepEqual(refusedNames((await live({ senders_used: 10 }, { slot: held, streaming: true })).checks), [], "this run's own reader and WAL sender");
  assert.deepEqual(refusedNames((await live({}, { slot: held, streaming: false })).checks), ["slot"], "a reader that is not this run's");
});

test("Live's checks read settings and the catalog alone: never a row of the table, and nothing written", async () => {
  const { sent } = await live({});
  assert.ok(sent.length >= 2 && sent.length <= 3, sent.join("\n"));
  for (const sql of sent) {
    assert.match(sql.trim(), /^SELECT /, "a read");
    for (const m of sql.matchAll(/\bFROM\s+(?!now\(\))([a-z_."]+)/gi)) assert.match(m[1]!, /^pg_/, `reads ${m[1]}: only the catalog and the statistics views`);
    assert.doesNotMatch(sql, /orders/, "the table is named nowhere");
  }
});

test("the table's own checks: no primary key and REPLICA IDENTITY NOTHING refuse Live, in mason add's words", () => {
  assert.equal(typeof choice.tableLiveChecks, "function", "src/cli/sync-choice.ts exports tableLiveChecks");
  assert.deepEqual(choice.tableLiveChecks!(TABLES[0]!).map((c) => c.state), ["ok", "ok"]);
  const [key] = choice.tableLiveChecks!(TABLES[2]!);
  assert.deepEqual([key!.name, key!.state], ["primary key", "refused"]);
  assert.equal(key!.detail, "it has no primary key, so logical replication cannot apply its changes by its key — poll it instead, or keep its sync off");
  const [, identity] = choice.tableLiveChecks!(TABLES[3]!);
  assert.deepEqual([identity!.name, identity!.state], ["replica identity", "refused"]);
  assert.match(identity!.detail, /REPLICA IDENTITY NOTHING, and a publication carrying it would make your app's own UPDATEs and DELETEs on it fail/);
});

// ------------------------------------------------------------------ the endpoint and the save, over real HTTP

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sync-choice-"));
const folder = path.join(root, "app", "mason");
const sourceFile = path.join(folder, "sources", "app.yml");
fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
const FILE_TEXT = "kind: postgres\nurl: postgres://me@localhost:5432/app\ntables:\n  orders: {}\n  events: {}\n  logs:\n    key: [id]\n  audit: {}\n";
fs.writeFileSync(sourceFile, FILE_TEXT);
const parsed = parseSource("postgres://me@localhost:5432/app");
assert.ok("source" in parsed);
// no top-level await from here on: a test the runner meets after one has run is never run
const readFile = () => { const r = readSource(folder, path.join(root, "app"), {}); assert.ok(!("message" in r), JSON.stringify(r)); return r; };
// the database's checks as the run would read them (src/cli/dev.ts liveChecks): what a test says, each call counted, and
// how many run at once
let databaseChecks: LiveCheck[] = [{ name: "wal_level", state: "ok", detail: "logical" }];
let checking = 0, mostAtOnce = 0, checked = 0;
const ctx = {
  page: true, users: { file: path.join(root, "users.json"), apiKey: "k".repeat(48), database: "app", postgresUrl: "postgresql://127.0.0.1:5433/app" },
  source: parsed.source, facts: () => ({ version: 160000, versionText: "16", standby: false, tables: TABLES, systemIdentifier: null }), warnings: [],
  replication: () => null, port: 0, token: "t0ken-of-this-run",
  folder: () => folder, root: path.join(root, "app"), home: path.join(root, "app", ".mason"), version: "9.9.9", startedAt: Date.now(),
  sources: () => ({ file: readFile(), problem: null }), sourcesChanged: () => undefined, log: () => undefined,
  readSource: () => readFile(), runUrl: "postgres://me@localhost:5432/app",
  listener: { openSessions: () => ({ open: 0, byClient: [] }) },
  logs: { capacity: 1, recent: () => [] },
  duck: { copies: () => [], file: path.join(root, "duck.db"), stream: async () => null, disk: () => ({ path: root, freeBytes: null, projectedBytes: null }), requests: { days: 7 }, restarts: () => [] },
  liveChecks: async () => {
    checking++; checked++; mostAtOnce = Math.max(mostAtOnce, checking);
    await new Promise((r) => setTimeout(r, 20));
    checking--;
    return databaseChecks;
  },
} as unknown as RunContext;
const server = createRunServer(ctx);
const listening = new Promise<void>((r) => server.listen(0, "127.0.0.1", () => { ctx.port = (server.address() as { port: number }).port; r(); }));
after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });

async function call(method: string, p: string, o: { cookie?: string | null; body?: unknown } = {}): Promise<{ status: number; text: string }> {
  await listening;
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `127.0.0.1:${ctx.port}` };
    const cookie = o.cookie === undefined ? `mason_dev_${ctx.port}=t0ken-of-this-run` : o.cookie;
    if (cookie) headers.Cookie = cookie;
    if (method !== "GET") headers.Origin = `http://127.0.0.1:${ctx.port}`;
    const body = o.body === undefined ? undefined : JSON.stringify(o.body);
    if (body) headers["Content-Type"] = "application/json";
    const req = http.request({ host: "127.0.0.1", port: ctx.port, method, path: p, headers }, (res) => {
      let text = "";
      res.on("data", (b: Buffer) => { text += b.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}
const syncOf = async (t: string) => { const r = await call("GET", `/api/tables/${encodeURIComponent(t)}/sync`); assert.equal(r.status, 200, r.text); return JSON.parse(r.text); };
const save = (t: string, sync: string) => call("POST", "/api/pick", { body: { table: t, picked: true, sync, keep: true } });

test("GET /api/tables/<table>/sync: behind the run's guard — no cookie, a wrong one, refused, nothing read of the database", async () => {
  const before = checked;
  assert.equal((await call("GET", "/api/tables/public.orders/sync", { cookie: null })).status, 403);
  assert.equal((await call("GET", "/api/tables/public.orders/sync", { cookie: `mason_dev_${ctx.port}=another` })).status, 403);
  assert.equal(checked, before, "a refused request never reaches the database");
  const missing = await call("GET", "/api/tables/public.nope/sync");
  assert.equal(missing.status, 404);
  assert.match(JSON.parse(missing.text).failure.message, /no table "public\.nope"/);
});

test("GET /api/tables/<table>/sync: its sync now (off, the default), the polls offered with a big table's cost, and Live's checks — allowed only when every one passes", async () => {
  const orders = await syncOf("public.orders");
  assert.deepEqual(orders.sync, { value: "off", from: "default" }, "a newly added table is off: nothing turns on load by itself");
  assert.deepEqual(orders.polls.map((p: { sync: string; seconds: number; cost: string | null }) => [p.sync, p.seconds, p.cost]),
    [["poll 5m", 300, null], ["poll 15m", 900, null], ["poll 1h", 3600, null], ["poll 1d", 86_400, null]], "presets only; a small table's poll costs nothing worth asking");
  assert.equal(orders.bigRows, false);
  assert.deepEqual(orders.live.checks.map((c: LiveCheck) => [c.name, c.state]), [["primary key", "ok"], ["replica identity", "ok"], ["wal_level", "ok"]]);
  assert.equal(orders.live.allowed, true);
  assert.doesNotMatch(JSON.stringify(orders), /localhost|me@|5432/, "never the database's address or user");

  const events = await syncOf("public.events");
  assert.equal(events.bigRows, true);
  for (const p of events.polls) assert.match(p.cost, /^events has about 40,000,000 rows, and each poll scans it whole on your database: about \d+ s a poll/, "a big table's cost, before it is saved");

  const logs = await syncOf("public.logs");
  assert.equal(logs.live.allowed, false, "no primary key");
  assert.equal(logs.live.checks[0].name, "primary key");

  databaseChecks = [{ name: "wal_level", state: "refused", detail: "replica: logical replication needs logical. To fix: …" }, { name: "WAL cap", state: "warn", detail: "max_slot_wal_keep_size is unlimited" }];
  const refused = await syncOf("public.orders");
  assert.equal(refused.live.allowed, false);
  databaseChecks = [{ name: "WAL cap", state: "warn", detail: "max_slot_wal_keep_size is unlimited" }];
  assert.equal((await syncOf("public.orders")).live.allowed, true, "a warning refuses nothing");
  databaseChecks = [{ name: "wal_level", state: "ok", detail: "logical" }];
});

test("the database's checks run one at a time for the whole run, whoever asks", async () => {
  mostAtOnce = 0;
  await Promise.all(["public.orders", "public.events", "public.orders", "public.audit"].map((t) => syncOf(t)));
  assert.equal(mostAtOnce, 1);
});

test("a run that cannot read the database's checks refuses Live: fail closed", async () => {
  const hook = ctx.liveChecks;
  delete ctx.liveChecks;
  try {
    const r = await syncOf("public.orders");
    assert.equal(r.live.allowed, false);
    assert.equal(r.live.checks.at(-1).name, "database");
  } finally { ctx.liveChecks = hook!; }
});

test("each choice saved by POST /api/pick with keep: only the entry's sync: line written; Off, a poll, Live", async () => {
  for (const [sync, line] of [["poll 5m", "  orders:\n    sync: poll 5m\n"], ["poll 1d", "  orders:\n    sync: poll 1d\n"], ["replication", "  orders:\n    sync: replication\n"], ["off", "  orders:\n    sync: off\n"]] as const) {
    const r = await save("public.orders", sync);
    assert.equal(r.status, 200, r.text);
    assert.equal(JSON.parse(r.text).sync.value, sync);
    const text = fs.readFileSync(sourceFile, "utf8");
    assert.ok(text.includes(line), `${sync}:\n${text}`);
    assert.ok(text.includes("  logs:\n    key: [id]\n"), "every other entry as it was");
  }
  // a table added with its key: (no primary key) is polled or turned off like any other, its key kept
  const keyed = await save("public.logs", "poll 1h");
  assert.equal(keyed.status, 200, keyed.text);
  assert.ok(fs.readFileSync(sourceFile, "utf8").includes("  logs:\n    key: [id]\n    sync: poll 1h\n"), fs.readFileSync(sourceFile, "utf8"));
  fs.writeFileSync(sourceFile, FILE_TEXT);
});

test("saving Live reads the database's checks AGAIN: one that fails since the choice opened is refused in mason start's words, the file untouched", async () => {
  assert.equal((await syncOf("public.orders")).live.allowed, true, "Live allowed when the choice opened");
  try {
    databaseChecks = [{ name: "replication role", state: "refused", detail: "mason_reader may not open a replication connection", sql: "ALTER ROLE mason_reader WITH REPLICATION;" }];
    const before = checked;
    const r = await save("public.orders", "replication");
    assert.equal(r.status, 409);
    assert.equal(checked, before + 1, "read again at save");
    const f = JSON.parse(r.text).failure;
    assert.equal(f.message, "orders cannot be kept current by logical replication from app: replication role");
    assert.equal(f.why, "replication role: mason_reader may not open a replication connection (ALTER ROLE mason_reader WITH REPLICATION;)");
    assert.match(f.fix, /^poll it instead: mason add orders --sync "poll 5m"/);
    assert.equal(fs.readFileSync(sourceFile, "utf8"), FILE_TEXT, "nothing written");
    // a poll, Off, or a table already replicated: no check of the database is read for them
    assert.equal((await save("public.orders", "poll 15m")).status, 200);
    assert.equal(checked, before + 1);
    // the table's own refusal is mason add's, worded as ever
    const keyless = await save("public.logs", "replication");
    assert.equal(keyless.status, 400, keyless.text);
    assert.match(JSON.parse(keyless.text).failure.message, /^public\.logs cannot be kept current by logical replication: it has no primary key/);
  } finally { databaseChecks = [{ name: "wal_level", state: "ok", detail: "logical" }]; fs.writeFileSync(sourceFile, FILE_TEXT); }
});

test("read-only: MASON_PROJECT_READONLY=1 refuses the save and writes nothing; the choice is still read (a GET), which the page shows without a control", async () => {
  process.env.MASON_PROJECT_READONLY = "1";
  try {
    const r = await save("public.orders", "poll 5m");
    assert.equal(r.status, 409);
    assert.match(JSON.parse(r.text).failure.message, /MASON_PROJECT_READONLY/);
    assert.equal(fs.readFileSync(sourceFile, "utf8"), FILE_TEXT);
    assert.match(JSON.parse((await call("GET", "/api/state")).text).sourcesReadOnly, /MASON_PROJECT_READONLY=1/);
  } finally { delete process.env.MASON_PROJECT_READONLY; }
});

test("read-only: a page under MASON_UI_READ_ONLY=1 may read the choice, never save it — unless MASON_UI_READ_ONLY_ALLOW=tables", async () => {
  ctx.pageReadOnly = true;
  try {
    assert.equal((await call("GET", "/api/tables/public.orders/sync")).status, 200);
    assert.equal((await save("public.orders", "poll 5m")).status, 403);
    assert.equal(fs.readFileSync(sourceFile, "utf8"), FILE_TEXT);
    ctx.pageReadOnlyAllow = ["tables"];
    assert.equal((await save("public.orders", "poll 5m")).status, 200);
  } finally { ctx.pageReadOnly = false; ctx.pageReadOnlyAllow = []; fs.writeFileSync(sourceFile, FILE_TEXT); }
});
