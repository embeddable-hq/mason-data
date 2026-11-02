/**
 * scripts/gate-slot.ts: a heavy gate runs in a machine-wide slot, says who it waits for, clears only what a dead PID
 * left, and a failure of the queue is never a success. Every test runs the script as `npm run check` does, over a queue
 * folder of its own (MASON_GATE_DIR), so a run on a shared machine neither sees that machine's gates nor is seen by them.
 *
 * The script is spawned, not imported, so a tree without it fails each test by name (scripts/fails-without.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
// a namespace, not a named import: a tree whose gate.ts lacks the constant still loads, and the test fails by name
import * as gatePlan from "../scripts/gate.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "gate-slot.ts");
const LOCK_FAILED = 3;

interface Queue { dir: string; scratch: string }

function queue(t: { after: (fn: () => void) => void }): Queue {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "gate-slot-test-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  return { dir: path.join(scratch, "queue"), scratch };
}

function env(q: Queue, slots: string | undefined): NodeJS.ProcessEnv {
  const { MASON_GATE_SLOTS: _, ...rest } = process.env;
  return { ...rest, MASON_GATE_DIR: q.dir, ...(slots === undefined ? {} : { MASON_GATE_SLOTS: slots }) };
}

/** Exits with `code` and touches `mark` first: a command that shows whether it ran. */
const marks = (mark: string, code = 0): string[] => [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(mark)}, ""); process.exit(${code})`];

/** Touches `mark`, then runs until `end` exists. */
const holds = (mark: string, end: string): string[] => [process.execPath, "-e",
  `const fs = require("fs"); fs.writeFileSync(${JSON.stringify(mark)}, ""); setInterval(() => { if (fs.existsSync(${JSON.stringify(end)})) process.exit(0); }, 20);`];

function gateSync(q: Queue, slots: string | undefined, ...command: string[]): { code: number | null; err: string } {
  const r = spawnSync(process.execPath, [SCRIPT, ...command], { env: env(q, slots), encoding: "utf8" });
  return { code: r.status, err: r.stderr };
}

interface Running { c: ChildProcess; err: () => string; done: Promise<number | null> }

function gate(q: Queue, slots: string | undefined, ...command: string[]): Running {
  const c = spawn(process.execPath, [SCRIPT, ...command], { env: env(q, slots), stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  c.stderr.on("data", (d) => { err += d; });
  return { c, err: () => err, done: new Promise((resolve) => c.on("close", (code) => resolve(code))) };
}

async function until(what: string, ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (!ready()) {
    assert.ok(Date.now() < deadline, `timed out waiting until ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const tickets = (q: Queue): string[] => fs.readdirSync(q.dir).filter((f) => f.endsWith(".ticket"));
const seen = (file: string): boolean => fs.existsSync(file);

/** A ticket as a run writes it, for a PID this test chooses. */
function plant(q: Queue, n: number, pid: number): string {
  fs.mkdirSync(q.dir, { recursive: true });
  const file = path.join(q.dir, `${n}-${pid}.ticket`);
  fs.writeFileSync(file, JSON.stringify({ pid, started: Date.now(), cwd: "/a/planted/tree", command: "planted gate" }));
  return file;
}

test("the command runs in a slot, its exit is the gate's, and the slot is given back", (t) => {
  const q = queue(t);
  const mark = path.join(q.scratch, "ran");
  assert.equal(gateSync(q, "2", ...marks(mark)).code, 0);
  assert.ok(seen(mark));
  assert.deepEqual(fs.readdirSync(q.dir), [], "no ticket or draft is left");
  assert.equal(gateSync(q, "2", ...marks(mark, 7)).code, 7);
  assert.deepEqual(fs.readdirSync(q.dir), []);
});

test("a command that dies of a signal or cannot start is no success", (t) => {
  const q = queue(t);
  const killed = gateSync(q, "1", process.execPath, "-e", `process.kill(process.pid, "SIGKILL")`);
  assert.equal(killed.code, 128 + os.constants.signals.SIGKILL);
  const missing = gateSync(q, "1", "/no/such/command");
  assert.equal(missing.code, 127, missing.err);
  assert.match(missing.err, /could not start/);
  assert.deepEqual(fs.readdirSync(q.dir), []);
});

