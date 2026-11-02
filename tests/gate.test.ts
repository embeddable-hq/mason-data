/**
 * THE READY LOCAL GATE (scripts/gate.ts): what can be held offline. Which files it runs, the Node and the Postgres read
 * from ci.yml alone, and every way it can end — a stubbed `docker` and `psql` stand in for the real ones, so the
 * container's removal, a failed start, a hung file and a signal are each exercised without a container.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ALWAYS, CI_FILE, GateRefusal, NODE_PIN, ORACLE, UsageError, buildPlan, changedFiles, chooseTests, ciFacts, ensureNode, importsOf, oracleAskedNothing, parseArgs, parseMappedPort, pinProblem, runGate, type Config, type Plan, type Step } from "../scripts/gate.ts";
// a namespace, not a named import: a tree whose gate.ts lacks the constant still loads, and the test fails by name
import * as gate from "../scripts/gate.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
/** The file names below are invented, under t/ and p/: a real-looking path to nothing fails the conventions' path guard. */
const I = "import", F = "from"; // spelled apart for the same reason: the import guard reads a fixture's line as an import
const NODE = process.execPath;

/** A step that runs a line of JavaScript. */
const js = (label: string, code: string, boundMs = 30_000, extra: Partial<Step> = {}): Step => ({ label, cmd: NODE, args: ["-e", code], boundMs, ...extra });
const PASS = js("t/pass.test.ts", "");
const FAIL = js("t/fail.test.ts", "process.exit(3)");

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "gate-test-"));

/** A `docker` that writes its arguments to a file, and a `psql` that says what it is told. Each subcommand can be replaced. */
function stubs(over: Partial<Record<"version" | "run" | "port" | "inspect" | "rm" | "logs" | "psql", string>> = {}): { dir: string; docker: string; psql: string; calls: () => string[] } {
  const dir = tmp();
  const log = path.join(dir, "calls");
  const docker = path.join(dir, "docker");
  const psql = path.join(dir, "psql");
  const gone = path.join(dir, "gone");
  fs.writeFileSync(docker, `#!/bin/sh
echo "$*" >> ${log}
case "$1" in
  version) ${over.version ?? "echo 29.0"} ;;
  run) ${over.run ?? "echo cid"} ;;
  port) ${over.port ?? "echo 127.0.0.1:54321"} ;;
  inspect) ${over.inspect ?? `if [ -e ${gone} ]; then echo "Error: No such object" >&2; exit 1; fi; echo true`} ;;
  rm) ${over.rm ?? `touch ${gone}`} ;;
  logs) ${over.logs ?? "echo a log line"} ;;
esac
`, { mode: 0o755 });
  // PGPASSWORD to a file of its own: `calls` is what the password must never be in
  fs.writeFileSync(psql, `#!/bin/sh\necho "psql $*" >> ${log}\necho "$PGPASSWORD" >> ${path.join(dir, "pgpassword")}\n${over.psql ?? `case "$1" in --version) echo psql;; *) echo logical;; esac`}\n`, { mode: 0o755 });
  return { dir, docker, psql, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []) };
}

const config = (s: ReturnType<typeof stubs>, lines: string[]): Config => ({
  root: ROOT, nodeBin: path.dirname(NODE), docker: s.docker, psql: s.psql, postgresImage: "postgres:18", out: (l) => { lines.push(l); },
  postgresReadyMs: 300, pollMs: 10, graceMs: 200,
});
const INTEGRATION: Plan = { first: [PASS], integration: [js("t/integration/pass.itest.ts", "")] };
const nameOf = (calls: string[]): string => /--name (\S+)/.exec(calls.find((c) => c.startsWith("run ")) ?? "")?.[1] ?? "(no docker run)";
const removedExactly = (calls: string[]): boolean => calls.includes(`rm --force --volumes ${nameOf(calls)}`);
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") return false; throw e; }
};

// ---- the one place ------------------------------------------------------------------------------------------------

