#!/usr/bin/env node
/**
 * THE STORED FOLD, LARGER THAN MEMORY (issue 124 stage 5, sub-issue 177): what stage 6's live table would cost, measured
 * before it is built. Issue 124's "How a table stays current" keeps a generated table current by folding each stream
 * batch into its stored rows (steps 1-7, with the time bound). This script drives those steps BY HAND on the real engine,
 * over synthetic data five times the container's memory, with dashboard statements running beside it through the real
 * listener, and says whether the numbers argue against stages 6-11. No product code changes: it calls src/ as it is.
 *
 *   node scripts/bench-fold.ts --smoke --out <file.json>     # 3 GiB container, ~1.5 GB of data, phases of ~1 min, <= 15 min
 *   scripts/gate-slot.ts node scripts/bench-fold.ts --out <file.json>   # the measurement: 4 GiB, ~20 GiB, <= 110 min
 *     --keep           leave the container, volume and image (debugging only; never the default)
 *     --budget-min N   the hard deadline (default 110)
 *
 * THE SETUP: everything that reads or writes the data runs in ONE container of the mason-data image
 * (docker/mason-data.Dockerfile), built from this tree and tagged `mason-bench-fold-<random>`, with --memory = --memory-swap
 * (no swap: swap would hide the pressure) and --cpus 4; its data on a NAMED volume at /data (a bind mount is served by
 * macOS's own cache), the volume's block device throttled to an EBS gp3's rate where the device can be found; this file
 * mounted read-only at /app/scripts/bench-fold.ts so its `../src/` is the image's. Inside, `--inside` serves a small
 * control port; the host (this script, default mode) drives the phases over it and runs the 4 load clients itself, with
 * `pg` loaded by dynamic import (a dev dependency the image does not have), over ports published on 127.0.0.1 only. The
 * data is generated in the same container lifetime as every phase, so no page a dead container cached serves a read.
 *
 * PHASES: (0) generate, and the cold read rate; (1) the whole re-run of both generated tables; (2) statements alone, 7-day
 * then 30-day; (3) the writer alone; (4) together, 4 users; (5) the correctness gate; (6) the report and cleanup. The
 * result JSON is written after every phase, so an interrupted run keeps what it measured; the report (markdown) beside it.
 * Every exit path removes the container, the volume and the image by their exact names and VERIFIES each is gone.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DuckStore, MASON_SCHEMA, SessionSetup } from "../src/duck/store.ts";
import { Sync, type AddedTable } from "../src/duck/sync.ts";
import { startPostgresApi, type PgApiServer } from "../src/api/postgres/server.ts";
import { GENERATED_DIR, readGenerated } from "../src/cli/generated-files.ts";
import { planDefinition, type DefinitionPlan, type Planner } from "../src/duck/generated-plan.ts";
import type { GeneratedStatus } from "../src/duck/generated.ts";
import { mintToken, tokenProblem } from "../src/duck/token.ts";
import type { DuckConnection } from "../src/duck/executor.ts";
import type { Source } from "../src/cli/preflight.ts";

// ───────────────────────────── the thresholds, set before the run so the numbers cannot choose them ─────────────────────────────

export const THRESHOLDS = {
  /** T1: a batch's p95 writer time with the fold, beside 4 users, at most this share of its interval */
  t1Share: 0.5,
  /** T2: the fold's added p95 per 60-row batch beside statements, ms */
  t2AddedMs: 1000,
  /** T3: the 7-day statements over the generated tables at 4 users, p95 at or under this with the fold beside, ms */
  t3P95Ms: 3000,
  /** T3: and the fold raises their p95 by at most this share against statements alone */
  t3Rise: 0.25,
  /** T4 (relevance): a whole re-run of requests plus daily_durations taking less than this, s, is covered by a scheduled table */
  t4Seconds: 60,
} as const;

const GIB = 1024 ** 3;
export const CAP_BYTES = 30e9;
export const VOLUME_STOP_BYTES = 38e9;
export const HOST_FREE_MIN_BYTES = 60e9;
export const BUDGET_MS = 110 * 60_000;
export const CLEANUP_MS = 5 * 60_000;
const SEED = 124177;
const API_KEY_BYTES = 32;
const CONTROL_PORT = 4141;
const PG_PORT = 5433;

// ───────────────────────────── the definitions (issue 124's shapes; the statements beside) ─────────────────────────────

export const REQUESTS_SQL = "SELECT tenant_id, coalesce(request_key, id) AS key, min(started_at) AS first_at, max(finished_at) AS last_at, " +
  "(extract(epoch FROM max(finished_at) - min(started_at)) * 1000)::double precision AS duration_ms, " +
  "latest(status ORDER BY started_at, id) AS status, latest(code ORDER BY started_at, id) AS code FROM events WHERE kind = 'query' GROUP BY 1, 2";
export const REQUESTS_ORDER = "date_trunc('day', first_at AT TIME ZONE 'UTC'), tenant_id";
export const DAILY_SQL = "SELECT tenant_id, date_trunc('day', first_at AT TIME ZONE 'UTC') AS day, count(*) AS requests, " +
  "percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95 FROM requests GROUP BY 1, 2";
export const DAILY_ORDER = "day, tenant_id";
const yml = (sql: string, order: string): string => `kind: scheduled\ntarget_lag: 24h\nsql: |\n  ${sql}\norder_by: ${order}\n`;
export const GENERATED_FILES: Record<string, string> = { requests: yml(REQUESTS_SQL, REQUESTS_ORDER), daily_durations: yml(DAILY_SQL, DAILY_ORDER) };

export const RANGES = { "7d": ["2026-03-24", "2026-03-31"], "30d": ["2026-03-01", "2026-03-31"] } as const;
export type RangeName = keyof typeof RANGES;
export interface Statement { name: string; sql: string; generated: boolean }
/** S1-S7 for one tenant and range, as literals as BI tools send them; `generated`: it reads the generated tables (T3's set) */
export function statementsFor(tenant: number, range: RangeName, label: string): Statement[] {
  const [from, to] = RANGES[range];
  const tz = `first_at >= timestamptz '${from} 00:00:00+00' AND first_at < timestamptz '${to} 00:00:00+00'`;
  const st = `started_at >= timestamptz '${from} 00:00:00+00' AND started_at < timestamptz '${to} 00:00:00+00'`;
  const n = (s: string): string => `${s} ${label} ${range}`;
  return [
    { name: n("S1"), generated: true, sql: `SELECT date_trunc('day', first_at AT TIME ZONE 'UTC') AS day, count(*) AS requests, avg(duration_ms) AS avg_ms FROM requests WHERE tenant_id = ${tenant} AND ${tz} GROUP BY 1 ORDER BY 1` },
    { name: n("S2"), generated: true, sql: `SELECT status, count(*) AS requests FROM requests WHERE tenant_id = ${tenant} AND ${tz} GROUP BY status ORDER BY 2 DESC, 1` },
    { name: n("S3"), generated: true, sql: `SELECT key, first_at, duration_ms, status FROM requests WHERE tenant_id = ${tenant} AND ${tz} ORDER BY duration_ms DESC NULLS LAST, key LIMIT 50` },
    { name: n("S4"), generated: true, sql: `SELECT day, requests, p95 FROM daily_durations WHERE tenant_id = ${tenant} AND day >= timestamp '${from} 00:00:00' AND day < timestamp '${to} 00:00:00' ORDER BY day` },
    { name: n("S5"), generated: true, sql: `SELECT date_trunc('day', first_at AT TIME ZONE 'UTC') AS day, code, count(*) AS requests FROM requests WHERE tenant_id = ${tenant} AND ${tz} GROUP BY 1, 2 ORDER BY 1, 2` },
    { name: n("S6"), generated: false, sql: `SELECT payload->>'source' AS source, count(*) AS events FROM events WHERE tenant_id = ${tenant} AND ${st} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10` },
    { name: n("S7"), generated: false, sql: `SELECT coalesce(request_key, id) AS key, min(started_at) AS first_at, max(finished_at) AS last_at, latest(status ORDER BY started_at, id) AS status FROM events WHERE kind = 'query' AND tenant_id = ${tenant} AND ${st} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 100` },
  ];
}
export const statementSet = (tenants: { top: number; median: number }, range: RangeName): Statement[] =>
  [...statementsFor(tenants.top, range, "top"), ...statementsFor(tenants.median, range, "median")];

// ───────────────────────────── pure parts: sizing, docker, the deadline, the verdict, the report ─────────────────────────────

/** the data's target bytes: 5x the container's memory, capped; refused under 3x the memory (not "several times") */
export function targetBytes(memoryBytes: number, capBytes = CAP_BYTES): number {
  const target = Math.min(5 * memoryBytes, capBytes);
  if (target < 3 * memoryBytes) throw new Error(`the data would be ${(target / memoryBytes).toFixed(2)}x the container's memory (${gib(memoryBytes)}), under the 3x a larger-than-memory run needs: give the container less memory`);
  return target;
}
/** past this the run stops: the volume's limit is 40 GB */
export const volumeTooBig = (bytes: number): boolean => bytes > VOLUME_STOP_BYTES;

export interface ContainerSpec { container: string; image: string; volume: string; memoryBytes: number; cpus: number; device: string | null; script: string; env: Record<string, string>; args: string[] }
/** the one container's `docker run` arguments: memory = memory-swap, the cpus, a NAMED volume at /data, the device's
 *  throttle where one was found, this script read-only, ports on 127.0.0.1 only */
