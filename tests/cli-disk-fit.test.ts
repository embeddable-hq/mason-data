/**
 * ADDING A TABLE SAYS UP FRONT WHEN IT LIKELY WON'T FIT ON DISK (issue 1075): the one check every entrance asks
 * (src/cli/source-edit.ts `addEntry`, over src/duck/disk-fit.ts), refusing with the numbers and writing nothing, and
 * going ahead with `yes`; `mason add` with Mason up (`/api/pick`, the run's room) and down (`stoppedRoom`, the room in
 * `.mason/`), with --yes and the line that adds anyway. The page and the deploy are held in their own files.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SourceTable } from "../src/cli/preflight.ts";
import type { RunContext } from "../src/cli/run-server.ts";
import { matrixEnv, runMason } from "./cli-matrix.ts";

// imported when the tests run, not at load: the file loads at a commit without the check (scripts/fails-without.ts)
const E = async () => await import("../src/cli/source-edit.ts" as string) as typeof import("../src/cli/source-edit.ts");
const C = async () => await import("../src/cli/commands.ts" as string) as typeof import("../src/cli/commands.ts");

const GiB = 2 ** 30;
const col = (name: string, width: number, toastable = false) => ({ name, type: toastable ? "jsonb" : "bigint", notNull: name === "id", comment: null, width, toastable });
/** a table of 10 GiB without its indexes, `id` 8 of its 1,000 bytes a row: about 4 GiB synced, 0.03 GiB with `id` alone */
const events: SourceTable = { source: "public.events", schema: "public", table: "events", key: ["id"], rows: 10_000_000, bytes: 12 * GiB, tableBytes: 10 * GiB, toastBytes: 0,
  comment: null, columns: [col("id", 8), col("payload", 992, true)], foreignKeys: [] };
const orders: SourceTable = { source: "public.orders", schema: "public", table: "orders", key: ["id"], rows: 3, bytes: 8192, tableBytes: 8192, toastBytes: 0,
  comment: null, columns: [col("id", 8), col("note", 20, true)], foreignKeys: [] };
/** 6 GiB free, 3 GiB kept for queries: 3 GiB for a table */
const ROOM = { freeBytes: 6 * GiB, reserveBytes: 3 * GiB, spillSet: false, pendingBytes: 0 };

function project(): { root: string; folder: string; file: string; url: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mason-disk-fit-")));
  const folder = path.join(root, "app", "mason");
  const file = path.join(folder, "sources", "shop.yml");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(path.join(root, "app", ".mason"), { mode: 0o700 });
  const url = "postgres://me@127.0.0.1:1/shop";
  fs.writeFileSync(file, `kind: postgres\nurl: ${url}\ntables:\n  orders: {}\n`);
  return { root, folder, file, url };
}

