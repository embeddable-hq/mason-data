/**
 * `mason help`'s guides (src/cli/guides.ts) say only what Mason accepts: their lists are the code's own tables, so they
 * cannot drift; these hold the prose and the examples around them.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GUIDES, guideText } from "../src/cli/guides.ts";

const MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "main.ts");

test("a guide or command mason does not have is refused, listing the guides; the guides print", async () => {
  const r = spawnSync(process.execPath, [MAIN, "help", "nope"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  // a failure's shape (src/cli/command.ts failureText): what is wrong, why, then Next
  assert.match(r.stderr, new RegExp(`^✗ mason help: there is no command or guide "nope"\\n {2}why {3}the guides: ${Object.keys(GUIDES).join(", ")}\\n\\nNext:\\n {2}mason help {2}`));
  for (const g of Object.keys(GUIDES) as Array<keyof typeof GUIDES>) {
    const guide = spawnSync(process.execPath, [MAIN, "help", g], { encoding: "utf8" });
    assert.equal(guide.status, 0, g);
    assert.equal(guide.stdout.trimEnd(), (await guideText(g)).trimEnd(), `${g} prints its text`);
  }
  const old = spawnSync(process.execPath, [MAIN, "docs"], { encoding: "utf8" });
  assert.equal(old.status, 2);
  assert.match(old.stderr, /mason docs is now mason help\n\nNext:\n {2}mason help agent .*\n {2}mason help production /);
});

test("every guide names only commands and flags mason has, and no path the package does not ship", async () => {
  const { COMMANDS } = await import("../src/cli/registry.ts");
  for (const g of Object.keys(GUIDES) as Array<keyof typeof GUIDES>) {
    const text = await guideText(g);
    // a command line (indented, after an environment variable or not) or a command with a flag in the prose
    const used = [...text.matchAll(/(?:^ {4,5}(?:\S+=\S+ )*|\b)mason ([a-z]+)((?: --[a-z-]+(?: "?[^\s"]+"?)?)*)/gm)]
      .filter((m) => /^ {4,5}/.test(m[0]) || m[2] !== "");
    assert.ok(used.length >= 4, `${g} names the road's commands`);
    for (const [whole, name, flags] of used) {
      const cmd = COMMANDS.find((c) => c.name === name);
      assert.ok(cmd, `${g}: ${whole}: no command ${name}`);
      for (const [, flag] of flags!.matchAll(/--([a-z-]+)/g)) assert.ok(Object.hasOwn(cmd.options, flag!), `${g}: ${whole}: mason ${name} has no --${flag}`);
    }
    // a path is a URL, never the repository's own (the package ships none of it)
    for (const m of text.matchAll(/\b(deploy|docs|src)\/\S+/g)) assert.match(text.slice(Math.max(0, m.index! - 60), m.index), /https:\/\/github\.com\/\S*$/, `${g}: ${m[0]} is a repository path`);
  }
});

test("the agent's guide lists every command with --json where it takes it, and every failure code", async () => {
  const { COMMANDS } = await import("../src/cli/registry.ts");
  const { FAILURE_CODES } = await import("../src/cli/command.ts");
  const text = await guideText("agent");
  for (const c of COMMANDS) assert.ok(text.includes(`mason ${c.name}${Object.hasOwn(c.options, "json") ? " --json" : ""}`), `${c.name}${Object.hasOwn(c.options, "json") ? " with --json" : ""}`);
  for (const code of Object.keys(FAILURE_CODES)) assert.match(text, new RegExp(`^ {4}${code} `, "m"), code);
});

test("the agent's guide says what mason init demo adds and the table it leaves for the first mason add, from the seed's lists", async () => {
  const { DEMO_ADDED_TABLES, DEMO_TABLE_TO_ADD } = await import("../src/demo/seed.ts");
  assert.deepEqual([DEMO_ADDED_TABLES, DEMO_TABLE_TO_ADD], [["customers", "products", "orders"], "order_items"]);
  const text = (await guideText("agent")).replace(/\s+/g, " ");
  assert.ok(text.includes("Init adds customers, products, orders; order_items is left to add: mason add order_items --json && mason wait --json, after mason start."), text.slice(-600));
});

test("mason help production says where the metrics are, beside the health check, and that they need no secret", async () => {
  const text = (await guideText("production")).replace(/\s+/g, " ");
  assert.ok(text.includes("GET /metrics on the same port is for Prometheus: numbers only"), text.slice(0, 400));
  assert.ok(text.includes("never a table's or a user's name, so it needs no secret"));
});

test("mason help production says how each table is kept current: sync: at the top and per entry, off by default, the poll's stretch, replication's slot and publication, the flags gone", async () => {
  const text = (await guideText("production")).replace(/\s+/g, " ");
  for (const said of [
    "How each table is kept current after its first sync is the sources file's sync:, committed with it, so the server runs what you ran — at the top for every table, and on an entry for that one:",
    "sync: off the file's default for every table tables: orders: { sync: replication }",
    "off (the default mason init writes): after the first sync Mason reads the table again only when you run mason sync <table>",
    "stretched to four times the last poll's own time, so the polls never take more than a fifth of the database's time",
    "a user with REPLICATION", "publication: ${PG_PUBLICATION} at the top of the sources file",
    "cap it on the database with max_slot_wal_keep_size", "dropped, verified gone, when no table's sync is replication any more",
    "The flags --replication, --poll and --publication of mason start, and MASON_CHANGES on a server, are gone: each answers with the line to write in the sources file.",
    "mason sync customers any table read again now, whatever its sync:",
  ]) assert.ok(text.includes(said), said);
  // the stretch the guide states is the poll's own (src/cdc/poll.ts nextPollDelayMs)
  const { nextPollDelayMs } = await import("../src/cdc/poll.ts");
  assert.equal(nextPollDelayMs(5000, 10_000), 40_000);
});
