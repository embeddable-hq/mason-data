/**
 * A caught error's words as Mason repeats them (src/lib/secret-mask.ts `errorText`, issue 599), alone: every form a
 * message can carry a password in, the `password=` keyword whatever its value, a short or plain password's error
 * withheld with its code, and the rule that the sync and the stream turn an error into text only through it. And the
 * ATTACH's path, which holds no credential (src/duck/sync.ts `attachPath`, `sourceSecretSql`). Each module is imported
 * inside its test, so the file loads at a commit without them and the test fails by name there
 * (scripts/fails-without.ts).
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

type MaskModule = typeof import("../src/lib/secret-mask.ts");
const mod = (): Promise<MaskModule> => import("../src/lib/secret-mask.ts");

/** passwords that can be masked inside words: libpq's specials, a URL's, SQL's and JSON's, and non-ASCII */
const PASSWORDS = [`s3cr3t-Pw`, `a b'c\\d=e@f%g:h"i`, `ünï cødé/?#&+`, `x'1234`, `\\\\\\\\\\\\`, ` lead9 `, `tab\there`];

test("an error's words: a maskable password in every form a message carries it — raw, URL-encoded, libpq-, SQL- and JSON-quoted — is never left", async () => {
  const { errorText, maskable, MASKED } = await mod();
  for (const pw of PASSWORDS) {
    assert.ok(maskable(pw), JSON.stringify(pw));
    const libpq = pw.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const forms = [
      pw,
      encodeURIComponent(pw),
      // the URL's own encoding of a userinfo password, which is not encodeURIComponent's
      new URL(`postgres://u:${encodeURIComponent(pw)}@h/db`).href,
      `IO Error: Unable to connect to Postgres at "host='h' port='5432' dbname='d' user='u' password='${libpq}' sslmode='prefer'": FATAL`,
      `SELECT '${pw.replace(/'/g, "''")}'`,
      JSON.stringify({ error: `failed: ${pw}` }),
    ];
    for (const text of forms) {
      const masked = errorText(new Error(text), pw);
      for (const leak of [pw, encodeURIComponent(pw), libpq, pw.replace(/'/g, "''"), JSON.stringify(pw).slice(1, -1)]) {
        assert.ok(!masked.includes(leak), `${JSON.stringify(text)} masked to ${JSON.stringify(masked)} still holds ${JSON.stringify(leak)}`);
      }
      assert.ok(masked.includes(MASKED), `${JSON.stringify(masked)} says it masked something`);
    }
    // a stack, when asked for, the same way
    const e = new Error(`the poll failed: ${pw}`);
    assert.ok(!errorText(e, pw, { stack: true }).includes(pw));
    assert.match(errorText(e, pw, { stack: true }), /^Error: the poll failed: \*\*\*\*\n\s+at /);
  }
});

test("an error's words: any password= keyword's value is masked whatever it is (a password since rotated), and the rest of the words stand", async () => {
  const { errorText, maskPasswordKeyword } = await mod();
  const old = `Unable to connect to Postgres at "host='db.internal' port='5432' dbname='app' user='reader' password='old\\'pw\\\\x' sslmode='prefer' application_name='mason-data'": connection to server at "10.0.0.1", port 5432 failed: Connection refused`;
  const want = `Unable to connect to Postgres at "host='db.internal' port='5432' dbname='app' user='reader' password=**** sslmode='prefer' application_name='mason-data'": connection to server at "10.0.0.1", port 5432 failed: Connection refused`;
  assert.equal(errorText(new Error(old), "a-new-one9"), want);
  assert.equal(maskPasswordKeyword(old), want);
  // a password the reader knows nothing of: no secret given
  assert.equal(errorText(new Error("password=bare123 host=h"), null), "password=**** host=h");
  assert.equal(errorText("PASSWORD = 'Quoted Value' x", ""), "PASSWORD = **** x");
  // a quote never closed: to the text's end
  assert.equal(maskPasswordKeyword("password='cut off"), "password=****");
  // nothing to mask: the words as they were, a table's name in them included
  const plain = `Unable to connect to Postgres at "sslmode='prefer' application_name='mason-data'": password authentication failed for user "reader" reading public.devices`;
  assert.equal(errorText(new Error(plain), "s3cr3t-Pw"), plain);
  assert.equal(errorText(new Error(plain), ""), plain);
});

test("a password under 6 characters or of letters alone: an error whose words hold it is withheld, its code kept; one that does not is shown whole", async () => {
  const { errorText, maskable, errorCode } = await mod();
  for (const pw of ["dev", "secret", "Passwort", "ünïcødé", "ab1", "12345"]) assert.equal(maskable(pw), false, JSON.stringify(pw));
  for (const pw of ["s3cr3t", "dev-12", "123456", "a b c!"]) assert.equal(maskable(pw), true, JSON.stringify(pw));
  // a table's name holds the password: the words are withheld, never `public.****ices`, which shows where it sits
  const named = new Error(`Catalog Error: Table public.devices does not exist`);
  const said = errorText(named, "dev");
  assert.match(said, /^an error \(Catalog Error\) whose words are not shown: they hold the database user's password, or a word equal to it, and a password under 6 characters or of letters alone/);
  assert.ok(!said.includes("dev"), said);
  assert.ok(!said.includes("****"), said);
  // the leaked form, the password inside: withheld too
  assert.ok(!errorText(new Error("IO Error: Unable to connect to Postgres at \"password='dev' x\""), "dev").includes("dev"));
  // its code: a SQLSTATE or a system error's, else the engine's kind
  const pg = Object.assign(new Error("FATAL: password authentication failed for user \"dev_user\""), { code: "28P01" });
  assert.match(errorText(pg, "dev"), /^an error \(28P01\) whose words are not shown/);
  const sys = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432 (dev)"), { code: "ECONNREFUSED" });
  assert.equal(errorCode(sys), "ECONNREFUSED");
  assert.match(errorText("dev failed", "dev"), /^an error whose words are not shown/);
  // words that do not hold it: shown as they are
  assert.equal(errorText(new Error("IO Error: connection to server at \"127.0.0.1\", port 5432 failed: Connection refused"), "dev"),
    "IO Error: connection to server at \"127.0.0.1\", port 5432 failed: Connection refused");
});

test("the sync and the stream turn a caught error into words only through errorText: where it enters, once", () => {
  // a dependency's message made text any other way (`e instanceof Error ? e.message : String(e)`, `(e as Error).message`,
  // a stack) is text no mask saw. A use of the message that is not text (matching a kind of failure) is the stream's
  // `away`, read whole and left out here
  const offenders: string[] = [];
  for (const file of ["src/duck/sync.ts", "src/duck/stream.ts"]) {
    const src = fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8").replace(/\nfunction away\([\s\S]*?\n\}\n/, "\n");
    src.split("\n").forEach((line, i) => {
      if (/instanceof Error \? \w+\.(message|stack)|\(\w+ as Error\)\.(message|stack)|\.stack\b/.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], "make a caught error's words with errorText (src/lib/secret-mask.ts), the sync's this.errorText");
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
