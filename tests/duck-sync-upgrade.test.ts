/**
 * A COPY AN OLDER MASON MADE, READ BY THIS ONE (src/duck/sync.ts `HELD_LAYOUT`, `findHeldLayout`): an older Mason stored
 * a column of a type this one holds as the source's text (src/duck/held-types.ts) as the extension's scan read it (a
 * `point` as a STRUCT), and recorded its columns without their kind (`typeKind`). Its record alone says the copy is as
 * this Mason would make it, so it was never read again: served as a STRUCT under the point's OID, and polled into the
 * STRUCT for ever. And an enum column, recorded without its kind, looked held as text, so every enum table was read
 * again for nothing. What the copy physically is decides: the held column's table is read again, the enum's is not, and
 * once read again nothing is said. Offline: a real Sync over a DuckDB file whose ledger is seeded, stopped before its
 * tables are set (its pass would attach a source there is none of).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DuckStore, MASON_SCHEMA } from "../src/duck/store.ts";
import { HELD_LAYOUT, Sync, type AddedTable } from "../src/duck/sync.ts";
import type { Source, SourceColumnInfo } from "../src/cli/preflight.ts";

const source = { url: "postgresql://x@127.0.0.1:1/x", remote: false, host: "127.0.0.1", port: 1, database: "x", user: "x", password: "", sslmode: "disable" } as unknown as Source;

const col = (name: string, type: string, typeKind?: string): SourceColumnInfo => ({ name, type, notNull: false, comment: null, ...(typeKind !== undefined ? { typeKind } : {}) });
/** the columns as an older Mason recorded them: no kind */
const OLD_HELD = [col("id", "integer"), col("pt", "point")];
const OLD_ENUM = [col("id", "integer"), col("m", "mood")];
/** the columns as this Mason's read of the source says them */
const NOW_HELD = [col("id", "integer", "b"), col("pt", "point", "b")];
const NOW_ENUM = [col("id", "integer", "b"), col("m", "mood", "e")];
const table = (name: string, columns: SourceColumnInfo[]): AddedTable => ({ source: `public.${name}`, schema: "public", table: name, key: ["id"], columns, foreignKeys: [], bytes: 0, rows: 1 });

test("a copy an older Mason made with a held column stored otherwise is read again once; an enum's is not; after its swap nothing is said", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-sync-upgrade-"));
  const store = await DuckStore.open(path.join(dir, "duck.db"), () => undefined, { memoryLimit: "256MB" });
  try {
    const opened = async (): Promise<{ sync: Sync; logs: string[] }> => {
      const logs: string[] = [];
      const sync = new Sync(store, source, "x", (m: string) => { logs.push(m); }, 5_000, "poll", null);
      await sync.open();
      await sync.stop();
      await sync.setTables([table("h", NOW_HELD), table("e", NOW_ENUM)]);
      return { sync, logs };
    };
    await (await opened()).sync.stop();
    const w = (sql: string) => store.writer.run(sql);
    // as an older Mason left them: the point as the extension's STRUCT, the enum as an ENUM
    await w("CREATE TABLE public.h (id INTEGER, pt STRUCT(x DOUBLE, y DOUBLE))");
    await w("INSERT INTO public.h VALUES (1, {'x': 1, 'y': 2})");
    await w("CREATE TABLE public.e (id INTEGER, m ENUM('a', 'b'))");
    await w("INSERT INTO public.e VALUES (1, 'b')");
    for (const [name, columns] of [["h", OLD_HELD], ["e", OLD_ENUM]] as const) {
      await w(`INSERT INTO ${MASON_SCHEMA}.copy_state VALUES ('public.${name}', 'copied', 1, 0, 0.1, now(), NULL, '${JSON.stringify(columns)}')`);
      await w(`INSERT INTO ${MASON_SCHEMA}.poll_state (source, snapshot, polled_at) VALUES ('public.${name}', '100:100:', now())`);
    }
    const needs = (sync: Sync, t: AddedTable): boolean => (sync as unknown as { needsCopy: (t: AddedTable) => boolean }).needsCopy(t);
    const retired = (sync: Sync, s: string): unknown => (sync.state().find((x) => x.source === s) as { retired?: string } | undefined)?.retired;

    const upgraded = await opened();
    assert.equal(needs(upgraded.sync, table("h", NOW_HELD)), true, "the point stored as a STRUCT is read again");
    assert.equal(retired(upgraded.sync, "public.h"), HELD_LAYOUT);
    assert.ok(upgraded.logs.some((l) => l.startsWith("public.h:") && l.includes("pt (point)")), upgraded.logs.join("\n"));
    assert.equal(needs(upgraded.sync, table("e", NOW_ENUM)), false, "the enum, stored as this Mason stores it, is not read again");
    assert.equal(retired(upgraded.sync, "public.e"), undefined);
    assert.ok(!upgraded.logs.some((l) => l.startsWith("public.e:")), upgraded.logs.join("\n"));
    await upgraded.sync.stop();

    // its swap, as this Mason's copy makes it: the point as its text, the columns recorded with their kind
    await w("DROP TABLE public.h");
    await w("CREATE TABLE public.h (id INTEGER, pt VARCHAR)");
    await w("INSERT INTO public.h VALUES (1, '(1,2)')");
    await w(`UPDATE ${MASON_SCHEMA}.copy_state SET columns = '${JSON.stringify(NOW_HELD)}' WHERE source = 'public.h'`);
    const after = await opened();
    assert.equal(needs(after.sync, table("h", NOW_HELD)), false);
    assert.equal(retired(after.sync, "public.h"), undefined);
    assert.equal(needs(after.sync, table("e", NOW_ENUM)), false);
    assert.ok(!after.logs.some((l) => l.includes(HELD_LAYOUT)), after.logs.join("\n"));
    await after.sync.stop();
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
