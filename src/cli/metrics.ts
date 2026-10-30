/**
 * `GET /metrics` (`mason serve`'s health port, beside `/healthz`): the run's numbers in Prometheus's text exposition
 * format 0.0.4, for a team that scrapes its services (docs/OBSERVABILITY.md "Access", option C; docs/DESIGN.md
 * "Observability").
 *
 * NUMBERS ONLY, NEVER A NAME: the endpoint takes no credential, as `/healthz` takes none, and a real database's
 * structure is confidential — so no table, column, user, client, statement or host appears here, as a value or as a
 * label. The renderer is a whitelist: it reads named numeric fields of its facts and nothing else, so a field added to
 * the facts later (a name among them) is never printed by accident (tests/cli-metrics.test.ts feeds it names and holds
 * them absent). The one label value that is text is the version, Mason's own.
 *
 * ONE FACT, ONE PLACE: every number is one the run already computes for `mason status` and the usage samples
 * (src/cli/run-server.ts `metricsFacts`: `usageFacts`, the sampler's statement counter and its last p50 / p95); this
 * module renders, it never derives.
 *
 * A NUMBER NOT KNOWN IS ABSENT, never 0 and never NaN: a stream's lag where nothing streams, the stalest copy's age
 * before any sync, a size that could not be read. An absent series is what Prometheus's `absent()` and a missing-data
 * alert read; a 0 would say "no lag" of a stream that is not there, and NaN compares false with everything, so an
 * alert on it never fires.
 */
import type { LastDurations, StatementTotals, UsageFacts } from "../duck/usage.ts";

/** The content type of the text exposition format, version 0.0.4. */
export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/** What the run says once it serves (src/cli/run-server.ts `metricsFacts`, plus `/healthz`'s uptime). */
export interface RunMetrics {
  /** since the serve started, as `/healthz`'s `uptimeSeconds` says it */
  uptimeSeconds: number;
  /** a usage sample's facts at this moment (src/cli/run-server.ts `usageFacts`) */
  usage: UsageFacts;
  /** the statements since the process started, by outcome (src/duck/usage.ts `statementTotals`) */
  statements: StatementTotals;
  /** the last usage sample's p50 / p95 of its completed statements; null before the first sample */
  durations: LastDurations | null;
}

/** What `/metrics` renders: Mason's version, and the run's numbers once it serves (null while starting or stopping). */
export interface MetricsFacts { version: string; run: RunMetrics | null }

type Kind = "gauge" | "counter" | "summary";
interface Sample { labels?: Readonly<Record<string, string>>; suffix?: string; value: number | null }

/** a label value escaped as the format says: backslash, double quote and line feed */
const labelValue = (v: string): string => v.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");

/** a sample's value: an integer as written, a fraction as JavaScript prints it (Go's ParseFloat reads both) */
const valueText = (n: number): string => (Number.isInteger(n) ? n.toFixed(0) : String(n));

/** One metric's lines: its HELP and TYPE, then each sample whose value is a finite number; a metric with none is absent. */
function metric(name: string, kind: Kind, help: string, samples: readonly Sample[]): string[] {
  const kept = samples.filter((s): s is Sample & { value: number } => s.value !== null && Number.isFinite(s.value));
  if (kept.length === 0) return [];
  const lines = [`# HELP ${name} ${help.replaceAll("\\", "\\\\").replaceAll("\n", "\\n")}`, `# TYPE ${name} ${kind}`];
  for (const s of kept) {
    const labels = s.labels ? Object.entries(s.labels).map(([k, v]) => `${k}="${labelValue(v)}"`).join(",") : "";
    lines.push(`${name}${s.suffix ?? ""}${labels ? `{${labels}}` : ""} ${valueText(s.value)}`);
  }
  return lines;
}

/** The PHASES `mason_tables` says, in order: the sync's (src/duck/sync.ts `CopyState.phase`), as `/healthz` counts them. */
export const TABLE_PHASES = ["copied", "copying", "waiting", "failed"] as const;
/** The OUTCOMES `mason_statements_total` says: the request log's (`outcomeOf`), `ok` said as `completed`. */
export const STATEMENT_OUTCOMES = ["completed", "failed", "refused", "cancelled"] as const;

