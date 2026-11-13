/**
 * `mason usage`: what the run was and did over time — a sample a minute (src/duck/usage.ts) of the copy's size and
 * rows, the copies failed, how old the stalest copy is, the statements and their duration, the stream's lag and the
 * memory — and each copy's own size. The run's `GET /api/usage` (src/cli/run-server.ts) answers it; `--json` prints that
 * answer as it is, so an agent and a chart read the same samples a person reads here.
 */
import { failed, jsonText, parseCommand, endText, type CommandSpec, type NextStep } from "./command.ts";
import { out as styleOut } from "./style.ts";
import { callRun } from "./control.ts";
import { reach } from "./state.ts";
import { fileSize, guarded, runFailure } from "./commands.ts";
import { timeOf } from "./request-filter.ts";
import { duration, statementMsText } from "./readiness.ts";
import { SIZE_EVERY_MS, type CopySize, type UnsizedTable, type UsageSample } from "../duck/usage.ts";
import { parseDuration } from "../lib/table-sync.ts";

const out = (m: string): void => { process.stdout.write(`${m}\n`); };
const n = (x: number): string => x.toLocaleString("en-US");

/**
 * WHAT A SYNCED TABLE WITH NO SIZE SHOWS where a size would be (issue 883; the run's `unsized`, src/duck/usage.ts
 * `unsizedTables`): `< 3 MiB` when its rows are all in the write-ahead log (the log's size, rounded up), `Measuring…`
 * for each other reason. The Tables page's Size cell is held equal to it (tests/web-page.test.ts).
 */
export function unsizedCell(u: Pick<UnsizedTable, "why" | "underBytes">): string {
  return u.why === "in-log" && u.underBytes !== null ? `< ${n(Math.round(u.underBytes / 1024 ** 2))} MiB` : "Measuring…";
}

/** Why, beside it on mason usage's line, one sentence a reason (`UnsizedWhy`: each a fact the run tells, never a guess):
 *  the CLI may name the log, which only a person at the files can look at. */
export function unsizedWhy(u: Pick<UnsizedTable, "why" | "underBytes">, sizedAt: string | null): string {
  const at = sizedAt === null ? "" : ` (at ${sizedAt.slice(11, 16)} UTC)`;
  const within = `measured within ${duration(SIZE_EVERY_MS / 1000)}`;
  switch (u.why) {
    case "in-log": return "its rows are all in the write-ahead log, not yet in the file: under the log's size, measured exactly once they are written into the file (the log past 16 MiB, or mason stop)";
    case "written-since": return `its rows were in the write-ahead log at the last measure${at}, and rows have been written into the file since, maybe its own: ${within}`;
    case "synced-since": return `synced since the last measure${at}: ${within}`;
    case "not-measured-yet": return `not measured since Mason started: the first measure is a minute after the start`;
  }
}

export const USAGE_USAGE = `usage: mason usage [--since <when>] [--until <when>] [--step <duration>] [--json]

  What Mason was and did over time, from a sample it takes every minute and keeps MASON_HISTORY_DAYS days
  (default 7): a line each span — the statements of the Postgres API (how many, how many were refused, failed or
  cancelled — the errors column —, the completed ones' p95 duration, the rows sent), the synced data's size and rows, the
  tables whose sync is failing, how old the stalest table was, the stream's lag (a table under sync: replication), and
  the memory of the process and of the engine against its limit (MASON_DUCKDB_MEMORY). Then each synced table's own size, measured every
  10 minutes once its rows are written into the file: a small table's can wait in the write-ahead log until it passes
  16 MiB or Mason stops, and shows "< 3 MiB" (under the log's size) until then; one not measured since its rows were
  written into the file, since it was synced or since Mason started shows "Measuring…" and why. A span sums its statements and shows each level at its highest. Read through the running Mason.

    mason usage                        the last hour, 5 minutes a line
    mason usage --since 7d --step 1h   the last week, an hour a line
    mason usage --since 2026-10-28T09:00:00Z --until 2026-10-28T10:00:00Z --step 0

  --since <when>   from when: an age (90s, 30m, 6h, 7d) or an ISO 8601 date or time with its zone; default 1h
  --until <when>   until when, the same way; default now
  --step <duration>  a line per span (1m to the days kept; default 5m; a bare number is seconds), or 0 for every
                   sample as it was taken
  --json           as data: its shape is at the end

  The --json answer: { since, until, stepSeconds (null: every sample), sampleSeconds, keptDays, samples: [{ at
    (with a step, the span's start), seconds, copyBytes, copyRows, tablesAdded, tablesCopied,
    tablesFailed, oldestSyncSeconds, statements, statementsRefused, statementsFailed, statementsCancelled,
    rowsSent, bytesSent, durationP50Ms, durationP95Ms, streamLagBytes, streamLagSeconds, rssBytes,
    heapUsedBytes, copyMemoryBytes, copyMemoryLimitBytes, slotWalHeldBytes (replication: the WAL the
    slot holds on the database), diskFreeBytes (free where the synced data is; with a step, the lowest),
    sessionsOpen (the Postgres API's sessions logged in) }],
    copySizes: [{ table, bytes, at }], sizedAt (when the sizes were last measured; null: not yet since
    Mason started), walBytes (the write-ahead log's size now; null: none), unsized: [{ table (a synced
    table with no size), why (in-log: measured since its first sync with its rows all in the write-ahead
    log, and nothing written into the file since; written-since: so at the last measure, but rows have
    been written into the file since; synced-since: its first sync finished after the last measure;
    not-measured-yet: no measure since Mason started), underBytes (in-log: the log's size rounded up to a
    MiB, which it is under; else null) }], next }
`;

