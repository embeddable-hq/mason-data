/**
 * EVERY `mason` COMMAND DOCUMENTS ITSELF: every command, present and future, is and stays self-documenting. The rules
 * are src/cli/command.ts's; this holds every command in the registry to them, so a
 * command added later is held to them the day it is added: its own --help (and `mason help <name>`), a usage that
 * starts with its name and shows an example, every option its parser takes named in that usage, a line in
 * `mason --help`, and a wrong option answered with what is wrong, the closest option and the synopsis (never the whole
 * usage: `mason <name> --help` for more).
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { COMMANDS, STEPS, topUsage } from "../src/cli/registry.ts";
import { GUIDES } from "../src/cli/guides.ts";
import { PLAIN } from "../src/cli/style.ts";
import * as commandModule from "../src/cli/command.ts";
// read from the module's namespace: at a commit without synopsis the file loads, and the tests fail by name
const synopsis = (c: { name: string; usage: string }): string => (commandModule as unknown as { synopsis?: (c: { name: string; usage: string }) => string }).synopsis?.(c) ?? "(no synopsis)";

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
    // a wrong option: what is wrong and every option, then the synopsis and where the rest is, exit 2
    const wrong = mason(c.name, "--no-such-option");
    assert.equal(wrong.status, 2, `${c.name}: ${wrong.stderr}`);
    assert.match(wrong.stderr, new RegExp(`^✗ mason ${c.name}: there is no option --no-such-option\n {2}fix {3}its options are `));
    for (const opt of Object.keys(c.options)) assert.ok(wrong.stderr.includes(`--${opt}`), `${c.name}: --${opt} is named`);
    assert.ok(wrong.stderr.endsWith(synopsis(c)), "followed by the synopsis");
    assert.ok(synopsis(c).startsWith(`usage: mason ${c.name}`) && synopsis(c).endsWith(`\n\nmason ${c.name} --help for more\n`), synopsis(c));
    if (synopsis(c).length < c.usage.length) assert.ok(!wrong.stderr.includes(c.usage), "never the whole usage");
    // listed in mason --help, with its summary
    assert.ok(topUsage().includes(`mason ${c.name}`) && topUsage().includes(c.summary), "listed in mason --help");
  });
}

test("every wrong command line, whatever check refused it, ends its next steps with mason <cmd> --help and carries a fix", () => {
  // the usage failures raised inside commands (wait, deploy, user, token, …) answered with next: [] and no fix
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mason-usage-"));
  try {
    const lines: string[][] = [["wait", "a", "b"], ["deploy", "stray"], ["user"], ["user", "frob"], ["token"], ["replica", "bogus"], ["sync"], ["logs", "-n", "x"],
      ["cancel"], ["init", "a", "b"], ["usage", "stray"], ["help", "a", "b"], ["status", "--jsn"]];
    for (const args of lines) {
      const r = spawnSync(process.execPath, [MAIN, ...args, "--json"], { cwd, encoding: "utf8", env: { ...process.env, HOME: "/nonexistent-home", MASON_REPLICA: "", MASON_TOKEN: "" } });
      assert.equal(r.status, 2, `mason ${args.join(" ")}: ${r.stdout}${r.stderr}`);
      const j = JSON.parse(r.stdout) as { error: { code: string; fix?: string }; next: Array<{ command: string }> };
      assert.equal(j.error.code, "usage", `mason ${args.join(" ")}`);
      assert.ok(j.error.fix, `mason ${args.join(" ")}: a fix`);
      assert.equal(j.next.at(-1)?.command, `mason ${args[0]} --help`, `mason ${args.join(" ")}: its usage last among the next steps`);
    }
    // a command's own way out is kept, the usage after it; for a person too, and no command's line gets the step twice
    const cancel = spawnSync(process.execPath, [MAIN, "cancel"], { cwd, encoding: "utf8" });
    assert.match(cancel.stderr, /^✗ mason cancel: name the session: mason cancel <session>\n {2}fix {3}mason logs --running lists each statement running with its session\n\nNext:\n {2}mason logs --running +.*\n {2}mason cancel --help +its usage, with every option\n\nusage: mason cancel/);
    const typo = spawnSync(process.execPath, [MAIN, "status", "--jsn"], { cwd, encoding: "utf8" });
    assert.equal(typo.stderr.split("\n  mason status --help ").length - 1, 1, typo.stderr);
    // no command: mason --help
    const none = JSON.parse(spawnSync(process.execPath, [MAIN, "statsu", "--json"], { cwd, encoding: "utf8" }).stdout) as { error: { fix?: string }; next: Array<{ command: string }> };
    assert.deepEqual([none.error.fix, none.next.map((n) => n.command)], ["name a command mason --help lists", ["mason --help"]]);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  // decided where every failure is said: a usage failure from anywhere, and nothing else
  const { usageWayOut } = commandModule as unknown as { usageWayOut?: (cmd: string, f: { message: string; code: string; fix?: string; next?: ReadonlyArray<readonly [string, string?]> }) => unknown };
  assert.ok(usageWayOut, "usageWayOut is exported");
  assert.deepEqual(usageWayOut("x", { message: "m", code: "usage", fix: "f" }), { message: "m", code: "usage", fix: "f", next: [["mason x --help", "its usage, with every option"]] });
  assert.deepEqual(usageWayOut("x", { message: "m", code: "failed" }), { message: "m", code: "failed" }, "only a wrong command line");
});

test("mason <cmd> --help --json, mason help <cmd> --json and mason help --json: each command's spec as data, read from its CommandSpec", () => {
  const { specJson, TIMEOUT_COMMANDS } = commandModule as unknown as { specJson?: (c: unknown) => Record<string, unknown>; TIMEOUT_COMMANDS: string };
  assert.ok(specJson, "specJson is exported");
  const all = mason("help", "--json");
  assert.equal(all.status, 0, all.stderr);
  const help = JSON.parse(all.stdout) as { version: string; commands: Array<Record<string, unknown> & { name: string }>; guides: Array<{ name: string; summary: string }>; failureCodes: Array<{ code: string; meaning: string }>; next: unknown[] };
  assert.deepEqual(Object.keys(help), ["version", "commands", "guides", "failureCodes", "next"]);
  assert.deepEqual(help.commands.map((c) => c.name), [...COMMANDS.map((c) => c.name), "version"], "every command, then mason version");
  assert.deepEqual(help.guides.map((g) => g.name), Object.keys(GUIDES));
  assert.deepEqual(help.failureCodes.map((c) => c.code), Object.keys(commandModule.FAILURE_CODES));
  assert.deepEqual(JSON.parse(mason("--help", "--json").stdout), help, "mason --help --json is the same");
  for (const c of COMMANDS) {
    const spec = help.commands.find((s) => s.name === c.name)!;
    assert.deepEqual(spec, specJson(c), `${c.name}: mason help --json carries its spec`);
    // the shape, declared and stable
    assert.deepEqual(Object.keys(spec), ["name", "summary", "usage", "forms", "options", "json", "needs", "stdout", "exitCodes"], c.name);
    assert.equal(spec.usage, c.usage, `${c.name}: the usage --help prints`);
    const options = spec.options as Array<{ name: string; short: string | null; type: string; multiple: boolean; default: unknown; value: string | null }>;
    assert.deepEqual(options.map((o) => o.name).sort(), [...Object.keys(c.options), "help"].map((o) => `--${o}`).sort(), `${c.name}: every option the parser takes`);
    for (const o of options) {
      const d = o.name === "--help" ? { type: "boolean", short: "h" } : c.options[o.name.slice(2)]!;
      assert.equal(o.type, d.type, `${c.name} ${o.name}`);
      assert.equal(o.short, d.short ? `-${d.short}` : null, `${c.name} ${o.name}`);
      assert.equal(o.type === "string", o.value !== null, `${c.name} ${o.name}: a string option's placeholder, from the usage (${o.value})`);
    }
    assert.deepEqual(spec.json, c.json ? [...c.json] : null, `${c.name}: its --json keys`);
    assert.deepEqual(spec.needs, c.needs ?? null);
    const codes = (spec.exitCodes as Array<{ code: number }>).map((e) => e.code);
    assert.deepEqual(codes, ["wait", "share", "ui", "login", "replica", "deploy"].includes(c.name) ? [0, 1, 2, 124] : [0, 1, 2], `${c.name}: its exit codes (${TIMEOUT_COMMANDS})`);
    // the same from its own --help --json and mason help <name> --json: { command, next }
    for (const args of [[c.name, "--help", "--json"], ["help", c.name, "--json"]]) {
      const r = mason(...args);
      assert.equal(r.status, 0, `mason ${args.join(" ")}: ${r.stderr}`);
      const j = JSON.parse(r.stdout) as { command: unknown; next: unknown[] };
      assert.deepEqual(Object.keys(j), ["command", "next"]);
      assert.deepEqual(j.command, spec, `mason ${args.join(" ")}`);
    }
  }
  // the forms and their positionals, as the synopsis writes them
  const forms = (name: string) => (help.commands.find((s) => s.name === name)!.forms as Array<{ synopsis: string; positionals: string[] }>);
  assert.deepEqual(forms("add").map((f) => f.positionals), [["<table>…"]]);
  assert.deepEqual(forms("init").map((f) => f.positionals), [["[<postgres url> | demo]"]]);
  assert.deepEqual(forms("user").map((f) => f.positionals), [["add", "<name>"], ["list"], ["disable", "<name>"], ["enable", "<name>"], ["remove", "<name>"]]);
  assert.deepEqual(forms("ui").map((f) => f.positionals), [[], []], "--ssh <user@server> is an option and its value");
  assert.deepEqual(forms("replica").map((f) => f.positionals)[2], ["status", "<org>/<name>"]);
  assert.deepEqual(forms("status"), [{ synopsis: "mason status [--json]", positionals: [] }]);
  // mason mcp, whose stdout is a protocol's and takes no --json, has a spec as data too
  assert.equal((JSON.parse(mason("mcp", "--help", "--json").stdout) as { command: { stdout: string; json: null } }).command.stdout, "protocol");
  // a guide as data, and a wrong line under --json still a failure
  const guide = JSON.parse(mason("help", "agent", "--json").stdout) as { guide: { name: string; text: string } };
  assert.equal(guide.guide.name, "agent");
  assert.match(guide.guide.text, /^DRIVING MASON FROM A CODING AGENT/);
  const nope = mason("help", "nope", "--json");
  assert.equal(nope.status, 2);
  assert.equal((JSON.parse(nope.stdout) as { error: { code: string } }).error.code, "usage");
});

test("mason version --json is { version, next }; mason version, --version and -v print the version alone", () => {
  const plain = mason("version");
  assert.equal(plain.status, 0);
  assert.match(plain.stdout, /^\S+\n$/);
  for (const args of [["--version"], ["-v"]]) assert.equal(mason(...args).stdout, plain.stdout, args[0]);
  for (const args of [["version", "--json"], ["--version", "--json"]]) {
    const r = mason(...args);
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(r.stdout), { version: plain.stdout.trim(), next: [] }, args.join(" "));
  }
  const spec = JSON.parse(mason("help", "version", "--json").stdout) as { command: { name: string; json: string[] } };
  assert.deepEqual([spec.command.name, spec.command.json], ["version", ["version", "next"]]);
});

test("a wrong option is said in the CLI's words: the closest option, a value missing or not taken; never Node's advice about --", () => {
  const typo = mason("status", "--jsn");
  assert.equal(typo.status, 2);
  assert.match(typo.stderr, /^✗ mason status: there is no option --jsn — did you mean `--json`\?\n {2}fix {3}its options are --json, --help\n/);
  assert.doesNotMatch(typo.stderr, /positional argument|place it at the end/);
  assert.ok(typo.stderr.endsWith("usage: mason status [--json]\n\nmason status --help for more\n"), typo.stderr);
  const j = mason("status", "--jsn", "--json");
  assert.equal(j.status, 2);
  assert.deepEqual(JSON.parse(j.stdout), { error: { code: "usage", message: "there is no option --jsn — did you mean `--json`?", fix: "its options are --json, --help" },
    next: [{ command: "mason status --help", what: "its usage, with every option" }] });
  const missing = mason("logs", "-n");
  assert.match(missing.stderr, /^✗ mason logs: -n \(--lines\) needs a value: -n <value>\n/);
  const value = mason("wait", "--json=yes");
  assert.match(value.stderr, /^✗ mason wait: --json takes no value: write --json alone\n/);
  assert.equal(value.status, 2);
});

test("every flag that takes a duration says <duration> in its command's usage (one grammar, src/lib/table-sync.ts parseDuration)", () => {
  const taking = COMMANDS.flatMap((c) => ["timeout", "step"].filter((k) => k in c.options).map((k) => [c, k] as const));
  assert.deepEqual(taking.map(([c, k]) => `${c.name} --${k}`), ["wait --timeout", "share --timeout", "ui --timeout", "usage --step", "replica --timeout", "deploy --timeout"]);
  for (const [c, k] of taking) assert.match(c.usage, new RegExp(`--${k} <duration>`), `mason ${c.name} --${k}`);
});

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
  assert.ok(bare.stdout.startsWith("Mason: a drop-in read replica of your Postgres, for analytics — the tables you add, synced, kept current and served to psql, BI tools and your app.\n  Project   "), bare.stdout);
  // and --help opens with the same line, then how to try it with nothing installed
  const lines = topUsage().split("\n");
  assert.equal(lines[2], "  Mason: a drop-in read replica of your Postgres, for analytics — the tables you add, synced, kept current and served to psql, BI tools and your app. " +
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
  assert.deepEqual(COMMANDS.map((c) => c.name), ["help", "doctor", "init", "start", "tables", "add", "remove", "wait", "user", "mcp", "share", "status", "ui", "sync", "logs", "cancel", "usage", "stop", "destroy", "serve", "login", "logout", "replica", "token", "deploy"]);
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
  assert.deepEqual(lines.map((l) => l.trim().split(/\s{2,}/)[0]), ["mason help", "mason help agent", "mason help production", "mason help generated"]);
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
  assert.deepEqual(COMMANDS.filter((c) => !("json" in c.options)).map((c) => c.name), ["mcp"], "the one whose stdout is a protocol's (mason help --json is the specs); mason logs --json is its lines, or with --requests the request log");
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
  assert.deepEqual(keys("init"), ["name", "root", "folder", "config", "demo", "source", "roles", "generated", "database", "warnings", "next"], "the source file, the roles file and the demo's generated table it wrote");
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
  assert.match(c("add").usage, /Before\s+mason start \(mason init && mason add orders && mason start\) the entry is written, checked against the database as\s+the run checks it, and the first sync begins at mason start/);
  assert.match(c("remove").usage, /with Mason\s+stopped, what an earlier run synced is dropped at the next mason start/);
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
  assert.equal(errs[0], "✗ mason x: m\n  fix   write the line as its usage says (mason x --help)\n\nNext:\n  mason x --help                                its usage, with every option\n\nusage: mason x",
    "a wrong line's way out, then its usage, for a person");
  assert.equal(failed("x", { message: "m", code: "usage" }, { json: true, io }), 2);
  assert.deepEqual(JSON.parse(outs[0]!), { error: { code: "usage", message: "m", fix: "write the line as its usage says (mason x --help)" }, next: [{ command: "mason x --help", what: "its usage, with every option" }] },
    "under --json the usage is not spliced in: mason x --help is");
  assert.equal(failed("wait", { message: "m", code: "timeout" }, { json: true, io }), 124);
  assert.equal(failed("x", { message: "m", code: "failed", exit: 3 }, { json: true, io }), 3);
  assert.equal(failed("x", { problem: "p", code: "no_project" }, { json: false, io }), 1, "a Problem (its message under problem) is a failure too");
  assert.equal(errs[errs.length - 1], "✗ mason x: p");
  // every code has one sentence, and the guide lists them (tests/cli-guides.test.ts reads the guide)
  for (const [code, what] of Object.entries(FAILURE_CODES)) assert.ok(/^[a-z_]+$/.test(code) && what.length > 10, code);
  // the set is closed: a hung run's not_answering is in it, and a code another process sent outside it becomes ours
  const { failureCode, TIMEOUT_COMMANDS } = await import("../src/cli/command.ts");
  assert.ok(Object.hasOwn(FAILURE_CODES, "not_answering"));
  assert.deepEqual([failureCode("not_found", "failed"), failureCode("frobnicated", "failed"), failureCode(7, "usage")], ["not_found", "failed", "usage"]);
  for (const c of ["mason wait", "mason deploy", "mason replica create", "mason login", "mason share", "mason ui --ssh"]) assert.ok(TIMEOUT_COMMANDS.includes(c), c);
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
  assert.match(r.stdout, /\n {2}orders, order_items\): mason start makes it in \.mason\/demo\/ and changes it every few seconds\. Three of its tables are\n {2}added; the fourth is yours to add after mason start \(mason add order_items\), to watch its first sync begin\.\n/);
});

test("mason serve --help lists GET /metrics beside /healthz, on MASON_HEALTH_PORT's line, and says it is numbers only", () => {
  const r = mason("serve", "--help");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\n {4}MASON_HEALTH_PORT {7}\/healthz's and \/metrics' port \(default 4140\), on MASON_HEALTH_HOST \(default 0\.0\.0\.0\)\n/);
  assert.match(r.stdout, /GET \/healthz for the platform's health check,\n {2}GET \/metrics for Prometheus \(numbers only: no name, no statement\)/);
  assert.doesNotMatch(r.stdout, /duckdb(?!_memory)/i, "nothing a user sees names the engine (MASON_DUCKDB_MEMORY is a setting's name)");
});

test("mason serve --help's MASON_DUCKDB_MEMORY line names the default's rule, its least share and the floor under which Mason warns, in sizes a reader recognises (issue 301)", () => {
  const r = mason("serve", "--help");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\n {4}MASON_DUCKDB_MEMORY {5}the engine's memory, 4GB or 512MiB \(default half the container's memory limit, else of the\n {28}machine's RAM, or what leaves 2\.5 GiB beside it when that is less, never under 128 MiB;\n {28}mason doctor says it\); a statement past it fails alone with 53200\. Unset, under 3\.0 GiB\n {28}Mason starts and warns: the system may stop it\n/);
  assert.doesNotMatch(r.stdout.slice(r.stdout.indexOf("MASON_DUCKDB_MEMORY"), r.stdout.indexOf("MASON_SPILL_LIMIT")), /refused/i, "a start is never refused for memory");
  assert.doesNotMatch(r.stdout, /duckdb(?!_memory)/i);
});
