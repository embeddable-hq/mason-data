/**
 * THE RUN DOWNLOADS NOTHING WITH THE PLATFORM PACKAGE PRESENT (src/duck/extensions.ts): a store opened over this
 * machine's @mason-data/extensions-<platform> (cli/extensions.ts builds it into cli/platforms/, the real files,
 * held to their pins; CI builds linux-x64 before this file runs), installed READ-ONLY in a node_modules of its own, with
 * HOME an empty folder (where DuckDB would install, ~/.duckdb/extensions) — copies a table with inet columns from a
 * real Postgres and casts a text to inet, and afterwards the HOME is still empty, the package unchanged, autoinstall
 * off, and every extension loaded is the package's file.
 *
 * What it needs: IT_POSTGRES_URL, psql on PATH. It writes only inside a database it creates and drops.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DuckStore } from "../../src/duck/store.ts";
import { Sync, type AddedTable } from "../../src/duck/sync.ts";
import { parseSource } from "../../src/cli/preflight.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const adminUrl = process.env.IT_POSTGRES_URL;
const tag = `it_ext_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const dbUrl = adminUrl ? (() => { const u = new URL(adminUrl); u.pathname = `/${tag}`; return u.toString(); })() : "";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "it-ext-"));

function psql(url: string, sql: string): string {
  const r = spawnSync("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", url, "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim()}\n  in: ${sql}`);
  return r.stdout.trim();
}

/** Every file under a folder with its size: what a download would change. */
const listing = (d: string): string[] => fs.existsSync(d)
  ? (fs.readdirSync(d, { recursive: true, withFileTypes: true }) as fs.Dirent[]).filter((e) => e.isFile()).map((e) => `${path.relative(d, path.join(e.parentPath, e.name))} ${fs.statSync(path.join(e.parentPath, e.name)).size}`).sort()
  : [];

const HOME_BEFORE = process.env.HOME;
after(() => {
  process.env.HOME = HOME_BEFORE;
  // read-only below: writable again so it can be removed
  spawnSync("chmod", ["-R", "u+w", dir]);
  fs.rmSync(dir, { recursive: true, force: true });
  if (adminUrl) psql(adminUrl, `DROP DATABASE IF EXISTS ${tag} WITH (FORCE)`);
});

const T: AddedTable = {
  source: "public.hosts", schema: "public", table: "hosts", key: ["id"], bytes: 0, rows: null, foreignKeys: [],
  columns: [{ name: "id", type: "integer", notNull: true, comment: null }, { name: "ip", type: "inet", notNull: false, comment: null },
    { name: "ips", type: "inet[]", notNull: false, comment: null }, { name: "s", type: "text", notNull: false, comment: null }],
};

test("with the platform package present, the copy and an inet cast work and nothing is downloaded", { skip: adminUrl ? false : "IT_POSTGRES_URL is not set" }, async () => {
  // imported when the test runs: at a commit without the module the file still loads, and this test fails by name;
  // only a module that is not there is absent, any other failure to load it is thrown
  const absent = (e: unknown): null => { if ((e as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") return null; throw e; };
  const x = await import("../../src/duck/extensions.ts" as string).catch(absent) as typeof import("../../src/duck/extensions.ts") | null;
  const b = await import("../../cli/extensions.ts" as string).catch(absent) as typeof import("../../cli/extensions.ts") | null;
  assert.ok(x && b, "src/duck/extensions.ts and cli/extensions.ts exist");
  const key = x.hostKey(x.thisHost());
  assert.ok(key in x.EXTENSION_PLATFORMS, `a package is built for this machine (${key})`);
  const platform = key as keyof typeof x.EXTENSION_PLATFORMS;
  // the real package, built (or kept, when its files are the pinned ones) as CI and the release build it, at the CLI's
  // version: cli/platforms/ is what the release publishes
  const built = path.join(ROOT, "cli", "platforms", platform);
  const cliVersion = (JSON.parse(fs.readFileSync(path.join(ROOT, "cli", "package.json"), "utf8")) as { version: string }).version;
  await b.buildPackage({ manifest: b.readManifest(), platform, cliVersion, dir: built });
  // installed as npm would install it, read-only, and found by the resolver as the run finds it
  const modules = path.join(dir, "node_modules");
  const installed = path.join(modules, x.packageName(platform));
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.cpSync(built, installed, { recursive: true });
  spawnSync("chmod", ["-R", "a-w", installed]);
  const found = x.findExtensions({ resolve: (id) => path.join(modules, id) });
  assert.equal(found.shipped, true, found.shipped ? "" : found.why);
  const before = listing(installed);
  // where DuckDB installs by default: an empty HOME, which must stay empty
  const home = path.join(dir, "home");
  fs.mkdirSync(home);
  process.env.HOME = home;

  psql(adminUrl!, `CREATE DATABASE ${tag}`);
  psql(dbUrl, "CREATE TABLE hosts (id int PRIMARY KEY, ip inet, ips inet[], s text); " +
    "INSERT INTO hosts VALUES (1, '10.0.0.1', '{10.0.0.2,::1}', '192.168.1.7'), (2, '::1', NULL, '10.1.2.3/8')");
  const parsed = parseSource(dbUrl);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const logged: string[] = [];
  const store = await DuckStore.open(path.join(dir, "duck.db"), (l) => logged.push(l), { extensions: found });
  const sync = new Sync(store, parsed.source, tag, (l) => logged.push(l), 3_600_000, "poll");
  try {
    await sync.open();
    await sync.setTables([T]);
    await sync.once();
    const rows = (await store.writer.runAndReadAll("SELECT id, ip, ips[1], ips[2], s FROM public.hosts ORDER BY id")).getRowsJS();
    assert.deepEqual(rows, [[1, "10.0.0.1/32", "10.0.0.2/32", "::1/128", "192.168.1.7"], [2, "::1/128", null, null, "10.1.2.3/8"]], logged.join("\n"));
    // a text cast to inet: DuckDB's inet type, autoloaded from the package
    const cast = (await store.writer.runAndReadAll("SELECT host(s::inet), family(s::inet) FROM public.hosts ORDER BY id")).getRowsJS();
    assert.deepEqual(cast, [["192.168.1.7", 4], ["10.1.2.3", 4]]);
    const settings = (await store.writer.runAndReadAll("SELECT current_setting('autoinstall_known_extensions'), current_setting('extension_directory')")).getRowsJS();
    assert.deepEqual(settings, [[false, found.shipped ? found.directory : ""]]);
    const loaded = (await store.writer.runAndReadAll("SELECT extension_name, install_path FROM duckdb_extensions() WHERE loaded AND install_mode <> 'STATICALLY_LINKED' ORDER BY 1")).getRowsJS();
    assert.deepEqual(loaded.map((r) => r[0]), ["inet", "postgres_scanner"]);
    for (const [name, at] of loaded) assert.ok(String(at).startsWith(installed), `${String(name)} loaded from the package, not ${String(at)}`);
    assert.ok(!logged.some((l) => /not installed with Mason/.test(l)), "no fallback said");
  } finally {
    await sync.stop();
    await store.close();
  }
  assert.deepEqual(listing(home), [], "nothing was installed under HOME");
  assert.deepEqual(listing(installed), before, "the package is as npm installed it");
});