export const USAGE: CommandSpec & { needs: "run" } = {
  needs: "run",
  name: "usage",
  summary: "what Mason did over time: statements, the synced data's size and age, memory (a sample a minute; --since 7d --step 1h)",
  usage: USAGE_USAGE,
  options: { since: { type: "string" }, until: { type: "string" }, step: { type: "string" }, json: { type: "boolean" } },
  json: ["since", "until", "stepSeconds", "sampleSeconds", "keptDays", "samples", "copySizes", "sizedAt", "walBytes", "unsized", "next"],
};

/** A span as the options write it (the command line's one duration grammar, src/lib/table-sync.ts `parseDuration`:
 *  90s, 30m, 6h, 7d, a bare number of seconds; 0 for every sample), in whole seconds, or null when it is not one. */
export function spanSeconds(text: string): number | null {
  if (text.trim() === "0") return 0;
  const d = parseDuration(text, { zero: true });
  return "problem" in d || !Number.isInteger(d.seconds) ? null : d.seconds;
}

/** One sample on one line: the time, the statements, those refused, failed or cancelled, p95, rows sent, the copy, its rows, the stalest copy, the lag, the memory. */
export function sampleLine(s: UsageSample, withLag: boolean): string {
  const time = s.at.slice(0, 16).replace("T", " ");
  const p95 = s.durationP95Ms === null ? "–" : statementMsText(s.durationP95Ms);
  const bad = s.statementsRefused + s.statementsFailed + s.statementsCancelled;
  const age = s.oldestSyncSeconds === null ? "–" : duration(s.oldestSyncSeconds);
  const lag = !withLag ? "" : `  ${(s.streamLagSeconds === null ? "–" : duration(s.streamLagSeconds)).padStart(9)}`;
  const memory = `${fileSize(s.rssBytes)}${s.copyMemoryBytes === null ? "" : ` (engine ${fileSize(s.copyMemoryBytes)} of ${fileSize(s.copyMemoryLimitBytes)})`}`;
  return `${time}  ${n(s.statements).padStart(10)}  ${(bad === 0 ? "" : n(bad)).padStart(7)}  ${p95.padStart(10)}  ${n(s.rowsSent).padStart(11)}  ` +
    `${(s.copyBytes === null ? "–" : fileSize(s.copyBytes)).padStart(10)}  ${n(s.copyRows).padStart(13)}  ${(s.tablesFailed === 0 ? "" : n(s.tablesFailed)).padStart(7)}  ` +
    `${age.padStart(10)}${lag}  ${memory}`;
}

/** The heading over `sampleLine`'s columns. */
export function sampleHeading(withLag: boolean): string {
  return `${"time (UTC)".padEnd(16)}  ${"statements".padStart(10)}  ${"errors".padStart(7)}  ${"p95".padStart(10)}  ${"rows sent".padStart(11)}  ` +
    `${"size".padStart(10)}  ${"rows".padStart(13)}  ${"failing".padStart(7)}  ${"oldest".padStart(10)}${withLag ? `  ${"lag".padStart(9)}` : ""}  memory`;
}