export function containerArgs(s: ContainerSpec): string[] {
  if (s.volume.includes("/") || s.volume.startsWith(".")) throw new Error(`the data volume must be a named docker volume, not a path: ${s.volume}`);
  const mem = `${Math.floor(s.memoryBytes / 1024 ** 2)}m`;
  const throttle = s.device === null ? [] : ["--device-read-bps", `${s.device}:125mb`, "--device-write-bps", `${s.device}:125mb`, "--device-read-iops", `${s.device}:3000`, "--device-write-iops", `${s.device}:3000`];
  return ["run", "-d", "--name", s.container, "--user", "0", "--memory", mem, "--memory-swap", mem, "--cpus", String(s.cpus), ...throttle,
    "-v", `${s.volume}:/data`, "-v", `${s.script}:/app/scripts/bench-fold.ts:ro`,
    "-p", `127.0.0.1::${PG_PORT}`, "-p", `127.0.0.1::${CONTROL_PORT}`,
    ...Object.entries(s.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    "--entrypoint", "node", s.image, "/app/scripts/bench-fold.ts", "--inside", ...s.args];
}

export interface PhaseEstimate { name: string; estimateMs: number }
/** the phases that fit `budgetMs` in order, each with `cleanupMs` kept after it; the rest dropped, said */
export function planPhases(budgetMs: number, phases: readonly PhaseEstimate[], cleanupMs = CLEANUP_MS, spentMs = 0): { planned: string[]; dropped: Array<{ phase: string; why: string }>; totalMs: number } {
  const planned: string[] = [], dropped: Array<{ phase: string; why: string }> = [];
  let at = spentMs;
  for (const p of phases) {
    if (at + p.estimateMs + cleanupMs > budgetMs) { dropped.push({ phase: p.name, why: `its ~${Math.round(p.estimateMs / 60_000)} min would end past the ${Math.round(budgetMs / 60_000)} min deadline with ${Math.round(cleanupMs / 60_000)} min kept for cleanup` }); continue; }
    planned.push(p.name); at += p.estimateMs;
  }
  return { planned, dropped, totalMs: at };
}

/** what a `docker` call answered */
export interface DockerResult { code: number; stdout: string; stderr: string }
export type Docker = (args: string[]) => Promise<DockerResult>;
export interface Names { container: string; volume: string; image: string }
export type CleanupReport = Record<keyof Names, "removed" | "not removed" | "kept"> & { ok: boolean };
/** each made thing removed by its EXACT name, then inspected: an inspect that succeeds is "not removed", never done */
export async function removeAll(docker: Docker, n: Names): Promise<CleanupReport> {
  const steps: Array<[keyof Names, string[], string[]]> = [
    ["container", ["rm", "-f", n.container], ["inspect", "--type", "container", n.container]],
    ["volume", ["volume", "rm", "-f", n.volume], ["volume", "inspect", n.volume]],
    ["image", ["rmi", "-f", n.image], ["image", "inspect", n.image]],
  ];
  const report = { ok: true } as CleanupReport;
  for (const [what, rm, inspect] of steps) {
    // a failed rm is read from the inspect after it, which is the verdict: the thing may never have been made
    await docker(rm);
    const still = await docker(inspect);
    report[what] = still.code === 0 ? "not removed" : "removed";
    if (still.code === 0) report.ok = false;
  }
  return report;
}

export interface Signals { once(event: "SIGINT" | "SIGTERM", f: () => void): unknown; removeListener(event: "SIGINT" | "SIGTERM", f: () => void): unknown }
/** `body` run with cleanup on EVERY exit: done, a throw, the deadline, SIGINT/SIGTERM. The body is abandoned on the
 *  deadline or a signal (its container is removed under it, so it fails and stops) */
export async function withCleanup<T>(docker: Docker, names: Names, body: () => Promise<T>, o: { deadlineMs: number; signals?: Signals; keep?: boolean }): Promise<{ value?: T; error?: string; cleanup: CleanupReport }> {
  const signals = o.signals ?? process;
  let onInt = (): void => undefined, onTerm = (): void => undefined, timer: NodeJS.Timeout | undefined;
  const stop = new Promise<never>((_, reject) => {
    onInt = () => reject(new Error("stopped by SIGINT")); onTerm = () => reject(new Error("stopped by SIGTERM"));
    signals.once("SIGINT", onInt); signals.once("SIGTERM", onTerm);
    timer = setTimeout(() => reject(new Error(`the deadline (${Math.round(o.deadlineMs / 60_000)} min) passed`)), o.deadlineMs);
  });
  const out: { value?: T; error?: string } = {};
  try { out.value = await Promise.race([body(), stop]); }
  catch (e) { out.error = e instanceof Error ? e.message : String(e); }
  finally { clearTimeout(timer); signals.removeListener("SIGINT", onInt); signals.removeListener("SIGTERM", onTerm); }
  const cleanup = o.keep === true ? { container: "kept", volume: "kept", image: "kept", ok: true } as CleanupReport : await removeAll(docker, names);
  return { ...out, cleanup };
}

/** the numbers the thresholds read, filled by the phases */
export interface Measures {
  /** phase 4: the fold's p95 batch time beside 4 users, ms, at 6 rows/0.5 s and 60 rows/5 s */
  t1?: { p95At6Ms: number; p95At60Ms: number };
  /** phase 4: the p95 of (batch - its base write) at 60 rows beside statements, ms */
  t2?: { addedP95Ms: number };
  /** the 7-day statements over the generated tables at 4 users: p95 alone (phase 2) and with the fold beside (phase 4, the worse of its two) */
  t3?: { aloneP95Ms: number; togetherP95Ms: number };
  /** phase 1: the whole re-run of both tables, s */
  t4?: { rerunSeconds: number };
  /** phase 5 and every compared unbounded recompute */
  gate?: { ok: boolean; failures: string[] };
}
export interface Check { name: string; pass: boolean; text: string }
export interface Verdict { valid: boolean; invalid?: string; checks: Check[]; against: boolean; liveBuysLittle: boolean | null; text: string }
export function verdictOf(m: Measures, smoke = false): Verdict {
  if (m.gate === undefined || !m.gate.ok) {
    const invalid = m.gate === undefined ? "the correctness gate did not run" : `the correctness gate failed: ${m.gate.failures.join("; ")}`;
    return { valid: false, invalid, checks: [], against: false, liveBuysLittle: null, text: `INVALID: ${invalid}. No verdict.` };
  }
  const checks: Check[] = [];
  if (m.t1 !== undefined) {
    const pass = m.t1.p95At6Ms <= THRESHOLDS.t1Share * 500 && m.t1.p95At60Ms <= THRESHOLDS.t1Share * 5000;
    checks.push({ name: "T1", pass, text: `the fold's p95 batch beside 4 users: ${ms(m.t1.p95At6Ms)} at 6 rows/0.5 s (limit ${ms(THRESHOLDS.t1Share * 500)}), ${ms(m.t1.p95At60Ms)} at 60 rows/5 s (limit ${ms(THRESHOLDS.t1Share * 5000)})` });
  }
  if (m.t2 !== undefined) checks.push({ name: "T2", pass: m.t2.addedP95Ms <= THRESHOLDS.t2AddedMs, text: `the fold's added p95 per 60-row batch: ${ms(m.t2.addedP95Ms)} (limit ${ms(THRESHOLDS.t2AddedMs)})` });
  if (m.t3 !== undefined) {
    const rise = m.t3.aloneP95Ms > 0 ? m.t3.togetherP95Ms / m.t3.aloneP95Ms - 1 : 0;
    checks.push({ name: "T3", pass: m.t3.togetherP95Ms <= THRESHOLDS.t3P95Ms && rise <= THRESHOLDS.t3Rise, text: `the 7-day statements' p95 at 4 users: ${ms(m.t3.aloneP95Ms)} alone, ${ms(m.t3.togetherP95Ms)} with the fold (limit ${ms(THRESHOLDS.t3P95Ms)}, a rise of ${(rise * 100).toFixed(0)} % against at most ${THRESHOLDS.t3Rise * 100} %)` });
  }
  let liveBuysLittle: boolean | null = null;
  if (m.t4 !== undefined) {
    liveBuysLittle = m.t4.rerunSeconds < THRESHOLDS.t4Seconds;
    checks.push({ name: "T4", pass: !liveBuysLittle, text: `the whole re-run of requests and daily_durations: ${ms(m.t4.rerunSeconds * 1000)} (live is needed at ${THRESHOLDS.t4Seconds} s or more)` });
  }
  const missing = ["T1", "T2", "T3"].filter((t) => !checks.some((c) => c.name === t));
  const against = checks.some((c) => c.name !== "T4" && !c.pass);
  const words = [
    smoke ? "SMOKE: a pipeline check at a size that fits memory, not a measurement." : "",
    missing.length > 0 ? `Not measured: ${missing.join(", ")} (dropped), so the verdict is partial.` : "",
    against ? `The numbers ARGUE AGAINST stages 6-11: ${checks.filter((c) => c.name !== "T4" && !c.pass).map((c) => c.name).join(", ")} failed.` : `The numbers do not argue against stages 6-11${missing.length > 0 ? " on what was measured" : ""}.`,
    liveBuysLittle === true ? `But live buys little at this size: a whole re-run takes ${ms(m.t4!.rerunSeconds * 1000)}, under ${THRESHOLDS.t4Seconds} s, so a scheduled table with target_lag 1m covers the dashboards.` :
      liveBuysLittle === false ? `A whole re-run takes ${ms(m.t4!.rerunSeconds * 1000)}, so a scheduled table cannot keep a dashboard within a minute at this size: live is needed.` : "",
  ].filter((x) => x !== "");
  return { valid: true, checks, against, liveBuysLittle, text: words.join(" ") };
}

export const gib = (b: number): string => `${(b / GIB).toFixed(2)} GiB`;
export const mrows = (n: number): string => `${(n / 1e6).toFixed(2)} M rows`;
export const ms = (t: number): string => t >= 1000 ? `${(t / 1000).toFixed(2)} s` : `${Math.round(t)} ms`;

export interface Stats { n: number; p50: number; p95: number; max: number; under3s?: number }
export function stats(xs: readonly number[]): Stats {
  if (xs.length === 0) return { n: 0, p50: 0, p95: 0, max: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number): number => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]!;
  return { n: s.length, p50: at(0.5), p95: at(0.95), max: s[s.length - 1]! };
}
export const latencyStats = (xs: readonly number[]): Stats => ({ ...stats(xs), under3s: xs.length === 0 ? 0 : xs.filter((x) => x < 3000).length / xs.length });

export interface PhaseRecord {
  seconds: number;
  /** the container's cgroup over the phase: disk bytes read and written (io.stat), page cache and anon at its end, peak */
  io: { readBytes: number | null; writeBytes: number | null };
  memory: { fileBytes: number | null; anonBytes: number | null; peakBytes: number | null };
  cpu: { throttledUsec: number | null; nrThrottled: number | null };
  volumeBytes: number; spillBytes: number;
  hostLoad?: number[];
  [k: string]: unknown;
}
export interface Result {
  smoke: boolean; startedAt: string; finishedAt?: string;
  environment: Record<string, unknown>;
  sizes?: Record<string, number>;
  tenants?: { top: number; median: number; topShare: number };
  phases: Record<string, PhaseRecord>;
  measures: Measures;
  dropped: Array<{ phase: string; why: string }>;
  errors: string[];
  cleanup?: CleanupReport;
}

