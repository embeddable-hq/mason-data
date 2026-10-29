/**
 * The demo project, the CLI's side (src/cli/demo.ts): the settings the run reads, the demo database's port read back
 * from the URL it is kept in, replication refused, the database opened and its failures said, the writer, the close.
 * The database itself (src/demo/source.ts) is held by its own tests; here it is a fake with the contract's handle.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { matrixEnv, runMason } from "./cli-matrix.ts";
import { unassignedPort } from "./test-ports.ts";
// imported when the tests run: at a commit without the module the file still loads, and each test fails by name
const demo = await import("../src/cli/demo.ts" as string).catch(() => ({})) as Record<string, unknown>;
const fn = <A extends unknown[], R>(name: string): ((...a: A) => R) => {
  const f = demo[name];
  assert.equal(typeof f, "function", `src/cli/demo.ts exports ${name}`);
  return f as (...a: A) => R;
};

test("MASON_DEMO_CHANGE_MS: how often the demo changes, 5 s by default; a value that is no number of milliseconds refused with the way out", () => {
  const demoSettings = fn<[NodeJS.ProcessEnv], { changeMs: number }>("demoSettings");
  assert.deepEqual(demoSettings({}), { changeMs: 5000 });
  assert.deepEqual(demoSettings({ MASON_DEMO_CHANGE_MS: "" }), { changeMs: 5000 });
  assert.deepEqual(demoSettings({ MASON_DEMO_CHANGE_MS: "2000" }), { changeMs: 2000 });
  for (const v of ["abc", "0", "50", "1.5", "-1", "5s"]) {
    assert.throws(() => demoSettings({ MASON_DEMO_CHANGE_MS: v }), new RegExp(`^Error: MASON_DEMO_CHANGE_MS=${JSON.stringify(v).replace(/[.]/g, "\\.")} is not a number of milliseconds: ` +
      "how often the demo database changes \\(a new order, an older one's status moved on\\); set it to 100 or more, or unset it for 5000$"), v);
  }
});

test("the demo database's port is read from the URL it is kept in, at once (nothing is loaded to read it); any other URL is refused with the way out", () => {
  const demoPort = fn<[string, string], { port: number } | { problem: string }>("demoPort");
  const from = "DATABASE_URL in .env";
  const read = demoPort("postgres://demo@127.0.0.1:5434/demo", from);
  assert.ok(!(read instanceof Promise), "demoPort answers synchronously: it loads no module to build the URL it compares");
  assert.deepEqual(read, { port: 5434 });
  assert.deepEqual(demoPort("postgres://demo@127.0.0.1:61234/demo", from), { port: 61234 });
  const wayOut = "mason destroy and mason init demo again in a new folder, or put the URL back";
  for (const [url, port] of [["postgres://me@127.0.0.1:5434/demo", 5434], ["postgres://demo:pw@127.0.0.1:5434/demo", 5434], ["postgres://demo@127.0.0.1:5434/shop", 5434],
    ["postgres://demo@localhost:5434/demo", 5434], ["postgres://demo@127.0.0.1:5434/demo?sslmode=disable", 5434], ["postgres://demo@127.0.0.1/demo", 5432]] as const) {
    assert.deepEqual(demoPort(url, from), { problem: `DATABASE_URL in .env was changed: the demo database is postgres://demo@127.0.0.1:${port}/demo; ${wayOut}` }, url);
  }
  assert.deepEqual(demoPort("postgres://demo@db.example.com:5434/demo", from),
    { problem: `DATABASE_URL in .env names db.example.com, which is not this machine's loopback: the demo database is hosted by mason start on 127.0.0.1 alone (postgres://demo@127.0.0.1:5434/demo); ${wayOut}` });
  const notUrl = demoPort("not a url", from) as { problem: string };
  assert.match(notUrl.problem, /^DATABASE_URL in \.env was changed: "not a url" is not a URL\..* The demo database is postgres:\/\/demo@127\.0\.0\.1:<port>\/demo; mason destroy and mason init demo again/);
});

test("a demo project is polled: --replication, or a config edited to it, refused before anything starts; any other project untouched", () => {
  const refusal = fn<[{ demo?: boolean; changes?: "poll" | "replication" }, "poll" | "replication" | null], { message: string; code: string; why: string; fix: string; next: Array<[string, string]> } | null>("demoChangesRefusal");
  assert.equal(refusal({}, "replication"), null, "a project of its own database replicates as it may");
  assert.equal(refusal({ demo: true }, null), null);
  assert.equal(refusal({ demo: true }, "poll"), null);
  assert.equal(refusal({ demo: true, changes: "replication" }, "poll"), null, "--poll takes it back");
  assert.deepEqual(refusal({ demo: true }, "replication"), { message: "the demo database is read by polling only: --replication does not apply to it", code: "refused",
    why: "the demo database has no change log for logical replication to read; mason start polls it with SELECTs, every few seconds",
    fix: "mason start, without --replication", next: [["mason start", "the demo database and Mason, polled"]] });
  assert.equal(refusal({ demo: true, changes: "replication" }, null)!.fix, `remove "changes": "replication" from .mason/config.json, then mason start`);
});

/** A fake of the demo database's handle (src/demo/source.ts DemoSource): what the run uses. */
function fake(o: { port?: number; seeded?: boolean; change?: () => Promise<string>; close?: () => Promise<void> } = {}): { port: number; seeded: boolean; change: () => Promise<string>; close: () => Promise<void> } {
  return { port: o.port ?? 5434, seeded: o.seeded ?? true, change: o.change ?? (async () => "a change"), close: o.close ?? (async () => undefined) };
}

