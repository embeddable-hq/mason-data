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
  assert.throws(() => parseDatabaseUrl("mysql://u@h/db"), /scheme mysql/);
  assert.throws(() => parseDatabaseUrl("postgres://u@h/"), /no database/);
  assert.throws(() => parseDatabaseUrl("postgres://h/db"), /no user/);
  assert.throws(() => parseDatabaseUrl("postgres://u@h/db?sslrootcert=/x"), /sslrootcert is not supported/);
  assert.throws(() => parseDatabaseUrl("postgres://u@h/db?sslmode=maybe"), /sslmode=maybe/);
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