const statRow = (name: string, s: Stats): string => `| ${name} | ${s.n} | ${ms(s.p50)} | ${ms(s.p95)} | ${ms(s.max)} | ${s.under3s === undefined ? "" : `${(s.under3s * 100).toFixed(1)} %`} |`;
/** the report, in markdown for the PR body and DESIGN: sizes in GiB and M rows, times in ms/s, each phase's disk reads */
export function renderReport(r: Result): string {
  const v = verdictOf(r.measures, r.smoke);
  const out: string[] = [`## The stored fold, larger than memory${r.smoke ? " (SMOKE)" : ""}`, "", `**Verdict:** ${v.text}`, ""];
  if (v.valid) out.push("| threshold | verdict | numbers |", "|---|---|---|", ...v.checks.map((c) => `| ${c.name} | ${c.pass ? "pass" : c.name === "T4" ? "live buys little" : "FAIL"} | ${c.text} |`), "");
  const e = r.environment as Record<string, unknown>;
  out.push("### Setup", "", `- container: ${typeof e.memoryBytes === "number" ? gib(e.memoryBytes) : "?"} memory, no swap, ${String(e.cpus ?? "?")} CPUs; the store's memory limit ${typeof e.storeMemoryLimitBytes === "number" ? gib(e.storeMemoryLimitBytes) : "?"} (Mason's default); spill limit ${String(e.spillLimit ?? "?")}`,
    `- disk: ${String(e.throttle ?? "?")}; cold read rate measured ${typeof e.coldReadBytesPerSecond === "number" ? `${(e.coldReadBytesPerSecond / 1e6).toFixed(0)} MB/s` : "?"}`);
  if (r.sizes !== undefined) {
    const s = r.sizes;
    out.push(`- data: ${mrows(s.rows ?? 0)}, a ${gib(s.fileBytes ?? 0)} file (${((s.fileBytes ?? 0) / (Number(e.memoryBytes) || 1)).toFixed(1)}x the container's memory); key columns the fold reads ${gib(s.keyColumnBytes ?? 0)}, payload ${gib(s.payloadBytes ?? 0)}; requests ${mrows(s.requestsRows ?? 0)} (${gib(s.requestsBytes ?? 0)}), daily_durations ${mrows(s.dailyRows ?? 0)} (${gib(s.dailyBytes ?? 0)})`);
  }
  if (r.tenants !== undefined) out.push(`- tenants: the largest holds ${(r.tenants.topShare * 100).toFixed(1)} % of the rows; the median tenant is picked from the data`);
  out.push("", "### Phases", "", "| phase | time | disk read | disk written | page cache at end | anon at end | peak | CPU throttled | host load |", "|---|---|---|---|---|---|---|---|---|");
  const g = (b: number | null): string => b === null ? "n/a" : gib(b);
  for (const [name, p] of Object.entries(r.phases)) out.push(`| ${name} | ${ms(p.seconds * 1000)} | ${g(p.io.readBytes)} | ${g(p.io.writeBytes)} | ${g(p.memory.fileBytes)} | ${g(p.memory.anonBytes)} | ${g(p.memory.peakBytes)} | ${p.cpu.throttledUsec === null ? "n/a" : ms(p.cpu.throttledUsec / 1000)} | ${(p.hostLoad ?? []).map((x) => x.toFixed(1)).join(" / ")} |`);
  const tables = (title: string, rows: Record<string, Stats> | undefined): void => {
    if (rows === undefined) return;
    out.push("", `#### ${title}`, "", "| what | n | p50 | p95 | max | under 3 s |", "|---|---|---|---|---|---|", ...Object.entries(rows).map(([k, s]) => statRow(k, s)));
  };
  out.push("", "### Detail");
  for (const [name, p] of Object.entries(r.phases)) for (const [k, val] of Object.entries(p)) if (k.endsWith("Stats")) tables(`${name}: ${k.replace(/Stats$/, "")}`, val as Record<string, Stats>);
  if (r.dropped.length > 0) out.push("", "### Dropped", "", ...r.dropped.map((d) => `- ${d.phase}: ${d.why}`));
  if (r.errors.length > 0) out.push("", "### Errors", "", ...r.errors.map((x) => `- ${x}`));
  if (r.cleanup !== undefined) out.push("", "### Cleanup", "", `container ${r.cleanup.container}, volume ${r.cleanup.volume}, image ${r.cleanup.image}${r.cleanup.ok ? "" : " — CLEANUP NOT VERIFIED: remove them by hand"}`);
  return out.join("\n") + "\n";
}

// ───────────────────────────── the data: generated by the engine, registered as a copied table ─────────────────────────────

const ident = (s: string): string => `"${s.replaceAll('"', '""')}"`;
const lit = (v: string | number | null): string => v === null ? "NULL" : typeof v === "number" ? String(v) : `'${v.replaceAll("'", "''")}'`;

export const EVENT_COLUMNS = [["id", "bigint", true], ["tenant_id", "integer", true], ["request_key", "bigint", false], ["kind", "text", true], ["status", "text", false], ["code", "integer", false],
  ["started_at", "timestamp with time zone", true], ["finished_at", "timestamp with time zone", false], ["payload", "jsonb", false]] as const;
const COLS = EVENT_COLUMNS.map(([n]) => n);
export const EVENTS: AddedTable = { source: "public.events", schema: "public", table: "events", key: ["id"], foreignKeys: [], bytes: 0, rows: 0, sync: { mode: "off" },
  columns: EVENT_COLUMNS.map(([name, type, notNull]) => ({ name, type, notNull, comment: null })) };
export const EVENTS_DDL = "CREATE TABLE public.events (id BIGINT, tenant_id INTEGER NOT NULL, request_key BIGINT, kind VARCHAR NOT NULL, status VARCHAR, code INTEGER, started_at TIMESTAMPTZ NOT NULL, finished_at TIMESTAMPTZ, payload JSON)";
export const END_DAY = "2026-03-31";
export const DAYS = 90;
export const PAYLOAD_KEYS = 40;

/** one day's rows, ids [first, first + n), heap order = started_at rising. Groups of up to 4 rows a few minutes apart
 *  share a request_key (20 % NULL), a tenant (Zipf: tenant 1 ~8 %) and a kind */
export function daySql(day: string, first: number, n: number, seed = SEED, keys = PAYLOAD_KEYS): string {
  const s = Math.max(1, Math.round(n * 3 / 1440));
  const h = (x: string, k: number): string => `hash(${x}, ${seed}, ${k})`;
  const payload = `json_object('source', ['web', 'api', 'sdk', 'job'][(1 + ${h("i", 7)} % 4)::INTEGER], ${Array.from({ length: keys }, (_, k) => `'h${String(k).padStart(2, "0")}', md5(i::VARCHAR || ':${k}:${seed}')`).join(", ")})`;
  return `INSERT INTO public.events SELECT i, 1 + least(499, floor(500 * pow((${h("g", 1)} % 1000003)::DOUBLE / 1000003, 2.46)))::INTEGER, ` +
    `CASE WHEN ${h("i", 3)} % 100 < 20 THEN NULL ELSE 1000000000 + g END, ` +
    `CASE WHEN ${h("g", 2)} % 100 < 80 THEN 'query' WHEN ${h("g", 2)} % 100 < 95 THEN 'load' ELSE 'other' END, ` +
    `CASE WHEN sv < 85 THEN 'ok' WHEN sv < 93 THEN 'failed' WHEN sv < 97 THEN 'timeout' END, ` +
    `CASE WHEN sv < 85 THEN 200 WHEN sv < 89 THEN 400 WHEN sv < 93 THEN 500 END, started, ` +
    `CASE WHEN ${h("i", 5)} % 100 < 2 THEN NULL ELSE started + to_milliseconds((10 + ${h("i", 6)} % 29990)::BIGINT) END, ${payload} ` +
    `FROM (SELECT i, (i // ${4 * s}) * ${s} + (i % ${s}) AS g, (${h("i", 4)} % 100)::INTEGER AS sv, ` +
    `TIMESTAMPTZ '${day} 00:00:00+00' + to_milliseconds(((i - ${first}) * 86400000 // ${n})::BIGINT) AS started FROM range(${first}, ${first + n}) t(i))`;
}
const dayOf = (k: number): string => new Date(Date.parse(`${END_DAY}T00:00:00Z`) - (DAYS - k) * 86_400_000).toISOString().slice(0, 10);

/** the base, appended a day at a time: a row count (the test world), or until the file reaches `targetBytes`, rows a day
 *  recalibrated from the bytes a row took so far (ZSTD makes it unknowable beforehand) */
export async function generate(w: DuckConnection, file: string, o: { rows?: number; targetBytes?: number }, log: (l: string) => void): Promise<{ rows: number }> {
  let id = 1, perDay = o.rows !== undefined ? Math.max(1, Math.round(o.rows / DAYS)) : Math.max(1000, Math.round(o.targetBytes! / DAYS / 900));
  for (let d = 0; d < DAYS; d++) {
    await w.run(daySql(dayOf(d), id, perDay));
    id += perDay;
    if (o.targetBytes !== undefined && (d === 0 || d % 10 === 9)) {
      await w.run("CHECKPOINT");
      const bytes = fs.statSync(file).size, perRow = bytes / (id - 1);
      perDay = Math.max(1000, Math.round(Math.max(0, o.targetBytes - bytes) / Math.max(1, DAYS - d - 1) / perRow));
      log(`generate: day ${d + 1}/${DAYS}, ${mrows(id - 1)}, ${gib(bytes)}, ${Math.round(perRow)} B a row, next ${perDay} rows a day`);
    }
  }
  await w.run("CHECKPOINT");
  return { rows: id - 1 };
}

// ───────────────────────────── the world: the real store, sync, listener and generated tables ─────────────────────────────

const source = { url: "postgresql://x@127.0.0.1:1/x", remote: false, host: "127.0.0.1", port: 1, database: "x", user: "x", password: "", sslmode: "disable" } as unknown as Source;
export interface World { dir: string; store: DuckStore; sync: Sync; api: PgApiServer; apiKey: string; logged: string[]; rows: number; token(seconds: number): string; close(): Promise<void> }
/** as tests/duck-generated-world.ts makes its world: a Sync opened once to make `_mason`, the base made and registered as
 *  a copied table (copy_state 'copied', poll_state sync 'off'), then the Sync, the listener and the generated tables */