test("the demo database opened in .mason/demo, its done line seeded or kept; an open that fails said with its message, and a held port's way out once, moving the demo among it", async () => {
  const openDemo = fn<[{ home: string; port: number; from: string; log: (l: string) => void; open?: (a: { dir: string; port: number; log: (l: string) => void }) => Promise<unknown> }], Promise<{ demo: unknown; done: string } | { problem: string }>>("openDemo");
  const from = "DATABASE_URL in .env";
  const asked: Array<{ dir: string; port: number }> = [];
  const seeded = await openDemo({ home: "/p/.mason", port: 5434, from, log: () => undefined, open: async (a) => { asked.push({ dir: a.dir, port: a.port }); return fake({ port: a.port, seeded: true }); } });
  assert.deepEqual(asked, [{ dir: "/p/.mason/demo", port: 5434 }]);
  assert.equal((seeded as { done: string }).done, "Demo database on 127.0.0.1:5434 (Postgres, hosted by this process in .mason/demo; seeded with the shop schema)");
  const kept = await openDemo({ home: "/p/.mason", port: 5434, from, log: () => undefined, open: async () => fake({ seeded: false }) });
  assert.equal((kept as { done: string }).done, "Demo database on 127.0.0.1:5434 (Postgres, hosted by this process in .mason/demo; kept from the last run)");
  // a port nobody holds: the open's own message alone (openDemo asks who holds it, so it must stay unheld until then:
  // out of the kernel's ephemeral range, tests/test-ports.ts)
  const free = await unassignedPort();
  const broken = await openDemo({ home: "/p/.mason", port: free, from, log: () => undefined, open: async () => { throw new Error("the folder is not a database"); } });
  assert.deepEqual(broken, { problem: "the demo database did not start: the folder is not a database" });
  // a held port: the open's own words (what failed), then the way out once — an earlier run (mason stop), what holds
  // it, or the demo moved by its URL's port, the one place the port is kept
  const holder = net.createServer();
  const held = await new Promise<number>((resolve) => holder.listen(0, "127.0.0.1", () => resolve((holder.address() as net.AddressInfo).port)));
  try {
    const refused = await openDemo({ home: "/p/.mason", port: held, from, log: () => undefined,
      open: async () => { throw new Error(`the demo database cannot listen on 127.0.0.1:${held}: port ${held} is in use`); } }) as { problem: string };
    assert.equal(refused.problem, `the demo database did not start: the demo database cannot listen on 127.0.0.1:${held}: port ${held} is in use: ` +
      `mason stop ends a run that may still hold it, else stop what does (lsof -nP -iTCP:${held} -sTCP:LISTEN names it), ` +
      `or move the demo database: change the port in DATABASE_URL in .env (postgres://demo@127.0.0.1:<another>/demo) and mason start again`);
    assert.equal(refused.problem.match(/in use/g)?.length, 1, "the port in use is said once");
  } finally { await new Promise((r) => holder.close(r)); }
});

