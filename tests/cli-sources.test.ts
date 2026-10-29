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
    ['url: "postgres://u:${PASS}@h/db" — write the URL whole, or ${NAME} alone: the whole URL in one variable, like ${DATABASE_URL}']);
  assert.deepEqual(problems("kind: postgres\nurl: ${DATABASE_URL}\n"), ["tables: missing — write tables: {} (mason add adds a table to it)"]);
  assert.deepEqual(problems("kind: postgres\nurl: ${DATABASE_URL}\ntables: [orders]\n"), ["tables: is one entry per table, like tables: { orders: {}, customers: { columns: [id, name] } }"]);
  assert.deepEqual(problems("kind: postgres\nurl: ${DATABASE_URL}\ntable: {}\n"), [
    "unexpected key table — did you mean `tables`? — a source file takes kind, url, sync, tables", "tables: missing — write tables: {} (mason add adds a table to it)"]);
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
    "tables.orders: unexpected key colums — did you mean `columns`? — a table takes columns, exclude, key and sync",
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
    "- tables.customers.key: public.customers has a primary key (id), which Mason keys it by — remove key",
    "- tables.customers.exclude: id is public.customers's key, which is always synced — take it out of exclude",
    "- tables.events: public.events has no primary key, so Mason cannot tell its rows apart — name the columns that do: key: [tenant_id, id] (its unique index events_tenant_id_id_key)",
    "- tables.billing.invoices.key: billing.invoices has a primary key (id), which Mason keys it by — remove key",
  ].join("\n"));
  assert.deepEqual(wrong.next, [["mason tables", "the database's tables and their columns"]]);
  // a key: table under logical replication: its rows have no identity there
  const repl = S.addedTables(parse("kind: postgres\nurl: x\ntables:\n  events: { key: [tenant_id, id] }\n") as Sources.SourceFile, CATALOG, "shop", "/app", { replication: true }) as Failure;
  assert.equal(repl.message, "mason/sources/app.yml: tables.events: public.events has no primary key, and logical replication cannot apply its changes by key: — sync it by polling (mason start --poll), or remove it");
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
    "- tables.bare.key: no unique index of public.bare is over (a), so two of its rows may share them and Mason could not tell them apart — it has no unique index over NOT NULL columns, so Mason cannot sync it until its owner adds one (or a primary key)",
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
  assert.equal(moved.problem, "mason/sources/app.yml: url: now names postgres://me:****@elsewhere:5432/other (mason/sources/app.yml), and this run syncs postgres://me@localhost:5432/shop: mason stop && mason start syncs from the new one");
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
    const add = (key: string): unknown => S.addedTables(parse(`kind: postgres\nurl: x\ntables:\n  logs: { key: [${key}] }\n`) as Sources.SourceFile, [logs], "shop", "/app", { replication: false });
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
  const added = S.addedTables(f, CATALOG, "shop", "/app", { replication: false }) as Array<{ source: string; sync?: unknown }>;
  assert.deepEqual(added.map((t) => [t.source, t.sync]), [["public.orders", OFF], ["public.customers", poll("5m", 300)]]);
});

