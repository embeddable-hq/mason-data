/**
 * The project's sources file (src/cli/sources.ts: a `sources` folder, where each file is a source to sync and names the
 * tables and columns to sync): every mistake a person or a coding agent
 * makes in it is told the file, the key, what is wrong and the way out — all of a file's mistakes on ONE report — and
 * `mason add` / `mason remove` edit one entry of it, every other byte as it was.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Failure } from "../src/cli/command.ts";
import type { SourceTable } from "../src/cli/preflight.ts";
import type * as Sources from "../src/cli/sources.ts";

// imported when the tests run, not at load: the file loads at a commit without the module (scripts/fails-without.ts)
const S = await import("../src/cli/sources.ts" as string).catch(() => ({})) as typeof Sources;

const col = (name: string, type = "text", notNull = false) => ({ name, type, notNull, comment: null });
const table = (o: Partial<SourceTable> & { schema?: string; table: string }): SourceTable => ({
  source: `${o.schema ?? "public"}.${o.table}`, schema: o.schema ?? "public", key: ["id"], rows: 3, bytes: 8192, comment: null,
  columns: [col("id", "bigint", true), col("name")], foreignKeys: [], ...o,
});
const orders = table({ table: "orders", columns: [col("id", "bigint", true), col("customer_id", "bigint"), col("status"), col("amount", "numeric"), col("api_token"), col("payload", "jsonb")],
  foreignKeys: [{ column: "customer_id", target: "public.customers", targetColumn: "id" }] });
const customers = table({ table: "customers" });
const events = table({ table: "events", key: [], columns: [col("tenant_id", "bigint", true), col("id", "bigint", true), col("raw_body")],
  uniqueKeys: [{ name: "events_tenant_id_id_key", columns: ["tenant_id", "id"], constraint: true, nullsNotDistinct: false }] });
const invoices = table({ schema: "billing", table: "invoices" });
const CATALOG = [orders, customers, events, invoices];

const FILE = "/app/mason/sources/app.yml";
const parse = (text: string): Sources.SourceFile | { problems: string[] } => S.parseSourceText(text, "app", FILE);
const problems = (text: string): string[] => (parse(text) as { problems: string[] }).problems;

/** The approved example, as a file. */
const EXAMPLE = `# mason/sources/app.yml — the database this project copies from. Yours to commit; the URL stays out of it.
kind: postgres
url: \${DATABASE_URL}          # an env var from .env or the shell; a literal URL is allowed for local dev

tables:
  orders:                     # a bare name is in \`public\`; \`billing.invoices\` names its schema
    columns: [id, customer_id, status, amount]
  customers: {}               # every column
  events:
    key: [tenant_id, id]      # only for a table with no primary key: the unique columns to copy it by
  billing.invoices:
    exclude: [name]           # every column but these
`;

test("the format: kind, url as ${NAME} or a literal URL, and tables a map of entries — columns, exclude, key — each defaulting to every column", () => {
  const f = parse(EXAMPLE) as Sources.SourceFile;
  assert.deepEqual([f.name, f.kind, f.url], ["app", "postgres", { env: "DATABASE_URL" }]);
  assert.deepEqual(f.tables, [
    { name: "orders", table: "public.orders", columns: ["id", "customer_id", "status", "amount"], exclude: [], key: null, sync: null },
    { name: "customers", table: "public.customers", columns: null, exclude: [], key: null, sync: null },
    { name: "events", table: "public.events", columns: null, exclude: [], key: ["tenant_id", "id"], sync: null },
    { name: "billing.invoices", table: "billing.invoices", columns: null, exclude: ["name"], key: null, sync: null },
  ]);
  assert.deepEqual((parse("kind: postgres\nurl: postgres://me@localhost/shop\ntables:\n") as Sources.SourceFile).url, { literal: "postgres://me@localhost/shop" });
  assert.deepEqual((parse("kind: postgres\nurl: postgres://me@localhost/shop\ntables:\n  orders:\n") as Sources.SourceFile).tables[0]!.columns, null, "an entry with nothing is every column");
  // what mason init writes is a file it reads, naming no table
  assert.deepEqual((parse(S.newSourceText()) as Sources.SourceFile).tables, []);
});

test("every mistake in the file is told its key, what is wrong and the way out — all of them, on one report", () => {
  assert.deepEqual(problems("kind: mysql\nurl: ${DATABASE_URL}\ntables: {}\n"), ["kind: mysql is not supported yet — postgres is the only kind for now"]);
  assert.deepEqual(problems("url: ${DATABASE_URL}\ntables: {}\n"), ["kind: missing — write kind: postgres (the kind of database this source is)"]);
  assert.deepEqual(problems("kind: postgres\ntables: {}\n"), ["url: missing — write url: ${DATABASE_URL} (DATABASE_URL in .env or the shell), or a postgres:// URL"]);
  assert.deepEqual(problems("kind: postgres\nurl: postgres://u:${PASS}@h/db\ntables: {}\n"),
    ["url: holds a ${NAME} inside a longer value (not shown: it may hold a password) — write the URL whole, or ${NAME} alone: the whole URL in one variable, like ${DATABASE_URL}"]);
  assert.deepEqual(problems("kind: postgres\nurl: ${DATABASE_URL}\n"), ["tables: missing — write tables: {} (mason add adds a table to it)"]);
  assert.deepEqual(problems("kind: postgres\nurl: ${DATABASE_URL}\ntables: [orders]\n"), ["tables: is one entry per table, like tables: { orders: {}, customers: { columns: [id, name] } }"]);
  assert.deepEqual(problems("kind: postgres\nurl: ${DATABASE_URL}\ntable: {}\n"), [
    "unexpected key table — did you mean `tables`? — a source file takes kind, url, database, sync, publication, tables", "tables: missing — write tables: {} (mason add adds a table to it)"]);
  assert.deepEqual(problems(`kind: postgres
url: \${DATABASE_URL}
tables:
  orders: { colums: [id] }
  customers: { columns: [id], exclude: [name] }
  events: { columns: id }
  sessions: { key: [] }
  logs: { exclude: [a, a] }
  orders_two: all
  public.customers: {}
`), [
    "tables.orders: unexpected key colums — did you mean `columns`? — a table takes columns, exclude, key, sync and references",
    "tables.customers: columns and exclude together — columns names what is synced, exclude what is left out of every column; keep one",
    "tables.events.columns: is the columns synced, a list of column names: [id, status]",
    "tables.sessions.key: is the columns that tell its rows apart, a list of column names: [id, status]",
    "tables.logs.exclude: names a twice",
    "tables.orders_two: is {} (every column), { columns: [...] }, { exclude: [...] }, { key: [...] } or { sync: poll 5m }",
    "tables.public.customers: public.customers is named twice (as customers too) — keep one",
  ]);
  assert.match(problems("kind: postgres\nurl: x\ntables:\n  a: {}\n  a: {}\n")[0]!, /^it is not YAML: Map keys must be unique/);
  assert.deepEqual(problems(""), ["it is empty: a source file is kind: postgres, url: ${DATABASE_URL} and tables: {}"]);
  // the failure: one problem is the message; several are counted, each under why; the way out is the file
  const one = S.sourceFailure(FILE, "/app", ["kind: missing — write kind: postgres"]);
  assert.deepEqual(one, { message: "mason/sources/app.yml: kind: missing — write kind: postgres", code: "bad_source", fix: "edit mason/sources/app.yml, then run the command again" });
  const two = S.sourceFailure(FILE, "/app", ["a", "b"]);
  assert.deepEqual([two.message, two.why], ["mason/sources/app.yml has 2 mistakes", "- a\n- b"]);
});

test("the tables against the database: a name it lacks is refused with a did-you-mean, key only for a table with no primary key, every mistake on one report", () => {
  const f = parse(EXAMPLE) as Sources.SourceFile;
  const added = S.addedTables(f, CATALOG, "shop", "/app") as Sources_AddedTable[];
  assert.ok(Array.isArray(added), JSON.stringify(added));
  assert.deepEqual(added.map((t) => [t.source, t.columns.map((c) => c.name), t.key, t.primaryKey]), [
    ["public.orders", ["id", "customer_id", "status", "amount"], ["id"], undefined],
    ["public.customers", ["id", "name"], ["id"], undefined],
    // copied by the file's key; the catalog keeps the source's own primary key, none (it declares only what Postgres does)
    ["public.events", ["tenant_id", "id", "raw_body"], ["tenant_id", "id"], []],
    ["billing.invoices", ["id"], ["id"], undefined],
  ]);
  assert.deepEqual(added[0]!.foreignKeys, orders.foreignKeys, "a foreign key out of a copied column is kept");
  const narrow = S.addedTables(parse("kind: postgres\nurl: x\ntables:\n  orders: { columns: [status] }\n") as Sources.SourceFile, CATALOG, "shop", "/app") as Sources_AddedTable[];
  assert.deepEqual([narrow[0]!.columns.map((c) => c.name), narrow[0]!.foreignKeys], [["id", "status"], []], "the key always copied; a foreign key out of a column left out goes");

  const wrong = S.addedTables(parse(`kind: postgres
url: x
tables:
  ordrs: {}
  orders: { columns: [id, statsu] }
  customers: { exclude: [id], key: [id] }
  events: {}
  billing.invoices: { key: [nope] }
`) as Sources.SourceFile, CATALOG, "shop", "/app") as Failure;
  assert.equal(wrong.code, "bad_source");
  assert.equal(wrong.message, "mason/sources/app.yml has 6 mistakes");
  assert.equal(wrong.why, [
    "- tables.ordrs: shop has no table public.ordrs this user can read — did you mean `orders`?",
    "- tables.orders.columns: public.orders has no column statsu — did you mean `status`? (its columns: id, customer_id, status, amount, api_token, payload)",
    "- tables.customers.key: public.customers has a primary key (id), which Mason keys it by — remove key",
    "- tables.customers.exclude: id is public.customers's key, which is always synced — take it out of exclude",
    "- tables.events: public.events has no primary key, so Mason cannot tell its rows apart — name the columns that do: key: [tenant_id, id] (its unique index events_tenant_id_id_key)",
    "- tables.billing.invoices.key: billing.invoices has a primary key (id), which Mason keys it by — remove key",
  ].join("\n"));
  assert.deepEqual(wrong.next, [["mason tables", "the database's tables and their columns"]]);
  // a key: table under sync: replication (its entry's, or the file's): its rows have no identity there — the line to write
  for (const text of ["kind: postgres\nurl: x\ntables:\n  events: { key: [tenant_id, id], sync: replication }\n", "kind: postgres\nurl: x\nsync: replication\ntables:\n  events: { key: [tenant_id, id] }\n"]) {
    const repl = S.addedTables(parse(text) as Sources.SourceFile, CATALOG, "shop", "/app") as Failure;
    assert.equal(repl.message, "mason/sources/app.yml: tables.events: public.events has no primary key, so logical replication cannot apply its changes by its key: (sync: replication) — give its entry sync: poll <interval> (poll 5m), or sync: off");
  }
  // polled, the same entry is taken
  assert.ok(Array.isArray(S.addedTables(parse("kind: postgres\nurl: x\nsync: replication\ntables:\n  events: { key: [tenant_id, id], sync: poll 5m }\n") as Sources.SourceFile, CATALOG, "shop", "/app")));
});
type Sources_AddedTable = import("../src/duck/sync.ts").AddedTable;

// THE KEY A TABLE IS SYNCED BY, CHECKED AGAIN AT EVERY READ (issue 1027): the file is checked against the catalog when it
// is read, but an index can be dropped while Mason runs, and a poll by a key two rows share lost synced rows. The run
// asks the database again before every read that writes by key (src/cdc/key-held.ts), and says a refusal at the place
// the file names the table: each table the file adds carries that place, so the engine's words name the file and the key.
test("every table the sources file adds carries where the file names it, so the sync's refusal of its key names the file and the key", () => {
  const f = parse("kind: postgres\nurl: x\ntables:\n  orders: {}\n  events: { key: [tenant_id, id], sync: poll 5m }\n  billing.invoices: {}\n") as Sources.SourceFile;
  const added = S.addedTables(f, CATALOG, "shop", "/app") as Array<Sources_AddedTable & { entryAt?: string }>;
  assert.deepEqual(added.map((t) => [t.source, t.key, t.entryAt]), [
    ["public.orders", ["id"], "mason/sources/app.yml: tables.orders"],
    ["public.events", ["tenant_id", "id"], "mason/sources/app.yml: tables.events"],
    ["billing.invoices", ["id"], "mason/sources/app.yml: tables.billing.invoices"],
  ]);
});

test("sync: replication at the top and on an entry, mixed with off and poll; a table that cannot be replicated refused at its entry with the line to write", () => {
  const REPL = { mode: "replication" };
  const f = parse("kind: postgres\nurl: x\nsync: replication\ntables:\n  orders: {}\n  customers: { sync: off }\n  billing.invoices: { sync: poll 30s }\n") as Sources.SourceFile;
  assert.deepEqual(f.sync, REPL);
  const added = S.addedTables(f, CATALOG, "shop", "/app") as Sources_AddedTable[];
  assert.deepEqual(added.map((t) => [t.source, t.sync]), [["public.orders", REPL], ["public.customers", { mode: "off" }], ["billing.invoices", { mode: "poll", every: "30s", seconds: 30 }]]);
  assert.deepEqual(S.replicatedEntries(f).map((e) => e.table), ["public.orders"]);
  // on an entry, under a file that polls
  const entry = parse("kind: postgres\nurl: x\nsync: poll 5m\ntables:\n  orders: { sync: replication }\n  customers: {}\n") as Sources.SourceFile;
  assert.deepEqual((S.addedTables(entry, CATALOG, "shop", "/app") as Sources_AddedTable[]).map((t) => t.sync?.mode), ["replication", "poll"]);
  // REPLICA IDENTITY NOTHING (the catalog's: the file cannot know) under replication: refused at its entry, ONE report
  // with the key: table beside it, each with the line to write; polled, both are taken
  const nothing = table({ table: "audit", replicaIdentity: "n" });
  const both = S.addedTables(parse("kind: postgres\nurl: x\nsync: replication\ntables:\n  audit: {}\n  events: { key: [tenant_id, id] }\n  orders: {}\n") as Sources.SourceFile,
    [...CATALOG, nothing], "shop", "/app") as Failure;
  assert.equal(both.why, [
    "- tables.audit: public.audit has REPLICA IDENTITY NOTHING, and a publication carrying it would make your app's own UPDATEs and DELETEs on it fail (sync: replication) — " +
      "give its entry sync: poll <interval> (poll 5m), or sync: off; or ALTER TABLE public.audit REPLICA IDENTITY DEFAULT on the database",
    "- tables.events: public.events has no primary key, so logical replication cannot apply its changes by its key: (sync: replication) — give its entry sync: poll <interval> (poll 5m), or sync: off",
  ].join("\n"));
  assert.ok(Array.isArray(S.addedTables(parse("kind: postgres\nurl: x\nsync: replication\ntables:\n  audit: { sync: poll 5m }\n  events: { key: [tenant_id, id], sync: off }\n") as Sources.SourceFile,
    [...CATALOG, nothing], "shop", "/app")));
});

