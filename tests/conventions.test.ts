/**
 * Executable conventions.
 *
 * CLAUDE.md's "never swallow an error" rule is prose, and prose has no test.
 * It said "no bare `.catch(() => {})`" from the day it was written, and the
 * repo still went from one swallowed rejection to three — the as-of probe in
 * one of the ClickHouse stack's example dashboards, which this was cut from,
 * was copied into two others, empty handler included (fixed in #63). Nothing objected,
 * because nothing was looking.
 *
 * So this is the one convention that now fails CI instead of being remembered.
 * It is deliberately NARROW — see `swallowedRejections` — and it is not a
 * substitute for reading the rule: it catches the copy-paste case, which is
 * the case that actually happened, twice.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { execFileSync } from "node:child_process";
import ts from "typescript";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");

/** The shipped code: what the guards below hold to their conventions. */
const SCANNED_DIRS = ["src", "scripts"];
/**
 * The swallow guard reads the tests too. A swallowed rejection in a test hides
 * a failure as well as one in the product does (review of PR #511: a fake
 * server's close swallowed, which could hold its port into the next test), so
 * `tests/` is scanned for it — all but this file, whose negative controls must
 * be free to contain the very pattern being banned.
 */
const SWALLOW_DIRS = [...SCANNED_DIRS, "tests"];
const NOT_SCANNED = new Set(["tests/conventions.test.ts"]);
const SCANNED_EXTS = [".ts", ".js", ".html"];

/**
 * Promise rejection handlers that DISCARD the error, as `file:line` hits.
 *
 * Narrow on purpose, in both directions:
 *
 *  - It matches only a handler passed to `.catch(...)` whose body is empty or a
 *    bare constant — the arrow and `function` forms, with or without a
 *    parameter, with or without space between the braces. `() => null` is the
 *    same swallow as `() => {}` spelled differently (review of PR #511: two in
 *    an integration test of the stack this was cut from outlived a guard that knew
 *    one spelling).
 *  - It does NOT match `catch {}` / `catch (e) {}` STATEMENT blocks. Three of
 *    those guarded `localStorage` in the ClickHouse stack's web UI, where the
 *    failure has an obviously safe default (no stored theme -> the default theme) and
 *    CLAUDE.md explicitly allows that shape. Banning them here would make the
 *    guard's first act a false positive, and a gate that cries wolf is a gate
 *    people delete.
 *
 * What it therefore cannot see: a handler whose body is `{ /* ignore *\/ }`, or
 * one that assigns to a variable nobody reads. Those need the human rule.
 */
export function swallowedRejections(src: string): number[] {
  const discarded = String.raw`(?:\{\s*\}|null|undefined|void 0|false|true|0|""|'')`;
  const re = new RegExp(
    String.raw`\.catch\(\s*(?:\(\s*\w*\s*\)|\w+)\s*=>\s*${discarded}\s*\)|\.catch\(\s*function\s*\([^)]*\)\s*\{\s*\}\s*\)`,
    "g",
  );
  const lines: number[] = [];
  for (const m of src.matchAll(re)) {
    lines.push(src.slice(0, m.index).split("\n").length);
  }
  return lines;
}

/** Every scanned file, as `{ name, src }`, discovered by walk rather than listed. */
function scannedFiles(dirs: string[] = SCANNED_DIRS): Array<{ name: string; src: string }> {
  const out: Array<{ name: string; src: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (SCANNED_EXTS.includes(path.extname(entry.name)) && !NOT_SCANNED.has(rel)) {
        out.push({ name: rel, src: fs.readFileSync(path.join(ROOT, rel), "utf8") });
      }
    }
  };
  for (const dir of dirs) walk(dir);
  return out;
}

test("the swallow guard has files to scan", () => {
  // A walk that matched nothing would pass silently — the exact defect
  // CLAUDE.md warns about: a check that cannot tell "no" from "couldn't tell".
  const files = scannedFiles();
  assert.ok(files.length >= 10,
    `expected to scan at least 10 files under ${SCANNED_DIRS.join(", ")}, got ${files.length}`);
  assert.ok(files.some((f) => f.name.endsWith(".ts")),
    "expected at least one .ts file in the scan");
});

test("no promise rejection is swallowed by an empty handler", () => {
  const hits: string[] = [];
  const files = scannedFiles(SWALLOW_DIRS);
  assert.ok(files.some((f) => f.name.startsWith("tests/")), "the swallow guard reads tests/ too");
  for (const { name, src } of files) {
    for (const line of swallowedRejections(src)) hits.push(`${name}:${line}`);
  }
  assert.deepEqual(hits, [],
    `empty .catch() handler(s) — a failure here reports success. Handle it, or ` +
    `catch it narrowly with the reason in a comment (CLAUDE.md, "Never swallow ` +
    `an error"):\n  ${hits.join("\n  ")}`);
});

test("the swallow guard would catch the real thing", () => {
  // Negative controls. A guard that cannot fail is not a guard — and this one
  // exists precisely because the banned pattern got copied twice unnoticed.
  const bad = [
    "loadAsOf().catch(() => {});",
    "loadAsOf().catch(()=>{});",
    "loadAsOf().catch(() => { });",
    "loadAsOf().catch(err => {});",
    "loadAsOf().catch((e) => {});",
    "loadAsOf().catch(function () {});",
    "loadAsOf().catch(function (e) { });",
    "loadAsOf().catch(() => null);",
    "loadAsOf().catch((e) => undefined);",
    "loadAsOf().catch(() => false);",
    "loadAsOf().catch(() => void 0);",
  ];
  for (const src of bad) {
    assert.deepEqual(swallowedRejections(src), [1], `should have flagged: ${src}`);
  }
});

test("the swallow guard leaves handled rejections and safe-default blocks alone", () => {
  const good = [
    // A handler that does something is the point of the rule, not a violation.
    "loadAsOf().catch((err) => { banner(err.message); });",
    "loadAsOf().catch((err) => report(err));",
    "loadAsOf().catch(() => nullResult(1));",
    // Statement-form catch blocks are out of scope: a localStorage read with a
    // safe default is the blessed case.
    'try { localStorage.getItem("k"); } catch {}',
    "try { f(); } catch (e) {}",
  ];
  for (const src of good) {
    assert.deepEqual(swallowedRejections(src), [], `should NOT have flagged: ${src}`);
  }
});