test("slots full: the next run waits, says who holds the slot, and runs when it is free", async (t) => {
  const q = queue(t);
  const a = path.join(q.scratch, "a"), b = path.join(q.scratch, "b"), end = path.join(q.scratch, "end");
  const holder = gate(q, "1", ...holds(a, end));
  await until("the holder runs", () => seen(a));
  const waiter = gate(q, "1", ...marks(b));
  await until("the waiter says who it waits for", () => waiter.err().includes(`pid ${holder.c.pid}`));
  assert.match(waiter.err(), /waiting for a slot for \d+s: 1 of 1 taken/);
  assert.ok(waiter.err().includes(process.cwd()), "it says where the holder runs");
  assert.ok(waiter.err().includes(process.execPath), "it says what the holder runs");
  assert.ok(!seen(b), "the waiter's command has not run");
  fs.writeFileSync(end, "");
  assert.equal(await holder.done, 0);
  assert.equal(await waiter.done, 0);
  assert.ok(seen(b));
  assert.match(waiter.err(), /slot taken after/);
  assert.deepEqual(fs.readdirSync(q.dir), []);
});

test("MASON_GATE_SLOTS sets how many run at once", async (t) => {
  const q = queue(t);
  const end = path.join(q.scratch, "end");
  const running = ["a", "b"].map((n) => gate(q, "2", ...holds(path.join(q.scratch, n), end)));
  await until("two run at once", () => seen(path.join(q.scratch, "a")) && seen(path.join(q.scratch, "b")));
  const third = gate(q, "2", ...marks(path.join(q.scratch, "c")));
  await until("the third waits", () => third.err().includes("2 of 2 taken"));
  assert.ok(!seen(path.join(q.scratch, "c")));
  fs.writeFileSync(end, "");
  assert.deepEqual(await Promise.all([...running, third].map((r) => r.done)), [0, 0, 0]);
});

test("the queue is first come, first served", async (t) => {
  const q = queue(t);
  const a = path.join(q.scratch, "a"), end = path.join(q.scratch, "end"), order = path.join(q.scratch, "order");
  const holder = gate(q, "1", ...holds(a, end));
  await until("the holder runs", () => seen(a));
  const appends = (name: string): string[] => [process.execPath, "-e", `require("fs").appendFileSync(${JSON.stringify(order)}, ${JSON.stringify(name)})`];
  const first = gate(q, "1", ...appends("1"));
  await until("the first waits", () => first.err().includes("waiting"));
  const second = gate(q, "1", ...appends("2"));
  await until("the second waits", () => second.err().includes("1 ahead in the queue"));
  fs.writeFileSync(end, "");
  await Promise.all([holder.done, first.done, second.done]);
  assert.equal(fs.readFileSync(order, "utf8"), "12");
});

test("runs that start together never overlap past the limit: no two think they are first", async (t) => {
  const q = queue(t);
  const log = path.join(q.scratch, "log");
  const body = `const fs = require("fs"); const log = ${JSON.stringify(log)};
    const inside = (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "").split("\\n").reduce((n, l) => n + (l === "in" ? 1 : l === "out" ? -1 : 0), 0);
    fs.appendFileSync(log, "in\\n"); setTimeout(() => { fs.appendFileSync(log, "out\\n"); process.exit(inside === 0 ? 0 : 9); }, 30);`;
  const runs = Array.from({ length: 8 }, () => gate(q, "1", process.execPath, "-e", body));
  assert.deepEqual(await Promise.all(runs.map((r) => r.done)), Array.from({ length: 8 }, () => 0));
  assert.equal(fs.readFileSync(log, "utf8"), "in\nout\n".repeat(8), "one at a time, each out before the next in");
});

