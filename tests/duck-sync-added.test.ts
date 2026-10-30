/**
 * WHAT A START SAYS OF ITS TABLES (src/duck/sync.ts `addedText`, `Sync.addedStatus`; the test server: every start
 * logged `added <all four tables>: they are synced at the next pass` while all four were copied and streamed from the
 * acknowledged position — read as a long re-copy that never came). One line, each table as the sync's records say it
 * is: current (polled every n s / streamed from a position), caught up by one poll first, left out of the polls, or
 * synced at the next pass WITH its reason. Offline: a real Sync over a DuckDB file whose ledger is seeded, stopped
 * before its tables are set, so the pass `setTables` kicks never runs (it would INSTALL the postgres extension over the
 * network and attach a source there is none of).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DuckStore, MASON_SCHEMA } from "../src/duck/store.ts";
import * as syncModule from "../src/duck/sync.ts";
import * as explainModule from "../src/duck/explain.ts";
import type { AddedTable, CopyState, StreamStatus, Sync as SyncClass, SyncMode, SyncReplication } from "../src/duck/sync.ts";
import type { Source } from "../src/cli/preflight.ts";
import { runState, type RunContext } from "../src/cli/run-server.ts";
import { EVENT_KINDS, type SyncEventInput } from "../src/duck/events.ts";
import { STATUS, streamLines, tableLines, WAIT, type RunState } from "../src/cli/commands.ts";
import * as commands from "../src/cli/commands.ts";
import { jsonText } from "../src/cli/command.ts";

// read from the module, not imported by name: the file loads at a commit without it (scripts/fails-without.ts)
type Status = { source: string } & ({ copy: string } | { behind: string } | { refused: string } | { kept: string; off: boolean });
const { addedText } = syncModule as unknown as { addedText: (tables: readonly Status[]) => string };
const { Sync } = syncModule;
// EXPLAIN's words for how a copy is kept current (src/duck/explain.ts), read the same way
const { keptText } = explainModule as unknown as { keptText: (f: unknown, now?: number) => string };

test("tables already synced and current are said as such, in one line, never as synced at the next pass", () => {
  const line = addedText(["public.a", "public.b", "public.c", "public.d"].map((source) => ({ source, kept: "streamed from 0/16B3F28", off: false })));
  assert.equal(line, "4 tables already synced and streamed from 0/16B3F28: public.a, public.b, public.c, public.d");
});

test("each table is grouped by its state, the current first and those synced at the next pass last, each with its reason", () => {
  const line = addedText([
    { source: "public.new", copy: "never synced" },
    { source: "public.a", kept: "polled every 5s", off: false },
    { source: "public.wide", copy: "its columns changed" },
    { source: "public.caught", behind: "after its whole read" },
    { source: "public.new2", copy: "never synced" },
    { source: "public.off", kept: "sync: off (read again only by mason sync public.off)", off: true },
    { source: "public.hourly", kept: "polled every 1h", off: false },
  ]);
  assert.equal(line, "1 table already synced and polled every 5s: public.a; 1 table already synced and polled every 1h: public.hourly; " +
    "1 table already synced, sync: off (read again only by mason sync public.off): public.off; " +
    "1 table already synced, caught up by one poll first (after its whole read): public.caught; " +
    "2 tables synced at the next pass (never synced): public.new, public.new2; " +
    "1 table synced at the next pass (its columns changed): public.wide");
});

const column = (name: string, type = "bigint") => ({ name, type, notNull: true, comment: null });
const table = (name: string, rows = 10, columns = [column("id")]): AddedTable =>
  ({ source: `public.${name}`, schema: "public", table: name, key: ["id"], columns, foreignKeys: [], bytes: 0, rows });
// a source nothing listens on: never reached, the sync is stopped before anything would connect
const source = { url: "postgresql://x@127.0.0.1:1/x", remote: false, host: "127.0.0.1", port: 1, database: "x", user: "x", password: "", sslmode: "disable" } as unknown as Source;

type Started = { mode: SyncMode; replication?: SyncReplication; seed: (run: (sql: string) => Promise<unknown>) => Promise<void>; tables: AddedTable[] };

/** the line a Sync over `file` logs when its tables are set, after `seed` wrote its ledger */
function startLine(t: Started): Promise<string[]> {
  return withSync(t, async (_sync, logged) => logged.filter((l) => !/^the catalog could not be rebuilt|: it is stored in key order/.test(l)));
}

/** a Sync over a fresh file whose ledger `seed` wrote, stopped, its tables set: `use` reads it before the file goes
 *  (with what it logged and the events it recorded, src/duck/events.ts) */