export async function openWorld(o: { dir: string; memoryLimit?: string; spillLimit?: string; rows?: number; targetBytes?: number; host: string; port: number; log: (l: string) => void }): Promise<World> {
  const file = path.join(o.dir, "duck.db"), folder = path.join(o.dir, "mason");
  fs.mkdirSync(path.join(folder, GENERATED_DIR), { recursive: true });
  const store = await DuckStore.open(file, o.log, { ...(o.memoryLimit === undefined ? {} : { memoryLimit: o.memoryLimit }), ...(o.spillLimit === undefined ? {} : { spillLimit: o.spillLimit }) });
  const logged: string[] = [];
  const open = async (): Promise<Sync> => { const s = new Sync(store, source, "app", (l) => { logged.push(l); o.log(l); }, 3_600_000, "poll", null, { generated: { reviewMs: 0 } }); await s.open(); return s; };
  await (await open()).stop();
  await store.writer.run("CREATE SCHEMA IF NOT EXISTS public");
  await store.writer.run(EVENTS_DDL);
  const { rows } = await generate(store.writer, file, { ...(o.rows === undefined ? {} : { rows: o.rows }), ...(o.targetBytes === undefined ? {} : { targetBytes: o.targetBytes }) }, o.log);
  await store.writer.run(`INSERT INTO ${MASON_SCHEMA}.copy_state VALUES ('public.events', 'copied', ${rows}, 0, 1.0, now(), NULL, ${lit(JSON.stringify(EVENTS.columns))})`);
  await store.writer.run(`INSERT INTO ${MASON_SCHEMA}.poll_state (source, snapshot, polled_at, sync) VALUES ('public.events', '100:100:', now(), 'off')`);
  const sync = await open();
  await sync.setTables([{ ...EVENTS, rows }]);
  const apiKey = crypto.randomBytes(API_KEY_BYTES).toString("hex");
  const api = await startPostgresApi({
    port: o.port, host: o.host, tls: null, database: "app", masonVersion: "bench-fold", product: "mason-data",
    authenticate: (password) => { const p = tokenProblem(apiKey, password); if (p !== null) throw new Error(p); return { filters: [], subject: undefined }; },
    schema: () => sync.schema(), record: () => undefined, log: () => undefined,
    duck: await store.listener(undefined, undefined, undefined, () => [...sync.state(), ...sync.generated.copies()], sync.kept),
  });
  return { dir: o.dir, store, sync, api, apiKey, logged, rows, token: (s) => mintToken(apiKey, s).token,
    close: async () => { await sync.generated.stop(); await api.close(); await sync.stop(); await store.close(); } };
}

/** phase 1: the generated tables built by the REAL stage-1 code, waited for until SERVED (its log line after the catalog's
 *  rebuild, #205), never merely built */
