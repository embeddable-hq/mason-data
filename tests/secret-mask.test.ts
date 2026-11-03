/**
 * A caught error's words as Mason repeats them (src/lib/secret-mask.ts `errorText`, issue 599), alone: the one form a
 * connection string carries a password in (`password=`) masked whatever the password, nothing else ever changed — no
 * identifier cut, so none shows where a password sits — and the two rules the sync and the stream are held to: an
 * error's words are made only through `errorText`, and no branch reads those words (it reads `messageOf`). And the
 * ATTACH's path, which holds no credential (src/duck/sync.ts `attachPath`, `sourceSecretSql`). Each module is imported
 * inside its test, so the file loads at a commit without them and the test fails by name there
 * (scripts/fails-without.ts).
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

type MaskModule = typeof import("../src/lib/secret-mask.ts");
const mod = (): Promise<MaskModule> => import("../src/lib/secret-mask.ts");

test("an error's words: any password= keyword's value is masked whatever it is — quoted with libpq's escapes, bare, any case — and the rest of the words stand", async () => {
  const { errorText, maskPasswordKeyword } = await mod();
  const old = `IO Error: Unable to connect to Postgres at "host='db.internal' port='5432' dbname='app' user='reader' password='old\\'pw\\\\x' sslmode='prefer' application_name='mason-data'": connection to server at "10.0.0.1", port 5432 failed: Connection refused`;
  const want = `IO Error: Unable to connect to Postgres at "host='db.internal' port='5432' dbname='app' user='reader' password=**** sslmode='prefer' application_name='mason-data'": connection to server at "10.0.0.1", port 5432 failed: Connection refused`;
  assert.equal(errorText(new Error(old)), want);
  assert.equal(maskPasswordKeyword(old), want);
  for (const pw of [`s3cr3t-Pw`, `a b'c\\d=e@f%g:h"i`, `ünï cødé/?#&+`, "dev", "e", "orders2024"]) {
    const libpq = pw.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const said = errorText(new Error(`Unable to connect to Postgres at "user='u' password='${libpq}' sslmode='prefer'": FATAL`));
    assert.equal(said, `Unable to connect to Postgres at "user='u' password=**** sslmode='prefer'": FATAL`, JSON.stringify(pw));
  }
  assert.equal(errorText(new Error("password=bare123 host=h")), "password=**** host=h");
  assert.equal(errorText("PASSWORD = 'Quoted Value' x"), "PASSWORD = **** x");
  assert.equal(maskPasswordKeyword("password='cut off"), "password=****");
  // a stack, when asked for, the same way
  assert.match(errorText(new Error("failed: password='p9x!q'"), { stack: true }), /^Error: failed: password=\*\*\*\*\n\s+at /);
});

test("an error's words never cut an identifier: a table, a user or Mason's own words holding a password's letters read whole, so none shows where it sits", async () => {
  const { errorText } = await mod();
  // the review of PR 620 round 2: each was masked to `public.****_archive`, `for user "****"`, `[public.****ices]`
  for (const words of [
    "public.orders2024_archive: reading its changed rows from the source into the poll's stage: Binder Error: Referenced column \"v\" not found",
    "FATAL: password authentication failed for user \"reporting2024\"",
    "mason: a numeric value wider than its synced column [public.devices]: amount = 12345.678",
    "cannot rollback - no transaction is active",
    "IO Error: Unable to connect to Postgres at \"sslmode='prefer' application_name='mason-data'\": could not translate host name \"db.internal\"",
  ]) assert.equal(errorText(new Error(words)), words);
});

test("the sync and the stream make a caught error's words only through errorText, and decide only on messageOf: no branch reads the words Mason repeats", () => {
  // (1) a dependency's message made text any other way (`e instanceof Error ? e.message : String(e)`, `(e as Error).message`,
  // a stack) is text the mask never saw
  const made: string[] = [];
  // (2) the words errorText made, read by a branch: a match, a test, a comparison of them (the review of PR 620 round 2:
  // a catch-up's wider numeric and a ROLLBACK's `no transaction is active` were matched on them)
  const decided: string[] = [];
  const READS = (v: string): RegExp => new RegExp(`\\b${v}\\s*\\.(includes|match|startsWith|endsWith|search|indexOf)\\(|\\.(test|exec)\\(\\s*${v}\\s*\\)|\\b${v}\\s*[!=]==|[!=]==\\s*${v}\\b`);
  for (const file of ["src/duck/sync.ts", "src/duck/stream.ts"]) {
    const lines = fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8").split("\n");
    lines.forEach((line, i) => {
      if (/instanceof Error \? \w+\.(message|stack)|\(\w+ as Error\)\.(message|stack)|\.stack\b/.test(line)) made.push(`${file}:${i + 1}: ${line.trim()}`);
      if (/errorText\(/.test(line) && /\.(includes|match|startsWith|endsWith|search|test|exec)\(\s*[^)]*errorText\(|errorText\([^)]*\)\s*\.(includes|match|startsWith|endsWith|search|indexOf)\(/.test(line)) decided.push(`${file}:${i + 1}: ${line.trim()}`);
      // a name bound to its words: every line after it, to the end of its method (a line closing at two spaces' indent)
      const bound = /\b(?:const|let)\s+(\w+)\s*=\s*(?:this\.)?errorText\(/.exec(line);
      if (bound === null) return;
      for (let j = i; j < lines.length && !(j > i && /^ {2}\}/.test(lines[j]!)); j++) {
        if (READS(bound[1]!).test(lines[j]!)) decided.push(`${file}:${j + 1}: ${lines[j]!.trim()} (${bound[1]} is errorText's, line ${i + 1})`);
      }
    });
  }
  assert.deepEqual(made, [], "make a caught error's words with errorText (src/lib/secret-mask.ts), the sync's this.errorText");
  assert.deepEqual(decided, [], "decide on an error's raw words, messageOf (src/lib/secret-mask.ts), never on errorText's");
});

test("the guard catches the real thing: a branch on errorText's words, bound or inline", () => {
  // the shapes round 2 met, as the guard above reads them
  const READS = (v: string): RegExp => new RegExp(`\\b${v}\\s*\\.(includes|match|startsWith|endsWith|search|indexOf)\\(|\\.(test|exec)\\(\\s*${v}\\s*\\)|\\b${v}\\s*[!=]==|[!=]==\\s*${v}\\b`);
  assert.ok(READS("m").test("          if (m.includes(`${WIDER} [${t.source}]`)) {"));
  assert.ok(READS("said").test("                if (/no transaction is active/.test(said)) { rolledBack = true; break; }"));
  assert.ok(!READS("m").test("            this.log(`${t.source}: … (${m})`);"));
});

test("a decision on a wider numeric reads the raw words, whatever the password: widerIn", async () => {
  const sync = await import("../src/duck/sync.ts") as unknown as { widerIn?: (e: unknown, source: string) => boolean };
  assert.equal(typeof sync.widerIn, "function", "src/duck/sync.ts widerIn");
  // the review's inputs: dev and public.devices, public, mason, orders2024 and public.orders2024_archive — the decision
  // takes no password at all, so none of them can change it
  for (const source of ["public.devices", "public.orders", "public.orders2024_archive", "mason_internal.t"]) {
    assert.equal(sync.widerIn!(new Error(`mason: a numeric value wider than its synced column [${source}]: amount = 12345.678`), source), true, source);
    assert.equal(sync.widerIn!(new Error(`mason: a numeric value wider than its synced column [${source}x]: amount = 1`), source), false, source);
  }
});

test("a ROLLBACK the engine had ended itself reads as rolled back, whatever the password (`active` among them): endedTransaction", async () => {
  const sync = await import("../src/duck/sync.ts") as unknown as { endedTransaction?: (e: unknown) => boolean };
  assert.equal(typeof sync.endedTransaction, "function", "src/duck/sync.ts endedTransaction");
  assert.equal(sync.endedTransaction!(new Error("TransactionContext Error: cannot rollback - no transaction is active")), true);
  assert.equal(sync.endedTransaction!(new Error("IO Error: could not write the chunk")), false);
});

test("the ATTACH's path holds no credential: the engine is given them only as a temporary secret", async () => {
  const sync = await import("../src/duck/sync.ts") as unknown as {
    attachPath?: (s: { sslmode: string }) => string;
    sourceSecretSql?: (s: { host: string; port: number; database: string; user: string; password: string }) => string;
  };
  assert.equal(typeof sync.attachPath, "function", "src/duck/sync.ts attachPath");
  assert.equal(typeof sync.sourceSecretSql, "function", "src/duck/sync.ts sourceSecretSql");
  const source = { host: "db.internal", port: 5432, database: "orders_db", user: "reader", password: "s3cr3t'Pw", sslmode: "prefer" };
  const p = sync.attachPath!(source);
  assert.equal(p, "sslmode='prefer' application_name='mason-data'");
  for (const v of [source.host, source.user, source.database, "s3cr3t"]) assert.ok(!p.includes(v), `${p} names ${v}`);
  const secret = sync.sourceSecretSql!(source);
  assert.match(secret, /^CREATE OR REPLACE TEMPORARY SECRET \w+ \(TYPE postgres, /);
  assert.ok(secret.includes("PASSWORD 's3cr3t''Pw'"), secret);
  assert.ok(!sync.sourceSecretSql!({ ...source, password: "" }).includes("PASSWORD"));
});