async function withSync<T>(t: Started, use: (sync: SyncClass, logged: string[], events: SyncEventInput[]) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-duck-added-"));
  const store = await DuckStore.open(path.join(dir, "duck.db"), () => undefined, { memoryLimit: "256MB" });
  try {
    const events: SyncEventInput[] = [];
    const open = async (log: (l: string) => void, onEvent: (e: SyncEventInput) => void = () => undefined): Promise<SyncClass> => {
      const s = new Sync(store, source, "x", log, 5_000, t.mode, t.replication ?? null, { onEvent });
      await s.open();
      return s;
    };
    // the first open makes the ledger's tables, which the seed then fills as a run before this one left them
    await (await open(() => undefined)).stop();
    await t.seed((sql) => store.writer.run(sql));
    const logged: string[] = [];
    const sync = await open((l) => logged.push(l), (e) => { events.push(e); });
    await sync.stop();
    await sync.setTables(t.tables);
    return await use(sync, logged, events);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const copied = (name: string, columns = [column("id")], phase = "copied", error: string | null = null): string =>
  `INSERT INTO ${MASON_SCHEMA}.copy_state VALUES ('public.${name}', '${phase}', 10, 0, 1.0, now(), ${error === null ? "NULL" : `'${error}'`}, '${JSON.stringify(columns)}')`;
const polled = (name: string): string => `INSERT INTO ${MASON_SCHEMA}.poll_state (source, snapshot, polled_at) VALUES ('public.${name}', '100:100:', now())`;
/** a table as the sources file adds it, its sync its entry's (or the file's): off, or polled every `every` */
const OFF = { mode: "off" } as const;
const every = (e: string, seconds: number) => ({ mode: "poll", every: e, seconds }) as const;

test("a start whose four tables are copied and current says so, polled every interval — no copy promised", async () => {
  const names = ["a", "b", "c", "d"];
  const lines = await startLine({
    mode: "poll", tables: names.map((n) => table(n)),
    seed: async (run) => { for (const n of names) { await run(copied(n)); await run(polled(n)); } },
  });
  assert.deepEqual(lines, ["4 tables already synced and polled every 5s: public.a, public.b, public.c, public.d"]);
});

test("a start names each table synced at the next pass with its reason, from the sync's own records", async () => {
  const lines = await startLine({
    mode: "poll",
    tables: [table("current"), table("never"), table("changed", 10, [column("id"), column("added", "text")]), table("failed"),
      table("caught"), { ...table("big", 2_000_000), sync: OFF }, table("retired"), table("outgrown")],
    seed: async (run) => {
      for (const n of ["current", "changed", "caught", "big", "retired"]) { await run(copied(n)); await run(polled(n)); }
      await run(copied("failed", [column("id")], "failed", "the source closed the connection"));
      // copied, but a numeric outgrew its DECIMAL: its watermark is gone until it is copied again, wider
      await run(copied("outgrown"));
      await run(`INSERT INTO ${MASON_SCHEMA}.catch_up VALUES ('public.caught', 'after its whole read', now())`);
      // a copy in the older layout carries its primary key (`findRetired`)
      await run("CREATE TABLE public.retired (id BIGINT PRIMARY KEY)");
    },
  });
  // its size decides nothing: a big table is polled unless its sync says off (mason add writes that for one)
  assert.deepEqual(lines, ["1 table already synced and polled every 5s: public.current; " +
    "1 table already synced, sync: off (read again only by mason sync public.big): public.big; " +
    "1 table already synced, caught up by one poll first (after its whole read): public.caught; " +
    "1 table synced at the next pass (never synced): public.never; " +
    "1 table synced at the next pass (its columns changed): public.changed; " +
    "1 table synced at the next pass (its first sync failed: the source closed the connection): public.failed; " +
    "1 table synced at the next pass (it is in an older Mason's layout, key order with an index): public.retired; " +
    "1 table synced at the next pass (a numeric value outgrew its synced DECIMAL column): public.outgrown"]);
});

test("in replication mode a current copy is streamed from the position the copy applied through; under a slot it has no record of, it is caught up first", async () => {
  const replication = { slot: "mason_x", publication: "mason_x", owned: true };
  const seed = (withSlot: boolean) => async (run: (sql: string) => Promise<unknown>): Promise<void> => {
    for (const n of ["a", "b"]) { await run(copied(n)); await run(polled(n)); }
    if (withSlot) await run(`INSERT INTO ${MASON_SCHEMA}.stream_state VALUES ('mason_x', '0/16B3F28', now())`);
  };
  const tables = [table("a"), table("b", 2_000_000)];
  assert.deepEqual(await startLine({ mode: "replication", replication, tables, seed: seed(true) }),
    ["2 tables already synced and streamed from 0/16B3F28: public.a, public.b"], "the row limit is the polls', never the stream's");
  assert.deepEqual(await startLine({ mode: "replication", replication, tables, seed: seed(false) }),
    ["2 tables already synced, caught up by one poll first (slot mason_x is new to the synced data): public.a, public.b"]);
});

// HOW A COPY IS KEPT CURRENT (src/duck/sync.ts `keptOf`): the sync's one fact, which mason status (`state`'s `kept`,
// `streamStatus`'s tables) and EXPLAIN (`keptText`) both read — a real Sync over a seeded ledger, stopped
type Kept = { by: string; state?: string; why?: string | null; position?: string; sync?: unknown; syncedAt?: string | null; nextAt?: string | null; pending?: string; copiedAt?: string | null; notRunning?: string | null };
type KeptState = { source: string; phase: string; kept?: Kept };
/** a kept without its next poll's time (when it is due: now, for a table whose interval has passed) */
const withoutNext = (k: Kept | undefined): Kept | undefined => { if (k === undefined) return k; const { nextAt: _n, ...rest } = k; return rest; };
const replicationX = { slot: "mason_x", publication: "mason_x", owned: true };
/** each table's state, and what mason status's stream section says of each (replication mode) */
const keptStates = (t: Started) => withSync(t, async (sync) => ({ states: sync.state() as KeptState[], stream: await sync.streamStatus() }));
const at = (states: readonly KeptState[], name: string): KeptState => states.find((s) => s.source === `public.${name}`)!;
// a project polled until 2026-10-27, its last polls still in the ledger
const lastPoll = (n: string): string => `INSERT INTO ${MASON_SCHEMA}.poll_state (source, snapshot, polled_at) VALUES ('public.${n}', '100:100:', '2026-10-27 19:58:39+00')`;
const slotAt = `INSERT INTO ${MASON_SCHEMA}.stream_state VALUES ('mason_x', '0/16B3F28', now())`;

test("a project switched to replication is said streamed by EXPLAIN and status alike, never by its last poll; the stream down is said with why", async () => {
  const tables = [table("a"), table("big", 2_000_000), table("caught")];
  const seed = (...more: string[]) => async (run: (sql: string) => Promise<unknown>): Promise<void> => {
    for (const n of ["a", "big", "caught"]) { await run(copied(n)); await run(lastPoll(n)); }
    await run(`INSERT INTO ${MASON_SCHEMA}.catch_up VALUES ('public.caught', 'after its whole read', now())`);
    for (const sql of more) await run(sql);
  };
  const { states, stream } = await keptStates({ mode: "replication", replication: replicationX, tables, seed: seed(slotAt) });
  assert.equal(states.length, 3);
  for (const st of states) {
    // mason status's stream section says the same of each table: one derivation
    const said = stream?.tables.find((t) => t.table === st.source);
    assert.deepEqual([said?.state, said?.why], [st.kept?.state, st.kept?.why], st.source);
    // its age is the copy's (the last poll's instant, as the stream has not run): never "polled"
    assert.doesNotMatch(keptText(st), /polled/);
  }
  // stopped (as this sync is, before its first pass could start the stream): the reason, never "the slot is not made"
  for (const name of ["a", "big"]) {
    assert.deepEqual(at(states, name).kept, { by: "replication", slot: "mason_x", state: "streamed", why: null, position: "0/16B3F28", syncedAt: "2026-10-27T19:58:39.000Z", lastCommit: null, notRunning: "Mason is stopping" });
    assert.equal(keptText(at(states, name), Date.parse("2026-10-29T19:58:39.000Z")),
      "streamed by logical replication (slot mason_x), replicated, at 0/16B3F28, last synced 2 days ago (2026-10-27 19:58:39 UTC), no change applied this run; NOT kept current now, the stream is not running: Mason is stopping");
  }
  // one owed its catch-up poll (`_mason.catch_up`): catching up, as status says it
  assert.deepEqual([at(states, "caught").kept?.state, at(states, "caught").kept?.why], ["catching-up", "caught up by one poll after its whole read"]);
  assert.equal(keptText(at(states, "caught")), "logical replication (slot mason_x), not streamed yet: caught up by one poll after its whole read");

  // the replication check a pass failed (recorded on each copy's state): its words
  const failed = await keptStates({ mode: "replication", replication: replicationX, tables: [table("a")], seed: async (run) => {
    await run(copied("a", [column("id")], "copied", "replication: the publication mason_x does not exist"));
    await run(lastPoll("a"));
    await run(slotAt);
  } });
  assert.equal(at(failed.states, "a").kept?.notRunning, "the publication mason_x does not exist");
  // a slot this copy has no record of: not made yet
  const noSlot = await keptStates({ mode: "replication", replication: replicationX, tables: [table("a")], seed: async (run) => { await run(copied("a")); await run(lastPoll("a")); } });
  assert.equal(at(noSlot.states, "a").kept?.notRunning, "slot mason_x is not made yet: it starts once it is");
});

test("a polled copy says its interval and last poll, an `off` one its age and the command that syncs it; one the passes skip is NOT kept current, and why", async () => {
  const { states } = await keptStates({
    mode: "poll",
    tables: [{ ...table("a"), sync: every("30s", 30) }, { ...table("big", 2_000_000), sync: OFF }, table("changed", 10, [column("id"), column("added", "text")]), table("retired"), table("outgrown"), table("caught")],
    seed: async (run) => {
      for (const n of ["a", "big", "changed", "retired", "caught"]) { await run(copied(n)); await run(lastPoll(n)); }
      // copied, but a numeric outgrew its DECIMAL: its watermark is gone until it is copied again, wider
      await run(copied("outgrown"));
      await run(`INSERT INTO ${MASON_SCHEMA}.catch_up VALUES ('public.caught', 'after its whole read', now())`);
      // a copy in the older layout carries its primary key (`findRetired`)
      await run("CREATE TABLE public.retired (id BIGINT PRIMARY KEY)");
    },
  });
  const asOf = "2026-10-27T19:58:39.000Z";
  const now = Date.parse("2026-10-30T20:58:39.000Z");
  assert.deepEqual(withoutNext(at(states, "a").kept), { by: "poll", sync: every("30s", 30), syncedAt: asOf });
  // its interval long past its last poll: due now (never a time before now)
  assert.ok(Date.parse(at(states, "a").kept!.nextAt!) >= Date.parse(asOf) + 30_000, "its next poll is due");
  assert.equal(keptText(at(states, "a"), now), "polled every 30s, last 3 days ago (2026-10-27 19:58:39 UTC)");
  // sync: off: copied, served, its age and the way to sync it said; no next poll, and no verdict of the run's own
  assert.deepEqual(at(states, "big").kept, { by: "poll", sync: OFF, syncedAt: asOf, nextAt: null });
  assert.equal("unsynced" in at(states, "big"), false);
  assert.equal(keptText(at(states, "big"), now), "off: last synced 3 days ago (2026-10-27 19:58:39 UTC); mason sync public.big syncs it now");
  const pending: Array<[string, string]> = [
    ["changed", "its columns changed: it is read again whole, then caught up by one poll"],
    ["retired", "it is in an older Mason's layout, key order with an index: it is read again whole, then caught up by one poll"],
    ["outgrown", "a numeric value outgrew its synced DECIMAL column: it is read again whole, wider, then caught up by one poll"],
    ["caught", "it is caught up by one poll after its whole read first"],
  ];
  for (const [name, why] of pending) {
    const st = at(states, name);
    assert.equal(st.kept?.pending, why, name);
    assert.match(keptText(st, now), new RegExp(`^NOT kept current \\((last synced 3 days ago \\(2026-10-27 19:58:39 UTC\\)|never synced)\\): ${why.replace(/[.()]/g, "\\$&")}$`), name);
  }
});

test("a recopied copy's last copy is the instant the ledger holds, said in UTC whatever the machine's zone", async () => {
  const { states } = await keptStates({ mode: "recopy", tables: [table("a")], seed: async (run) => {
    await run(`INSERT INTO ${MASON_SCHEMA}.copy_state VALUES ('public.a', 'copied', 10, 0, 1.0, '2026-10-27 19:00:00+00', NULL, '${JSON.stringify([column("id")])}')`);
  } });
  assert.deepEqual(at(states, "a").kept, { by: "recopy", copiedAt: "2026-10-27T19:00:00.000Z" });
  assert.equal(keptText(at(states, "a")), "kept current by reading it again whole, last synced 2026-10-27 19:00:00 UTC");
});


// MASON STATUS --JSON CARRIES THE SAME FACT (src/cli/run-server.ts runState): each added table's `kept` is the sync's
// state's, beside the `unsynced` and the stream's tables that its text renders (tableLines, streamLines) — one
// derivation, which the JSON and the text both read. Before, the run server mapped a copy's fields one by one and
// `kept` was not among them: an agent reading --json could not tell how a table was kept current, or why it was not.
// read from the module, not imported by name: the file loads at a commit without it (scripts/fails-without.ts)
const waitTable = (commands as unknown as { waitTable?: (t: RunState["tables"][number]) => Record<string, unknown> }).waitTable;
/** the run's context as runState reads it: the catalog the sync's tables are in, each one added in the sources file */
const runContext = (tables: readonly AddedTable[], changes: "poll" | "replication"): RunContext => ({
  source, facts: () => ({ version: 160000, versionText: "16", standby: false, tables, systemIdentifier: null }), warnings: [],
  replication: () => changes === "replication" ? { slot: "mason_x", publication: "mason_x", owned: true } : null, page: false, folder: () => null, root: os.tmpdir(), home: path.join(os.tmpdir(), "mason-no-such-home"), startedAt: Date.now(), version: "dev",
  users: { file: "", apiKey: "", database: "x", postgresUrl: "postgresql://127.0.0.1:5433/x" }, listener: { openSessions: () => ({ open: 0, byClient: [] }) },
  sources: () => ({ file: { name: "x", file: "/x/mason/sources/x.yml", kind: "postgres", url: { env: "DATABASE_URL" },
    tables: tables.map((t) => ({ name: t.table, table: t.source, columns: null, exclude: [], key: null })) }, problem: null }),
  duck: { file: path.join(os.tmpdir(), "mason-no-such-copy.db"), disk: () => ({ path: os.tmpdir(), freeBytes: null, projectedBytes: null }), restarts: () => [], requests: { days: 7 } },
}) as unknown as RunContext;
/** what mason status --json says of a sync (the run's /api/state, as the command reads it), and the sync's own states */
const statusOf = (t: Started, changes: "poll" | "replication") => withSync(t, async (sync) => {
  const states: CopyState[] = sync.state();
  const json = JSON.parse(JSON.stringify(runState(runContext(t.tables, changes), states, await sync.streamStatus()))) as RunState;
  return { states, json };
});

test("mason status --json says how each table is kept current as the sync derives it: the same fact its text renders, in poll and replication mode", async () => {
  const sameAsTheSync = (states: readonly CopyState[], json: RunState): void => {
    assert.equal(json.tables.length, states.length);
    for (const t of json.tables) {
      const st = states.find((s) => s.source === t.table)!;
      assert.ok(st.kept !== undefined, `${t.table}: the sync says how it is kept current`);
      assert.deepEqual(t.kept, st.kept, `${t.table}: --json's kept is the sync's state's`);
      // mason status --json (the run's state under its declared key) and mason wait --json carry it as it is
      assert.deepEqual((JSON.parse(jsonText(STATUS, { tables: json.tables })) as RunState).tables.find((x) => x.table === t.table)?.kept, st.kept, `${t.table}: mason status --json`);
      assert.ok(waitTable !== undefined, "mason wait --json's table (waitTable)");
      assert.deepEqual((JSON.parse(jsonText(WAIT, { tables: [waitTable(t)] })) as { tables: Array<{ kept?: unknown }> }).tables[0]!.kept, st.kept, `${t.table}: mason wait --json`);
    }
  };

  // POLL MODE: one polled, one whose sync is off, which the text says with its age from the same fact
  const pollTables = [{ ...table("a"), sync: every("30s", 30) }, { ...table("big", 2_000_000), sync: OFF }];
  const poll = await statusOf({ mode: "poll", tables: pollTables, seed: async (run) => { for (const n of ["a", "big"]) { await run(copied(n)); await run(lastPoll(n)); } } }, "poll");
  sameAsTheSync(poll.states, poll.json);
  const asOf = "2026-10-27T19:58:39.000Z";
  const by = (name: string) => poll.json.tables.find((t) => t.table === `public.${name}`)!;
  assert.deepEqual(withoutNext(by("a").kept), { by: "poll", sync: every("30s", 30), syncedAt: asOf });
  assert.deepEqual(by("big").kept, { by: "poll", sync: OFF, syncedAt: asOf, nextAt: null });
  const lines = tableLines(poll.json, Date.parse("2026-10-30T20:58:39.000Z"));
  assert.match(lines.find((l) => l.startsWith("public.big"))!, /synced · sync: off, last synced 3 days ago — mason sync big syncs it now; sync: poll 5m on its entry polls it$/);
  assert.match(lines.find((l) => l.startsWith("public.a "))!, /synced · polled every 30s, last 3 days ago$/);

  // REPLICATION MODE: streamed, and caught up by one poll first — the stream section's state and why are kept's
  const replTables = [table("a"), table("caught")];
  const repl = await statusOf({ mode: "replication", replication: replicationX, tables: replTables, seed: async (run) => {
    for (const n of ["a", "caught"]) { await run(copied(n)); await run(lastPoll(n)); }
    await run(`INSERT INTO ${MASON_SCHEMA}.catch_up VALUES ('public.caught', 'after its whole read', now())`);
    await run(slotAt);
  } }, "replication");
  sameAsTheSync(repl.states, repl.json);
  const stream = repl.json.stream;
  assert.ok(stream !== undefined, "replication mode: the stream");
  for (const t of repl.json.tables) {
    const k = t.kept!;
    assert.equal(k.by, "replication", t.table);
    const said: StreamStatus["tables"][number] = stream.tables.find((s) => s.table === t.table)!;
    assert.deepEqual([said.state, said.why], k.by === "replication" ? [k.state, k.why] : [], `${t.table}: the stream section says what kept says`);
  }
  assert.deepEqual(repl.json.tables.find((t) => t.table === "public.caught")!.kept,
    { by: "replication", slot: "mason_x", state: "catching-up", why: "caught up by one poll after its whole read", position: "0/16B3F28", syncedAt: "2026-10-27T19:58:39.000Z", lastCommit: null, notRunning: "Mason is stopping" });
  assert.match(streamLines(stream).find((l) => l.startsWith("public.caught"))!, /catching up by one poll/);
});

test("a table not copied now says so in kept itself — waiting for its copy, its copy failed — in poll, recopy and replication mode, never polled", async () => {
  // kept read alone (mason status --json) must never tell an agent that a table whose copy failed is polled: every text
  // reader checks the phase first, an agent reading kept may not
  const tables = [table("a"), table("waiting"), table("failed")];
  const seed = (...more: string[]) => async (run: (sql: string) => Promise<unknown>): Promise<void> => {
    await run(copied("a")); await run(lastPoll("a"));
    await run(copied("failed", [column("id")], "failed", "the source closed the connection"));
    for (const sql of more) await run(sql);
  };
  const keptBy = async (t: Started, changes: "poll" | "replication"): Promise<Record<string, unknown>> => {
    const { states, json } = await statusOf(t, changes);
    for (const s of states) assert.deepEqual(json.tables.find((x) => x.table === s.source)?.kept, s.kept, `${s.source}: --json's kept is the sync's`);
    // the text is phase-first, as it was
    assert.equal(keptText(at(states as KeptState[], "waiting")), "waiting for its first sync to start");
    assert.equal(keptText(at(states as KeptState[], "failed")), "its first sync failed: the source closed the connection");
    return Object.fromEntries(json.tables.map((x) => [x.table.replace(/^public\./, ""), x.kept]));
  };
  const poll = await keptBy({ mode: "poll", tables, seed: seed() }, "poll");
  const five = every("5s", 5);
  assert.deepEqual(Object.fromEntries(Object.entries(poll).map(([k, v]) => [k, withoutNext(v as Kept)])), {
    a: { by: "poll", sync: five, syncedAt: "2026-10-27T19:58:39.000Z" },
    waiting: { by: "poll", sync: five, syncedAt: null, pending: "it waits for its first sync: it joins once synced and caught up by one poll" },
    failed: { by: "poll", sync: five, syncedAt: null, pending: "its first sync failed (the source closed the connection): it joins once synced and caught up by one poll" },
  });
  // a table not kept current now has no next poll
  assert.deepEqual([(poll.waiting as Kept).nextAt, (poll.failed as Kept).nextAt], [null, null]);
  const recopy = await keptBy({ mode: "recopy", tables, seed: seed() }, "poll");
  assert.deepEqual([recopy.waiting, recopy.failed], [
    { by: "recopy", copiedAt: null, pending: "it waits for its first sync: it is kept current once synced" },
    { by: "recopy", copiedAt: (recopy.failed as { copiedAt: string | null }).copiedAt, pending: "its first sync failed (the source closed the connection): it is kept current once synced" },
  ]);
  assert.equal("pending" in (recopy.a as object), false, "a copied table copied again whole is kept current");
  const repl = await keptBy({ mode: "replication", replication: replicationX, tables, seed: seed(slotAt) }, "replication");
  assert.deepEqual([repl.waiting, repl.failed].map((k) => { const r = k as { state: string; why: string | null }; return [r.state, r.why]; }), [
    ["waiting", "it waits for its first sync: it joins once synced and caught up by one poll"],
    ["waiting", "its first sync failed (the source closed the connection): it joins once synced and caught up by one poll"],
  ]);
});

// THE PASS LOOP'S TIMER (src/duck/sync.ts `nextPassDelay`, `rearm`; the review of issue 33's PR 1): a real Sync over a
// seeded ledger, its private schedule read and driven as the run drives it — the source is never reached (`attach`
// refuses at once) and no pass runs (a timer set is read, then cleared)
type Schedule = {
  nextPassDelay(): number | null; followUp(source: string): void; attach(): Promise<void>;
  stopped: boolean; timer: NodeJS.Timeout | null; due: Map<string, number>; behind: Map<string, { why: string }>;
  queued: Map<string, unknown>; rebuildingNow: { source: string; kind: string } | null;
};
const scheduleOf = (s: SyncClass): Schedule => s as unknown as Schedule;
/** the sync's timer, read and cleared (null: none set), so no pass it would run ever starts */
const takeTimer = (s: Schedule): NodeJS.Timeout | null => { const t = s.timer; if (t !== null) clearTimeout(t); s.timer = null; return t; };
const polledUnder = (n: string, sync: string): string =>
  `INSERT INTO ${MASON_SCHEMA}.poll_state (source, snapshot, polled_at, sync) VALUES ('public.${n}', '100:100:', '2026-10-27 19:58:39+00', '${sync}')`;

test("a table being caught up, queued or rebuilt is not due to a pass: the loop waits for its catch-up, never runs every few ms polling nothing", async () => {
  await withSync({ mode: "poll", tables: [{ ...table("a"), sync: every("30s", 30) }], seed: async (run) => { await run(copied("a")); await run(lastPoll("a")); } }, async (sync) => {
    const s = scheduleOf(sync);
    assert.equal(s.nextPassDelay(), 0, "copied and its interval long past: a pass at once");
    s.behind.set("public.a", { why: "after its whole read" });
    assert.equal(s.nextPassDelay(), 5_000, "owed its catch-up and nothing queued it: a pass after the interval, to queue it");
    s.queued.set("public.a", { kind: "catch-up" });
    assert.equal(s.nextPassDelay(), null, "its catch-up queued: that polls it, then times the next pass (counted as due, a pass every few ms polled nothing)");
    s.queued.clear();
    s.rebuildingNow = { source: "public.a", kind: "catch-up" };
    assert.equal(s.nextPassDelay(), null, "its catch-up running: the same");
    s.rebuildingNow = null;
    s.behind.clear();
  });
});

test("a table out of its copy is polled from then on: the timer is set again after its catch-up, and after a mason sync that held the pass slot", async () => {
  await withSync({ mode: "poll", tables: [{ ...table("a"), sync: every("30s", 30) }, { ...table("b"), sync: OFF }],
    seed: async (run) => { for (const n of ["a", "b"]) { await run(copied(n)); await run(lastPoll(n)); } } }, async (sync) => {
    const s = scheduleOf(sync);
    s.stopped = false;
    s.attach = async () => { throw new Error("no source in this test"); };
    try {
      // a's catch-up ended with no pass running and no timer (the last pass ended while a copied): followUp times one
      s.due.set("public.a", Date.now() + 3_600_000);
      assert.equal(takeTimer(s), null);
      s.followUp("public.a");
      assert.notEqual(takeTimer(s), null, "the next pass timed for a's next poll");
      // mason sync b held the pass slot while a came out of its catch-up: its end times the next pass, replacing an
      // earlier timer (a's next poll moved: the old one would run a pass that polls nothing)
      const stale = setTimeout(() => undefined, 7_200_000);
      s.timer = stale;
      await assert.rejects(sync.pollNow(["public.b"]), /no source in this test/);
      // the slot's release runs after the poll's failure reaches the caller: a turn later
      await new Promise((r) => setImmediate(r));
      const after = takeTimer(s);
      clearTimeout(stale);
      assert.ok(after !== null && after !== stale, "mason sync's end set the timer again, from the state then");
    } finally { takeTimer(s); s.stopped = true; }
  });
});

test("a sync changed is a catch-up by one poll, said once, beside the stream as in a polled project, and into replication; with its columns changed too, no catch-up is promised", async () => {
  const seed = async (run: (sql: string) => Promise<unknown>): Promise<void> => { await run(copied("a")); await run(polledUnder("a", "poll 5m")); };
  const switched = (lines: readonly string[]) => lines.filter((l) => / sync: .* → /.test(l));
  assert.deepEqual(switched(await startLine({ mode: "poll", tables: [{ ...table("a"), sync: every("30s", 30) }], seed })),
    ["public.a: sync: poll 5m → poll 30s: its synced data is kept, and caught up by one poll now"], "changed by hand while Mason was down: seen at the start");
  // in a project that streams, a polled table is polled beside the stream: the same catch-up, said the same
  assert.deepEqual(switched(await startLine({ mode: "replication", replication: replicationX, tables: [{ ...table("a"), sync: every("30s", 30) }], seed })),
    ["public.a: sync: poll 5m → poll 30s: its synced data is kept, and caught up by one poll now"], "a polled table beside the stream");
  // into replication: the copy kept, caught up by one poll, then streamed (its changes held from before that poll)
  assert.deepEqual(switched(await startLine({ mode: "replication", replication: replicationX, tables: [{ ...table("a"), sync: { mode: "replication" } }], seed })),
    ["public.a: sync: poll 5m → replication: its synced data is kept, and caught up by one poll now, then streamed"], "poll → replication, changed while Mason was down");
  assert.deepEqual(switched(await startLine({ mode: "poll", tables: [{ ...table("a", 10, [column("id"), column("added", "text")]), sync: every("30s", 30) }], seed })), [],
    "its columns changed too: it is copied again (said as such), never 'its copy is kept'");
});

test("a sync changed is recorded as the sync's event of its table, in the words its log line says: the history keeps what a table's sync was", async () => {
  const seed = async (run: (sql: string) => Promise<unknown>): Promise<void> => { await run(copied("a")); await run(polledUnder("a", "poll 5m")); };
  const changed = (t: Started) => withSync(t, async (_sync, _logged, events) => events.filter((e) => e.kind !== "copied" && e.kind !== "recovered"));
  assert.deepEqual(await changed({ mode: "poll", tables: [{ ...table("a"), sync: every("30s", 30) }], seed }),
    [{ kind: "sync_changed", table: "public.a", message: "sync: poll 5m → poll 30s: its synced data is kept, and caught up by one poll now" }]);
  assert.deepEqual(await changed({ mode: "replication", replication: replicationX, tables: [{ ...table("a"), sync: { mode: "replication" } }], seed }),
    [{ kind: "sync_changed", table: "public.a", message: "sync: poll 5m → replication: its synced data is kept, and caught up by one poll now, then streamed" }], "into replication");
  assert.deepEqual(await changed({ mode: "poll", tables: [{ ...table("a"), sync: every("5m", 300) }], seed }), [], "the same sync: no event");
  // the kind is one the events' readers know: the CLI's --events, the web page's Kind filter (held equal to it)
  assert.ok((EVENT_KINDS as readonly string[]).includes("sync_changed"));
});

test("a table just copied says its copy's age at once, never 'never synced' until the next pass reads the ledger again", async () => {
  await withSync({ mode: "poll", tables: [{ ...table("a"), sync: every("30s", 30) }], seed: async (run) => {
    // the side table a copy built, ready to be swapped in (src/duck/sync.ts swap)
    await run("CREATE TABLE public.a__mason_copy (id BIGINT)");
    await run(`INSERT INTO ${MASON_SCHEMA}.copy_state VALUES ('public.a', 'copied', 0, 0, 1.0, now(), NULL, '${JSON.stringify([column("id")])}')`);
  } }, async (sync) => {
    const swap = (sync as unknown as { swap(t: AddedTable, side: string, o: { snapshot: string | null; behind: string | null }): Promise<void> }).swap.bind(sync);
    const kept = () => sync.state().find((x) => x.source === "public.a")!.kept as Kept;
    assert.equal(kept().syncedAt, null, "before its copy: never synced");
    await swap({ ...table("a"), sync: every("30s", 30) }, "public.a__mason_copy", { snapshot: "100:100:", behind: "after its whole read" });
    const k = kept();
    assert.ok(typeof k.syncedAt === "string" && Date.now() - Date.parse(k.syncedAt) < 60_000, `synced as of its copy: ${JSON.stringify(k)}`);
    const line = tableLines(runState(runContext([{ ...table("a"), sync: every("30s", 30) }], "poll"), sync.state(), null) as RunState).find((l) => l.startsWith("public.a"))!;
    assert.match(line, /NOT kept current \(last synced \d+ s ago\): /, line);
    assert.doesNotMatch(line, /never synced/);
  });
});

test("replication the database will not set up is said on the replicated table's line with the line that polls it, never a bare error (a slot it cannot make, a role)", async () => {
  // a database at wal_level = replica: the source reachable, the slot refused with Postgres's own words (the review's run)
  await withSync({ mode: "poll", replication: replicationX, tables: [{ ...table("a"), sync: { mode: "replication" } }],
    seed: async (run) => { await run("CREATE TABLE public.a (id BIGINT)"); await run(copied("a")); await run(lastPoll("a")); } }, async (sync) => {
    const inner = sync as unknown as { pass(): Promise<void>; prepareReplication(): Promise<void>; attach(): Promise<void>; detach(): Promise<void> };
    inner.prepareReplication = async () => { throw new Error("ERROR: logical decoding requires wal_level >= logical"); };
    inner.attach = async () => undefined;
    inner.detach = async () => undefined;
    await assert.rejects(inner.pass.bind(sync)(), /logical decoding requires wal_level >= logical/);
    const a = sync.state().find((s) => s.source === "public.a")!;
    assert.equal(a.phase, "copied", "its copy still served");
    assert.equal(a.error, "replication: ERROR: logical decoding requires wal_level >= logical — public.a is NOT kept current until it is fixed: " +
      "give its entry sync: poll <interval> (poll 5m) in the sources file to poll it instead");
    // its line says it, as mason status reads kept
    assert.match(keptText(a as KeptState), /give its entry sync: poll <interval> \(poll 5m\) in the sources file to poll it instead/);
  });
});
