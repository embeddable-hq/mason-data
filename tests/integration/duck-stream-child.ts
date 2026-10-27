#!/usr/bin/env node
/**
 * A replication sync in a process of its own, for tests/integration/duck-stream.itest.ts's bulk-change test: run under a
 * small V8 heap (`--max-old-space-size`), it shows what the stream holds in Node's heap while a transaction arrives.
 * It copies one table, runs the given SQL on the source (one transaction), waits until DuckDB has it, and prints one
 * JSON line: the DuckDB checksum the test compares with the source's, and every line the sync logged. A heap that runs
 * out kills it, which the test reports with its stderr.
 *
 * argv[2]: JSON { url, file, memoryLimit, slot, publication, table: AddedTable, sql, checksum }
 */
import { spawnSync } from "node:child_process";
import { DuckStore } from "../../src/duck/store.ts";
import { Sync, type AddedTable } from "../../src/duck/sync.ts";
import { parseSource } from "../../src/cli/preflight.ts";

const a = JSON.parse(process.argv[2]!) as { url: string; file: string; memoryLimit: string; slot: string; publication: string; table: AddedTable; sql: string; checksum: string };
const parsed = parseSource(a.url);
if ("problem" in parsed) throw new Error(parsed.problem);
const logged: string[] = [];
const store = await DuckStore.open(a.file, (l) => logged.push(l), { memoryLimit: a.memoryLimit });
const sync = new Sync(store, parsed.source, new URL(a.url).pathname.slice(1), (l) => logged.push(l), 3_600_000, "replication", { slot: a.slot, publication: a.publication, owned: true });
try {
  await sync.open();
  void sync.setTables([a.table]);
  await sync.once();
  const r = spawnSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", a.url, "-c", a.sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim()}`);
  await sync.caughtUp(120_000);
  const rows = (await store.writer.runAndReadAll(a.checksum)).getRowsJS() as unknown[][];
  process.stdout.write(`${JSON.stringify({ checksum: rows.map((x) => x.join("\t")).join("\n"), logged })}\n`);
} catch (e) {
  process.stdout.write(`${JSON.stringify({ error: (e as Error).message, logged })}\n`);
} finally {
  await sync.stop();
  store.close();
}
