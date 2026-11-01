/**
 * THE WORLD tests/duck-generated.test.ts AND ITS CRASH CHILD SHARE: a real file, a real listener and its catalog, and a Sync
 * whose base is made by hand, as the wire tests make theirs.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pg from "pg";
import { DuckStore, MASON_SCHEMA } from "../src/duck/store.ts";
import { Sync, type AddedTable, type CopyState } from "../src/duck/sync.ts";
import { startPostgresApi, type PgApiServer } from "../src/api/postgres/server.ts";
import { GENERATED_DIR, readGenerated } from "../src/cli/generated-files.ts";
import type { GeneratedOptions, GeneratedStatus, GeneratedStep } from "../src/duck/generated.ts";
import type { GeneratedRefusal } from "../src/duck/generated-plan.ts";
import { mintToken, tokenProblem } from "../src/duck/token.ts";
import type { SyncEventInput } from "../src/duck/events.ts";
import type { Source } from "../src/cli/preflight.ts";

const API_KEY = "k".repeat(48);
const source = { url: "postgresql://x@127.0.0.1:1/x", remote: false, host: "127.0.0.1", port: 1, database: "x", user: "x", password: "", sslmode: "disable" } as unknown as Source;

const EVENT_COLUMNS = [["id", "bigint"], ["tenant_id", "integer"], ["kind", "text"], ["status", "text"], ["n", "text"], ["started_at", "timestamp with time zone"], ["finished_at", "timestamp with time zone"], ["amount", "numeric(12,2)"], ["payload", "jsonb"]] as const;
const columns = EVENT_COLUMNS.map(([name, type]) => ({ name, type, notNull: false, comment: null }));
const events: AddedTable = { source: "public.events", schema: "public", table: "events", key: ["id"], columns, foreignKeys: [], bytes: 0, rows: 4 };
const SEED = [
  "CREATE SCHEMA IF NOT EXISTS public",
  "CREATE TABLE public.events (id BIGINT, tenant_id INTEGER, kind VARCHAR, status VARCHAR, n VARCHAR, started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ, amount DECIMAL(12,2), payload JSON)",
  "INSERT INTO public.events VALUES (1, 1, 'query', 'ok', '1', '2026-01-01 00:00:00+00', '2026-01-01 00:00:02+00', 1.50, '{\"a\": 1}'), (2, 1, 'query', NULL, '2', '2026-01-01 00:00:05+00', NULL, 2.50, NULL), " +
    "(3, 2, 'query', 'failed', '3', '2026-01-02 00:00:00+00', '2026-01-02 00:00:01+00', NULL, '{\"a\": 2}'), (4, 2, 'load', 'ok', '4', NULL, NULL, 4.00, '{}')",
  `INSERT INTO ${MASON_SCHEMA}.copy_state VALUES ('public.events', 'copied', 4, 0, 1.0, now(), NULL, '${JSON.stringify(columns)}')`,
  `INSERT INTO ${MASON_SCHEMA}.poll_state (source, snapshot, polled_at, sync) VALUES ('public.events', '100:100:', now(), 'off')`,
];

export const COUNTS = "kind: scheduled\ntarget_lag: 1s\nsql: |\n  SELECT tenant_id, count(*) AS requests, max(started_at) AS last_at FROM events GROUP BY 1\norder_by: tenant_id\n";

export interface World {
  dir: string; root: string; folder: string; store: DuckStore; sync: Sync; api: PgApiServer; logged: string[]; events: SyncEventInput[];
  /** the steps runs have reached */
  reached: GeneratedStep[];
  write(name: string, text: string): void;
  remove(name: string): void;
  status(name?: string): GeneratedStatus;
  client(): Promise<pg.Client>;
  /** the review run until `done` holds of the table, or a failure naming what it is */
  until(done: (s: GeneratedStatus) => boolean, name?: string): Promise<GeneratedStatus>;
  rows(sql: string): Promise<unknown[][]>;
}