test("the Node and the Postgres are ci.yml's, and the pin holds ci.yml's major", () => {
  const { nodeMajor, postgresImage } = ciFacts(fs.readFileSync(path.join(ROOT, CI_FILE), "utf8"));
  assert.equal(pinProblem(nodeMajor), null);
  assert.match(postgresImage, /^postgres:\d+$/);
  assert.deepEqual(Object.keys(NODE_PIN.sha256).sort(), ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]);
  for (const sum of Object.values(NODE_PIN.sha256)) assert.match(sum, /^[0-9a-f]{64}$/);
});

test("ci.yml moving to another Node or Postgres moves the gate, or refuses it with what to change", () => {
  const facts = ciFacts("      with:\n        node-version: '27'   # why\n      postgres:\n        image: postgres:19\n");
  assert.deepEqual(facts, { nodeMajor: "27", postgresImage: "postgres:19" });
  assert.match(pinProblem(facts.nodeMajor) ?? "", /runs Node 27 and scripts\/gate\.ts pins 26\..*SHASUMS256/);
  assert.equal(pinProblem("27", { version: "27.1.0" }), null);
});

test("ci.yml naming two Nodes, none, a non-major or no Postgres is a refusal, never a guess", () => {
  assert.throws(() => ciFacts("node-version: '24'\nnode-version: '26'\nimage: postgres:18\n"), GateRefusal);
  assert.throws(() => ciFacts("image: postgres:18\n"), GateRefusal);
  assert.throws(() => ciFacts("node-version: 'lts/*'\nimage: postgres:18\n"), GateRefusal);
  assert.throws(() => ciFacts("node-version: '26'\n"), GateRefusal);
});

// ---- which files ----------------------------------------------------------------------------------------------------

test("importsOf reads static, multi-line and dynamic imports as repository paths, and no package", () => {
  assert.deepEqual(importsOf("t/integration/a.itest.ts", `
    ${I} { x } ${F} "../../p/duck/sync.ts";
    ${I} {
      y,
    } ${F} './helper.ts';
    ${I} "../side.ts";
    const z = await ${I}("../../p/lib/z.ts");
    import * as fs from "node:fs";
    import { test } from "yaml";
  `).sort(), ["p/duck/sync.ts", "p/lib/z.ts", "t/integration/helper.ts", "t/side.ts"]);
});

const TESTS = new Map([
  ["t/a.test.ts", `${I} "../p/a.ts";`],
  ["t/b.test.ts", `${I} "../p/b.ts";`],
  ["t/postgres-api/n.test.ts", `${I} "../../p/a.ts";`],
  ["t/integration/a.itest.ts", `${I} "../../p/a.ts";`],
  ["t/integration/c.itest.ts", `${I} "./helper.ts";`],
  [ORACLE, `${I} "../../p/a.ts";`],
]);
const choose = (changed: string[], named: string[] = [], oracle = false): ReturnType<typeof chooseTests> => chooseTests({ tests: TESTS, changed, named, oracle });

test("a test file importing a changed file directly is chosen, and says why; one that does not is not", () => {
  const c = choose(["p/a.ts"]);
  assert.deepEqual(c.unit, [
    { file: ALWAYS[0], why: "always" }, { file: ALWAYS[1], why: "always" },
    { file: "t/a.test.ts", why: "imports p/a.ts" }, { file: "t/postgres-api/n.test.ts", why: "imports p/a.ts" },
  ]);
  assert.deepEqual(c.integration, [{ file: "t/integration/a.itest.ts", why: "imports p/a.ts" }]);
  assert.deepEqual(c.nothingNear, []);
});

test("nothing changed still runs the two always-files, and no integration file", () => {
  const c = choose([]);
  assert.deepEqual(c.unit.map((e) => e.file), ALWAYS);
  assert.deepEqual(c.integration, []);
});

