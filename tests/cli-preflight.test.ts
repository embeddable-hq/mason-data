/**
 * `mason start`'s preflight (src/cli/preflight.ts), pure parts: the URL a developer pastes and edits, what each
 * connection failure says to change, and what a database on another machine is warned and refused about.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as os from "node:os";
import { PgError } from "../src/cdc/pg-wire.ts";
import { checkSource, explainConnectError, isLocalHost, maskedUrl, parseSource, serverlessHost, sourceWarnings, unpickableReason,
  type SourceFacts, type SourceTable } from "../src/cli/preflight.ts";
import { unassignedPort } from "./test-ports.ts";
import { PGlite } from "@electric-sql/pglite";
import { readCollations, TABLES_SQL } from "../src/cli/preflight.ts";

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

test("a source's URL is shown only when it reads whole as a postgres:// URL, its password masked; any other shape is never shown, and its refusal says the shape, never the value (issue 541)", () => {
  // shown: the password masked, whatever it holds (an unencoded @ or : is the password's: the host is after the LAST @)
  for (const [url, shown] of [
    ["postgres://me:Pw541@localhost:5432/app", "postgres://me:****@localhost:5432/app"],
    ["postgres://me:p@Pw541@db.example.com/app?sslmode=require", "postgres://me:****@db.example.com/app?sslmode=require"],
    ["postgres://me:p:Pw541@localhost/app", "postgres://me:****@localhost/app"],
    ["postgres://me:p%2FPw541%3F%23@localhost/app", "postgres://me:****@localhost/app"],
    ["postgresql://me:Pw541@[::1]:5433/app", "postgresql://me:****@[::1]:5433/app"],
    ["postgres://me@localhost/app", "postgres://me@localhost/app"],
    ["postgres://me:Pw541@db/app?sslmode=require&application_name=svc", "postgres://me:****@db/app?sslmode=require&application_name=svc"],
    ["postgres://me:Pw541@db/app?application_name=my-app.v2_1", "postgres://me:****@db/app?application_name=my-app.v2_1"],
    // the query shown is the one read, written out again
    ["postgres://me:Pw541@db/app?ssl%6Dode=%70refer", "postgres://me:****@db/app?sslmode=prefer"],
    // a secret file's last newline, or a space pasted at either end: trimmed, as the parse trims it
    ["postgres://me:Pw541@localhost/app\n", "postgres://me:****@localhost/app"],
    [" postgres://me:Pw541@localhost/app\r\n", "postgres://me:****@localhost/app"],
  ] as const) assert.equal(maskedUrl(url), shown, JSON.stringify(url));
  assert.equal((parseSource("postgres://me:Pw541@localhost/app\n") as { source: { url: string } }).source.url, "postgres://me:Pw541@localhost/app");
  // never shown: each a shape a mask that recognises shapes let through, or a parse that half-works would show part of
  const never: Array<[string, RegExp]> = [
    ["host=db user=me password=Pw541 dbname=app", /: it looks like a keyword\/value connection string \(host=… user=… password=…\)\. Write it as postgres:\/\/user:password@host:5432\/your_app/],
    ["  password = Pw541 host=db", /keyword\/value connection string/],
    ["Pw541", /: it is not a URL\./],
    ["Pw541:x", /: it is not a URL\./],
    ["", /: it is empty\./],
    ["jdbc:postgresql://db/app?user=me&password=Pw541", /: it looks like a JDBC URL: drop jdbc:/],
    ["mysql://me:Pw541@db/app", /: its scheme is mysql, not postgres:\/\/ or postgresql:\/\//],
    ["Pw541://me@db/app", /: its scheme is not postgres:\/\/ or postgresql:\/\//],
    // a password holding / ? or # unencoded: the URL splits there, the password's tail a path, a parameter, a fragment
    ["postgres://me:12/Pw541@db/app", /: it does not read as one URL/],
    ["postgres://me:12?Pw541@db/app", /: it does not read as one URL/],
    ["postgres://me:12#Pw541@db/app", /: it does not read as one URL/],
    ["postgres://me:ab/Pw541@db/app", /: it does not read as one URL/],
    ["postgres://me:Pw541@db/app#frag", /: it does not read as one URL/],
    // a space or a control character, which a parse encodes or drops: never shown rewritten
    ["postgres://me:Pw 541@db/app", /: it does not read as one URL/],
    ["postgres://me:Pw\t541@db/app", /: it does not read as one URL/],
    ["postgres://me:Pw541@db/app\nPw541", /: it does not read as one URL/],
    ["postgres://me:Pw541@db/app?application_name=a@b", /: it does not read as one URL/],
    ["postgres://me:Pw541@127.0.0.1:99999/app", /: it does not read as one URL .*the port is not a number up to 65535/],
    ["postgres://me:Pw541@[::1/app", /: it does not read as one URL/],
    ["postgres://me:Pw541@local host/app", /: it does not read as one URL/],
    ["postgres:///app?password=Pw541", /: it does not read as one URL/],
    ["postgres://me:Pw541@db/app#", /: it does not read as one URL/],
    // a connection keyword libpq reads from the query (a query password wins over the user's): a part Mason does not
    // read is never shown, so the URL is not
    ["postgres://me@db/app?password=Pw541", /: it has the parameter password, which Mason does not read \(it reads sslmode and application_name alone\): a password goes before the host, postgres:\/\/user:password@host:5432\/your_app\./],
    ["postgres://me:x@db/app?sslmode=require&sslpassword=Pw541", /: it has the parameter sslpassword, which Mason does not read .*: a password goes before the host/],
    ["postgres://me@db/app?PASSWORD=Pw541", /: it has the parameter password, which Mason does not read .*: a password goes before the host/],
    ["postgres://me@db/app?pass%77ord=Pw541", /: it has the parameter password, which Mason does not read/],
    ["postgres://me@db/app?password%3DPw541", /: it has a parameter Mason does not read \(it reads sslmode and application_name alone\): leave it out of the URL\./],
    ["postgres://me@db/app?sslmode%3Dprefer&password=Pw541", /: it has the parameter password, and another, which Mason does not read/],
    ["postgres://me@db/app?password=a&password=Pw541", /: it has the parameter password, which Mason does not read/],
    ["postgres://me@db/app?sslmode=prefer&password=Pw541", /: it has the parameter password, which Mason does not read/],
    ["postgres://me@db/app?application_name=svc&password=Pw541", /: it has the parameter password, which Mason does not read/],
    ["postgres://me@db/app?password=Pw541;sslmode=prefer", /: it has the parameter password, which Mason does not read/],
    ["postgres://me@db/app?Pw541=1", /: it has a parameter Mason does not read .*: leave it out of the URL\./],
    ["postgres://me@db/app?Pw541", /: it has a parameter Mason does not read/],
    ["postgres://me:Pw541@db/app?sslrootcert=%2Fx&channel_binding=require", /: it has the parameters sslrootcert, channel_binding, which Mason does not read .*: leave it out of the URL\./],
    ["postgres://me:Pw541@db/app?pgbouncer=true", /: it has the parameter pgbouncer, which Mason does not read .*: leave it out of the URL\./],
    // a parameter Mason reads, its VALUE not one the reading accepts: a password may hide in it (the review of #575)
    ["postgres://me@db/app?sslmode=prefer%26password=Pw541", /: its sslmode is not one of disable, allow, prefer, require, verify-ca, verify-full\./],
    ["postgres://me@db/app?sslmode=prefer;password=Pw541", /: its sslmode is not one of disable, allow, prefer, require, verify-ca, verify-full\./],
    ["postgres://me:x@db/app?sslmode=Pw541", /: its sslmode is not one of/],
    ["postgres://me:x@db/app?sslmode=prefer&sslmode=Pw541", /: it gives sslmode more than once: give it once\./],
    ["postgres://me:x@db/app?application_name=password=Pw541", /: its application_name is not letters, digits, \. _ and - \(at most 64\): give it in those, or leave it out\./],
    ["postgres://me:x@db/app?application_name=svc%20Pw541", /: its application_name is not letters/],
    [`postgres://me:x@db/app?application_name=${"a".repeat(65)}`, /: its application_name is not letters/],
    ["postgres://me:x@db/app?application_name=a&application_name=Pw541", /: it gives application_name more than once/],
  ];
  for (const [value, said] of never) {
    // maskedUrl is shownUrl's null in a sentence (src/cli/preflight.ts)
    assert.equal(maskedUrl(value), "a value that is not a postgres:// URL (not shown)", JSON.stringify(value));
    const r = parseSource(value, "DATABASE_URL in .env");
    assert.ok("problem" in r, JSON.stringify(value));
    assert.ok(r.problem.startsWith("DATABASE_URL in .env is not a postgres:// URL: "), r.problem);
    assert.match(r.problem, said);
    assert.match(r.problem, /a password holding @ : \/ # \? % or a space is URL-encoded \(encodeURIComponent; @ is %40, \/ is %2F, # is %23\)$/);
    assert.doesNotMatch(r.problem, /Pw|541|frag|99999|aaaa|svc/, "never a part of the value");
  }
  // a %-escape that is none: refused naming where, never a crash or the value
  const pct = parseSource("postgres://me:Pw%zz541@localhost/app", "MASON_URL");
  assert.ok("problem" in pct);
  assert.match(pct.problem, /^MASON_URL holds a % that starts no %-escape: a % in the user or the password is written %25\./);
  const user = parseSource("postgres://m%zz@localhost", "DATABASE_URL");
  assert.ok("problem" in user && /^DATABASE_URL holds a % that starts no %-escape/.test(user.problem), "the user's name too, where no database is named");
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
  assert.match(explainConnectError(new PgError({ C: "3D000", M: "database \"app\" does not exist" }), s).message, /^localhost:5432 has no database by the name the URL gives \(the part after the port\)$/);
  const refused = explainConnectError(new Error("connecting to localhost:5432: connect ECONNREFUSED 127.0.0.1:5432"), s);
  assert.match(refused.message, /nothing is listening on localhost:5432/);
  assert.ok(refused.hints.some((h) => /54322/.test(h)));
  const far = explainConnectError(new Error("connecting to db.internal:5432 timed out"), source("postgres://me@db.internal/app"));
  assert.ok(far.hints.some((h) => /ssh -L/.test(h)), "a private network needs a tunnel");
});

test("a refused connection to localhost says nothing is listening, from the real error (::1 and 127.0.0.1 both refused)", async () => {
  // Node tries localhost's two addresses and fails with an AggregateError whose message is EMPTY, so the
  // hand-written message above was the only ECONNREFUSED this ever saw; mason start said only "Connecting to … ✘".
  // A port nothing listens on until the connect: out of the kernel's ephemeral range (tests/test-ports.ts)
  const port = await unassignedPort();
  const said: string[] = [], progress: string[] = [];
  const r = await checkSource(`postgres://me@localhost:${port}/app`, { remote: false, cmd: "mason start", say: (m) => said.push(m), progress: (m) => progress.push(m) });
  assert.deepEqual(r, { exit: 1 });
  assert.deepEqual(progress, [`mason start: connecting to postgres://me@localhost:${port}/app …`]);
  assert.equal(said[0], `mason start: could not connect: nothing is listening on localhost:${port}`);
  assert.ok(said.some((h) => /Is Postgres running\?/.test(h)), said.join("\n"));
});

test("the demo database refused while its run is down says the way out: it runs inside mason start (the project's config says it is the demo's)", async () => {
  const { connectSource } = await import("../src/cli/preflight.ts");
  // a port nothing listens on until both connects: out of the kernel's ephemeral range (tests/test-ports.ts)
  const port = await unassignedPort();
  const s = source(`postgres://demo@127.0.0.1:${port}/demo`);
  const demo = await connectSource(s, { demo: true });
  assert.ok("failure" in demo);
  assert.deepEqual(demo.failure, { message: `the demo database is not running on 127.0.0.1:${port}`, hints: ["the demo database runs inside mason start: start it first"] });
  // the same URL in a project that is not the demo's: nothing is listening, as before (the URL is never sniffed)
  const other = await connectSource(s);
  assert.ok("failure" in other);
  assert.equal(other.failure.message, `nothing is listening on 127.0.0.1:${port}`);
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
  assert.ok(neon.some((w) => /sync the tables you pick/.test(w)));
  assert.ok(neon.some((w) => /PRIMARY/.test(w)));
  assert.ok(neon.some((w) => /Neon suspends an idle compute/.test(w)));
  assert.ok(!sourceWarnings(source("postgres://me@replica.example.com/app"), facts(true)).some((w) => /PRIMARY/.test(w)));
  assert.equal(serverlessHost("db.abc.supabase.co"), null);
});

// THE SOURCE'S COLLATIONS (issue 253, decision B): a column's own collation, where it is not its type's, and every
// collation of the database's encoding, read where the tables are; the catalog declares them (src/api/postgres/catalog.ts)
test("collation: a column's own collation and the source's collations are read with the tables", async () => {
  const db = new PGlite();
  try {
    await db.exec("CREATE COLLATION public.mason_num (provider = icu, locale = 'und-u-kn'); " +
      "CREATE COLLATION public.mason_ci (provider = icu, locale = 'und-u-ks-level2', deterministic = false); " +
      "CREATE TABLE public.colls (id int PRIMARY KEY, d text, c text COLLATE \"C\", n text COLLATE public.mason_num, a text[] COLLATE \"C\", v varchar(4) COLLATE \"und-x-icu\")");
    const pg = { query: async (sql: string) => ({ rows: (await db.query<unknown[]>(sql, [], { rowMode: "array" })).rows }) };
    const tables = JSON.parse(String((await pg.query(TABLES_SQL)).rows[0]![0])) as Array<{ table: string; columns: Array<{ name: string; collation: unknown }> }>;
    assert.deepEqual(tables.find((t) => t.table === "colls")!.columns.map((c) => [c.name, c.collation]),
      [["id", null], ["d", null], ["c", { schema: "pg_catalog", name: "C" }], ["n", { schema: "public", name: "mason_num" }], ["a", { schema: "pg_catalog", name: "C" }],
        ["v", { schema: "pg_catalog", name: "und-x-icu" }]]);
    const collations = await readCollations(pg as unknown as Parameters<typeof readCollations>[0], 170000);
    const own = (name: string) => collations.find((c) => c.name === name);
    assert.deepEqual(own("mason_num"), { schema: "public", name: "mason_num", provider: "i", collate: null, ctype: null, locale: "und-u-kn", deterministic: true, version: own("mason_num")!.version });
    assert.equal(own("mason_ci")?.deterministic, false);
    assert.deepEqual([own("C")?.provider, own("C")?.collate, own("C")?.ctype, own("und-x-icu")?.provider, own("und-x-icu")?.locale], ["c", "C", "C", "i", "und"]);
  } finally { await db.close(); }
});

// ------------------------------------------------------------------ a database the server does not have (issue 871)

/** A Postgres that has only `names` (`postgres` among them, the one it serves): any other database is 3D000, and its
 *  one statement, the names' read, is answered with them. Synthetic names alone. */
