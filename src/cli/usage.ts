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
import { duration, msText } from "./readiness.ts";
import { SIZE_EVERY_MS, type CopySize, type UsageSample } from "../duck/usage.ts";

const out = (m: string): void => { process.stdout.write(`${m}\n`); };
const n = (x: number): string => x.toLocaleString("en-US");

export const USAGE_USAGE = `usage: mason usage [--since <when>] [--until <when>] [--step <span>] [--json]

  What Mason was and did over time, from a sample it takes every minute and keeps MASON_HISTORY_DAYS days
  (default 7): a line each span — the statements of the Postgres API (how many, how many were refused, failed or
  cancelled — the errors column —, the completed ones' p95 duration, the rows sent), the copy's size and rows, the
  tables whose sync is failing, how old the stalest copy was, the stream's lag (with --replication), and the memory
  of the process and of the copy against its limit (MASON_DUCKDB_MEMORY). Then each copy's own size, measured every
  10 minutes. A span sums its statements and shows each level at its highest. Read through the running Mason.

    mason usage                        the last hour, 5 minutes a line
    mason usage --since 7d --step 1h   the last week, an hour a line
    mason usage --since 2026-10-28T09:00:00Z --until 2026-10-28T10:00:00Z --step 0

  --since <when>   from when: an age (90s, 30m, 6h, 7d) or an ISO 8601 date or time with its zone; default 1h
  --until <when>   until when, the same way; default now
  --step <span>    a line per span (1m to the days kept; default 5m), or 0 for every sample as it was taken
  --json           as data: { since, until, stepSeconds (null: every sample), sampleSeconds, keptDays, samples: [{ at
                   (with a step, the span's start), seconds, copyBytes, copyRows, tablesAdded, tablesCopied,
                   tablesFailed, oldestSyncSeconds, statements, statementsRefused, statementsFailed, statementsCancelled,
                   rowsSent, bytesSent, durationP50Ms, durationP95Ms, streamLagBytes, streamLagSeconds, rssBytes,
                   heapUsedBytes, copyMemoryBytes, copyMemoryLimitBytes, slotWalHeldBytes (replication: the WAL the
                   slot holds on the database), diskFreeBytes (free where the copy is; with a step, the lowest),
                   sessionsOpen (the Postgres API's sessions logged in) }],
                   copySizes: [{ table, bytes, at }], next }
`;

export const USAGE: CommandSpec & { needs: "run" } = {
  needs: "run",
  name: "usage",
  summary: "what Mason did over time: statements, the copy's size and age, memory (a sample a minute; --since 7d --step 1h)",
  usage: USAGE_USAGE,
  options: { since: { type: "string" }, until: { type: "string" }, step: { type: "string" }, json: { type: "boolean" } },
  json: ["since", "until", "stepSeconds", "sampleSeconds", "keptDays", "samples", "copySizes", "next"],
};

const UNIT: Readonly<Record<string, number>> = { s: 1, m: 60, h: 3600, d: 86_400 };

/** A span as the options write it (90s, 30m, 6h, 7d; 0), in seconds, or null when it is not one. */
export function spanSeconds(text: string): number | null {
  if (text.trim() === "0") return 0;
  const m = /^\s*(\d+)\s*([smhd])\s*$/.exec(text);
  return m ? Number(m[1]) * UNIT[m[2]!]! : null;
}

/** One sample on one line: the time, the statements, those refused, failed or cancelled, p95, rows sent, the copy, its rows, the stalest copy, the lag, the memory. */
export function sampleLine(s: UsageSample, withLag: boolean): string {
  const time = s.at.slice(0, 16).replace("T", " ");
  const p95 = s.durationP95Ms === null ? "–" : msText(s.durationP95Ms);
  const bad = s.statementsRefused + s.statementsFailed + s.statementsCancelled;
  const age = s.oldestSyncSeconds === null ? "–" : duration(s.oldestSyncSeconds);
  const lag = !withLag ? "" : `  ${(s.streamLagSeconds === null ? "–" : duration(s.streamLagSeconds)).padStart(9)}`;
  const memory = `${fileSize(s.rssBytes)}${s.copyMemoryBytes === null ? "" : ` (copy ${fileSize(s.copyMemoryBytes)} of ${fileSize(s.copyMemoryLimitBytes)})`}`;
  return `${time}  ${n(s.statements).padStart(10)}  ${(bad === 0 ? "" : n(bad)).padStart(7)}  ${p95.padStart(10)}  ${n(s.rowsSent).padStart(11)}  ` +
    `${(s.copyBytes === null ? "–" : fileSize(s.copyBytes)).padStart(10)}  ${n(s.copyRows).padStart(13)}  ${(s.tablesFailed === 0 ? "" : n(s.tablesFailed)).padStart(7)}  ` +
    `${age.padStart(10)}${lag}  ${memory}`;
}

/** The heading over `sampleLine`'s columns. */
export function sampleHeading(withLag: boolean): string {
  return `${"time (UTC)".padEnd(16)}  ${"statements".padStart(10)}  ${"errors".padStart(7)}  ${"p95".padStart(10)}  ${"rows sent".padStart(11)}  ` +
    `${"copy".padStart(10)}  ${"rows".padStart(13)}  ${"failing".padStart(7)}  ${"oldest".padStart(10)}${withLag ? `  ${"lag".padStart(9)}` : ""}  memory`;
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
  if (step === null) return failed("usage", { message: `--step is a span (1m, 5m, 1h, 1d) or 0 for every sample, not ${JSON.stringify(v.step)}`, code: "usage", usage: USAGE_USAGE }, { json });
  const w = await reach(USAGE, json);
  if (w === null || !("run" in w)) return 1;
  const run = w.run;
  return guarded("usage", json, async () => {
    const q = new URLSearchParams({ since: since as string, until: until as string, ...(step === 0 ? {} : { step: String(step) }) });
    const r = await callRun(run, "GET", `/api/usage?${q}`);
    // the run's refusal (a step past the days kept, a since after until) in its own words and code
    if (r.status !== 200) return failed("usage", runFailure(r, [["mason usage --help", "the spans and times it takes"], ["mason logs", "the run's log"]]), { json });
    const b = r.body as unknown as { since: string; until: string; stepSeconds: number | null; sampleSeconds: number; keptDays: number; samples: UsageSample[]; copySizes: CopySize[] };
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
    if (b.copySizes.length) {
      out("");
      out(st.bold(`Each copy's own size (measured every ${duration(SIZE_EVERY_MS / 1000)}):`));
      const wide = Math.max(...b.copySizes.map((c) => c.table.length));
      for (const c of b.copySizes) out(`  ${c.table.padEnd(wide)}  ${fileSize(c.bytes).padStart(10)}  ${st.dim(`at ${c.at.slice(11, 16)} UTC`)}`);
    }
    out(endText({ next }, st));
    return 0;
  });
}