test("a changed test and a changed helper reach their files; a changed file with no importer is said", () => {
  const c = choose(["t/b.test.ts", "t/integration/helper.ts", "p/web/page.css"]);
  assert.deepEqual(c.unit.map((e) => [e.file, e.why]).slice(2), [["t/b.test.ts", "changed"]]);
  assert.deepEqual(c.integration, [{ file: "t/integration/c.itest.ts", why: "imports t/integration/helper.ts" }]);
  assert.deepEqual(c.nothingNear, ["p/web/page.css"]);
});

test("a file named by hand is run and says so, beside what the change chose", () => {
  const c = choose(["p/b.ts"], ["t/integration/c.itest.ts"]);
  assert.deepEqual(c.integration, [{ file: "t/integration/c.itest.ts", why: "named by hand" }]);
  assert.ok(c.unit.some((e) => e.file === "t/b.test.ts"));
});

test("a change never picks the oracle: it is said left out, and --oracle or naming its file runs it", () => {
  const near = choose(["p/a.ts"]);
  assert.ok(!near.integration.some((e) => e.file === ORACLE));
  assert.equal(near.oracleLeftOut, "imports p/a.ts");
  const subset = choose(["p/a.ts"], [], true);
  assert.ok(subset.integration.some((e) => e.file === ORACLE && e.why === "--oracle"));
  assert.equal(subset.oracleLeftOut, null);
  const whole = choose([], [ORACLE]);
  assert.deepEqual(whole.integration, [{ file: ORACLE, why: "named by hand" }]);
});

test("the changed files are what left origin/main: committed, staged, unstaged, untracked; no origin/main says to fetch", () => {
  const repo = tmp();
  const git = (...args: string[]): void => { execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: repo, stdio: "ignore" }); };
  const write = (f: string): void => { fs.writeFileSync(path.join(repo, f), f); };
  git("init", "-q", "-b", "main");
  for (const f of ["old", "unstaged", "staged", "same"]) write(f);
  git("add", ".");
  git("commit", "-qm", "base");
  assert.throws(() => changedFiles(repo), /no merge base with origin\/main.*git fetch origin main/s);
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  write("committed");
  git("add", "committed");
  git("commit", "-qm", "work");
  fs.appendFileSync(path.join(repo, "unstaged"), "x");
  fs.appendFileSync(path.join(repo, "staged"), "x");
  git("add", "staged");
  write("untracked");
  assert.deepEqual(changedFiles(repo).changed, ["committed", "staged", "unstaged", "untracked"]);
});

test("the plan: typecheck first, one file at a time, IT_ORACLE_ONLY only with --oracle, npm ci only without node_modules", () => {
  const opts = { nodeBin: "/n/bin", hasNodeModules: true, oracleOnly: null, timeoutMs: null, platform: "darwin-arm64" };
  const plain = buildPlan(choose(["p/a.ts"], [ORACLE]), opts);
  assert.deepEqual(plain.first.map((s) => s.label), ["typecheck", ...ALWAYS, "t/a.test.ts", "t/postgres-api/n.test.ts"]);
  assert.ok([...plain.first, ...plain.integration].every((s) => s.boundMs > 0), "every step has a bound");
  assert.equal(plain.first[1]?.cmd, "/n/bin/node", "a test runs under the pinned Node");
  assert.deepEqual(plain.first[1]?.args.slice(0, 2), ["--test", "--test-concurrency=1"]);
  // a unit file carries the per-test pair BEFORE the file (Node ignores it after); an integration file does not (issue 139)
  assert.deepEqual(gate.TEST_BOUND_ARGS, ["--test-timeout=300000", "--test-force-exit"]);
  for (const step of plain.first.slice(1)) {
    assert.deepEqual(step.args, ["--test", "--test-concurrency=1", ...gate.TEST_BOUND_ARGS, "--test-reporter=spec", step.label], step.label);
  }
  const integrationTests = plain.integration.filter((s) => s.args[0] === "--test");
  assert.ok(integrationTests.length >= 2 && integrationTests.some((s) => s.label === ORACLE), integrationTests.map((s) => s.label).join(", "));
  for (const step of [...integrationTests, ...buildPlan(choose([], [], true), { ...opts, oracleOnly: "x" }).integration.filter((s) => s.args[0] === "--test")]) {
    assert.ok(step.args.every((a) => !a.startsWith("--test-timeout") && a !== "--test-force-exit"), `${step.label}: ${step.args.join(" ")}`);
  }
  assert.deepEqual(plain.integration.slice(0, 2).map((s) => s.required), [true, true], "the extensions are built as CI does, or nothing after runs");
  assert.equal(plain.integration.find((s) => s.label === ORACLE)?.env, undefined);

  const subset = buildPlan(choose([], [], true), { ...opts, oracleOnly: "^type matrix", hasNodeModules: false, timeoutMs: 5000 });
  assert.deepEqual(subset.integration.find((s) => s.label === ORACLE)?.env, { IT_ORACLE_ONLY: "^type matrix" });
  assert.equal(subset.integration.find((s) => s.label === ORACLE)?.boundMs, 5000);
  assert.deepEqual([subset.first[0]?.label, subset.first[0]?.required], ["npm ci", true]);
  assert.deepEqual(buildPlan(choose([]), opts).integration, [], "no integration file, no extensions");
});