test("a dead PID's ticket is cleared, and the gate says so", async (t) => {
  const q = queue(t);
  const a = path.join(q.scratch, "a"), b = path.join(q.scratch, "b"), end = path.join(q.scratch, "end");
  const holder = gate(q, "1", ...holds(a, end));
  try {
    await until("the holder runs", () => seen(a));
    holder.c.kill("SIGKILL"); // nothing of the gate runs: its ticket stays, as a crash or the OOM killer leaves it
    await new Promise((resolve) => holder.c.on("exit", resolve));
    assert.equal(tickets(q).length, 1, "the killed gate's ticket is still there");
    const next = gate(q, "1", ...marks(b));
    assert.equal(await next.done, 0, next.err());
    assert.ok(seen(b));
    assert.match(next.err(), new RegExp(`cleared a stale slot: pid ${holder.c.pid} is dead`));
    assert.deepEqual(tickets(q), []);
  } finally {
    fs.writeFileSync(end, ""); // the command the killed gate left behind ends by this, and holds its stderr till then
    await holder.done;
  }
});

test("a dead PID's ticket left by a run that is itself waiting does not hold the queue up", async (t) => {
  const q = queue(t);
  const a = path.join(q.scratch, "a"), b = path.join(q.scratch, "b"), end = path.join(q.scratch, "end");
  const holder = gate(q, "1", ...holds(a, end));
  await until("the holder runs", () => seen(a));
  const killed = gate(q, "1", ...marks(path.join(q.scratch, "never")));
  await until("the second waits", () => killed.err().includes("waiting"));
  killed.c.kill("SIGKILL");
  const third = gate(q, "1", ...marks(b));
  await until("the third waits", () => third.err().includes("waiting"));
  fs.writeFileSync(end, "");
  assert.equal(await holder.done, 0);
  assert.equal(await third.done, 0, third.err());
  assert.ok(seen(b));
  assert.ok(!seen(path.join(q.scratch, "never")));
});

test("a ticket whose PID is alive is never cleared, however old", async (t) => {
  const q = queue(t);
  const planted = plant(q, 1, process.pid);
  fs.writeFileSync(planted, JSON.stringify({ pid: process.pid, started: 0, cwd: "/a/planted/tree", command: "planted gate" }));
  const b = path.join(q.scratch, "b");
  const waiter = gate(q, "1", ...marks(b));
  await until("the waiter names the holder", () => waiter.err().includes(`pid ${process.pid}`));
  assert.match(waiter.err(), /planted gate \(in \/a\/planted\/tree\)/);
  await new Promise((resolve) => setTimeout(resolve, 600)); // past several looks at the queue
  assert.ok(seen(planted), "the live holder's ticket stands");
  assert.ok(!seen(b));
  fs.rmSync(planted);
  assert.equal(await waiter.done, 0);
});

test("a PID of another user's is alive: EPERM is not ESRCH", { skip: process.getuid?.() === 0 ? "root may signal anything" : false }, async (t) => {
  const q = queue(t);
  const planted = plant(q, 1, 1); // pid 1 exists, and this user may not signal it
  const waiter = gate(q, "1", ...marks(path.join(q.scratch, "b")));
  await until("the waiter names the holder", () => waiter.err().includes("pid 1 for"));
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.ok(seen(planted));
  waiter.c.kill("SIGTERM");
  assert.equal(await waiter.done, 128 + os.constants.signals.SIGTERM);
  assert.deepEqual(tickets(q), [path.basename(planted)], "the waiter's own ticket went with it, the planted one stayed");
});

test("a signal to a holder reaches the command, which ends before the slot is given back", async (t) => {
  const q = queue(t);
  const a = path.join(q.scratch, "a"), after = path.join(q.scratch, "after");
  const holder = gate(q, "1", process.execPath, "-e", `const fs = require("fs");
    process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(after)}, String(fs.readdirSync(${JSON.stringify(q.dir)}).length)); process.exit(5); });
    fs.writeFileSync(${JSON.stringify(a)}, ""); setInterval(() => {}, 1000);`);
  await until("the holder runs", () => seen(a));
  holder.c.kill("SIGTERM");
  assert.equal(await holder.done, 5);
  assert.equal(fs.readFileSync(after, "utf8"), "1", "the ticket stood while the command was still running");
  assert.deepEqual(fs.readdirSync(q.dir), []);
});

