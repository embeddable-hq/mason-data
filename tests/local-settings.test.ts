/**
 * A LIMIT MASON SETS ENDS WITH MASON'S OWN WORK (src/lib/local-settings.ts, issue 930): `SET LOCAL` inside one
 * read-only transaction, never a session SET, and the transaction ended on every way out — COMMIT, else ROLLBACK while
 * the connection answers (bounded), else the caller's close. The work's own error is thrown as it was.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";

// loaded so this file fails by name where the module does not exist (scripts/fails-without.ts), never "did not load"
const m = await import("../src/lib/local-settings.ts" as string).catch(() => ({})) as Partial<typeof import("../src/lib/local-settings.ts")>;

/** A connection that records each statement and fails or hangs the ones asked. */
function fake(o: { fail?: RegExp; hang?: RegExp; closed?: boolean } = {}): { sent: string[]; query: (sql: string) => Promise<unknown>; answers: () => boolean } {
  const sent: string[] = [];
  return {
    sent,
    answers: () => o.closed !== true,
    query: (sql: string) => {
      sent.push(sql);
      if (o.hang?.test(sql)) return new Promise(() => undefined);
      if (o.fail?.test(sql)) return Promise.reject(Object.assign(new Error(`refused: ${sql}`), { code: "57014" }));
      return Promise.resolve({ rows: [] });
    },
  };
}

const run = async (c: ReturnType<typeof fake>, work: () => Promise<unknown>, extra: Record<string, unknown> = {}): Promise<{ sent: string[]; out: unknown; error: unknown; logged: string[] }> => {
  assert.equal(typeof m.withLocalSettings, "function", "src/lib/local-settings.ts exports withLocalSettings");
  const logged: string[] = [];
  let out: unknown = null, error: unknown = null;
  try { out = await m.withLocalSettings!({ query: c.query, answers: c.answers, settings: [["statement_timeout", 10_000]], work, log: (l) => logged.push(l), ...extra }); }
  catch (e) { error = e; }
  return { sent: c.sent, out, error, logged };
};

test("the work runs inside BEGIN READ ONLY under SET LOCAL, then COMMIT: never a session SET", async () => {
  const c = fake();
  const r = await run(c, async () => { await c.query("SELECT 1"); return 42; });
  assert.deepEqual(r, { sent: ["BEGIN READ ONLY", "SET LOCAL statement_timeout = 10000", "SELECT 1", "COMMIT"], out: 42, error: null, logged: [] });
});

test("every failure ends the transaction: the work's, the SET's, the COMMIT's — ROLLBACK, and the error thrown as it was", async () => {
  for (const [at, expected] of [
    [/SELECT/, ["BEGIN READ ONLY", "SET LOCAL statement_timeout = 10000", "SELECT 1", "ROLLBACK"]],
    [/SET LOCAL/, ["BEGIN READ ONLY", "SET LOCAL statement_timeout = 10000", "ROLLBACK"]],
    [/COMMIT/, ["BEGIN READ ONLY", "SET LOCAL statement_timeout = 10000", "SELECT 1", "COMMIT", "ROLLBACK"]],
  ] as const) {
    const c = fake({ fail: at });
    const r = await run(c, async () => { await c.query("SELECT 1"); return 1; });
    assert.deepEqual(r.sent, expected, String(at));
    assert.equal((r.error as { code?: string }).code, "57014", "the error itself, not a wrapper");
  }
  // a BEGIN that failed opened nothing: nothing to roll back
  const c = fake({ fail: /BEGIN/ });
  assert.deepEqual((await run(c, async () => 1)).sent, ["BEGIN READ ONLY"]);
  // an error the work throws itself (not the connection's) ends it too
  const w = fake();
  const thrown = new Error("the work's own");
  const r = await run(w, async () => { throw thrown; });
  assert.deepEqual([r.sent, r.error], [["BEGIN READ ONLY", "SET LOCAL statement_timeout = 10000", "ROLLBACK"], thrown]);
});

test("a ROLLBACK that fails or never answers is said and bounded, the work's error kept; a closed connection is sent none", async () => {
  const failing = fake({ fail: /SELECT|ROLLBACK/ });
  const f = await run(failing, async () => failing.query("SELECT 1"));
  assert.match((f.error as Error).message, /SELECT 1/, "the work's error, not the ROLLBACK's");
  assert.equal(f.logged.length, 1);
  assert.match(f.logged[0]!, /could not be rolled back \(refused: ROLLBACK\): its connection is closed, which ends it/);

  const hanging = fake({ fail: /SELECT/, hang: /ROLLBACK/ });
  const t0 = Date.now();
  const h = await run(hanging, async () => hanging.query("SELECT 1"), { rollbackMs: 50 });
  assert.ok(Date.now() - t0 < 2_000, "waited for the ROLLBACK at most rollbackMs");
  assert.match((h.error as Error).message, /SELECT 1/);

  const closed = fake({ fail: /SELECT/, closed: true });
  assert.deepEqual((await run(closed, async () => closed.query("SELECT 1"))).sent, ["BEGIN READ ONLY", "SET LOCAL statement_timeout = 10000", "SELECT 1"]);

  // settle runs once the work ends, before the ROLLBACK
  const order: string[] = [];
  const s = fake({ fail: /SELECT/ });
  await run({ ...s, query: (sql) => { order.push(sql); return s.query(sql); } }, async () => s.query("SELECT 1"), { settle: () => order.push("settle") });
  assert.deepEqual(order.slice(-2), ["settle", "ROLLBACK"]);
});

test("a setting's name or value that SET would read as something else is refused before anything is sent", async () => {
  assert.equal(typeof m.withLocalSettings, "function", "src/lib/local-settings.ts exports withLocalSettings");
  for (const settings of [[["statement_timeout; DROP TABLE x", 1]], [["Statement_Timeout", 1]], [["statement_timeout", 1.5]], [["statement_timeout", -1]], [["statement_timeout", Number.NaN]]] as const) {
    const c = fake();
    await assert.rejects(m.withLocalSettings!({ query: c.query, settings: settings as never, work: async () => 1, log: () => undefined }), JSON.stringify(settings));
    assert.deepEqual(c.sent, []);
  }
});
