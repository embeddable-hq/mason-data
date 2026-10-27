/**
 * `mason start`'s preflight (src/cli/preflight.ts), pure parts: the URL a developer pastes and edits, what each
 * connection failure says to change, and what a database on another machine is warned and refused about.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as os from "node:os";
import * as net from "node:net";
import { PgError } from "../src/cdc/pg-wire.ts";
import { checkSource, explainConnectError, isLocalHost, maskedUrl, parseSource, serverlessHost, sourceWarnings, unpickableReason,
  type SourceFacts, type SourceTable } from "../src/cli/preflight.ts";

const source = (url: string) => {
  const r = parseSource(url);
  if ("problem" in r) throw new Error(r.problem);
  return r.source;
};

test("the URL: the user defaults to the OS user, the database never defaults, a broken URL says to encode", () => {
  const s = source("postgres://localhost:5432/app");
  assert.equal(s.user, os.userInfo().username);
  assert.equal(s.database, "app");
  assert.equal(s.remote, false);
  assert.equal(s.sslmode, "prefer");
  const noDb = parseSource("postgres://me@localhost:5432");
  assert.ok("problem" in noDb && /names no database/.test(noDb.problem));
  const bad = parseSource("postgres://me:p@ss@local host/app");
  assert.ok("problem" in bad && /URL-encoded/.test(bad.problem));
  const scheme = parseSource("mysql://me@localhost/app");
  assert.ok("problem" in scheme && /postgres:\/\//.test(scheme.problem));
  assert.equal(source("postgres://me:p%40ss@localhost/app").password, "p@ss");
});

test("a database elsewhere is remote, and read over TLS unless the URL says otherwise", () => {
  assert.equal(source("postgres://me@db.example.com/app").remote, true);
  assert.equal(source("postgres://me@db.example.com/app").sslmode, "require");
  assert.equal(source("postgres://me@db.example.com/app?sslmode=disable").sslmode, "disable");
  for (const h of ["localhost", "127.0.0.1", "127.1.2.3", "::1", "host.docker.internal", "app.localhost"]) assert.equal(isLocalHost(h), true, h);
  for (const h of ["10.0.0.5", "db.internal", "ep-x.us-east-2.aws.neon.tech"]) assert.equal(isLocalHost(h), false, h);
});

test("the password is masked wherever the URL is shown", () => {
  assert.equal(maskedUrl("postgres://me:secret@localhost:5432/app"), "postgres://me:****@localhost:5432/app");
  assert.equal(maskedUrl("postgres://me@localhost/app"), "postgres://me@localhost/app");
});

test("each connection failure says what to change", () => {
  const s = source("postgres://me:x@localhost:5432/app");
  const auth = explainConnectError(new PgError({ S: "FATAL", C: "28P01", M: "password authentication failed for user \"me\"" }), s);
  assert.match(auth.message, /refused user me/);
  assert.ok(auth.hints.some((h) => /Homebrew and Postgres\.app/.test(h)));
  assert.ok(auth.hints.some((h) => /POSTGRES_PASSWORD/.test(h)));
  assert.match(explainConnectError(new PgError({ C: "3D000", M: "database \"app\" does not exist" }), s).message, /has no database "app"/);
  const refused = explainConnectError(new Error("connecting to localhost:5432: connect ECONNREFUSED 127.0.0.1:5432"), s);
  assert.match(refused.message, /nothing is listening on localhost:5432/);
  assert.ok(refused.hints.some((h) => /54322/.test(h)));
  const far = explainConnectError(new Error("connecting to db.internal:5432 timed out"), source("postgres://me@db.internal/app"));
  assert.ok(far.hints.some((h) => /ssh -L/.test(h)), "a private network needs a tunnel");
});

test("a refused connection to localhost says nothing is listening, from the real error (::1 and 127.0.0.1 both refused)", async () => {
  // Node tries localhost's two addresses and fails with an AggregateError whose message is EMPTY, so the
  // hand-written message above was the only ECONNREFUSED this ever saw; mason start said only "Connecting to … ✘"
  const port = await new Promise<number>((resolve) => { const srv = net.createServer().listen(0, "127.0.0.1", () => { const p = (srv.address() as net.AddressInfo).port; srv.close(() => resolve(p)); }); });
  const said: string[] = [], progress: string[] = [];
  const r = await checkSource(`postgres://me@localhost:${port}/app`, { remote: false, cmd: "mason start", say: (m) => said.push(m), progress: (m) => progress.push(m) });
  assert.deepEqual(r, { exit: 1 });
  assert.deepEqual(progress, [`mason start: connecting to postgres://me@localhost:${port}/app …`]);
  assert.equal(said[0], `mason start: could not connect: nothing is listening on localhost:${port}`);
  assert.ok(said.some((h) => /Is Postgres running\?/.test(h)), said.join("\n"));
});

const table = (o: Partial<SourceTable>): SourceTable => ({ source: "public.t", schema: "public", table: "t", key: ["id"], rows: 10, bytes: 8192, comment: null, columns: [], foreignKeys: [], ...o });

test("a table without a primary key cannot be picked; one of any size can, wherever its database is", () => {
  assert.match(unpickableReason(table({ key: [] }))!, /no primary key/);
  // a 22 M-row table of a database on another machine could not be added (the 1 M-row cap, now gone)
  for (const rows of [5, 22_000_000, 1_000_000_000, null]) assert.equal(unpickableReason(table({ rows })), null, `rows: ${rows}`);
});

test("a database elsewhere is warned about: the copy, a primary, a serverless compute kept awake", () => {
  const facts = (standby: boolean): SourceFacts => ({ version: 160000, versionText: "16", standby, tables: [], systemIdentifier: null });
  assert.deepEqual(sourceWarnings(source("postgres://me@localhost/app"), facts(false)), []);
  const neon = sourceWarnings(source("postgres://me@ep-x.us-east-2.aws.neon.tech/app"), facts(false));
  assert.ok(neon.some((w) => /copy the tables you pick/.test(w)));
  assert.ok(neon.some((w) => /PRIMARY/.test(w)));
  assert.ok(neon.some((w) => /Neon suspends an idle compute/.test(w)));
  assert.ok(!sourceWarnings(source("postgres://me@replica.example.com/app"), facts(true)).some((w) => /PRIMARY/.test(w)));
  assert.equal(serverlessHost("db.abc.supabase.co"), null);
});