test("the lock's own failure: the folder cannot be made, and the command does not run", (t) => {
  const q = queue(t);
  fs.writeFileSync(q.dir, "a file where the folder should be");
  const mark = path.join(q.scratch, "ran");
  const r = gateSync(q, "1", ...marks(mark));
  assert.equal(r.code, LOCK_FAILED, r.err);
  assert.ok(!seen(mark), "no slot, no run");
  assert.match(r.err, /no slot, so nothing ran/);
  assert.ok(r.err.includes(q.dir), "it names the folder");
  assert.match(r.err, /MASON_GATE_DIR/);
});

test("the lock's own failure: the folder cannot be written", { skip: process.getuid?.() === 0 ? "root writes anywhere" : false }, (t) => {
  const q = queue(t);
  fs.mkdirSync(q.dir, { mode: 0o500 });
  try {
    const mark = path.join(q.scratch, "ran");
    const r = gateSync(q, "1", ...marks(mark));
    assert.equal(r.code, LOCK_FAILED, r.err);
    assert.ok(!seen(mark));
  } finally {
    fs.chmodSync(q.dir, 0o700);
  }
});

test("the lock's own failure: a damaged ticket refuses, is kept, and the command does not run", (t) => {
  const q = queue(t);
  for (const body of ["not json", JSON.stringify({ pid: 5 }), JSON.stringify({ pid: 999, started: 1, cwd: "/", command: "name and pid differ" })]) {
    const file = plant(q, 1, 5);
    fs.writeFileSync(file, body);
    const mark = path.join(q.scratch, "ran");
    const r = gateSync(q, "1", ...marks(mark));
    assert.equal(r.code, LOCK_FAILED, r.err);
    assert.ok(!seen(mark));
    assert.ok(r.err.includes(file), "it names the file");
    assert.ok(seen(file), "a ticket it cannot read is not one it knows to be stale");
    assert.deepEqual(tickets(q), [path.basename(file)], "the failed run's own ticket went");
  }
});

test("the lock's own failure: a ticket removed under a waiter or a holder is no success, though the command passed", async (t) => {
  const q = queue(t);
  const a = path.join(q.scratch, "a"), end = path.join(q.scratch, "end");
  const holder = gate(q, "1", ...holds(a, end));
  await until("the holder runs", () => seen(a));
  const b = path.join(q.scratch, "b");
  const waiter = gate(q, "1", ...marks(b));
  await until("the waiter waits", () => waiter.err().includes("waiting"));
  fs.rmSync(path.join(q.dir, tickets(q).find((f) => f.endsWith(`-${waiter.c.pid}.ticket`))!));
  assert.equal(await waiter.done, LOCK_FAILED, waiter.err());
  assert.match(waiter.err(), /is gone from the queue/);
  assert.ok(!seen(b));

  fs.rmSync(path.join(q.dir, tickets(q)[0]!));
  fs.writeFileSync(end, "");
  assert.equal(await holder.done, LOCK_FAILED, holder.err());
  assert.match(holder.err(), /the slot failed, so the exit is not the command's 0/);
});

test("MASON_GATE_SLOTS that is not a positive integer refuses", (t) => {
  const q = queue(t);
  const mark = path.join(q.scratch, "ran");
  for (const bad of ["0", "-1", "two", "1.5", "", " 2"]) {
    const r = gateSync(q, bad, ...marks(mark));
    assert.equal(r.code, LOCK_FAILED, `${JSON.stringify(bad)}: ${r.err}`);
    assert.match(r.err, /MASON_GATE_SLOTS is .* positive integer/);
    assert.ok(!seen(mark));
  }
  assert.equal(gateSync(q, undefined, ...marks(mark)).code, 0, "unset is the default");
});

test("no command is a usage error, not a run", () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: scripts\/gate-slot\.ts <command>/);
});