async function serverOf(names: string[]): Promise<{ port: number; close: () => void }> {
  const net = await import("node:net");
  const msg = (type: string, body: Buffer): Buffer => { const len = Buffer.alloc(4); len.writeInt32BE(body.length + 4); return Buffer.concat([Buffer.from(type), len, body]); };
  const cstr = (s: string) => Buffer.from(`${s}\0`);
  const server = net.createServer((sock) => {
    let started = false;
    sock.on("data", (d: Buffer) => {
      if (!started && d.length === 8 && d.readInt32BE(4) === 80877103) { sock.write("N"); return; }   // SSLRequest: no TLS here
      if (!started) {
        started = true;
        const fields = d.subarray(8).toString("utf8").split("\0");
        const database = fields[fields.indexOf("database") + 1];
        if (database !== "postgres") {
          sock.end(msg("E", Buffer.concat([cstr("SFATAL"), cstr("C3D000"), cstr(`Mdatabase "${database}" does not exist`), Buffer.from([0])])));
          return;
        }
        sock.write(Buffer.concat([msg("R", Buffer.alloc(4)), msg("Z", Buffer.from("I"))]));
        return;
      }
      if (d[0] !== 0x51) return;   // 'Q': the names' read; a Terminate is answered by nothing
      const col = Buffer.alloc(18); col.writeInt32BE(0, 0); col.writeInt16BE(0, 4); col.writeInt32BE(19, 6); col.writeInt16BE(64, 10); col.writeInt32BE(-1, 12); col.writeInt16BE(0, 16);
      const one = Buffer.alloc(2); one.writeInt16BE(1);
      const rows = names.map((name) => { const v = Buffer.from(name); const h = Buffer.alloc(6); h.writeInt16BE(1, 0); h.writeInt32BE(v.length, 2); return msg("D", Buffer.concat([h, v])); });
      sock.write(Buffer.concat([msg("T", Buffer.concat([one, cstr("datname"), col])), ...rows, msg("C", cstr(`SELECT ${names.length}`)), msg("Z", Buffer.from("I"))]));
    });
    sock.on("error", () => { /* the client's close resets the socket: nothing of the test's to say */ });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as { port: number }).port, close: () => server.close() };
}