export async function buildGenerated(w: World, boundMs: number): Promise<{ seconds: number; statuses: GeneratedStatus[] }> {
  const folder = path.join(w.dir, "mason");
  for (const [name, text] of Object.entries(GENERATED_FILES)) fs.writeFileSync(path.join(folder, GENERATED_DIR, `${name}.yml`), text);
  const t0 = performance.now(), from = w.logged.length;
  await w.sync.generated.start(() => readGenerated(folder, w.dir), w.api.planner());
  const end = Date.now() + boundMs;
  for (;;) {
    await w.sync.generated.review();
    const all = w.sync.generated.status();
    const failed = all.find((s) => s.state === "failed");
    if (failed !== undefined) throw new Error(`generated ${failed.table} failed: ${JSON.stringify(failed)}`);
    const served = ["public.requests", "public.daily_durations"].every((t) => { const s = all.find((x) => x.table === t); return s !== undefined && s.serving && w.logged.slice(from).some((l) => l.startsWith(`generated ${t}:`)); });
    if (served) return { seconds: (performance.now() - t0) / 1000, statuses: all };
    if (Date.now() > end) throw new Error(`the generated tables were not served within ${ms(boundMs)}: ${JSON.stringify(all)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ───────────────────────────── the batches ─────────────────────────────

export interface EventRow { id: number; tenant_id: number; request_key: number | null; kind: string; status: string | null; code: number | null; started_at: string; finished_at: string | null; payload: string | null }
export type Change = { op: "upsert"; row: EventRow } | { op: "delete"; id: number };
/** folded by key, as a stream batch is: each id's final row, or null where its last change deleted it */
export function foldByKey(changes: readonly Change[]): Map<number, EventRow | null> {
  const out = new Map<number, EventRow | null>();
  for (const c of changes) if (c.op === "upsert") out.set(c.row.id, c.row); else out.set(c.id, null);
  return out;
}
const rowValues = (r: EventRow): string => `(${[r.id, r.tenant_id, r.request_key, r.kind, r.status, r.code, r.started_at, r.finished_at, r.payload].map(lit).join(", ")})`;
/** a time as the batches write it and DuckDB reads it: UTC, milliseconds only where there are some */
export const iso = (msEpoch: number): string => new Date(msEpoch).toISOString().replace("T", " ").replace(".000Z", "+00").replace("Z", "+00");
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function makePayload(rnd: () => number, keys = PAYLOAD_KEYS): string {
  const o: Record<string, string> = { source: ["web", "api", "sdk", "job"][Math.floor(rnd() * 4)]! };
  for (let k = 0; k < keys; k++) o[`h${String(k).padStart(2, "0")}`] = crypto.createHash("md5").update(`${rnd()}`).digest("hex");
  return JSON.stringify(o);
}
export const MIX = [["new", 0.60], ["finish", 0.25], ["retry", 0.08], ["group", 0.02], ["leave", 0.02], ["delete", 0.02], ["late", 0.01]] as const;
const SELECT_ROW = "SELECT id, tenant_id, request_key, kind, status, code, epoch_ms(started_at), epoch_ms(finished_at), payload::VARCHAR FROM public.events";
const toRow = (r: unknown[]): EventRow => ({ id: Number(r[0]), tenant_id: Number(r[1]), request_key: r[2] === null ? null : Number(r[2]), kind: String(r[3]), status: r[4] as string | null, code: r[5] === null ? null : Number(r[5]),
  started_at: iso(Number(r[6])), finished_at: r[7] === null ? null : iso(Number(r[7])), payload: r[8] as string | null });
/** batches of the issue's mix, seeded, drawn from pools read from the base before each phase (outside every timing).
 *  `outside`: every row a batch touches is outside the definition's WHERE (kind <> 'query'), before and after: the base
 *  write alone (today's writer, the baseline) has the same shape and cost, and leaves the stored tables equal to their
 *  definitions, so the correctness gate still holds after it */
export class Batches {
  private readonly rnd: () => number;
  private clock = 0; private nextId = 0; private nextKey = 0;
  private unfinished: EventRow[] = []; private recent: EventRow[] = []; private older: EventRow[] = [];
  private readonly c: DuckConnection; private readonly keys: number; private readonly outside: boolean;
  constructor(c: DuckConnection, seed = SEED, o: { keys?: number; outside?: boolean } = {}) { this.c = c; this.keys = o.keys ?? PAYLOAD_KEYS; this.outside = o.outside === true; this.rnd = mulberry32(seed); }
  async refill(): Promise<void> {
    const one = async (sql: string): Promise<unknown[]> => (await this.c.runAndReadAll(sql)).getRowsJS()[0]!;
    const [newest, maxId, maxKey] = await one("SELECT epoch_ms(max(started_at)), max(id), max(request_key) FROM public.events");
    this.clock = Math.max(this.clock, Number(newest)); this.nextId = Math.max(this.nextId, Number(maxId) + 1); this.nextKey = Math.max(this.nextKey, Number(maxKey ?? 0) + 1);
    const rows = async (where: string, limit: number): Promise<EventRow[]> => (await this.c.runAndReadAll(`${SELECT_ROW} WHERE ${where} ORDER BY id DESC LIMIT ${limit}`)).getRowsJS().map(toRow);
    const t = (days: number): string => `TIMESTAMPTZ '${iso(this.clock - days * 86_400_000)}'`;
    const kind = this.outside ? "kind <> 'query'" : "kind = 'query'";
    this.unfinished = await rows(`finished_at IS NULL AND ${kind} AND started_at >= ${t(10)}`, 5000);
    this.recent = await rows(`${kind} AND started_at >= ${t(1)}`, 20000);
    this.older = await rows(`${kind} AND request_key IS NOT NULL AND started_at >= ${t(15)} AND started_at < ${t(5)}`, 5000);
  }
  private pick(pool: EventRow[]): EventRow | undefined { if (pool.length === 0) return undefined; const i = Math.floor(this.rnd() * pool.length); const [r] = pool.splice(i, 1); return r; }
  private fresh(over: Partial<EventRow> = {}): EventRow {
    this.clock += 1 + Math.floor(this.rnd() * 50);
    const u = this.rnd(), v = this.rnd() * 100;
    const row: EventRow = { id: this.nextId++, tenant_id: 1 + Math.min(499, Math.floor(500 * Math.pow(u, 2.46))), request_key: this.rnd() < 0.2 ? null : 1_000_000_000 + this.nextKey++,
      kind: this.outside ? "other" : v < 80 ? "query" : v < 95 ? "load" : "other", status: null, code: null, started_at: iso(this.clock), finished_at: null, payload: makePayload(this.rnd, this.keys), ...over };
    if (this.rnd() > 0.3 && over.finished_at === undefined) { row.finished_at = iso(this.clock + 10 + Math.floor(this.rnd() * 29990)); row.status = "ok"; row.code = 200; }
    this.recent.push(row); if (row.finished_at === null) this.unfinished.push(row);
    return row;
  }
  next(size: number): Change[] {
    const out: Change[] = [];
    for (let k = 0; k < size; k++) {
      let x = this.rnd(), op: string = "new";
      for (const [name, share] of MIX) { if (x < share) { op = name; break; } x -= share; }
      const base = op === "finish" ? this.pick(this.unfinished) : op === "late" ? this.pick(this.older) : op === "new" ? undefined : this.pick(this.recent);
      if (op === "new" || base === undefined) { out.push({ op: "upsert", row: this.fresh() }); continue; }
      switch (op) {
        case "finish": out.push({ op: "upsert", row: { ...base, finished_at: iso(Date.parse(base.started_at.replace(" ", "T").replace("+00", "Z")) + 10 + Math.floor(this.rnd() * 29990)), status: "ok", code: 200 } }); break;
        case "retry": out.push({ op: "upsert", row: this.fresh({ tenant_id: base.tenant_id, request_key: base.request_key ?? base.id, kind: this.outside ? "other" : "query" }) }); this.recent.push(base); break;
        case "group": out.push({ op: "upsert", row: { ...base, request_key: 1_000_000_000 + this.nextKey++ } }); break;
        case "leave": out.push({ op: "upsert", row: { ...base, kind: this.outside ? (base.kind === "load" ? "other" : "load") : "load" } }); break;
        case "delete": out.push({ op: "delete", id: base.id }); break;
        case "late": out.push({ op: "upsert", row: { ...this.fresh({ tenant_id: base.tenant_id, request_key: base.request_key, kind: this.outside ? "other" : "query" }), started_at: iso(Date.parse(base.started_at.replace(" ", "T").replace("+00", "Z")) - 60_000), finished_at: base.started_at } }); this.clock -= 1; break;
      }
    }
    return out;
  }
}

// ───────────────────────────── the fold: issue 124's steps 1-7 on ONE connection, ONE transaction a batch ─────────────────────────────

export interface BatchTiming { total: number; base: number; s1?: number; s2?: number; s3?: number; s4?: number; s5?: number; s6?: number; s7?: number; unbounded?: number; equal?: boolean; rows: number }
export interface FoldOptions { fold: boolean; withPayload?: boolean; compareUnbounded?: boolean; mutate?: "bound-new-only" | "bound-stored-only" | "skip-step4" | "skip-cascade" }
const SCOPE_EVENTS = "bench_fold_scope_events";
const SCOPE_REQUESTS = "bench_fold_scope_requests";
const output = (d: DefinitionPlan): { cols: string; select: (sql: string) => string } => {
  const aliases = d.columns.map((_, i) => `__mason_c${i}`);
  return { cols: d.columns.map((c) => ident(c.name)).join(", "),
    // as src/duck/generated.ts writes a run's rows: each column cast to the type it is stored as
    select: (sql) => `SELECT ${d.columns.map((c, i) => `${c.duck === null ? aliases[i]! : `CAST(${aliases[i]} AS ${c.duck})`} AS ${ident(c.name)}`).join(", ")} FROM (${sql}) AS __mason_output(${aliases.join(", ")})` };
};
async function plan(p: Planner, sql: string, relations?: ReadonlyMap<string, string>): Promise<DefinitionPlan> {
  const r = await planDefinition(p, sql, null, relations);
  if ("refused" in r) throw new Error(`the planner refused ${sql.slice(0, 60)}…: ${r.refused.map((x) => x.message).join("; ")}`);
  if (r.definition.numerics.length > 0 || r.definition.plan.clock !== undefined) throw new Error("a definition with a computed numeric or a clock: not this bench's shape");
  return r.definition;
}

export class Fold {
  readonly conn: DuckConnection; private readonly kept: Sync["kept"];
  readonly plans: { requests: DefinitionPlan; daily: DefinitionPlan; requestsWhole: DefinitionPlan; dailyWhole: DefinitionPlan };
  readonly reads: { events: string[]; requests: string[] };
  private constructor(conn: DuckConnection, kept: Sync["kept"], plans: Fold["plans"], reads: Fold["reads"]) { this.conn = conn; this.kept = kept; this.plans = plans; this.reads = reads; }
  /** the fold's connection, set up by the one set-up (src/duck/store.ts SessionSetup: the session variable every Mason
   *  function reads, the null order, UTC), never by hand; the recomputes planned by the PLANNER over the swapped relation */
  static async open(w: World): Promise<Fold> {
    const c = await w.store.instance.connect();
    await SessionSetup.open(c, "bench_fold");
    const planner = w.api.planner();
    const requestsWhole = await plan(planner, REQUESTS_SQL), dailyWhole = await plan(planner, DAILY_SQL);
    // the columns each definition reads, as Postgres's analysis says (DuckPlan.reads), never a list written here
    const readsOf = (d: DefinitionPlan, table: string): string[] => { const r = (d.plan.reads ?? []).find((x) => x.table === table); if (r === undefined) throw new Error(`the plan reads no ${table}`); return r.columns; };
    const reads = { events: readsOf(requestsWhole, "public.events"), requests: readsOf(dailyWhole, "public.requests") };
    // the swapped relations: TEMP tables of this connection, made once and refilled each batch (no DDL a batch). The planned
    // SQL names them bare, and DuckDB looks in the temp catalog before the search path
    await c.run(`CREATE OR REPLACE TEMP TABLE ${SCOPE_EVENTS} AS SELECT ${reads.events.map(ident).join(", ")} FROM public.events LIMIT 0`);
    await c.run(`CREATE OR REPLACE TEMP TABLE ${SCOPE_REQUESTS} AS SELECT ${reads.requests.map(ident).join(", ")} FROM public.requests LIMIT 0`);
    const requests = await plan(planner, REQUESTS_SQL, new Map([["public.events", SCOPE_EVENTS]]));
    const daily = await plan(planner, DAILY_SQL, new Map([["public.requests", SCOPE_REQUESTS]]));
    return new Fold(c, w.sync.kept, { requests, daily, requestsWhole, dailyWhole }, reads);
  }

  /** the base write of today's writer: src/duck/sync.ts writeByKey and deleteKeys (not exported, so repeated here): a TEMP
   *  rows table, a TEMP keys table, ONE join delete by key, ONE insert, with the stored JSON paths' values */
  private async baseWrite(gone: readonly number[], whole: readonly EventRow[]): Promise<void> {
    const c = this.conn, list = COLS.map(ident).join(", ");
    if (whole.length > 0) {
      await c.run(`CREATE OR REPLACE TEMP TABLE __mason_write_rows AS SELECT ${list} FROM public.events LIMIT 0`);
      for (let i = 0; i < whole.length; i += 500) await c.run(`INSERT INTO __mason_write_rows VALUES ${whole.slice(i, i + 500).map(rowValues).join(", ")}`);
    }
    await c.run("CREATE OR REPLACE TEMP TABLE __mason_write_keys AS SELECT id FROM public.events LIMIT 0");
    for (let i = 0; i < gone.length; i += 500) await c.run(`INSERT INTO __mason_write_keys VALUES ${gone.slice(i, i + 500).map((k) => `(${k})`).join(", ")}`);
    if (whole.length > 0) await c.run("INSERT INTO __mason_write_keys SELECT id FROM __mason_write_rows");
    await c.run("DELETE FROM public.events AS t USING __mason_write_keys AS k WHERE t.id = k.id");
    await c.run("DROP TABLE __mason_write_keys");
    if (whole.length > 0) {
      const stored = this.kept.stored("public.events", ident);
      await c.run(`INSERT INTO public.events (${[list, ...stored.names.map(ident)].join(", ")}) SELECT ${[list, ...stored.values].join(", ")} FROM __mason_write_rows`);
      await c.run("DROP TABLE __mason_write_rows");
    }
  }

  /** ONE batch, in ONE transaction: the base write alone (today), or the base write with steps 1-7 */
  async batch(changes: readonly Change[], o: FoldOptions): Promise<BatchTiming> {
    const folded = foldByKey(changes);
    if (folded.size === 0) return { total: 0, base: 0, rows: 0 };
    const gone = [...folded].filter(([, r]) => r === null).map(([id]) => id), whole = [...folded.values()].filter((r): r is EventRow => r !== null);
    const c = this.conn, t: BatchTiming = { total: 0, base: 0, rows: folded.size };
    let at = performance.now();
    const lap = (): number => { const now = performance.now(), d = now - at; at = now; return d; };
    const t0 = at;
    let unboundedMs = 0;
    await c.run("BEGIN TRANSACTION");
    try {
      if (!o.fold) { await this.baseWrite(gone, whole); t.base = lap(); }
      else {
        const evCols = this.reads.events.map(ident).join(", ");
        // step 1: rowid and the columns the definition reads, by the batch's whole key set
        await c.run(`CREATE OR REPLACE TEMP TABLE __fold_keys AS SELECT * FROM (VALUES ${[...folded.keys()].map((k) => `(${k}::BIGINT)`).join(", ")}) v(id)`);
        await c.run(`CREATE OR REPLACE TEMP TABLE __fold_old AS SELECT e.rowid AS rid, ${this.reads.events.map((x) => `e.${ident(x)}`).join(", ")}${o.withPayload === true ? ", e.payload" : ""} FROM public.events e SEMI JOIN __fold_keys k ON e.id = k.id`);
        t.s1 = lap();
        // step 2: the base write, then the new rows read back by the same keys
        await this.baseWrite(gone, whole); t.base = lap();
        await c.run(`CREATE OR REPLACE TEMP TABLE __fold_new AS SELECT ${evCols} FROM public.events e SEMI JOIN __fold_keys k ON e.id = k.id`);
        t.s2 = lap();
        // step 3: the touched groups of old and new rows, into the ledger
        await c.run("CREATE OR REPLACE TEMP TABLE __fold_ledger AS SELECT DISTINCT tenant_id, coalesce(request_key, id) AS key FROM (SELECT tenant_id, request_key, id FROM __fold_old UNION ALL SELECT tenant_id, request_key, id FROM __fold_new)");
        t.s3 = lap();
        // step 4: the touched groups' stored rows found by one scan, then deleted; the bound
        await c.run("CREATE OR REPLACE TEMP TABLE __fold_req_old AS SELECT r.* FROM public.requests r SEMI JOIN __fold_ledger l ON r.tenant_id = l.tenant_id AND r.key = l.key");
        if (o.mutate !== "skip-step4") await c.run("DELETE FROM public.requests AS r USING __fold_req_old AS o WHERE r.tenant_id = o.tenant_id AND r.key = o.key");
        const parts = o.mutate === "bound-new-only" ? ["(SELECT min(started_at) FROM __fold_new)"] : o.mutate === "bound-stored-only" ? ["(SELECT min(first_at) FROM __fold_req_old)"] :
          ["(SELECT min(first_at) FROM __fold_req_old)", "(SELECT min(started_at) FROM __fold_old)", "(SELECT min(started_at) FROM __fold_new)"];
        const bound = (await c.runAndReadAll(`SELECT least(${parts.join(", ")})::VARCHAR`)).getRowsJS()[0]![0] as string | null;
        t.s4 = lap();
        // step 5: the recompute: the PLANNER's SQL over a relation of the touched groups' base rows, the columns it reads, from the bound
        const req = output(this.plans.requests);
        const scope = async (where: string): Promise<void> => { await c.run(`DELETE FROM ${SCOPE_EVENTS}`); await c.run(`INSERT INTO ${SCOPE_EVENTS} SELECT ${this.reads.events.map((x) => `e.${ident(x)}`).join(", ")} FROM public.events e SEMI JOIN __fold_ledger l ON e.tenant_id = l.tenant_id AND coalesce(e.request_key, e.id) = l.key${where}`); };
        if (o.compareUnbounded === true) {
          const u0 = performance.now();
          await scope("");
          await c.run(`CREATE OR REPLACE TEMP TABLE __fold_req_unbounded AS ${req.select(this.plans.requests.plan.sql.text)}`);
          unboundedMs = performance.now() - u0; t.unbounded = unboundedMs; at += unboundedMs;
        }
        await scope(bound === null ? " WHERE false" : ` WHERE e.started_at >= ${lit(bound)}::TIMESTAMPTZ`);
        await c.run(`CREATE OR REPLACE TEMP TABLE __fold_req_new AS ${req.select(this.plans.requests.plan.sql.text)}`);
        await c.run(`INSERT INTO public.requests (${req.cols}) SELECT * FROM __fold_req_new`);
        t.s5 = lap();
        if (o.compareUnbounded === true) {
          const e0 = performance.now();
          const [a, b] = (await c.runAndReadAll("SELECT (SELECT count(*) FROM (SELECT * FROM __fold_req_new EXCEPT ALL SELECT * FROM __fold_req_unbounded)), (SELECT count(*) FROM (SELECT * FROM __fold_req_unbounded EXCEPT ALL SELECT * FROM __fold_req_new))")).getRowsJS()[0]!;
          t.equal = Number(a) === 0 && Number(b) === 0;
          at += performance.now() - e0;
        }
        // step 6: the ledger's rows consumed
        await c.run("DROP TABLE __fold_ledger");
        t.s6 = lap();
        // step 7: the cascade into daily_durations, from the (tenant_id, day) groups of the requests rows deleted and inserted
        if (o.mutate !== "skip-cascade") {
          const day = (x: string): string => `date_trunc('day', timezone('UTC', ${x}))`;
          await c.run(`CREATE OR REPLACE TEMP TABLE __fold_days AS SELECT DISTINCT tenant_id, ${day("first_at")} AS day FROM (SELECT tenant_id, first_at FROM __fold_req_old UNION ALL SELECT tenant_id, first_at FROM __fold_req_new)`);
          await c.run("DELETE FROM public.daily_durations AS d USING __fold_days AS x WHERE d.tenant_id = x.tenant_id AND d.day = x.day");
          await c.run(`DELETE FROM ${SCOPE_REQUESTS}`);
          await c.run(`INSERT INTO ${SCOPE_REQUESTS} SELECT ${this.reads.requests.map((x) => `r.${ident(x)}`).join(", ")} FROM public.requests r SEMI JOIN __fold_days x ON r.tenant_id = x.tenant_id AND ${day("r.first_at")} = x.day`);
          const daily = output(this.plans.daily);
          await c.run(`INSERT INTO public.daily_durations (${daily.cols}) ${daily.select(this.plans.daily.plan.sql.text)}`);
        }
        t.s7 = lap();
      }
      await c.run("COMMIT");
    } catch (e) {
      await c.run("ROLLBACK").catch((r: unknown) => { throw new Error(`${e instanceof Error ? e.message : String(e)}; and its ROLLBACK failed: ${r instanceof Error ? r.message : String(r)}`); });
      throw e;
    }
    t.total = performance.now() - t0 - unboundedMs;
    return t;
  }

  /** the correctness gate: each stored table EXCEPT ALL its definition run whole, both ways, empty */
  async gate(): Promise<{ ok: boolean; failures: string[]; requestsRows: number; dailyRows: number }> {
    const failures: string[] = [];
    const one = async (table: string, d: DefinitionPlan): Promise<number> => {
      const o = output(d);
      await this.conn.run(`CREATE OR REPLACE TEMP TABLE __gate AS ${o.select(d.plan.sql.text)}`);
      const [a, b, n] = (await this.conn.runAndReadAll(`SELECT (SELECT count(*) FROM (SELECT ${o.cols} FROM ${table} EXCEPT ALL SELECT * FROM __gate)), (SELECT count(*) FROM (SELECT * FROM __gate EXCEPT ALL SELECT ${o.cols} FROM ${table})), (SELECT count(*) FROM ${table})`)).getRowsJS()[0]!;
      if (Number(a) !== 0 || Number(b) !== 0) failures.push(`${table}: ${Number(a)} stored rows not in its definition, ${Number(b)} rows of its definition not stored`);
      await this.conn.run("DROP TABLE __gate");
      return Number(n);
    };
    const requestsRows = await one("public.requests", this.plans.requestsWhole);
    const dailyRows = await one("public.daily_durations", this.plans.dailyWhole);
    return { ok: failures.length === 0, failures, requestsRows, dailyRows };
  }
}

/** batches at a fixed interval (0: back to back), `count` of them or until `durationMs`; a batch that outlasts its interval
 *  is backlog: the lag it leaves is recorded, and a lag that grows is a writer that cannot keep up */
export async function runBatches(f: Fold, gen: Batches, o: { size: number; intervalMs: number; count?: number; durationMs?: number } & FoldOptions): Promise<{ timings: BatchTiming[]; late: number; maxLagMs: number; lastLagMs: number }> {
  const timings: BatchTiming[] = [];
  const t0 = performance.now();
  let late = 0, maxLag = 0, lastLag = 0;
  for (let k = 0; ; k++) {
    if (o.count !== undefined && k >= o.count) break;
    if (o.durationMs !== undefined && performance.now() - t0 >= o.durationMs) break;
    const due = t0 + k * o.intervalMs, now = performance.now();
    if (now < due) await new Promise((r) => setTimeout(r, due - now));
    const changes = gen.next(o.size);
    timings.push(await f.batch(changes, o));
    const lag = performance.now() - (t0 + (k + 1) * o.intervalMs);
    lastLag = o.intervalMs > 0 ? Math.max(0, lag) : 0;
    if (o.intervalMs > 0 && lag > 0) { late++; maxLag = Math.max(maxLag, lag); }
  }
  return { timings, late, maxLagMs: maxLag, lastLagMs: lastLag };
}
export function timingStats(ts: readonly BatchTiming[]): Record<string, Stats> {
  const out: Record<string, Stats> = {};
  for (const k of ["total", "base", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "unbounded"] as const) {
    const xs = ts.map((t) => t[k]).filter((x): x is number => typeof x === "number");
    if (xs.length > 0) out[k] = stats(xs);
  }
  const added = ts.filter((t) => t.s1 !== undefined).map((t) => t.total - t.base);
  if (added.length > 0) out.added = stats(added);
  return out;
}

// ───────────────────────────── inside the container: the control port ─────────────────────────────

const cgroup = (file: string): string | null => { try { return fs.readFileSync(`/sys/fs/cgroup/${file}`, "utf8"); } catch { return null; } };   // not a cgroup v2 container (the test world on a laptop): n/a
function readCgroup(): { ioRead: number | null; ioWrite: number | null; file: number | null; anon: number | null; peak: number | null; throttledUsec: number | null; nrThrottled: number | null } {
  const io = cgroup("io.stat"), mem = cgroup("memory.stat"), cpu = cgroup("cpu.stat"), peak = cgroup("memory.peak");
  const sum = (text: string | null, key: string): number | null => text === null ? null : [...text.matchAll(new RegExp(`\\b${key}=(\\d+)`, "g"))].reduce((a, m) => a + Number(m[1]), 0);
  const field = (text: string | null, key: string): number | null => { const m = text === null ? null : new RegExp(`^${key} (\\d+)$`, "m").exec(text); return m === null ? null : Number(m[1]); };
  return { ioRead: sum(io, "rbytes"), ioWrite: sum(io, "wbytes"), file: field(mem, "file"), anon: field(mem, "anon"), peak: peak === null ? null : Number(peak.trim()), throttledUsec: field(cpu, "throttled_usec"), nrThrottled: field(cpu, "nr_throttled") };
}
function bytesUnder(p: string): number {
  let st: fs.Stats;
  try { st = fs.statSync(p); } catch { return 0; }   // a file gone between the listing and the stat (a spill file): nothing
  if (!st.isDirectory()) return st.size;
  return fs.readdirSync(p).reduce((a, n) => a + bytesUnder(path.join(p, n)), 0);
}
async function phase(dir: string, body: () => Promise<Record<string, unknown>>): Promise<PhaseRecord> {
  const before = readCgroup(), t0 = performance.now();
  let spill = 0;
  const sample = setInterval(() => { spill = Math.max(spill, bytesUnder(path.join(dir, "duck.db.tmp"))); }, 1000);
  try {
    const extra = await body();
    const after = readCgroup();
    const d = (a: number | null, b: number | null): number | null => a === null || b === null ? null : a - b;
    return { seconds: (performance.now() - t0) / 1000, io: { readBytes: d(after.ioRead, before.ioRead), writeBytes: d(after.ioWrite, before.ioWrite) },
      memory: { fileBytes: after.file, anonBytes: after.anon, peakBytes: after.peak }, cpu: { throttledUsec: d(after.throttledUsec, before.throttledUsec), nrThrottled: d(after.nrThrottled, before.nrThrottled) },
      volumeBytes: bytesUnder(dir), spillBytes: spill, ...extra };
  } finally { clearInterval(sample); }
}
/** the cold read rate: the file's oldest part (written first, long evicted at 5x memory) read sequentially; io.stat's
 *  bytes over the time, so a disk that is a cached image file shows as a rate no gp3 has */
async function coldRead(file: string, bytes: number): Promise<{ readBytes: number; diskBytes: number | null; seconds: number }> {
  const before = readCgroup().ioRead, fd = fs.openSync(file, "r"), buf = Buffer.alloc(16 * 1024 ** 2), t0 = performance.now();
  let read = 0;
  try { while (read < bytes) { const n = fs.readSync(fd, buf, 0, buf.length, read); if (n === 0) break; read += n; } } finally { fs.closeSync(fd); }
  const after = readCgroup().ioRead;
  return { readBytes: read, diskBytes: before === null || after === null ? null : after - before, seconds: (performance.now() - t0) / 1000 };
}
async function blocksOf(c: DuckConnection, table: string, columns?: readonly string[]): Promise<number> {
  // a column's blocks: each segment's own and its overflow blocks (a long string's), counted once; an upper bound, since a
  // small segment shares its block with others
  const where = columns === undefined ? "" : ` WHERE column_name IN (${columns.map(lit).join(", ")})`;
  const info = `pragma_storage_info(${lit(table)})`;
  return Number((await c.runAndReadAll(`SELECT count(DISTINCT b) * 262144 FROM (SELECT block_id AS b FROM ${info}${where} UNION ALL SELECT unnest(additional_block_ids) FROM ${info}${where}) WHERE b IS NOT NULL`)).getRowsJS()[0]![0]);
}

interface InsideConfig { targetBytes: number; smoke: boolean; batchesPerSize: number; spillLimit: string }
async function inside(cfg: InsideConfig): Promise<void> {
  const dir = "/data", log = (l: string): void => { process.stdout.write(`${new Date().toISOString()} ${l}\n`); };
  let world: World | null = null, fold: Fold | null = null, gen: Batches | null = null, outside: Batches | null = null;
  const run = async (req: Record<string, unknown>): Promise<unknown> => {
    switch (req.phase) {
      case "generate": return phase(dir, async () => {
        world = await openWorld({ dir, spillLimit: cfg.spillLimit, targetBytes: cfg.targetBytes, host: "0.0.0.0", port: PG_PORT, log });
        const file = path.join(dir, "duck.db"), size = fs.statSync(file).size;
        const cold = await coldRead(file, Math.min(size, cfg.smoke ? 512 * 1024 ** 2 : 4 * GIB));
        const tenants = (await world.store.writer.runAndReadAll("SELECT tenant_id, count(*) FROM public.events GROUP BY 1 ORDER BY 2 DESC, 1")).getRowsJS().map(([t, n]) => [Number(t), Number(n)] as const);
        const keyCols = ["id", "tenant_id", "request_key", "kind", "status", "code", "started_at", "finished_at"];
        return { rows: world.rows, fileBytes: size, storeMemoryLimitBytes: world.store.memoryLimitBytes, cold,
          keyColumnBytes: await blocksOf(world.store.writer, "public.events", keyCols), payloadBytes: await blocksOf(world.store.writer, "public.events", ["payload"]),
          tenants: { top: tenants[0]![0], median: tenants[Math.floor(tenants.length / 2)]![0], topShare: tenants[0]![1] / world.rows } };
      });
      case "token": return { token: world!.token(4 * 3600) };
      case "rerun": return phase(dir, async () => {
        const built = await buildGenerated(world!, 60 * 60_000);
        fold = await Fold.open(world!); gen = new Batches(fold.conn); outside = new Batches(fold.conn, SEED + 1, { outside: true });
        const w = world!.store.writer;
        const n = async (t: string): Promise<number> => Number((await w.runAndReadAll(`SELECT count(*) FROM ${t}`)).getRowsJS()[0]![0]);
        return { rerunSeconds: built.seconds, requestsRows: await n("public.requests"), dailyRows: await n("public.daily_durations"),
          requestsBytes: await blocksOf(w, "public.requests"), dailyBytes: await blocksOf(w, "public.daily_durations"), reads: fold.reads };
      });
      case "writer": return phase(dir, async () => {
        const out: Record<string, unknown> = {}, count = cfg.batchesPerSize;
        for (const fold_ of [false, true]) for (const size of [6, 60, 1000]) {
          const g = fold_ ? gen! : outside!;
          await g.refill();
          const r = await runBatches(fold!, g, { size, intervalMs: 0, count, fold: fold_ });
          out[`${fold_ ? "fold" : "base"}${size}Stats`] = timingStats(r.timings);
        }
        await gen!.refill();
        out.payload60Stats = timingStats((await runBatches(fold!, gen!, { size: 60, intervalMs: 0, count, fold: true, withPayload: true })).timings);
        await gen!.refill();
        const cmp = await runBatches(fold!, gen!, { size: 60, intervalMs: 0, count: cfg.smoke ? 5 : 20, fold: true, compareUnbounded: true });
        out.unbounded60Stats = timingStats(cmp.timings);
        out.unboundedEqual = cmp.timings.every((t) => t.equal === true);
        return out;
      });
      case "together": return phase(dir, async () => {
        const g = req.fold === true ? gen! : outside!;
        await g.refill();
        const r = await runBatches(fold!, g, { size: Number(req.size), intervalMs: Number(req.intervalMs), durationMs: Number(req.durationMs), fold: req.fold === true });
        return { batchStats: timingStats(r.timings), batches: r.timings.length, late: r.late, maxLagMs: r.maxLagMs, lastLagMs: r.lastLagMs };
      });
      case "gate": return phase(dir, async () => ({ gate: await fold!.gate() }));
      default: throw new Error(`no phase ${String(req.phase)}`);
    }
  };
  const server = http.createServer((q, s) => {
    let body = "";
    q.on("data", (d: Buffer) => { body += d.toString(); });
    q.on("end", () => {
      if (q.url === "/health") { s.end(JSON.stringify({ ok: true })); return; }
      run(JSON.parse(body) as Record<string, unknown>).then((result) => s.end(JSON.stringify({ ok: true, result })),
        (e: unknown) => { log(`phase failed: ${e instanceof Error ? e.stack : String(e)}`); s.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) })); });
    });
  });
  server.requestTimeout = 0; server.headersTimeout = 0; server.timeout = 0;
  server.listen(CONTROL_PORT, "0.0.0.0");
  // the memory a kill would follow, every 2 s: what the host's death report quotes (its last line)
  setInterval(() => {
    const m = cgroup("memory.stat"), f = (k: string): string => { const x = m === null ? null : new RegExp(`^${k} (\\d+)$`, "m").exec(m); return x === null ? "?" : `${Math.round(Number(x[1]) / 1024 ** 2)}M`; };
    const duck = world === null ? "" : ` duckdb_limit=${Math.round(world.store.memoryLimitBytes / 1024 ** 2)}M`;
    log(`mem anon=${f("anon")} file=${f("file")} dirty=${f("file_dirty")} writeback=${f("file_writeback")} kernel=${f("kernel")} rss=${Math.round(process.memoryUsage().rss / 1024 ** 2)}M heap=${Math.round(process.memoryUsage().heapUsed / 1024 ** 2)}M${duck}`);
  }, 2000).unref();
  log(`bench-fold inside: control on ${CONTROL_PORT}`);
}

// ───────────────────────────── on the host: docker, the clients, the phases ─────────────────────────────

const realDocker: Docker = (args) => new Promise((resolve) => {
  const p = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  p.stdout.on("data", (d: Buffer) => { stdout += d.toString(); }); p.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
  p.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  p.on("error", (e) => resolve({ code: 1, stdout, stderr: e.message }));
});
const must = async (docker: Docker, args: string[]): Promise<string> => { const r = await docker(args); if (r.code !== 0) throw new Error(`docker ${args.slice(0, 3).join(" ")} failed: ${r.stderr.trim().split("\n").slice(-3).join(" / ")}`); return r.stdout.trim(); };
function control(port: number, body: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const q = http.request({ host: "127.0.0.1", port, path: body.phase === undefined ? "/health" : "/run", method: "POST", headers: { "content-type": "application/json" } }, (s) => {
      let text = ""; s.on("data", (d: Buffer) => { text += d.toString(); });
      s.on("end", () => { try { const r = JSON.parse(text) as { ok: boolean; result?: unknown; error?: string }; if (r.ok) resolve(r.result); else reject(new Error(r.error)); } catch (e) { reject(e instanceof Error ? e : new Error(String(e))); } });
    });
    q.on("error", reject); q.end(JSON.stringify(body));
  });
}

/** 4 clients round-robin over the statements, each on its own pg connection, recorded under the current label */
export async function startClients(port: number, token: string, statements: readonly Statement[], n: number): Promise<{ label(l: string): void; stop(): Promise<{ latencies: Record<string, Record<string, number[]>>; errors: string[] }> }> {
  const pg = (await import("pg")).default;
  const latencies: Record<string, Record<string, number[]>> = {}, errors: string[] = [];
  let label = "warmup", stopped = false;
  const clients = await Promise.all(Array.from({ length: n }, async () => { const c = new pg.Client({ host: "127.0.0.1", port, database: "app", user: "mason", password: token }); await c.connect(); return c; }));
  const loops = clients.map(async (c, i) => {
    for (let k = i; !stopped; k++) {
      const s = statements[k % statements.length]!, at = label, t0 = performance.now();
      try { await c.query(s.sql); ((latencies[at] ??= {})[s.name] ??= []).push(performance.now() - t0); }
      catch (e) { if (errors.length < 20) errors.push(`${s.name}: ${e instanceof Error ? e.message : String(e)}`); }
    }
  });
  return { label: (l) => { label = l; }, stop: async () => { stopped = true; await Promise.all(loops); await Promise.all(clients.map((c) => c.end())); return { latencies, errors }; } };
}
const summarise = (byStatement: Record<string, number[]> | undefined, generatedOnly: ReadonlySet<string>): Record<string, Stats> => {
  const out: Record<string, Stats> = {}, all: number[] = [], gen: number[] = [];
  for (const [name, xs] of Object.entries(byStatement ?? {})) { out[name] = latencyStats(xs); all.push(...xs); if (generatedOnly.has(name)) gen.push(...xs); }
  out["the set"] = latencyStats(all); out["S1-S5 (generated tables)"] = latencyStats(gen);
  return out;
};

async function host(argv: string[]): Promise<number> {
  const smoke = argv.includes("--smoke"), keep = argv.includes("--keep");
  const arg = (k: string): string | undefined => { const i = argv.indexOf(k); return i < 0 ? undefined : argv[i + 1]; };
  const out = arg("--out") ?? path.join(os.tmpdir(), `bench-fold${smoke ? "-smoke" : ""}.json`);
  const budgetMs = Number(arg("--budget-min") ?? (smoke ? 15 : 110)) * 60_000;
  // the smoke at 3 GiB: Mason with its default memory limit (half the cgroup) was OOM-killed at 1 GiB in the whole re-run,
  // and at 2 GiB in the writer phase (anon 1.76 GiB beside an engine limit of 1 GiB)
  const memoryBytes = smoke ? 3 * GIB : 4 * GIB;
  const target = smoke ? 1.5e9 : targetBytes(memoryBytes);
  const free = fs.statfsSync(os.homedir()); const freeBytes = free.bavail * free.bsize;
  if (freeBytes < HOST_FREE_MIN_BYTES) { process.stderr.write(`bench-fold: ${gib(freeBytes)} free on the host, under the ${gib(HOST_FREE_MIN_BYTES)} the run needs\n`); return 2; }
  const id = crypto.randomBytes(4).toString("hex"), base = `mason-bench-fold-${id}`;
  const names: Names = { container: base, volume: base, image: `${base}:run` };
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const started = Date.now();
  const result: Result = { smoke, startedAt: new Date().toISOString(), environment: { memoryBytes, cpus: 4, spillLimit: "6GB", targetBytes: target, names, hostCpus: os.cpus().length, hostMemoryBytes: os.totalmem() }, phases: {}, measures: {}, dropped: [], errors: [] };
  const save = (): void => { fs.writeFileSync(out, JSON.stringify(result, null, 2)); fs.writeFileSync(out.replace(/\.json$/, "") + ".md", renderReport(result)); };
  const say = (l: string): void => { process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${l}\n`); };
  const est = (full: number, s: number): number => (smoke ? s : full) * 60_000;
  const phases: PhaseEstimate[] = [{ name: "1 rerun", estimateMs: est(10, 1) }, { name: "2 alone", estimateMs: est(9, 2.2) }, { name: "3 writer", estimateMs: est(15, 2) }, { name: "4 together", estimateMs: est(17, 3.5) }, { name: "5 gate", estimateMs: est(6, 0.5) }];
  const sub = smoke ? { warm: 10_000, alone: 50_000, together: 50_000 } : { warm: 30_000, alone: 210_000, together: 300_000 };

  const done = await withCleanup(realDocker, names, async () => {
    say(`building ${names.image} from ${root}`);
    await must(realDocker, ["build", "-q", "-f", path.join(root, "docker/mason-data.Dockerfile"), "-t", names.image, root]);
    await must(realDocker, ["volume", "create", names.volume]);
    // the volume's block device, read inside a throwaway container from /data's mount and sysfs (a partition's parent disk)
    // a volume on a filesystem with no device of its own (btrfs: major 0) is read from its mount's source
    const probe = "const fs=require('fs');const l=fs.readFileSync('/proc/self/mountinfo','utf8').split('\\n').find(x=>x.split(' ')[4]==='/data');const mm=l&&l.split(' ')[2];const src=l&&l.split(' - ')[1].split(' ')[1];let d=null;" +
      "const disk=(sys)=>{let p=sys;if(fs.existsSync(p+'/partition'))p=fs.realpathSync(p)+'/..';const m=/DEVNAME=(.*)/.exec(fs.readFileSync(p+'/uevent','utf8'));return m?'/dev/'+m[1]:null};" +
      "try{if(mm&&!mm.startsWith('0:'))d=disk('/sys/dev/block/'+mm);else if(src&&src.startsWith('/dev/'))d=disk('/sys/class/block/'+src.slice(5));}catch(e){d=null}console.log(JSON.stringify({mm,src,d}))";
    const found = JSON.parse(await must(realDocker, ["run", "--rm", "--user", "0", "-v", `${names.volume}:/data`, "--entrypoint", "node", names.image, "-e", probe])) as { mm: string | null; src: string | null; d: string | null };
    const spec = (device: string | null): ContainerSpec => ({ container: names.container, image: names.image, volume: names.volume, memoryBytes, cpus: 4, device, script: fileURLToPath(import.meta.url),
      env: { MASON_SPILL_LIMIT: "6GB", BENCH_FOLD_CONFIG: JSON.stringify({ targetBytes: target, smoke, batchesPerSize: smoke ? 6 : 40, spillLimit: "6GB" } satisfies InsideConfig) }, args: [] });
    let run = found.d === null ? { code: 1, stdout: "", stderr: `no block device for /data (${found.mm ?? "no mount"} on ${found.src ?? "?"})` } : await realDocker(containerArgs(spec(found.d)));
    result.environment.throttle = run.code === 0 ? `${found.d} throttled to 125 MB/s and 3000 IOPS each way (an EBS gp3)` : `NOT throttled (${run.stderr.trim().split("\n")[0]}): the numbers are a laptop disk's`;
    if (run.code !== 0) { await realDocker(["rm", "-f", names.container]); run = await realDocker(containerArgs(spec(null))); }
    if (run.code !== 0) throw new Error(`the container did not start: ${run.stderr.trim()}`);
    /** why the container stopped answering: its state (OOMKilled) and its log's last lines, read before cleanup removes it */
    const died = async (): Promise<string> => {
      const st = await realDocker(["inspect", "-f", "running={{.State.Running}} oomkilled={{.State.OOMKilled}} exit={{.State.ExitCode}}", names.container]);
      const logs = await realDocker(["logs", "--tail", "400", names.container]);
      const lines = (logs.stdout + logs.stderr).trim().split("\n");
      const mem = lines.filter((l) => / mem anon=/.test(l)).slice(-3);
      return `${st.stdout.trim()}; memory before: ${mem.join(" / ")}; last lines: ${lines.filter((l) => !/ mem anon=/.test(l)).slice(-3).map((l) => l.slice(0, 200)).join(" / ")}`;
    };
    const portOf = async (p: number): Promise<number> => Number((await must(realDocker, ["port", names.container, String(p)])).split("\n")[0]!.split(":").pop());
    const cport = await portOf(CONTROL_PORT), pgport = await portOf(PG_PORT);
    for (let k = 0; ; k++) { try { await control(cport, {}); break; } catch (e) { if (k > 120) throw e; await new Promise((r) => setTimeout(r, 500)); } }
    const step = async (name: string, body: Record<string, unknown>): Promise<PhaseRecord> => {
      const r = await control(cport, body).catch(async (e: unknown) => { throw new Error(`${name}: ${e instanceof Error ? e.message : String(e)} (${await died()})`); }) as PhaseRecord;
      r.hostLoad = os.loadavg();
      result.phases[name] = r; save();
      if (volumeTooBig(r.volumeBytes)) throw new Error(`the volume holds ${gib(r.volumeBytes)}, past the ${gib(VOLUME_STOP_BYTES)} stop`);
      return r;
    };
    const fits = (p: PhaseEstimate): boolean => { const plan = planPhases(budgetMs - CLEANUP_MS, [p], 0, Date.now() - started); if (plan.dropped.length > 0) { result.dropped.push(...plan.dropped); save(); say(`dropped ${p.name}`); } return plan.planned.length > 0; };

    say(`generating ~${gib(target)} in ${names.container}`);
    const g = await step("0 generate", { phase: "generate" });
    const cold = g.cold as { readBytes: number; diskBytes: number | null; seconds: number };
    Object.assign(result.environment, { storeMemoryLimitBytes: g.storeMemoryLimitBytes, coldReadBytesPerSecond: (cold.diskBytes ?? cold.readBytes) / cold.seconds, coldRead: cold });
    result.tenants = g.tenants as NonNullable<Result["tenants"]>;
    result.sizes = { rows: Number(g.rows), fileBytes: Number(g.fileBytes), keyColumnBytes: Number(g.keyColumnBytes), payloadBytes: Number(g.payloadBytes) };
    say(`tenants: top ${result.tenants!.top}, median ${result.tenants!.median}`);
    if (!fits(phases[0]!)) return;
    const r1 = await step("1 rerun", { phase: "rerun" });
    result.measures.t4 = { rerunSeconds: Number(r1.rerunSeconds) };
    Object.assign(result.sizes, { requestsRows: Number(r1.requestsRows), dailyRows: Number(r1.dailyRows), requestsBytes: Number(r1.requestsBytes), dailyBytes: Number(r1.dailyBytes) });
    save();
    const token = (await control(cport, { phase: "token" }) as { token: string }).token;
    const sets = { "7d": statementSet(result.tenants!, "7d"), "30d": statementSet(result.tenants!, "30d") };
    const generatedNames = new Set(Object.values(sets).flat().filter((s) => s.generated).map((s) => s.name));
    const clientPhase = async (name: string, statements: Statement[], parts: Array<{ label: string; body?: Record<string, unknown>; ms?: number }>): Promise<void> => {
      const t0 = performance.now(), c = await startClients(pgport, token, statements, 4);
      await new Promise((r) => setTimeout(r, sub.warm));
      const rec: Record<string, unknown> = {};
      for (const p of parts) {
        c.label(p.label);
        if (p.body !== undefined) rec[p.label] = await control(cport, p.body).catch(async (e: unknown) => { throw new Error(`${name} ${p.label}: ${e instanceof Error ? e.message : String(e)} (${await died()})`); }); else await new Promise((r) => setTimeout(r, p.ms));
      }
      const got = await c.stop();
      const record = { ...(Object.values(rec)[0] as PhaseRecord | undefined ?? { io: { readBytes: null, writeBytes: null }, memory: { fileBytes: null, anonBytes: null, peakBytes: null }, cpu: { throttledUsec: null, nrThrottled: null }, volumeBytes: 0, spillBytes: 0 }), seconds: (performance.now() - t0) / 1000, hostLoad: os.loadavg(), clientErrors: got.errors } as PhaseRecord;
      for (const p of parts) { record[`${p.label}Stats`] = summarise(got.latencies[p.label], generatedNames); if (rec[p.label] !== undefined) { record[`${p.label}Writer`] = rec[p.label]; const ws = (rec[p.label] as { batchStats?: Record<string, Stats> }).batchStats; if (ws !== undefined) record[`${p.label} writerStats`] = ws; } }
      if (got.errors.length > 0) result.errors.push(...got.errors.map((x) => `${name}: ${x}`));
      result.phases[name] = record; save();
    };
    if (fits(phases[1]!)) {
      await clientPhase("2 alone 7d", sets["7d"], [{ label: "alone 7d", ms: sub.alone }]);
      await clientPhase("2 alone 30d", sets["30d"], [{ label: "alone 30d", ms: sub.alone }]);
    }
    if (fits(phases[2]!)) {
      const w = await step("3 writer", { phase: "writer" });
      if (w.unboundedEqual !== true) result.errors.push("an unbounded recompute's rows differed from the bounded one's");
    }
    if (fits(phases[3]!)) {
      const D = sub.together;
      await clientPhase("4 together", sets["7d"], [
        { label: "fold 6/0.5s", body: { phase: "together", fold: true, size: 6, intervalMs: 500, durationMs: D } },
        { label: "base 6/0.5s", body: { phase: "together", fold: false, size: 6, intervalMs: 500, durationMs: D } },
        { label: "fold 60/5s", body: { phase: "together", fold: true, size: 60, intervalMs: 5000, durationMs: D } },
      ]);
      const p4 = result.phases["4 together"]!, w = (l: string): Record<string, Stats> => (p4[`${l}Writer`] as { batchStats: Record<string, Stats> }).batchStats;
      result.measures.t1 = { p95At6Ms: w("fold 6/0.5s").total!.p95, p95At60Ms: w("fold 60/5s").total!.p95 };
      result.measures.t2 = { addedP95Ms: w("fold 60/5s").added!.p95 };
      const s = (l: string): number => (p4[`${l}Stats`] as Record<string, Stats>)["S1-S5 (generated tables)"]!.p95;
      const alone = result.phases["2 alone 7d"]?.["alone 7dStats"] as Record<string, Stats> | undefined;
      if (alone !== undefined) result.measures.t3 = { aloneP95Ms: alone["S1-S5 (generated tables)"]!.p95, togetherP95Ms: Math.max(s("fold 6/0.5s"), s("fold 60/5s")) };
      save();
    }
    if (fits(phases[4]!)) {
      const gate = (await step("5 gate", { phase: "gate" })).gate as { ok: boolean; failures: string[] };
      const unbounded = result.phases["3 writer"]?.unboundedEqual;
      result.measures.gate = { ok: gate.ok && unbounded !== false, failures: [...gate.failures, ...(unbounded === false ? ["an unbounded recompute differed from its bounded one"] : [])] };
    }
  }, { deadlineMs: budgetMs - CLEANUP_MS, keep });
  if (done.error !== undefined) result.errors.push(done.error);
  result.cleanup = done.cleanup; result.finishedAt = new Date().toISOString();
  save();
  say(`report: ${out.replace(/\.json$/, "")}.md; cleanup ${done.cleanup.ok ? "verified" : "NOT VERIFIED"}`);
  process.stdout.write(renderReport(result));
  return done.error === undefined && done.cleanup.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--inside")) await inside(JSON.parse(process.env.BENCH_FOLD_CONFIG ?? "{}") as InsideConfig);
  else process.exit(await host(process.argv.slice(2)));
}