const packageScripts = (): Record<string, string> =>
  (JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;

test("the heavy gates queue, and CI's steps do not need to", () => {
  const scripts = packageScripts();
  for (const name of ["check", "gate", "test:integration"]) assert.match(scripts[name]!, /^node scripts\/gate-slot\.ts /, `${name} takes a slot`);
  for (const name of ["typecheck", "test"]) assert.doesNotMatch(scripts[name]!, /gate-slot/, `${name} is what CI and a targeted run call: no slot`);
  assert.match(scripts["check"]!, /npm run typecheck && npm test/);
  assert.match(scripts["test:integration"]!, /--test-concurrency=1/);
  // npm test carries the per-test bound (scripts/gate.ts, which a package.json cannot import) BEFORE its glob, where Node
  // reads it, and so does npm run check, which runs it (issue 139)
  assert.equal(scripts["test"], `node --test ${gatePlan.TEST_BOUND_ARGS.join(" ")} 'tests/**/*.test.ts'`);
  assert.equal(scripts["test"], "node --test --test-timeout=300000 --test-force-exit 'tests/**/*.test.ts'");
});

/**
 * A test that never settles and holds an interval, as issue 139's hang did (0.43 s of CPU in 2h07, never exiting). The
 * interval ends its own process once its runner is gone (its parent is then init) or after 90 s, far past every bound
 * here, so a run of this file that is itself killed (a gate cut short) leaves no process behind.
 */
const HANG = `import { test } from "node:test";
const born = Date.now(), runner = process.ppid;
test("hangs", () => new Promise(() => { setInterval(() => { if (process.ppid !== runner || Date.now() - born > 90_000) process.exit(3); }, 500); }));
test("after", () => {});
`;

/** Runs npm test's own options (the limit swapped to 1 s) over the hung fixture; its process group, killed if left. */
function runHung(t: { after: (fn: () => void) => void }, options: (scriptOptions: string[]) => string[]): { child: ChildProcess; out: () => string; exit: Promise<number | null> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-slot-hang-"));
  fs.writeFileSync(path.join(dir, "hang.test.mjs"), HANG);
  const words = packageScripts()["test"]!.split(" ");
  assert.equal(words[0], "node");
  const scriptOptions = words.slice(1).filter((w) => w.startsWith("--")).map((w) => w.replace(/^--test-timeout=\d+$/, "--test-timeout=1000"));
  // NODE_TEST_CONTEXT: this file runs under the test runner, and a runner that inherits it reports to a parent
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  const child = spawn(process.execPath, [...options(scriptOptions), "hang.test.mjs"], { cwd: dir, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout!.on("data", (b: Buffer) => { out += b.toString(); });
  child.stderr!.on("data", (b: Buffer) => { out += b.toString(); });
  const exit = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid!, "SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { child, out: () => out, exit };
}

test("a hung test that holds a handle ends npm test's run, named, and without --test-force-exit it would not", async (t) => {
  const bounded = runHung(t, (o) => o);
  const ended = await Promise.race([bounded.exit, new Promise<"bound">((resolve) => setTimeout(resolve, 30_000, "bound").unref())]);
  assert.equal(ended, 1, `the run ends, failed, within 30 s:\n${bounded.out()}`);
  assert.match(bounded.out(), /✖ hangs/);
  assert.match(bounded.out(), /test timed out after 1000ms/);

  // the control: the same options less --test-force-exit name nothing that ends the process, so the run is still there
  const unbounded = runHung(t, (o) => o.filter((w) => w !== "--test-force-exit"));
  const still = await Promise.race([unbounded.exit, new Promise<"running">((resolve) => setTimeout(resolve, 5_000, "running").unref())]);
  assert.equal(still, "running", `without --test-force-exit the run should still be alive after 5 s:\n${unbounded.out()}`);
  process.kill(-unbounded.child.pid!, "SIGKILL");
  await unbounded.exit;
});
