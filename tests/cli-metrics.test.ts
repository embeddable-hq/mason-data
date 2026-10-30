/**
 * `GET /metrics` (src/cli/metrics.ts, `mason serve`'s health port): the run's numbers in Prometheus's text exposition
 * format 0.0.4 — every metric with its HELP and TYPE, named `mason_…` with its unit, every value finite or the metric
 * absent (never 0 or NaN pretending), the statements a counter that never goes down, `mason_ready 0` and `mason_info`
 * alone while Mason starts or stops, and NEVER a name: no table, user, client, statement or host, as a value or a label,
 * because the endpoint takes no credential. The endpoint over HTTP: tests/serve.test.ts.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DuckStore } from "../src/duck/store.ts";
import type { ApiLogRow } from "../src/api/request-log.ts";
import type { MetricsFacts, RunMetrics } from "../src/cli/metrics.ts";

// imported when the tests run: at a commit without the module this file still loads, and each test fails by name
type Metrics = typeof import("../src/cli/metrics.ts");
const metrics = (): Promise<Metrics> => import("../src/cli/metrics.ts" as string) as Promise<Metrics>;
type Usage = typeof import("../src/duck/usage.ts");

const usage = {
  copyBytes: 5 * 2 ** 30, totals: { added: 4, copied: 3, failed: 1, rows: 12_345_678 }, oldestSyncSeconds: 42.5,
  streamLag: { bytes: 2_048, seconds: 1.5 }, copied: ["public.orders", "public.customers", "billing.invoices"],
  slotWalHeldBytes: 65_536, diskFreeBytes: 80 * 2 ** 30, sessionsOpen: 3, tables: { total: 5, copied: 3, copying: 1, waiting: 0, failed: 1 },
};
const run: RunMetrics = {
  uptimeSeconds: 3_600, usage,
  statements: { completed: 1_000, refused: 7, failed: 2, cancelled: 1, completedMs: 12_500 },
  durations: { at: "2026-10-30T09:00:00.000Z", p50Ms: 12, p95Ms: 340 },
};
const READY: MetricsFacts = { version: "0.9.1", run };

/** the exposition parsed: each metric's HELP and TYPE, and every sample line (name, labels, value text) */
interface Parsed { help: Map<string, string>; type: Map<string, string>; samples: Array<{ name: string; labels: string; value: string }> }
function parse(text: string): Parsed {
  assert.ok(text.endsWith("\n"), "the body ends with a line feed");
  const p: Parsed = { help: new Map(), type: new Map(), samples: [] };
  for (const line of text.slice(0, -1).split("\n")) {
    const meta = /^# (HELP|TYPE) (\S+) (.*)$/.exec(line);
    if (meta) { (meta[1] === "HELP" ? p.help : p.type).set(meta[2]!, meta[3]!); continue; }
    const s = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})? (\S+)$/.exec(line);
    assert.ok(s, `a sample line: ${JSON.stringify(line)}`);
    p.samples.push({ name: s[1]!, labels: s[2] ?? "", value: s[3]! });
  }
  return p;
}
/** the metric a sample belongs to: a summary's `_sum` and `_count` are its own */
const family = (p: Parsed, name: string): string => p.type.has(name) ? name : name.replace(/_(sum|count)$/, "");
const value = (p: Parsed, name: string, labels = ""): number | undefined => {
  const s = p.samples.find((x) => x.name === name && x.labels === labels);
  return s === undefined ? undefined : Number(s.value);
};

/** every rule of the format the endpoint keeps, over one body */
function holdsTheFormat(text: string): Parsed {
  const p = parse(text);
  for (const s of p.samples) {
    const f = family(p, s.name);
    assert.match(f, /^mason_[a-z0-9_]+$/, `the name ${f}`);
    assert.ok(p.help.has(f) && p.help.get(f)!.length > 0, `${f} has its HELP`);
    assert.ok(["gauge", "counter", "summary"].includes(p.type.get(f) ?? ""), `${f} has its TYPE: ${p.type.get(f)}`);
    assert.ok(Number.isFinite(Number(s.value)) && /^-?[0-9.e+]+$/.test(s.value), `${s.name}${s.labels} is a finite number: ${s.value}`);
  }
  for (const [name, kind] of p.type) {
    assert.ok(p.samples.some((s) => family(p, s.name) === name), `${name}'s TYPE has samples (an absent metric has no HELP or TYPE)`);
    if (kind === "counter") assert.match(name, /_total$/, `the counter ${name} ends in _total`);
  }
  return p;
}

