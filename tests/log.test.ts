/**
 * Log lines (src/lib/log.ts): the text this repo has always printed, the JSON entry under MASON_LOG_FORMAT=json,
 * and `JsonLines`, which makes every line a child prints one entry.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { entry, JsonLines, lineEntry, logFormatOf, logger, markedLevel, type LogEntry } from "../src/lib/log.ts";
import * as logModule from "../src/lib/log.ts";

// read from the module, not imported by name: the file loads at a commit without it (scripts/fails-without.ts)
const { textEntry } = logModule as unknown as { textEntry: (head: string, msg: string) => string };

/** What a logger wrote, per stream, while `run` ran. */
function capture(run: () => void): { stdout: string; stderr: string } {
  const out = { stdout: "", stderr: "" };
  const was = { stdout: process.stdout.write, stderr: process.stderr.write };
  process.stdout.write = ((c: string) => { out.stdout += c; return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: string) => { out.stderr += c; return true; }) as typeof process.stderr.write;
  try { run(); } finally { process.stdout.write = was.stdout; process.stderr.write = was.stderr; }
  return out;
}

test("as text, the lines this repo has always printed: [component] message, WARNING: / ERROR: on stderr", () => {
  const env = {};
  const got = capture(() => {
    const l = logger("cdc", {}, env);
    l.info("streaming");
    l.warn("TRUNCATE of t is not replicated");
    l.error("boom");
    l.log("WARNING: from the marker");
    l.log("plain");
  });
  assert.equal(got.stdout, "[cdc] streaming\n[cdc] plain\n");
  assert.equal(got.stderr, "[cdc] WARNING: TRUNCATE of t is not replicated\n[cdc] ERROR: boom\n[cdc] WARNING: from the marker\n");
  const ts = capture(() => logger("runtime", { timestamp: true }, env).info("up"));
  assert.match(ts.stdout, /^\[runtime\] \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z up\n$/);
});

test("as JSON, one object per line on stdout: ts, level, component, msg, service, deployment, version", () => {
  const env = { MASON_LOG_FORMAT: "json", DEPLOYMENT: "app", MASON_VERSION: "1.4.0" };
  const got = capture(() => {
    const l = logger("bootstrap", {}, env);
    l.log("WARNING: a marker becomes the level");
    l.error("line one\n    at frame");
  });
  assert.equal(got.stderr, "");
  const [a, b] = got.stdout.trimEnd().split("\n").map((l) => JSON.parse(l) as LogEntry);
  assert.deepEqual({ ...a!, ts: "" }, { ts: "", level: "warn", component: "bootstrap", msg: "a marker becomes the level", service: "mason", deployment: "app", version: "1.4.0" });
  assert.equal(b!.level, "error");
  assert.equal(b!.msg, "line one\n    at frame", "a stack is ONE entry");
  assert.ok(!Number.isNaN(Date.parse(a!.ts)));
  // no deployment or version set: the keys are left out, never empty
  assert.deepEqual(Object.keys(entry("info", "x", "m", {})), ["ts", "level", "component", "msg", "service"]);
});

test("MASON_LOG_FORMAT: text by default, json, and a problem for anything else", () => {
  assert.deepEqual(logFormatOf({}), { format: "text", problem: null });
  assert.deepEqual(logFormatOf({ MASON_LOG_FORMAT: "json" }), { format: "json", problem: null });
  assert.match(logFormatOf({ MASON_LOG_FORMAT: "yaml" }).problem ?? "", /MASON_LOG_FORMAT=yaml is not a log format/);
});

test("a line's level: its ERROR / WARNING marker, else its stream; its component: its [prefix], else the child's", () => {
  assert.deepEqual(markedLevel("ERROR: x"), { level: "error", msg: "x" });
  assert.deepEqual(markedLevel("WARNING: x"), { level: "warn", msg: "x" });
  assert.deepEqual(markedLevel("no marker"), { level: null, msg: "no marker" });
  assert.deepEqual(markedLevel("ERRORS were counted"), { level: null, msg: "ERRORS were counted" }, "a word, not a marker");
  const at = new Date(0);
  const e = (line: string, stream: "stdout" | "stderr"): Pick<LogEntry, "level" | "component" | "msg"> => {
    const { level, component, msg } = lineEntry(line, stream, "mason", {}, at);
    return { level, component, msg };
  };
  assert.deepEqual(e("[sync] copied public.orders", "stdout"), { level: "info", component: "sync", msg: "copied public.orders" });
  assert.deepEqual(e("[stream] WARNING: slow", "stderr"), { level: "warn", component: "stream", msg: "slow" });
  assert.deepEqual(e("Postgres API: postgresql://localhost:5433/app", "stdout"), { level: "info", component: "mason", msg: "Postgres API: postgresql://localhost:5433/app" });
  assert.deepEqual(e("TypeError: x is undefined", "stderr"), { level: "error", component: "mason", msg: "TypeError: x is undefined" });
  assert.deepEqual(e("[api-log] could not record", "stderr"), { level: "error", component: "api-log", msg: "could not record" });
});