test("sync: every mistake on one report, at its key, with the line to write — a short interval, poll alone, a misspelt mode or key, replication not yet", () => {
  const one = (v: string, at = "sync"): string => {
    const p = at === "sync" ? problems(`${head}sync: ${v}\ntables: {}\n`) : problems(`${head}tables:\n  orders:\n    sync: ${v}\n`);
    assert.equal(p.length, 1, JSON.stringify(p));
    return p[0]!;
  };
  assert.equal(one("poll 500ms"), "sync: 500ms is under the shortest interval, 1s (a poll scans the table whole on your database): write poll 1s or longer");
  assert.equal(one("poll 0s"), "sync: 0s is under the shortest interval, 1s: write poll 1s or longer");
  assert.equal(one("poll"), "sync: poll needs its interval: write poll 5s, poll 5m or poll 1h (at least 1s)");
  assert.equal(one("polling 5s"), "sync: polling is not a sync — did you mean `poll 5s`? Write off, or poll <interval> (poll 5s, poll 5m or poll 1h)");
  assert.equal(one("Off"), "sync: Off is not a sync — did you mean `off`? Write off, or poll <interval> (poll 5s, poll 5m or poll 1h)");
  assert.equal(one("replication"), "sync: replication is not in this release yet: mason start --replication keeps every table current (write off or poll <interval> here)");
  assert.equal(one("poll 5 minutes"), 'sync: "5 minutes": write poll 5m');
  assert.equal(one("poll 1.5h"), "sync: 1.5h: an interval is a whole number — write poll 90m");
  assert.equal(one("poll 2d"), "sync: 2d: d is not a unit of an interval — days are hours: write poll 48h");
  assert.equal(one("poll soon"), 'sync: "soon" is not an interval: an interval is <n>s, <n>m or <n>h, a whole number, at least 1s (poll 5s, poll 5m or poll 1h)');
  assert.equal(one("off 5m"), "sync: off takes no interval: write off, or poll 5m");
  // at most a day (a longer one is off and mason sync from a scheduler; a huge one was an instant past a Date's range and
  // broke every status line), and one spelling of each interval (05s and 5s would read as a change of sync)
  assert.equal(one("poll 25h"), "sync: 25h is over the longest interval, 24h: write poll 24h, or off with mason sync <table> run by a scheduler");
  assert.equal(one("poll 9999999999999s"), "sync: 9999999999999s is over the longest interval, 24h: write poll 24h, or off with mason sync <table> run by a scheduler");
  assert.equal(one("poll 05s"), 'sync: "05s": write poll 5s');
  assert.deepEqual((parse(`${head}sync: poll 24h\ntables: {}\n`) as Sources.SourceFile).sync, poll("24h", 86_400), "a day is the longest, and taken");
  assert.equal(one("5"), "sync: is the number 5: write off, or poll <interval> (poll 5s, poll 5m or poll 1h)");
  // on an entry, at the entry's key
  assert.equal(one("poll", "entry"), "tables.orders.sync: poll needs its interval: write poll 5s, poll 5m or poll 1h (at least 1s)");
  // the key misspelt, at the top and on an entry: did you mean
  assert.deepEqual(problems(`${head}synk: off\ntables: {}\n`), ["unexpected key synk — did you mean `sync`? — a source file takes kind, url, sync, tables"]);
  assert.deepEqual(problems(`${head}tables:\n  orders:\n    Sync: off\n`), ["tables.orders: unexpected key Sync — did you mean `sync`? — a table takes columns, exclude, key and sync"]);
  // all of a file's mistakes on ONE report
  assert.deepEqual(problems(`${head}sync: poll\ntables:\n  orders: { sync: polling 5s }\n  customers: { sync: poll 500ms }\n`), [
    "sync: poll needs its interval: write poll 5s, poll 5m or poll 1h (at least 1s)",
    "tables.orders.sync: polling is not a sync — did you mean `poll 5s`? Write off, or poll <interval> (poll 5s, poll 5m or poll 1h)",
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
  const db = { tables: [...CATALOG, big, huge], database: "shop", replication: false };
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
      "mason add events_big --sync \"poll 1h\" polls it hourly; mason sync events_big syncs it once, now; mason start --replication keeps every table current from the change log");
    // under a file whose default is off, a big table follows it (nothing to write); with --sync it is what was asked
    const offTop = top.replace("sync: poll 5m", "sync: off");
    assert.deepEqual([E.addEntry(edit(offTop), db, "public.events_big").bigOff, fs.readFileSync(file, "utf8").endsWith("  events_big: {}\n")], [false, true]);
    // a huge table set to poll under a minute: warned, the estimate's basis said — the catalog's rows, nothing measured
    const h = E.addEntry(edit(top), db, "public.huge", ["*"], null, { sync: { mode: "poll", every: "30s", seconds: 30 } });
    assert.equal(h.pollCost, "huge has about 50,000,000 rows, and each poll scans it whole on your database: about 28 s a poll, from the catalog's 50,000,000 rows at an assumed " +
      "1,800,000 rows a second of scan (nothing of it measured yet). sync: poll 30s is stretched to a poll every 2 min at most (a poll waits four times its own time), one backend of " +
      "your database busy 25 % of the time — a longer interval (--sync \"poll 1h\"), or mason start --replication, costs it less");
    // measured by the run: its last poll first, else its copy's read rate a reader
    assert.match(E.pollCost(huge, { mode: "poll", every: "10s", seconds: 10 }, { lastPollMs: 40_000, copyRowsPerSecond: 500_000 })!, /about 40 s a poll, from its last poll, measured\./);
    assert.match(E.pollCost(huge, { mode: "poll", every: "10s", seconds: 10 }, { lastPollMs: null, copyRowsPerSecond: 500_000 })!, /about 2 min a poll, from its first sync's read rate, 500,000 rows a second a reader/);
    assert.equal(E.pollCost(huge, { mode: "poll", every: "1m", seconds: 60 }, null), null, "every minute or slower: no warning");
    assert.equal(E.pollCost(table({ table: "mid", rows: 5_000_000 }), { mode: "poll", every: "5s", seconds: 5 }, null), null, "under ten million rows: none");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