test("starting or stopping: mason_ready 0 and mason_info alone, each with HELP and TYPE (a scrape never fails while Mason starts)", async () => {
  const { metricsText } = await metrics();
  const text = metricsText({ version: "0.9.1", run: null });
  assert.equal(text, [
    "# HELP mason_ready 1 once Mason serves the copy; 0 while it starts or stops (/healthz answers 503 then).",
    "# TYPE mason_ready gauge",
    "mason_ready 0",
    "# HELP mason_info Mason's version, as a label; the value is always 1.",
    "# TYPE mason_info gauge",
    'mason_info{version="0.9.1"} 1',
    "",
  ].join("\n"));
  holdsTheFormat(text);
  // the one text label is escaped as the format says
  assert.match(metricsText({ version: 'dev"\\\n', run: null }), /^mason_info\{version="dev\\"\\\\\\n"\} 1$/m);
});

test("serving: mason_ready 1 and every number, named with its unit, a counter by outcome and a summary of the durations", async () => {
  const { metricsText, METRICS_CONTENT_TYPE } = await metrics();
  assert.equal(METRICS_CONTENT_TYPE, "text/plain; version=0.0.4; charset=utf-8");
  const text = metricsText(READY);
  const p = holdsTheFormat(text);
  assert.deepEqual(Object.fromEntries(p.type), {
    mason_ready: "gauge", mason_info: "gauge", mason_uptime_seconds: "gauge", mason_tables: "gauge", mason_copy_bytes: "gauge", mason_copy_rows: "gauge",
    mason_sync_oldest_age_seconds: "gauge", mason_stream_lag_bytes: "gauge", mason_stream_lag_seconds: "gauge", mason_slot_wal_held_bytes: "gauge",
    mason_disk_free_bytes: "gauge", mason_sessions_open: "gauge", mason_statements_total: "counter", mason_statement_duration_seconds: "summary",
  });
  assert.deepEqual(p.samples.map((s) => `${s.name}${s.labels} ${s.value}`), [
    "mason_ready 1",
    'mason_info{version="0.9.1"} 1',
    "mason_uptime_seconds 3600",
    'mason_tables{phase="copied"} 3', 'mason_tables{phase="copying"} 1', 'mason_tables{phase="waiting"} 0', 'mason_tables{phase="failed"} 1',
    `mason_copy_bytes ${5 * 2 ** 30}`,
    "mason_copy_rows 12345678",
    "mason_sync_oldest_age_seconds 42.5",
    "mason_stream_lag_bytes 2048",
    "mason_stream_lag_seconds 1.5",
    "mason_slot_wal_held_bytes 65536",
    `mason_disk_free_bytes ${80 * 2 ** 30}`,
    "mason_sessions_open 3",
    'mason_statements_total{outcome="completed"} 1000', 'mason_statements_total{outcome="failed"} 2',
    'mason_statements_total{outcome="refused"} 7', 'mason_statements_total{outcome="cancelled"} 1',
    // the last sample's p50 / p95, ms said in seconds; the sum and count of the completed since the process started
    'mason_statement_duration_seconds{quantile="0.5"} 0.012', 'mason_statement_duration_seconds{quantile="0.95"} 0.34',
    "mason_statement_duration_seconds_sum 12.5", "mason_statement_duration_seconds_count 1000",
  ]);
});

test("a number not known is ABSENT, never 0 or NaN: no stream when polling, no age before any sync, no size unread, no quantile before a sample", async () => {
  const { metricsText } = await metrics();
  const polled = holdsTheFormat(metricsText({ version: "0.9.1", run: {
    ...run, usage: { ...usage, streamLag: null, slotWalHeldBytes: null, oldestSyncSeconds: null, copyBytes: null, diskFreeBytes: null }, durations: null,
  } }));
  const names = new Set(polled.samples.map((s) => family(polled, s.name)));
  for (const gone of ["mason_stream_lag_bytes", "mason_stream_lag_seconds", "mason_slot_wal_held_bytes", "mason_sync_oldest_age_seconds", "mason_copy_bytes", "mason_disk_free_bytes"]) {
    assert.ok(!names.has(gone) && !polled.help.has(gone) && !polled.type.has(gone), `${gone} is absent, its HELP and TYPE too`);
  }
  // before the first sample: the summary's sum and count stand (the counter), its quantiles are absent
  assert.deepEqual(polled.samples.filter((s) => family(polled, s.name) === "mason_statement_duration_seconds").map((s) => s.name + s.labels),
    ["mason_statement_duration_seconds_sum", "mason_statement_duration_seconds_count"]);
  // a stream whose lag is not known yet (its position not read): each of its numbers absent alone
  const unread = holdsTheFormat(metricsText({ version: "0.9.1", run: { ...run, usage: { ...usage, streamLag: { bytes: 4_096, seconds: null } },
    durations: { at: "2026-10-30T09:00:00.000Z", p50Ms: null, p95Ms: null } } }));
  assert.equal(value(unread, "mason_stream_lag_bytes"), 4_096);
  assert.equal(value(unread, "mason_stream_lag_seconds"), undefined);
  assert.equal(value(unread, "mason_statement_duration_seconds", '{quantile="0.5"}'), undefined, "a minute with none completed has no quantile");
  // a value that is not finite is never written (a guard: the facts never carry one)
  const odd = holdsTheFormat(metricsText({ version: "0.9.1", run: { ...run, usage: { ...usage, oldestSyncSeconds: Number.NaN, copyBytes: Number.POSITIVE_INFINITY } } }));
  assert.equal(value(odd, "mason_sync_oldest_age_seconds"), undefined);
  assert.equal(value(odd, "mason_copy_bytes"), undefined);
});

test("mason_statements_total is a COUNTER: counted as the listener records each statement, never reset by a sample, so two scrapes never go down", async () => {
  const { metricsText } = await metrics();
  const { UsageSampler } = await import("../src/duck/usage.ts" as string) as Usage;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-metrics-"));
  const store = await DuckStore.open(path.join(dir, "duck.db"), () => undefined, { memoryLimit: "512MiB" });
  after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  let clock = Date.parse("2026-10-30T09:00:00.000Z");
  const u = await UsageSampler.open(store, () => undefined, { days: 7, now: () => clock, sampleMs: 3_600_000, sizeEveryMs: 3_600_000 });
  u.start(async () => usage);
  const row = (durationMs: number, o: Partial<ApiLogRow> = {}): ApiLogRow => ({ requestId: "r", at: new Date(), method: "QUERY", status: 200, durationMs, ...o });
  const scrape = (): Parsed => parse(metricsText({ version: "0.9.1", run: { uptimeSeconds: 1, usage, statements: u.statementTotals(), durations: u.lastDurations() } }));
  const counts = (p: Parsed): Record<string, number> => Object.fromEntries(p.samples.filter((s) => s.name === "mason_statements_total" || s.name.startsWith("mason_statement_duration_seconds_"))
    .map((s) => [s.name + s.labels, Number(s.value)]));
  for (const ms of [10, 20, 30]) u.count(row(ms));
  u.count(row(5, { sqlstate: "42P01" }));
  u.count(row(9_000, { sqlstate: "57014" }));
  u.count(row(1, { method: "CONNECT", sqlstate: "28P01" }));   // a refused login is no statement (the summary's rule)
  const first = scrape();
  assert.deepEqual(counts(first), {
    'mason_statements_total{outcome="completed"}': 3, 'mason_statements_total{outcome="failed"}': 0, 'mason_statements_total{outcome="refused"}': 1,
    'mason_statements_total{outcome="cancelled"}': 1, mason_statement_duration_seconds_sum: 0.06, mason_statement_duration_seconds_count: 3,
  });
  assert.equal(value(first, "mason_statement_duration_seconds", '{quantile="0.5"}'), undefined, "no sample taken yet");
  // a sample ends the interval: the interval's counts start again at 0, the counter does not
  clock += 60_000;
  await u.sample();
  u.count(row(40));
  u.count(row(7, { sqlstate: "XX000" }));
  const second = scrape();
  for (const [k, v] of Object.entries(counts(first))) assert.ok(counts(second)[k]! >= v, `${k} never goes down: ${v} then ${counts(second)[k]}`);
  assert.deepEqual(counts(second), {
    'mason_statements_total{outcome="completed"}': 4, 'mason_statements_total{outcome="failed"}': 1, 'mason_statements_total{outcome="refused"}': 1,
    'mason_statements_total{outcome="cancelled"}': 1, mason_statement_duration_seconds_sum: 0.1, mason_statement_duration_seconds_count: 4,
  });
  // the quantiles are the sample's own (10, 20, 30 ms: p50 20, p95 29), the ones it wrote to the usage samples
  const [written] = await u.samples({ since: "2026-10-30T00:00:00Z", until: "2026-10-31T00:00:00Z" });
  assert.deepEqual([value(second, "mason_statement_duration_seconds", '{quantile="0.5"}'), value(second, "mason_statement_duration_seconds", '{quantile="0.95"}')],
    [written!.durationP50Ms! / 1000, written!.durationP95Ms! / 1000]);
  assert.deepEqual([written!.durationP50Ms, written!.durationP95Ms], [20, 29]);
  await u.close();
});

test("NEVER A NAME: facts that carry a table's, a user's, a client's name, a statement and a host print none of them (the endpoint takes no credential)", async () => {
  const { metricsText } = await metrics();
  const secrets = ["public.secret_orders", "secret_orders", "alice_analyst", "Metabase-7", "SELECT ssn FROM", "db.internal.example", "10.0.0.7"];
  // the facts as a run could hold them: the copies served are named, and fields beside the numbers carry the rest
  const leaky = {
    ...run,
    usage: { ...usage, copied: ["public.secret_orders", "secret_orders"], sessions: [{ user: "alice_analyst", client: "Metabase-7" }] },
    running: [{ statement: "SELECT ssn FROM secret_orders", user: "alice_analyst" }],
    source: { host: "db.internal.example", address: "10.0.0.7" },
  };
  for (const text of [metricsText({ version: "0.9.1", run: leaky }), metricsText({ version: "0.9.1", run: { ...leaky, durations: null } })]) {
    holdsTheFormat(text);
    for (const s of secrets) assert.ok(!text.includes(s), `${JSON.stringify(s)} is not in the body`);
    // and no label but the three closed sets and the version
    const labels = [...text.matchAll(/\{([^}]*)\}/g)].flatMap((m) => m[1]!.split(",").map((kv) => kv.split("=")[0]));
    for (const l of labels) assert.ok(["outcome", "phase", "quantile", "version"].includes(l!), `the label ${l}`);
  }
});
