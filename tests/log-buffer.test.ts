/**
 * The run's log in memory (src/lib/log-buffer.ts): bounded, in order, a multi-line entry ONE entry exactly as `textEntry`
 * writes it, and the file's parser giving the same `{ at, text }` — so `mason logs --json` and GET /api/logs agree.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { textEntry } from "../src/lib/log.ts";
import { newConfig, writeConfig } from "../src/cli/project.ts";

type Mod = typeof import("../src/lib/log-buffer.ts");
// imported when the tests run: the file loads at a commit without the module, and its tests fail by name
const mod = await import("../src/lib/log-buffer.ts" as string).catch(() => ({})) as Partial<Mod>;
function need<K extends keyof Mod>(k: K): Mod[K] {
  const v = mod[k];
  if (v === undefined) assert.fail(`src/lib/log-buffer.ts has no ${k}`);
  return v as Mod[K];
}
const at = (n: number): string => `2026-10-24T10:00:${String(n).padStart(2, "0")}.000Z`;

test("the buffer keeps the last N entries, oldest first, and drops the oldest", () => {
  const b = new (need("LogBuffer"))(3);
  for (let i = 0; i < 5; i++) b.push(textEntry(`${at(i)} `, `[sync] line ${i}`));
  assert.deepEqual(b.recent({ lines: 10 }).map((l) => l.text), ["[sync] line 2", "[sync] line 3", "[sync] line 4"]);
  assert.deepEqual(b.recent({ lines: 2 }).map((l) => l.text), ["[sync] line 3", "[sync] line 4"], "the last ones");
  assert.deepEqual(b.recent({ lines: 0 }), []);
  assert.equal(b.capacity, 3);
  assert.ok(need("LOG_KEPT") >= 1000, "the run's default keeps a useful window");
});

test("a multi-line entry, as textEntry writes it, is ONE entry with its lines indented; since keeps only later entries", () => {
  const b = new (need("LogBuffer"))();
  b.push(textEntry(`${at(1)} `, "[sync] copy failed\nBinder Error: no column\n\nLINE 1: select x"));
  b.push(textEntry(`${at(2)} `, "[sync] retry"));
  assert.deepEqual(b.recent({ lines: 10 }), [
    { at: at(1), text: "[sync] copy failed\n    Binder Error: no column\n    LINE 1: select x" },
    { at: at(2), text: "[sync] retry" },
  ]);
  assert.deepEqual(b.recent({ lines: 10, since: at(1) }).map((l) => l.at), [at(2)]);
});

test("the file's parser gives the buffer's entries: one shape for mason logs and /api/logs; a line with no time has at null", () => {
  const first = textEntry(`${at(1)} `, "[a] one\ntwo");
  const second = textEntry(`${at(2)} `, "[b] three");
  const b = new (need("LogBuffer"))();
  b.push(first); b.push(second);
  assert.deepEqual(need("logEntries")(first + second), b.recent({ lines: 10 }));
  assert.deepEqual(need("logEntries")("Starting\n  step one\n", { perLine: true }), [{ at: null, text: "Starting" }, { at: null, text: "  step one" }]);
  // a terminal's text (dev.log) keeps its blank lines; the log (mason.log) has no blank entry
  assert.deepEqual(need("logEntries")("Starting\n\n  step one\n\n", { perLine: true }), [{ at: null, text: "Starting" }, { at: null, text: "" }, { at: null, text: "  step one" }, { at: null, text: "" }]);
  assert.deepEqual(need("logEntries")(`${first}\n${second}\n\n`), b.recent({ lines: 10 }), "no blank entry in the log");
  assert.equal(need("logLineText")({ at: at(1), text: "[a] x" }), `${at(1)} [a] x`);
});

test("mason logs --json prints the file's entries as { at, text }, a multi-line one whole, -n counting entries", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-logs-"));
  try {
    writeConfig(path.join(dir, ".mason"), newConfig("shop", "mason", false));
    fs.writeFileSync(path.join(dir, ".mason", "mason.log"), textEntry(`${at(1)} `, "[a] one") + textEntry(`${at(2)} `, "[b] two\nmore"));
    const r = spawnSync(process.execPath, [path.resolve("src/cli/main.ts"), "logs", "--json", "-n", "1"], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout) as { lines: unknown };
    assert.deepEqual(j.lines, [{ at: at(2), text: "[b] two\n    more" }]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("mason logs --start prints dev.log as written, its blank lines too", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-logs-"));
  try {
    writeConfig(path.join(dir, ".mason"), newConfig("shop", "mason", false));
    fs.writeFileSync(path.join(dir, ".mason", "dev.log"), "Starting\n\n  step one\n\nReady\n");
    const r = spawnSync(process.execPath, [path.resolve("src/cli/main.ts"), "logs", "--start"], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "Starting\n\n  step one\n\nReady\n");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