test("JsonLines: every line one entry — chunks split anywhere, continuations joined, entries passed through, the rest flushed at the end", () => {
  const out: string[] = [];
  const j = new JsonLines("mason", (l) => out.push(l), {});
  j.push("stdout", "[sync] copied\n  orders  table\n  cust");
  j.push("stdout", "omers  table\n[sync] done\n");
  j.push("stderr", "Error: boom\n    at f (x.ts:1)\n    at g (x.ts:2)\n");
  j.push("stdout", '{"ts":"t","level":"warn","component":"cdc","msg":"already an entry","service":"mason"}\n\n');
  j.push("stdout", "{not json at all\n");
  j.push("stdout", "no newline yet");
  j.end();
  const entries = out.map((l) => JSON.parse(l) as LogEntry);
  assert.deepEqual(entries.map((e) => [e.level, e.component, e.msg]), [
    ["info", "sync", "copied\n  orders  table\n  customers  table"],
    ["info", "sync", "done"],
    ["error", "mason", "Error: boom\n    at f (x.ts:1)\n    at g (x.ts:2)"],
    ["warn", "cdc", "already an entry"],
    ["info", "mason", "{not json at all"],
    ["info", "mason", "no newline yet"],
  ], "in the order printed");
  // an entry a child wrote is passed through as it came, byte for byte
  assert.ok(out.includes('{"ts":"t","level":"warn","component":"cdc","msg":"already an entry","service":"mason"}'));
});

test("JsonLines writes a held entry after a quiet FLUSH_MS, without waiting for the next line", async () => {
  const out: string[] = [];
  const j = new JsonLines("runtime", (l) => out.push(l), {});
  j.push("stdout", "[runtime] up\n");
  assert.equal(out.length, 0, "held: an indented line may still follow");
  await new Promise((r) => setTimeout(r, JsonLines.FLUSH_MS + 50));
  assert.equal(out.length, 1);
  assert.equal((JSON.parse(out[0]!) as LogEntry).msg, "up");
});

// A REASON IN SEVERAL LINES IS ONE ENTRY, WHOLE (a test server: a failed catch-up's DuckDB Binder Error was logged
// as its first line). Its further lines are indented under it — what JsonLines and a person both read as the entry's
// continuation — and nothing of it is dropped but its blank lines. src/cli/dev.ts writes mason.log through it.
test("a multi-line message is one entry: every further line indented under it, read back whole as one entry", () => {
  const duck = "Binder Error: Referenced column \"extra\" not found in FROM clause!\nCandidate bindings: \"id\", \"v\"\n\nLINE 1: SELECT \"id\", \"v\", \"extra\" FROM \"public\".\"a\" LIMIT 0\n                                ^";
  const got = { stderr: textEntry("[sync] ERROR: ", `public.a: the changes could not be applied: ${duck}`) };
  assert.equal(got.stderr, "[sync] ERROR: public.a: the changes could not be applied: Binder Error: Referenced column \"extra\" not found in FROM clause!\n" +
    "    Candidate bindings: \"id\", \"v\"\n" +
    "    LINE 1: SELECT \"id\", \"v\", \"extra\" FROM \"public\".\"a\" LIMIT 0\n" +
    "                                    ^\n");
  // read back as a log reader reads it: ONE entry, carrying every line of the reason
  const entries: LogEntry[] = [];
  const j = new JsonLines("mason", (l) => entries.push(JSON.parse(l) as LogEntry), {});
  j.push("stderr", got.stderr);
  j.end();
  assert.equal(entries.length, 1, JSON.stringify(entries));
  for (const part of ["Referenced column \"extra\"", "Candidate bindings", "LINE 1: SELECT"]) assert.ok(entries[0]!.msg.includes(part), part);
});