/**
 * THE BODY OF `GET /metrics`. Starting or stopping: `mason_ready 0` and `mason_info` alone (a scrape must not fail
 * while Mason starts; whether it is up is `/healthz`'s to say). Serving: `mason_ready 1` and the run's numbers.
 */
export function metricsText(f: MetricsFacts): string {
  const lines = [
    ...metric("mason_ready", "gauge", "1 once Mason serves the copy; 0 while it starts or stops (/healthz answers 503 then).", [{ value: f.run === null ? 0 : 1 }]),
    ...metric("mason_info", "gauge", "Mason's version, as a label; the value is always 1.", [{ labels: { version: f.version }, value: 1 }]),
  ];
  const r = f.run;
  if (r !== null) {
    const u = r.usage, st = r.statements;
    lines.push(
      ...metric("mason_uptime_seconds", "gauge", "Seconds since mason serve started.", [{ value: r.uptimeSeconds }]),
      ...metric("mason_tables", "gauge", "The tables Mason copies, by phase of their copy.",
        TABLE_PHASES.map((phase) => ({ labels: { phase }, value: u.tables[phase] }))),
      ...metric("mason_copy_bytes", "gauge", "The size of the copy's file on disk, bytes.", [{ value: u.copyBytes }]),
      ...metric("mason_copy_rows", "gauge", "The rows of the copies served.", [{ value: u.totals.rows }]),
      // absent, not NaN, before any added table was synced: nothing has an age yet (see the module's comment)
      ...metric("mason_sync_oldest_age_seconds", "gauge", "Seconds since the stalest added table was last brought current; absent before any sync.",
        [{ value: u.oldestSyncSeconds }]),
      // absent where no table is replicated (the run polls): a 0 would claim a stream that is not there
      ...metric("mason_stream_lag_bytes", "gauge", "Replication: WAL bytes between the database's position and what the copy has applied; absent when nothing is replicated.",
        [{ value: u.streamLag?.bytes ?? null }]),
      ...metric("mason_stream_lag_seconds", "gauge", "Replication: seconds since the newest change applied was committed on the database; absent when nothing is replicated.",
        [{ value: u.streamLag?.seconds ?? null }]),
      ...metric("mason_slot_wal_held_bytes", "gauge", "Replication: WAL bytes the replication slot holds on the database; absent when nothing is replicated or it could not be read.",
        [{ value: u.slotWalHeldBytes }]),
      ...metric("mason_disk_free_bytes", "gauge", "Bytes free on the disk the copy is on.", [{ value: u.diskFreeBytes }]),
      ...metric("mason_sessions_open", "gauge", "Sessions logged in to Mason's Postgres API now.", [{ value: u.sessionsOpen }]),
      ...metric("mason_statements_total", "counter", "Statements answered since the process started, by outcome (refused: the statement's fault; failed: Mason's or the machine's).",
        STATEMENT_OUTCOMES.map((outcome) => ({ labels: { outcome }, value: outcome === "completed" ? st.completed : st[outcome] }))),
      ...durationSummary(r),
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * `mason_statement_duration_seconds`, a summary: the quantiles are the last usage sample's (its minute's completed
 * statements, as `mason usage` says them: src/duck/usage.ts `lastDurations`), absent before the first sample and for a
 * minute none completed; `_sum` and `_count` are the completed statements since the process started (the counter), as a
 * Prometheus client's summary is: quantiles over a recent window, sum and count cumulative.
 */
function durationSummary(r: RunMetrics): string[] {
  const d = r.durations;
  const seconds = (ms: number | null | undefined): number | null => (ms === null || ms === undefined ? null : ms / 1000);
  return metric("mason_statement_duration_seconds", "summary",
    "Completed statements' duration, seconds: p50 and p95 over the last minute's sample; sum and count since the process started.", [
      { labels: { quantile: "0.5" }, value: seconds(d?.p50Ms) },
      { labels: { quantile: "0.95" }, value: seconds(d?.p95Ms) },
      { suffix: "_sum", value: r.statements.completedMs / 1000 },
      { suffix: "_count", value: r.statements.completed },
    ]);
}