test("addEntry: a table that likely won't fit is refused with its numbers and nothing written; yes adds it and says so; a sync alone, or an unreadable disk, is not held", async () => {
  const { addEntry, sourceToEdit, Refusal } = await E();
  const { readSource } = await import("../src/cli/sources.ts");
  const p = project();
  const app = path.join(p.root, "app");
  const at = () => sourceToEdit(p.folder, app, () => readSource(p.folder, app, {}));
  let asked: string[] = [];
  const db = (room: object = ROOM) => ({ tables: [events, orders], database: "shop", disk: (t: string) => { asked.push(t); return room as never; } });
  try {
    const before = fs.readFileSync(p.file, "utf8");
    assert.throws(() => addEntry(at(), db(), "public.events"), (e: unknown) => {
      assert.ok(e instanceof Refusal);
      assert.equal(e.status, 409);
      assert.deepEqual([e.failure.code, e.failure.message], ["disk_short", "public.events likely won't fit on disk: it needs about 4.0 GiB, and 3.0 GiB is free for it"]);
      assert.deepEqual(e.extra.disk, { table: "public.events", estimateBytes: Math.round(10 * GiB * 0.4), freeBytes: 6 * GiB, reserveBytes: 3 * GiB, pendingBytes: 0, spillSet: false, resync: false, fits: false });
      return true;
    });
    assert.equal(fs.readFileSync(p.file, "utf8"), before, "nothing written");
    assert.deepEqual(asked, ["public.events"], "the room is asked beside the table itself");
    // fewer columns fit: written, its numbers on the answer
    const fewer = addEntry(at(), db(), "public.events", ["id"]);
    assert.equal(fewer.disk !== null && "fits" in fewer.disk && fewer.disk.fits, true);
    assert.match(fs.readFileSync(p.file, "utf8"), /events:\n {4}columns: \[id\]\n/);
    // every column again: synced again whole beside its synced data now, refused, then added with yes
    assert.throws(() => addEntry(at(), db(), "public.events"), (e: unknown) => e instanceof Refusal && (e.extra.disk as { resync: boolean }).resync === true);
    const anyway = addEntry(at(), db(), "public.events", ["*"], null, { yes: true });
    assert.deepEqual(anyway.disk !== null && "fits" in anyway.disk ? [anyway.disk.fits, anyway.disk.resync] : null, [false, true]);
    assert.match(fs.readFileSync(p.file, "utf8"), /events: \{\}\n/);
    // only its sync, or nothing changed: no whole sync, the disk not asked
    asked = [];
    assert.equal(addEntry(at(), db(), "public.events", ["*"], null, { sync: { mode: "poll", every: "1h", seconds: 3600 }, keep: true }).disk, null);
    assert.equal(addEntry(at(), db(), "public.orders").disk, null);
    assert.deepEqual(asked, []);
    // the free disk unreadable: added, and said
    fs.writeFileSync(p.file, before);
    const unknown = addEntry(at(), db({ unknown: "the free space could not be read: EACCES" }), "public.events");
    assert.deepEqual(unknown.disk, { table: "public.events", unknown: "the free space could not be read: EACCES" });
    const { addedLines } = await C();
    assert.ok(addedLines(anyway, "mason/sources/shop.yml").notes.includes("added anyway: it likely won't fit on disk: it needs about 4.0 GiB, and 3.0 GiB is free for it, beside 3.0 GiB kept for queries that spill to disk"));
    assert.ok(addedLines(unknown, "f").notes.includes("its room on disk was not checked: the free space could not be read: EACCES"));
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});

test("mason add with Mason stopped: the room in .mason/ by the run's own spill rule, MASON_SPILL_LIMIT read by its grammar, the tables added before counted; and the line that adds anyway", async () => {
  const { stoppedRoom, addAnywayLine } = await C();
  const free = () => 10 * GiB;
  const room = await stoppedRoom("/x", {}, free);
  assert.deepEqual(room("public.b", new Map([["public.a", GiB], ["public.b", 2 * GiB]])), { freeBytes: 10 * GiB, reserveBytes: 5 * GiB, spillSet: false, pendingBytes: GiB });
  assert.deepEqual((await stoppedRoom("/x", { MASON_SPILL_LIMIT: "1GiB" }, free))("t", new Map()), { freeBytes: 10 * GiB, reserveBytes: GiB, spillSet: true, pendingBytes: 0 });
  // never past 90% of what is free, as the run holds it
  assert.equal(((await stoppedRoom("/x", { MASON_SPILL_LIMIT: "40GB" }, free))("t", new Map()) as { reserveBytes: number }).reserveBytes, Math.floor(9 * GiB));
  assert.deepEqual((await stoppedRoom("/x", { MASON_SPILL_LIMIT: "lots" }, free))("t", new Map()), { unknown: "MASON_SPILL_LIMIT is not an amount (\"lots\" is not an amount of memory)" });
  assert.deepEqual((await stoppedRoom("/x", {}, () => { throw new Error("EACCES: permission denied"); }))("t", new Map()), { unknown: "the free space in /x could not be read: EACCES: permission denied" });
  assert.equal(addAnywayLine(["public.events"], ["events", "--columns", "id,status", "--sync", "poll 30s", "--json"], ["events"]), "mason add events --columns id,status --sync \"poll 30s\" --yes");
  assert.equal(addAnywayLine(["public.a", "billing.b"], ["--json", "a", "billing.b", "--yes"], ["a", "billing.b"]), "mason add a billing.b --yes");
});

test("mason add with Mason up: the run's room refuses a table that likely won't fit, as a person and with --json, nothing written; --yes adds it and says so", async () => {
  const { createRunServer } = await import("../src/cli/run-server.ts");
  const { parseSource } = await import("../src/cli/preflight.ts");
  const { readSource } = await import("../src/cli/sources.ts");
  const p = project();
  const app = path.join(p.root, "app");
  const parsed = parseSource(p.url);
  assert.ok("source" in parsed);
  const read = () => readSource(p.folder, app, {});
  const ctx = {
    page: false, users: { file: path.join(app, ".mason", "users.json"), apiKey: "k".repeat(48), database: "shop", postgresUrl: "postgresql://127.0.0.1:1/shop" },
    source: parsed.source, facts: () => ({ version: 160000, versionText: "16", standby: false, tables: [events, orders, { ...orders, source: "public.audit", table: "audit", estimateBytes: 123_456 }], systemIdentifier: null }), warnings: [], replication: () => null, port: 0, token: "t0ken-of-the-run",
    factsNow: async (carried: number | null) => ({ read: carried ?? 5, failure: null, running: false }),
    folder: () => p.folder, root: app, home: path.join(app, ".mason"), version: "test", startedAt: Date.now(),
    sources: () => { const r = read(); return { file: "message" in r ? null : r, problem: null }; }, sourcesChanged: () => {}, log: () => {}, readSource: read, runUrl: p.url,
    listener: { running: () => [], openSessions: () => ({ open: 0, byClient: [] }) },
    duck: { copies: () => [], file: path.join(p.root, "duck.db"), refused: () => null, poll: async () => ({ at: "", tables: [] }), stream: async () => null,
      disk: () => ({ path: "/x", freeBytes: 6 * GiB, projectedBytes: null }), spill: () => ({ limitBytes: 3 * GiB, set: false }), restarts: () => [], requests: { days: 7 } },
  } as unknown as RunContext;
  const server = createRunServer(ctx);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  ctx.port = (server.address() as { port: number }).port;
  fs.writeFileSync(path.join(app, ".mason", "config.json"), JSON.stringify({ name: "shop", folder: "mason", remote: false, apiKey: "k".repeat(48), sourceServer: null,
    running: { pid: process.pid, controlUrl: `http://127.0.0.1:${ctx.port}`, token: ctx.token, postgresUrl: "postgresql://127.0.0.1:1/shop", postgresListener: { host: "127.0.0.1", tls: null } }, lastRun: null }), { mode: 0o600 });
  const before = fs.readFileSync(p.file, "utf8");
  try {
    const j = await runMason(app, ["add", "events", "--json"], matrixEnv());
    assert.equal(j.code, 1, j.stdout + j.stderr);
    const v = JSON.parse(j.stdout) as { added: Array<{ table: string; error: string; disk: Record<string, unknown> }>; error: Record<string, string>; next: Array<{ command: string }> };
    assert.equal(v.error.code, "disk_short");
    assert.equal(v.error.message, "public.events was not added");
    assert.match(v.error.why!, /^public\.events likely won't fit on disk: it needs about 4\.0 GiB, and 3\.0 GiB is free for it\. Its synced data would need about 4\.0 GiB on disk/);
    assert.match(v.error.fix!, /choose fewer columns \(--columns\), give Mason more disk, or add it anyway \(--yes\)/);
    assert.deepEqual(v.added[0]!.disk, { table: "public.events", estimateBytes: Math.round(10 * GiB * 0.4), freeBytes: 6 * GiB, reserveBytes: 3 * GiB, pendingBytes: 0, spillSet: false, resync: false, fits: false });
    assert.deepEqual(v.next.map((n) => n.command), ["mason add events --yes", "mason tables"]);
    assert.equal(fs.readFileSync(p.file, "utf8"), before, "nothing written");
    // as a person: the table's line failed, its words under it, the failure, then what adds it anyway
    const person = await runMason(app, ["add", "events"], matrixEnv());
    assert.equal(person.code, 1, person.stdout + person.stderr);
    assert.match(person.stdout, /public\.events likely won't fit on disk: it needs about 4\.0 GiB, and 3\.0 GiB is free for it\n {4}Its synced data would need about 4\.0 GiB on disk, estimated from the database's catalog\. 6\.0 GiB is free where the synced data is\. Mason keeps 3\.0 GiB of it for queries that spill to disk/);
    assert.match(person.stderr, /mason add: public\.events was not added\n/);
    assert.match(person.stderr, /Next:\n {2}mason add events --yes +add it anyway, though it likely won't fit on disk\n/);
    assert.equal(fs.readFileSync(p.file, "utf8"), before);
    // --yes: added, its numbers said, and the line that says it went ahead anyway
    const yes = await runMason(app, ["add", "events", "--yes", "--json"], matrixEnv());
    assert.equal(yes.code, 0, yes.stdout + yes.stderr);
    assert.equal((JSON.parse(yes.stdout) as { added: Array<{ disk: { fits: boolean } }> }).added[0]!.disk.fits, false);
    assert.match(fs.readFileSync(p.file, "utf8"), /events: \{\}\n/);
    // THE RUN'S STATE (issue 1075): the table added anyway carries its shortage as numbers, and a warning says it in the
    // same numbers, until its first sync is in; a table not added carries its estimate, computed when the catalog was read
    const state = async () => await (await fetch(`http://127.0.0.1:${ctx.port}/api/state`, { headers: { authorization: `Bearer ${ctx.token}` } })).json() as
      { warnings: string[]; tables: Array<{ table: string; estimateBytes: number | null; diskShort?: unknown }> };
    const s = await state();
    const of = (t: string) => s.tables.find((x) => x.table === t)!;
    assert.deepEqual(of("public.events").diskShort, { code: "disk_short", neededBytes: Math.round(10 * GiB * 0.4), freeBytes: 6 * GiB, reserveBytes: 3 * GiB, pendingBytes: 0, estimated: true });
    assert.ok(s.warnings.includes("public.events was added though it likely won't fit on disk: it needs about 4.0 GiB, and 3.0 GiB is free for it, beside 3.0 GiB kept for queries that spill to disk"), s.warnings.join("\n"));
    assert.deepEqual([of("public.audit").estimateBytes, of("public.orders").estimateBytes, of("public.orders").diskShort], [123_456, null, undefined]);
    // with fewer columns it fits: said as nothing more
    const fewer = await runMason(app, ["add", "events", "--columns", "id"], matrixEnv());
    assert.equal(fewer.code, 0, fewer.stdout + fewer.stderr);
    assert.doesNotMatch(fewer.stdout, /won't fit/);
    const after = await state();
    assert.equal(after.tables.find((x) => x.table === "public.events")!.diskShort, undefined, "synced again with room: no longer short");
    assert.ok(!after.warnings.some((w) => w.includes("won't fit")));
  } finally { server.close(); fs.rmSync(p.root, { recursive: true, force: true }); }
});
