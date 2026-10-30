/**
 * EVERY `mason` COMMAND DOCUMENTS ITSELF: every command, present and future, is and stays self-documenting. The rules
 * are src/cli/command.ts's; this holds every command in the registry to them, so a
 * command added later is held to them the day it is added: its own --help (and `mason help <name>`), a usage that
 * starts with its name and shows an example, every option its parser takes named in that usage, a line in
 * `mason --help`, and a wrong option answered with what is wrong and the usage.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { COMMANDS, STEPS, topUsage } from "../src/cli/registry.ts";
import { GUIDES } from "../src/cli/guides.ts";
import { PLAIN } from "../src/cli/style.ts";

const MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "main.ts");
const mason = (...args: string[]) => spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env: { ...process.env, HOME: "/nonexistent-home" } });

test("the registry: every command once, each with a one-line summary", () => {
  const names = COMMANDS.map((c) => c.name);
  assert.deepEqual(names, [...new Set(names)], "no command twice");
  for (const c of COMMANDS) {
    assert.ok(c.summary.trim() && !c.summary.includes("\n"), `${c.name}: a one-line summary`);
    assert.ok(c.summary.length <= 120, `${c.name}: its summary fits a terminal line (${c.summary.length} characters)`);
  }
});

for (const c of COMMANDS) {
  test(`mason ${c.name} documents itself`, () => {
    // its usage: its name first, what it does, an example to copy, and every option it takes
    assert.match(c.usage, new RegExp(`^usage: mason ${c.name}\\b`), "starts `usage: mason <name>`");
    assert.match(c.usage, new RegExp(`^\\s+(?:[A-Z_]+=\\S+ )*mason ${c.name}\\b`, "m"), "an indented example line");
    for (const [opt, def] of Object.entries(c.options)) {
      assert.ok(c.usage.includes(`--${opt}`), `--${opt} is in its usage`);
      if (def.short) assert.ok(new RegExp(`(^|[\\s\\[])-${def.short}\\b`).test(c.usage), `-${def.short} is in its usage`);
    }
    assert.ok(c.usage.endsWith("\n"), "ends with a newline");
    // --help, -h and `mason help <name>` print it and exit 0
    for (const args of [[c.name, "--help"], [c.name, "-h"], ["help", c.name]]) {
      const r = mason(...args);
      assert.equal(r.status, 0, `mason ${args.join(" ")}: ${r.stderr}`);
      assert.equal(r.stdout, c.usage, `mason ${args.join(" ")} prints the usage`);
    }
    // a wrong option: what is wrong, then the usage, exit 2
    const wrong = mason(c.name, "--no-such-option");
    assert.equal(wrong.status, 2, `${c.name}: ${wrong.stderr}`);
    assert.match(wrong.stderr, new RegExp(`^✗ mason ${c.name}: .*no-such-option`));
    assert.ok(wrong.stderr.endsWith(c.usage), "followed by the usage");
    // listed in mason --help, with its summary
    assert.ok(topUsage().includes(`mason ${c.name}`) && topUsage().includes(c.summary), "listed in mason --help");
  });
}

test("mason --help lists the commands; a misspelt one is answered with the closest", () => {
  const help = mason("--help");
  assert.equal(help.status, 0);
  assert.equal(help.stdout, topUsage());
  const h = mason("help");
  assert.deepEqual([h.status, h.stdout], [0, topUsage()], "mason help: the commands");
  // mason alone is where you are and what to run next, never the same page as mason help
  const bare = mason();
  assert.equal(bare.status, 0);
  assert.notEqual(bare.stdout, topUsage());
  // what Mason is, in the words its reader was told it: a drop-in read replica, for analytics
  assert.ok(bare.stdout.startsWith("Mason: a drop-in read replica of your Postgres, for analytics — the tables you add, copied, kept current and served to psql, BI tools and your app.\n  Project   "), bare.stdout);
  // and --help opens with the same line, then how to try it with nothing installed
  const lines = topUsage().split("\n");
  assert.equal(lines[2], "  Mason: a drop-in read replica of your Postgres, for analytics — the tables you add, copied, kept current and served to psql, BI tools and your app. " +
    "Make your app's folder a project (mason init), add tables (mason add, before or after the start), start Mason (mason start), connect a tool (mason user add). It needs Node 22.13 or later; mason doctor checks.");
  assert.equal(lines[3], "  Try it first with nothing to install: mason init demo, then mason start and mason ui (a demo shop database, hosted by Mason itself).");
  assert.match(bare.stdout, /\n {2}mason help {36}every command, and the guides\n$/);
  assert.equal(mason("help", "version").status, 0, "mason version runs, so mason help version answers");
  const typo = mason("statsu");
  assert.equal(typo.status, 2);
  assert.match(typo.stderr, /^✗ mason: there is no command "statsu" — did you mean `status`\?/);
});

test("mason --help lists the commands under the steps a first session takes, in that order", () => {
  assert.deepEqual(STEPS.map(([step]) => step), ["Learn", "Set up", "Add your tables", "Connect", "Run", "Go to production"]);
  assert.deepEqual(COMMANDS.map((c) => c.name), ["help", "doctor", "init", "start", "tables", "add", "remove", "wait", "user", "mcp", "status", "ui", "sync", "logs", "cancel", "usage", "stop", "destroy", "serve"]);
  const help = topUsage();
  let at = -1;
  for (const [step, commands] of STEPS) {
    const here = help.indexOf(`\n  ${step}\n`);
    assert.ok(here > at, `${step} is a heading, after the one before it`);
    at = here;
    for (const c of commands) { const line = help.indexOf(`    mason ${c.name} `, here); assert.ok(line > here, `${c.name} is listed under ${step}`); at = Math.max(at, line); }
  }
});

test("a guide's name is never a command's: mason help <word> means one page (never a mason docs beside mason help)", () => {
  for (const g of Object.keys(GUIDES)) assert.ok(!COMMANDS.some((c) => c.name === g), `${g} is a guide and a command`);
});

test("the guides are listed under Learn, a line each beside mason help, so Learn lists them all", () => {
  const help = topUsage();
  const learn = help.slice(help.indexOf("\n  Learn\n"), help.indexOf("\n  Set up\n"));
  const lines = learn.split("\n").filter((l) => l.startsWith("    mason "));
  assert.deepEqual(lines.map((l) => l.trim().split(/\s{2,}/)[0]), ["mason help", "mason help agent", "mason help production"]);
  const w = Math.max(...COMMANDS.map((c) => c.name.length), ...Object.keys(GUIDES).map((g) => `help ${g}`.length));
  for (const [g, what] of Object.entries(GUIDES)) assert.ok(learn.includes(`mason ${`help ${g}`.padEnd(w)}   ${what}`), `${g} with its summary, aligned under Learn`);
  // and the other steps keep the commands' own column: a guide's name widens Learn alone
  const commandWidth = Math.max(...COMMANDS.map((c) => c.name.length));
  assert.ok(help.includes(`    mason ${"init".padEnd(commandWidth)}   `), "Set up's column is the commands' width");
  assert.ok(!help.includes("Guides, offline"), "listed once, under Learn, not again as a paragraph");
});

test("mason alone: no project here, a project not running — each with its own next command", async () => {
  const { orientation } = await import("../src/cli/registry.ts");
  const { PLAIN } = await import("../src/cli/style.ts");
  const { newConfig, writeConfig } = await import("../src/cli/project.ts");
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-orientation-"));
  try {
    const none = await orientation(dir, PLAIN);
    assert.match(none, /\n {2}Project {3}none here: mason init makes this folder one\n/);
    assert.match(none, /\nNext:\n {2}mason init {2}/);
    assert.match(none, /\n {2}mason init demo +or try it on a demo database Mason makes itself: nothing to install\n/);
    writeConfig(path.join(dir, ".mason"), newConfig("shop", "mason", false));
    fs.mkdirSync(path.join(dir, "mason", "sources"), { recursive: true });
    const stopped = await orientation(path.join(dir, "mason", "sources"), PLAIN);
    assert.match(stopped, /\n {2}Project {3}shop, files in .*\/mason\n {2}Mason {5}not running\n/, "found from a folder below the project's root");
    assert.match(stopped, /\nNext:\n {2}mason start {2}/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("every command that takes --json declares its answer's keys, ends them with next, and names each in its usage", async () => {
  // a coding agent needs clear, unambiguous context and a machine-readable form, and a person and an agent both need
  // the next steps. jsonText (src/cli/command.ts) holds a command's answer to its spec's keys at run time; this holds
  // the spec to the help, so what a program reads is what mason help <command> says.
  const { jsonText } = await import("../src/cli/command.ts");
  for (const c of COMMANDS) {
    const takesJson = "json" in c.options;
    assert.equal(c.json !== undefined, takesJson, `${c.name}: json keys declared exactly when --json is an option`);
    if (!c.json) continue;
    assert.equal(c.json[c.json.length - 1], "next", `${c.name}: its keys end with next`);
    const line = c.usage.slice(c.usage.indexOf("--json"));
    for (const k of c.json) assert.ok(new RegExp(`\\b${k}\\b`).test(line), `${c.name}: --json's line in its usage names ${k}`);
    assert.match(line, /as data/, `${c.name}: the --json line says what the data is`);
    // a key the spec does not name is refused as the bug it is; next is always added
    assert.throws(() => jsonText(c, { nope: 1 }), new RegExp(`mason ${c.name} --json: nope is not in its spec's json keys`));
    assert.deepEqual(JSON.parse(jsonText(c, {}, [["mason x", "y"]])), { next: [{ command: "mason x", what: "y" }] });
  }
  assert.deepEqual(COMMANDS.filter((c) => !("json" in c.options)).map((c) => c.name), ["help", "mcp"], "the one that prints text alone (mason help agent says so), and the one whose stdout is a protocol's; mason logs --json is its lines, or with --requests the request log");
  // a command takes no --json exactly when it prints text alone or its stdout is a protocol's
  assert.deepEqual(COMMANDS.filter((c) => c.stdout === "protocol").map((c) => c.name), ["mcp"]);
});

test("a command whose stdout is a protocol's says every failure on stderr, --json on its line or not", () => {
  // mason mcp: an MCP client reads its stdout as JSON-RPC frames, so a pretty { error, next } there is a frame it
  // cannot read; the wrong option (--json itself) and a refusal are both said on stderr, nothing on stdout
  for (const args of [["mcp", "--json"], ["mcp", "--url", "mysql://x@y/z", "--json"], ["mcp", "stray", "--json"]]) {
    const r = mason(...args);
    assert.equal(r.stdout, "", `mason ${args.join(" ")}: nothing on stdout`);
    assert.equal(r.status, 2, `mason ${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, /^✗ mason mcp: /, `mason ${args.join(" ")}`);
  }
});

test("mason help mcp's Claude Code lines name the server BEFORE --env (claude mcp add's --env takes every value after it)", async () => {
  const { MCP } = await import("../src/cli/mcp.ts");
  const lines = MCP.usage.split("\n").filter((l) => /^\s+claude mcp add /.test(l));
  assert.ok(lines.length >= 2 && lines.some((l) => l.includes("--env")), MCP.usage);
  for (const l of lines) {
    const words = l.trim().split(/\s+/);
    const name = words.indexOf("mason");
    const env = words.indexOf("--env");
    assert.ok(name === 3, `the server's name follows claude mcp add: ${l}`);
    if (env >= 0) assert.ok(env > name, `--env after the server's name: ${l}`);
    assert.ok(words.indexOf("--") > name && words.indexOf("--") > env, `-- before the command: ${l}`);
  }
  // the URL in the environment is said first: on the command line ps shows it
  assert.ok(lines[0]!.includes("--env MASON_URL="), lines[0]);
  const { guideText } = await import("../src/cli/guides.ts");
  assert.match(await guideText("agent"), /\n {4}claude mcp add mason --env MASON_URL="<url>" -- mason mcp\n/);
});

test("the --json shapes of the commands that change what is copied name the sources file and its tables, never a model", () => {
  // there is no concept of models, only a `sources` folder. What a program reads back
  // from init, tables, add, remove and status is the sources file and its tables by their names on the database
  const keys = (name: string): readonly string[] | undefined => COMMANDS.find((c) => c.name === name)?.json;
  assert.deepEqual(keys("tables"), ["database", "source", "tables", "next"], "the source file the tables are read against");
  assert.deepEqual(keys("add"), ["added", "file", "error", "next"], "the sources file it wrote");
  assert.deepEqual(keys("remove"), ["removed", "file", "next"], "the sources file it wrote");
  assert.deepEqual(keys("init"), ["name", "root", "folder", "config", "demo", "source", "roles", "database", "warnings", "next"], "the source file and the roles file it wrote");
  assert.ok(keys("status")?.includes("source") && !keys("status")?.includes("sources"), "status names its source, the database, with the sources file in it");
  assert.deepEqual(COMMANDS.filter((c) => c.json?.some((k) => /model/i.test(k))).map((c) => c.name), [], "no command answers with a model");
  for (const name of ["add", "remove", "tables"]) {
    const c = COMMANDS.find((x) => x.name === name)!;
    assert.doesNotMatch(c.usage, /\bmodels?\b/i, `mason ${name}'s help says table and source file, never model`);
  }
});

test("mason add and mason remove need the project, not the run: their help says what each does before mason start", () => {
  // the sources file is the list: mason init && mason add orders && mason start is a natural order
  const c = (name: string) => COMMANDS.find((x) => x.name === name)!;
  assert.deepEqual(["tables", "add", "remove"].map((n) => c(n).needs), ["project", "project", "project"]);
  assert.match(c("add").usage, /Before\s+mason start \(mason init && mason add orders && mason start\) the entry is written, checked against the database as\s+the run checks it, and the copy begins at mason start/);
  assert.match(c("remove").usage, /with Mason\s+stopped, a copy an earlier run made is dropped at the next mason start/);
  assert.match(topUsage(PLAIN), /a project \(mason init\), add tables \(mason add, before or after the start\), start Mason \(mason start\), connect a tool/);
});

test("a failure is one shape for a person and for a program: what, why, fix, next; JSON under --json; the exit code says it", async () => {
  const { failureText, failureJson, failed, FAILURE_CODES } = await import("../src/cli/command.ts");
  const { PLAIN } = await import("../src/cli/style.ts");
  const f = { message: "there is no table \"ordrs\"", code: "not_found" as const, why: "the database has orders, customers", fix: "name it as mason tables lists it", next: [["mason tables", "the tables"]] as const };
  assert.equal(failureText("add", f, PLAIN), "✗ mason add: there is no table \"ordrs\"\n  why   the database has orders, customers\n  fix   name it as mason tables lists it\n\nNext:\n  mason tables                                  the tables");
  assert.deepEqual(JSON.parse(failureJson(f)), { error: { code: "not_found", message: "there is no table \"ordrs\"", why: "the database has orders, customers", fix: "name it as mason tables lists it" }, next: [{ command: "mason tables", what: "the tables" }] });
  // a value of several lines keeps them, under the first
  assert.equal(failureText("wait", { message: "2 things failed", code: "failed", why: "a\nb" }, PLAIN), "✗ mason wait: 2 things failed\n  why   a\n        b");
  // failed() prints the one or the other, and returns the exit: 1, 2 for usage, 124 for a timeout, or the one given
  const outs: string[] = [], errs: string[] = [];
  const io = { out: (m: string) => { outs.push(m); }, err: (m: string) => { errs.push(m); } };
  assert.equal(failed("x", { message: "m", code: "usage", usage: "usage: mason x\n" }, { json: false, io }), 2);
  assert.equal(errs[0], "✗ mason x: m\n\nusage: mason x", "a wrong line's usage follows, for a person");
  assert.equal(failed("x", { message: "m", code: "usage" }, { json: true, io }), 2);
  assert.deepEqual(JSON.parse(outs[0]!), { error: { code: "usage", message: "m" }, next: [] }, "under --json the usage is not spliced in: mason x --help is");
  assert.equal(failed("wait", { message: "m", code: "timeout" }, { json: true, io }), 124);
  assert.equal(failed("x", { message: "m", code: "failed", exit: 3 }, { json: true, io }), 3);
  assert.equal(failed("x", { problem: "p", code: "no_project" }, { json: false, io }), 1, "a Problem (its message under problem) is a failure too");
  assert.equal(errs[errs.length - 1], "✗ mason x: p");
  // every code has one sentence, and the guide lists them (tests/cli-guides.test.ts reads the guide)
  for (const [code, what] of Object.entries(FAILURE_CODES)) assert.ok(/^[a-z_]+$/.test(code) && what.length > 10, code);
});

// A FAILURE IS DRAWN BY ITS STREAM (the red ✘ and the bold message never showed on a person's terminal — mason
// init defaulted its io to STDIO and passed it on, which failed() took for "not a terminal"): to STDIO it is stderr's
// style, with the checklist's ✘; to an io a caller supplied, plain with its ✗.
test("a failure to stderr is styled as stderr is, with a red ✘ and a bold message; one to a supplied io is plain with a ✗", async () => {
  const { failed, failureText, STDIO } = await import("../src/cli/command.ts");
  const { PLAIN, styleFor } = await import("../src/cli/style.ts");
  const colour = styleFor({ isTTY: true, columns: 200 }, { FORCE_COLOR: "1" });
  const f = { message: "it broke", code: "failed" as const, why: "a reason\nin two lines", fix: "do this" };
  assert.match(failureText("x", f, PLAIN), /^✗ mason x: it broke\n {2}why {3}a reason\n {8}in two lines\n {2}fix {3}do this$/);
  assert.match(failureText("x", f, colour), /^\x1b\[31m✘\x1b\[39m \x1b\[31mmason x:\x1b\[39m \x1b\[1mit broke\x1b\[22m\n/);
  // to STDIO under FORCE_COLOR: stderr's style, colour on; to another io: plain
  const was = process.env.FORCE_COLOR, write = process.stderr.write;
  const got: string[] = [];
  process.env.FORCE_COLOR = "1";
  process.stderr.write = ((chunk: string | Uint8Array) => { got.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try { assert.equal(failed("x", f, { json: false, io: STDIO }), 1); }
  finally { process.stderr.write = write; if (was === undefined) delete process.env.FORCE_COLOR; else process.env.FORCE_COLOR = was; }
  assert.match(got.join(""), /^\x1b\[31m✘\x1b\[39m \x1b\[31mmason x:\x1b\[39m /, "a failure to STDIO is drawn in stderr's style");
  const plain: string[] = [];
  assert.equal(failed("x", f, { json: false, io: { out: () => undefined, err: (m) => { plain.push(m); } } }), 1);
  assert.match(plain.join(""), /^✗ mason x: it broke\n/);
});

test("mason init --help says the demo adds three of its tables and leaves order_items for the first mason add", () => {
  const r = mason("init", "--help");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\n {2}orders, order_items\): mason start makes it in \.mason\/demo\/ and changes it every few seconds\. Three of its tables are\n {2}added; the fourth is yours to add after mason start \(mason add order_items\), to watch its copy begin\.\n/);
});