/**
 * THE SECOND EXECUTABLE CONVENTION, and it is here for the same reason as the
 * first: the rule already existed and nothing was looking.
 *
 * The ClickHouse stack's model graph module carried committed merge-conflict markers from
 * b007d33 ("Merge main (#42, #66, #67, #68) into the model-format
 * rename") — a conflict resolved incompletely and pushed. Every gate stayed
 * GREEN for a day: the markers landed inside a `/** *&#47;` doc comment, so
 * `tsc` never saw them, `node --test` never saw them, and the golden fixture
 * never saw them because comments emit no SQL. The damage was real anyway —
 * one function's documentation had been replaced by another's, and
 * `validateFrom` still described a `from:` key renamed to `sql_table:`.
 *
 * A conflict marker in a comment is exactly the shape of defect this repo
 * keeps re-learning: a check that looks like a check and is not. Text is the
 * artefact here, so text is what gets tested.
 */
const CONFLICT_MARKER_RE = /^(<{7}|={7}|>{7})(\s|$)/;

/** Conflict-marker lines in `src`, 1-indexed. */
export function conflictMarkers(src: string): number[] {
  return src.split("\n")
    .map((line, i) => (CONFLICT_MARKER_RE.test(line) ? i + 1 : 0))
    .filter((n) => n > 0);
}

test("no source file carries a committed merge-conflict marker", () => {
  const hits: string[] = [];
  for (const { name, src } of scannedFiles()) {
    for (const line of conflictMarkers(src)) hits.push(`${name}:${line}`);
  }
  assert.deepEqual(hits, [],
    "merge-conflict markers are committed here — resolve the conflict:\n  " +
    hits.join("\n  "));
});

test("the conflict-marker guard would catch the real thing, comments included", () => {
  // Verbatim shape of what sat on main, doc comment and all.
  const real = [
    "/**",
    "<<<<<<< HEAD",
    " * Guard `sql_table:`, which is interpolated verbatim into the compiled SQL.",
    "=======",
    " * The two hashes a model needs: one for everything it materializes.",
    " */",
    "export function modelHashes() {}",
    ">>>>>>> origin/main",
  ].join("\n");
  assert.deepEqual(conflictMarkers(real), [2, 4, 8]);
});

test("the conflict-marker guard leaves lookalikes alone", () => {
  const good = [
    // A rule of equals signs is a section divider, not a conflict — and this
    // repo's own comments are full of them.
    "// ============================== API client ==============================",
    "const shift = a >>> 7;",
    "if (a <<< b) {}",
    "const md = '======= not a marker';",
    // Seven characters but not at line start: a marker is always column 0.
    "  <<<<<<< indented is git's own output, not a file git wrote",
  ].join("\n");
  assert.deepEqual(conflictMarkers(good), []);
});

/**
 * `ops`' three ReplacingMergeTree tables read WITHOUT `FINAL`, as `file:line`.
 *
 * WHY THIS IS A TEST AND NOT A NOTE. CLAUDE.md has said "read
 * ops.bootstrap_state — a ReplacingMergeTree — with FINAL" since the day a
 * poll loop got BOTH the old and the new hash row, took the first, and
 * reported a successful rebuild as failed. That is the whole failure mode:
 * omitting FINAL does not error, it returns a superseded row, so the answer
 * is confidently wrong and nothing looks broken. Prose cannot catch it; a
 * grep can, and every read of these tables is one line of SQL.
 *
 * Deliberately narrow, like the handler check above:
 *
 *  - Only the three DEDUPING tables. `ops.jobs`, `ops.dirty_partitions` and
 *    `ops.api_requests` are append-only or aggregating and are read by
 *    GROUP BY on purpose, so requiring FINAL there would be wrong.
 *  - Only a `FROM` read. `INSERT INTO`, `ALTER TABLE` and
 *    `CREATE TABLE IF NOT EXISTS` name the same table and need no FINAL;
 *    `DELETE FROM` is a write that happens to be spelled with FROM, so it is
 *    excluded by name.
 *  - Both spellings: the literal `ops.bootstrap_state` used in SQL files and
 *    shell, and the interpolated `${OPS_DB}.${STATE_TABLE}` used in TypeScript.
 */
const DEDUPING_TABLES: Array<[string, string]> = [
  ["bootstrap_state", "STATE_TABLE"],
  ["test_results", "TEST_RESULTS_TABLE"],
  ["cdc_state", "CDC_STATE_TABLE"],
  ["winner_recomputes", "WINNER_RECOMPUTES_TABLE"],
];

/**
 * Comments blanked, line count preserved. Needed because this repo documents
 * its SQL in prose: "Parse a plan the runtime read back from
 * ops.bootstrap_state." is an English sentence containing `from
 * ops.bootstrap_state`, and flagging it would make the guard's first act a
 * false positive — the same trap the swallow check above is narrow to avoid.
 * Newlines are kept so a real hit still reports the right line.
 */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, pre: string) => pre + " ".repeat(m.length - pre.length))
    .replace(/--[^\n]*/g, (m) => " ".repeat(m.length));
}

export function finalless(source: string): number[] {
  const text = withoutComments(source);
  const alternatives = DEDUPING_TABLES
    .flatMap(([literal, constant]) => [
      `ops\\.${literal}`,
      `\\$\\{OPS_DB\\}\\.\\$\\{${constant}\\}`,
    ])
    .join("|");
  // (\w+\s+)? captures the word before FROM, so DELETE FROM can be excluded.
  const re = new RegExp(`(\\w+)?\\s*\\bFROM\\s+(?:${alternatives})(\\s+FINAL\\b)?`, "gi");
  const hits: number[] = [];
  for (const m of text.matchAll(re)) {
    if ((m[1] ?? "").toUpperCase() === "DELETE") continue;
    if (m[2] !== undefined) continue;
    hits.push(text.slice(0, m.index).split("\n").length);
  }
  return hits;
}

/**
 * Helpers that address an `ops` table, called with the ANALYTICS database.
 *
 * WHY THIS ONE IS EASY TO GET WRONG. These functions take the database as an
 * argument, so the call site contains no table name at all —
 * `jobsTableDdl(ANALYTICS_DB)` reads perfectly and silently creates
 * `analytics.jobs`, a second empty ledger that the scheduler then admits
 * against. Moving the six tables into `ops` missed exactly seven such call
 * sites, and no name-based search could see them; a live run found them by
 * creating the wrong table. Nothing else in the sweep had that property.
 *
 * The functions listed here read or write ONLY `ops` tables, so the analytics
 * database is never a legitimate argument to any of them.
 */
const OPS_HELPERS = [
  "jobsTableDdl", "jobEventSql", "jobStateSql", "reservationsSql", "jobHistorySql",
  "dirtyTableDdl", "dirtyMvDdl", "dirtyBatchesSql", "unknownRowsSql", "lateRowsTestSql",
];

export function opsHelperWithAnalyticsDb(source: string): number[] {
  const text = withoutComments(source);
  const re = new RegExp(
    `\\b(?:${OPS_HELPERS.join("|")})\\(\\s*(?:ANALYTICS_DB|"analytics"|'analytics')`, "g");
  return [...text.matchAll(re)].map((m) => text.slice(0, m.index).split("\n").length);
}