test("parseArgs takes a path as a shell gives it, and refuses what is not a test, an empty --oracle and a bad regex", () => {
  const known = new Map([["t/a.test.ts", ""]]);
  assert.deepEqual(parseArgs(["./t/a.test.ts", "--oracle", "x", "--timeout", "2"], known, process.cwd()), { named: ["t/a.test.ts"], oracleOnly: "x", timeoutMs: 2000 });
  for (const bad of [["p/a.ts"], ["--oracle"], ["--oracle", "("], ["--timeout", "0"], ["--nope"]]) {
    assert.throws(() => parseArgs(bad, known, process.cwd()), UsageError, bad.join(" "));
  }
});

test("docker port's line is read as a port, and anything else is no port", () => {
  assert.equal(parseMappedPort("127.0.0.1:49153\n"), 49153);
  for (const bad of ["", "[::]:49153", "127.0.0.1:0", "127.0.0.1:99999", "Error: No public port"]) assert.equal(parseMappedPort(bad), null, bad);
});

// ---- Node -----------------------------------------------------------------------------------------------------------

function fakeTarball(version: string, says = version): Buffer {
  const dir = tmp();
  const name = `node-v${version}-test-os`;
  fs.mkdirSync(path.join(dir, name, "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, name, "bin", "node"), `#!/bin/sh\necho v${says}\n`, { mode: 0o755 });
  execFileSync("tar", ["-czf", path.join(dir, "t.tar.gz"), "-C", dir, name]);
  return fs.readFileSync(path.join(dir, "t.tar.gz"));
}
const sha = (b: Buffer): string => crypto.createHash("sha256").update(b).digest("hex");

test("Node is fetched once, unpacked into the folder alone, and not fetched again", async () => {
  const dir = path.join(tmp(), "cache");
  const tarball = fakeTarball("26.0.1");
  let fetched = 0;
  const input = { dir, pin: { version: "26.0.1", sha256: { "test-os": sha(tarball) } }, platform: "test-os", fetchTarball: () => { fetched++; return Promise.resolve(tarball); } };
  const bin = await ensureNode(input);
  assert.equal(bin, path.join(dir, "node-v26.0.1-test-os", "bin"));
  assert.equal(await ensureNode(input), bin);
  assert.equal(fetched, 1);
  assert.deepEqual(fs.readdirSync(dir), ["node-v26.0.1-test-os"], "no fetch folder is left");
});

test("a tarball that differs from the pin installs nothing and says both checksums", async () => {
  const dir = path.join(tmp(), "cache");
  const tarball = fakeTarball("26.0.1");
  const want = "0".repeat(64);
  await assert.rejects(ensureNode({ dir, pin: { version: "26.0.1", sha256: { "test-os": want } }, platform: "test-os", fetchTarball: () => Promise.resolve(tarball) }), (e: Error) => {
    assert.ok(e instanceof GateRefusal);
    assert.ok(e.message.includes(want) && e.message.includes(sha(tarball)), e.message);
    return true;
  });
  assert.equal(fs.existsSync(dir), false);
});

test("a tarball that unpacks to another version, no pin for the platform and a failed fetch are each refused", async () => {
  const tarball = fakeTarball("26.0.1", "26.0.2");
  const wrong = { dir: path.join(tmp(), "cache"), pin: { version: "26.0.1", sha256: { "test-os": sha(tarball) } }, platform: "test-os", fetchTarball: () => Promise.resolve(tarball) };
  await assert.rejects(ensureNode(wrong), GateRefusal, "the sha holds, the binary says another version");
  await assert.rejects(ensureNode({ ...wrong, platform: "plan9-mips" }), /pins no Node for plan9-mips/);
  await assert.rejects(ensureNode({ ...wrong, fetchTarball: () => Promise.reject(new Error("offline")) }), /could not fetch .*offline.*Check the network/);
});

// ---- how it ends ----------------------------------------------------------------------------------------------------

test("all green: exit 0, the Postgres removed by its exact name, and the verdict says CI is the full gate", async () => {
  const s = stubs(); const lines: string[] = [];
  const code = await runGate(INTEGRATION, config(s, lines));
  assert.equal(code, 0, lines.join("\n"));
  const calls = s.calls();
  assert.match(nameOf(calls), /^mason-gate-\d+-[0-9a-f]{8}$/);
  assert.ok(removedExactly(calls), calls.join("\n"));
  assert.match(lines.at(-1) ?? "", /PASSED.*load .*CI is the full gate/);
});

test("the container: a port Docker picks, password auth with the password in no argv, logical, bounded, the image CI uses", async () => {
  const s = stubs(); const lines: string[] = [];
  const seen = path.join(s.dir, "seen");
  const file = js("t/integration/sees.itest.ts", `require("fs").writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ url: process.env.IT_POSTGRES_URL, argv: process.argv }))`);
  assert.equal(await runGate({ first: [], integration: [file] }, config(s, lines)), 0, lines.join("\n"));
  const calls = s.calls();
  const run = calls.find((c) => c.startsWith("run ")) ?? "";
  assert.match(run, /--publish 127\.0\.0\.1:0:5432 /);
  assert.match(run, /--env POSTGRES_PASSWORD --publish/, "the value comes from the environment");
  assert.match(run, /--entrypoint timeout postgres:18 --kill-after=30 \d+ docker-entrypoint\.sh postgres -c wal_level=logical$/);
  // every docker and psql call and the file itself: the file has it in its env, and nothing has it in its argv
  const { url, argv } = JSON.parse(fs.readFileSync(seen, "utf8")) as { url: string; argv: string[] };
  const password = new URL(url).password;
  assert.match(password, /^[0-9a-f]{32}$/);
  const probes = calls.filter((c) => c.startsWith("psql ") && c.includes("SHOW wal_level"));
  assert.ok(probes.length > 0, calls.join("\n"));
  for (const c of [...calls, ...argv]) assert.ok(!c.includes(password), `the password in an argv: ${c}`);
  assert.equal(fs.readFileSync(path.join(s.dir, "pgpassword"), "utf8").trim().split("\n").at(-1), password, "the probe has it by PGPASSWORD");
});

test("two gates at once use two names", async () => {
  const a = stubs(); const b = stubs();
  await Promise.all([runGate(INTEGRATION, config(a, [])), runGate(INTEGRATION, config(b, []))]);
  assert.notEqual(nameOf(a.calls()), nameOf(b.calls()));
});

test("no integration file: no Docker is touched and no Postgres started", async () => {
  const s = stubs(); const lines: string[] = [];
  assert.equal(await runGate({ first: [PASS], integration: [] }, config(s, lines)), 0);
  assert.deepEqual(s.calls(), []);
});

test("a failed step fails the gate, the rest still run, and Postgres is removed", async () => {
  const s = stubs(); const lines: string[] = [];
  const marker = path.join(s.dir, "ran");
  const plan: Plan = { first: [FAIL, js("t/after.test.ts", `require("fs").writeFileSync(${JSON.stringify(marker)}, "")`)], integration: [js("t/integration/fail.itest.ts", "process.exit(1)")] };
  assert.equal(await runGate(plan, config(s, lines)), 1);
  assert.ok(fs.existsSync(marker), "a failure does not hide the next file's");
  assert.ok(removedExactly(s.calls()));
  const end = lines.slice(lines.findIndex((l) => /FAILED/.test(l))).join("\n");
  assert.match(end, /t\/fail\.test\.ts: exit 3/);
  assert.match(end, /t\/integration\/fail\.itest\.ts: exit 1/);
});

test("a required step that fails ends the gate there: no Postgres is started for what cannot run", async () => {
  const s = stubs(); const lines: string[] = [];
  const marker = path.join(s.dir, "ran");
  const plan: Plan = { first: [{ ...FAIL, label: "npm ci", required: true }, js("typecheck", `require("fs").writeFileSync(${JSON.stringify(marker)}, "")`)], integration: INTEGRATION.integration };
  assert.equal(await runGate(plan, config(s, lines)), 1);
  assert.equal(fs.existsSync(marker), false);
  assert.ok(!s.calls().some((c) => c.startsWith("run ")));
});

test("no Docker at all: one report saying what to do, before any step", async () => {
  const s = stubs(); const lines: string[] = [];
  const marker = path.join(s.dir, "ran");
  const plan: Plan = { first: [js("x", `require("fs").writeFileSync(${JSON.stringify(marker)}, "")`)], integration: INTEGRATION.integration };
  assert.equal(await runGate(plan, { ...config(s, lines), docker: path.join(s.dir, "no-such-docker") }), 1);
  const all = lines.join("\n");
  assert.match(all, /FAILED/);
  assert.match(all, /no Docker: .*install Docker Desktop, start it, and run the gate again.*IT_POSTGRES_URL=/);
  assert.equal(lines.filter((l) => /no Docker/.test(l)).length, 1, "one report");
  assert.equal(fs.existsSync(marker), false);
});

test("Docker installed and its daemon down is said as that", async () => {
  const s = stubs({ version: `echo "Cannot connect to the Docker daemon" >&2; exit 1` }); const lines: string[] = [];
  assert.equal(await runGate(INTEGRATION, config(s, lines)), 1);
  assert.match(lines.join("\n"), /Docker does not answer \(Cannot connect to the Docker daemon\): start Docker Desktop/);
  assert.ok(!s.calls().some((c) => c.startsWith("run ") || c.startsWith("rm ")), "nothing was started, so nothing is removed");
});

test("no psql is said before any time is spent", async () => {
  const s = stubs(); const lines: string[] = [];
  assert.equal(await runGate(INTEGRATION, { ...config(s, lines), psql: path.join(s.dir, "no-such-psql") }), 1);
  assert.match(lines.join("\n"), /no psql: .*add its bin folder to PATH/);
});

test("a failed docker run is a failed gate, the integration file does not run, and the name is still removed", async () => {
  const s = stubs({ run: `echo "pull access denied" >&2; exit 125` }); const lines: string[] = [];
  const marker = path.join(s.dir, "ran");
  const plan: Plan = { first: [PASS], integration: [js("t/integration/x.itest.ts", `require("fs").writeFileSync(${JSON.stringify(marker)}, "")`)] };
  assert.equal(await runGate(plan, config(s, lines)), 1);
  assert.equal(fs.existsSync(marker), false);
  assert.match(lines.join("\n"), /Postgres did not start: docker run: exit 125: pull access denied/);
  assert.ok(removedExactly(s.calls()));
});

test("a port that cannot be read, a Postgres that never answers, a container that dies and the wrong wal_level each fail", async () => {
  for (const [over, why] of [
    [{ port: `echo nonsense` }, /docker port said/],
    [{ psql: `case "$1" in --version) echo psql;; *) exit 2;; esac` }, /did not answer within/],
    [{ psql: `case "$1" in --version) echo psql;; *) exit 2;; esac`, inspect: `echo false` }, /the container exited during startup:\n\s+a log line/],
    [{ psql: `case "$1" in --version) echo psql;; *) echo replica;; esac` }, /wal_level is replica/],
  ] as const) {
    const s = stubs(over); const lines: string[] = [];
    assert.equal(await runGate(INTEGRATION, config(s, lines)), 1, why.source);
    assert.match(lines.join("\n"), why);
    assert.doesNotMatch(lines.join("\n"), /PASSED/);
  }
});

test("a container that cannot be removed, or whose removal cannot be confirmed, fails a green gate with the exact command", async () => {
  for (const over of [{ rm: "exit 1" }, { inspect: `echo "Cannot connect" >&2; exit 1` }]) {
    const s = stubs({ ...over }); const lines: string[] = [];
    assert.equal(await runGate({ first: [], integration: INTEGRATION.integration }, config(s, lines)), 1);
    assert.ok(lines.join("\n").includes(`docker rm --force --volumes ${nameOf(s.calls())}`), lines.join("\n"));
  }
});

test("a hung file ends at its bound, is named, its process group is gone, and Postgres is removed", async () => {
  const s = stubs(); const lines: string[] = [];
  const pids = path.join(s.dir, "pids");
  // ignores SIGTERM, and has a child in its group, so only the group's SIGKILL ends both
  const hang = `const fs=require("fs"),cp=require("child_process");process.on("SIGTERM",()=>{});const c=cp.spawn(process.execPath,["-e","process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:"ignore"});fs.writeFileSync(${JSON.stringify(pids)},process.pid+" "+c.pid);setInterval(()=>{},1000)`;
  const plan: Plan = { first: [PASS], integration: [js("t/integration/hangs.itest.ts", hang, 6000)] };
  assert.equal(await runGate(plan, config(s, lines)), 1);
  assert.match(lines.join("\n"), /FAILED[^]*t\/integration\/hangs\.itest\.ts: HUNG: no end within its bound/);
  for (const pid of fs.readFileSync(pids, "utf8").split(" ").map(Number)) {
    for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => { setTimeout(r, 20); });
    assert.equal(alive(pid), false, `process ${pid} outlived its bound`);
  }
  assert.ok(removedExactly(s.calls()));
});

test("a step that cannot start is a failure, never a pass", async () => {
  const s = stubs(); const lines: string[] = [];
  assert.equal(await runGate({ first: [{ label: "x", cmd: path.join(s.dir, "nothing"), args: [], boundMs: 1000 }], integration: [] }, config(s, lines)), 1);
  assert.match(lines.join("\n"), /x: could not start/);
});

test("an --oracle regex that names nothing is a failure: exit 0 of an empty oracle is not a pass", async () => {
  const verify = oracleAskedNothing("^zz$");
  assert.equal(verify("duck oracle: 12 statements asked, 0 differ (x)"), null);
  assert.match(verify("duck oracle: 0 statements asked, 0 differ (x)") ?? "", /--oracle \^zz\$ named no statement/);
  assert.match(verify("") ?? "", /never said/);
  const s = stubs(); const lines: string[] = [];
  const plan: Plan = { first: [{ ...js("oracle", `console.log("duck oracle: 0 statements asked, 0 differ")`), verify }], integration: [] };
  assert.equal(await runGate(plan, config(s, lines)), 1);
  assert.doesNotMatch(lines.join("\n"), /PASSED/);
});

test("an inherited IT_ORACLE_LEG never reaches a step, so naming the oracle's file is never silently half of it", async () => {
  const s = stubs();
  const at = path.join(s.dir, "seen");
  const lines: string[] = [];
  process.env.IT_ORACLE_LEG = "1/2";
  process.env.IT_ORACLE_LEG_REPORT = "stale";
  try {
    assert.equal(await runGate({ first: [js("x", `require("fs").writeFileSync(${JSON.stringify(at)}, String(process.env.IT_ORACLE_LEG) + String(process.env.IT_ORACLE_LEG_REPORT))`)], integration: [] }, config(s, lines)), 0);
  } finally { delete process.env.IT_ORACLE_LEG; delete process.env.IT_ORACLE_LEG_REPORT; }
  assert.equal(fs.readFileSync(at, "utf8"), "undefinedundefined");
});

test("an inherited IT_ORACLE_ONLY never reaches a step, so a whole oracle is never silently a subset", async () => {
  const s = stubs(); const lines: string[] = [];
  const at = path.join(s.dir, "env");
  process.env.IT_ORACLE_ONLY = "stale";
  try {
    assert.equal(await runGate({ first: [js("x", `require("fs").writeFileSync(${JSON.stringify(at)}, String(process.env.IT_ORACLE_ONLY))`)], integration: [] }, config(s, lines)), 0);
  } finally { delete process.env.IT_ORACLE_ONLY; }
  assert.equal(fs.readFileSync(at, "utf8"), "undefined");
});

test("the steps run under the pinned Node's PATH and integration files get the URL with its port", async () => {
  const s = stubs(); const lines: string[] = [];
  const at = path.join(s.dir, "env");
  const nodeBin = path.join(s.dir, "pinned-bin");
  fs.mkdirSync(nodeBin);
  const plan: Plan = { first: [], integration: [js("x", `require("fs").writeFileSync(${JSON.stringify(at)}, process.env.PATH.split(":")[0] + " " + process.env.IT_POSTGRES_URL)`)] };
  assert.equal(await runGate(plan, { ...config(s, lines), nodeBin }), 0, lines.join("\n"));
  assert.match(fs.readFileSync(at, "utf8"), new RegExp(`^${nodeBin} postgres://postgres:[0-9a-f]{32}@127\\.0\\.0\\.1:54321/postgres$`));
});

test("SIGTERM mid-file stops the file's group, removes Postgres by its name, and exits 143, not 0", async () => {
  const s = stubs();
  const pidFile = path.join(s.dir, "pid");
  const child = spawn(NODE, ["--input-type=module", "-e", `
    import { runGate } from ${JSON.stringify(path.join(ROOT, "scripts", "gate.ts"))};
    const { plan, cfg } = JSON.parse(process.env.GATE_FIXTURE);
    process.exitCode = await runGate(plan, cfg);
  `], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GATE_FIXTURE: JSON.stringify({
      plan: { first: [], integration: [js("t/integration/slow.itest.ts", `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`, 60_000)] },
      cfg: { root: ROOT, nodeBin: path.dirname(NODE), docker: s.docker, psql: s.psql, postgresImage: "postgres:18", postgresReadyMs: 5000, pollMs: 10, graceMs: 500 },
    }) },
  });
  let output = "";
  child.stdout.on("data", (d) => { output += String(d); });
  child.stderr.on("data", (d) => { output += String(d); });
  for (let i = 0; i < 1500 && !fs.existsSync(pidFile); i++) await new Promise((r) => { setTimeout(r, 20); });
  assert.ok(fs.existsSync(pidFile), output);
  await new Promise((r) => { setTimeout(r, 50); });
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  child.kill("SIGTERM");
  const code = await new Promise<number | null>((r) => { child.once("close", r); });
  assert.equal(code, 143, output);
  assert.match(output, /STOPPED by SIGTERM.*Nothing is proved/);
  assert.equal(alive(pid), false);
  assert.ok(removedExactly(s.calls()), s.calls().join("\n"));
});
