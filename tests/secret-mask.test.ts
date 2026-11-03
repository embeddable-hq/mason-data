/**
 * The one mask of the source's password (src/lib/secret-mask.ts, issue 599), alone: every form a message can carry a
 * password in, the `password=` keyword whatever its value, and the walk over an answer. And the ATTACH's path, which
 * holds no credential (src/duck/sync.ts `attachPath`, `sourceSecretSql`). Each module is imported inside its test, so
 * the file loads at a commit without them and the test fails by name there (scripts/fails-without.ts).
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";

type MaskModule = typeof import("../src/lib/secret-mask.ts");
const mod = (): Promise<MaskModule> => import("../src/lib/secret-mask.ts");

/** passwords a person may set: libpq's specials, a URL's, SQL's and JSON's, and non-ASCII */
const PASSWORDS = [`s3cr3t-Pw`, `a b'c\\d=e@f%g:h"i`, `ünï cødé/?#&+`, `x'`, `\\`, ` lead`, `tab\there`];

test("the mask: a password in every form a message carries it — raw, URL-encoded, libpq-, SQL- and JSON-quoted — is never left", async () => {
  const { maskSecret, MASKED } = await mod();
  for (const pw of PASSWORDS) {
    const libpq = pw.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const forms = [
      pw,
      encodeURIComponent(pw),
      // the URL's own encoding of a userinfo password, which is not encodeURIComponent's
      new URL(`postgres://u:${encodeURIComponent(pw)}@h/db`).href,
      `Unable to connect to Postgres at "host='h' port='5432' dbname='d' user='u' password='${libpq}' sslmode='prefer'": FATAL`,
      `SELECT '${pw.replace(/'/g, "''")}'`,
      JSON.stringify({ error: `failed: ${pw}` }),
    ];
    for (const text of forms) {
      const masked = maskSecret(text, pw);
      for (const leak of [pw, encodeURIComponent(pw), libpq, pw.replace(/'/g, "''"), JSON.stringify(pw).slice(1, -1)]) {
        assert.ok(!masked.includes(leak), `${JSON.stringify(text)} masked to ${JSON.stringify(masked)} still holds ${JSON.stringify(leak)}`);
      }
      assert.ok(masked.includes(MASKED), `${JSON.stringify(masked)} says it masked something`);
    }
  }
});

test("the mask: any password= keyword's value is masked whatever it is (a password since rotated), and the rest of the message stands", async () => {
  const { maskSecret } = await mod();
  const old = `Unable to connect to Postgres at "host='db.internal' port='5432' dbname='app' user='reader' password='old\\'pw\\\\x' sslmode='prefer' application_name='mason-data'": connection to server at "10.0.0.1", port 5432 failed: Connection refused`;
  assert.equal(maskSecret(old, "a-new-one"),
    `Unable to connect to Postgres at "host='db.internal' port='5432' dbname='app' user='reader' password=**** sslmode='prefer' application_name='mason-data'": connection to server at "10.0.0.1", port 5432 failed: Connection refused`);
  // a password the reader knows nothing of: no secret given
  assert.equal(maskSecret("password=bare123 host=h", null), "password=**** host=h");
  assert.equal(maskSecret("PASSWORD = 'Quoted Value' x", ""), "PASSWORD = **** x");
  // a quote never closed: to the text's end
  assert.equal(maskSecret("password='cut off", undefined), "password=****");
  // nothing to mask: the text as it was
  const plain = `Unable to connect to Postgres at "sslmode='prefer' application_name='mason-data'": password authentication failed for user "reader"`;
  assert.equal(maskSecret(plain, "s3cr3t-Pw"), plain);
  assert.equal(maskSecret(plain, ""), plain);
});

test("the mask over an answer: every string of its objects and arrays, anything else as it was; an error keeps its class", async () => {
  const { maskDeep, maskError } = await mod();
  const pw = "s3cr3t-Pw";
  const answer = { tables: [{ source: "public.t", error: `failed: ${pw}`, rows: 3, kept: { lateWhy: `password='${pw}'`, at: null } }], ok: true, n: 2n };
  const masked = maskDeep(answer, pw);
  assert.ok(!JSON.stringify(masked, (_k, v: unknown) => typeof v === "bigint" ? String(v) : v).includes(pw));
  assert.deepEqual(masked, { tables: [{ source: "public.t", error: "failed: ****", rows: 3, kept: { lateWhy: "password=****", at: null } }], ok: true, n: 2n });
  class Refused extends Error {}
  const e = maskError(new Refused(`the poll failed: ${pw}`), pw);
  assert.ok(e instanceof Refused);
  assert.equal((e as Error).message, "the poll failed: ****");
  assert.ok(!((e as Error).stack ?? "").includes(pw));
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