export async function usage(argv: string[], now = Date.now()): Promise<number> {
  const f = parseCommand(USAGE, argv);
  if (typeof f === "number") return f;
  const v = f.values as { since?: string; until?: string; step?: string; json?: boolean };
  const json = v.json === true;
  if (f.positionals.length) return failed("usage", { message: `it takes no ${f.positionals.length === 1 ? "argument" : "arguments"}: ${f.positionals.join(" ")}`, code: "usage", usage: USAGE_USAGE }, { json });
  // the one time grammar (src/cli/request-filter.ts timeOf): an age, or an ISO 8601 date or time WITH its zone
  const since = timeOf("--since", v.since ?? "1h", now), until = v.until === undefined ? new Date(now).toISOString() : timeOf("--until", v.until, now);
  for (const t of [since, until]) if (typeof t !== "string") return failed("usage", { ...t, usage: USAGE_USAGE }, { json });
  const step = spanSeconds(v.step ?? "5m");
  if (step === null) return failed("usage", { message: `--step is a duration (300, 1m, 5m, 1h, 1d: a bare number is seconds) or 0 for every sample, not ${JSON.stringify(v.step)}`, code: "usage", usage: USAGE_USAGE }, { json });
  const w = await reach(USAGE, json);
  if (w === null || !("run" in w)) return 1;
  const run = w.run;
  return guarded("usage", json, async () => {
    const q = new URLSearchParams({ since: since as string, until: until as string, ...(step === 0 ? {} : { step: String(step) }) });
    const r = await callRun(run, "GET", `/api/usage?${q}`);
    // the run's refusal (a step past the days kept, a since after until) in its own words and code
    if (r.status !== 200) return failed("usage", runFailure(r, [["mason usage --help", "the spans and times it takes"], ["mason logs", "the run's log"]]), { json });
    const b = r.body as unknown as { since: string; until: string; stepSeconds: number | null; sampleSeconds: number; keptDays: number; samples: UsageSample[]; copySizes: CopySize[];
      sizedAt?: string | null; walBytes?: number | null; unsized?: UnsizedTable[] };
    const next: NextStep[] = [["mason usage --since 7d --step 1h", "the week, an hour a line"], ["mason status", "where everything is now"]];
    if (json) { out(jsonText(USAGE, b, next)); return 0; }
    const st = styleOut();
    const span = b.stepSeconds === null ? "every sample" : `${duration(b.stepSeconds)} a line`;
    out(st.bold(`Usage from ${b.since.slice(0, 16).replace("T", " ")} to ${b.until.slice(0, 16).replace("T", " ")} UTC, ${span} (a sample every ${duration(b.sampleSeconds)}, kept ${b.keptDays} day${b.keptDays === 1 ? "" : "s"}):`));
    if (!b.samples.length) out(st.dim("  no sample in this time: Mason takes the first a minute after it starts"));
    else {
      const withLag = b.samples.some((s) => s.streamLagBytes !== null || s.streamLagSeconds !== null);
      out(st.dim(sampleHeading(withLag)));
      for (const s of b.samples) out(sampleLine(s, withLag));
    }
    // a run of an earlier Mason says no table without a size: none listed
    const unsized = b.unsized ?? [];
    if (b.copySizes.length || unsized.length) {
      out("");
      out(st.bold(`Each synced table's own size (measured every ${duration(SIZE_EVERY_MS / 1000)}):`));
      const wide = Math.max(...b.copySizes.map((c) => c.table.length), ...unsized.map((u) => u.table.length));
      for (const c of b.copySizes) out(`  ${c.table.padEnd(wide)}  ${fileSize(c.bytes).padStart(10)}  ${st.dim(`at ${c.at.slice(11, 16)} UTC`)}`);
      // a synced table with no size says why, on its line, where its size would be (issue 883)
      for (const u of unsized) out(`  ${u.table.padEnd(wide)}  ${unsizedCell(u).padStart(10)}  ${st.dim(unsizedWhy(u, b.sizedAt ?? null))}`);
    }
    out(endText({ next }, st));
    return 0;
  });
}
