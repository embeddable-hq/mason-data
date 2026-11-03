/**
 * DATABASE_URL -> PG_* (src/lib/database-url.ts): what a URL may say, what it may not, and that an explicit
 * PG_* variable wins over it.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { applyDatabaseUrl, parseDatabaseUrl } from "../src/lib/database-url.ts";

test("a URL becomes a connection, percent-encoding decoded", () => {
  assert.deepEqual(parseDatabaseUrl("postgres://app:p%40ss%2Fword@db.internal:6543/my-app?sslmode=require"), {
    host: "db.internal", port: 6543, database: "my-app", user: "app", password: "p@ss/word", sslmode: "require",
  });
  const c = parseDatabaseUrl("postgresql://u@[::1]/db");
  assert.equal(c.host, "::1");
  assert.equal(c.port, 5432);
  assert.equal(c.sslmode, "prefer");
});

test("what cannot be represented faithfully is refused", () => {
  assert.throws(() => parseDatabaseUrl("mysql://u@h/db"), /^Error: DATABASE_URL: its scheme is not postgres or postgresql$/);
  assert.throws(() => parseDatabaseUrl("postgres://u@h/"), /no database/);
  assert.throws(() => parseDatabaseUrl("postgres://h/db"), /no user/);
  // a refusal names a parameter only from Mason's own lists, and never repeats a value (issue 541)
  const refusal = (url: string): string => { try { parseDatabaseUrl(url); } catch (e) { return (e as Error).message; } return "accepted"; };
  assert.equal(refusal("postgres://u@h/db?sslrootcert=/x"), "DATABASE_URL: it has the parameter sslrootcert, which Mason does not read (it reads sslmode and application_name alone): leave it out of the URL");
  assert.equal(refusal("postgres://u@h/db?password=Mk541"), "DATABASE_URL: it has the parameter password, which Mason does not read (it reads sslmode and application_name alone): a password goes before the host, postgres://user:password@host:5432/your_app");
  assert.equal(refusal("postgres://u@h/db?Mk541=1"), "DATABASE_URL: it has a parameter Mason does not read (it reads sslmode and application_name alone): leave it out of the URL");
  assert.equal(refusal("postgres://u@h/db?sslmode=maybe"), "DATABASE_URL: its sslmode is not one of disable, allow, prefer, require, verify-ca, verify-full");
  assert.equal(refusal("postgres://u@h/db?sslmode=prefer%26password=Mk541"), "DATABASE_URL: its sslmode is not one of disable, allow, prefer, require, verify-ca, verify-full");
  assert.equal(refusal("postgres://u@h/db?sslmode=prefer&sslmode=Mk541"), "DATABASE_URL: it gives sslmode more than once: give it once");
  assert.equal(refusal("postgres://u@h/db?application_name=password=Mk541"), "DATABASE_URL: its application_name is not letters, digits, . _ and - (at most 64): give it in those, or leave it out");
  assert.equal(refusal("postgres://u@h/db?sslmode=require&application_name=svc"), "accepted");
  assert.throws(() => parseDatabaseUrl("not a url"), /not a URL/);
});

test("PG_* fill from the URL, and an explicit one wins", () => {
  const env: NodeJS.ProcessEnv = { DATABASE_URL: "postgres://app:secret@db:5433/main", PG_HOST: "override" };
  assert.deepEqual(applyDatabaseUrl(env).sort(), ["PG_DATABASE", "PG_PASSWORD", "PG_PORT", "PG_SSLMODE", "PG_USER"]);
  assert.equal(env.PG_HOST, "override");
  assert.equal(env.PG_PORT, "5433");
  assert.equal(env.PG_PASSWORD, "secret");
  assert.deepEqual(applyDatabaseUrl({}), []);
});