/** `again`: over the file of an earlier world in that folder, as a restart finds it */
export async function withWorld(files: Record<string, string>, use: (w: World) => Promise<void>, o: { dir?: string; again?: boolean; onStep?: GeneratedOptions["onStep"]; tables?: AddedTable[] } = {}): Promise<void> {
  const dir = o.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "mason-generated-"));
  const folder = path.join(dir, "mason"), tables = path.join(folder, GENERATED_DIR);
  fs.mkdirSync(tables, { recursive: true });
  const first = o.again !== true;
  const store = await DuckStore.open(path.join(dir, "duck.db"), () => undefined, { memoryLimit: "256MB" });
  const logged: string[] = [], recorded: SyncEventInput[] = [], reached: GeneratedStep[] = [];
  let sync: Sync | null = null;
  let api: PgApiServer | null = null;
  try {
    const open = async (): Promise<Sync> => { const s = new Sync(store, source, "app", (l) => logged.push(l), 3_600_000, "poll", null, { generated: { reviewMs: 0, onStep: async (s, n) => { reached.push(s); await o.onStep?.(s, n); } }, onEvent: (e) => { recorded.push(e); } }); await s.open(); return s; };
    if (first) { await (await open()).stop(); for (const sql of SEED) await store.writer.run(sql); }
    sync = await open();
    await sync.setTables([events, ...(o.tables ?? [])]);
    const live = sync;
    const copies = (): CopyState[] => [...live.state(), ...live.generated.copies()];
    api = await startPostgresApi({
      port: 0, host: "127.0.0.1", tls: null, database: "app", masonVersion: "test", product: "mason-data",
      authenticate: (password) => { const p = tokenProblem(API_KEY, password); if (p !== null) throw new Error(p); return { filters: [], subject: undefined }; },
      schema: () => live.schema(), record: () => undefined, log: () => undefined,
      duck: await store.listener(undefined, undefined, undefined, copies, live.kept),
    });
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(tables, `${name}.yml`), text);
    await live.generated.start(() => readGenerated(folder, dir), api.planner());
    const theApi = api;
    const status = (name = "public.counts"): GeneratedStatus => {
      const s = live.generated.status().find((x) => x.table === name);
      assert.ok(s !== undefined, `no generated table ${name}: ${live.generated.status().map((x) => x.table).join(", ")}`);
      return s;
    };
    await use({
      dir, root: dir, folder, store, sync: live, api: theApi, logged, events: recorded, reached,
      write: (name, text) => fs.writeFileSync(path.join(tables, `${name}.yml`), text),
      remove: (name) => fs.rmSync(path.join(tables, `${name}.yml`)),
      status,
      client: async () => { const c = new pg.Client({ host: "127.0.0.1", port: theApi.port, database: "app", user: "mason", password: mintToken(API_KEY, 600).token }); await c.connect(); return c; },
      until: async (done, name = "public.counts") => {
        const end = Date.now() + 20_000;
        for (;;) {
          await live.generated.review();
          const s = status(name);
          if (done(s)) return s;
          if (Date.now() > end) assert.fail(`${name} never got there: ${JSON.stringify(s)}\n${logged.join("\n")}`);
          await new Promise((r) => setTimeout(r, 20));
        }
      },
      rows: async (sql) => (await store.writer.runAndReadAll(sql)).getRowsJS(),
    });
  } finally {
    // in the order `mason start` stops (src/cli/dev.ts): the generated tables before the listener whose catalog their
    // planning reads, so a run still queued never plans on a closed catalog
    await sync?.generated.stop();
    await api?.close();
    await sync?.stop();
    await store.close();
    if (o.dir === undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
}

export const built = (s: GeneratedStatus): boolean => s.serving && s.state !== "failed";
export const plain = { bold: (s: string) => s, dim: (s: string) => s, red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s, cyan: (s: string) => s } as never;
export const refusedAt = (r: readonly GeneratedRefusal[], key: string | null, re: RegExp): void => { assert.ok(r.some((x) => x.key === key && re.test(x.message)), JSON.stringify(r)); };
