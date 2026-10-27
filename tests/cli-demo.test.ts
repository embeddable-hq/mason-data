/**
 * The demo project, the CLI's side (src/cli/demo.ts): the settings the run reads, the demo database's port read back
 * from the URL it is kept in, replication refused, the database opened and its failures said, the writer, the close.
 * The database itself (src/demo/source.ts) is held by its own tests; here it is a fake with the contract's handle.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as net from "node:net";
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

test("the demo database's port is read from the URL it is kept in; any other URL is refused with the way out", async () => {
  const demoPort = fn<[string, string], Promise<{ port: number } | { problem: string }>>("demoPort");
  const from = "DATABASE_URL in .env";
  assert.deepEqual(await demoPort("postgres://demo@127.0.0.1:5434/demo", from), { port: 5434 });
  assert.deepEqual(await demoPort("postgres://demo@127.0.0.1:61234/demo", from), { port: 61234 });
  const wayOut = "mason destroy and mason init demo again in a new folder, or put the URL back";
  for (const [url, port] of [["postgres://me@127.0.0.1:5434/demo", 5434], ["postgres://demo:pw@127.0.0.1:5434/demo", 5434], ["postgres://demo@127.0.0.1:5434/shop", 5434],
    ["postgres://demo@localhost:5434/demo", 5434], ["postgres://demo@127.0.0.1:5434/demo?sslmode=disable", 5434], ["postgres://demo@127.0.0.1/demo", 5432]] as const) {
    assert.deepEqual(await demoPort(url, from), { problem: `DATABASE_URL in .env was changed: the demo database is postgres://demo@127.0.0.1:${port}/demo; ${wayOut}` }, url);
  }
  assert.deepEqual(await demoPort("postgres://demo@db.example.com:5434/demo", from),
    { problem: `DATABASE_URL in .env names db.example.com, which is not this machine's loopback: the demo database is hosted by mason start on 127.0.0.1 alone (postgres://demo@127.0.0.1:5434/demo); ${wayOut}` });
  const notUrl = await demoPort("not a url", from) as { problem: string };
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

test("the demo database opened in .mason/demo, its done line seeded or kept; an open that fails said with its message, and who holds a held port", async () => {
  const openDemo = fn<[{ home: string; port: number; log: (l: string) => void; open?: (a: { dir: string; port: number; log: (l: string) => void }) => Promise<unknown> }], Promise<{ demo: unknown; done: string } | { problem: string }>>("openDemo");
  const asked: Array<{ dir: string; port: number }> = [];
  const seeded = await openDemo({ home: "/p/.mason", port: 5434, log: () => undefined, open: async (a) => { asked.push({ dir: a.dir, port: a.port }); return fake({ port: a.port, seeded: true }); } });
  assert.deepEqual(asked, [{ dir: "/p/.mason/demo", port: 5434 }]);
  assert.equal((seeded as { done: string }).done, "Demo database on 127.0.0.1:5434 (Postgres, hosted by this process in .mason/demo; seeded with the shop schema)");
  const kept = await openDemo({ home: "/p/.mason", port: 5434, log: () => undefined, open: async () => fake({ seeded: false }) });
  assert.equal((kept as { done: string }).done, "Demo database on 127.0.0.1:5434 (Postgres, hosted by this process in .mason/demo; kept from the last run)");
  // a port nobody holds: the open's own message alone
  const free = await new Promise<number>((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
  const broken = await openDemo({ home: "/p/.mason", port: free, log: () => undefined, open: async () => { throw new Error("the folder is not a database"); } });
  assert.deepEqual(broken, { problem: "the demo database did not start: the folder is not a database" });
  // a held port: who holds it, and that an earlier run may (mason stop)
  const holder = net.createServer();
  const held = await new Promise<number>((resolve) => holder.listen(0, "127.0.0.1", () => resolve((holder.address() as net.AddressInfo).port)));
  try {
    const refused = await openDemo({ home: "/p/.mason", port: held, log: () => undefined, open: async () => { throw new Error(`port ${held} is in use`); } }) as { problem: string };
    assert.equal(refused.problem, `the demo database did not start: port ${held} is in use (something holds port ${held} on 127.0.0.1 (EADDRINUSE): ` +
      `mason stop ends a run that may still hold it, else stop what does — lsof -nP -iTCP:${held} -sTCP:LISTEN names it)`);
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