test("the writer: a round of changes every few ms, each line logged; a round that fails said and the next tried; never two at once; stopped for good", async () => {
  const demoChanges = fn<[{ change: () => Promise<string> }, number, (l: string) => void], () => void>("demoChanges");
  const lines: string[] = [];
  let n = 0, running = 0, most = 0;
  const stop = demoChanges({ change: async () => {
    running++; most = Math.max(most, running);
    await new Promise((r) => setTimeout(r, 35));   // slower than the interval: a round is never begun on top of it
    running--;
    if (++n === 2) throw new Error("the order could not be written");
    return `order ${n} placed`;
  } }, 10, (l) => lines.push(l));
  // at least three rounds, with room for a loaded machine
  for (let waited = 0; lines.length < 3 && waited < 5000; waited += 20) await new Promise((r) => setTimeout(r, 20));
  stop();
  const after = n;
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(n - after <= 1, "stopped: at most the round under way finishes");
  assert.equal(most, 1, "one round at a time");
  assert.equal(lines[0], "order 1 placed");
  assert.equal(lines[1], "a change failed (the next one is tried in 0.01 s): the order could not be written");
  assert.equal(lines[2], "order 3 placed", "the next round after a failure");
  stop();   // idempotent
});

test("the demo database is closed once however often it is asked, and a close that fails is said, never swallowed", async () => {
  const closingOnce = fn<[{ close: () => Promise<void> }], () => Promise<string | null>>("closingOnce");
  let closes = 0;
  const once = closingOnce({ close: async () => { closes++; } });
  assert.equal(await once(), null);
  assert.equal(await once(), null);
  assert.equal(closes, 1);
  const failing = closingOnce({ close: async () => { throw new Error("its data could not be flushed"); } });
  assert.equal(await failing(), "its data could not be flushed");
});

test("a demo database still closing when the crash path stops waiting is said, never silent; one that closed in time says nothing", async () => {
  const closedWithin = fn<[Promise<unknown>, number, () => void], Promise<void>>("closedWithin");
  const still = fn<[number], string>("DEMO_STILL_CLOSING");
  assert.equal(still(2_000), "closing the demo database: still closing after 2 s; its data may need seeding again at the next start");
  let late = 0;
  await closedWithin(new Promise(() => undefined), 20, () => { late++; });
  assert.equal(late, 1, "a close past the wait is said");
  const t0 = Date.now();
  await closedWithin(Promise.resolve(null), 5_000, () => { late++; });
  assert.equal(late, 1, "a close in time says nothing");
  assert.ok(Date.now() - t0 < 1_000, "and is not waited past");
  await assert.rejects(closedWithin(Promise.reject(new Error("its data could not be flushed")), 5_000, () => { late++; }), /its data could not be flushed/);
});

const MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "main.ts");
const tmp = (what: string): string => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `mason-cli-demo-${what}-`));

