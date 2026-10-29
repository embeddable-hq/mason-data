/**
 * WHAT A START SAYS OF ITS TABLES (src/duck/sync.ts `addedText`, `Sync.addedStatus`; the test server: every start
 * logged `added <all four tables>: they are copied at the next pass` while all four were copied and streamed from the
 * acknowledged position — read as a long re-copy that never came). One line, each table as the sync's records say it
 * is: current (polled every n s / streamed from a position), caught up by one poll first, left out of the polls, or
 * copied at the next pass WITH its reason. Offline: a real Sync over a DuckDB file whose ledger is seeded, stopped
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
import type { AddedTable, Sync as SyncClass, SyncMode, SyncReplication } from "../src/duck/sync.ts";
import type { Source } from "../src/cli/preflight.ts";

// read from the module, not imported by name: the file loads at a commit without it (scripts/fails-without.ts)
type Status = { source: string } & ({ copy: string } | { behind: string } | { refused: string } | { unsynced: boolean });
const { addedText } = syncModule as unknown as { addedText: (tables: readonly Status[], kept: string) => string };
const { Sync } = syncModule;
// EXPLAIN's words for how a copy is kept current (src/duck/explain.ts), read the same way
const { keptText } = explainModule as unknown as { keptText: (f: unknown) => string };

test("tables already copied and current are said as such, in one line, never as copied at the next pass", () => {
  const line = addedText(["public.a", "public.b", "public.c", "public.d"].map((source) => ({ source, unsynced: false })), "streamed from 0/16B3F28");
  assert.equal(line, "4 tables already copied and streamed from 0/16B3F28: public.a, public.b, public.c, public.d");
});

test("each table is grouped by its state, the current first and those copied at the next pass last, each with its reason", () => {
  const line = addedText([
    { source: "public.new", copy: "never copied" },
    { source: "public.a", unsynced: false },
    { source: "public.wide", copy: "its columns changed" },
    { source: "public.caught", behind: "after its copy" },
    { source: "public.new2", copy: "never copied" },
    { source: "public.big", unsynced: true },
  ], "polled every 5 s");
  assert.equal(line, "1 table already copied and polled every 5 s: public.a; " +
    "1 table already copied, NOT kept current (over the 1,000,000-row sync limit: mason sync polls one now, mason start --replication keeps it current): public.big; " +
    "1 table already copied, caught up by one poll first (after its copy): public.caught; " +
    "2 tables copied at the next pass (never copied): public.new, public.new2; " +
    "1 table copied at the next pass (its columns changed): public.wide");
});

const column = (name: string, type = "bigint") => ({ name, type, notNull: true, comment: null });
const table = (name: string, rows = 10, columns = [column("id")]): AddedTable =>
  ({ source: `public.${name}`, schema: "public", table: name, key: ["id"], columns, foreignKeys: [], bytes: 0, rows });
// a source nothing listens on: never reached, the sync is stopped before anything would connect
const source = { url: "postgresql://x@127.0.0.1:1/x", remote: false, host: "127.0.0.1", port: 1, database: "x", user: "x", password: "", sslmode: "disable" } as unknown as Source;

type Started = { mode: SyncMode; replication?: SyncReplication; seed: (run: (sql: string) => Promise<unknown>) => Promise<void>; tables: AddedTable[] };

/** the line a Sync over `file` logs when its tables are set, after `seed` wrote its ledger */
function startLine(t: Started): Promise<string[]> {
  return withSync(t, async (_sync, logged) => logged.filter((l) => !/^the catalog could not be rebuilt|: its copy is stored in key order/.test(l)));
}