// ---------------------------------------------------------------- .env under the environment
// `set -a; . ./.env; set +a` in a wrapper script lets `.env` OVERWRITE what the shell carries, where a
// deployment's settings live in the shell: a script sourced that way once dropped one deployment's data
// under another's shell. src/lib/dotenv.ts is the one reader: the environment first, `.env` for the rest.
export function dotenvSourced(src: string): number[] {
  const out: number[] = [];
  src.split("\n").forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    if (/(^|[\s;])(\.|source)\s+(\.\/)?\.env\b/.test(line)) out.push(i + 1);
  });
  return out;
}

/**
 * EVERY RELATIVE IMPORT RESOLVES — including the ones `tsc` never sees. tsconfig includes `src/`, `scripts/` and
 * `tests/`, so a `.mjs` tool or anything else outside those can import a path that no longer exists and nothing
 * objects until someone runs it (a layout move once pointed a tool's import at a folder that was gone). Reads the
 * COMMITTED tree (`git ls-files`).
 */
export function relativeImports(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g)) out.push(m[1]!);
  return out;
}

test("every relative import in a tracked .ts / .mjs file resolves to a file", () => {
  const files = execFileSync("git", ["ls-files", "-z", "*.ts", "*.mjs"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
  assert.ok(files.length >= 100, `expected at least 100 tracked .ts/.mjs files, got ${files.length}`);
  const missing: string[] = [];
  // this file is skipped: the negative control below holds imports of files that do not exist, on purpose
  for (const f of files.filter((x) => x !== "tests/conventions.test.ts")) {
    for (const spec of relativeImports(fs.readFileSync(path.join(ROOT, f), "utf8"))) {
      if (!fs.existsSync(path.resolve(ROOT, path.dirname(f), spec))) missing.push(`${f}: ${spec}`);
    }
  }
  assert.deepEqual(missing, [], "relative imports that resolve to nothing:\n  " + missing.join("\n  "));
});

test("the import guard reads static and dynamic imports, and nothing else", () => {
  assert.deepEqual(relativeImports(`import { a } from "./a.ts";\nimport "../b.mjs";\nconst c = await import('./c.ts');\nconst u = "./not-an-import.ts";`),
    ["./a.ts", "../b.mjs", "./c.ts"]);
});

// ------------------------------------------------------------------ column names in SQL text

test("no test replaces process.stdout across an await: the runner reports through it, and a swallowed report hides a failure", () => {
  // tests of mason init and mason rm replaced process.stdout.write around `await`ed commands; each file's
  // runner speaks to the parent through the child's stdout, so the results of tests that ended meanwhile went into the
  // capture — 15 tests ran and 10 were reported, and a failing one would have been reported by nobody. A command takes an
  // `io` (src/cli/command.ts Io) instead; a capture around SYNCHRONOUS code (tests/log.test.ts) cannot interleave.
  const allowed = new Set(["tests/log.test.ts", "tests/conventions.test.ts"]);
  const offenders = fs.readdirSync(path.join(ROOT, "tests")).filter((f) => f.endsWith(".ts")).map((f) => `tests/${f}`)
    .filter((f) => !allowed.has(f) && /process\.stdout\.write\s*=(?!=)/.test(fs.readFileSync(path.join(ROOT, f), "utf8")));
  assert.deepEqual(offenders, [], "pass the command an io (src/cli/command.ts) instead of replacing process.stdout");
});

/**
 * A `Next:`, `Try:` or `Tip:` a command writes itself, outside src/cli/command.ts's nextBlock / endText — or a nextBlock
 * spliced onto the end of a line (`…${nextBlock(…)}`), which loses the blank line before it: withEnd puts it there.
 */
export function ownEndings(text: string): string[] {
  return [...text.matchAll(/["'`](?:\\n)*\s*(Next|Try|Tip):|[^\s`]\$\{nextBlock\(/g)].map((m) => m[0]);
}

test("every command ends the same way: its tips and what to run next only through nextBlock / endText (src/cli/command.ts)", () => {
  // some commands showed Next as one line, some without the Next prefix and some as a kind of table, where each
  // command must show Next the same way — doctor and init wrote `Next: <a line>`, start
  // a block of its own, the old query command a `Try:` list. One function writes the block now; a command that writes its own
  // is the class come back.
  const dir = path.join(ROOT, "src", "cli");
  const offenders = fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "command.ts")
    .flatMap((f) => ownEndings(fs.readFileSync(path.join(dir, f), "utf8")).map((m) => `src/cli/${f}: ${m}`));
  assert.deepEqual(offenders, [], "print what to run next with nextBlock, a tip with endText (src/cli/command.ts)");
});

test("the endings guard catches the real thing", () => {
  assert.deepEqual(ownEndings('say("Next: mason start")'), ['"Next:']);
  assert.deepEqual(ownEndings('lines.push("", "Try:", ...tries)'), ['"Try:']);
  assert.deepEqual(ownEndings('out(`\\nNext: ${next}`)'), ["`\\nNext:"]);
  assert.deepEqual(ownEndings('out("next: mason wait")'), []);
  assert.deepEqual(ownEndings('out(`Ready.${nextBlock(steps)}`)'), [".${nextBlock("]);
});

/** A colour code written outside src/cli/style.ts (cursor movement — `\x1b[2K`, `\x1b[3F` — is not colour). */
export function ownColours(text: string): string[] {
  return [...text.matchAll(/\\(?:x1b|u001b|033)\[[0-9;]*m/g)].map((m) => m[0]);
}

test("colour is src/cli/style.ts's alone: every command is coloured the same way, and none colours a pipe", () => {
  // colour to make output easier to read and scan — one palette, and only for a person
  // at a terminal (NO_COLOR, --json, a pipe and a coding agent get plain text). A command writing its own code would do
  // neither.
  const dir = path.join(ROOT, "src", "cli");
  const offenders = fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "style.ts")
    .flatMap((f) => ownColours(fs.readFileSync(path.join(dir, f), "utf8")).map((m) => `src/cli/${f}: ${m}`));
  assert.deepEqual(offenders, [], "colour through src/cli/style.ts (styleFor / out / err)");
});

test("the colour guard catches the real thing", () => {
  assert.deepEqual(ownColours('out(`\\x1b[32mok\\x1b[39m`)'), ["\\x1b[32m", "\\x1b[39m"]);
  assert.deepEqual(ownColours('process.stderr.write("\\r\\x1b[2K")'), [], "cursor movement is not colour");
});

/** A failure a command writes itself (`err(\`mason add: …\`)`), outside src/cli/command.ts's failed(); and a JSON answer
 *  printed bare (`out(JSON.stringify(…))`), outside jsonText — which carries next and holds the keys to the spec. */
export function ownFailures(text: string): string[] {
  return [...text.matchAll(/\b(?:err|io\.err|process\.stderr\.write)\((?:`|")mason(?: \$\{[^}]+\}| \w+)?: |\b(?:out|say|io\.out|process\.stdout\.write)\(JSON\.stringify\(/g)].map((m) => m[0]);
}

test("every failure and every --json answer has one shape: failed() and jsonText() (src/cli/command.ts), never a command's own", () => {
  // a person wants short, scannable responses; a coding agent unambiguous, machine-readable ones —
  // so a failure is what / why / fix / next, in JSON under --json, and an answer is an object with next and only the
  // keys its spec declares. A command writing `mason x: …` to stderr, or JSON.stringify to stdout, is the class come back.
  const dir = path.join(ROOT, "src", "cli");
  const offenders = fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "command.ts")
    .flatMap((f) => ownFailures(fs.readFileSync(path.join(dir, f), "utf8")).map((m) => `src/cli/${f}: ${m}`));
  assert.deepEqual(offenders, [], "a failure through failed(), a JSON answer through jsonText() (src/cli/command.ts)");
});

test("the failure guard catches the real thing", () => {
  assert.deepEqual(ownFailures('err(`mason add: ${t}`)'), ["err(`mason add: "]);
  assert.deepEqual(ownFailures('process.stderr.write(`mason ${cmd.name}: ${p.problem}\\n`)'), ["process.stderr.write(`mason ${cmd.name}: "]);
  assert.deepEqual(ownFailures('io.err("mason add: no table")'), ['io.err("mason add: ']);
  assert.deepEqual(ownFailures('out(JSON.stringify(results, null, 2))'), ["out(JSON.stringify("]);
  assert.deepEqual(ownFailures('say(`  stopping Mason for ${run.name}`)'), [], "progress is not a failure");
  assert.deepEqual(ownFailures('shellWord(JSON.stringify(payload))'), [], "JSON inside a line is not an answer");
});

/** Every `process.exit(` in a file's text, as its line numbers. */
export function exits(text: string): number[] {
  return [...text.matchAll(/\bprocess\.exit\(/g)].map((m) => text.slice(0, m.index).split("\n").length);
}

test("the mason command exits only once what it wrote has reached the reader (src/lib/exit-when-written.ts)", () => {
  // #435: `mason status --json | jq` read 65,536 bytes of 138,668 — process.exit on a pipe drops what is still queued, so
  // an agent parsing the answer got half of it. One exit waits for both streams; a second process.exit is the class
  // back. An exit at module load, before anything is written, says so on its line ("before anything else is written").
  const files = fs.readdirSync(path.join(ROOT, "src", "cli")).filter((f) => f.endsWith(".ts")).map((f) => `src/cli/${f}`);
  const offenders = files.flatMap((f) => {
    const lines = fs.readFileSync(path.join(ROOT, f), "utf8").split("\n");
    return exits(lines.join("\n")).filter((line) => !lines[line - 1]!.includes("before anything else is written")).map((line) => `${f}:${line}`);
  });
  assert.deepEqual(offenders, [], "exit through exitWhenWritten (src/lib/exit-when-written.ts), or set process.exitCode and return");
});

test("the exit guard finds the real thing", () => {
  assert.deepEqual(exits("main().then((code) => process.exit(code));"), [1]);
  assert.deepEqual(exits("a\nprocess.exitCode = 1;\nprocess.exit(2)"), [3]);
});

// ------------------------------------------------------------------ the latest value, NULL included

/** Each branch of each `tokio::select!` in a Rust source, as `{ line, future }` (the text between `=` and `=>`). */
export function selectBranches(src: string): Array<{ line: number; future: string }> {
  const out: Array<{ line: number; future: string }> = [];
  for (const m of src.matchAll(/tokio::select!\s*\{/g)) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    const start = i + 1;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) break;
    }
    const body = src.slice(start, i);
    const base = src.slice(0, start).split("\n").length;
    body.split("\n").forEach((l, n) => {
      const b = /^\s*(?:\w+|_)\s*=\s*(.+?)\s*=>/.exec(l);
      if (b) out.push({ line: base + n, future: b[1]! });
    });
  }
  return out;
}

/** the lines of `src` that make a PlannedSql (a cast to it) */
function plannedCasts(src: string): number[] {
  const lines: number[] = [];
  for (const m of src.matchAll(/\bas\s+PlannedSql\b|<PlannedSql>/g)) lines.push(src.slice(0, m.index).split("\n").length);
  return lines;
}

test("DuckDB runs only planned SQL: a PlannedSql is made in src/duck/plan.ts alone, after the read-back", () => {
  // review finding: an EXPLAIN's text ran on DuckDB as written, and EXPLAIN ANALYZE ran the write under it.
  // A session's runner takes a PlannedSql only (src/api/postgres/server.ts DuckRunner.run); a cast anywhere else
  // would hand it a statement's text again
  const hits = scannedFiles(["src"]).filter((f) => f.name !== "src/duck/plan.ts").flatMap((f) => plannedCasts(f.src).map((l) => `${f.name}:${l}`));
  assert.deepEqual(hits, [], "a PlannedSql made outside src/duck/plan.ts: plan the statement instead");
  const plan = fs.readFileSync(path.join(ROOT, "src/duck/plan.ts"), "utf8");
  assert.equal(plannedCasts(plan).length, 1, "src/duck/plan.ts makes a PlannedSql once, where the read-back has passed");
  assert.ok(plan.indexOf("as PlannedSql") > plan.indexOf("treeDifference(back, tree)"), "the PlannedSql is made after the read-back");
});

/** the lines of `src` that decide whether a statement calls a Mason function by reading its text for `__mason_` */
function textClassified(src: string): number[] {
  const lines: number[] = [];
  for (const m of src.matchAll(/\.(?:includes|indexOf)\(\s*["'`]__mason_["'`]\s*\)|\.match\(\s*\/[^/\n]*__mason_/g)) lines.push(src.slice(0, m.index).split("\n").length);
  return lines;
}

test("whether a statement calls a Mason function is its plan's (PlannedSql.functions), never read off its text", () => {
  // review finding: `sql.includes("__mason_")` took the view of a copy's visible columns and a stored path's
  // column for calls, and every `SELECT *` over such a copy could no longer be timed out or cancelled
  // (src/duck/rewrite.ts masonCalls reads the TREE; tests/duck-corpus.test.ts holds it equal to the calls in the text)
  const hits = scannedFiles(["src"]).flatMap((f) => textClassified(f.src).map((l) => `${f.name}:${l}`));
  assert.deepEqual(hits, [], "read the plan's `functions` instead");
  assert.deepEqual(textClassified('const calls = sql.includes("__mason_");\nconst f = sql.match(/\\b__mason_[a-z]+/g);'), [1, 2]);
  // a function's NAME is the rewrite's to test (src/duck/rewrite.ts fn, masonCalls): not a statement's text
  assert.deepEqual(textClassified('if (name.startsWith("__mason_")) x();'), []);
});

test("the planned-SQL guard would catch the real thing", () => {
  assert.deepEqual(plannedCasts("const a = 1;\nawait runner.run(t.sql as PlannedSql, [], s, signal);"), [2]);
  assert.deepEqual(plannedCasts("run(<PlannedSql>text)"), [1]);
  assert.deepEqual(plannedCasts("import type { PlannedSql } from './plan.ts'; run(sql: PlannedSql)"), []);
});

/**
 * ONE DEFINITION OF A `#>` PATH ELEMENT THAT IS AN ARRAY INDEX (src/duck/functions.ts `pathIndex`; a review finding):
 * the function read `+1` as a key and `1 ` as an index where Postgres's strtoint reads the reverse, and the
 * native read (src/duck/rewrite.ts jsonGet) had copied its regular expression, so a fix to one would have parted the
 * two. Each must ask pathIndex, and test no element against a pattern of digits of its own.
 */
const ownIndexPattern = (body: string): string[] =>
  [...body.matchAll(/\/[^/\n]*(?:\\d|\[0-9\])[^/\n]*\/[a-z]*\.test\((?:s|s\.either|element)\)/g)].map((m) => m[0]);
const functionBody = (file: string, start: string): string => {
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");
  const at = src.indexOf(start);
  assert.ok(at >= 0, `${file} has no ${start}`);
  return src.slice(at, src.indexOf("\n}\n", at));
};

test("a #> path element is an array index by ONE definition: the function's step and the native read both ask pathIndex", () => {
  for (const [file, start] of [["src/duck/functions.ts", "function step("], ["src/duck/rewrite.ts", "function jsonGet("]] as const) {
    const body = functionBody(file, start);
    assert.match(body, /\bpathIndex\(/, `${file} ${start}…): an element read as an index must ask pathIndex`);
    assert.deepEqual(ownIndexPattern(body), [], `${file} ${start}…): an element tested against a pattern of its own`);
  }
});

test("the index guard would catch the real thing", () => {
  assert.equal(ownIndexPattern("else { if (!/^\\s*-?\\d+\\s*$/.test(s.either)) return null; i = Number(s.either); }").length, 1);
  assert.equal(ownIndexPattern("if (typeof s !== \"string\" || (either && /^\\s*-?\\d+\\s*$/.test(s)) || /[\\u0000-\\u001f]/.test(s)) return call;").length, 1);
  assert.deepEqual(ownIndexPattern("if (keys.some((k) => /^\\d+$/.test(k))) {"), []);
});

/**
 * WHAT A PROJECT COPIES IS ITS SOURCES FILE, NEVER A FOLDER OF MODEL FILES (there is no concept of models, only a
 * `sources` folder). The folder an older Mason listed a project's tables in is read by
 * nothing — src/cli/sources.ts names it once (`OLD_TABLES_DIR`), to refuse such a project with the way out — and no
 * `--json` answer of the CLI names a model: a key `model`/`models` in a command's declared keys or in an object it
 * answers with is the concept come back.
 */
export function modelsPaths(text: string): string[] {
  return [...text.matchAll(/\bmodels\/|["'`]models["'`]/g)].map((m) => m[0]);
}
export function modelKeys(text: string): string[] {
  return [...text.matchAll(/^\s*json:\s*\[[^\]]*["']models?["'][^\]]*\]|(?<![\w.])models?\??:\s*(?![\s:])/gm)].map((m) => m[0].trim());
}
const NAMES_THE_OLD_FOLDER = new Set(["src/cli/sources.ts"]);

test("an older Mason's models/ folder is named once, to refuse it, and no CLI --json shape names a model", () => {
  const files = scannedFiles(["src"]);
  assert.ok(files.some((f) => f.name.startsWith("src/cli/")), "the guard has the CLI to scan");
  const paths = files.filter((f) => !NAMES_THE_OLD_FOLDER.has(f.name)).flatMap((f) => modelsPaths(f.src).map((m) => `${f.name}: ${m}`));
  assert.deepEqual(paths, [], "the tables a project copies are its sources file's (src/cli/sources.ts), which names the old folder once (OLD_TABLES_DIR)");
  const keys = files.filter((f) => f.name.startsWith("src/cli/")).flatMap((f) => modelKeys(f.src).map((m) => `${f.name}: ${m}`));
  assert.deepEqual(keys, [], "a --json answer says table or source, never model");
});

test("the models guard catches the real thing", () => {
  assert.deepEqual(modelsPaths('const dir = path.join(folder, "models");'), ['"models"']);
  assert.deepEqual(modelsPaths("written to mason/models/orders.yml"), ["models/"]);
  assert.deepEqual(modelsPaths('path.join(folder, "sources")'), []);
  assert.deepEqual(modelKeys('  json: ["database", "models", "next"],'), ['json: ["database", "models", "next"]']);
  assert.deepEqual(modelKeys("return { model: t.name, file };"), ["model:"]);
  assert.deepEqual(modelKeys("  models?: string[];"), ["models?:"]);
  assert.deepEqual(modelKeys("return { table: t.source, file }; // a modeller's: model::text is no key"), []);
  assert.deepEqual(modelKeys("const x = t.model; f(a ? model : b)"), []);
});

/**
 * A PATH A COMMENT OR A DOC NAMES EXISTS IN THIS TREE (the cut to a public repository): this product was cut
 * from a larger stack on ClickHouse, and 61 comments and docs still named its files (its service, its compiler, its web
 * UI, its design history) — a path to nothing for a reader who has only this tree. Every `src/`, `tests/`, `scripts/`,
 * `docs/` or `examples/` path ending in .ts, .mjs, .js, .md, .yml, .json, .html, .sh or .sql, in a tracked file under
 * the folders below, must exist. A path inside a URL or after `../` is not one (`https://www.postgresql.org/docs/current/…`
 * is Postgres's documentation; a relative import is tsc's and the import guard's). Say what the gone thing WAS instead.
 */
const PATH_SCANNED = ["src", "tests", "scripts", "docs", ".claude", "README.md", "CLAUDE.md", "cli", "deploy"];
/** Paths named on purpose that are not files here, each with its reason. None today. */
const PATH_EXCEPTIONS: ReadonlyMap<string, string> = new Map();
export function namedPaths(text: string): Array<{ line: number; path: string }> {
  const re = /(?<![\w./-])(?:src|tests|scripts|docs|examples)\/[A-Za-z0-9_./-]+\.(?:ts|mjs|js|md|yml|json|html|sh|sql)\b/g;
  return text.split("\n").flatMap((l, i) => [...l.matchAll(re)].map((m) => ({ line: i + 1, path: m[0] })));
}

test("a path a comment or a doc names exists in this tree", () => {
  const files = execFileSync("git", ["ls-files", "-z", ...PATH_SCANNED], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
  assert.ok(files.length >= 100, `expected at least 100 tracked files, got ${files.length}`);
  const missing = files.flatMap((f) => namedPaths(fs.readFileSync(path.join(ROOT, f), "utf8"))
    .filter((p) => !PATH_EXCEPTIONS.has(p.path) && !fs.existsSync(path.join(ROOT, p.path)))
    .map((p) => `${f}:${p.line} ${p.path}`));
  assert.deepEqual(missing, [], "a path to nothing: say what the referenced thing was, or drop the aside — never leave the path");
});

test("the path guard would catch the real thing", () => {
  const gone = "src/" + "mason.ts", doc = "docs/history/" + "PLAN.md";
  assert.deepEqual(namedPaths(`// read at the start (${gone} readConfig)\n * (${doc} §4.7)`).map((p) => p.path), [gone, doc]);
  assert.deepEqual(namedPaths("see `" + "tests/" + "x.test.ts`").length, 1);
  assert.deepEqual(namedPaths("https://www.postgresql.org/docs/" + "current/protocol.html"), [], "a URL's path is not one");
  assert.deepEqual(namedPaths('import { a } from "../src/' + 'lib/a.ts";'), [], "a relative import is not one");
});

/**
 * The lines of a TypeScript `src` where a STRING (a message, a log line, a JSON value, a hint) names the engine:
 * "Nothing a user sees is named for DuckDB" (CLAUDE.md "Who this is for"). Comments, identifiers and imports are the
 * code's; inside a string, the engine's own names are too when they are PART of one token: SQL it defines
 * (`duckdb_memory()`), a setting (`MASON_DUCKDB_MEMORY`), a path (`~/.duckdb/extensions`), a package (`@duckdb/node-api`),
 * a label that is hashed (`mason-duckdb-postgres:`); and the whole string "duckdb" is a tag the code switches on.
 */
function engineNamedInStrings(src: string): number[] {
  const sf = ts.createSourceFile("x.ts", src, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const named = (text: string): boolean => text !== "duckdb" && /(?<![A-Za-z0-9_@./-])duck ?db(?![A-Za-z0-9_])/i.test(text);
  const visit = (n: ts.Node): void => {
    const text = ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) ? n.text : null;
    if (text !== null && named(text) && !ts.isImportDeclaration(n.parent) && !ts.isExportDeclaration(n.parent) && !ts.isExternalModuleReference(n.parent)) {
      lines.push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return lines;
}

test("no string a user can see names the engine: a message, a log line or a JSON value says 'the copy'", () => {
  const hits = scannedFiles(["src"]).filter((f) => f.name.endsWith(".ts")).flatMap((f) => engineNamedInStrings(f.src).map((l) => `${f.name}:${l}`));
  // docs/SQL-SUPPORT.md renders src/duck/gaps.ts, and a doc may name the engine: its registry text is not scanned
  assert.deepEqual(hits.filter((h) => !h.startsWith("src/duck/gaps.ts:")), [], "a string names the engine: say 'the copy' or 'Mason' (CLAUDE.md: nothing a user sees is named for DuckDB)");
});

test("the engine-name guard catches the real thing, and leaves the engine's own tokens alone", () => {
  assert.deepEqual(engineNamedInStrings("throw new Error(`DuckDB could not open ${f}`);\nconst a = 1;"), [1]);
  assert.deepEqual(engineNamedInStrings("const m = \"a sum past DuckDB's 38 digits\";"), [1]);
  assert.deepEqual(engineNamedInStrings("log(`[duckdb] ${l}`);"), [1]);
  assert.deepEqual(engineNamedInStrings("a(\"SELECT * FROM duckdb_tables()\"); b(process.env.MASON_DUCKDB_MEMORY); c(\"~/.duckdb/extensions\"); d(\"mason-duckdb-postgres:\"); const k = \"duckdb\";"), []);
  assert.deepEqual(engineNamedInStrings("import { DuckDBValue } from \"@duckdb/node-api\"; // DuckDB says\n/* DuckDB */ const DuckDBThing = 1;"), []);
});

/**
 * A LINK IN THE FRONT DOOR RESOLVES (the README's restructure, PR 26): the path guard above reads only `src/`, `tests/`,
 * `scripts/`, `docs/` and `examples/` paths from the root, so a markdown link to `cli/README.md`, `SECURITY.md` or
 * `LICENSE`, a link from `docs/` relative to its own folder, and every `#anchor` went unchecked — a broken
 * `[BENCHMARK.md](BENCHMARK.md)` passed. Every relative `](target)` (and an image's src / srcset) in the files below,
 * outside code fences, must name a file that exists from the linking file's folder, and its `#anchor` a heading of the
 * target as GitHub makes anchors of them.
 */
const LINKS_SCANNED = ["README.md", "docs/MEASUREMENTS.md", "docs/SQL-SUPPORT.md"];

/** a markdown text's lines outside code fences, with their numbers */
function unfenced(text: string): Array<[number, string]> {
  let fence = false;
  return text.split("\n").flatMap((l, i): Array<[number, string]> => {
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; return []; }
    return fence ? [] : [[i + 1, l]];
  });
}

/** GitHub's anchor for each heading: its text without markup, lower case, punctuation dropped, each space a hyphen; a repeat gets -1, -2 */
export function markdownAnchors(text: string): Set<string> {
  const seen = new Map<string, number>(), out = new Set<string>();
  for (const [, l] of unfenced(text)) {
    const h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(l);
    if (h === null) continue;
    const base = h[1]!.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<[^>]+>/g, "").toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "").replace(/ /g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

/** the links in `text` (the file at `file`, relative to ROOT) that name nothing: `read` gives a file's text, or undefined when there is none */
export function brokenLinks(file: string, text: string, read: (rel: string) => string | undefined): string[] {
  return unfenced(text).flatMap(([line, l]) =>
    [...l.matchAll(/\]\(([^)\s]+)\)/g), ...l.matchAll(/\b(?:src|srcset)="([^"\s]+)"/g)].map((m) => m[1]!)
      .filter((t) => !/^[a-z][a-z0-9+.-]*:/i.test(t))
      .flatMap((t) => {
        const [rel = "", anchor] = t.split("#");
        const target = rel === "" ? file : path.posix.normalize(path.posix.join(path.posix.dirname(file), rel));
        const body = read(target);
        if (body === undefined) return [`${file}:${line} ${t}: no file ${target}`];
        if (anchor === undefined || anchor === "") return [];
        if (!target.endsWith(".md")) return [`${file}:${line} ${t}: an anchor into a file that is not markdown`];
        return markdownAnchors(body).has(anchor) ? [] : [`${file}:${line} ${t}: ${target} has no heading #${anchor}`];
      }));
}

test("a link in the README, docs/MEASUREMENTS.md and docs/SQL-SUPPORT.md resolves, its #anchor too", () => {
  const read = (rel: string): string | undefined => {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) return undefined;
    return fs.statSync(p).isDirectory() ? "" : fs.readFileSync(p, "utf8");
  };
  const broken = LINKS_SCANNED.flatMap((f) => brokenLinks(f, read(f) ?? assert.fail(`${f} is gone`), read));
  assert.deepEqual(broken, [], "a link to nothing: point it at the file or heading that is there");
});

test("the link guard would catch the real thing", () => {
  const files: Record<string, string> = {
    "README.md": "# Mason\n\n## SQL support\n\n## Why Mason\n\n## Why Mason\n\n```yaml\n# not a heading\n```\n",
    "guide/A.md": "# A `doc`: the [first](x.md) one\n",
    "LICENSE": "Apache-2.0",
  };
  const read = (rel: string): string | undefined => files[rel];
  const ok = "[a](#sql-support) [b](#why-mason-1) [c](guide/A.md#a-doc-the-first-one) [d](LICENSE) [e](https://example.com/x) ![f](guide/A.md)";
  assert.deepEqual(brokenLinks("README.md", ok, read), []);
  assert.deepEqual(brokenLinks("guide/A.md", "[r](../README.md#why-mason) [s](A.md)", read), [], "a link from a folder is relative to that folder");
  assert.deepEqual(brokenLinks("guide/A.md", "[b](BENCHMARK.md)\n[l](../LICENSE#x)\n[h](../README.md#not-a-heading)\n[w](#what-of-postgres-is-answered)", read), [
    "guide/A.md:1 BENCHMARK.md: no file guide/BENCHMARK.md",
    "guide/A.md:2 ../LICENSE#x: an anchor into a file that is not markdown",
    "guide/A.md:3 ../README.md#not-a-heading: README.md has no heading #not-a-heading",
    "guide/A.md:4 #what-of-postgres-is-answered: guide/A.md has no heading #what-of-postgres-is-answered",
  ]);
  assert.deepEqual(brokenLinks("README.md", "```\n[x](nothing.md)\n```", read), [], "a link in a code fence is code");
});

/**
 * EVERY REFUSAL ON THE WIRE NAMES ITS REGISTRY ENTRY (CLAUDE.md "Conventions"; src/duck/gaps.ts): the listener refused
 * Postico's SHOW ALL, at every connection, with a bare `PgError` 0A000 that named no gap, so docs/SQL-SUPPORT.md never
 * listed it and the oracle never met it. A `new PgError({ code: "0A000", … })` in src/api/ names its gap (`gapMark(…)`,
 * or `Mason gap <id>` in its words); those that did not when this guard was written are listed by their FULL message
 * text, a ratchet held as a multiset: none is added (a copy of a listed one included), and one fixed or gone is taken
 * off the list.
 *
 * The fields object is read whole, whatever its keys' order or quoting: `new PgError({ … })`, or `new PgError(f)` of a
 * `const f = { … }` before it; its braces matched past string and template literals (a `${f({})}` inside a message)
 * and comments; its code `"0A000"` in any quotes, or a constant of the file whose value is it.
 */
/** the index just past the string or template literal that opens at `i` (a template's `${…}` matched as code) */
function pastLiteral(src: string, i: number): number {
  const q = src[i]!;
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === "\\") { j++; continue; }
    if (src[j] === q) return j + 1;
    if (q === "`" && src[j] === "$" && src[j + 1] === "{") j = pastBraces(src, j + 1) - 1;
  }
  return src.length;
}
/** the index just past the `}` that closes the `{` at `open`, skipping literals and comments */
function pastBraces(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === "`") { i = pastLiteral(src, i) - 1; continue; }
    if (c === "/" && src[i + 1] === "/") { const nl = src.indexOf("\n", i); i = nl < 0 ? src.length : nl; continue; }
    if (c === "/" && src[i + 1] === "*") { const end = src.indexOf("*/", i + 2); i = end < 0 ? src.length : end + 1; continue; }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return src.length;
}
export function bareRefusals(src: string): string[] {
  const constants = [...src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[\w.]+\s*)?=\s*(["'`])0A000\2/g)].map((m) => m[1]!);
  const featureCode = new RegExp(`\\bcode\\s*:\\s*(?:(["'\`])0A000\\1${constants.map((c) => `|${c.replace(/\$/g, "\\$")}\\b`).join("")})`);
  const objects: string[] = [];
  for (const m of src.matchAll(/new PgError\(\s*/g)) {
    const at = m.index + m[0].length;
    if (src[at] === "{") { objects.push(src.slice(at, pastBraces(src, at))); continue; }
    const name = /^[A-Za-z_$][\w$]*/.exec(src.slice(at))?.[0];
    if (name === undefined) continue;
    const made = [...src.slice(0, m.index).matchAll(new RegExp(`\\b(?:const|let|var)\\s+${name.replace(/\$/g, "\\$")}\\s*(?::[^=]+)?=\\s*\\{`, "g"))].at(-1);
    if (made !== undefined) { const open = made.index + made[0].length - 1; objects.push(src.slice(open, pastBraces(src, open))); }
  }
  return objects.filter((o) => featureCode.test(o) && !/gapMark\(|Mason gap [a-z0-9-]/.test(o)).map((o) => {
    const key = /\bmessage\s*:\s*/.exec(o);
    if (key === null) return "(no message)";
    const from = key.index + key[0].length;
    return /["'`]/.test(o[from] ?? "") ? o.slice(from + 1, pastLiteral(o, from) - 1) : `(an expression) ${/^[^,}]*/.exec(o.slice(from))![0].trim()}`;
  });
}
const BARE_REFUSALS_WHEN_GUARDED = [
  "startup options ${JSON.stringify(options)}: only -c name=value is supported",
  "DateStyle ${value} is not supported: this API writes every date and time in ISO 8601 (DateStyle ISO)",
  "extra_float_digits ${n} is not supported: this API sends every float as the shortest text that reads back exactly (Postgres's extra_float_digits >= 1, the default since Postgres 12); fewer digits would be a different number",
  "standard_conforming_strings off is not supported: a string literal is read as Postgres reads it by default",
  "EXPLAIN of this statement is not supported: a SELECT is explained",
  "Mason cannot find the statement this EXPLAIN explains in its text (a Mason gap: report it, with the statement)",
];

test("a statement refused 0A000 by the listener names its gap (src/duck/gaps.ts): no new bare refusal", () => {
  const bare = scannedFiles(["src/api"]).flatMap((f) => bareRefusals(f.src));
  assert.deepEqual([...bare].sort(), [...BARE_REFUSALS_WHEN_GUARDED].sort(), "a refusal that names no gap: register it in src/duck/gaps.ts and name " +
    "it (gapMark), or answer the statement; a listed one that is gone is taken off BARE_REFUSALS_WHEN_GUARDED");
});

test("the bare-refusal guard catches the real thing", () => {
  assert.deepEqual(bareRefusals('if (name === "all") throw new PgError({ code: "0A000", message: "SHOW ALL is not supported: SHOW one parameter" });'), ["SHOW ALL is not supported: SHOW one parameter"]);
  // the spellings a textual pattern missed (the review of #38): each is a bare refusal
  assert.deepEqual(bareRefusals('throw new PgError({ message: "fields in another order", code: "0A000" });'), ["fields in another order"]);
  assert.deepEqual(bareRefusals("throw new PgError({ code: '0A000', message: 'a single-quoted message' });"), ["a single-quoted message"]);
  assert.deepEqual(bareRefusals('const UNSUPPORTED = "0A000";\nthrow new PgError({ code: UNSUPPORTED, message: "a code by a constant" });'), ["a code by a constant"]);
  assert.deepEqual(bareRefusals('const f = { code: "0A000", message: "the fields built first" };\nthrow new PgError(f);'), ["the fields built first"]);
  assert.deepEqual(bareRefusals('throw new PgError({ code: "0A000", hint: "a hint first", message: "a hint between" });'), ["a hint between"]);
  assert.deepEqual(bareRefusals('throw new PgError({\n  code: "0A000", // the user\'s word\n  message: `x ${n}`,\n});'), ["x ${n}"], "a comment and a template");
  // named, or not a feature's refusal: none
  assert.deepEqual(bareRefusals('throw new PgError({ code: "0A000", message: `x is not supported (${gapMark("show-all")})` });'), []);
  assert.deepEqual(bareRefusals('throw new PgError({ code: "0A000", message: "x", detail: "Mason gap explain-option" });'), []);
  assert.deepEqual(bareRefusals('throw new PgError({ code: "0A000", message: `x ${f({})} y`, detail: gapMark("show-all") });'), [], "a } inside the message is no end of the fields");
  assert.deepEqual(bareRefusals('throw new PgError({ code: "22023", message: "a bad value" });'), [], "another SQLSTATE is Postgres's own refusal");
});

/**
 * WHAT A SESSION SAYS A PARAMETER IS, ONE READER (src/api/postgres/server.ts `sessionSetting`; a fact derived in several
 * places): `SHOW <name>`, SHOW ALL's row of that name, the ParameterStatus the startup and every SET / RESET report, and
 * `current_setting(name)` — in the catalog (every request carries `sessionSettings`, catalog.ts asSession) and beside a
 * copied table (`duckSession`, read by src/duck/rewrite.ts `settingRead`) — each read it, so a tool reads one string
 * however it asks (GitHub issues 40, 41: the catalog's `current_setting` was a fourth reader, answering its own values
 * after a SET). `fixedParameter` is called by that reader alone; a request to the catalog that does not carry the
 * session's settings is one of the few that cannot meet a `current_setting` of the session's; and DuckDB's own
 * `current_setting` is read for the TimeZone alone (which the settle sets from the session's).
 */
test("SHOW, SHOW ALL, the reported parameters and current_setting read a parameter through one reader (sessionSetting)", () => {
  const server = "src/api/postgres/server.ts";
  const src = fs.readFileSync(path.join(ROOT, server), "utf8");
  const bodyOf = (start: string): string => {
    const at = src.indexOf(start);
    assert.ok(at >= 0, `${server} has no ${start}`);
    return src.slice(at, src.indexOf("\n  }\n", at));
  };
  // through it alone: no session variable, TLS table or fixed value read beside it
  const beside = /this\.vars\.\w+|\btlsParameters\(|\bfixedParameter\(|\bFIXED\.get\(/g;
  for (const start of ["private async showStatement(", "private async showAll(", "private reportedParameters(", "private async catalogAs(", "private async duckSession("]) {
    const body = bodyOf(start);
    assert.match(body, /this\.sessionSettings?\(/, `${start}…): read the value through sessionSetting`);
    assert.deepEqual([...body.matchAll(beside)].map((m) => m[0]), [], `${start}…): a value read beside sessionSetting`);
  }
  // every setting the session holds, each sessionSetting's: its NAMES may be read from the tables, never a value
  const settings = bodyOf("private sessionSettings(");
  assert.match(settings, /this\.sessionSetting\(/, "sessionSettings reads each value through sessionSetting");
  assert.deepEqual([...settings.matchAll(/this\.vars\.(?!other\.keys\(\))\w+(?:\.\w+)?|\bfixedParameter\(|\bFIXED\.get\(|tlsParameters\([^)]*\)\[/g)].map((m) => m[0]), [], "sessionSettings reads a value beside sessionSetting");
  // every catalog request of a session carries its settings: one that does not is a method named here, each of which
  // reads no current_setting of the session's (a close, a SET's validation, SHOW's own reads, a plan's analysis, the
  // catalog's own settings)
  const enclosing = (at: number): string => [...src.slice(0, at).matchAll(/\n {2}(?:private |readonly |static )*(?:async )?(\w+)\(/g)].at(-1)?.[1] ?? "?";
  const direct = [...new Set([...src.matchAll(/catalog\.run\(/g)].map((m) => enclosing(m.index)))].sort();
  assert.deepEqual(direct, ["catalogAs", "catalogSettings", "duckPlan", "duckValues", "end", "explaining", "showAll", "showStatement", "validateElsewhere"].sort(),
    "a catalog request beside catalogAs: carry the session's settings (catalogAs), or say here why it reads none of them");
  const calls = scannedFiles(["src"]).flatMap((f) => [...f.src.matchAll(/(?<!function )\bfixedParameter\(/g)].map((m) => `${f.name}:${f.src.slice(0, m.index).split("\n").length}`));
  assert.equal(calls.length, 1, `fixedParameter is called by sessionSetting alone: ${calls.join(", ")}`);
  // DuckDB's own current_setting is the TimeZone's alone (the session's, set by src/duck/store.ts settle); a statement's
  // current_setting is the session's map (`settingRead`)
  const rewrite = fs.readFileSync(path.join(ROOT, "src/duck/rewrite.ts"), "utf8");
  assert.deepEqual([...rewrite.matchAll(/fn\("current_setting", \[([^\]]*)\]/g)].map((m) => m[1]).filter((a) => a !== 'strConst("TimeZone")'), [], "DuckDB's current_setting read for another name than TimeZone");
  assert.match(rewrite, /case "current_setting": return [^\n]*settingRead\(/, "a statement's current_setting is the session's (settingRead)");
});
