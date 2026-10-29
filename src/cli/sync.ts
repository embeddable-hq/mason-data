/**
 * `mason sync <table>…`: Mason's poll of exactly these tables, now — named for what it does to the copy
 * (made current, incrementally), never for the mechanism (`poll` was). A table whose sources-file entry says `sync:
 * off` (the default: src/lib/table-sync.ts) is read again only so, and one set to `poll <interval>` is polled now
 * whatever its interval says, its next poll an interval from this one. In replication mode nothing is polled: the
 * answer is where the stream is. The run's `POST /api/sync` (src/cli/run-server.ts) answers it, through the sync's own
 * poll (`Sync.pollNow`).
 */
import { failed, jsonText, parseCommand, reportText, type CommandSpec, type NextStep } from "./command.ts";
import { out as styleOut } from "./style.ts";
import { callRun } from "./control.ts";
import { reach } from "./state.ts";
import { findTable, guarded, readState, tableArg } from "./commands.ts";
import { didYouMean } from "../lib/did-you-mean.ts";
import type { KeptCurrent, PolledTable, StreamedAnswer } from "../duck/sync.ts";
import { syncWords } from "../lib/table-sync.ts";

const out = (m: string): void => { process.stdout.write(`${m}\n`); };
const n = (x: number): string => x.toLocaleString("en-US");

export const SYNC_USAGE = `usage: mason sync <table>… [--json]

  Brings these synced tables up to date now: it reads what changed in your database since Mason last read them —
  the rows inserted or updated, and the ones deleted — in one transaction, as a poll does (each one scans its table
  whole on your database). After its first sync, a table is read again as its sync: in the sources file says: off
  (the default) only when you run this — before a report, from cron, at the end of a deploy — and poll <interval> by
  itself every interval, which this does now too, whatever the interval says. mason status says how each table is
  kept current and when it was last synced. With mason start --replication, nothing is polled: it answers where the
  stream of the database's change log is.

    mason sync orders
    mason sync orders public.events

  --json   as data: { syncedAt, tables: [{ table, changed, deleted, rows, ms }], streamed (replication mode: [{ table,
           position, state, why }], nothing polled), next }
`;

export const SYNC: CommandSpec & { needs: "run" } = {
  needs: "run",
  name: "sync",
  summary: "bring these synced tables up to date now: mason sync orders (a table whose sync is off is read again only so)",
  usage: SYNC_USAGE,
  options: { json: { type: "boolean" } },
  json: ["syncedAt", "tables", "streamed", "next"],
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
        return failed("sync", { message: `${db.table} is not added, so Mason has not synced it`, code: "not_found", fix: `mason add ${tableArg(db.table)}`,
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
        next: [["mason status", "each synced table"], ["mason logs", "the run's log"]] }, { json });
    }
    const b = r.body as unknown as { at: string; tables: PolledTable[]; streamed?: StreamedAnswer[] };
    const next: NextStep[] = [[`mason sync ${names.join(" ")}`, "sync again, whenever you need it current"], ["mason status", "how each table is kept current, and when it was last synced"]];
    if (json) { out(jsonText(SYNC, { syncedAt: b.at, tables: b.tables, ...(b.streamed ? { streamed: b.streamed } : {}) }, next)); return 0; }
    if (b.streamed) {
      out(reportText({ headline: `Nothing to sync: logical replication keeps ${picked.join(", ")} current.`,
        details: b.streamed.map((t) => [t.table, `${t.state}${t.why ? `: ${t.why}` : ""} · the stream has applied the database's changes through ${t.position}`] as const), next }, styleOut()));
      return 0;
    }
    const changed = b.tables.reduce((a, t) => a + t.changed, 0), deleted = b.tables.reduce((a, t) => a + t.deleted, 0);
    out(reportText({
      headline: `Synced ${picked.join(", ")}: ${n(changed)} row(s) written, ${n(deleted)} deleted.`,
      details: b.tables.map((t) => [t.table, `${n(t.changed)} changed, ${n(t.deleted)} deleted, ${n(t.rows)} rows now · ${n(t.ms)} ms`] as const),
      // what happens next to each: an `off` table stays as of now, a polled one is polled again after its interval
      tips: syncedTips(added.filter((t) => picked.includes(t.table))),
      next,
    }, styleOut()));
    return 0;
  });
}

/** What happens to each table synced after now, by its sync (src/duck/sync.ts KeptCurrent): an `off` table stays as of
 *  this sync until the next one, a polled one is polled again after its interval. */
export function syncedTips(tables: ReadonlyArray<{ table: string; kept?: KeptCurrent }>): string[] {
  return tables.flatMap((t) => {
    const k = t.kept;
    if (k?.by !== "poll") return [];
    return [k.sync.mode === "off" ? `${t.table}'s sync is off: it stays as of this sync until the next mason sync ${tableArg(t.table)}`
      : `${t.table} is ${syncWords(k.sync)}: its next poll is an interval from this one`];
  });
}
