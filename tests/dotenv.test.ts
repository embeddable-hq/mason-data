/**
 * ONE `.env` READER, AND THE ENVIRONMENT WINS (src/lib/dotenv.ts).
 *
 * Four host scripts of the ClickHouse stack this was cut from carried their own `.env` parser, and three
 * ignored the environment — so under a second stack's `stack.env` its web UI read the first stack's
 * ClickHouse and its backfill would have copied into it. The rule is docker compose's: the shell first,
 * `.env` fills in.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { parseDotenv, readEnv } from "../src/lib/dotenv.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("parseDotenv: KEY=value lines, quotes stripped, comments and blanks skipped", () => {
  assert.deepEqual(parseDotenv("# c\n\nA=1\nB = 'two'\nC=\"x=y\"\nnot a line\n"), { A: "1", B: "two", C: "x=y" });
});

test("readEnv: the process environment wins over .env, and .env fills in the rest", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dotenv-"));
  try {
    fs.writeFileSync(path.join(dir, ".env"), "CLICKHOUSE_HTTP_PORT=8123\nPG_DATABASE=shop_dev\nONLY_IN_FILE=f\n");
    const env = readEnv(dir, { CLICKHOUSE_HTTP_PORT: "8125", PG_DATABASE: "shop", EMPTY: "" });
    assert.equal(env.CLICKHOUSE_HTTP_PORT, "8125");
    assert.equal(env.PG_DATABASE, "shop");
    assert.equal(env.ONLY_IN_FILE, "f");
    assert.equal(env.EMPTY, "", "a variable set empty in the shell is still set, as in dotenv.sh");
    assert.deepEqual(readEnv(path.join(dir, "nowhere"), {}), {}, "no .env is no variables, not an error");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("no host script parses .env on its own", () => {
  const allowed = new Set(["src/lib/dotenv.ts"]);
  const offenders: string[] = [];
  const dirs = ["scripts", "src", ...fs.readdirSync(path.join(ROOT, "src"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => `src/${e.name}`)];
  for (const dir of dirs) {
    for (const f of fs.readdirSync(path.join(ROOT, dir)).filter((x) => x.endsWith(".ts"))) {
      const rel = `${dir}/${f}`;
      if (allowed.has(rel)) continue;
      const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
      if (/["']\.env["']/.test(src) || /function readEnv\b/.test(src)) offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, [], "read configuration through src/lib/dotenv.ts readEnv");
});