test("a database the server does not have: the closest name there, as did you mean, and never the list (mason init, mason start)", async () => {
  const names = ["accounts", "billing", "postgres", "shop", "warehouse"];
  const srv = await serverOf(names);
  try {
    const said: string[] = [];
    const r = await checkSource(`postgres://me@127.0.0.1:${srv.port}/shpo`, { remote: false, cmd: "mason init", say: (m) => said.push(m), progress: () => {} });
    assert.deepEqual(r, { exit: 1 });
    assert.deepEqual(said, [
      `mason init: could not connect: 127.0.0.1:${srv.port} has no database by the name the URL gives (the part after the port)`,
      "  - did you mean `shop`? It is the name after the port in the URL",
    ]);
  } finally { srv.close(); }
});

test("a database the server does not have and none close to it: a count only, in mason doctor's check and its --json", async () => {
  const others = ["accounts", "billing", "warehouse"];
  const srv = await serverOf(["postgres", ...others]);
  try {
    const { connectSource } = await import("../src/cli/preflight.ts");
    const c = await connectSource(source(`postgres://me@127.0.0.1:${srv.port}/inventory`));
    assert.ok("failure" in c);
    assert.deepEqual(c.failure.hints, [`127.0.0.1:${srv.port} has 4 other databases, none close to that name: put the right name after the port in the URL`]);
    // the database line mason doctor says, which its --json carries as it is
    const { databaseChecks } = await import("../src/cli/doctor.ts");
    const json = JSON.stringify(await databaseChecks(`postgres://me@127.0.0.1:${srv.port}/inventory`));
    assert.match(json, /has 4 other databases, none close to that name/);
    for (const n of others) assert.ok(!json.includes(n), `${n} is not in the check's --json: ${json}`);
  } finally { srv.close(); }
});

test("a server with many databases: the failure is as short as with one, and names none of them", async () => {
  const { connectSource } = await import("../src/cli/preflight.ts");
  const srv = await serverOf(["postgres", ...Array.from({ length: 2000 }, (_, i) => `tenant_${String(i).padStart(4, "0")}_data`)]);
  try {
    const c = await connectSource(source(`postgres://me@127.0.0.1:${srv.port}/inventory`));
    assert.ok("failure" in c);
    const text = [c.failure.message, ...c.failure.hints].join("\n");
    assert.ok(text.length < 300, `bounded: ${text.length} characters`);
    assert.doesNotMatch(text, /tenant_/);
    assert.match(text, /has 2001 other databases, none close to that name/);
  } finally { srv.close(); }
  // one other: said in the singular
  const one = await serverOf(["postgres"]);
  try {
    const c = await connectSource(source(`postgres://me@127.0.0.1:${one.port}/inventory`));
    assert.ok("failure" in c);
    assert.deepEqual(c.failure.hints, [`127.0.0.1:${one.port} has 1 other database, none close to that name: put the right name after the port in the URL`]);
  } finally { one.close(); }
});