/** A child node that refuses to load PGlite (a resolve hook), running `args`: its exit and output. */
async function withoutPglite(dir: string, cwd: string, args: string[]): Promise<{ code: number | null; out: string }> {
  const hook = path.join(dir, "no-pglite.mjs");
  fs.writeFileSync(hook, `import { registerHooks } from "node:module";
registerHooks({ resolve(spec, ctx, next) {
  if (spec === "@electric-sql/pglite" || spec.startsWith("@electric-sql/pglite/")) throw new Error("PGLITE LOADED from " + ctx.parentURL);
  return next(spec, ctx);
} });
`);
  const child = spawn(process.execPath, ["--import", pathToFileURL(hook).href, ...args], { cwd, env: matrixEnv(), stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (b: Buffer) => { out += b.toString(); });
  child.stderr.on("data", (b: Buffer) => { out += b.toString(); });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { code, out };
}

test("mason init demo and the run's port check never load the demo database's module (PGlite): the URL is the seed's module's", async () => {
  const dir = tmp("graph");
  try {
    const demoTs = pathToFileURL(path.resolve(path.dirname(MAIN), "demo.ts")).href;
    const seedTs = pathToFileURL(path.resolve(path.dirname(MAIN), "..", "demo", "seed.ts")).href;
    const read = await withoutPglite(dir, dir, ["--input-type=module", "-e",
      `const d = await import(${JSON.stringify(demoTs)}); const s = await import(${JSON.stringify(seedTs)});
       const r = d.demoPort(s.demoUrl(5434), "DATABASE_URL in .env");
       process.stdout.write(JSON.stringify({ sync: !(r instanceof Promise), value: await r, tables: s.DEMO_TABLES }));`]);
    assert.equal(read.code, 0, read.out);
    assert.deepEqual(JSON.parse(read.out), { sync: true, value: { port: 5434 }, tables: ["customers", "products", "orders", "order_items"] });
    const project = path.join(dir, "project");
    fs.mkdirSync(project);
    const init = await withoutPglite(dir, project, [MAIN, "init", "demo", "--json"]);
    assert.equal(init.code, 0, init.out);
    assert.equal((JSON.parse(init.out) as { demo: boolean }).demo, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the Postgres API's port avoids the demo database's: a MASON_PG_PORT or a recorded port that is the demo's is refused where mason start was typed, and nothing is recorded", async () => {
  const dir = tmp("ports");
  try {
    const init = await runMason(dir, ["init", "demo", "--json"], matrixEnv());
    assert.equal(init.code, 0, init.stdout + init.stderr);
    const env = fs.readFileSync(path.join(dir, ".env"), "utf8");
    const demoPort = Number(/^DATABASE_URL=postgres:\/\/demo@127\.0\.0\.1:(\d+)\/demo$/m.exec(env)?.[1]);
    assert.ok(demoPort > 0, env);
    const configFile = path.join(dir, ".mason", "config.json");
    const pgPortOf = (): unknown => (JSON.parse(fs.readFileSync(configFile, "utf8")) as { pgPort?: unknown }).pgPort;
    const held = `something holds port ${demoPort} on this mason start (chosen for another listener)`;
    // named in the shell: refused by the start a person typed (and its --json), before a run is spawned
    const named = await runMason(dir, ["start", "--json"], matrixEnv({ MASON_PG_PORT: String(demoPort) }));
    assert.equal(named.code, 1, named.stdout + named.stderr);
    const error = (JSON.parse(named.stdout) as { error: { code: string; message: string; why: string } }).error;
    assert.deepEqual([error.code, error.message, error.why], ["refused", `MASON_PG_PORT=${demoPort} is in use`, `${held}, so the Postgres API cannot listen there`]);
    assert.equal(pgPortOf(), undefined, "a refused port is not recorded");
    // the run itself refuses it too (a port may be taken between the two), and records nothing
    const attached = await runMason(dir, ["start", "--attach"], matrixEnv({ MASON_PG_PORT: String(demoPort) }));
    assert.equal(attached.code, 1, attached.stdout + attached.stderr);
    assert.match(attached.stdout + attached.stderr, new RegExp(`mason start: MASON_PG_PORT=${demoPort} is in use`));
    assert.equal(pgPortOf(), undefined, "the run records no refused port");
    // a project's recorded port that is the demo's (an edited .env): refused by the project's own words
    const cfg = JSON.parse(fs.readFileSync(configFile, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(configFile, JSON.stringify({ ...cfg, pgPort: demoPort }), { mode: 0o600 });
    const recorded = await runMason(dir, ["start", "--json"], matrixEnv());
    assert.equal(recorded.code, 1, recorded.stdout + recorded.stderr);
    const e2 = (JSON.parse(recorded.stdout) as { error: { message: string; why: string } }).error;
    assert.equal(e2.message, `this project's Postgres API port ${demoPort} is in use`);
    assert.match(e2.why, new RegExp(`^${held.replace(/[()]/g, "\\$&")}, so the Postgres API cannot listen there`));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
