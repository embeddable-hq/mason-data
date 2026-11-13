/**
 * A TABLE'S SYNC CHOICE ON THE WEB PAGE'S TABLES (issue 840; src/web/pages/tables.js): every added table says its sync on
 * its note — Off, Every 5 minutes, Live (replication) — and, where the page may edit the sources file, opens a dialog
 * beside it: Off, a poll at each preset (each saying it scans the whole table at that interval, a big table's cost asked
 * before saving), or Live, chosen only when every check passes, else shown disabled with each failing check in the
 * server's words and the SQL that fixes it, a warning asked before saving, and what Live keeps on the database said. A
 * choice is saved by `POST api/pick` `{ table, picked, sync, keep }` (`mason add <table> --sync …`), its refusal shown as
 * the run words it. Read-only, the words alone. The renderers run on the server's own state (`runState`), the app over a
 * fake `fetch`, asserting on what the page WROTE.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runState, type RunContext } from "../src/cli/run-server.ts";
import { parseSource, type SourceTable } from "../src/cli/preflight.ts";
import { parseSourceText } from "../src/cli/sources.ts";
import type { CopyState } from "../src/duck/sync.ts";

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "web");
// imported when the tests run: at a commit without them the file still loads, and each test fails by name
const tables = await import(path.join(WEB, "pages", "tables.js") as string).catch(() => ({})) as Record<string, unknown>;
const appModule = await import(path.join(WEB, "app.js") as string).catch(() => ({})) as Record<string, unknown>;
const fn = <F>(m: Record<string, unknown>, name: string): F => { assert.equal(typeof m[name], "function", `exports ${name}`); return m[name] as F; };
const renderTables = (s: unknown, ui: Record<string, unknown> = {}): string => fn<(s: unknown, ui: unknown) => string>(tables, "renderTables")(s, ui);
const renderSyncChoice = (t: unknown, c: unknown, ask: string | null = null): string => fn<(t: unknown, c: unknown, a: string | null) => string>(tables, "renderSyncChoice")(t, c, ask);

const textOf = (html: string): string => html.replace(/<wbr>/g, "").replace(/<[^>]*>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"")
  .replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
/** The popover beside an element (`pop` of src/web/shared.js), or "". */
const popOf = (html: string, anchor: string): string => {
  const at = html.indexOf(`data-anchor="${anchor}"`);
  if (at < 0) return "";
  const start = html.lastIndexOf("<div", at);
  let depth = 0;
  const tag = /<\/?div\b[^>]*>/g;
  tag.lastIndex = start;
  for (let t = tag.exec(html); t !== null; t = tag.exec(html)) {
    depth += t[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(start, tag.lastIndex);
  }
  return "";
};

// ------------------------------------------------------------------ fixtures: the server's state over synthetic copies

const col = (name: string, type = "text") => ({ name, type, notNull: false, comment: null });
const table = (name: string, rows: number): SourceTable => ({ source: `public.${name}`, schema: "public", table: name, key: ["id"], rows, bytes: 8192, comment: null,
  columns: [col("id", "bigint"), col("name")], foreignKeys: [] });
const TABLES = [table("customers", 1200), table("orders", 40_000_000), table("events", 3000), table("audit", 50)];
const parsed = parseSource("postgres://shop:secret@db.example.com:5432/shop");
const source = "source" in parsed ? parsed.source : assert.fail(parsed.problem);
const FILE = parseSourceText("kind: postgres\nurl: x\ntables:\n  customers: {}\n  orders:\n    sync: poll 5m\n  events:\n    sync: replication\n", "shop", "/app/mason/sources/shop.yml");
assert.ok(!("problems" in FILE));
const at = "2026-11-11T09:00:00.000Z";
const copied = (s: string, rows: number, kept: CopyState["kept"]): CopyState => ({ source: s, phase: "copied", rows, bytes: 1, seconds: 1, copiedAt: at, error: null, ...(kept ? { kept } : {}) });
const COPIES = [copied("public.customers", 1200, { by: "poll", sync: { mode: "off" }, syncedAt: at, nextAt: null }),
  copied("public.orders", 40_000_000, { by: "poll", sync: { mode: "poll", every: "5m", seconds: 300 }, syncedAt: at, nextAt: at }),
  copied("public.events", 3000, { by: "replication", slot: "mason_shop", state: "streamed", why: null, position: "0/1", lastCommit: null, notRunning: null, syncedAt: at })];
function stateOf(o: { pageReadOnly?: boolean; allow?: string[]; sourcesReadOnly?: string } = {}): Record<string, unknown> {
  const ctx = {
    source, facts: () => ({ version: 160000, versionText: "16.4", standby: false, tables: TABLES, systemIdentifier: null }), warnings: [],
    replication: () => ({ slot: "mason_shop", publication: "mason_shop", owned: true }), page: true,
    ...(o.pageReadOnly ? { pageReadOnly: true, pageReadOnlyAllow: o.allow ?? [] } : {}),
    users: { file: "/app/.mason/users.json", apiKey: "k".repeat(32), database: "shop", postgresUrl: "postgresql://127.0.0.1:5433/shop" },
    folder: () => "/app/mason", root: "/app", home: "/app/.mason", version: "0.9.0", startedAt: Date.parse(at),
    sources: () => ({ file: FILE, problem: null }), listener: { openSessions: () => ({ open: 0, byClient: [] }) },
    duck: { file: "/app/.mason/duck.db", requests: { days: 7 }, restarts: () => [], disk: () => ({ path: "/app/.mason", freeBytes: null, projectedBytes: null }) },
  } as unknown as RunContext;
  const s = JSON.parse(JSON.stringify(runState(ctx, COPIES, null, Date.parse(at)))) as Record<string, unknown>;
  return o.sourcesReadOnly ? { ...s, sourcesReadOnly: o.sourcesReadOnly } : s;
}
const STATE = stateOf();
const tableOf = (name: string) => (STATE.tables as Array<{ table: string }>).find((t) => t.table === name)!;

/** `GET api/tables/<table>/sync`'s answer (src/cli/sync-choice.ts SyncChoice). */
type Cost = (seconds: number) => Record<string, unknown>;
const POLLS = (cost: Cost | null) => ([["poll 5m", 300], ["poll 15m", 900], ["poll 1h", 3600], ["poll 1d", 86_400]] as const).map(([sync, seconds]) => ({ sync, seconds, cost: cost ? cost(seconds) : null }));
const PASSING = [{ name: "primary key", state: "ok", detail: "id" }, { name: "replica identity", state: "ok", detail: "DEFAULT (its primary key)" },
  { name: "wal_level", state: "ok", detail: "logical" }, { name: "replication role", state: "ok", detail: "mason_reader may replicate (REPLICATION)" },
  { name: "WAL cap", state: "ok", detail: "max_slot_wal_keep_size = 4GB" }];
const choiceOf = (name: string, o: { sync?: string; checks?: unknown[]; cost?: Cost | null; big?: boolean } = {}) => {
  const checks = (o.checks ?? PASSING) as Array<{ state: string }>;
  return { table: name, sync: { value: o.sync ?? "off", from: o.sync ? "entry" : "default" }, rows: 1200, polls: POLLS(o.cost ?? null), bigRows: o.big ?? false,
    live: { allowed: checks.every((c) => c.state !== "refused"), checks } };
};
/** A big table's cost at each interval, as src/cli/source-edit.ts pollLoad answers it: a scan of `scan` seconds, a poll
 *  waiting four times that. */
const costOf = (scan: number, basis = "assumed"): Cost => (seconds) => {
  const every = Math.max(seconds, 4 * scan);
  return { rows: 40_000_000, scanSeconds: scan, everySeconds: every, busyPercent: Math.round((scan / every) * 100), basis, rowsPerSecond: 1_800_000 };
};
const COST = costOf(22);
const LEAD = "orders has about 40,000,000 rows. Each scheduled sync scans the whole table on your database, about 22 seconds a scan (a rough guess, since nothing is measured yet).";
/** Each check that refuses Live the issue names, in the server's words (src/cli/replication-checks.ts, sync-choice.ts). */
const FAILING = [
  { name: "primary key", state: "refused", detail: "it has no primary key, so logical replication cannot apply its changes by its key — poll it instead, or keep its sync off" },
  { name: "wal_level", state: "refused", detail: "replica: logical replication needs logical. To fix: set wal_level = logical (ALTER SYSTEM SET wal_level = logical, or postgresql.conf; a managed Postgres: its parameter or flag of that name), then restart Postgres." },
  { name: "replication role", state: "refused", detail: "mason_reader may not open a replication connection", sql: "ALTER ROLE mason_reader WITH REPLICATION;" },
  { name: "slot", state: "refused", detail: "every replication slot is taken (10 of max_replication_slots 10): raise max_replication_slots (a restart), or drop a slot nobody reads" },
  { name: "standby", state: "refused", detail: "a read replica on Postgres 15.4: logical decoding on a standby needs Postgres 16. Point Mason at the primary, upgrade the replica, or poll the table" },
];

// ------------------------------------------------------------------ the list

test("every added table says its sync on its note, in the page's words, and opens its choice there; one not added has none", () => {
  const html = renderTables(STATE);
  const text = textOf(html);
  assert.match(text, /public\.customers Synced .* Remove Sync: Off All columns public\.orders /);
  assert.match(text, /public\.orders Synced .* Remove Sync: Every 5 minutes All columns public\.events /);
  assert.match(text, /public\.events Synced .* Remove Sync: Live \(replication\) All columns/);
  for (const t of ["public.customers", "public.orders", "public.events"]) assert.match(html, new RegExp(`<button type="button" class="small link syncnow" id="sync-tables-${t.replace(".", "\\.")}" data-choose-sync="${t.replace(".", "\\.")}"`));
  assert.ok(!html.includes('data-choose-sync="public.audit"'), "no choice for a table not added");
});

test("read-only: no choice where the project's files are read-only or the page may not edit tables — the sync said alone, the reason its title and above the list", () => {
  const why = "the project's files are read-only here (MASON_PROJECT_READONLY=1); edit them where they are committed, and deploy";
  for (const s of [stateOf({ sourcesReadOnly: why }), stateOf({ pageReadOnly: true }), stateOf({ pageReadOnly: true, allow: ["users"] })]) {
    const html = renderTables(s, { syncOpen: "public.customers", syncChoice: choiceOf("public.customers") });
    assert.ok(!html.includes("data-choose-sync"), "no button");
    assert.ok(!html.includes("data-sync-form") && !html.includes("data-save-sync"), "no dialog, even one the model says is open");
    assert.match(html, /<span class="syncnow dim" title="[^"]+">Sync: Off<\/span>/);
    assert.match(textOf(html), /Tables are not added(,| or) removed/, "the reason, above the list");
  }
  assert.ok(renderTables(stateOf({ sourcesReadOnly: why })).includes(`title="${why.replace(/'/g, "&#39;")}">Sync: Off`));
  // a read-only page that still edits its tables (MASON_UI_READ_ONLY_ALLOW=tables) offers the choice
  assert.ok(renderTables(stateOf({ pageReadOnly: true, allow: ["tables"] })).includes('data-choose-sync="public.customers"'));
});

// ------------------------------------------------------------------ the dialog

test("the choice: Off checked for a table on the default, each poll saying it scans the whole table at its interval, Live allowed when every check passes, and what Live keeps on the database", () => {
  const html = renderSyncChoice(tableOf("public.customers"), choiceOf("public.customers"));
  const text = textOf(html);
  assert.match(html, /<input type="radio" name="sync" value="off" checked>/, "Off: the default, nothing turns on load by itself");
  assert.equal([...html.matchAll(/ checked/g)].length, 1);
  for (const [value, words] of [["poll 5m", "5 minutes"], ["poll 15m", "15 minutes"], ["poll 1h", "hour"], ["poll 1d", "day"]]) {
    assert.match(html, new RegExp(`value="${value}">`));
    assert.ok(text.includes(`Scans the whole table on your database every ${words}.`), words);
  }
  assert.match(html, /<input type="radio" name="sync" value="replication">/, "Live may be chosen");
  assert.ok(text.includes("Live (replication) Changes stream from your database's change log. No scans."));
  assert.ok(text.includes(tables.LIVE_SLOT_WORDS as string), "what the slot holds if Mason stops reading");
  assert.match(tables.LIVE_SLOT_WORDS as string, /^Live keeps a replication slot on your database\. While Mason is not reading it \(stopped or down\), the slot keeps all the WAL/);
  assert.match(text, /The checks that pass \(5\)/, "the passing checks behind a closed details");
  assert.ok(!text.includes("Live cannot be chosen"));
  // its sync now is the one checked, and an interval the page does not offer is kept as a choice of its own
  assert.match(renderSyncChoice(tableOf("public.orders"), choiceOf("public.orders", { sync: "poll 5m" })), /value="poll 5m" checked>/);
  const odd = renderSyncChoice(tableOf("public.orders"), choiceOf("public.orders", { sync: "poll 30s" }));
  assert.match(odd, /value="poll 30s" checked>/);
  assert.ok(textOf(odd).includes("Every 30 seconds (current)"));
});

test("Live greyed out with each failing check named in the server's words and the SQL that fixes it: no key, wal_level, no REPLICATION, no free slot, a standby before 16", () => {
  for (const failing of FAILING) {
    const html = renderSyncChoice(tableOf("public.customers"), choiceOf("public.customers", { checks: [...PASSING.slice(2), failing] }));
    const text = textOf(html);
    assert.match(html, /<label class="choice disabled"><input type="radio" name="sync" value="replication" disabled>/, failing.name);
    assert.ok(text.includes(`Live cannot be chosen: ${failing.name}.`), text);
    assert.ok(text.includes(`fails ${failing.name} ${failing.detail}`), `${failing.name}: its words as the server says them`);
    if (failing.sql) assert.ok(html.includes(`<pre class="sql"><code>${failing.sql}</code></pre>`), "the SQL that fixes it");
  }
  // all at once: each named
  const all = textOf(renderSyncChoice(tableOf("public.customers"), choiceOf("public.customers", { checks: FAILING })));
  assert.ok(all.includes(`Live cannot be chosen: ${FAILING.map((c) => c.name).join(", ")}.`));
  // the page re-decides nothing: allowed is the server's
  assert.match(renderSyncChoice(tableOf("public.customers"), { ...choiceOf("public.customers"), live: { allowed: false, checks: [] } }), /value="replication" disabled>/);
});

test("asked before saving: a big table's poll with its cost; Live with a warning, the warning said", () => {
  const syncQuestion = fn<(c: unknown, v: string) => { lines: string[]; ask: string; yes: string } | null>(tables, "syncQuestion");
  const big = choiceOf("public.orders", { big: true, cost: COST, sync: "poll 5m" });
  assert.equal(syncQuestion(choiceOf("public.customers"), "poll 5m"), null, "a small table's poll is saved at once");
  assert.equal(syncQuestion(big, "off"), null);
  const HOUR = "One connection to your database is busy about 1% of the time.";
  assert.deepEqual(syncQuestion(big, "poll 1h"), { lines: [LEAD, HOUR], ask: "Scan all of orders on your database every hour?", yes: "Poll it every hour" });
  const asked = textOf(renderSyncChoice(tableOf("public.orders"), big, "poll 1h"));
  assert.ok(asked.startsWith(`${LEAD} ${HOUR} Scan all of orders on your database every hour? Poll it every hour Back Cancel`), asked);
  // in the choice: what every interval shares said ONCE, over the choices; each interval's own share under it
  const choice = renderSyncChoice(tableOf("public.orders"), big);
  assert.equal(choice.split("has about 40,000,000 rows").length - 1, 1, "the table's rows and a scan's length said once");
  assert.match(textOf(choice), new RegExp(`^How Mason keeps orders up to date after its first sync ${LEAD.replace(/[.()]/g, "\\$&")} Off `));
  assert.ok(textOf(choice).includes("Every 15 minutes Scans the whole table on your database every 15 minutes. One connection to your database is busy about 2% of the time."));
  assert.ok(textOf(choice).includes("Every day Scans the whole table on your database every day. One connection to your database is busy less than 1% of the time."));
  assert.doesNotMatch(choice, /--sync|stretched|backend/, "the page's words, never the CLI's");
  assert.match(choice, /<span class="choice-cost">One connection[^<]*about 7%/, "under 10 %: quiet");
  // a scan long enough to stretch the interval says so, and a share of 10 % or more is in the warning colour
  const slow = renderSyncChoice(tableOf("public.orders"), choiceOf("public.orders", { big: true, cost: costOf(100, "first-sync"), sync: "poll 5m" }));
  assert.match(textOf(slow), /about 2 minutes a scan \(estimated from how fast its first sync read it\)/);
  assert.match(slow, /<span class="choice-cost high">It runs every 7 minutes at most, since a scan waits four times its own length\. One connection to your database is busy about 25% of the time\.<\/span>/);
  // a short scan is said plainly: "under a second", never "about 0 seconds"; one second is singular
  const quick = textOf(renderSyncChoice(tableOf("public.orders"), choiceOf("public.orders", { big: true, cost: costOf(0.3, "measured"), sync: "poll 5m" })));
  assert.match(quick, /scans the whole table on your database, under a second a scan \(measured at its last scheduled sync\)\./);
  assert.doesNotMatch(quick, /about 0 seconds/);
  assert.match(textOf(renderSyncChoice(tableOf("public.orders"), choiceOf("public.orders", { big: true, cost: costOf(1.2), sync: "poll 5m" }))), /about 1 second a scan /);
  const warned = choiceOf("public.customers", { checks: [...PASSING.slice(0, 4), { name: "WAL cap", state: "warn", detail: "max_slot_wal_keep_size is unlimited: while Mason is stopped its slot holds every byte of WAL" }] });
  assert.equal(warned.live.allowed, true);
  assert.deepEqual(syncQuestion(warned, "replication"), { lines: ["WAL cap: max_slot_wal_keep_size is unlimited: while Mason is stopped its slot holds every byte of WAL"],
    ask: "Keep customers up to date by logical replication, with this warning?", yes: "Save Live (replication)" });
  assert.equal(syncQuestion(choiceOf("public.customers"), "replication"), null, "no warning: saved at once");
});

test("a dialog too tall for the room above or below its sync stays inside the window, where its Save and Cancel can be reached", () => {
  const placePops = fn<(d: unknown, w: unknown) => unknown[]>(appModule, "placePops");
  const tall = { dataset: { anchor: "s" }, offsetWidth: 600, offsetHeight: 760, hidden: false, style: {} as Record<string, string> };
  const anchor = { getBoundingClientRect: () => ({ left: 300, top: 420, right: 400, bottom: 440, width: 100, height: 20 }) };
  placePops({ querySelectorAll: () => [tall], getElementById: () => anchor }, { innerWidth: 1280, innerHeight: 900 });
  assert.deepEqual(tall.style, { left: "16px", top: "124px" }, "its bottom 16 px above the window's");
});

// ------------------------------------------------------------------ the app over a fake run

type App = Record<string, (...a: never[]) => unknown> & { model: Record<string, unknown>; view(): Record<string, string>; show(id: string): void; poll(): Promise<void> };
function fakeRun(state: unknown) {
  const answers = new Map<string, () => Response>();
  const asked: string[] = [];
  const gates: Array<() => void> = [];
  let gated = false;
  const json = (v: unknown, status = 200) => () => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
  answers.set("GET api/state", json(state));
  answers.set("GET api/usage?since=1m", json({ copySizes: [], samples: [] }));
  return {
    asked, answers, json, gate: (on: boolean) => { gated = on; }, release: () => { for (const g of gates.splice(0)) g(); },
    fetch: async (p: string, init?: { method?: string; body?: string }) => {
      assert.match(p, /^api\//);
      const key = `${init?.method ?? "GET"} ${p}`;
      asked.push(init?.body ? `${key} ${init.body}` : key);
      if (gated && /\/sync$/.test(p)) await new Promise<void>((r) => gates.push(r));
      const a = answers.get(key);
      if (a === undefined) throw new TypeError("fetch failed");
      return a();
    },
  };
}
/** The Tables page's own state (its `model`), as the app keeps it. */
const tablesModel = (app: App): Record<string, unknown> => (app as unknown as { pages: Map<string, { model: Record<string, unknown> }> }).pages.get("tables")!.model;
async function appOver(state = STATE) {
  const run = fakeRun(state);
  const app = fn<(f: unknown) => App>(appModule, "createApp")(run.fetch);
  app.show("tables");
  await app.poll();
  run.asked.length = 0;
  return { run, app, call: <R>(name: string, ...a: unknown[]): R => (app[name] as unknown as (...x: unknown[]) => R)(...a) };
}

test("the app: opening the choice reads GET api/tables/<table>/sync once (never with the state); the list held still while it is open", async () => {
  const { run, app, call } = await appOver();
  run.answers.set("GET api/tables/public.customers/sync", run.json(choiceOf("public.customers")));
  assert.equal(await call<Promise<boolean>>("chooseSync", "public.customers"), true);
  assert.deepEqual(run.asked, ["GET api/tables/public.customers/sync"]);
  const html = app.view().tables!;
  const dialog = popOf(html, "sync-tables-public.customers");
  assert.match(dialog, /role="dialog" aria-label="Sync customers"/);
  assert.match(dialog, /data-sync-form="public\.customers"/);
  assert.match(html, /id="sync-tables-public\.customers" data-choose-sync="public\.customers" aria-expanded="true"/);
  assert.ok(tablesModel(app).held !== null, "the list frozen while the choice is open");
  // a poll asks the state, never the database's checks again: no caching beyond the open dialog, no timer
  run.asked.length = 0;
  await app.poll();
  assert.ok(!run.asked.some((a) => a.includes("/sync")), run.asked.join("\n"));
  call("cancelSync");
  assert.equal(popOf(app.view().tables!, "sync-tables-public.customers"), "");
  assert.equal(tablesModel(app).held, null);
});

test("the app: each choice saved by POST api/pick { table, picked, sync, keep: true }, then the state read again; the answer said beside its sync", async () => {
  for (const value of ["off", "poll 5m", "poll 15m", "poll 1h", "poll 1d", "replication"]) {
    const { run, app, call } = await appOver();
    run.answers.set("GET api/tables/public.customers/sync", run.json(choiceOf("public.customers")));
    run.answers.set("POST api/pick", run.json({ table: "public.customers", file: "/app/mason/sources/shop.yml", entry: "customers", columns: null, exclude: [], key: null, addedKey: [], skippedSecrets: [],
      already: false, sync: { value, from: "entry" }, bigOff: false, notReplicated: null, pollCost: null }));
    await call("chooseSync", "public.customers");
    run.asked.length = 0;
    assert.equal(await call<Promise<boolean>>("chooseSyncValue", "public.customers", value), true, value);
    assert.deepEqual(run.asked, [`POST api/pick ${JSON.stringify({ table: "public.customers", picked: true, sync: value, keep: true })}`, "GET api/state"], value);
    const said = textOf(popOf(app.view().tables!, "sync-tables-public.customers"));
    // the sync saved, in the page's words: never "Added" (the table was added before), never the sources file
    const words = value === "off" ? "Off: after its first sync, it syncs only when you press Sync now\\."
      : value === "replication" ? "Live: after its first sync, changes stream from your database's change log\\."
      : `${({ "poll 5m": "every 5 minutes", "poll 15m": "every 15 minutes", "poll 1h": "every hour", "poll 1d": "every day" } as Record<string, string>)[value]}: after its first sync, Mason checks it for changes on that schedule\\.`;
    assert.match(said, new RegExp(`^Saved customers's sync\\. Its sync is ${words} Dismiss$`), said);
    assert.equal(tablesModel(app).syncOpen, null);
  }
});

test("the app: a big table's poll asks first with its cost; Back returns to the choice; its yes saves", async () => {
  const { run, app, call } = await appOver();
  run.answers.set("GET api/tables/public.orders/sync", run.json(choiceOf("public.orders", { big: true, cost: COST, sync: "poll 5m" })));
  run.answers.set("POST api/pick", run.json({ table: "public.orders", file: "/app/mason/sources/shop.yml", entry: "orders", columns: null, exclude: [], key: null, addedKey: [], skippedSecrets: [],
    already: false, sync: { value: "poll 1h", from: "entry" }, bigOff: false, notReplicated: null, pollCost: null }));
  await call("chooseSync", "public.orders");
  run.asked.length = 0;
  assert.equal(await call("chooseSyncValue", "public.orders", "poll 1h"), true);
  assert.deepEqual(run.asked, [], "nothing saved before the person says yes");
  const asking = popOf(app.view().tables!, "sync-tables-public.orders");
  assert.ok(textOf(asking).startsWith(`${LEAD} One connection to your database is busy about 1% of the time. Scan all of orders on your database every hour?`));
  assert.match(asking, /data-save-sync="public\.orders" data-sync="poll 1h">Poll it every hour</);
  call("backSync");
  assert.match(popOf(app.view().tables!, "sync-tables-public.orders"), /data-sync-form="public\.orders"/);
  await call("chooseSyncValue", "public.orders", "poll 1h");
  assert.equal(await call<Promise<boolean>>("saveSync", "public.orders", "poll 1h"), true);
  assert.equal(run.asked[0], `POST api/pick ${JSON.stringify({ table: "public.orders", picked: true, sync: "poll 1h", keep: true })}`);
});

test("the app: a check that fails between opening and saving — the run's refusal at save shown as it is, beside the sync, until dismissed", async () => {
  const { run, app, call } = await appOver();
  run.answers.set("GET api/tables/public.customers/sync", run.json(choiceOf("public.customers")));
  await call("chooseSync", "public.customers");
  const failure = { code: "refused", message: "customers cannot be kept current by logical replication from shop: replication role",
    why: "replication role: mason_reader may not open a replication connection (ALTER ROLE mason_reader WITH REPLICATION;)",
    fix: "poll it instead: mason add customers --sync \"poll 5m\", or sync: poll 5m on its entry in mason/sources/shop.yml, which needs none of this — or fix the database as said, then mason stop && mason start",
    next: [{ command: "mason add customers --sync \"poll 5m\"", what: "polls it with SELECTs instead" }] };
  run.answers.set("POST api/pick", run.json({ error: failure.message, failure }, 409));
  run.asked.length = 0;
  assert.equal(await call<Promise<boolean>>("chooseSyncValue", "public.customers", "replication"), false);
  assert.deepEqual(run.asked, [`POST api/pick ${JSON.stringify({ table: "public.customers", picked: true, sync: "replication", keep: true })}`], "nothing read again: nothing changed");
  const said = popOf(app.view().tables!, "sync-tables-public.customers");
  for (const words of [failure.message, failure.why, failure.fix]) assert.ok(textOf(said).includes(words), words);
  assert.match(said, /role="alert"/);
});

test("the app: one read of the database's checks at a time — a second choice opened while the first is read waits for it", async () => {
  const { run, call } = await appOver();
  run.answers.set("GET api/tables/public.customers/sync", run.json(choiceOf("public.customers")));
  run.answers.set("GET api/tables/public.events/sync", run.json(choiceOf("public.events")));
  run.gate(true);
  const first = call<Promise<boolean>>("chooseSync", "public.customers");
  await new Promise((r) => setTimeout(r, 10));
  const second = call<Promise<boolean>>("chooseSync", "public.events");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(run.asked, ["GET api/tables/public.customers/sync"], "the second not asked while the first is read");
  run.gate(false);
  run.release();
  assert.equal(await first, false, "closed by the second: its answer is not shown");
  assert.equal(await second, true);
  assert.deepEqual(run.asked, ["GET api/tables/public.customers/sync", "GET api/tables/public.events/sync"]);
});

test("the app: a choice ticked survives a poll's rewrite of the part — written ticked from the page's own state, the list held as of when it opened", async () => {
  const { run, app, call } = await appOver();
  run.answers.set("GET api/tables/public.customers/sync", run.json(choiceOf("public.customers")));
  await call("chooseSync", "public.customers");
  const page = (app as unknown as { pages: Map<string, { input(t: unknown): unknown }> }).pages.get("tables")!;
  assert.equal(page.input({ name: "sync", value: "poll 1h", form: { dataset: { syncForm: "public.customers" } } }), null, "nothing to paint: the box is ticked already");
  const before = app.view().tables!;
  await new Promise((r) => setTimeout(r, 1100));
  await app.poll();
  const after = app.view().tables!;
  assert.match(popOf(after, "sync-tables-public.customers"), /value="poll 1h" checked>/);
  assert.equal([...popOf(after, "sync-tables-public.customers").matchAll(/ checked/g)].length, 1);
  assert.equal(after, before, "nothing of the held list moved: the part is not rewritten under the person");
  call("cancelSync");
  await call("chooseSync", "public.customers");
  assert.match(popOf(app.view().tables!, "sync-tables-public.customers"), /value="off" checked>/, "opened again: its sync now");
});

// ------------------------------------------------------------------ an added table's columns (issue 884)

/** A database whose added tables each choose their columns differently, over the server's own state. */
const COLS = {
  // every column: `{}`, none looks like a secret
  customers: ["id", "name", "status"],
  // two named
  orders: ["id", "name", "status", "created_at"],
  // every column but the secret-looking one, as mason add writes it
  accounts: ["id", "name", "api_token"],
  // an exclude: written by hand, which the boxes cannot show
  invoices: ["id", "name", "status"],
  // `{}` over a secret-looking column: kept on purpose (mason add --include), which the boxes cannot show either
  sessions: ["id", "user_id", "api_token"],
  // no primary key: synced by its key:
  raw_log: ["tenant_id", "seq", "body"],
  // not added
  audit: ["id", "what"],
} as const;
const COL_TABLES: SourceTable[] = Object.entries(COLS).map(([name, cols]) => ({ source: `public.${name}`, schema: "public", table: name, key: name === "raw_log" ? [] : ["id"],
  rows: name === "orders" ? 40_000_000 : 1200, bytes: 8192, comment: null, columns: cols.map((c) => col(c, c === "id" ? "bigint" : "text")), foreignKeys: [] }));
const COL_FILE = parseSourceText("kind: postgres\nurl: x\ntables:\n  customers: {}\n  orders:\n    columns: [id, status]\n  accounts:\n    exclude: [api_token]\n" +
  "  invoices:\n    exclude: [name]\n  sessions: {}\n  raw_log:\n    key: [tenant_id, seq]\n    columns: [tenant_id, seq, body]\n", "shop", "/app/mason/sources/shop.yml");
assert.ok(!("problems" in COL_FILE), JSON.stringify(COL_FILE));
function colStateOf(o: { pageReadOnly?: boolean; sourcesReadOnly?: string } = {}): Record<string, unknown> {
  const ctx = {
    source, facts: () => ({ version: 160000, versionText: "16.4", standby: false, tables: COL_TABLES, systemIdentifier: null }), warnings: [],
    replication: () => ({ slot: "mason_shop", publication: "mason_shop", owned: true }), page: true,
    ...(o.pageReadOnly ? { pageReadOnly: true, pageReadOnlyAllow: [] } : {}),
    users: { file: "/app/.mason/users.json", apiKey: "k".repeat(32), database: "shop", postgresUrl: "postgresql://127.0.0.1:5433/shop" },
    folder: () => "/app/mason", root: "/app", home: "/app/.mason", version: "0.9.0", startedAt: Date.parse(at),
    sources: () => ({ file: COL_FILE, problem: null }), listener: { openSessions: () => ({ open: 0, byClient: [] }) },
    duck: { file: "/app/.mason/duck.db", requests: { days: 7 }, restarts: () => [], disk: () => ({ path: "/app/.mason", freeBytes: null, projectedBytes: null }) },
  } as unknown as RunContext;
  const kept: CopyState["kept"] = { by: "poll", sync: { mode: "off" }, syncedAt: at, nextAt: null };
  const copies = Object.keys(COLS).filter((n) => n !== "audit").map((n) => copied(`public.${n}`, 1200, kept));
  const s = JSON.parse(JSON.stringify(runState(ctx, copies, null, Date.parse(at)))) as Record<string, unknown>;
  return o.sourcesReadOnly ? { ...s, sourcesReadOnly: o.sourcesReadOnly } : s;
}
const COL_STATE = colStateOf();
type ColTable = { table: string; added: boolean; columnCount?: number; entry?: unknown; everyColumnLeavesOut?: string[]; addedColumns: string[] | null };
const colTable = (name: string) => (COL_STATE.tables as ColTable[]).find((t) => t.table === `public.${name}`)!;
/** `GET api/tables/<table>/columns`'s answer (src/cli/run-server.ts tableColumns). */
const columnsOf = (name: keyof typeof COLS) => ({ table: `public.${name}`, columns: COLS[name].map((c) => ({ name: c, type: c === "id" ? "bigint" : "text", nullable: true, comment: null, references: null })) });
const ticksOf = (html: string, field: string): string[] => [...html.matchAll(new RegExp(`name="${field}" value="([^"]+)" checked`, "g"))].map((m) => m[1]!);
/** A column form's columns choice: the radio chosen, All or Only these. */
const whichOf = (html: string): string[] => ticksOf(html, "which");

test("the state carries each added table's entry — its columns, exclude and key —, the columns every column leaves out, and every table's column count", () => {
  assert.deepEqual(colTable("customers").entry, { columns: null, exclude: [], key: null });
  assert.deepEqual(colTable("orders").entry, { columns: ["id", "status"], exclude: [], key: null });
  assert.deepEqual(colTable("accounts").entry, { columns: null, exclude: ["api_token"], key: null });
  assert.deepEqual(colTable("raw_log").entry, { columns: ["tenant_id", "seq", "body"], exclude: [], key: ["tenant_id", "seq"] });
  assert.deepEqual(colTable("accounts").everyColumnLeavesOut, ["api_token"]);
  assert.deepEqual(colTable("sessions").everyColumnLeavesOut, ["api_token"]);
  assert.deepEqual(colTable("customers").everyColumnLeavesOut, []);
  assert.equal(colTable("orders").columnCount, 4);
  assert.equal(colTable("audit").columnCount, 2, "a table not added says how many columns it has too");
  assert.ok(!("entry" in colTable("audit")) && !("everyColumnLeavesOut" in colTable("audit")), "and no entry");
});

test("an added table's row says which columns it syncs in a few words — All columns, 2 of 4 columns, All but 1 column — the columns its title, and opens its column form", () => {
  const html = renderTables(COL_STATE);
  const summary = (name: string) => new RegExp(`<button type="button" class="small link syncnow" id="columns-tables-public\\.${name}" data-choose="public\\.${name}" title="([^"]*)">([^<]*)</button>`).exec(html);
  const said = Object.fromEntries(["customers", "orders", "accounts", "invoices", "sessions", "raw_log"].map((n) => [n, summary(n)?.slice(1)]));
  assert.deepEqual(said, {
    customers: ["Every column, and any column added to the table later. Choose which columns Mason syncs", "All columns"],
    orders: ["Synced: id, status. Choose which columns Mason syncs", "2 of 4 columns"],
    accounts: ["Every column but api_token. Choose which columns Mason syncs", "All but 1 column"],
    invoices: ["Every column but name. Choose which columns Mason syncs", "All but 1 column"],
    sessions: ["Every column, and any column added to the table later. Choose which columns Mason syncs", "All columns"],
    raw_log: ["Synced: tenant_id, seq, body. Choose which columns Mason syncs", "3 of 3 columns"],
  });
  assert.match(textOf(html), /public\.orders Synced .* Remove Sync: Off 2 of 4 columns public\.accounts /, "on its note, beside its sync");
  assert.ok(!html.includes('id="columns-tables-public.audit"'), "a table not added has Columns… in its actions instead");
  assert.match(html, /data-add-table="public\.audit">Add<\/button> <button type="button" class="small" data-choose="public\.audit">Columns…<\/button>/);
});

test("read-only: the columns said, no form — where the project's files are read-only or the page may not edit tables", () => {
  for (const s of [colStateOf({ sourcesReadOnly: "the project's files are read-only here (MASON_PROJECT_READONLY=1)" }), colStateOf({ pageReadOnly: true })]) {
    const html = renderTables(s, { choosing: "public.orders", columns: columnsOf("orders") });
    assert.match(html, /<span class="syncnow dim" title="Synced: id, status">2 of 4 columns<\/span>/);
    assert.ok(!html.includes('id="columns-tables-'), "no button");
    assert.ok(!html.includes("data-pick-form"), "no form, even one the model says is open");
  }
});

test("the column form on an added table: All columns for every column, else Only these with its entry's columns ticked; its key ticked, what saving costs said before Save", () => {
  const form = (name: keyof typeof COLS) => popOf(renderTables(COL_STATE, { choosing: `public.${name}`, columns: columnsOf(name) }), `columns-tables-public.${name}`);
  const orders = form("orders");
  assert.match(orders, /role="dialog" aria-label="The columns orders syncs"/);
  assert.deepEqual(whichOf(orders), ["only"], "a list of columns: Only these");
  assert.deepEqual(ticksOf(orders, "columns"), ["id", "status"]);
  assert.ok(!orders.includes('name="key"'), "a table with a primary key: no key to tick");
  assert.match(orders, /<div class="radios"><label><input type="radio" name="which" value="all"> <span>All columns, and any added to the table later<\/span><\/label><label><input type="radio" name="which" value="only" checked> <span>Only these columns<\/span><\/label><\/div><div class="only-cols">/,
    "two choices, the boxes under Only these");
  assert.equal(textOf(orders), "The columns orders syncs All columns, and any added to the table later Only these columns id bigint name text status text created_at text " +
    "Saving different columns syncs orders again in full from your database (~40,000,000 rows): that takes a while, and on a big table it adds load to your database. " +
    "Its synced data can still be queried until the new sync finishes. Saving the same columns changes nothing and starts no sync. Save Cancel");
  // every column: All chosen, never an empty set of boxes; under Only these every box ticked, so choosing it starts from what is synced
  const customers = form("customers");
  assert.deepEqual(whichOf(customers), ["all"], "every column: All");
  assert.deepEqual(ticksOf(customers, "columns"), ["id", "name", "status"], "its boxes all ticked, hidden while All is chosen");
  const accounts = form("accounts");
  assert.deepEqual(whichOf(accounts), ["all"], "every column but the secret-looking one, as mason add writes it: All");
  assert.deepEqual(ticksOf(accounts, "columns"), ["id", "name"], "its boxes: every column but the one All leaves out");
  assert.match(textOf(accounts), /All columns, and any added to the table later, but api_token, which looks like a secret Only these columns/);
  // the boxes hidden by the radio itself while All is chosen: nothing is written when it changes
  const css = fs.readFileSync(path.join(WEB, "app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(css, /form\.pick:has\(input\[name="which"\]\[value="all"\]:checked\) \.only-cols \{ display: none; \}/);
  const rawLog = form("raw_log");
  assert.deepEqual(ticksOf(rawLog, "key"), ["tenant_id", "seq"], "its key: ticked");
  assert.deepEqual(ticksOf(rawLog, "columns"), ["tenant_id", "seq", "body"]);
  // while it is read: said, with Cancel
  assert.equal(textOf(popOf(renderTables(COL_STATE, { choosing: "public.orders", columns: null }), "columns-tables-public.orders")), "Reading orders's columns… Cancel");
  // while it is saved: Saving…, disabled
  assert.match(popOf(renderTables(COL_STATE, { choosing: "public.orders", columns: columnsOf("orders"), savingColumns: "public.orders" }), "columns-tables-public.orders"),
    /<button type="submit" class="primary small" disabled>Saving…<\/button>/);
});

test("an entry the form cannot show (an exclude: written by hand, a secret-looking column kept) is described, its boxes the columns synced now, and saving replaces it — said first", () => {
  const form = (name: keyof typeof COLS) => popOf(renderTables(COL_STATE, { choosing: `public.${name}`, columns: columnsOf(name) }), `columns-tables-public.${name}`);
  const invoices = form("invoices");
  assert.match(textOf(invoices), /^Its entry in the sources file syncs every column but name, which these boxes cannot show: they show the columns synced now\. Saving replaces the entry with the columns ticked\. /);
  assert.deepEqual(ticksOf(invoices, "columns"), ["id", "status"]);
  assert.deepEqual(whichOf(invoices), ["only"], "the columns synced now: Only these");
  assert.match(textOf(invoices), /Saving the same columns starts no sync\. Save Cancel$/);
  const sessions = form("sessions");
  assert.match(textOf(sessions), /^Its entry in the sources file syncs every column, api_token included, which these boxes cannot show/);
  assert.deepEqual(ticksOf(sessions, "columns"), ["id", "user_id", "api_token"]);
  const columnsChoice = fn<(t: unknown) => { exact: boolean }>(tables, "columnsChoice");
  assert.deepEqual(["customers", "orders", "accounts", "invoices", "sessions", "raw_log"].map((n) => columnsChoice(colTable(n)).exact), [true, true, true, false, false, true]);
});

/** The Tables page's submit of a column form, as the shell calls it: the boxes ticked by FormData's getAll, the columns
 *  choice (`which`) by its get. */
const submitForm = (app: App, table: string, ticks: { which?: string[]; columns?: string[]; key?: string[] }) => {
  class FD {
    f: { ticks: Record<string, string[]> };
    constructor(f: { ticks: Record<string, string[]> }) { this.f = f; }
    getAll(k: string) { return this.f.ticks[k] ?? []; }
    get(k: string) { return this.f.ticks[k]?.[0] ?? null; }
  }
  const page = (app as unknown as { pages: Map<string, { submit(f: unknown, F: unknown): Promise<boolean> | null }> }).pages.get("tables")!;
  return page.submit({ dataset: { pickForm: table }, ticks }, FD);
};
const pickAnswer = (table: string, o: Record<string, unknown> = {}) => ({ table, file: "/app/mason/sources/shop.yml", entry: table.slice("public.".length), columns: null, exclude: [], key: null,
  addedKey: [], skippedSecrets: [], already: false, sync: { value: "off", from: "default" }, bigOff: false, notReplicated: null, pollCost: null, ...o });

test("the app: opening the column form on an added table reads its columns once; saving a change sends POST api/pick as mason add --columns, then the state; the answer beside its columns", async () => {
  const { run, app, call } = await appOver(COL_STATE);
  run.answers.set("GET api/tables/public.orders/columns", run.json(columnsOf("orders")));
  assert.equal(await call<Promise<boolean>>("choose", "public.orders"), true);
  assert.deepEqual(run.asked, ["GET api/tables/public.orders/columns"]);
  assert.ok(tablesModel(app).held !== null, "the list held still while it is open");
  assert.deepEqual(ticksOf(popOf(app.view().tables!, "columns-tables-public.orders"), "columns"), ["id", "status"]);
  // a poll keeps it open: the table is still added
  await app.poll();
  assert.equal(tablesModel(app).choosing, "public.orders");
  run.answers.set("POST api/pick", run.json(pickAnswer("public.orders", { columns: ["id", "name", "status"] })));
  run.asked.length = 0;
  assert.equal(await submitForm(app, "public.orders", { which: ["only"], columns: ["id", "name", "status"] }), true);
  assert.deepEqual(run.asked, [`POST api/pick ${JSON.stringify({ table: "public.orders", picked: true, columns: ["id", "name", "status"] })}`, "GET api/state"]);
  const html = app.view().tables!;
  assert.equal(textOf(popOf(html, "columns-tables-public.orders")), "Saved orders's columns: the columns id, name, status. Dismiss", "what was saved; its sync, unchanged, not said again");
  assert.ok(!html.includes("data-pick-form"), "the form closed");
  assert.ok(!html.includes("Adding…"), "an added table is not said to be added again");
});

test("the app: saving the same choice sends the entry as it is — the run answers already, writes nothing and starts no sync", async () => {
  const cases: Array<[keyof typeof COLS, { which?: string[]; columns?: string[]; key?: string[] }, Record<string, unknown>]> = [
    // its columns ticked in another order, its key left unticked (always synced): the entry's own list
    ["orders", { which: ["only"], columns: ["status"] }, { table: "public.orders", picked: true, columns: ["id", "status"] }],
    // every column: All, its boxes (hidden, all ticked) not sent
    ["customers", { which: ["all"], columns: ["id", "name", "status"] }, { table: "public.customers", picked: true }],
    ["accounts", { which: ["all"], columns: ["id", "name"] }, { table: "public.accounts", picked: true }],
    // its key as the entry orders it
    ["raw_log", { which: ["only"], columns: ["body", "seq", "tenant_id"], key: ["seq", "tenant_id"] }, { table: "public.raw_log", picked: true, columns: ["tenant_id", "seq", "body"], key: ["tenant_id", "seq"] }],
  ];
  for (const [name, ticks, body] of cases) {
    const { run, app, call } = await appOver(COL_STATE);
    run.answers.set(`GET api/tables/public.${name}/columns`, run.json(columnsOf(name)));
    run.answers.set("POST api/pick", run.json(pickAnswer(`public.${name}`, { already: true })));
    await call("choose", `public.${name}`);
    run.asked.length = 0;
    await submitForm(app, `public.${name}`, ticks);
    assert.equal(run.asked[0], `POST api/pick ${JSON.stringify(body)}`, name);
    assert.match(textOf(popOf(app.view().tables!, `columns-tables-public.${name}`)), new RegExp(`^Nothing changed: ${name} already syncs every column\\. Dismiss$`), name);
  }
  // the form the boxes cannot show: what they say is sent, which replaces the entry (said in the form first)
  const { run, app, call } = await appOver(COL_STATE);
  run.answers.set("GET api/tables/public.invoices/columns", run.json(columnsOf("invoices")));
  run.answers.set("POST api/pick", run.json(pickAnswer("public.invoices", { columns: ["id", "status"] })));
  await call("choose", "public.invoices");
  run.asked.length = 0;
  await submitForm(app, "public.invoices", { which: ["only"], columns: ["id", "status"] });
  assert.equal(run.asked[0], `POST api/pick ${JSON.stringify({ table: "public.invoices", picked: true, columns: ["id", "status"] })}`);
});

test("the app: Only these with no box ticked is refused on the page, never sent as every column; All sends no columns whatever its hidden boxes say", async () => {
  const { run, app, call } = await appOver(COL_STATE);
  run.answers.set("GET api/tables/public.orders/columns", run.json(columnsOf("orders")));
  run.answers.set("POST api/pick", run.json(pickAnswer("public.orders")));
  await call("choose", "public.orders");
  run.asked.length = 0;
  assert.equal(await submitForm(app, "public.orders", { which: ["only"], columns: [] }), true);
  assert.deepEqual(run.asked, [], "nothing sent");
  const form = popOf(app.view().tables!, "columns-tables-public.orders");
  assert.match(textOf(form), /^✗ Tick the columns to sync, or choose All columns\. The columns orders syncs /, "said over the form");
  assert.deepEqual(whichOf(form), ["only"], "the choice as it was");
  assert.deepEqual(ticksOf(form, "columns"), [], "its boxes as they were");
  await submitForm(app, "public.orders", { which: ["all"], columns: ["id"] });
  assert.equal(run.asked[0], `POST api/pick ${JSON.stringify({ table: "public.orders", picked: true })}`, "All: every column, as mason add <table>");
});

test("the app: a refused save is said over the form, its boxes as they were ticked; a table removed elsewhere takes its form with it", async () => {
  const { run, app, call } = await appOver(COL_STATE);
  run.answers.set("GET api/tables/public.orders/columns", run.json(columnsOf("orders")));
  run.answers.set("POST api/pick", run.json({ error: "x", failure: { code: "refused", message: "public.orders has no column nope", next: [] } }, 400));
  await call("choose", "public.orders");
  assert.equal(await submitForm(app, "public.orders", { which: ["only"], columns: ["name"] }), false);
  const form = popOf(app.view().tables!, "columns-tables-public.orders");
  assert.match(textOf(form), /^✗ public\.orders has no column nope The columns orders syncs /);
  assert.deepEqual(ticksOf(form, "columns"), ["name"]);
  assert.deepEqual(whichOf(form), ["only"], "the choice as it was");
  // removed elsewhere (mason remove): the next poll closes the form
  const removed = JSON.parse(JSON.stringify(COL_STATE)) as { tables: Array<Record<string, unknown>> };
  for (const t of removed.tables) if (t.table === "public.orders") { t.added = false; delete t.entry; }
  run.answers.set("GET api/state", run.json(removed));
  await app.poll();
  assert.equal(tablesModel(app).choosing, null);
});
