/**
 * `mason sync <table>…`: Mason's poll of exactly these tables, now — named for what it does to the copy
 * (made current, incrementally), never for the mechanism (`poll` was). The passes poll every added table but one over
 * the poll's row limit (src/duck/sync.ts POLL_ROW_LIMIT: each poll scans its table whole on the database), which is
 * copied and served as it was copied; this reads what changed in it since, when asked. The run's `POST /api/sync`
 * (src/cli/run-server.ts) answers it, through the sync's own poll (`Sync.pollNow`).
 */
import { failed, jsonText, parseCommand, reportText, type CommandSpec, type NextStep } from "./command.ts";
import { out as styleOut } from "./style.ts";
import { callRun } from "./control.ts";
import { reach } from "./state.ts";
import { findTable, guarded, readState, tableArg } from "./commands.ts";
import { didYouMean } from "../lib/did-you-mean.ts";
import { POLL_ROW_LIMIT, type PolledTable } from "../duck/sync.ts";

const out = (m: string): void => { process.stdout.write(`${m}\n`); };
const n = (x: number): string => x.toLocaleString("en-US");

export const SYNC_USAGE = `usage: mason sync <table>… [--json]

  Makes Mason's copy of these tables current now: it reads what changed in your database since Mason last read them —
  the rows inserted or updated, and the ones deleted. Mason syncs every added table by itself every few seconds, but
  a table over ${n(POLL_ROW_LIMIT)} rows is copied and served without that (each sync scans a table whole on your
  database): mason status says which, and this syncs one when you need it current. mason start --replication keeps
  every table current from the database's change log, whatever its size.

    mason sync orders
    mason sync orders public.events

  --json   as data: { syncedAt, tables: [{ table, changed, deleted, rows, ms }], next }
`;

export const SYNC: CommandSpec & { needs: "run" } = {
  needs: "run",
  name: "sync",
  summary: "make the copy of these tables current now: mason sync orders (a table over the sync's row limit is synced only so)",
  usage: SYNC_USAGE,
  options: { json: { type: "boolean" } },
  json: ["syncedAt", "tables", "next"],
};

export async function sync(argv: string[]): Promise<number> {
  const f = parseCommand(SYNC, argv);
  if (typeof f === "number") return f;
  const json = f.values.json === true;
  const names = [...new Set(f.positionals)];
  if (!names.length) return failed("sync", { message: "name a table: mason sync orders (mason status lists the added ones)", code: "usage", usage: SYNC_USAGE }, { json });
  const w = await reach(SYNC, json);
  if (w === null || !("run" in w)) return 1;
  const run = w.run;
  return guarded("sync", json, async () => {
    const s = await readState(run);
    const added = s.tables.filter((t) => t.added);
    const picked: string[] = [];
    for (const name of names) {
      const t = findTable(added, name);
      if (!("message" in t)) { picked.push(t.table); continue; }
      // a table of the database that is not added is told so, with the command that adds it
      const db = findTable(s.tables, name);
      if ("message" in db && db.code === "usage") return failed("sync", db, { json });
      if (!("message" in db)) {
        return failed("sync", { message: `${db.table} is not added, so Mason has no copy of it to sync`, code: "not_found", fix: `mason add ${tableArg(db.table)}`,
          next: [["mason status", "the added tables"]] }, { json });
      }
      return failed("sync", { message: `there is no added table ${JSON.stringify(name)}${didYouMean(name, added.flatMap((x) => [x.table, tableArg(x.table)]))}`, code: "not_found",
        next: [["mason status", "the added tables"], ["mason tables", "the database's tables"]] }, { json });
    }
    // a sync scans each table whole on the database (and waits for a copy under way): minutes, not the commands' 30 s
    const r = await callRun(run, "POST", "/api/sync", { tables: picked }, 60 * 60_000);
    if (r.status !== 200) {
      const code = typeof r.body.code === "string" ? r.body.code : r.status === 404 ? "not_found" : "failed";
      return failed("sync", { message: `${picked.join(", ")} ${picked.length === 1 ? "was" : "were"} not synced`, code, why: String(r.body.error),
        next: [["mason status", "each table's copy"], ["mason logs", "the run's log"]] }, { json });
    }
    const b = r.body as unknown as { at: string; tables: PolledTable[] };
    const unsynced = added.filter((t) => picked.includes(t.table) && t.unsynced);
    const next: NextStep[] = [[`mason sync ${names.join(" ")}`, "sync again, whenever you need it current"], ["mason status", "each table's copy, and which the sync leaves out"]];
    if (json) { out(jsonText(SYNC, { syncedAt: b.at, tables: b.tables }, next)); return 0; }
    const changed = b.tables.reduce((a, t) => a + t.changed, 0), deleted = b.tables.reduce((a, t) => a + t.deleted, 0);
    out(reportText({
      headline: `Synced ${picked.join(", ")}: ${n(changed)} row(s) written, ${n(deleted)} deleted.`,
      details: b.tables.map((t) => [t.table, `${n(t.changed)} changed, ${n(t.deleted)} deleted, ${n(t.rows)} rows now · ${n(t.ms)} ms`] as const),
      tips: unsynced.map((t) => `${t.table} is ${t.unsynced!.reason}: it stays as of this sync until the next mason sync (mason start --replication keeps every table current)`),
      next,
    }, styleOut()));
    return 0;
  });
}