test("publication: at the top names the publication replication reads, a ${VARIABLE} read as url: is — unset, or written wrong, refused with the way out", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mason-sources-pub-"));
  try {
    const folder = path.join(root, "mason");
    fs.mkdirSync(path.join(folder, "sources"), { recursive: true });
    const write = (pub: string): void => fs.writeFileSync(path.join(folder, "sources", "app.yml"), `kind: postgres\nurl: postgres://x/db\nsync: replication\n${pub}tables: {}\n`);
    write("publication: app_pub\n");
    assert.equal((S.readSource(folder, root, {}) as Sources.ProjectSource).publicationName, "app_pub");
    write("");
    assert.equal((S.readSource(folder, root, {}) as Sources.ProjectSource).publicationName, null, "none named: Mason's own");
    write("publication: ${PG_PUBLICATION}\n");
    assert.equal((S.readSource(folder, root, { PG_PUBLICATION: "shell_pub" }) as Sources.ProjectSource).publicationName, "shell_pub");
    fs.writeFileSync(path.join(root, ".env"), "PG_PUBLICATION=dotenv_pub\n");
    assert.equal((S.readSource(folder, root, { PG_PUBLICATION: "shell_pub" }) as Sources.ProjectSource).publicationName, "dotenv_pub", "as url: is read: the folder's .env over the shell");
    assert.equal((S.readSource(folder, root, { PG_PUBLICATION: "shell_pub" }, { shellFirst: true }) as Sources.ProjectSource).publicationName, "shell_pub", "a server's environment first");
    fs.rmSync(path.join(root, ".env"));
    const unset = S.readSource(folder, root, {}) as Failure;
    assert.deepEqual([unset.code, unset.message, unset.fix], ["bad_source", "mason/sources/app.yml: publication: ${PG_PUBLICATION} is not set — not in .env.local, .env or the shell",
      "put PG_PUBLICATION=<the publication's name> in .env (or export it), or write publication: null and Mason makes its own"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  // `publication: null` is Mason's own, said on purpose, past PG_PUBLICATION too; no line says nothing
  const said = parse("kind: postgres\nurl: x\npublication: null\ntables: {}\n") as { publication: unknown };
  assert.deepEqual(said.publication, { own: true });
  assert.equal((parse("kind: postgres\nurl: x\ntables: {}\n") as { publication: unknown }).publication, null);
  // only the word: a key left with no value is a line half-written, and `~` is nobody's way of saying it
  for (const bare of ["publication:", "publication: ~", "publication: NULL"]) {
    assert.deepEqual((parse(`kind: postgres\nurl: x\n${bare}\ntables: {}\n`) as { problems: string[] }).problems,
      ["publication: write publication: ${PG_PUBLICATION}, or a publication's name (publication: null and Mason makes its own)"], bare);
  }
  const problems = (text: string): string[] => (parse(text) as { problems: string[] }).problems;
  assert.deepEqual(problems("kind: postgres\nurl: x\npublication: $PG_PUBLICATION\ntables: {}\n"), ['publication: "$PG_PUBLICATION" — write ${NAME} alone, like ${PG_PUBLICATION}, or the publication\'s name']);
  assert.deepEqual(problems("kind: postgres\nurl: x\npublication: ''\ntables: {}\n"), ["publication: write publication: ${PG_PUBLICATION}, or a publication's name (publication: null and Mason makes its own)"]);
  assert.deepEqual(problems("kind: postgres\nurl: x\npublcation: app_pub\ntables: {}\n"), ["unexpected key publcation — did you mean `publication`? — a source file takes kind, url, database, sync, publication, tables"]);
});

test("publication: or url: naming one of Mason's own settings (${MASON_…}) is refused when the file is read, its value never shown (issue 718)", () => {
  const SECRET = "secret-marker-7f3a9c";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mason-sources-own-"));
  try {
    const folder = path.join(root, "mason");
    fs.mkdirSync(path.join(folder, "sources"), { recursive: true });
    const write = (body: string): void => fs.writeFileSync(path.join(folder, "sources", "app.yml"), `kind: postgres\n${body}sync: replication\ntables: {}\n`);
    const env = { MASON_API_KEY: SECRET, mason_api_key: SECRET, MASON_TOKEN: SECRET, PG_PUBLICATION: "app_pub", DATABASE_URL: "postgres://u:p@h/db" };
    fs.writeFileSync(path.join(root, ".env"), `MASON_API_KEY=${SECRET}\n`);
    const pubWay = "write publication: ${PG_PUBLICATION}, the publication's name, or publication: null and Mason makes its own";
    const urlWay = "write url: ${DATABASE_URL} (or ${MASON_DATABASE_URL}), or a postgres:// URL";
    // every spelling YAML reads as ${MASON_API_KEY} is refused alike: the check is on the value parsed, not the text
    const cases: Array<[string, string]> = [
      ["url: ${DATABASE_URL}\npublication: ${MASON_API_KEY}\n", `publication: \${MASON_API_KEY} names one of Mason's own settings (MASON_*), which a sources file may not read — ${pubWay}`],
      ['url: ${DATABASE_URL}\npublication: "\\x24{MASON_API_KEY}"\n', `publication: \${MASON_API_KEY} names one of Mason's own settings (MASON_*), which a sources file may not read — ${pubWay}`],
      ['url: ${DATABASE_URL}\n"publication": " ${mason_api_key} "\n', `publication: \${mason_api_key} names one of Mason's own settings (MASON_*), which a sources file may not read — ${pubWay}`],
      ["url: ${MASON_TOKEN}\n", `url: \${MASON_TOKEN} names one of Mason's own settings (MASON_*), which a sources file may not read — ${urlWay}`],
      ["url: ${MASON_API_KEY}\npublication: ${PG_PUBLICATION}\n", `url: \${MASON_API_KEY} names one of Mason's own settings (MASON_*), which a sources file may not read — ${urlWay}`],
    ];
    for (const [body, problem] of cases) {
      write(body);
      for (const o of [{}, { shellFirst: true }]) {
        const f = S.readSource(folder, root, env, o) as Failure;
        assert.deepEqual([f.code, f.message, f.fix], ["bad_source", `mason/sources/app.yml: ${problem}`, "edit mason/sources/app.yml, then run the command again"], body);
        assert.ok(!JSON.stringify(f).includes(SECRET), `the value is never shown: ${body}`);
      }
      assert.deepEqual(problems(fs.readFileSync(path.join(folder, "sources", "app.yml"), "utf8")), [problem], body);
    }
    // the source's URL mason init writes stays: ${MASON_DATABASE_URL}, and any variable of the app's own
    write("url: ${MASON_DATABASE_URL}\npublication: ${PG_PUBLICATION}\n");
    const ok = S.readSource(folder, root, { MASON_DATABASE_URL: "postgres://u:p@h/db", PG_PUBLICATION: "app_pub" }) as Sources.ProjectSource;
    assert.deepEqual([ok.resolved, ok.publicationName], ["postgres://u:p@h/db", "app_pub"]);
    // MASON_DATABASE_URL is a URL, never a publication's name
    write("url: ${DATABASE_URL}\npublication: ${MASON_DATABASE_URL}\n");
    assert.equal((S.readSource(folder, root, env) as Failure).code, "bad_source");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the file read: one source per project, its URL from .env.local, .env or the shell — or what to write", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mason-sources-"));
  try {
    const folder = path.join(root, "mason");
    const none = S.readSource(folder, root, {}) as Failure;
    assert.equal(none.message, "this project names no database: mason/sources/ has no source file");
    assert.equal(none.fix, `write mason/sources/app.yml, with the database's URL in .env as DATABASE_URL:\n${S.newSourceText().trimEnd()}`);
    fs.mkdirSync(path.join(folder, "sources"), { recursive: true });
    fs.writeFileSync(path.join(folder, "sources", "app.yml"), S.newSourceText());
    const unset = S.readSource(folder, root, {}) as Failure;
    assert.deepEqual([unset.message, unset.fix], ["mason/sources/app.yml: url: ${DATABASE_URL} is not set — not in .env.local, .env or the shell",
      "put DATABASE_URL=postgres://user:password@host:5432/your_app in .env (or export it), or write the URL in url:"]);
    const shell = S.readSource(folder, root, { DATABASE_URL: "postgres://shell/db" }) as Sources.ProjectSource;
    assert.deepEqual([shell.resolved, shell.from], ["postgres://shell/db", "DATABASE_URL in the shell"]);
    fs.writeFileSync(path.join(root, ".env"), "DATABASE_URL=postgres://dotenv/db\n");
    const env = S.readSource(folder, root, { DATABASE_URL: "postgres://shell/db" }) as Sources.ProjectSource;
    assert.deepEqual([env.resolved, env.from], ["postgres://dotenv/db", "DATABASE_URL in .env"], "the folder's own, over the shell's: the URL mason init checked");
    fs.writeFileSync(path.join(folder, "sources", "warehouse.yml"), S.newSourceText());
    const two = S.readSource(folder, root, {}) as Failure;
    assert.deepEqual([two.code, two.message], ["bad_source", "mason/sources/ has 2 source files (app.yml, warehouse.yml): one source per project for now"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("mason add's entry, spliced in: after the last one, or in place of the table's own; every other byte as it was", () => {
  const add = (text: string, e: Partial<Sources.TableEntry> & { table: string }): string => {
    const r = S.withTable(text, { name: S.entryName(e.table), columns: null, exclude: [], key: null, ...e });
    assert.ok("text" in r, JSON.stringify(r));
    return r.text;
  };
  const fresh = S.newSourceText();
  const one = add(fresh, { table: "public.orders" });
  assert.equal(one, fresh.replace("tables: {}\n", "tables:\n  orders: {}\n"));
  const two = add(one, { table: "billing.invoices", columns: ["id", "Total Due"] });
  assert.ok(two.endsWith("tables:\n  orders: {}\n  billing.invoices:\n    columns: [id, \"Total Due\"]\n"), two);
  // in place, under the name the file gives it, comments around it kept
  const mine = "kind: postgres\nurl: x\ntables:   # copied\n    customers: {}   # every column\n    orders:\n      columns: [id]\n# end\n";
  assert.equal(add(mine, { table: "public.orders", exclude: ["payload"] }), "kind: postgres\nurl: x\ntables:   # copied\n    customers: {}   # every column\n    orders:\n      exclude: [payload]\n# end\n");
  assert.equal(add(mine, { table: "public.events", key: ["tenant_id", "id"] }), "kind: postgres\nurl: x\ntables:   # copied\n    customers: {}   # every column\n    orders:\n      columns: [id]\n    events:\n      key: [tenant_id, id]\n# end\n");
  assert.equal(add("kind: postgres\nurl: x\ntables: {}   # none yet\nmore: 1\n", { table: "public.orders" }), "kind: postgres\nurl: x\ntables:   # none yet\n  orders: {}\nmore: 1\n");
  assert.equal(add("kind: postgres\nurl: x\n", { table: "public.orders" }), "kind: postgres\nurl: x\ntables:\n  orders: {}\n");
  assert.deepEqual(S.withTable("tables: { orders: {} }\n", { name: "a", table: "public.a", columns: null, exclude: [], key: null }),
    { problem: "its tables: is written as a { … } map with entries: write it one table per line to have mason add and mason remove edit it" });
  // whatever the edit, the file reads back as the entry it wrote
  assert.deepEqual((parse(`kind: postgres\nurl: x\n${two.slice(two.indexOf("tables:"))}`) as Sources.SourceFile).tables.map((t) => [t.table, t.columns]),
    [["public.orders", null], ["billing.invoices", ["id", "Total Due"]]]);
});

test("mason remove's cut: the entry's lines go, the rest as it was; the last one gone leaves tables: {}", () => {
  const text = "kind: postgres\nurl: x\ntables:   # copied\n  customers: {}   # every column\n  orders:\n    columns: [id]\n# end\n";
  assert.deepEqual(S.withoutTable(text, "public.orders"), { text: "kind: postgres\nurl: x\ntables:   # copied\n  customers: {}   # every column\n# end\n" });
  assert.deepEqual(S.withoutTable(text, "public.nope"), null);
  const once = S.withoutTable(text, "public.orders") as { text: string };
  assert.deepEqual(S.withoutTable(once.text, "public.customers"), { text: "kind: postgres\nurl: x\ntables: {}   # copied\n# end\n" });
  const f = parse(EXAMPLE) as Sources.SourceFile;
  assert.equal((S.findEntry(f, "public.customers") as Sources.TableEntry).name, "customers");
  assert.equal((S.findEntry(f, "invoices") as { problem: string }).problem, "app.yml names no table invoices (it names orders, customers, events, billing.invoices)");
  assert.equal((S.findEntry(f, "order") as { problem: string }).problem, "app.yml names no table order — did you mean `orders`? (it names orders, customers, events, billing.invoices)");
});

test("mason add's columns: a list with the key added, every one as {} or exclude: naming what looks secret, --key's columns, a name the table lacks refused", () => {
  assert.deepEqual(S.chooseColumns(orders, ["*"]), { columns: null, exclude: ["api_token"], addedKey: [], skipped: ["api_token"] }, "secret-looking: left out, said as exclude:");
  assert.deepEqual(S.chooseColumns(customers, ["*"]), { columns: null, exclude: [], addedKey: [], skipped: [] }, "nothing secret-looking: every column, {}");
  assert.deepEqual(S.chooseColumns(orders, ["*", "api_token"]), { columns: null, exclude: [], addedKey: [], skipped: [] });
  assert.deepEqual(S.chooseColumns(orders, ["api_token"]), { columns: ["id", "api_token"], exclude: [], addedKey: ["id"], skipped: [] }, "named outright: included, as any column; the key written first");
  assert.deepEqual(S.chooseColumns(events, ["raw_body"], ["tenant_id", "id"]), { columns: ["tenant_id", "id", "raw_body"], exclude: [], addedKey: ["tenant_id", "id"], skipped: [] }, "--key's columns are its key");
  assert.deepEqual(S.chooseColumns(orders, ["status", "id"]), { columns: ["status", "id"], exclude: [], addedKey: [], skipped: [] }, "a key named is where it was named");
  assert.equal((S.chooseColumns(orders, ["statsu"]) as { problem: string }).problem, 'public.orders has no column "statsu" — did you mean `status`?; its columns: id, customer_id, status, amount, api_token, payload');
  assert.match((S.chooseColumns(orders, []) as { problem: string }).problem, /mason add orders --columns id,status,… — or leave --columns out for every one/);
  // what a table says in mason tables: the columns its copy keeps, the key it is copied by
  assert.deepEqual(S.catalogTable(events, { name: "events", table: "public.events", columns: null, exclude: ["raw_body"], key: ["tenant_id", "id"], sync: null }),
    { ...S.catalogTable(events, undefined), reason: null, added: true, addedColumns: ["tenant_id", "id"], copyKey: ["tenant_id", "id"] });
  assert.equal(S.catalogTable(events, undefined).reason, "no primary key: name the columns that tell its rows apart, mason add events --key tenant_id,id (its unique index events_tenant_id_id_key)");
});

test("what looks like a secret: credentials' own words, never an identifier or a time named after one", () => {
  for (const c of ["password", "password_hash", "passwd", "secret", "client_secret", "token", "access_token", "api_key", "apikey", "ssh_private_key", "deploy_key_content", "warehouse_private_key", "aws_secret_key", "credentials", "salt"]) {
    assert.ok(S.looksSecret(c), `${c} looks like a secret`);
  }
  for (const c of ["id", "name", "token_id", "token_count", "secret_name", "api_key_created_at", "user_key", "cache_key", "partition_key", "tokens_used_type", "email"]) {
    assert.ok(!S.looksSecret(c), `${c} does not`);
  }
});

// ISSUE 797: the same words however a name is written — an ORM's camelCase and PascalCase, UPPER_SNAKE, kebab — and the
// same identifier and time suffixes exempt in each form.
test("what looks like a secret reads a name's words in any case: passwordHash, apiKey, API_TOKEN, Password; tokenId, apiKeyName are not", () => {
  const forms: Record<string, (w: string[]) => string> = {
    snake: (w) => w.join("_"),
    camel: (w) => w.map((x, i) => i === 0 ? x : x[0]!.toUpperCase() + x.slice(1)).join(""),
    pascal: (w) => w.map((x) => x[0]!.toUpperCase() + x.slice(1)).join(""),
    upper: (w) => w.join("_").toUpperCase(),
    kebab: (w) => w.join("-"),
    acronym: (w) => w.map((x) => x === "api" || x === "ssh" ? x.toUpperCase() : x[0]!.toUpperCase() + x.slice(1)).join(""),
  };
  const secrets = [["password"], ["passwd"], ["pwd"], ["secret"], ["secrets"], ["token"], ["tokens"], ["apikey"], ["credential"], ["credentials"], ["salt"],
    ["api", "key"], ["access", "key"], ["secret", "key"], ["private", "key"], ["ssh", "key"], ["signing", "key", "content"]];
  const exempt = [["id"], ["ids"], ["at"], ["count"], ["type"], ["name"], ["kind"], ["hash", "algo"]];
  for (const [form, write] of Object.entries(forms)) {
    for (const s of secrets) {
      // `…_key_content` is a secret at the name's end only, as main read it
      const around = s.at(-1) === "content" ? [s, ["user", ...s]] : [s, ["hashed", ...s], [...s, "hash"], ["user", ...s, "value"]];
      for (const w of around) assert.ok(S.looksSecret(write(w)), `${form}: ${write(w)} looks like a secret`);
      for (const e of exempt) assert.ok(!S.looksSecret(write([...s, ...e])), `${form}: ${write([...s, ...e])} names an identifier or a time, not a secret`);
    }
  }
  for (const c of ["passwordHash", "hashedPassword", "apiKey", "APIKey", "API_KEY", "api-key", "accessToken", "refreshToken", "Password", "API_TOKEN", "SSHKey",
    "clientSecret", "oauth2Token", "isSecret"]) assert.ok(S.looksSecret(c), `${c} looks like a secret`);
  // near misses: a secret word inside another word, a plural the rule never named, a word that only begins like one
  for (const c of ["tokenId", "tokenID", "tokenIDs", "secretCount", "passwordType", "apiKeyName", "saltHashAlgo", "pwdChangedAt", "accessKeyId", "tokenizer",
    "Tokenizer", "TOKENIZER", "passwords", "secretary", "Secretary", "salary", "keyboard", "monkey", "apiVersion", "API_VERSION", "keyContent", "key_content",
    "primaryKey", "cacheKey", "userKey", "displayName"]) assert.ok(!S.looksSecret(c), `${c} does not`);
  // at the name's very end only: a separator after a suffix is no identifier (fail closed, as main read it)
  assert.ok(S.looksSecret("token_id_"));
  assert.deepEqual(S.nameWords("APIKeyIDs"), ["api", "key", "ids"]);
  assert.deepEqual(S.nameWords("user_PasswordHash-v2"), ["user", "password", "hash", "v2"]);
});

test("a key: must tell the rows apart as the database enforces it: NOT NULL columns, over a unique index — else refused at its key", () => {
  // the review of the sources file: a key with duplicates failed the copy as "Mason bug", retried for ever,
  // and duplicates after the copy made the poll's update and delete by key change both rows
  const logs = table({ table: "logs", key: [], columns: [col("tenant_id", "bigint", true), col("id", "bigint", true), col("seq", "bigint"), col("note")],
    uniqueKeys: [{ name: "logs_tenant_id_id_key", columns: ["tenant_id", "id"], constraint: true, nullsNotDistinct: false }] });
  const bare = table({ table: "bare", key: [], columns: [col("a", "bigint", true), col("b")] });
  const added = (entries: string): unknown => S.addedTables(parse(`kind: postgres\nurl: x\ntables:\n${entries}`) as Sources.SourceFile, [logs, bare], "shop", "/app");
  assert.ok(Array.isArray(added("  logs: { key: [tenant_id, id] }\n")), "the unique index's own columns");
  assert.ok(Array.isArray(added("  logs: { key: [id, tenant_id] }\n")), "in any order");
  const wrong = added("  logs: { key: [id] }\n  bare: { key: [a] }\n") as Failure;
  assert.equal(wrong.why, [
    "- tables.logs.key: no unique index of public.logs is over (id), so two of its rows may share them and Mason could not tell them apart — name the columns of one: key: [tenant_id, id] (its unique index logs_tenant_id_id_key)",
    "- tables.bare.key: no unique index of public.bare is over (a), so two of its rows may share them and Mason could not tell them apart — it has no unique index over NOT NULL columns, so Mason cannot sync it until its owner adds one (or a primary key)",
  ].join("\n"));
  const nullable = added("  logs: { key: [tenant_id, id, seq] }\n") as Failure;
  assert.equal(nullable.message, "mason/sources/app.yml: tables.logs.key: seq may be NULL in public.logs, and rows with NULL there cannot be told apart — a key's columns are NOT NULL");
});

test("the file read again while the run is up: a mistake keeps the tables read before and is said once; a url: naming another database too", () => {
  const ok = parse("kind: postgres\nurl: postgres://me@localhost:5432/shop\ntables:\n  customers: {}\n") as Sources.SourceFile;
  const read = (text: string, resolved = "postgres://me@localhost:5432/shop"): Sources.ProjectSource | Failure => {
    const p = parse(text);
    return "problems" in p ? S.sourceFailure(FILE, "/app", p.problems) : { ...p, resolved, from: "mason/sources/app.yml", publicationName: null };
  };
  const RUN = "postgres://me@localhost:5432/shop";
  const first = S.addedTables(ok, CATALOG, "shop", "/app") as Sources_AddedTable[];
  let now: Sources.RunSources = { file: ok, tables: first, problem: null };
  // the file stops parsing: the tables kept, said once
  const broken = S.rereadSources(now, read("kind: postgres\nurl: x\ntables:\n  customers: {\n"), RUN, CATALOG, "shop", "/app");
  assert.deepEqual([broken.tables, broken.file], [first, ok], "the tables read before, kept");
  assert.match(broken.said ?? "", /^the sources file cannot be read as it is now, so the tables read before are kept: mason\/sources\/app\.yml: it is not YAML/);
  now = broken;
  assert.equal(S.rereadSources(now, read("kind: postgres\nurl: x\ntables:\n  customers: {\n"), RUN, CATALOG, "shop", "/app").said, null, "the same problem is not said again");
  // a url: that names another database (a .env edited): the run's catalog is the old one's — kept, and the way out said
  const moved = S.rereadSources(now, read("kind: postgres\nurl: ${DATABASE_URL}\ntables:\n  orders: {}\n", "postgres://me:pw@elsewhere:5432/other"), RUN, CATALOG, "shop", "/app");
  assert.deepEqual(moved.tables, first);
  assert.equal(moved.problem, "mason/sources/app.yml: url: now names postgres://me:****@elsewhere:5432/other (mason/sources/app.yml), and this run syncs postgres://me@localhost:5432/shop: mason stop && mason start syncs from the new one");
  // fixed: the file's tables now, nothing wrong
  const fixed = S.rereadSources(moved, read("kind: postgres\nurl: x\ntables:\n  orders: {}\n"), RUN, CATALOG, "shop", "/app");
  assert.deepEqual([fixed.tables.map((t) => t.source), fixed.problem, fixed.said], [["public.orders"], null, null]);
});

test("the small mistakes: $NAME without braces, a name YAML reads as a boolean, null or number — each told what to write", () => {
  assert.deepEqual(problems("kind: postgres\nurl: $DATABASE_URL\ntables: {}\n"), ["url: $DATABASE_URL — write ${DATABASE_URL}: a variable is named in braces"]);
  assert.deepEqual(problems("kind: postgres\nurl: x\ntables:\n  true: {}\n  1: {}\n  orders: { columns: [id, null, 2] }\n"), [
    "tables: true is read by YAML as a boolean, not a name — quote it: \"true\"",
    "tables: 1 is read by YAML as a number, not a name — quote it: \"1\"",
    "tables.orders.columns: null is read by YAML as nothing (null), not a name — quote it: \"null\"",
  ]);
  assert.deepEqual((parse("kind: postgres\nurl: x\ntables:\n  \"true\": { columns: [id, \"null\"] }\n") as Sources.SourceFile).tables[0], { name: "true", table: "public.true", columns: ["id", "null"], exclude: [], key: null, sync: null });
});

test("a table's name has at most two parts, said why: a third will name the source a table is in, once a project has several", () => {
  // the file: refused at its key, never read as a table whose name holds a dot
  assert.deepEqual(problems("kind: postgres\nurl: x\ntables:\n  shop.billing.invoices: {}\n  a..b: {}\n  orders: {}\n"), [
    "tables.shop.billing.invoices: shop.billing.invoices has 3 parts, and a table is schema.table (billing.invoices) or its name alone in public (orders): this project has one source, so a table's name has at most two",
    "tables.a..b: a table is its name (orders) or schema.table (billing.invoices)",
  ]);
  // mason remove: the entry it may have meant, by the last two parts
  const f = parse(EXAMPLE) as Sources.SourceFile;
  assert.deepEqual(S.findEntry(f, "app.billing.invoices"), { problem: "app.billing.invoices has 3 parts, and a table is schema.table (billing.invoices) or its name alone in public (orders): this project has one source, so a table's name has at most two — did you mean `billing.invoices`?", usage: true });
  assert.deepEqual(S.findEntry(f, "app.public.order"), { problem: "app.public.order has 3 parts, and a table is schema.table (billing.invoices) or its name alone in public (orders): this project has one source, so a table's name has at most two — did you mean `orders`?", usage: true });
  assert.deepEqual(S.findEntry(f, "x.y.z.w"), { problem: "x.y.z.w has 4 parts, and a table is schema.table (billing.invoices) or its name alone in public (orders): this project has one source, so a table's name has at most two", usage: true }, "nothing close: no guess");
  assert.equal(S.tableNameProblem("billing.invoices"), null);
  assert.equal(S.tableNameProblem("orders"), null);
});

test("a file written with CRLF line endings is edited in them: what mason add and mason remove write ends as the file's lines do", () => {
  const crlf = "kind: postgres\r\nurl: x\r\ntables:\r\n  customers: {}\r\n";
  const added = S.withTable(crlf, { name: "orders", table: "public.orders", columns: ["id"], exclude: [], key: null }) as { text: string };
  assert.equal(added.text, "kind: postgres\r\nurl: x\r\ntables:\r\n  customers: {}\r\n  orders:\r\n    columns: [id]\r\n");
  assert.equal((S.withoutTable(added.text, "public.customers") as { text: string }).text, "kind: postgres\r\nurl: x\r\ntables:\r\n  orders:\r\n    columns: [id]\r\n");
  assert.equal((S.withoutTable("kind: postgres\r\nurl: x\r\ntables:\r\n  orders: {}\r\n", "public.orders") as { text: string }).text, "kind: postgres\r\nurl: x\r\ntables: {}\r\n");
});

test("an INVALID unique index (a failed CREATE UNIQUE INDEX CONCURRENTLY, its duplicates still there) is neither read, declared to the catalog, nor a key: Mason accepts", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { readSourceFacts } = await import("../src/cli/preflight.ts");
  const db = new PGlite();
  try {
    // logs: no primary key, (tenant_id, id) unique by a valid index and (id) by an INVALID one, as a failed concurrent
    // build leaves it; the duplicate ids that failed it are in the table
    await db.exec("CREATE TABLE public.logs (tenant_id bigint NOT NULL, id bigint NOT NULL, note text); " +
      "CREATE UNIQUE INDEX logs_tenant_id_id ON public.logs (tenant_id, id); CREATE UNIQUE INDEX logs_id ON public.logs (id); " +
      // not valid, and (as a build that failed before it was ready) not maintained: the duplicate goes in after it
      "UPDATE pg_index SET indisvalid = false, indisready = false WHERE indexrelid = 'public.logs_id'::regclass; " +
      "INSERT INTO public.logs VALUES (1, 7, 'a'), (2, 7, 'b')");
    // the source read through PGlite: each statement's rows as text (the last statement's, of a text of several)
    const pg = { query: async (sql: string) => {
      const last = (await db.exec(sql, { rowMode: "array" })).at(-1)!;
      return { rows: (last.rows as unknown as unknown[][]).map((r) => r.map((v) => v === null || v === undefined ? null : typeof v === "object" ? JSON.stringify(v) : String(v))) };
    } };
    const facts = await readSourceFacts(pg as unknown as Parameters<typeof readSourceFacts>[0], new Map());
    const logs = facts.tables.find((t) => t.source === "public.logs")!;
    assert.deepEqual(logs.uniqueKeys?.map((u) => u.name), ["logs_tenant_id_id"], "the invalid index is not read, so the catalog never declares it");
    // a key: over the invalid index's column alone is refused; over the valid one's columns accepted
    const add = (key: string): unknown => S.addedTables(parse(`kind: postgres\nurl: x\ntables:\n  logs: { key: [${key}] }\n`) as Sources.SourceFile, [logs], "shop", "/app");
    assert.match((add("id") as Failure).why ?? (add("id") as Failure).message, /no unique index of public\.logs is over \(id\)/);
    assert.ok(Array.isArray(add("tenant_id, id")), JSON.stringify(add("tenant_id, id")));
  } finally { await db.close(); }
});

// ------------------------------------------------------------------ sync: how each table is kept current (GitHub issue 33)

const OFF = { mode: "off" };
const poll = (every: string, seconds: number) => ({ mode: "poll", every, seconds });
const head = "kind: postgres\nurl: ${DATABASE_URL}\n";

test("sync: one grammar — off, poll 5s, poll 5m, poll 1h — at the top as every table's default, on an entry for that table, and none at all meaning off", () => {
  const read = (text: string) => { const f = parse(text) as Sources.SourceFile; return { top: f.sync, entries: f.tables.map((e) => [e.name, e.sync, S.effectiveSync(f, e)]) }; };
  for (const [v, want] of [["off", OFF], ["poll 5s", poll("5s", 5)], ["poll 5m", poll("5m", 300)], ["poll 1h", poll("1h", 3600)], ["poll 90s", poll("90s", 90)], ["  poll 1s ", poll("1s", 1)]] as const) {
    assert.deepEqual(read(`${head}sync: ${v}\ntables: {}\n`).top, want, v);
  }
  // at the top only: every entry follows it, said as the file's
  assert.deepEqual(read(`${head}sync: poll 5m\ntables:\n  orders: {}\n`).entries, [["orders", null, { sync: poll("5m", 300), from: "file" }]]);
  // on an entry: it overrides the top for that table alone
  assert.deepEqual(read(`${head}sync: off\ntables:\n  orders:\n    sync: poll 30s\n  customers: {}\n  events: { sync: poll 1h }\n`).entries, [
    ["orders", poll("30s", 30), { sync: poll("30s", 30), from: "entry" }],
    ["customers", null, { sync: OFF, from: "file" }],
    ["events", poll("1h", 3600), { sync: poll("1h", 3600), from: "entry" }],
  ]);
  // none anywhere: off, the default — the file means it, said as the default
  assert.deepEqual(read(`${head}tables:\n  orders: {}\n`), { top: null, entries: [["orders", null, { sync: OFF, from: "default" }]] });
  // and the tables the run copies carry each one's effective sync
  const f = parse(`${head}sync: poll 5m\ntables:\n  orders: { sync: off }\n  customers: {}\n`) as Sources.SourceFile;
  const added = S.addedTables(f, CATALOG, "shop", "/app") as Array<{ source: string; sync?: unknown }>;
  assert.deepEqual(added.map((t) => [t.source, t.sync]), [["public.orders", OFF], ["public.customers", poll("5m", 300)]]);
});

test("sync: every mistake on one report, at its key, with the line to write — a short interval, poll alone, a misspelt mode or key, an interval on replication", () => {
  const one = (v: string, at = "sync"): string => {
    const p = at === "sync" ? problems(`${head}sync: ${v}\ntables: {}\n`) : problems(`${head}tables:\n  orders:\n    sync: ${v}\n`);
    assert.equal(p.length, 1, JSON.stringify(p));
    return p[0]!;
  };
  assert.equal(one("poll 500ms"), "sync: 500ms is under the shortest interval, 1s (a poll scans the table whole on your database): write poll 1s or longer");
  assert.equal(one("poll 0s"), "sync: 0s is under the shortest interval, 1s: write poll 1s or longer");
  assert.equal(one("poll"), "sync: poll needs its interval: write poll 5s, poll 5m or poll 1h (at least 1s)");
  assert.equal(one("polling 5s"), "sync: polling is not a sync — did you mean `poll 5s`? Write off, poll <interval> (poll 5s, poll 5m or poll 1h) or replication");
  assert.equal(one("Off"), "sync: Off is not a sync — did you mean `off`? Write off, poll <interval> (poll 5s, poll 5m or poll 1h) or replication");
  assert.equal(one("replication 5m"), "sync: replication takes no interval: write replication, or poll 5m");
  assert.equal(one("poll 5 minutes"), 'sync: "5 minutes": write poll 5m');
  assert.equal(one("poll 1.5h"), "sync: 1.5h: an interval is a whole number — write poll 90m");
  // d is a unit, as on every command line (src/lib/table-sync.ts parseDuration); a bare number is said with its unit
  assert.equal(one("poll 2d"), "sync: 2d is over the longest interval, 24h: write poll 24h, or off with mason sync <table> run by a scheduler");
  assert.deepEqual((parse(`${head}sync: poll 1d\ntables: {}\n`) as Sources.SourceFile).sync, { mode: "poll", every: "1d", seconds: 86_400 });
  assert.equal(one("poll 30"), "sync: 30 has no unit: write poll 30s for seconds (or m, h, d)");
  assert.equal(one("poll soon"), 'sync: "soon" is not an interval: an interval is <n>s, <n>m, <n>h or <n>d, a whole number, at least 1s (poll 5s, poll 5m or poll 1h)');
  assert.equal(one("off 5m"), "sync: off takes no interval: write off, or poll 5m");
  // at most a day (a longer one is off and mason sync from a scheduler; a huge one was an instant past a Date's range and
  // broke every status line), and one spelling of each interval (05s and 5s would read as a change of sync)
  assert.equal(one("poll 25h"), "sync: 25h is over the longest interval, 24h: write poll 24h, or off with mason sync <table> run by a scheduler");
  assert.equal(one("poll 9999999999999s"), "sync: 9999999999999s is over the longest interval, 24h: write poll 24h, or off with mason sync <table> run by a scheduler");
  assert.equal(one("poll 05s"), 'sync: "05s": write poll 5s');
  assert.deepEqual((parse(`${head}sync: poll 24h\ntables: {}\n`) as Sources.SourceFile).sync, poll("24h", 86_400), "a day is the longest, and taken");
  assert.equal(one("5"), "sync: is the number 5: write off, poll <interval> (poll 5s, poll 5m or poll 1h) or replication");
  // on an entry, at the entry's key
  assert.equal(one("poll", "entry"), "tables.orders.sync: poll needs its interval: write poll 5s, poll 5m or poll 1h (at least 1s)");
  // the key misspelt, at the top and on an entry: did you mean
  assert.deepEqual(problems(`${head}synk: off\ntables: {}\n`), ["unexpected key synk — did you mean `sync`? — a source file takes kind, url, database, sync, publication, tables"]);
  assert.deepEqual(problems(`${head}tables:\n  orders:\n    Sync: off\n`), ["tables.orders: unexpected key Sync — did you mean `sync`? — a table takes columns, exclude, key, sync and references"]);
  // all of a file's mistakes on ONE report
  assert.deepEqual(problems(`${head}sync: poll\ntables:\n  orders: { sync: polling 5s }\n  customers: { sync: poll 500ms }\n`), [
    "sync: poll needs its interval: write poll 5s, poll 5m or poll 1h (at least 1s)",
    "tables.orders.sync: polling is not a sync — did you mean `poll 5s`? Write off, poll <interval> (poll 5s, poll 5m or poll 1h) or replication",
    "tables.customers.sync: 500ms is under the shortest interval, 1s (a poll scans the table whole on your database): write poll 1s or longer",
  ]);
});

test("mason init writes sync: off at the top with a one-line comment; mason init demo writes sync: poll 5s", () => {
  const plain = S.newSourceText();
  assert.match(plain, /^sync: off {3}# after its first sync, a table is read again only by mason sync <table> \(poll 5m: every 5 minutes\)$/m);
  assert.deepEqual((parse(plain) as Sources.SourceFile).sync, OFF, "a file it reads, its sync written");
  const demo = S.newSourceText("${DATABASE_URL}", ["customers", "orders"], poll("5s", 5) as never);
  assert.match(demo, /^sync: poll 5s {3}# each table polled every 5s after its first sync \(off: read again only by mason sync <table>\)$/m);
  assert.deepEqual((parse(demo) as Sources.SourceFile).sync, poll("5s", 5));
  // the sync above the tables, the tables last, as before
  assert.ok(demo.indexOf("sync: poll 5s") < demo.indexOf("tables:"), demo);
});

test("mason add --sync's line: written on the entry alone, its columns, key and comments as they were — a block entry's line replaced or added, a flow entry written again", () => {
  const set = (text: string, table: string, sync: ReturnType<typeof poll> | typeof OFF | null): string => {
    const f = parse(text) as Sources.SourceFile;
    const e = f.tables.find((x) => x.table === table)!;
    const r = S.withEntrySync(text, e, sync as never);
    assert.ok("text" in r, JSON.stringify(r));
    return r.text;
  };
  const mine = `${head}sync: off   # the default\ntables:   # copied\n  customers: {}   # every column\n  orders:\n    columns: [id, status]   # not the payload\n# end\n`;
  // a block entry: a line of its own under its last key, at its keys' indent; its comment kept
  const polled = set(mine, "public.orders", poll("30s", 30));
  assert.equal(polled, mine.replace("    columns: [id, status]   # not the payload\n", "    columns: [id, status]   # not the payload\n    sync: poll 30s\n"));
  // its sync: replaced in place, the rest of the line too; and taken out (it follows the file's again)
  assert.equal(set(polled, "public.orders", poll("1h", 3600)), polled.replace("sync: poll 30s", "sync: poll 1h"));
  assert.equal(set(polled, "public.orders", null), mine);
  // a flow entry ({}): written again a key a line, the comment after it on its key's line kept
  assert.equal(set(mine, "public.customers", OFF), mine.replace("  customers: {}   # every column\n", "  customers:   # every column\n    sync: off\n"));
  // an entry with no value: its comment kept on its key's line (a review finding: it was dropped)
  const bare = `${head}tables:\n  orders:   # the shop's\n  customers: {}\n`;
  assert.equal(set(bare, "public.orders", poll("30s", 30)), `${head}tables:\n  orders:   # the shop's\n    sync: poll 30s\n  customers: {}\n`);
  // an entry whose only key is sync, taken out: {} again
  const only = `${head}tables:\n  orders:\n    sync: poll 5s\n`;
  assert.equal(set(only, "public.orders", null), `${head}tables:\n  orders: {}\n`);
  // what it wrote reads back as the entry it meant, every other entry as it was
  const back = parse(set(mine, "public.orders", poll("30s", 30))) as Sources.SourceFile;
  assert.deepEqual(back.tables.map((e) => [e.name, e.columns, e.sync]), [["customers", null, null], ["orders", ["id", "status"], poll("30s", 30)]]);
  // and withTable, a new entry with its own sync
  const r = S.withTable(`${head}tables: {}\n`, { name: "orders", table: "public.orders", columns: null, exclude: [], key: null, sync: poll("5m", 300) as never });
  assert.deepEqual(r, { text: `${head}tables:\n  orders:\n    sync: poll 5m\n` });
});

test("mason add's sync: --sync writes the entry's sync: alone, comments kept; a big table under a polling file is written off and said; a frequent poll of a huge one is estimated, its basis said", async () => {
  const E = await import("../src/cli/source-edit.ts" as string) as typeof import("../src/cli/source-edit.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mason-add-sync-"));
  const folder = path.join(root, "mason");
  fs.mkdirSync(path.join(folder, "sources"), { recursive: true });
  const file = path.join(folder, "sources", "app.yml");
  const big = table({ table: "events_big", rows: 22_000_000 });
  const huge = table({ table: "huge", rows: 50_000_000 });
  const db = { tables: [...CATALOG, big, huge], database: "shop" };
  const edit = (text: string) => { fs.writeFileSync(file, text); return E.sourceToEdit(folder, root, () => S.readSource(folder, root, {})); };
  const top = "kind: postgres\nurl: postgres://me@localhost/shop\nsync: poll 5m   # every table\ntables:   # copied\n  customers: {}   # every column\n  orders:\n    columns: [id, status]   # not the payload\n";
  try {
    // --sync alone on a table already added: its sync: line, nothing else — its columns and its comment kept
    const r = E.addEntry(edit(top), db, "public.orders", ["*"], null, { sync: { mode: "poll", every: "30s", seconds: 30 }, keep: true });
    assert.equal(fs.readFileSync(file, "utf8"), top.replace("    columns: [id, status]   # not the payload\n", "    columns: [id, status]   # not the payload\n    sync: poll 30s\n"));
    assert.deepEqual([r.columns, r.sync, r.bigOff, r.pollCost, r.already], [["id", "status"], { value: "poll 30s", from: "entry" }, false, null, false]);
    // asked again, the same: nothing written
    assert.equal(E.addEntry(edit(fs.readFileSync(file, "utf8")), db, "public.orders", ["*"], null, { sync: { mode: "poll", every: "30s", seconds: 30 }, keep: true }).already, true);
    // a new entry without --sync follows the file's: no sync: of its own, said as the file's
    const inv = E.addEntry(edit(top), db, "billing.invoices");
    assert.deepEqual(inv.sync, { value: "poll 5m", from: "file" });
    assert.ok(fs.readFileSync(file, "utf8").endsWith("  billing.invoices: {}\n"), "no sync: of its own");
    // A BIG TABLE under a file that polls: written sync: off on its entry, and said with the alternatives
    const b = E.addEntry(edit(top), db, "public.events_big");
    assert.ok(fs.readFileSync(file, "utf8").endsWith("  events_big:\n    sync: off\n"), fs.readFileSync(file, "utf8"));
    assert.deepEqual([b.sync, b.bigOff], [{ value: "off", from: "entry" }, true]);
    const commands = await import("../src/cli/commands.ts");
    assert.equal(commands.addedLines(b, "mason/sources/app.yml").notes[0], "sync: off written on its entry: it has more than 1,000,000 rows, and each poll scans it whole on your database — " +
      "mason add events_big --sync \"poll 1h\" polls it hourly; mason sync events_big syncs it once, now; mason add events_big --sync replication keeps it current from the change log");
    // under a file whose default is off, a big table follows it (nothing to write); with --sync it is what was asked
    const offTop = top.replace("sync: poll 5m", "sync: off");
    assert.deepEqual([E.addEntry(edit(offTop), db, "public.events_big").bigOff, fs.readFileSync(file, "utf8").endsWith("  events_big: {}\n")], [false, true]);
    // a huge table set to poll under a minute: warned, the estimate's basis said — the catalog's rows, nothing measured
    const h = E.addEntry(edit(top), db, "public.huge", ["*"], null, { sync: { mode: "poll", every: "30s", seconds: 30 } });
    assert.equal(h.pollCost, "huge has about 50,000,000 rows, and each poll scans it whole on your database: about 28 s a poll, from the catalog's 50,000,000 rows at an assumed " +
      "1,800,000 rows a second of scan (nothing of it measured yet). sync: poll 30s is stretched to a poll every 2 min at most (a poll waits four times its own time), one backend of " +
      "your database busy 25 % of the time — a longer interval (--sync \"poll 1h\"), or --sync replication (the change log), costs it less");
    // measured by the run: its last poll first, else its copy's read rate a reader
    assert.match(E.pollCost(huge, { mode: "poll", every: "10s", seconds: 10 }, { lastPollMs: 40_000, copyRowsPerSecond: 500_000 })!, /about 40 s a poll, from its last poll, measured\./);
    assert.match(E.pollCost(huge, { mode: "poll", every: "10s", seconds: 10 }, { lastPollMs: null, copyRowsPerSecond: 500_000 })!, /about 2 min a poll, from its first sync's read rate, 500,000 rows a second a reader/);
    assert.equal(E.pollCost(huge, { mode: "poll", every: "1m", seconds: 60 }, null), null, "every minute or slower: no warning");
    assert.equal(E.pollCost(table({ table: "mid", rows: 5_000_000 }), { mode: "poll", every: "5s", seconds: 5 }, null), null, "under ten million rows: none");
    // UNDER A FILE WHOSE DEFAULT IS REPLICATION, a table it cannot replicate is written sync: poll 5m, and why: a key:
    // table (no primary key), and one with REPLICA IDENTITY NOTHING; one that can follows the file
    const replTop = "kind: postgres\nurl: postgres://me@localhost/shop\nsync: replication\ntables:\n  customers: {}\n";
    const keyed = E.addEntry(edit(replTop), { tables: [...CATALOG], database: "shop" }, "public.events", ["*"], ["tenant_id", "id"]);
    assert.ok(fs.readFileSync(file, "utf8").endsWith("  events:\n    key: [tenant_id, id]\n    sync: poll 5m\n"), fs.readFileSync(file, "utf8"));
    assert.deepEqual([keyed.sync, keyed.notReplicated], [{ value: "poll 5m", from: "entry" }, "it has no primary key, so logical replication cannot apply its changes by its key:"]);
    const nothing = E.addEntry(edit(replTop), { tables: [...CATALOG, table({ table: "audit", replicaIdentity: "n" })], database: "shop" }, "public.audit");
    assert.deepEqual([nothing.sync, nothing.notReplicated?.startsWith("it has REPLICA IDENTITY NOTHING")], [{ value: "poll 5m", from: "entry" }, true]);
    const follows = E.addEntry(edit(replTop), db, "billing.invoices");
    assert.deepEqual([follows.sync, follows.notReplicated], [{ value: "replication", from: "file" }, null]);
    assert.ok(fs.readFileSync(file, "utf8").endsWith("  billing.invoices: {}\n"));
    // asked for by --sync, it is what was asked: refused at its entry, the line to write
    // asked for by --sync, refused with the COMMAND to run, its own flags kept (the person is at it), nothing written
    const said = (f: () => unknown): string => { try { f(); } catch (e) { return (e as Error).message; } return "taken"; };
    const REPL = { sync: { mode: "replication" } as const };
    const keyedText = edit(replTop);
    assert.equal(said(() => E.addEntry(keyedText, { tables: [...CATALOG], database: "shop" }, "public.events", ["*"], ["tenant_id", "id"], REPL)),
      "public.events cannot be kept current by logical replication: it has no primary key, so logical replication cannot apply its changes by its key: — " +
      "mason add events --key tenant_id,id --sync \"poll 5m\" polls it instead");
    assert.equal(fs.readFileSync(file, "utf8"), replTop, "nothing written");
    assert.equal(said(() => E.addEntry(edit(replTop), { tables: [...CATALOG, table({ table: "audit", replicaIdentity: "n" })], database: "shop" }, "public.audit", ["id"], null, REPL)),
      "public.audit cannot be kept current by logical replication: it has REPLICA IDENTITY NOTHING, and a publication carrying it would make your app's own UPDATEs and DELETEs on it fail — " +
      "mason add audit --columns id --sync \"poll 5m\" polls it instead");
    // --sync alone on one added already: the command is --sync alone
    const withAudit = "kind: postgres\nurl: postgres://me@localhost/shop\ntables:\n  audit: {}\n";
    assert.match(said(() => E.addEntry(edit(withAudit), { tables: [...CATALOG, table({ table: "audit", replicaIdentity: "n" })], database: "shop" }, "public.audit", ["*"], null, { ...REPL, keep: true })),
      / — mason add audit --sync "poll 5m" polls it instead$/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("mason tables' entry for each table is mason add's, decided in one place: its sync under the file's default, a refusal as its reason, an added one's as the file says it (issue 794)", async () => {
  const E = await import("../src/cli/source-edit.ts" as string) as typeof import("../src/cli/source-edit.ts");
  const { parse } = await import("yaml");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mason-tables-entry-"));
  const folder = path.join(root, "mason");
  fs.mkdirSync(path.join(folder, "sources"), { recursive: true });
  const file = path.join(folder, "sources", "app.yml");
  const big = table({ table: "events_big", rows: 22_000_000 });
  const hidden = table({ table: "hidden", rowSecurityHidesFrom: "mason" });
  const audit = table({ table: "audit", replicaIdentity: "n" });
  const hiddenLog = table({ table: "hidden_log", key: [], rowSecurityHidesFrom: "mason",
    uniqueKeys: [{ name: "hidden_log_id_key", columns: ["id"], constraint: true, nullsNotDistinct: false }] });
  const db = { tables: [...CATALOG, big, hidden, audit, hiddenLog], database: "shop" };
  const edit = (text: string) => { fs.writeFileSync(file, text); return E.sourceToEdit(folder, root, () => S.readSource(folder, root, {})); };
  const said = (f: () => unknown): string => { try { f(); } catch (e) { return (e as Error).message; } return "taken"; };
  try {
    for (const top of ["sync: poll 5m\n", "sync: replication\n", ""]) {
      const text = `kind: postgres\nurl: postgres://me@localhost/shop\n${top}tables:\n  customers: {}\n`;
      const listed = E.listTables(edit(text).parsed, db);
      for (const t of listed.filter((x) => !x.added)) {
        const key = t.entry === null ? null : Object.values(t.entry)[0]!.key ?? null;
        if (t.entry === null) {
          assert.match(said(() => E.addEntry(edit(text), db, t.table, ["*"], key)), /./, `${t.table}: mason add refuses it too`);
          assert.ok(t.reason !== null, `${t.table}: its reason said`);
          continue;
        }
        E.addEntry(edit(text), db, t.table, ["*"], key);
        const written = (parse(fs.readFileSync(file, "utf8")) as { tables: Record<string, unknown> }).tables;
        assert.deepEqual(written, { customers: {}, ...t.entry }, `${top.trim() || "no sync:"} — ${t.table}: the entry mason add wrote`);
      }
      const of = (name: string) => listed.find((t) => t.table === name)!;
      assert.deepEqual(of("public.customers").entry, { customers: {} }, "added: its entry as the file says it");
      // row-level security, said in a table's words (issue 802): no `tables.<entry>:`, no "remove its entry", the
      // mason add to run once a policy is there; mason add's refusal the same words
      const policy = (t: string) => `row-level security on public.${t} hides every row from mason (no SELECT policy for it, and it is not the owner or BYPASSRLS), ` +
        `so its synced table would be empty — the table's owner adds a policy for the rows Mason may read (CREATE POLICY mason_read ON public.${t} FOR SELECT TO "mason" USING (…);), `;
      assert.deepEqual([of("public.hidden").entry, of("public.hidden").reason], [null, `${policy("hidden")}then mason add hidden`],
        "a table row-level security hides: no entry, and its reason in mason add's words for a table");
      assert.equal(said(() => E.addEntry(edit(text), db, "public.hidden")), `public.hidden cannot be added: ${policy("hidden")}then mason add hidden`);
      assert.equal(of("public.hidden_log").reason,
        `${policy("hidden_log")}then mason add hidden_log --key id (no primary key: its unique index hidden_log_id_key tells its rows apart)`,
        "no primary key as well: one reason, the --key in its mason add");
      assert.equal(said(() => E.addEntry(edit(text), db, "public.hidden_log", ["*"], ["id"])), `public.hidden_log cannot be added: ${policy("hidden_log")}then mason add hidden_log --key id`);
      assert.equal(said(() => E.addEntry(edit(text), db, "public.hidden_log")), `public.hidden_log cannot be added: ${of("public.hidden_log").reason}`);
      // the run's state (the web page's Tables) says the same reason: one function, catalogTable's
      for (const name of ["public.hidden", "public.hidden_log"]) assert.equal(S.catalogTable(db.tables.find((t) => t.source === name)!, undefined).reason, of(name).reason, name);
      if (top === "sync: poll 5m\n") assert.deepEqual(of("public.events_big").entry, { events_big: { sync: "off" } }, "a big table under a polling file: written off");
      if (top === "sync: replication\n") {
        assert.deepEqual(of("public.audit").entry, { audit: { sync: "poll 5m" } }, "REPLICA IDENTITY NOTHING under a replicating file: polled");
        assert.deepEqual(of("public.events").entry, { events: { key: ["tenant_id", "id"], sync: "poll 5m" } }, "no primary key under a replicating file: keyed and polled");
      }
      assert.deepEqual(of("public.orders").columns.filter((c) => c.secret).map((c) => c.name), ["api_token"]);
    }
    // FAIL CLOSED: a key: the file gets wrong never un-flags a column that looks like a secret — one naming a column the
    // table lacks (with or without a primary key), and one naming the secret beside a primary key
    const logins = table({ table: "logins", key: [], columns: [col("id", "bigint", true), col("token")] });
    const wrong = `kind: postgres\nurl: postgres://me@localhost/shop\ntables:\n  orders:\n    key: [nosuch]\n  logins:\n    key: [nosuch]\n`;
    const flagged = (text: string, name: string): string[] => E.listTables(S.parseSourceText(text, "app", file) as Sources.SourceFile, { tables: [...CATALOG, logins], database: "shop" })
      .find((t) => t.table === name)!.columns.filter((c) => c.secret).map((c) => c.name);
    assert.deepEqual(flagged(wrong, "public.orders"), ["api_token"], "key: naming a column the table lacks, beside a primary key");
    assert.deepEqual(flagged(wrong, "public.logins"), ["token"], "key: naming a column the table lacks, no primary key");
    assert.deepEqual(flagged(wrong.replace("  orders:\n    key: [nosuch]", "  orders:\n    key: [api_token]"), "public.orders"), ["api_token"], "key: naming the secret beside a primary key");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the run's re-read keeps the tables read before when the file goes silent on sync: over a recorded slot, said with the line; any sync: is taken, and a run with no slot is untouched", () => {
  const entry = "kind: postgres\nurl: x\ntables:\n  orders: {}\n";
  const reading = (text: string) => ({ ...(parse(text) as Sources.SourceFile), resolved: "x", from: "mason/sources/app.yml", publicationName: null });
  const prev = { file: parse("kind: postgres\nurl: x\nsync: replication\ntables:\n  orders: {}\n") as Sources.SourceFile, tables: [], problem: null };
  const kept = S.rereadSources(prev, reading(entry), "x", CATALOG, "shop", "/app", { slot: "mason_dev_shop_app" });
  assert.equal(kept.file, prev.file, "the tables read before: the slot is not retired");
  assert.equal(kept.tables, prev.tables);
  assert.equal(kept.problem, "mason/sources/app.yml: no sync: at its top or on an entry, and this project streams through replication slot mason_dev_shop_app: " +
    "write sync: replication at its top to keep streaming, or sync: off or sync: poll <interval> to drop the slot");
  assert.match(kept.said!, /^the sources file cannot be read as it is now, so the tables read before are kept: /);
  for (const said of ["sync: off\n", "sync: poll 5m\n", "sync: replication\n"]) {
    assert.equal(S.rereadSources(prev, reading(`kind: postgres\nurl: x\n${said}tables:\n  orders: {}\n`), "x", CATALOG, "shop", "/app", { slot: "mason_dev_shop_app" }).problem, null, said);
  }
  assert.equal(S.rereadSources(prev, reading("kind: postgres\nurl: x\ntables: {}\n"), "x", CATALOG, "shop", "/app", { slot: "mason_dev_shop_app" }).problem, null, "no table left to stream");
  assert.equal(S.rereadSources(prev, reading(entry), "x", CATALOG, "shop", "/app", { slot: null }).problem, null, "no slot: a silent file is the default");
  assert.equal(S.rereadSources(prev, reading(entry), "x", CATALOG, "shop", "/app").problem, null);
});

test("the run's re-read keeps the tables read before when the file sets one to sync: replication the run never checked the database for, said with the way out", () => {
  const prev = { file: parse("kind: postgres\nurl: x\nsync: poll 5m\ntables:\n  orders: {}\n") as Sources.SourceFile, tables: [], problem: null };
  const now = { ...(parse("kind: postgres\nurl: x\nsync: poll 5m\ntables:\n  orders: { sync: replication }\n") as Sources.SourceFile), resolved: "x", from: "mason/sources/app.yml", publicationName: null } as unknown as Sources.ProjectSource;
  const kept = S.rereadSources(prev, now, "x", CATALOG, "shop", "/app", { replicationChecked: false });
  assert.equal(kept.file, prev.file, "the tables read before");
  assert.equal(kept.problem, "mason/sources/app.yml: orders is sync: replication, and this run has not checked shop for logical replication (no table was replicated when it started): " +
    "mason stop && mason start checks it and streams them");
  // checked (the start replicated a table, or the edit's check passed): taken
  assert.equal(S.rereadSources(prev, now, "x", CATALOG, "shop", "/app", { replicationChecked: true }).problem, null);
});

/**
 * A WAY OUT APPLIED AS WRITTEN (the review of PR 48): a retired setting's answer names the edit to make at the top of
 * the sources file, and that edit, made to a file `mason init` wrote (which has a `sync:` line already) as the words
 * say it, leaves a file the run reads, saying what was asked. "write sync: replication at the top" of such a file made
 * two sync: keys, a file the run refuses.
 */
test("every retired setting's way out, applied as written to a file mason init wrote, leaves a valid file saying what was asked", async () => {
  type Top = { shown: string; sync: string | null; publication: string | null };
  type Said = { message: string; why: string; fix: string } | null;
  const T = await import("../src/lib/table-sync.ts" as string) as Record<string, unknown>;
  const sourcesTop = (S as unknown as Record<string, unknown>).sourcesTop as ((root: string, folder: string) => Top) | undefined;
  assert.equal(typeof sourcesTop, "function", "src/cli/sources.ts reads the top of the file (sourcesTop)");
  const removed = T.removedStartFlags as (argv: string[], top: () => Top) => Said;
  const changes = T.changesRetired as (env: Record<string, string>, top: () => Top) => Said;
  const pollMs = T.pollMsRetired as (env: Record<string, string>, top: () => Top) => Said;
  // the edits a way out names, applied as a person or an agent would: change the line it names, write one beside the
  // others at the top, keep one; every value is the first one offered
  const VALUE = String.raw`(poll \S+?|[^\s,()]+)(?=[\s,()]|$)`;
  const apply = (text: string, fix: string): string => {
    let out = text;
    for (const m of fix.matchAll(new RegExp(String.raw`\bchange (sync|publication): .+? at the top of \S+ to (?:sync|publication): ${VALUE}`, "g"))) {
      assert.match(out, new RegExp(`^${m[1]}:`, "m"), `${fix}: the file has the line it says to change`);
      out = out.replace(new RegExp(`^${m[1]}:.*$`, "m"), `${m[1]}: ${m[2]}`);
    }
    // "write sync: replication and publication: app_pub at the top of …": each line it names, the first of any "or"
    for (const w of fix.matchAll(/\bwrite (.+?) at the top of /g)) {
      for (const part of w[1]!.split(" and ")) {
        const m = new RegExp(String.raw`^(sync|publication): ${VALUE}`).exec(part.split(" or ")[0]!);
        assert.ok(m, `${fix}: "${part}" is a line to write`);
        out = out.replace(/^(url:.*)$/m, `$1\n${m[1]}: ${m[2]}`);
      }
    }
    return out;
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mason-way-out-"));
  try {
    const folder = path.join(root, "mason");
    fs.mkdirSync(path.join(folder, "sources"), { recursive: true });
    const file = path.join(folder, "sources", "demo.yml");
    const files: Array<[string, string]> = [
      ["init's (sync: off)", S.newSourceText("${DATABASE_URL}", ["orders"])],
      ["init demo's (sync: poll 5s)", S.newSourceText("${DATABASE_URL}", ["orders"], (T.parseSync as (v: string) => never)("poll 5s"))],
      ["one naming its publication", S.newSourceText("${DATABASE_URL}", ["orders"]).replace(/^(sync:.*)$/m, "$1\npublication: their_pub")],
      ["one written by hand, with no sync:", "kind: postgres\nurl: ${DATABASE_URL}\ntables:\n  orders: {}\n"],
    ];
    for (const [what, text] of files) {
      fs.writeFileSync(file, text);
      const top = (): Top => sourcesTop!(root, folder);
      const cases: Array<[string, Said, { sync?: string; publication?: string }]> = [
        ["--replication", removed(["--replication"], top), { sync: "replication" }],
        ["--poll", removed(["--poll"], top), {}],
        ["--publication app_pub", removed(["--publication", "app_pub"], top), { publication: "app_pub" }],
        ["--replication --publication app_pub", removed(["--replication", "--publication", "app_pub"], top), { sync: "replication", publication: "app_pub" }],
        ["--poll --publication app_pub", removed(["--poll", "--publication", "app_pub"], top), { publication: "app_pub" }],
        ["--replication --poll", removed(["--replication", "--poll"], top), { sync: "replication" }],
        ["MASON_CHANGES=replication", changes({ MASON_CHANGES: "replication" }, top), { sync: "replication" }],
        ["MASON_CHANGES=poll", changes({ MASON_CHANGES: "poll" }, top), {}],
        ["MASON_POLL_MS=30000", pollMs({ MASON_POLL_MS: "30000" }, top), { sync: "poll 30s" }],
      ];
      for (const [given, said, want] of cases) {
        assert.ok(said !== null, `${what}, ${given}: answered`);
        assert.match(said.fix, /mason\/sources\/demo\.yml/, `${what}, ${given}: names the file`);
        const edited = apply(text, said.fix);
        const parsed = S.parseSourceText(edited, "demo", file);
        assert.ok(!("problems" in parsed), `${what}, ${given}: "${said.fix}" applied leaves ${JSON.stringify("problems" in parsed ? parsed.problems : [])}\n${edited}`);
        if (want.sync !== undefined) assert.equal(parsed.sync === null ? null : (T.syncText as (s: unknown) => string)(parsed.sync), want.sync, `${what}, ${given}: the top's sync`);
        if (given === "--poll" || given === "MASON_CHANGES=poll") assert.equal(parsed.sync?.mode, "poll", `${what}, ${given}: every table polled`);
        if (want.publication !== undefined) assert.deepEqual(parsed.publication, { literal: want.publication }, `${what}, ${given}: the publication`);
      }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a file whose values the YAML library refuses to expand (more aliases than it takes: a file built to exhaust memory) is a problem of the file, never a throw", () => {
  const text = `kind: postgres\nurl: \${DATABASE_URL}\ntables: {}\nx: &x 1\nl: [${Array(120).fill("*x").join(", ")}]\n`;
  assert.deepEqual(problems(text).map((p) => p.replace(/: .*$/, ":")), ["it cannot be read as values:"]);
  assert.match(problems(text)[0]!, /^it cannot be read as values: \S/);
});

// ------------------------------------------------------------------ columns that arrive while the run is up (issue 977)

test("leftOutArrivals: a secret-looking column new since the run's tables were set, of an every-column entry, is left out; a column chosen by an edit is not", () => {
  const file = parse("kind: postgres\nurl: ${DATABASE_URL}\ntables:\n  orders: {}\n  customers:\n    columns: [id, name]\n  events:\n    key: [tenant_id, id]\n    exclude: [raw_body]\n") as Sources.SourceFile;
  const now = [
    table({ table: "orders", columns: [...orders.columns, col("deploy_key_content"), col("passwordHash"), col("token_id"), col("note")] }),
    table({ table: "customers", columns: [col("id", "bigint", true), col("name"), col("password")] }),
    table({ table: "events", key: [], columns: [col("tenant_id", "bigint", true), col("id", "bigint", true), col("raw_body"), col("secret")] }),
  ];
  const before = new Map([["public.orders", orders.columns.map((c) => c.name)], ["public.customers", ["id", "name"]], ["public.events", ["tenant_id", "id", "raw_body"]]]);
  assert.deepEqual(S.leftOutArrivals(file, now, before).map((a) => [a.entry.table, a.columns, a.gone]), [
    // api_token was there before: the entry's {} took it, as the person left it; token_id names an identifier, note no secret
    ["public.orders", ["deploy_key_content", "passwordHash"], []],
    // a columns: entry syncs only what it names: nothing arrives in it
    ["public.events", ["secret"], []],
  ]);
  assert.deepEqual(S.leftOutArrivals(file, now, before, ["public.orders"]).map((a) => a.entry.table), ["public.events"], "an edit's own table is as the person chose it");
  assert.deepEqual(S.leftOutArrivals(file, now, new Map()), [], "a table new to the run is the person's entry");
});

test("leftOutArrivals fails closed on a name of exclude: gone while the run was up: every column that arrived with it is left out in its place; gone alone, it is taken out (issue 977)", () => {
  const file = parse("kind: postgres\nurl: ${DATABASE_URL}\ntables:\n  staff:\n    exclude: [salary]\n") as Sources.SourceFile;
  const before = new Map([["public.staff", ["id", "name", "salary"]]]);
  const staff = (...cols: string[]) => [table({ table: "staff", columns: [col("id", "bigint", true), ...cols.map((c) => col(c))] })];
  // RENAMED: salary → annual_pay, nothing in its name that looks like a secret — left out all the same
  const renamed = S.leftOutArrivals(file, staff("name", "annual_pay"), before);
  assert.deepEqual(renamed.map((a) => [a.columns, a.gone, S.excludeOf(a)]), [[["annual_pay"], ["salary"], ["annual_pay"]]]);
  assert.equal(S.leftOutText(renamed[0]!, "mason/sources/app.yml"),
    "public.staff: salary, which exclude: names, is gone from the database, and annual_pay arrived at the same time (a rename keeps its data), so it is not synced either. " +
    "Mason wrote exclude: [annual_pay] on its entry in mason/sources/app.yml. To sync it, run mason add staff --include annual_pay");
  // DROPPED: nothing arrived — taken out of exclude:
  const dropped = S.leftOutArrivals(file, staff("name"), before);
  assert.deepEqual(dropped.map((a) => [a.columns, a.gone, S.excludeOf(a)]), [[[], ["salary"], []]]);
  assert.equal(S.leftOutText(dropped[0]!, "mason/sources/app.yml"), "public.staff: salary, which exclude: names, is gone from the database. Mason wrote staff: {} as its entry in mason/sources/app.yml");
  // where the file cannot be written: left out for this run, the line to write said, and the start refuses until then
  assert.equal(S.leftOutText(renamed[0]!, null, "MASON_PROJECT_READONLY=1"),
    "public.staff: salary, which exclude: names, is gone from the database, and annual_pay arrived at the same time (a rename keeps its data), so it is not synced either, " +
    "in this run (MASON_PROJECT_READONLY=1). Write exclude: [annual_pay] on its entry in the sources file: a start refuses the file until then");
  const taken = S.withLeftOut(file, new Map([["public.staff", { left: ["annual_pay"], gone: ["salary"] }]]), staff("name", "annual_pay"));
  assert.deepEqual(taken.tables[0]!.exclude, ["annual_pay"]);
  const added = S.addedTables(taken, staff("name", "annual_pay"), "shop", "/app");
  assert.ok(Array.isArray(added), JSON.stringify(added));
  assert.deepEqual(added[0]!.columns.map((c) => c.name), ["id", "name"], "never annual_pay");
});

test("leftOutText says what was left out, where it is written and how to sync it; withLeftOut leaves it out of an every-column entry", () => {
  const file = parse("kind: postgres\nurl: ${DATABASE_URL}\ntables:\n  orders:\n    exclude: [api_token]\n  customers:\n    columns: [id, name]\n") as Sources.SourceFile;
  const a = { entry: file.tables[0]!, columns: ["deploy_key"], gone: [] };
  assert.equal(S.leftOutText(a, "mason/sources/app.yml"),
    "public.orders: the new column deploy_key looks like a secret, so it is not synced. Mason wrote exclude: [api_token, deploy_key] on its entry in mason/sources/app.yml. To sync it, run mason add orders --include deploy_key");
  assert.equal(S.leftOutText({ ...a, columns: ["deploy_key", "salt"] }, null, "MASON_PROJECT_READONLY=1"),
    "public.orders: the new columns deploy_key, salt look like secrets, so they are not synced, in this run (MASON_PROJECT_READONLY=1). " +
    "Write exclude: [api_token, deploy_key, salt] on its entry in the sources file: a start syncs what the file says");
  const left = S.withLeftOut(file, new Map([["public.orders", { left: ["deploy_key"], gone: [] }], ["public.customers", { left: ["password"], gone: [] }]]), CATALOG);
  assert.deepEqual(left.tables.map((e) => [e.table, e.columns, e.exclude]), [["public.orders", null, ["api_token", "deploy_key"]], ["public.customers", ["id", "name"], []]]);
});

/**
 * ONE LOOK OF A RUN THAT CANNOT WRITE ITS SOURCES FILE, as src/cli/dev.ts `added` makes it, on the run's own record
 * (`LeftOutRecord`): what arrived, each kept and said with its line (its ending as the file as it is decides it), and
 * the file as the run takes it — refused, or the tables it syncs.
 */
function readOnlyLook(file: Sources.SourceFile, record: Sources.LeftOutRecord, now: SourceTable[]) {
  const said = record.look(file, now).map((a) => {
    record.keep(a);
    const have = now.find((t) => t.source === a.entry.table)?.columns.map((c) => c.name) ?? [];
    const refused = file.tables.find((e) => e.table === a.entry.table)!.exclude.some((c) => !have.includes(c));
    return { a, line: S.excludeOf(a), text: S.leftOutText(a, null, "MASON_PROJECT_READONLY=1", refused) };
  });
  return { said, tables: S.addedTables(record.taken(file, now), now, "shop", "/app") };
}
const syncedOf = (tables: ReturnType<typeof S.addedTables>, source: string): string[] => {
  assert.ok(Array.isArray(tables), `the file as the run takes it is refused: ${JSON.stringify(tables)}`);
  return tables.find((t) => t.source === source)!.columns.map((c) => c.name);
};
/** An entry's lines as the line said tells a person to write them: the text a start reads, never a parsed entry. */
function entryAsSaid(name: string, said: string): string {
  const list = /Write (exclude: \[[^\]]*\]) on its entry/.exec(said);
  if (list) return `  ${name}:\n    ${list[1]}\n`;
  const empty = /Write (\S+: \{\}) as its entry/.exec(said);
  assert.ok(empty, `no line to write in: ${said}`);
  return `  ${empty[1]}\n`;
}

test("issue 1026: in a run that cannot write its sources file, a second rename of an excluded column is left out in its place, the line to write is the whole exclude: now, and every other table's changes are still taken", () => {
  const file = parse("kind: postgres\nurl: ${DATABASE_URL}\ntables:\n  t:\n    exclude: [salary]\n  t2: {}\n") as Sources.SourceFile;
  const t = (...cols: string[]) => table({ table: "t", columns: [col("id", "bigint", true), ...cols.map((c) => col(c))] });
  const t2 = (...cols: string[]) => table({ table: "t2", columns: [col("id", "bigint", true), ...cols.map((c) => col(c))] });
  const record = new S.LeftOutRecord([t("a", "salary"), t2("v", "w")]);

  const first = readOnlyLook(file, record, [t("a", "annual_pay"), t2("v", "w")]);
  assert.deepEqual(syncedOf(first.tables, "public.t"), ["id", "a"]);
  assert.deepEqual(first.said.map((x) => x.line), [["annual_pay"]]);
  // THE SECOND RENAME: annual_pay, which the file never named, is the name gone; pay3 is left out in its place
  const second = readOnlyLook(file, record, [t("a", "pay3"), t2("v", "w")]);
  assert.deepEqual(syncedOf(second.tables, "public.t"), ["id", "a"], "never pay3");
  assert.equal(second.said.length, 1);
  assert.equal(second.said[0]!.text,
    "public.t: annual_pay, which exclude: names, is gone from the database, and pay3 arrived at the same time (a rename keeps its data), so it is not synced either, " +
    "in this run (MASON_PROJECT_READONLY=1). Write exclude: [pay3] on its entry in the sources file: a start refuses the file until then");
  // the other table's changes are still taken: a column added, then one renamed
  assert.deepEqual(syncedOf(readOnlyLook(file, record, [t("a", "pay3"), t2("v", "w", "y")]).tables, "public.t2"), ["id", "v", "w", "y"]);
  assert.deepEqual(syncedOf(readOnlyLook(file, record, [t("a", "pay3"), t2("v", "w2", "y")]).tables, "public.t2"), ["id", "v", "w2", "y"]);
  // a third rename, and the line written: a start reads the file as the run took it
  const third = readOnlyLook(file, record, [t("a", "pay4"), t2("v", "w2", "y")]);
  assert.deepEqual(syncedOf(third.tables, "public.t"), ["id", "a"]);
  const written = parse(`kind: postgres\nurl: \${DATABASE_URL}\ntables:\n${entryAsSaid("t", third.said[0]!.text)}  t2: {}\n`) as Sources.SourceFile;
  assert.deepEqual(syncedOf(S.addedTables(written, [t("a", "pay4"), t2("v", "w2", "y")], "shop", "/app"), "public.t"), ["id", "a"]);
});

test("the review of PR 1065: the file refused for another reason while an excluded column is renamed twice — once that is fixed, the file as the run takes it names the column now, the line says it, and every later change is taken", () => {
  const text = (t3: string, t1 = "  t1:\n    exclude: [salary]\n") => `kind: postgres\nurl: \${DATABASE_URL}\ntables:\n${t1}  t2: {}\n  t3:\n    columns: [id, ${t3}]\n`;
  const file = parse(text("amount_total")) as Sources.SourceFile;
  const t1 = (c: string) => table({ table: "t1", columns: [col("id", "bigint", true), col("a"), col(c)] });
  const t2 = (...cols: string[]) => table({ table: "t2", columns: [col("id", "bigint", true), ...cols.map((c) => col(c))] });
  const t3 = table({ table: "t3", columns: [col("id", "bigint", true), col("amount_total2")] });
  const record = new S.LeftOutRecord([t1("salary"), t2("v"), table({ table: "t3", columns: [col("id", "bigint", true), col("amount_total")] })]);
  // t3's listed column renamed to a close name: the file is refused, for t3 alone
  const refusedFor = (r: ReturnType<typeof readOnlyLook>): string => JSON.stringify(r.tables).match(/tables\.t\d/g)!.join(",");
  assert.equal(refusedFor(readOnlyLook(file, record, [t1("salary"), t2("v"), t3])), "tables.t3");
  const p1 = readOnlyLook(file, record, [t1("p1"), t2("v"), t3]);
  assert.equal(refusedFor(p1), "tables.t3");
  assert.deepEqual(p1.said.map((x) => x.line), [["p1"]]);
  const p2 = readOnlyLook(file, record, [t1("p2"), t2("v"), t3]);
  assert.equal(refusedFor(p2), "tables.t3", "never t1: p1 is the name gone");
  assert.deepEqual(p2.said.map((x) => x.line), [["p2"]]);
  // t3 fixed by hand, then t2's changes, then the run's own line written on t1 too
  const fixed = parse(text("amount_total2")) as Sources.SourceFile;
  const y = readOnlyLook(fixed, record, [t1("p2"), t2("v", "y"), t3]);
  assert.deepEqual(syncedOf(y.tables, "public.t1"), ["id", "a"]);
  assert.deepEqual(syncedOf(y.tables, "public.t2"), ["id", "v", "y"]);
  const both = parse(text("amount_total2", entryAsSaid("t1", p2.said[0]!.text))) as Sources.SourceFile;
  assert.deepEqual(syncedOf(readOnlyLook(both, record, [t1("p2"), t2("v", "y", "y2"), t3]).tables, "public.t2"), ["id", "v", "y", "y2"]);
  const v2 = readOnlyLook(both, record, [t1("p2"), t2("v2", "y", "y2"), t3]);
  assert.deepEqual(syncedOf(v2.tables, "public.t2"), ["id", "v2", "y", "y2"]);
  assert.deepEqual(syncedOf(v2.tables, "public.t1"), ["id", "a"]);
});

test("keptBack: a name of exclude: the run took out as gone, back on the table, is left out again as the file says, and said with the line that names it", () => {
  const file = parse("kind: postgres\nurl: ${DATABASE_URL}\ntables:\n  t:\n    exclude: [salary]\n") as Sources.SourceFile;
  const t = (...cols: string[]) => [table({ table: "t", columns: [col("id", "bigint", true), ...cols.map((c) => col(c))] })];
  const record = new S.LeftOutRecord(t("a", "salary"));
  const dropped = readOnlyLook(file, record, t("a"));
  assert.deepEqual(dropped.said.map((x) => x.text), ["public.t: salary, which exclude: names, is gone from the database, in this run (MASON_PROJECT_READONLY=1). " +
    "Write t: {} as its entry in the sources file: a start refuses the file until then"]);
  assert.deepEqual(syncedOf(dropped.tables, "public.t"), ["id", "a"]);
  // the line, written as the text a start reads, is taken
  const asSaid = parse(`kind: postgres\nurl: \${DATABASE_URL}\ntables:\n${entryAsSaid("t", dropped.said[0]!.text)}`) as Sources.SourceFile;
  assert.deepEqual(syncedOf(S.addedTables(asSaid, t("a"), "shop", "/app"), "public.t"), ["id", "a"]);
  const back = readOnlyLook(file, record, t("a", "salary"));
  assert.deepEqual(syncedOf(back.tables, "public.t"), ["id", "a"], "never the salary added back");
  assert.deepEqual(back.said.map((x) => x.text), ["public.t: salary, which exclude: names, is back on the database, so it is not synced, in this run (MASON_PROJECT_READONLY=1). " +
    "Write exclude: [salary] on its entry in the sources file: a start syncs what the file says"]);
  assert.deepEqual(readOnlyLook(file, record, t("a", "salary")).said, [], "said once");
});

test("writeLine: the line that writes an exclude: is the list; with nothing left out, the entry {} — or exclude: taken out beside its other keys — never exclude: [], which a start refuses", () => {
  const file = parse("kind: postgres\nurl: ${DATABASE_URL}\ntables:\n  t:\n    exclude: [salary]\n  billing.invoices:\n    exclude: [salary]\n    sync: poll 1m\n") as Sources.SourceFile;
  const [t, inv] = file.tables as [Sources.TableEntry, Sources.TableEntry];
  assert.deepEqual(S.writeLine(t, ["pay"]), { ask: "Write exclude: [pay] on its entry", wrote: "wrote exclude: [pay] on its entry" });
  assert.deepEqual(S.writeLine(t, []), { ask: "Write t: {} as its entry", wrote: "wrote t: {} as its entry" });
  assert.deepEqual(S.writeLine(inv, []), { ask: "Take exclude: out of its entry", wrote: "took exclude: out of its entry" });
  assert.ok("problems" in parse("kind: postgres\nurl: ${DATABASE_URL}\ntables:\n  t:\n    exclude: []\n"), "a start refuses exclude: []");
  assert.ok(!("problems" in parse("kind: postgres\nurl: ${DATABASE_URL}\ntables:\n  t: {}\n  billing.invoices:\n    sync: poll 1m\n")), "each line, written, is read");
});

test("issue 1026: any sequence of renames, adds and drops, of excluded and synced columns, across several tables, in a run that cannot write its sources file, with the file refused for another reason and fixed between: an excluded column never synced, refused only for that reason, every other change taken, and the lines said, written as text, read by a start the same", () => {
  const fileText = (t3: string) => `kind: postgres\nurl: \${DATABASE_URL}\ntables:\n  t1:\n    exclude: [salary]\n  t2: {}\n  t3:\n    columns: [id, ${t3}]\n  t4:\n    exclude: [secret_note, ssn]\n`;
  const excludeOfFile = new Map([["public.t1", ["salary"]], ["public.t2", []], ["public.t4", ["secret_note", "ssn"]]]);
  interface Col { name: string; out: boolean }
  for (let seed = 1; seed <= 40; seed++) {
    let r = (seed * 2654435761) % 4294967296;
    const rand = (n: number): number => { r = (r * 1664525 + 1013904223) % 4294967296; return Math.floor((r / 4294967296) * n); };
    // the model: each table's columns in order, each carried through its renames with whether it is left out; t3's entry
    // lists amount_total, whatever its column is called now: renamed to a close name, the file is refused until fixed
    const model = new Map<string, Col[]>([
      ["public.t1", [{ name: "a", out: false }, { name: "salary", out: true }, { name: "b", out: false }]],
      ["public.t2", [{ name: "v", out: false }, { name: "w", out: false }]],
      ["public.t3", [{ name: "amount_total", out: false }, { name: "y", out: false }]],
      ["public.t4", [{ name: "note", out: false }, { name: "secret_note", out: true }, { name: "ssn", out: true }]],
    ]);
    let listed = "amount_total";
    const used = new Map([...model].map(([k, cs]) => [k, cs.map((c) => c.name)]));
    const catalog = (): SourceTable[] => [...model].map(([k, cs]) => table({ table: k.slice(7), columns: [col("id", "bigint", true), ...cs.map((c) => col(c.name))] }));
    const record = new S.LeftOutRecord(catalog());
    const lines = new Map<string, string>();
    let fresh = 0, refusals = 0, fixes = 0;
    const history: string[] = [];
    for (let round = 0; round < 60; round++) {
      const start = new Map([...model].map(([k, cs]) => [k, cs.map((c) => c.name)]));
      const wasOut = new Map([...model].map(([k, cs]) => [k, new Set(cs.filter((x) => x.out).map((x) => x.name))]));
      const changed = new Map<string, { gone: string[]; arrived: Col[] }>();
      const taken = new Set<string>();
      const t3 = model.get("public.t3")!.find((x) => x.name.startsWith("amount_total"));
      if (t3 !== undefined && t3.name === listed && rand(6) === 0) {
        // THE FILE REFUSED FOR ANOTHER REASON: t3's listed column renamed to a close name
        t3.name = `amount_total${fresh++}`;
        history.push(`t3 rename ${listed} to ${t3.name} (the file refused)`);
        refusals++;
      } else if (t3 !== undefined && t3.name !== listed && rand(3) === 0) {
        // FIXED BY HAND: the entry lists the column's name now
        listed = t3.name;
        history.push(`t3 fixed in the file: columns: [id, ${listed}]`);
        fixes++;
      } else {
        // one or two changes on the database before the run looks, on one table or two (t3's listed column left alone)
        for (let n = 1 + rand(2); n > 0; n--) {
          const k = [...model.keys()][rand(model.size)]!, cs = model.get(k)!;
          const c = changed.get(k) ?? { gone: [], arrived: [] };
          changed.set(k, c);
          const absent = used.get(k)!.filter((x) => !start.get(k)!.includes(x) && !taken.has(x) && !cs.some((y) => y.name === x) && !x.startsWith("amount_total"));
          const newName = (): string => {
            const name = absent.length && rand(3) === 0 ? absent[rand(absent.length)]! : rand(3) === 0 ? `api_token_${fresh++}` : `col_${fresh++}_q`;
            taken.add(name);
            used.get(k)!.push(name);
            return name;
          };
          const free = cs.filter((x) => !taken.has(x.name) && !x.name.startsWith("amount_total"));
          const op = free.length === 0 ? 1 : rand(3);
          if (op === 0) {
            const x = free[rand(free.length)]!, old = x.name;
            c.gone.push(old);
            x.name = newName();
            c.arrived.push(x);
            history.push(`${k} rename ${old} to ${x.name}`);
          } else if (op === 1) {
            const x = { name: newName(), out: false };
            cs.push(x);
            c.arrived.push(x);
            history.push(`${k} add ${x.name}`);
          } else {
            const x = free[rand(free.length)]!;
            cs.splice(cs.indexOf(x), 1);
            c.gone.push(x.name);
            history.push(`${k} drop ${x.name}`);
          }
        }
      }
      // in an every-column entry, a column that arrived is left out when it looks like a secret, when the file's exclude:
      // names it, or when a column left out went in the same look (a rename, or a drop and an add, cannot be told apart:
      // fail closed); a renamed column left out stays out
      for (const [k, c] of changed) {
        if (k === "public.t3") continue;
        const wentOut = c.gone.some((g) => wasOut.get(k)!.has(g));
        for (const x of c.arrived) x.out = x.out || wentOut || S.looksSecret(x.name) || excludeOfFile.get(k)!.includes(x.name);
      }
      const file = parse(fileText(listed)) as Sources.SourceFile;
      const now = catalog();
      const res = readOnlyLook(file, record, now);
      const at = `seed ${seed}, round ${round}: ${history.slice(-4).join("; ")}`;
      const t3Now = model.get("public.t3")!.find((x) => x.name.startsWith("amount_total"));
      const refusedNow = t3Now !== undefined && t3Now.name !== listed;
      if (refusedNow) {
        // refused for t3 alone, never for what the run left out
        assert.ok(!Array.isArray(res.tables), `${at}: not refused`);
        assert.deepEqual(JSON.stringify(res.tables).match(/tables\.t\d/g), ["tables.t3"], `${at}: ${JSON.stringify(res.tables)}`);
      } else {
        assert.ok(Array.isArray(res.tables), `${at}: refused: ${JSON.stringify(res.tables)}`);
        for (const [k, cs] of model) {
          const want = ["id", ...cs.filter((x) => k === "public.t3" ? x.name === listed : !x.out).map((x) => x.name)];
          assert.deepEqual(syncedOf(res.tables, k), want, `${at}: ${k}`);
        }
      }
      for (const s of res.said) {
        lines.set(s.a.entry.table, s.text);
        // what the line says a start does with the file as it is: refuses it, for this entry, exactly when it would
        const p = S.addedTables(file, now, "shop", "/app");
        const fileRefused = !Array.isArray(p) && new RegExp(`tables\\.${s.a.entry.table.slice(7)}\\.exclude`).test(JSON.stringify(p));
        assert.equal(/a start refuses the file until then$/.test(s.text), fileRefused, `${at}: ${s.text}`);
      }
      if (!refusedNow) {
        // the lines said, written as a person writes them: a start, which keeps out only what the file says, syncs what
        // the run syncs
        const entry = (k: string, text: string): string => lines.has(`public.${k}`) ? entryAsSaid(k, lines.get(`public.${k}`)!) : text;
        const asSaid = parse(`kind: postgres\nurl: \${DATABASE_URL}\ntables:\n${entry("t1", "  t1:\n    exclude: [salary]\n")}${entry("t2", "  t2: {}\n")}` +
          `  t3:\n    columns: [id, ${listed}]\n${entry("t4", "  t4:\n    exclude: [secret_note, ssn]\n")}`);
        assert.ok(!("problems" in asSaid), `${at}: the lines said, written, are refused: ${JSON.stringify(asSaid)}`);
        const started = S.addedTables(asSaid as Sources.SourceFile, now, "shop", "/app");
        for (const k of model.keys()) assert.deepEqual(syncedOf(started, k), syncedOf(res.tables, k), `${at}: ${k} once the lines said are written`);
      }
    }
    assert.ok(refusals > 0 && fixes > 0, `seed ${seed}: the file was refused ${refusals} times and fixed ${fixes} times`);
  }
});

test("a column the database dropped that an entry's columns: names is passed over and said; a name of exclude: the table lacks is refused, fail closed, with the way out (issue 977)", () => {
  const file = parse("kind: postgres\nurl: ${DATABASE_URL}\ntables:\n  orders:\n    exclude: [api_token]\n  customers:\n    columns: [id, name, nickname]\n") as Sources.SourceFile;
  const added = S.addedTables(file, CATALOG, "shop", "/app");
  assert.ok(Array.isArray(added), JSON.stringify(added));
  assert.deepEqual(added.map((t) => [t.source, t.columns.map((c) => c.name)]),
    [["public.orders", ["id", "customer_id", "status", "amount", "payload"]], ["public.customers", ["id", "name"]]], "synced with the columns it has");
  assert.deepEqual(S.goneNotes(file, CATALOG, "/app"), [
    "mason/sources/app.yml: tables.customers.columns: public.customers no longer has nickname, so it is not synced. Take it out of columns:",
  ]);
  // EXCLUDE: a name the table lacks never lets a column through — far from every column (a rename's old name, a typo
  // such as salaries or date_of_birth) or near one
  for (const name of ["old_secret", "api_tokn"]) {
    const refused = S.addedTables(parse(`kind: postgres\nurl: \${DATABASE_URL}\ntables:\n  orders:\n    exclude: [${name}]\n`) as Sources.SourceFile, CATALOG, "shop", "/app");
    assert.ok(!Array.isArray(refused), name);
    assert.match(JSON.stringify(refused), new RegExp(`tables\\.orders\\.exclude: public\\.orders has no column ${name}.* — if it was renamed on the database, write its new name in exclude:; if it was dropped, take it out of exclude:`));
  }
  assert.deepEqual(S.goneColumns(customers, { columns: ["id", "nme"] }), { columns: [] }, "a near name is never passed over");
});

test("names the synced data holds as one: columns or tables whose names differ only in ASCII case are refused at the start, at mason add and in mason tables, by name and with the line that syncs the rest (issue 1019)", async () => {
  const E = await import("../src/cli/source-edit.ts" as string) as typeof import("../src/cli/source-edit.ts");
  const cased = table({ table: "t", columns: [col("id", "bigint", true), col("U", "integer"), col("u", "integer"), col("note")] });
  const three = table({ table: "three", columns: [col("id", "bigint", true), col("Status"), col("status"), col("STATUS")] });
  const keyed = table({ table: "keyed", key: ["K", "k"], columns: [col("K", "bigint", true), col("k", "bigint", true)] });
  const keyClash = table({ table: "keyclash", key: ["ID"], columns: [col("ID", "bigint", true), col("id", "bigint")] });
  const accents = table({ table: "accents", columns: [col("id", "bigint", true), col("É"), col("é")] });
  const upper = table({ table: "Orders", columns: [col("id", "bigint", true), col("a")] });
  const db = [...CATALOG, cased, three, keyed, keyClash, accents, upper];
  const start = (entries: string): Failure | Sources_AddedTable[] => S.addedTables(parse(`kind: postgres\nurl: x\ntables:\n${entries}`) as Sources.SourceFile, db, "shop", "/app");
  const why = (entries: string): string => { const r = start(entries); assert.ok(!Array.isArray(r), entries); return `${(r as Failure).message}\n${(r as Failure).why ?? ""}`; };

  // AT THE START: each way out in the file's own words, at the entry's key
  assert.match(why("  t: {}\n"), /tables\.t: public\.t has columns U and u, whose names differ only in case\. The synced data cannot hold them all\. Leave one out: exclude: \[u\]/);
  assert.match(why("  t: { exclude: [note] }\n"), /Leave one out: exclude: \[note, u\]/);
  assert.match(why("  t: { columns: [id, U, u] }\n"), /tables\.t\.columns: public\.t has columns U and u, whose names differ only in case\. The synced data cannot hold them all\. Take u out of columns:/);
  assert.match(why("  three: {}\n"), /public\.three has columns Status, status and STATUS, whose names differ only in case\. The synced data cannot hold them all\. Leave all but one out: exclude: \[status, STATUS\]/);
  assert.match(why("  keyed: {}\n"), /tables\.keyed: public\.keyed has columns K and k, whose names differ only in case\. The synced data cannot hold them all, and they are its key, so Mason cannot sync this table\. Remove its entry/);
  // the key is always synced, so the other column is the one to leave out
  assert.match(why("  keyclash: {}\n"), /Leave one out: exclude: \[id\]/);
  // the ways out it names are taken; one column of the pair, or neither, is fine
  for (const ok of ["  t: { exclude: [u] }\n", "  t: { columns: [id, U] }\n", "  t: { columns: [id, note] }\n", "  three: { exclude: [status, STATUS] }\n", "  keyclash: { exclude: [id] }\n"]) {
    assert.ok(Array.isArray(start(ok)), `${ok}: ${JSON.stringify(start(ok))}`);
  }
  assert.deepEqual((start("  t: { exclude: [u] }\n") as Sources_AddedTable[])[0]!.columns.map((c) => c.name), ["id", "U", "note"]);
  // a letter outside ASCII keeps its case in the synced data: É and é are two names there, as in Postgres
  assert.deepEqual((start("  accents: {}\n") as Sources_AddedTable[])[0]!.columns.map((c) => c.name), ["id", "É", "é"]);
  // two tables whose names differ only in case: the second entry is refused, naming the first
  assert.match(why('  orders: {}\n  "Orders": {}\n'), /tables\.Orders: public\.Orders and public\.orders \(tables\.orders\) have names that differ only in case\. The synced data cannot hold both\. Remove one of the two entries/);
  assert.ok(Array.isArray(start('  "Orders": {}\n')), "alone it syncs");
  // and two schemas so
  const billing = table({ schema: "Billing", table: "invoices" });
  const schemas = S.addedTables(parse('kind: postgres\nurl: x\ntables:\n  billing.invoices: {}\n  "Billing.invoices": {}\n') as Sources.SourceFile, [...db, billing], "shop", "/app") as Failure;
  assert.match(schemas.message, /tables\.Billing\.invoices: Billing\.invoices and billing\.invoices \(tables\.billing\.invoices\) have names that differ only in case/);

  // AT MASON ADD: in the command's words, the --columns that syncs the rest, and nothing written
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mason-add-case-"));
  const folder = path.join(root, "mason");
  fs.mkdirSync(path.join(folder, "sources"), { recursive: true });
  const file = path.join(folder, "sources", "app.yml");
  const edit = (text: string) => { fs.writeFileSync(file, text); return E.sourceToEdit(folder, root, () => S.readSource(folder, root, {})); };
  const said = (f: () => unknown): string => { try { f(); } catch (e) { return (e as Error).message; } return "taken"; };
  const top = "kind: postgres\nurl: postgres://me@localhost/shop\ntables:\n  orders: {}\n";
  const cat = { tables: db, database: "shop" };
  const tRefusal = "public.t cannot be added: its columns U and u have names that differ only in case. The synced data cannot hold them all. mason add t --columns id,U,note syncs the others, without u";
  try {
    assert.equal(said(() => E.addEntry(edit(top), cat, "public.t")), tRefusal);
    assert.equal(fs.readFileSync(file, "utf8"), top, "nothing written");
    assert.equal(said(() => E.addEntry(edit(top), cat, "public.t", ["id", "U", "u"])),
      "public.t cannot be added: its columns U and u have names that differ only in case. The synced data cannot hold them all. mason add t --columns id,U syncs the others, without u");
    assert.equal(said(() => E.addEntry(edit(top), cat, "public.keyed")),
      "public.keyed cannot be added: its key columns K and k have names that differ only in case. The synced data cannot hold them all, so Mason cannot sync it");
    assert.equal(said(() => E.addEntry(edit(top), cat, "public.Orders")),
      "public.Orders cannot be added: its name differs from public.orders only in case, and the file syncs public.orders already (tables.orders). The synced data cannot hold both. mason remove orders first to sync public.Orders instead");
    assert.equal(fs.readFileSync(file, "utf8"), top, "nothing written");
    // MASON TABLES says the same refusal as the table's reason, and offers no entry; so does the run's state, which the
    // web page reads (`catalogTable`), so the page never offers an Add the run refuses (issue 802)
    const listed = E.listTables(edit(top).parsed, cat);
    const of = (name: string) => listed.find((x) => x.table === name)!;
    const tReason = tRefusal.replace("public.t cannot be added: ", "");
    assert.deepEqual([of("public.t").entry, of("public.t").reason], [null, tReason]);
    assert.equal(S.catalogTable(cased, undefined).reason, tReason);
    assert.equal(S.catalogTable(keyed, undefined).reason, "its key columns K and k have names that differ only in case. The synced data cannot hold them all, so Mason cannot sync it");
    assert.equal(S.catalogTable(accents, undefined).reason, null);
    assert.equal(S.catalogTable(cased, { name: "t", table: "public.t", columns: null, exclude: ["u"], key: null, sync: null }).reason, null, "added: the file's entry says it");
    assert.match(of("public.Orders").reason ?? "", /differs from public\.orders only in case/);
    assert.equal(of("public.accents").reason, null);
    // the line it names is taken, and É and é are every column
    assert.deepEqual(E.addEntry(edit(top), cat, "public.t", ["id", "U", "note"]).columns, ["id", "U", "note"]);
    assert.equal(E.addEntry(edit(top), cat, "public.accents").columns, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ISSUE 1143: AN ENTRY NAMES ITS TABLE'S FOREIGN KEYS (`references:`), from the side that holds them. One column is
// `customer_id: customers.id`; several are written as SQL's FOREIGN KEY … REFERENCES writes them. `mason add` writes the
// ones the database declares, on whichever entry holds them; validation at load names the file and the key.
const tenants = table({ table: "tenants" });
const accounts = table({ table: "accounts", key: ["tenant_id", "id"], columns: [col("tenant_id", "bigint", true), col("id", "bigint", true), col("name"), col("email")],
  references: [{ columns: ["tenant_id"], target: "public.tenants", targetColumns: ["id"] }] });
const invoices2 = table({ table: "invoices", columns: [col("id", "bigint", true), col("tenant_id", "bigint"), col("account_id", "bigint"), col("customer_id", "bigint"), col("total", "numeric")],
  references: [{ columns: ["tenant_id", "account_id"], target: "public.accounts", targetColumns: ["tenant_id", "id"] },
    { columns: ["customer_id"], target: "public.customers", targetColumns: ["id"] }, { columns: ["tenant_id"], target: "public.tenants", targetColumns: ["id"] }] });
const REFS_CATALOG = [orders, customers, tenants, accounts, invoices2];
const HEAD = "kind: postgres\nurl: postgres://me@localhost/shop\n";

test("references: one column as customer_id: customers.id, several as SQL's (a, b): table (c, d), read from the file as written (issue 1143)", () => {
  const f = parse(`${HEAD}tables:
  orders:
    references:
      customer_id: customers.id     # the customer who placed it
  invoices:
    references:
      (tenant_id, account_id): accounts (tenant_id, id)
      "customer_id": billing.customers.id
  accounts:
    references: {}
`) as Sources.SourceFile;
  assert.deepEqual(f.tables.map((e) => [e.name, e.references]), [
    ["orders", [{ columns: ["customer_id"], to: "customers", table: "public.customers", targetColumns: ["id"] }]],
    ["invoices", [{ columns: ["tenant_id", "account_id"], to: "accounts", table: "public.accounts", targetColumns: ["tenant_id", "id"] },
      { columns: ["customer_id"], to: "billing.customers", table: "billing.customers", targetColumns: ["id"] }]],
    ["accounts", undefined],
  ]);
  // what the writer writes is what the reader reads: the same entry back
  const e = f.tables[1]!;
  const back = parse(`${HEAD}tables:\n${S.entryText(e, "  ")}`) as Sources.SourceFile;
  assert.deepEqual(back.tables[0], e);
  assert.equal(S.entryText(e, "  "), "  invoices:\n    references:\n      (tenant_id, account_id): accounts (tenant_id, id)\n      customer_id: billing.customers.id\n");
});

test("references: every mistake in its spelling at its key, with the line to write (issue 1143)", () => {
  const way = "write customer_id: customers.id (the table it references, a dot, and that table's column), or (tenant_id, customer_id): customers (tenant_id, id) for a foreign key of several columns";
  assert.deepEqual(problems(`${HEAD}tables:
  a:
    references: [customer_id]
  b:
    references:
      customer_id: customers
      account_id:
      x_id: 3
      (tenant_id): tenants.id
      (tenant_id, ): tenants.id
      (a, a): t (x, y)
      (c, d): t (x)
      e: t (x)
      f: one.two.three.x
      (g, h): t (x, x)
`), [
    `tables.a.references: is one line per foreign key, like references: { customer_id: customers.id } — ${way}`,
    `tables.b.references.customer_id: customers names no table and column — ${way}`,
    `tables.b.references.account_id: names no table — ${way}`,
    `tables.b.references.x_id: 3 is read by YAML as a number, not a name — ${way}`,
    "tables.b.references.(tenant_id): is one column: write it without the parentheses, tenant_id: …",
    `tables.b.references.(tenant_id, ): is a list of column names in parentheses, like (tenant_id, customer_id) — ${way}`,
    "tables.b.references.(a, a): names a twice",
    "tables.b.references.(c, d): names 2 columns of this table and 1 of t — a foreign key's columns pair up, one for one",
    "tables.b.references.e: is one column: write e: t.x",
    "tables.b.references.f: one.two.three has 3 parts, and a table is schema.table (billing.invoices) or its name alone in public (orders): this project has one source, so a table's name has at most two",
    "tables.b.references.(g, h): names t.x twice",
  ]);
  assert.deepEqual(problems(`${HEAD}tables:\n  orders:\n    refrences: {}\n`), ["tables.orders: unexpected key refrences — did you mean `references`? — a table takes columns, exclude, key, sync and references"]);
});

test("references: held to the database and the file at load, each at its key with the way out — a column either side lacks or does not sync, a table the file does not sync (issue 1143)", () => {
  const failed = (text: string): string[] => {
    const r = S.addedTables(parse(`${HEAD}${text}`) as Sources.SourceFile, REFS_CATALOG, "shop", "/app");
    return Array.isArray(r) ? [] : (r.why ?? r.message).split("\n").map((l) => l.replace(/^- |^mason\/sources\/app\.yml: /, ""));
  };
  assert.deepEqual(failed("tables:\n  orders:\n    references:\n      customer_id: customers.id\n  customers: {}\n"), [], "a reference that holds");
  assert.deepEqual(failed(`tables:
  orders:
    columns: [id, status]
    references:
      customer_id: customer.id
      custmer_id: customers.id
  customers: {}
  invoices:
    exclude: [account_id]
    references:
      (tenant_id, account_id): accounts (tenant_id, id)
      customer_id: customers.idd
  accounts:
    columns: [name]
    references:
      tenant_id: tenants.id
      email: customers.name
`), [
    "tables.orders.references.customer_id: customer_id is not synced (its columns: leaves it out) — sync it, or take this reference out",
    "tables.orders.references.customer_id: public.customer is not in this file — did you mean `customers`? — mason add customer syncs it, or take this reference out",
    "tables.orders.references.custmer_id: public.orders has no column custmer_id — did you mean `customer_id`? (its columns: id, customer_id, status, amount, api_token, payload)",
    "tables.invoices.references.(tenant_id, account_id): account_id is not synced (its exclude: names it) — sync it, or take this reference out",
    "tables.invoices.references.customer_id: public.customers has no column idd — did you mean `id`? (its columns: id, name)",
    "tables.accounts.references.tenant_id: public.tenants is not in this file — mason add tenants syncs it, or take this reference out",
    "tables.accounts.references.email: email is not synced (its columns: leaves it out) — sync it, or take this reference out",
  ]);
  // the referenced side's column, left out there
  assert.deepEqual(failed("tables:\n  orders:\n    references:\n      status: customers.name\n  customers:\n    exclude: [name]\n"),
    ["tables.orders.references.status: public.customers.name is not synced (tables.customers: exclude: names it) — sync it there, or take this reference out"]);
  // a reference never decides what is synced: the run's tables are the same with it or without it, the reference
  // carried beside them (src/duck/reference-keys.ts numbers its keys)
  const plain = S.addedTables(parse(`${HEAD}tables:\n  orders: {}\n  customers: {}\n`) as Sources.SourceFile, REFS_CATALOG, "shop", "/app");
  const withRefs = S.addedTables(parse(`${HEAD}tables:\n  orders:\n    references:\n      status: customers.name\n  customers: {}\n`) as Sources.SourceFile, REFS_CATALOG, "shop", "/app");
  assert.ok(Array.isArray(withRefs) && Array.isArray(plain));
  assert.deepEqual(withRefs.map(({ fileReferences: _, ...t }) => t), plain);
  assert.deepEqual(withRefs.map((t) => t.fileReferences ?? null), [[{ columns: ["status"], table: "public.customers", targetColumns: ["name"] }], null]);
});

test("mason add writes the foreign keys the database declares as references — one column and several, on the entry that holds each, comments kept — and says each it left out and why (issue 1143)", async () => {
  const E = await import("../src/cli/source-edit.ts" as string) as typeof import("../src/cli/source-edit.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mason-add-refs-"));
  const folder = path.join(root, "mason");
  fs.mkdirSync(path.join(folder, "sources"), { recursive: true });
  const file = path.join(folder, "sources", "app.yml");
  const edit = (text?: string) => { if (text !== undefined) fs.writeFileSync(file, text); return E.sourceToEdit(folder, root, () => S.readSource(folder, root, {})); };
  const db = { tables: REFS_CATALOG, database: "shop" };
  const tail = () => fs.readFileSync(file, "utf8").slice(HEAD.length);
  try {
    // the table that holds them added first: the keys to tables the file does not sync are left out, said with the way
    const inv = E.addEntry(edit(`${HEAD}tables:   # what the dashboards read\n  customers: {}   # people\n`), db, "public.invoices");
    assert.deepEqual(inv.referencesWritten, [{ table: "public.invoices", columns: ["customer_id"], references: "public.customers", targetColumns: ["id"] }]);
    assert.deepEqual(inv.referencesLeftOut, [
      { table: "public.invoices", columns: ["tenant_id", "account_id"], references: "public.accounts", targetColumns: ["tenant_id", "id"],
        reason: "accounts is not in the sources file: mason add accounts syncs it and writes this reference" },
      { table: "public.invoices", columns: ["tenant_id"], references: "public.tenants", targetColumns: ["id"],
        reason: "tenants is not in the sources file: mason add tenants syncs it and writes this reference" }]);
    assert.equal(tail(), "tables:   # what the dashboards read\n  customers: {}   # people\n  invoices:\n    references:\n      customer_id: customers.id\n");
    // a comment the person writes on a reference is theirs
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("customer_id: customers.id\n", "customer_id: customers.id   # who pays\n"));
    // the referenced table added later: the reference that points to it written on the entry that holds it, its other
    // lines as they were; and its own foreign key to a table the file does not sync, left out
    const acc = E.addEntry(edit(), db, "public.accounts");
    assert.deepEqual(acc.referencesWritten, [{ table: "public.invoices", columns: ["tenant_id", "account_id"], references: "public.accounts", targetColumns: ["tenant_id", "id"] }]);
    assert.deepEqual(acc.referencesLeftOut.map((x) => x.reason), ["tenants is not in the sources file: mason add tenants syncs it and writes this reference"]);
    assert.equal(tail(), "tables:   # what the dashboards read\n  customers: {}   # people\n  invoices:\n    references:\n      customer_id: customers.id   # who pays\n" +
      "      (tenant_id, account_id): accounts (tenant_id, id)\n  accounts: {}\n");
    // what the file says now holds at the next start
    assert.ok(Array.isArray(S.addedTables(edit().parsed, REFS_CATALOG, "shop", "/app")));
    // the table both point to: each entry gets its own, a flow entry written a key a line
    const ten = E.addEntry(edit(), db, "public.tenants");
    assert.deepEqual(ten.referencesWritten.map((x) => x.table), ["public.invoices", "public.accounts"]);
    assert.equal(tail(), "tables:   # what the dashboards read\n  customers: {}   # people\n  invoices:\n    references:\n      customer_id: customers.id   # who pays\n" +
      "      (tenant_id, account_id): accounts (tenant_id, id)\n      tenant_id: tenants.id\n  accounts:\n    references:\n      tenant_id: tenants.id\n  tenants: {}\n");
    // added again: nothing to write, nothing left out
    const again = E.addEntry(edit(), db, "public.tenants");
    assert.deepEqual([again.already, again.referencesWritten, again.referencesLeftOut], [true, [], []]);
    // the person's lines: what it wrote, and each it did not, in SQL's words
    const { addedLines } = await import("../src/cli/commands.ts");
    assert.deepEqual(addedLines(inv, "f").notes.slice(-3), [
      "wrote the database's foreign key as references: invoices.customer_id → customers.id",
      "foreign key invoices (tenant_id, account_id) → accounts (tenant_id, id) not written as a reference: accounts is not in the sources file: mason add accounts syncs it and writes this reference",
      "foreign key invoices.tenant_id → tenants.id not written as a reference: tenants is not in the sources file: mason add tenants syncs it and writes this reference"]);

    // A COLUMN NOT SYNCED on either side: left out, said; and mason tables' entry is what mason add writes
    const narrow = E.addEntry(edit(`${HEAD}tables:\n  customers:\n    columns: [name]\n`), db, "public.orders", ["id", "status"]);
    assert.deepEqual(narrow.referencesLeftOut.map((x) => x.reason), ["orders.customer_id is not synced"]);
    const listed = E.listTables(edit(`${HEAD}tables:\n  customers: {}\n  tenants: {}\n`).parsed, db);
    assert.deepEqual(listed.find((t) => t.table === "public.invoices")!.entry,
      { invoices: { references: { customer_id: "customers.id", tenant_id: "tenants.id" } } }, "mason tables --json: the references mason add would write");
    assert.deepEqual(listed.find((t) => t.table === "public.customers")!.entry, { customers: {} });

    // A REFERENCE ANOTHER ENTRY HOLDS that the table added again would break: refused, nothing written
    const held = `${HEAD}tables:\n  orders:\n    references:\n      status: customers.name\n  customers: {}\n`;
    assert.throws(() => E.addEntry(edit(held), db, "public.customers", ["id"]),
      { message: "public.customers cannot be added as asked: tables.orders.references.status: public.customers.name is not synced (tables.customers: columns: leaves it out) — sync it there, or take this reference out" });
    assert.equal(fs.readFileSync(file, "utf8"), held, "nothing written");
    // the table's own reference that its new columns no longer sync: left out, and said
    const own = E.addEntry(edit(`${HEAD}tables:\n  orders:\n    references:\n      customer_id: customers.id\n  customers: {}\n`), db, "public.orders", ["id", "status"]);
    assert.deepEqual(own.referencesLeftOut.map((x) => [x.columns, x.reason]), [[["customer_id"], "orders.customer_id is not synced"]]);
    assert.equal(tail(), "tables:\n  orders:\n    columns: [id, status]\n  customers: {}\n");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("mason remove takes the references to a removed table out of the entries that stay, comments and other lines kept, and says them (issue 1143)", async () => {
  const E = await import("../src/cli/source-edit.ts" as string) as typeof import("../src/cli/source-edit.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mason-remove-refs-"));
  const folder = path.join(root, "mason");
  fs.mkdirSync(path.join(folder, "sources"), { recursive: true });
  const file = path.join(folder, "sources", "app.yml");
  const edit = (text: string) => { fs.writeFileSync(file, text); return E.sourceToEdit(folder, root, () => S.readSource(folder, root, {})); };
  const db = { tables: REFS_CATALOG, database: "shop" };
  const text = `${HEAD}tables:
  invoices:
    sync: poll 5m   # hourly is too slow
    references:
      customer_id: customers.id   # who pays
      (tenant_id, account_id): accounts (tenant_id, id)
      tenant_id: tenants.id
  orders:
    references: { customer_id: customers.id }
  accounts:
    references:
      tenant_id: tenants.id
  customers: {}
  tenants: {}
`;
  try {
    const r = E.removeEntries(edit(text), db, ["tenants", "customers"]);
    assert.deepEqual(r.referencesRemoved.map((x) => `${x.table} ${x.columns.join(",")} ${x.references}`),
      ["public.invoices customer_id public.customers", "public.invoices tenant_id public.tenants", "public.orders customer_id public.customers", "public.accounts tenant_id public.tenants"]);
    assert.equal(fs.readFileSync(file, "utf8"), `${HEAD}tables:
  invoices:
    sync: poll 5m   # hourly is too slow
    references:
      # who pays
      (tenant_id, account_id): accounts (tenant_id, id)
  orders: {}
  accounts: {}
`);
    // the file left holds at the next start
    assert.ok(Array.isArray(S.addedTables(S.parseSourceText(fs.readFileSync(file, "utf8"), "app", file) as Sources.SourceFile, REFS_CATALOG, "shop", "/app")));
    // the last reference of an entry with other keys: its references: line goes too, a comment under it stays
    const r2 = E.removeEntries(edit(fs.readFileSync(file, "utf8")), db, ["accounts"]);
    assert.equal(r2.referencesRemoved.length, 1);
    assert.equal(fs.readFileSync(file, "utf8"), `${HEAD}tables:\n  invoices:\n    sync: poll 5m   # hourly is too slow\n      # who pays\n  orders: {}\n`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// THE REVIEW OF PR 1145: an entry whose nested block ends in a comment line has the `yaml` package's range run on to the
// next entry's key, so an edit that cut to it took that entry too. Every edit now asks one function where an entry ends.
const visits = table({ table: "visits", columns: [col("id", "bigint", true), col("customer_id", "bigint")],
  references: [{ columns: ["customer_id"], target: "public.customers", targetColumns: ["id"] }] });
const billingAccounts = table({ schema: "billing", table: "accounts" });
const user = table({ table: "User" });
const ENDS_CATALOG = [customers, visits, billingAccounts, user];

test("mason remove after an entry whose block ends in a comment line cuts only what it names: the next entry stays, its line and all (review of PR 1145)", async () => {
  const E = await import("../src/cli/source-edit.ts" as string) as typeof import("../src/cli/source-edit.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mason-remove-ends-"));
  const folder = path.join(root, "mason");
  fs.mkdirSync(path.join(folder, "sources"), { recursive: true });
  const file = path.join(folder, "sources", "app.yml");
  const edit = (text?: string) => { if (text !== undefined) fs.writeFileSync(file, text); return E.sourceToEdit(folder, root, () => S.readSource(folder, root, {})); };
  const db = { tables: ENDS_CATALOG, database: "shop" };
  try {
    // as a person gets there: mason add each, then a comment line at the end of visits' references
    fs.writeFileSync(file, `${HEAD}tables: {}\n`);
    for (const t of ["public.customers", "public.visits", "billing.accounts", "public.User"]) E.addEntry(edit(), db, t);
    assert.equal(fs.readFileSync(file, "utf8"), `${HEAD}tables:\n  customers: {}\n  visits:\n    references:\n      customer_id: customers.id\n  billing.accounts: {}\n  User: {}\n`);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("customer_id: customers.id\n", "customer_id: customers.id\n      # d: days.d   (once days is synced)\n"));
    const r = E.removeEntries(edit(), db, ["customers"]);
    assert.deepEqual([r.removed, r.referencesRemoved.map((x) => x.table)], [["public.customers"], ["public.visits"]]);
    // its references: gone, the entry is {} with the commented-out reference under it
    assert.equal(fs.readFileSync(file, "utf8"), `${HEAD}tables:\n  visits: {}\n      # d: days.d   (once days is synced)\n  billing.accounts: {}\n  User: {}\n`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("every edit ends an entry where its own lines end: a block ending in a comment, a block list at the key's indent, a comment at the next key's indent, a blank line after it (review of PR 1145)", () => {
  const top = `${HEAD}tables:\n`;
  const after = "  # the next one's comment\n  User: {}\n";
  for (const [body, readded] of [
    // the columns asked already: nothing written
    ["  visits:\n    columns:\n      - id\n      # - customer_id\n", null],
    ["  visits:\n    columns:\n    - id\n    # - customer_id\n", null],
    // references: cut, its comment kept; columns: added after
    ["  visits:\n    references:\n      customer_id: customers.id\n      # d: days.d\n", "  visits:\n      # d: days.d\n    columns: [id]\n"],
    ["  visits:   # every column\n    # until it is big\n", "  visits:   # every column\n    columns: [id]\n    # until it is big\n"],
  ] as const) {
    const text = `${top}${body}\n${after}`;
    // mason remove: the entry's own lines go, the blank line and the next entry's comment stay
    assert.deepEqual(S.withoutTable(text, "public.visits"), { text: `${top}\n${after}` }, body);
    // mason add again: the entry written in its place, the rest as it was
    assert.deepEqual(S.withTable(text, { name: "visits", table: "public.visits", columns: ["id"], exclude: [], key: null }), { text: `${top}${readded ?? body}\n${after}` }, body);
    // mason add of a new table: after the last entry's own lines
    const last = `${top}${after.replace("  User: {}\n", "")}${body}`;
    assert.deepEqual(S.withTable(last, { name: "orders", table: "public.orders", columns: null, exclude: [], key: null }), { text: `${last}  orders: {}\n` }, body);
  }
  // a key of the entry: a sync: line added after the entry's own lines, never inside the next entry
  const commented = `${top}  visits:\n    columns:\n      - id\n      # - customer_id\n  User: {}\n`;
  assert.deepEqual(S.withEntrySync(commented, { name: "visits", table: "public.visits", columns: ["id"], exclude: [], key: null }, { mode: "off" }),
    { text: `${top}  visits:\n    columns:\n      - id\n      # - customer_id\n    sync: off\n  User: {}\n` });
});

test("mason add of a table added already keeps its entry byte for byte, its comments too, writing only the reference another entry holds to it (review of PR 1145)", async () => {
  const E = await import("../src/cli/source-edit.ts" as string) as typeof import("../src/cli/source-edit.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mason-readd-"));
  const folder = path.join(root, "mason");
  fs.mkdirSync(path.join(folder, "sources"), { recursive: true });
  const file = path.join(folder, "sources", "app.yml");
  const edit = (text: string) => { fs.writeFileSync(file, text); return E.sourceToEdit(folder, root, () => S.readSource(folder, root, {})); };
  const db = { tables: ENDS_CATALOG, database: "shop" };
  const customersEntry = "  customers:   # who pays\n    # hourly is enough\n    sync: poll 1h   # cheap\n";
  try {
    const r = E.addEntry(edit(`${HEAD}tables:\n${customersEntry}  visits: {}\n`), db, "public.customers");
    assert.deepEqual(r.referencesWritten.map((x) => x.table), ["public.visits"]);
    assert.equal(fs.readFileSync(file, "utf8"), `${HEAD}tables:\n${customersEntry}  visits:\n    references:\n      customer_id: customers.id\n`);
    // its own references alone changed (the database declares one the entry lacks): those lines alone written
    const own = "  visits:   # the app's visits\n    # polled: they change all day\n    sync: poll 5m\n";
    E.addEntry(edit(`${HEAD}tables:\n  customers: {}\n${own}`), db, "public.visits");
    assert.equal(fs.readFileSync(file, "utf8"), `${HEAD}tables:\n  customers: {}\n${own}    references:\n      customer_id: customers.id\n`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// THE SECOND REVIEW OF PR 1145: an entry's end read from indentation alone left a closing bracket on a line of its own
// behind, and an entry whose key has an anchor or a tag lost its lines. The parser's own positions now bound it, and every
// edit is read back before it is written.
test("an entry ends where the parser says: a flow collection's bracket on a line of its own, a key with an anchor or a tag, a block scalar's line break (second review of PR 1145)", async () => {
  const E = await import("../src/cli/source-edit.ts" as string) as typeof import("../src/cli/source-edit.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mason-ends-parser-"));
  const folder = path.join(root, "mason");
  fs.mkdirSync(path.join(folder, "sources"), { recursive: true });
  const file = path.join(folder, "sources", "app.yml");
  const edit = (text: string) => { fs.writeFileSync(file, text); return E.sourceToEdit(folder, root, () => S.readSource(folder, root, {})); };
  const db = { tables: ENDS_CATALOG, database: "shop" };
  const off = { sync: { mode: "off" as const }, keep: true };
  const after = (f: () => unknown): string => { f(); return fs.readFileSync(file, "utf8").slice(HEAD.length); };
  const tables = (s: string) => `${HEAD}tables:\n${s}`;
  try {
    // a flow map closed on a line of its own, at the key's indent
    const flowMap = tables("  customers: {\n    columns: [id]\n  }\n  visits: {}\n  User: {}\n");
    assert.equal(after(() => E.removeEntries(edit(flowMap), db, ["customers"])), "tables:\n  visits: {}\n  User: {}\n");
    assert.equal(after(() => E.addEntry(edit(flowMap), db, "public.customers", ["*"], null, off)), "tables:\n  customers:\n    columns: [id]\n    sync: off\n  visits: {}\n  User: {}\n");
    assert.equal(after(() => E.addEntry(edit(flowMap), db, "public.customers")), "tables:\n  customers: {}\n  visits:\n    references:\n      customer_id: customers.id\n  User: {}\n");
    // a flow list closed the same way: a sync: line after it, never inside it
    assert.equal(after(() => E.addEntry(edit(tables("  customers:\n    columns: [\n      id,\n    ]\n  visits: {}\n")), db, "public.customers", ["*"], null, off)),
      "tables:\n  customers:\n    columns: [\n      id,\n    ]\n    sync: off\n  visits: {}\n");
    // a reference written on an entry that is a flow map over several lines, and a sync: after a references: map over several
    assert.equal(after(() => E.addEntry(edit(tables("  customers: {}\n  visits: { columns: [\n      id, customer_id\n    ] }\n  User: {}\n")), db, "public.customers")),
      "tables:\n  customers: {}\n  visits:\n    columns: [id, customer_id]\n    references:\n      customer_id: customers.id\n  User: {}\n");
    assert.equal(after(() => E.addEntry(edit(tables("  customers: {}\n  visits:\n    references: {\n      customer_id: customers.id\n    }\n  User: {}\n")), db, "public.visits", ["*"], null, off)),
      "tables:\n  customers: {}\n  visits:\n    references: {\n      customer_id: customers.id\n    }\n    sync: off\n  User: {}\n");
    // a key with an anchor or a tag before it: its lines go with it, and an entry added after is at the entries' indent
    for (const key of ["&c customers", "!!str customers"]) {
      const text = tables(`  ${key}:\n    columns: [id]\n  visits: {}\n`);
      assert.equal(after(() => E.removeEntries(edit(text), db, ["customers"])), "tables:\n  visits: {}\n", key);
      assert.equal(after(() => E.addEntry(edit(text), db, "public.customers")), `tables:\n  ${key}: {}\n  visits:\n    references:\n      customer_id: customers.id\n`, key);
      assert.equal(after(() => E.addEntry(edit(text), db, "public.User", ["id"])), `tables:\n  ${key}:\n    columns: [id]\n  visits: {}\n  User:\n    columns: [id]\n`, key);
    }
    // a sync: written as a block scalar: its value replaced, the line break after it kept (on main the next entry joined it)
    assert.equal(after(() => E.addEntry(edit(tables("  customers:\n    sync: >-\n      poll 5m\n  visits: {}\n  User: {}\n")), db, "public.customers", ["*"], null, off)),
      "tables:\n  customers:\n    sync: off\n  visits: {}\n  User: {}\n");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("an edit that would not leave the file as asked writes nothing and refuses, naming the file and what to write by hand (second review of PR 1145)", async () => {
  const E = await import("../src/cli/source-edit.ts" as string) as typeof import("../src/cli/source-edit.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mason-edit-checked-"));
  const folder = path.join(root, "mason");
  fs.mkdirSync(path.join(folder, "sources"), { recursive: true });
  const file = path.join(folder, "sources", "app.yml");
  const edit = (text: string) => { fs.writeFileSync(file, text); return E.sourceToEdit(folder, root, () => S.readSource(folder, root, {})); };
  const db = { tables: ENDS_CATALOG, database: "shop" };
  // an explicit key (`? customers` / `: columns: [id]`): a sync: line spliced at its value's indent would read as a
  // table named sync (on main, written: the file then refused at the next start)
  const text = `${HEAD}tables:\n  ? customers\n  : columns: [id]\n  visits: {}\n`;
  try {
    assert.throws(() => E.addEntry(edit(text), db, "public.customers", ["*"], null, { sync: { mode: "off" }, keep: true }),
      { message: "mason/sources/app.yml could not be edited safely, so nothing was written: the edit would leave it unreadable " +
        "(tables.sync: is {} (every column), { columns: [...] }, { exclude: [...] }, { key: [...] } or { sync: poll 5m }). " +
        "Edit it by hand: write its entry as customers: {\"columns\":[\"id\"],\"sync\":\"off\"}" });
    assert.equal(fs.readFileSync(file, "utf8"), text, "nothing written");
    // the edits it can make there, it makes
    E.addEntry(edit(text), db, "public.User");
    assert.equal(fs.readFileSync(file, "utf8"), `${text}  User: {}\n`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// THE THIRD REVIEW OF PR 1145: an entry written again from its key line (`entryText`) kept only the comment on that line.
// Every edit now changes only the lines it must, and the read-back refuses one that would lose a comment.
const placed = table({ table: "orders", columns: [col("id", "bigint", true), col("customer_id", "bigint"), col("account_id", "bigint"), col("name")],
  references: [{ columns: ["customer_id"], target: "public.customers", targetColumns: ["id"] },
    { columns: ["account_id"], target: "billing.accounts", targetColumns: ["id"] }] });
const COMMENTS_CATALOG = [customers, placed, billingAccounts];

test("an edit changes only the lines it must: every comment of an entry it edits survives, a flow map made a block keeps its own (third review of PR 1145)", async () => {
  const E = await import("../src/cli/source-edit.ts" as string) as typeof import("../src/cli/source-edit.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mason-comments-"));
  const folder = path.join(root, "mason");
  fs.mkdirSync(path.join(folder, "sources"), { recursive: true });
  const file = path.join(folder, "sources", "app.yml");
  const edit = (text: string) => { fs.writeFileSync(file, `${HEAD}tables:\n${text}`); return E.sourceToEdit(folder, root, () => S.readSource(folder, root, {})); };
  const after = (f: () => unknown): string => { f(); return fs.readFileSync(file, "utf8").slice(`${HEAD}tables:\n`.length); };
  const db = { tables: COMMENTS_CATALOG, database: "shop" };
  try {
    // mason add customers writes the reference orders holds to it: orders' flow map made a block, each comment kept
    assert.equal(after(() => E.addEntry(edit("  orders: {   # o\n    columns: [id, customer_id],   # cols\n    # inside\n  }\n"), db, "public.customers")),
      "  orders:   # o\n    columns: [id, customer_id]   # cols\n    # inside\n    references:\n      customer_id: customers.id\n  customers: {}\n");
    // mason remove customers: one reference out of a flow map, the comment after it kept
    assert.equal(after(() => E.removeEntries(edit("  customers: {}\n  billing.accounts: {}\n  orders:\n    references: { customer_id: customers.id, account_id: billing.accounts.id }   # refs\n"), db, ["customers"])),
      "  billing.accounts: {}\n  orders:\n    references:   # refs\n      account_id: billing.accounts.id\n");
    // a reference cut from a block: its own comment kept on a line of its own, the next reference's line as it was
    assert.equal(after(() => E.removeEntries(edit("  customers: {}\n  billing.accounts: {}\n  orders:\n    references:\n      customer_id: customers.id   # who placed it\n      account_id: billing.accounts.id   # who pays\n"), db, ["customers"])),
      "  billing.accounts: {}\n  orders:\n    references:\n      # who placed it\n      account_id: billing.accounts.id   # who pays\n");
    // an entry whose only key was references: is {} again, its comments under it, a commented-out reference too
    assert.equal(after(() => E.removeEntries(edit("  customers: {}\n  orders:\n    # the orders a customer placed\n    references:\n      customer_id: customers.id\n      # d: days.d\n      # TODO: more once synced\n"), db, ["customers"])),
      "  orders: {}\n    # the orders a customer placed\n      # d: days.d\n      # TODO: more once synced\n");
    // mason remove: a comment line among the entry's lines no deeper than its key is not its own, and stays
    assert.equal(after(() => E.removeEntries(edit("  customers:\n# --- the shop ---\n  # what is synced\n    # customers' own\n    columns: [id]\n  billing.accounts: {}\n"), db, ["customers"])),
      "# --- the shop ---\n  # what is synced\n  billing.accounts: {}\n");
    // mason add customers --columns id, and again with every column: the columns: line alone changes, the comment after it stays
    const pii = "  customers:\n    columns: [id, name]\n    # TODO: drop name after the PII review\n";
    assert.equal(after(() => E.addEntry(edit(pii), db, "public.customers", ["id"])), "  customers:\n    columns: [id]\n    # TODO: drop name after the PII review\n");
    assert.equal(after(() => E.addEntry(edit(pii), db, "public.customers")), "  customers: {}\n    # TODO: drop name after the PII review\n");
    // a sync: on an entry written as a flow map: made a block, the comment after it kept on the key's line
    assert.equal(after(() => E.addEntry(edit("  customers: { columns: [id] }   # c\n"), db, "public.customers", ["*"], null, { sync: { mode: "off" }, keep: true })),
      "  customers:   # c\n    columns: [id]\n    sync: off\n");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the read-back refuses an edit that would lose a comment, but for the lines it cuts on purpose (third review of PR 1145)", () => {
  const before = `${HEAD}tables:\n  customers: {}   # keep me\n  orders: {}   # old\n`;
  const parsed = S.parseSourceText(before, "app", "/app/mason/sources/app.yml") as Sources.SourceFile;
  assert.equal(S.editProblem({ text: before, parsed }, `${HEAD}tables:\n  customers: {}\n  orders: {}   # old\n`, parsed.tables), "the edit would lose the comment # keep me");
  // two alike are two: one gone is one lost
  const twice = `${HEAD}tables:\n  customers: {}   # same\n  orders: {}   # same\n`;
  const p2 = S.parseSourceText(twice, "app", "/app/mason/sources/app.yml") as Sources.SourceFile;
  assert.equal(S.editProblem({ text: twice, parsed: p2 }, `${HEAD}tables:\n  customers: {}   # same\n  orders: {}\n`, p2.tables), "the edit would lose the comment # same");
  // a removed entry's own comments go with it, said as dropped; a # in a quoted name or a block scalar is no comment
  assert.equal(S.editProblem({ text: before, parsed }, `${HEAD}tables:\n  customers: {}   # keep me\n`, parsed.tables.filter((e) => e.name === "customers"), ["# old"]), null);
  assert.deepEqual(S.commentsOf(`a: "x # y"   # z\nb: |\n  # not one\n`).map((c) => c.text), ["# z"]);
});

test("the run writes exclude: for a secret-looking column that arrived on that key's line alone, the entry's comments kept, read back first (third review of PR 1145)", async () => {
  const E = await import("../src/cli/source-edit.ts" as string) as typeof import("../src/cli/source-edit.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mason-left-out-"));
  const file = path.join(root, "app.yml");
  try {
    fs.writeFileSync(file, `${HEAD}tables:\n  t:   # the app's tokens\n    # every column for now\n  u: {}\n`);
    E.writeLeftOut(root, file, "app", [{ table: "public.t", exclude: ["api_token"] }]);
    assert.equal(fs.readFileSync(file, "utf8"), `${HEAD}tables:\n  t:   # the app's tokens\n    exclude: [api_token]\n    # every column for now\n  u: {}\n`);
    // an entry with keys: exclude: added after them, the rest as it was
    fs.writeFileSync(file, `${HEAD}tables:\n  t:\n    sync: poll 5m   # often\n    # more later\n`);
    E.writeLeftOut(root, file, "app", [{ table: "public.t", exclude: ["secret"] }]);
    assert.equal(fs.readFileSync(file, "utf8"), `${HEAD}tables:\n  t:\n    sync: poll 5m   # often\n    exclude: [secret]\n    # more later\n`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
