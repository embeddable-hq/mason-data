/**
 * A REFUSAL NEVER QUOTES A ROW (issue 128): Mason's own refusal, 0A000 raised while rows are read, reaches any user, in
 * a BI tool's error box and the request log, and it names a gap, not a value: `libc-uncovered` quoted a row's text. Over
 * the wire, for a user of a filtered role, each refusal raised at a row is asked of a row the user may read and of one
 * it may not, and neither row's value appears in the message, the DETAIL or the HINT. (Postgres's own errors, a bad
 * cast's 22P02, quote what Postgres quotes: that is its answer. `tests/conventions.test.ts` holds the class in the source.)
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pg from "pg";
import { DuckStore } from "../src/duck/store.ts";
import { startPostgresApi, type PgApiServer } from "../src/api/postgres/server.ts";
import type { PgSchema } from "../src/api/postgres/schema.ts";
import { changeUsers, keyFingerprint, listenerLogins, LiveUsers, newUserId, userPassword } from "../src/duck/users.ts";
import { LiveRoles } from "../src/cli/roles.ts";
import type { LibcOrder } from "../src/duck/libc-order.ts";
import { handLibcOrder, lettersOf } from "./libc-order-fixture.ts";

const KEY = "k".repeat(48);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-refusal-values-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

/** an order covering ASCII's letters and digits alone, so a value with any other character is refused */
const asciiOrder = (): LibcOrder => handLibcOrder([..."0123456789", ...lettersOf()], [" "]);

const MARK = "́";
/** what a refusal must not say: the words each row's values hold */
const VISIBLE = ["visiblesecret", "BBB", "111111111111111111111111", "NaN", "infinity", "tomorrow"];
const HIDDEN = ["hiddensecret", "CCC", "222222222222222222222222"];

test("a refusal raised at a row says the gap, never the row's value, for a user of a filtered role", async () => {
  const root = path.join(dir, "project"), home = path.join(root, ".mason"), folder = path.join(root, "mason");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(folder, "sources"), { recursive: true });
  fs.writeFileSync(path.join(folder, "roles.yml"), `default: tenant
roles:
  tenant:
    attributes: [tenant]
    tables:
      notes: { where: "tenant_id = :tenant" }
`);
  const usersFile = path.join(home, "users.json");
  const id = newUserId();
  changeUsers(usersFile, () => [{ name: "acme", id, addedAt: new Date().toISOString(), key: keyFingerprint(KEY), role: "tenant", attributes: { tenant: "1" } }]);

  const store = await DuckStore.open(path.join(home, "duck.db"), () => undefined);
  let api: PgApiServer | null = null;
  try {
    await store.writer.run("CREATE TABLE public.notes (id BIGINT, tenant_id INTEGER, label VARCHAR, zone VARCHAR, big VARCHAR, special VARCHAR, span VARCHAR, moment VARCHAR, ts TIMESTAMPTZ)");
    await store.writer.run(`INSERT INTO public.notes VALUES
      (1, 1, 'plain', 'UTC', '1', '1', '1 day', '2024-01-01', '2024-01-01'),
      (2, 1, 'visiblesecret${MARK}', 'BBB', '111111111111111111111111.5', 'NaN', 'infinity', 'tomorrow', '2024-01-01'),
      (3, 2, 'hiddensecret${MARK}', 'CCC', '222222222222222222222222.5', 'Infinity', 'infinity', 'tomorrow', '2024-01-01')`);
    const text = (name: string): { name: string; type: "text" } => ({ name, type: "text" });
    const schema: PgSchema = { database: "app", tables: [{ name: "notes", primaryKey: ["id"], joins: [],
      columns: [{ name: "id", type: "int8" }, { name: "tenant_id", type: "int4" }, ...["label", "zone", "big", "special", "span", "moment"].map(text), { name: "ts", type: "timestamptz" }] }] };
    const copied = [{ source: "public.notes", columns: schema.tables[0]!.columns.map((c) => ({ name: c.name })), key: ["id"], foreignKeys: [] }];
    const live = new LiveRoles(folder, root, () => copied as never);
    api = await startPostgresApi({
      port: 0, host: "127.0.0.1", tls: null, database: "app", masonVersion: "test",
      ...listenerLogins(new LiveUsers(usersFile, KEY), KEY), recheckMs: 0,
      roles: () => live.now() as never, schema: () => schema, record: () => undefined, log: () => undefined,
      duck: await store.listener({ provider: "c", collate: "en_US.utf8", locale: null }, null, asciiOrder()),
    });
    const c = new pg.Client({ host: "127.0.0.1", port: api.port, database: "app", user: "acme", password: userPassword(KEY, "acme", id) });
    await c.connect();
    try {
      // the filter holds: the hidden row is not read
      for (let i = 0; ; i++) {
        const read = await c.query("SELECT id FROM notes ORDER BY id").then((r) => r.rows.map((x: { id: string }) => x.id), (x: pg.DatabaseError) => x);
        if (read instanceof Error && read.code === "57P03" && i < 50) { await new Promise((r) => setTimeout(r, 100)); continue; }
        assert.deepEqual(read, ["1", "2"]);
        break;
      }
      for (const [gap, sql] of [
        ["libc-uncovered", "SELECT label FROM notes ORDER BY label"],
        ["libc-uncovered", "SELECT min(label) FROM notes"],
        ["libc-uncovered", "SELECT id FROM notes WHERE label > 'a'"],
        ["zone-abbreviation", "SELECT ts AT TIME ZONE zone FROM notes WHERE id = 2"],
        ["numeric-exact-sum", "SELECT sum(big::numeric) FROM notes"],
        ["numeric-special", "SELECT special::numeric(10, 2) FROM notes"],
        ["numeric-special", "SELECT special::numeric + 1 FROM notes"],
        ["infinite-interval", "SELECT span::interval FROM notes"],
        ["relative-time-literal", "SELECT moment::timestamptz FROM notes"],
      ] as const) {
        const e = await c.query(sql).then(() => null, (x: pg.DatabaseError) => x);
        assert.ok(e !== null, `refused: ${sql}`);
        const said = [e.message, e.detail ?? "", e.hint ?? ""].join("\n");
        assert.equal(e.code, "0A000", `${sql}: ${said}`);
        assert.match(said, new RegExp(`Mason gap ${gap}`), sql);
        // the words of a gap's own explanation are the gap's; the value is what must not be said
        const words = gap === "numeric-special" ? VISIBLE.filter((v) => v !== "NaN") : gap === "infinite-interval" ? VISIBLE.filter((v) => v !== "infinity") : gap === "relative-time-literal" ? VISIBLE.filter((v) => v !== "tomorrow") : VISIBLE;
        for (const v of [...words, ...HIDDEN]) assert.ok(!said.includes(v), `${sql} quotes a row's value: ${said}`);
        assert.ok(!/U\+[0-9A-F]{4}/.test(said) && !said.includes(MARK), `${sql} says a row's character: ${said}`);
      }
    } finally { await c.end(); }
  } finally { await api?.close(); store.close(); }
});
