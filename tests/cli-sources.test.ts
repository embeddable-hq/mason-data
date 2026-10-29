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
    { name: "orders", table: "public.orders", columns: ["id", "customer_id", "status", "amount"], exclude: [], key: null },
    { name: "customers", table: "public.customers", columns: null, exclude: [], key: null },
    { name: "events", table: "public.events", columns: null, exclude: [], key: ["tenant_id", "id"] },
    { name: "billing.invoices", table: "billing.invoices", columns: null, exclude: ["name"], key: null },
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
    ['url: "postgres://u:${PASS}@h/db" — write the URL whole, or ${NAME} alone: the whole URL in one variable, like ${DATABASE_URL}']);
  assert.deepEqual(problems("kind: postgres\nurl: ${DATABASE_URL}\n"), ["tables: missing — write tables: {} (mason add adds a table to it)"]);
  assert.deepEqual(problems("kind: postgres\nurl: ${DATABASE_URL}\ntables: [orders]\n"), ["tables: is one entry per table, like tables: { orders: {}, customers: { columns: [id, name] } }"]);
  assert.deepEqual(problems("kind: postgres\nurl: ${DATABASE_URL}\ntable: {}\n"), [
    "unexpected key table — did you mean `tables`? — a source file takes kind, url, tables", "tables: missing — write tables: {} (mason add adds a table to it)"]);
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
    "tables.orders: unexpected key colums — did you mean `columns`? — a table takes columns, exclude and key",
    "tables.customers: columns and exclude together — columns names what is copied, exclude what is left out of every column; keep one",
    "tables.events.columns: is the columns copied, a list of column names: [id, status]",
    "tables.sessions.key: is the columns that tell its rows apart, a list of column names: [id, status]",
    "tables.logs.exclude: names a twice",
    "tables.orders_two: is {} (every column), { columns: [...] }, { exclude: [...] } or { key: [...] }",
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
  const added = S.addedTables(f, CATALOG, "shop", "/app", { replication: false }) as Sources_AddedTable[];
  assert.ok(Array.isArray(added), JSON.stringify(added));
  assert.deepEqual(added.map((t) => [t.source, t.columns.map((c) => c.name), t.key, t.primaryKey]), [
    ["public.orders", ["id", "customer_id", "status", "amount"], ["id"], undefined],
    ["public.customers", ["id", "name"], ["id"], undefined],
    // copied by the file's key; the catalog keeps the source's own primary key, none (it declares only what Postgres does)
    ["public.events", ["tenant_id", "id", "raw_body"], ["tenant_id", "id"], []],
    ["billing.invoices", ["id"], ["id"], undefined],
  ]);
  assert.deepEqual(added[0]!.foreignKeys, orders.foreignKeys, "a foreign key out of a copied column is kept");
  const narrow = S.addedTables(parse("kind: postgres\nurl: x\ntables:\n  orders: { columns: [status] }\n") as Sources.SourceFile, CATALOG, "shop", "/app", { replication: false }) as Sources_AddedTable[];
  assert.deepEqual([narrow[0]!.columns.map((c) => c.name), narrow[0]!.foreignKeys], [["id", "status"], []], "the key always copied; a foreign key out of a column left out goes");

  const wrong = S.addedTables(parse(`kind: postgres
url: x
tables:
  ordrs: {}
  orders: { columns: [id, statsu] }
  customers: { exclude: [id], key: [id] }
  events: {}
  billing.invoices: { key: [nope] }
`) as Sources.SourceFile, CATALOG, "shop", "/app", { replication: false }) as Failure;
  assert.equal(wrong.code, "bad_source");
  assert.equal(wrong.message, "mason/sources/app.yml has 6 mistakes");
  assert.equal(wrong.why, [
    "- tables.ordrs: shop has no table public.ordrs this user can read — did you mean `orders`?",
    "- tables.orders.columns: public.orders has no column statsu — did you mean `status`? (its columns: id, customer_id, status, amount, api_token, payload)",
    "- tables.customers.key: public.customers has a primary key (id), which Mason copies it by — remove key",
    "- tables.customers.exclude: id is public.customers's key, which is always copied — take it out of exclude",
    "- tables.events: public.events has no primary key, so Mason cannot tell its rows apart — name the columns that do: key: [tenant_id, id] (its unique index events_tenant_id_id_key)",
    "- tables.billing.invoices.key: billing.invoices has a primary key (id), which Mason copies it by — remove key",
  ].join("\n"));
  assert.deepEqual(wrong.next, [["mason tables", "the database's tables and their columns"]]);
  // a key: table under logical replication: its rows have no identity there
  const repl = S.addedTables(parse("kind: postgres\nurl: x\ntables:\n  events: { key: [tenant_id, id] }\n") as Sources.SourceFile, CATALOG, "shop", "/app", { replication: true }) as Failure;
  assert.equal(repl.message, "mason/sources/app.yml: tables.events: public.events has no primary key, and logical replication cannot apply its changes by key: — copy it by polling (mason start --poll), or remove it");
});
type Sources_AddedTable = import("../src/duck/sync.ts").AddedTable;

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
  assert.deepEqual(S.catalogTable(events, { name: "events", table: "public.events", columns: null, exclude: ["raw_body"], key: ["tenant_id", "id"] }),
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

test("a key: must tell the rows apart as the database enforces it: NOT NULL columns, over a unique index — else refused at its key", () => {
  // the review of the sources file: a key with duplicates failed the copy as "Mason bug", retried for ever,
  // and duplicates after the copy made the poll's update and delete by key change both rows
  const logs = table({ table: "logs", key: [], columns: [col("tenant_id", "bigint", true), col("id", "bigint", true), col("seq", "bigint"), col("note")],
    uniqueKeys: [{ name: "logs_tenant_id_id_key", columns: ["tenant_id", "id"], constraint: true, nullsNotDistinct: false }] });
  const bare = table({ table: "bare", key: [], columns: [col("a", "bigint", true), col("b")] });
  const added = (entries: string): unknown => S.addedTables(parse(`kind: postgres\nurl: x\ntables:\n${entries}`) as Sources.SourceFile, [logs, bare], "shop", "/app", { replication: false });
  assert.ok(Array.isArray(added("  logs: { key: [tenant_id, id] }\n")), "the unique index's own columns");
  assert.ok(Array.isArray(added("  logs: { key: [id, tenant_id] }\n")), "in any order");
  const wrong = added("  logs: { key: [id] }\n  bare: { key: [a] }\n") as Failure;
  assert.equal(wrong.why, [
    "- tables.logs.key: no unique index of public.logs is over (id), so two of its rows may share them and Mason could not tell them apart — name the columns of one: key: [tenant_id, id] (its unique index logs_tenant_id_id_key)",
    "- tables.bare.key: no unique index of public.bare is over (a), so two of its rows may share them and Mason could not tell them apart — it has no unique index over NOT NULL columns, so Mason cannot copy it until its owner adds one (or a primary key)",
  ].join("\n"));
  const nullable = added("  logs: { key: [tenant_id, id, seq] }\n") as Failure;
  assert.equal(nullable.message, "mason/sources/app.yml: tables.logs.key: seq may be NULL in public.logs, and rows with NULL there cannot be told apart — a key's columns are NOT NULL");
});

test("the file read again while the run is up: a mistake keeps the tables read before and is said once; a url: naming another database too", () => {
  const ok = parse("kind: postgres\nurl: postgres://me@localhost:5432/shop\ntables:\n  customers: {}\n") as Sources.SourceFile;
  const read = (text: string, resolved = "postgres://me@localhost:5432/shop"): Sources.ProjectSource | Failure => {
    const p = parse(text);
    return "problems" in p ? S.sourceFailure(FILE, "/app", p.problems) : { ...p, resolved, from: "mason/sources/app.yml" };
  };
  const RUN = "postgres://me@localhost:5432/shop";
  const first = S.addedTables(ok, CATALOG, "shop", "/app", { replication: false }) as Sources_AddedTable[];
  let now: Sources.RunSources = { file: ok, tables: first, problem: null };
  // the file stops parsing: the tables kept, said once
  const broken = S.rereadSources(now, read("kind: postgres\nurl: x\ntables:\n  customers: {\n"), RUN, CATALOG, "shop", "/app", { replication: false });
  assert.deepEqual([broken.tables, broken.file], [first, ok], "the tables read before, kept");
  assert.match(broken.said ?? "", /^the sources file cannot be read as it is now, so the tables read before are kept: mason\/sources\/app\.yml: it is not YAML/);
  now = broken;
  assert.equal(S.rereadSources(now, read("kind: postgres\nurl: x\ntables:\n  customers: {\n"), RUN, CATALOG, "shop", "/app", { replication: false }).said, null, "the same problem is not said again");
  // a url: that names another database (a .env edited): the run's catalog is the old one's — kept, and the way out said
  const moved = S.rereadSources(now, read("kind: postgres\nurl: ${DATABASE_URL}\ntables:\n  orders: {}\n", "postgres://me:pw@elsewhere:5432/other"), RUN, CATALOG, "shop", "/app", { replication: false });
  assert.deepEqual(moved.tables, first);
  assert.equal(moved.problem, "mason/sources/app.yml: url: now names postgres://me:****@elsewhere:5432/other (mason/sources/app.yml), and this run copies postgres://me@localhost:5432/shop: mason stop && mason start copies from the new one");
  // fixed: the file's tables now, nothing wrong
  const fixed = S.rereadSources(moved, read("kind: postgres\nurl: x\ntables:\n  orders: {}\n"), RUN, CATALOG, "shop", "/app", { replication: false });
  assert.deepEqual([fixed.tables.map((t) => t.source), fixed.problem, fixed.said], [["public.orders"], null, null]);
});

test("the small mistakes: $NAME without braces, a name YAML reads as a boolean, null or number — each told what to write", () => {
  assert.deepEqual(problems("kind: postgres\nurl: $DATABASE_URL\ntables: {}\n"), ["url: $DATABASE_URL — write ${DATABASE_URL}: a variable is named in braces"]);
  assert.deepEqual(problems("kind: postgres\nurl: x\ntables:\n  true: {}\n  1: {}\n  orders: { columns: [id, null, 2] }\n"), [
    "tables: true is read by YAML as a boolean, not a name — quote it: \"true\"",
    "tables: 1 is read by YAML as a number, not a name — quote it: \"1\"",
    "tables.orders.columns: null is read by YAML as nothing (null), not a name — quote it: \"null\"",
  ]);
  assert.deepEqual((parse("kind: postgres\nurl: x\ntables:\n  \"true\": { columns: [id, \"null\"] }\n") as Sources.SourceFile).tables[0], { name: "true", table: "public.true", columns: ["id", "null"], exclude: [], key: null });
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
    const add = (key: string): unknown => S.addedTables(parse(`kind: postgres\nurl: x\ntables:\n  logs: { key: [${key}] }\n`) as Sources.SourceFile, [logs], "shop", "/app", { replication: false });
    assert.match((add("id") as Failure).why ?? (add("id") as Failure).message, /no unique index of public\.logs is over \(id\)/);
    assert.ok(Array.isArray(add("tenant_id, id")), JSON.stringify(add("tenant_id, id")));
  } finally { await db.close(); }
});
