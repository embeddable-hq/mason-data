/**
 * A Mason project is a folder (src/cli/project.ts, init.ts, runs.ts): `mason init` makes one where it
 * runs; every command finds the nearest `.mason/` at or above the folder it runs in; and a run is up only when it
 * answers with its own token and pid — never because a pid in a file is alive.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findProject, ignoresStateDir, nameFromFolder, newConfig, readProject, theProject, writeConfig, type Project } from "../src/cli/project.ts";
import { init, nameProblem, withIgnored } from "../src/cli/init.ts";
import * as initModule from "../src/cli/init.ts";
// imported when the tests run: at a commit without the module the file still loads, and a test that needs it fails by name
const sourcesModule = await import("../src/cli/sources.ts" as string).catch(() => ({})) as Record<string, unknown>;
// read from the modules, not imported by name: the file loads at a commit without them (scripts/fails-without.ts)
const { urlVariable } = initModule as unknown as { urlVariable: (root: string, url: string) => { variable: string; line: string | null } | { problem: string } };
// at a commit without it, the bare file it writes, so the file loads and its tests fail by name
const newSourceText = (url?: string): string =>
  (sourcesModule.newSourceText as ((u?: string) => string) | undefined)?.(url) ?? `kind: postgres\nurl: ${url ?? "$" + "{DATABASE_URL}"}\ntables: {}\n`;
import type { Io } from "../src/cli/command.ts";
import { appDatabaseUrl } from "../src/lib/dotenv.ts";
import { answers, endRun, liveRun, runOf, runState } from "../src/cli/runs.ts";

const MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "main.ts");
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "mason-project-"));

/** A command's output, recorded through its io (never by replacing process.stdout, which the test runner reports on). */
function recorder(): { io: Io; out: () => string; err: () => string } {
  const o: string[] = [], e: string[] = [];
  return { io: { out: (m) => { o.push(`${m}\n`); }, err: (m) => { e.push(`${m}\n`); } }, out: () => o.join(""), err: () => e.join("") };
}
async function quiet<T>(f: (io: Io) => Promise<T>): Promise<{ value: T; out: string; err: string }> {
  const r = recorder();
  const value = await f(r.io);
  return { value, out: r.out(), err: r.err() };
}