/** a Sync over a fresh file whose ledger `seed` wrote, stopped, its tables set: `use` reads it before the file goes */
async function withSync<T>(t: Started, use: (sync: SyncClass, logged: string[]) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-duck-added-"));
  const store = await DuckStore.open(path.join(dir, "duck.db"), () => undefined, { memoryLimit: "256MB" });
  try {
    const open = async (log: (l: string) => void): Promise<SyncClass> => {
      const s = new Sync(store, source, "x", log, 5_000, t.mode, t.replication ?? null);
      await s.open();
      return s;
    };
    // the first open makes the ledger's tables, which the seed then fills as a run before this one left them
    await (await open(() => undefined)).stop();
    await t.seed((sql) => store.writer.run(sql));
    const logged: string[] = [];
    const sync = await open((l) => logged.push(l));
    await sync.stop();
    await sync.setTables(t.tables);
    return await use(sync, logged);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const copied = (name: string, columns = [column("id")], phase = "copied", error: string | null = null): string =>
  `INSERT INTO ${MASON_SCHEMA}.copy_state VALUES ('public.${name}', '${phase}', 10, 0, 1.0, now(), ${error === null ? "NULL" : `'${error}'`}, '${JSON.stringify(columns)}')`;
const polled = (name: string): string => `INSERT INTO ${MASON_SCHEMA}.poll_state VALUES ('public.${name}', '100:100:', now())`;

test("a start whose four tables are copied and current says so, polled every interval — no copy promised", async () => {
  const names = ["a", "b", "c", "d"];
  const lines = await startLine({
    mode: "poll", tables: names.map((n) => table(n)),
    seed: async (run) => { for (const n of names) { await run(copied(n)); await run(polled(n)); } },
  });
  assert.deepEqual(lines, ["4 tables already copied and polled every 5 s: public.a, public.b, public.c, public.d"]);
});

test("a start names each table copied at the next pass with its reason, from the sync's own records", async () => {
  const lines = await startLine({
    mode: "poll",
    tables: [table("current"), table("never"), table("changed", 10, [column("id"), column("added", "text")]), table("failed"),
      table("caught"), table("big", 2_000_000), table("retired"), table("outgrown")],
    seed: async (run) => {
      for (const n of ["current", "changed", "caught", "big", "retired"]) { await run(copied(n)); await run(polled(n)); }
      await run(copied("failed", [column("id")], "failed", "the source closed the connection"));
      // copied, but a numeric outgrew its DECIMAL: its watermark is gone until it is copied again, wider
      await run(copied("outgrown"));
      await run(`INSERT INTO ${MASON_SCHEMA}.catch_up VALUES ('public.caught', 'after its copy', now())`);
      // a copy in the older layout carries its primary key (`findRetired`)
      await run("CREATE TABLE public.retired (id BIGINT PRIMARY KEY)");
    },
  });
  assert.deepEqual(lines, ["1 table already copied and polled every 5 s: public.current; " +
    "1 table already copied, NOT kept current (over the 1,000,000-row sync limit: mason sync polls one now, mason start --replication keeps it current): public.big; " +
    "1 table already copied, caught up by one poll first (after its copy): public.caught; " +
    "1 table copied at the next pass (never copied): public.never; " +
    "1 table copied at the next pass (its columns changed): public.changed; " +
    "1 table copied at the next pass (its last copy failed: the source closed the connection): public.failed; " +
    "1 table copied at the next pass (its copy is in an older Mason's layout, key order with an index): public.retired; " +
    "1 table copied at the next pass (a numeric value outgrew its copy's DECIMAL): public.outgrown"]);
});

test("in replication mode a current copy is streamed from the position the copy applied through; under a slot it has no record of, it is caught up first", async () => {
  const replication = { slot: "mason_x", publication: "mason_x", owned: true };
  const seed = (withSlot: boolean) => async (run: (sql: string) => Promise<unknown>): Promise<void> => {
    for (const n of ["a", "b"]) { await run(copied(n)); await run(polled(n)); }
    if (withSlot) await run(`INSERT INTO ${MASON_SCHEMA}.stream_state VALUES ('mason_x', '0/16B3F28', now())`);
  };
  const tables = [table("a"), table("b", 2_000_000)];
  assert.deepEqual(await startLine({ mode: "replication", replication, tables, seed: seed(true) }),
    ["2 tables already copied and streamed from 0/16B3F28: public.a, public.b"], "the row limit is the polls', never the stream's");
  assert.deepEqual(await startLine({ mode: "replication", replication, tables, seed: seed(false) }),
    ["2 tables already copied, caught up by one poll first (slot mason_x is new to this copy): public.a, public.b"]);
});

test("how a copy is kept current is the sync's one fact, read by EXPLAIN and mason status alike: a project switched to replication is streamed, never its last poll", async () => {
  // the ledger as a project polled until 2026-10-27 leaves it, then started with --replication: its last poll stays
  const lastPoll = (n: string): string => `INSERT INTO ${MASON_SCHEMA}.poll_state VALUES ('public.${n}', '100:100:', '2026-10-27 19:58:39+00')`;
  const seed = async (run: (sql: string) => Promise<unknown>): Promise<void> => {
    for (const n of ["a", "big"]) { await run(copied(n)); await run(lastPoll(n)); }
    await run(`INSERT INTO ${MASON_SCHEMA}.stream_state VALUES ('mason_x', '0/16B3F28', now())`);
  };
  const tables = [table("a"), table("big", 2_000_000)];
  type Kept = { by: string; state?: string; position?: string; polledAt?: string | null; unsynced?: string };
  const streamed = await withSync({ mode: "replication", replication: { slot: "mason_x", publication: "mason_x", owned: true }, tables, seed }, async (sync) => {
    const states = sync.state() as Array<{ source: string; phase: string; kept?: Kept; unsynced?: unknown }>;
    return { states, stream: await sync.streamStatus() };
  });
  assert.equal(streamed.states.length, 2);
  for (const st of streamed.states) {
    assert.deepEqual([st.kept?.by, st.kept?.state, st.kept?.position], ["replication", "streamed", "0/16B3F28"], JSON.stringify(st));
    // mason status's stream section says the same of it: one derivation
    assert.equal(streamed.stream?.tables.find((t) => t.table === st.source)?.state, st.kept?.state);
    assert.equal(st.unsynced, undefined, "the row limit is the polls', never the stream's");
    const text = keptText(st);
    assert.match(text, /^kept current by logical replication \(slot mason_x\), applied through 0\/16B3F28, no change applied this run/);
    assert.doesNotMatch(text, /polling|last poll/);
  }
  // the same ledger polled: its last poll, and the big table left as copied, as status says it
  const polled = await withSync({ mode: "poll", tables, seed }, async (sync) => sync.state() as Array<{ source: string; kept?: Kept; unsynced?: { reason: string; asOf: string | null } }>);
  const [a, big] = polled;
  assert.deepEqual(a!.kept, { by: "poll", polledAt: "2026-10-27T19:58:39.000Z" });
  assert.equal(keptText(a), "kept current by polling, last poll 2026-10-27 19:58:39 UTC");
  assert.deepEqual(big!.kept, { by: "poll", polledAt: "2026-10-27T19:58:39.000Z", unsynced: "over the 1,000,000-row sync limit" });
  assert.deepEqual(big!.unsynced, { reason: "over the 1,000,000-row sync limit", asOf: "2026-10-27T19:58:39.000Z" });
});