test("a command means the nearest project at or above its folder, as git finds a repository", () => {
  const home = tmp();
  try {
    const shop = path.join(home, "code", "shop");
    fs.mkdirSync(path.join(shop, "src", "components"), { recursive: true });
    writeConfig(path.join(shop, ".mason"), newConfig("shop", "mason", false));
    assert.equal(findProject(path.join(shop, "src", "components"))!.root, shop);
    assert.equal((findProject(shop) as Project).folder, path.join(shop, "mason"));
    assert.equal(findProject(home), null);
    const none = theProject(home) as { problem: string; code: string; next: Array<[string, string?]> };
    assert.deepEqual([none.problem, none.code, none.next.map((n) => n[0])], ["no Mason project here or above", "no_project", ["mason init"]]);
    // the config is the developer's alone: it holds the database's password
    assert.equal(fs.statSync(path.join(shop, ".mason", "config.json")).mode & 0o777, 0o600);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("the old names answer with the new ones; mason start takes no URL", () => {
  for (const [argv, said] of [
    [["purge"], /mason purge is now mason destroy/],
    [["poll", "orders"], /mason poll is now mason sync/],
    [["rm"], /mason rm is gone: mason remove takes a table out of the project, mason destroy removes the project's copy\n\nNext:\n {2}mason remove <table> {2}.*a table, and its copy\n {2}mason destroy {2}.*this folder's project/],
    [["dev"], /mason dev is now mason start\n\nNext:\n {2}mason init <postgres url> .*once, in your app's folder\n {2}mason start /],
    // mason connect and mason list are gone: mason user is enough, and a project is its folder
    [["connect"], /mason connect is gone: mason user add <name> makes a user whose password does not expire, and prints the URL to paste\n\nNext:\n {2}mason user add <name> /],
    [["list"], /mason list is gone: a project is its folder, and a command means the project of the folder it runs in\n\nNext:\n {2}mason status /],
    [["destroy", "shop"], /✗ mason destroy: it takes no name \(shop\): a project is its folder\n {2}fix {3}cd into the project's folder, then mason destroy/],
  ] as const) {
    const r = spawnSync(process.execPath, [MAIN, ...argv], { encoding: "utf8" });
    assert.equal(r.status, 2, argv.join(" "));
    assert.match(r.stderr, said);
  }
  const start = spawnSync(process.execPath, [MAIN, "start", "postgres://u@localhost/app"], { encoding: "utf8" });
  assert.equal(start.status, 2);
  assert.match(start.stderr, /✗ mason start: it takes no database URL: the project has one\n {2}why {3}mason init <url> made it; \.mason\/config\.json holds it\n\nusage: mason start/);
});

test("a name from the folder; .gitignore gains .mason/ once; the URL from .env.local, .env, then the shell", () => {
  assert.equal(nameFromFolder("/code/My Shop"), "my-shop");
  assert.equal(nameFromFolder("/code/___"), "mason");
  assert.ok(ignoresStateDir("node_modules\n.mason/\n"));
  assert.ok(ignoresStateDir("/.mason\n"));
  assert.ok(!ignoresStateDir(".masonry/\n"));
  assert.equal(withIgnored("node_modules\n.mason/\n"), null);
  assert.deepEqual(withIgnored("node_modules"), { text: "node_modules\n# Mason: this machine's key, copy and state (mason init)\n.mason/\n", added: [".mason/"] });
  assert.deepEqual(withIgnored(null), { text: "# Mason: this machine's key, copy and state (mason init)\n.mason/\n", added: [".mason/"] });
  // the file the database URL was read from is ignored too (the test server: mason init read .env and left
  // it committable); a line that already covers it — exact, anchored, or the .env* glob — is enough
  assert.deepEqual(withIgnored(null, [".env"]), { text: "# Mason: this machine's key, copy and state (mason init)\n.mason/\n# the database URL mason/sources/ names (mason init)\n.env\n", added: [".mason/", ".env"] });
  assert.deepEqual(withIgnored(".mason/\n", [".env.local"]), { text: ".mason/\n# the database URL mason/sources/ names (mason init)\n.env.local\n", added: [".env.local"] });
  assert.equal(withIgnored(".env\n.mason/\n", [".env"]), null);
  assert.equal(withIgnored("/.env.local\n/.mason\n", [".env.local"]), null);
  assert.equal(withIgnored(".env*\n.mason/\n", [".env.local"]), null, "a glob covers it");
  assert.equal(withIgnored("*.local\n.mason/\n", [".env.local"]), null);
  assert.deepEqual(withIgnored(".env.local\n.mason/\n", [".env"])?.added, [".env"], ".env.local does not cover .env");
  assert.deepEqual(withIgnored(".env/\n.mason/\n", [".env"])?.added, [".env"], "a directory pattern does not cover the file");
  assert.deepEqual(withIgnored("!.env\n.mason/\n", [".env"])?.added, [".env"], "a negation does not ignore");
  const root = tmp();
  try {
    assert.equal(appDatabaseUrl(root, {}), null);
    assert.deepEqual(appDatabaseUrl(root, { DATABASE_URL: "postgres://shell/db" }), { url: "postgres://shell/db", from: "the shell's DATABASE_URL", file: null });
    fs.writeFileSync(path.join(root, ".env"), "# app\nexport DATABASE_URL=\"postgres://dotenv/db\"\n");
    assert.deepEqual(appDatabaseUrl(root, { DATABASE_URL: "postgres://shell/db" }), { url: "postgres://dotenv/db", from: ".env", file: ".env" }, "the folder's own, over the shell's");
    fs.writeFileSync(path.join(root, ".env.local"), "DATABASE_URL=postgres://local/db\n");
    assert.deepEqual(appDatabaseUrl(root, {}), { url: "postgres://local/db", from: ".env.local", file: ".env.local" });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  assert.match(nameProblem("Shop!")!, /is not a project name/);
  assert.equal(nameProblem("shop"), null);
});

test("mason init writes the project — config, the sources file, the URL in .env, .gitignore — and refuses a second one", async () => {
  const root = tmp();
  try {
    fs.mkdirSync(path.join(root, "app"));
    fs.writeFileSync(path.join(root, "app", ".gitignore"), "node_modules\n");
    const app = path.join(root, "app");
    const r = await quiet((io) => init(["postgres://me:secret@localhost:5432/shop", "--skip-check"], app, { io }));
    assert.equal(r.value, 0, r.err);
    const p = readProject(app) as Project;
    assert.equal(p.config.name, "app");
    assert.equal(p.config.folder, "mason");
    // the source file is yours to commit, and the URL stays out of it — and out of .mason/config.json
    assert.equal(JSON.stringify(p.config).includes("secret"), false, "the config holds no URL");
    assert.equal(fs.readFileSync(path.join(app, "mason", "sources", "shop.yml"), "utf8"), newSourceText());
    assert.match(fs.readFileSync(path.join(app, ".env"), "utf8"), /^# the database Mason copies from .*\nDATABASE_URL=postgres:\/\/me:secret@localhost:5432\/shop\n$/);
    assert.equal(fs.statSync(path.join(app, ".env")).mode & 0o777, 0o600);
    assert.match(fs.readFileSync(path.join(app, ".gitignore"), "utf8"), /^node_modules\n# Mason: .*\n\.mason\/\n# the database URL mason\/sources\/ names \(mason init\)\n\.env\n$/);
    // what it did, as a checklist, then what to run next
    assert.match(r.out, /^Making app a Mason project in .*\n✓ Not checking postgres:\/\/me:\*\*\*\*@localhost:5432\/shop \(--skip-check\): mason start checks it\n✓ Wrote \.mason\/config\.json: Mason's key \(this machine's\)\n✓ Wrote mason\/sources\/shop\.yml: the database \(url: \$\{DATABASE_URL\}\) and the tables to copy, none yet \(mason add\) — commit it\n✓ Wrote DATABASE_URL=postgres:\/\/me:\*\*\*\*@localhost:5432\/shop to \.env: the URL the source file names, kept out of git\n✓ Added \.mason\/ and \.env to \.gitignore\n\nTip: Mason only reads your database: no setting, slot or publication is needed or made\n\nNext:\n  mason start {35}Mason in the background, for this folder\n  mason tables /);
    assert.doesNotMatch(r.out, /secret/, "the password is never printed");
    // again here, or anywhere inside: refused, naming the project and how to point it elsewhere
    fs.mkdirSync(path.join(app, "src"));
    const again = await quiet((io) => init(["--skip-check", "postgres://u@localhost/x"], path.join(app, "src"), { io }));
    assert.equal(again.value, 1);
    // a failure: what is wrong, the fix as a row, the command to run under Next (src/cli/command.ts failureText)
    assert.match(again.err, /this folder is inside .*app, which is already the Mason project app\n {2}fix {3}to point it at another database, change DATABASE_URL in .*app\/\.env \(url: in mason\/sources\/shop\.yml names it\), or url: itself\n\nNext:\n {2}mason status {2}/);
    // --folder . and --name; a folder outside is refused
    const two = path.join(root, "two");
    fs.mkdirSync(two);
    assert.equal((await quiet((io) => init(["postgres://u@localhost/x", "--skip-check", "--folder", ".", "--name", "two-db"], two, { io }))).value, 0);
    assert.equal((readProject(two) as Project).folder, two);
    assert.ok(fs.existsSync(path.join(two, "sources", "x.yml")));
    const three = path.join(root, "three");
    fs.mkdirSync(three);
    const outside = await quiet((io) => init(["postgres://u@localhost/x", "--skip-check", "--folder", "../elsewhere"], three, { io }));
    assert.equal(outside.value, 2);
    assert.match(outside.err, /--folder \.\.\/elsewhere is outside this folder/);
    // no URL and none in .env: which database?
    const none = await quiet((io) => init([], three, { io }));
    assert.equal(none.value, 2);
    assert.match(none.err, /which database\? none is named, and this folder has no DATABASE_URL\n {2}fix {3}give its URL .* or put it in this folder's \.env as DATABASE_URL=/);
    // the two fixes are the two next commands, for the person's Next: and the agent's next[]
    assert.match(none.err, /\nNext:\n {2}mason init postgres:\/\/user:password@localhost:5432\/your_app {2}its URL, given\n {2}mason init +again, once \.env has DATABASE_URL\n/);
    const noneJson = await quiet((io) => init(["--json"], three, { io }));
    assert.equal(noneJson.value, 2);
    assert.deepEqual(JSON.parse(noneJson.out).next.map((n: { command: string }) => n.command), ["mason init postgres://user:password@localhost:5432/your_app", "mason init"]);
    // a database elsewhere needs --remote, even unchecked
    const remote = await quiet((io) => init(["postgres://u@db.example.com/x", "--skip-check"], three, { io }));
    assert.equal(remote.value, 1);
    assert.match(remote.err, /^✗ mason init: stopped before writing anything: db\.example\.com is on another machine, and copying from it needs your say-so\n/m);
    assert.match(remote.err, /\n {2}why {3}mason start would copy the tables you pick to this machine: a file under \.mason\/, with no access control beyond this machine's\n {8}and keep them current while it runs by reading that database/);
    assert.match(remote.err, /\n {2}fix {3}run the same mason init again with --remote: that says yes, copy from that machine\n/);
    assert.match(remote.err, /\nNext:\n {2}mason init --remote <url>/);
    assert.equal(readProject(three), null, "nothing written");
    // the URL read from .env: that file is ignored with .mason/ (and named in the checklist)
    const four = path.join(root, "four");
    fs.mkdirSync(four);
    fs.writeFileSync(path.join(four, ".env"), "DATABASE_URL=postgres://u:secret@localhost/x\n");
    const fromEnv = await quiet((io) => init(["--skip-check"], four, { io }));
    assert.equal(fromEnv.value, 0, fromEnv.err);
    assert.match(fs.readFileSync(path.join(four, ".gitignore"), "utf8"), /^# Mason: .*\n\.mason\/\n# the database URL mason\/sources\/ names \(mason init\)\n\.env\n$/);
    assert.equal(fs.readFileSync(path.join(four, ".env"), "utf8"), "DATABASE_URL=postgres://u:secret@localhost/x\n", "read from .env: nothing more written there");
    assert.doesNotMatch(fromEnv.out, /to \.env/);
    assert.match(fromEnv.out, /\n✓ Made \.gitignore, ignoring \.mason\/ and \.env\n/);
    assert.doesNotMatch(fromEnv.out, /already committed/);
    // .env already ignored, .mason/ not: only .mason/ is added
    const five = path.join(root, "five");
    fs.mkdirSync(five);
    fs.writeFileSync(path.join(five, ".env"), "DATABASE_URL=postgres://u:secret@localhost/x\n");
    fs.writeFileSync(path.join(five, ".gitignore"), ".env*\n");
    const envIgnored = await quiet((io) => init(["--skip-check"], five, { io }));
    assert.equal(envIgnored.value, 0, envIgnored.err);
    assert.equal(fs.readFileSync(path.join(five, ".gitignore"), "utf8"), ".env*\n# Mason: this machine's key, copy and state (mason init)\n.mason/\n");
    assert.match(envIgnored.out, /\n✓ Added \.mason\/ to \.gitignore\n/);
    // .env already COMMITTED: ignoring it changes nothing, so init says what to run
    const withCommittedEnv = (name: string): string => {
      const dir = path.join(root, name);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, ".env"), "DATABASE_URL=postgres://u:secret@localhost/x\n");
      for (const args of [["init", "-q"], ["add", ".env"], ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "x"]]) {
        const g = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
        assert.equal(g.status, 0, g.stderr);
      }
      return dir;
    };
    const said = ".env holds the database URL (DATABASE_URL) and is committed in git: git rm --cached .env takes it out of the next commit (the file stays); then change the password";
    const committed = await quiet((io) => init(["--skip-check"], withCommittedEnv("six"), { io }));
    assert.equal(committed.value, 0, committed.err);
    assert.ok(committed.out.includes(`\n  ! ${said}\n`), committed.out);
    const committedJson = await quiet((io) => init(["--skip-check", "--json"], withCommittedEnv("seven"), { io }));
    assert.equal(committedJson.value, 0, committedJson.err);
    assert.deepEqual(JSON.parse(committedJson.out).warnings, [said]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("mason init writes the version pin a released mason is, keeps one already there, and says when it pins another line", async () => {
  const root = tmp();
  try {
    const app = path.join(root, "app");
    fs.mkdirSync(app);
    const r = await quiet((io) => init(["postgres://u@localhost/shop", "--skip-check"], app, { io, version: "0.5.1" }));
    assert.equal(r.value, 0, r.err);
    assert.match(r.out, /\n✓ Wrote mason\/mason\.yml: version 0\.5\.1, the Mason this project is written for — commit it\n/);
    assert.match(fs.readFileSync(path.join(app, "mason", "mason.yml"), "utf8"), /\nversion: 0\.5\.1\n$/);
    // a clone of a repo pinned to another release line: kept, and the line said, with the two ways out
    const clone = path.join(root, "clone");
    fs.mkdirSync(path.join(clone, "mason"), { recursive: true });
    fs.writeFileSync(path.join(clone, "mason", "mason.yml"), "version: 0.4.2\n");
    const c = await quiet((io) => init(["postgres://u@localhost/shop", "--skip-check", "--name", "clone"], clone, { io, version: "0.5.1" }));
    assert.equal(c.value, 0, c.err);
    assert.match(c.out, /\n✓ Kept mason\/mason\.yml\n/);
    assert.match(c.out, /! .*mason\.yml pins Mason 0\.4\.2, and this mason command is 0\.5\.1, a newer release line than 0\.4\.x.* npm i -g @mason-data\/cli@0\.4\.2/);
    assert.equal(fs.readFileSync(path.join(clone, "mason", "mason.yml"), "utf8"), "version: 0.4.2\n");
    // a checkout's mason is `dev`: no version to write
    const dev = path.join(root, "dev");
    fs.mkdirSync(dev);
    assert.equal((await quiet((io) => init(["postgres://u@localhost/shop", "--skip-check", "--name", "dev"], dev, { io, version: "dev" }))).value, 0);
    assert.ok(!fs.existsSync(path.join(dev, "mason", "mason.yml")));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("mason init checks the database and writes nothing when it cannot connect", async () => {
  const root = tmp();
  try {
    // nothing listens on port 1
    const r = await quiet((io) => init(["postgres://u:p@127.0.0.1:1/shop"], root, { io }));
    assert.equal(r.value, 1);
    // the step fails as such, and the check's own words — what is wrong, then the ways out — follow it
    assert.match(r.out, /\n✗ Connecting to postgres:\/\/u:\*\*\*\*@127\.0\.0\.1:1\/shop\n$/);
    assert.match(r.err, /^✗ mason init: could not connect: .*\n {2}why {3}the database's URL is postgres:\/\/u:\*{4}@127\.0\.0\.1:1\/shop\n {2}fix {3}Is Postgres running\?.*\n {8}Supabase/);
    assert.equal(readProject(root), null);
    assert.ok(!fs.existsSync(path.join(root, "mason")));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a run is up only when it answers with its token and its pid: a pid alive after a reboot is not a run", async () => {
  let pidAnswered = process.pid;
  const srv = http.createServer((req, res) => {
    if (req.headers.authorization !== "Bearer right") { res.writeHead(401).end(); return; }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ pid: pidAnswered }));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  const root = tmp();
  try {
    const cfg = newConfig("shop", "mason", false);
    cfg.running = { pid: process.pid, controlUrl: `http://127.0.0.1:${port}`, token: "right", postgresUrl: "postgresql://127.0.0.1:5433/shop", postgresListener: { host: "127.0.0.1", tls: null } };
    writeConfig(path.join(root, ".mason"), cfg);
    const p = readProject(root) as Project;
    const run = runOf(p)!;
    assert.equal(await answers(run), true);
    assert.equal((await liveRun(p))?.pid, process.pid);
    pidAnswered = 1;                                            // something else answers on the port now
    assert.equal(await answers(run), false);
    pidAnswered = process.pid;
    assert.equal(await answers({ ...run, control: { url: run.control.url, token: "wrong" } }), false);
    assert.equal(await answers({ ...run, control: { url: "http://127.0.0.1:1", token: "right" } }), false, "nothing listening");
    assert.equal(runOf(p, () => false), null, "a dead pid needs no asking");
    assert.equal(await liveRun(p, () => true, async () => false), null, "alive but not answering: not up");
    // A RUN THAT IS ALIVE AND DOES NOT ANSWER IS A THIRD STATE, never "not running" (the test server: a run
    // hung with its main thread blocked; mason stop said it was not running and mason destroy deleted its files under
    // it). It is hung when its pid is a Mason run by its command line (a pid alive after a reboot is another process)
    assert.deepEqual(await runState(p, () => true, async () => true, () => true), { kind: "up", run: runOf(p) });
    assert.deepEqual(await runState(p, () => true, async () => false, () => true), { kind: "hung", run: runOf(p) });
    assert.deepEqual(await runState(p, () => true, async () => false, () => false), { kind: "none", run: null }, "alive, silent, and not a Mason run: another process has the pid");
    assert.deepEqual(await runState(p, () => false, async () => true, () => true), { kind: "none", run: null });
  } finally { srv.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("ending a hung run: SIGTERM, then SIGKILL once the grace is over, and the pid waited for", async () => {
  const signals: string[] = [];
  let alive = true;
  const deps = { kill: (_pid: number, s: NodeJS.Signals) => { signals.push(s); if (s === "SIGKILL") alive = false; }, isAlive: () => alive, sleep: async () => undefined, graceMs: 1_000 };
  assert.deepEqual(await endRun(4242, deps), { killed: true });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"], "SIGTERM ignored for the grace, then SIGKILL");
  // one that leaves on SIGTERM is not killed
  signals.length = 0; alive = true;
  let terms = 0;
  assert.deepEqual(await endRun(4242, { ...deps, kill: (_p, s) => { signals.push(s); if (s === "SIGTERM") terms++; }, isAlive: () => terms === 0 }), { killed: false });
  assert.deepEqual(signals, ["SIGTERM"]);
  // one that survives SIGKILL is said
  signals.length = 0;
  await assert.rejects(endRun(4242, { ...deps, kill: (_p, s) => { signals.push(s); }, isAlive: () => true }), /pid 4242 is still running after SIGKILL/);
});

test("a config that cannot be read is a broken project: said with the file and the way out, never thrown (found by tests/cli-state-matrix.test.ts)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mason-broken-"));
  const dir = path.join(root, ".mason");
  fs.mkdirSync(dir);
  const file = path.join(dir, "config.json");
  const good = newConfig("shop", "mason", false);
  const cases: Array<[string, string, RegExp]> = [
    ["half-written", '{"name": "shop", "sour', /^it is not valid JSON \(Unterminated string in JSON/],
    ["not an object", "[1, 2]", /^it is not a JSON object$/],
    ["a field missing", JSON.stringify({ ...good, apiKey: undefined, folder: 7 }), /^it has no folder, apiKey \(each a string\)$/],
    ["a name no project has", JSON.stringify({ ...good, name: "Shop Dev" }), /^its name "Shop Dev" is not a project name/],
    ["a port that is none", JSON.stringify({ ...good, pgPort: "5433" }), /^its "pgPort" "5433" is not a port number/],
    ["a run recorded without how to reach it", JSON.stringify({ ...good, running: { pid: 4242 } }), /^its "running" has no controlUrl, token, postgresUrl, postgresListener \(mason start writes the whole of it, or null when stopped\)$/],
    ["a run without its pid", JSON.stringify({ ...good, running: { controlUrl: "c", token: "t", postgresUrl: "p", postgresListener: { host: "127.0.0.1", tls: null } } }), /^its "running" has no pid/],
  ];
  for (const [what, text, says] of cases) {
    fs.writeFileSync(file, text);
    const p = readProject(root);
    assert.ok(p && "broken" in p, `${what}: broken`);
    assert.match(p.broken, says, what);
    assert.deepEqual(findProject(path.join(root, "deeper")), p, `${what}: the nearest project, broken or not`);
    const t = theProject(root);
    assert.ok("problem" in t);
    assert.equal(t.code, "bad_config");
    assert.equal(t.problem, `this folder's Mason project cannot be read: ${file}: ${p.broken}`);
    assert.match(t.fix!, /^repair it \(JSON: name, folder, apiKey\), or move .*\.mason aside and run mason init again/);
  }
  fs.writeFileSync(file, JSON.stringify(good));
  assert.ok(!("broken" in readProject(root)!), "and a whole one reads");
});

test("the URL init keeps for the source file: DATABASE_URL in .env, unless the folder's files give it another database", () => {
  const root = tmp();
  try {
    const url = "postgres://me:pw@localhost:5432/shop";
    assert.deepEqual(urlVariable(root, url), { variable: "DATABASE_URL", line: `DATABASE_URL=${url}` }, "none: written to .env");
    fs.writeFileSync(path.join(root, ".env"), `DATABASE_URL=${url}\n`);
    assert.deepEqual(urlVariable(root, url), { variable: "DATABASE_URL", line: null }, "the same one: nothing written");
    fs.writeFileSync(path.join(root, ".env.local"), "DATABASE_URL=postgres://app@localhost:5432/app_dev\n");
    assert.deepEqual(urlVariable(root, url), { variable: "MASON_DATABASE_URL", line: `MASON_DATABASE_URL=${url}` }, "the app's own DATABASE_URL is another database: never changed under it");
    fs.writeFileSync(path.join(root, ".env"), "MASON_DATABASE_URL=postgres://x@localhost/y\n");
    assert.match((urlVariable(root, url) as { problem: string }).problem, /names DATABASE_URL and MASON_DATABASE_URL for other databases/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

/** A project an older Mason made: a file per table in mason/models/, the URL in .mason/config.json; no sources file. */
function oldProject(root: string): ReturnType<typeof newConfig> {
  const models = path.join(root, "mason", "models");
  fs.mkdirSync(models, { recursive: true });
  fs.writeFileSync(path.join(models, "orders.yml"), "name: orders\nprimary_key:\n  id: { type: bigint }\n");
  const config = { ...newConfig("shop", "mason", false), source: "postgres://me:pw@localhost:5432/shop_dev" };
  fs.writeFileSync(path.join(root, ".gitignore"), ".mason/\n");
  writeConfig(path.join(root, ".mason"), config as ReturnType<typeof newConfig>);
  return config;
}

test("a project an older Mason made: refused with the way out — mason init writes its sources file alone, nothing migrated", async () => {
  // the review of the sources file: no backwards compatibility before v1.0 — nothing reads mason/models/
  const root = tmp();
  try {
    const config = oldProject(root);
    const start = spawnSync(process.execPath, [MAIN, "start", "--attach"], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: root } });
    assert.equal(start.status, 1, start.stdout + start.stderr);
    assert.ok(start.stderr.startsWith("✗ mason start: this project names no database: mason/sources/ has no source file, and mason/models/ is an older Mason's, which this one does not read\n" +
      "  fix   mason init writes mason/sources/ (then mason add each table again); remove mason/models/ afterwards\n\nNext:\n  mason init "), start.stderr);
    // the way out: init in the project writes the sources file alone — its config, key and copy as they were
    const named = await quiet((io) => init(["--name", "other", "--skip-check", "postgres://me:pw@localhost:5432/shop_dev"], root, { io }));
    assert.equal(named.value, 2, "the project is named already");
    assert.match(named.err, /^✗ mason init: this folder is the Mason project shop already, whose source file is all mason init writes here: it takes no --name or --folder\n/);
    const r = await quiet((io) => init(["postgres://me:pw@localhost:5432/shop_dev", "--skip-check"], root, { io }));
    assert.equal(r.value, 0, r.err);
    assert.equal(fs.readFileSync(path.join(root, "mason", "sources", "shop_dev.yml"), "utf8"), newSourceText(), "no table: nothing migrated");
    const kept = JSON.parse(fs.readFileSync(path.join(root, ".mason", "config.json"), "utf8")) as { name: string; apiKey: string };
    assert.deepEqual([kept.name, kept.apiKey], [config.name, config.apiKey], "the config kept: its key, so its users");
    assert.match(r.out, /\n✓ Kept \.mason\/config\.json: the project shop, its key and its copy\n/);
    assert.match(r.out, /\n {2}! mason\/models\/ is an older Mason's, which this one does not read: mason add each table again, then remove it\n/);
    assert.ok(fs.existsSync(path.join(root, "mason", "models")), "removing it is the person's");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("mason init in a clone: the sources file already there is kept, and its variable given the URL in .env", async () => {
  const root = tmp();
  try {
    fs.mkdirSync(path.join(root, "mason", "sources"), { recursive: true });
    const text = `${newSourceText()}`.replace("tables: {}\n", "tables:\n  orders: {}   # ours\n");
    fs.writeFileSync(path.join(root, "mason", "sources", "app.yml"), text);
    const r = await quiet((io) => init(["postgres://me:pw@localhost:5432/shop", "--skip-check"], root, { io }));
    assert.equal(r.value, 0, r.err);
    assert.equal(fs.readFileSync(path.join(root, "mason", "sources", "app.yml"), "utf8"), text, "kept, byte for byte");
    assert.match(r.out, /\n✓ Kept mason\/sources\/app\.yml: the database and the tables this project copies\n✓ Wrote DATABASE_URL=postgres:\/\/me:\*\*\*\*@localhost:5432\/shop to \.env/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
