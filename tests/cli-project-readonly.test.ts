/**
 * A DEPLOYED PROJECT'S FILES ARE READ-ONLY (issue 473): under `MASON_PROJECT_READONLY=1`, or the record a run started
 * with it makes in the project's config, every writer of a project file asks ONE authority (src/cli/project.ts
 * `projectWriteRefusal`) and writes nothing on its refusal — held here over each writer: the check-and-write of `mason
 * add` and `mason remove` (src/cli/source-edit.ts `sourceToEdit`), the run's `POST /api/pick` and `/api/remove` (the web
 * page's Add and Remove), the commands with the run up (they ask it), `mason serve`'s first sources file (`serveSource`),
 * `mason.yml` (`ensurePin`) and `mason init`. The commands with the run down, and the setting at `mason start`, are the
 * state matrix's (tests/cli-state-matrix.test.ts, "a deployed project"). `/api/state` says why the page offers no Add or
 * Remove, from the same authority. Each "nothing written" compares every file's bytes and mtime.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { createRunServer, type RunContext } from "../src/cli/run-server.ts";
import { parseSource, type SourceTable } from "../src/cli/preflight.ts";
import { init } from "../src/cli/init.ts";
import { ensurePin } from "../src/cli/pin.ts";
import { serveSettings, serveSource, type ServeSettings } from "../src/cli/serve.ts";
import { matrixEnv, runMason } from "./cli-matrix.ts";
// read from the modules, not imported by name: the file loads at a commit without them (scripts/fails-without.ts)
import * as projectModule from "../src/cli/project.ts";
import * as editModule from "../src/cli/source-edit.ts";
const { projectWriteRefusal, projectReadOnlySetting } = projectModule as unknown as {
  projectWriteRefusal: (root: string | null, env: Record<string, string | undefined>) => { message: string; code: string; why?: string; fix?: string; next?: ReadonlyArray<readonly [string, string?]> } | null;
  projectReadOnlySetting: (env: Record<string, string | undefined>) => boolean | { problem: string };
};
const { sourceToEdit, Refusal } = editModule;

const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const temp = (name: string): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `mason-readonly-${name}-`)); made.push(d); return d; };

const SOURCE = "kind: postgres\nurl: postgres://me@127.0.0.1:1/shop\ntables:\n  orders: {}\n";
const READ_ONLY = "the project's files are read-only here (MASON_PROJECT_READONLY=1)";
const RECORDED = "the project's files are read-only here (MASON_PROJECT_READONLY=1 when Mason last started)";
const WHY = "Mason runs them as they were deployed: an edit here would run what nobody committed, and the next deploy would undo it";
const FIX = "edit the files and deploy them: mason add or mason remove where the project is committed, then commit and deploy";

/** A project folder: its sources file naming orders, and a config that records the read-only start or not. */
function project(o: { recorded?: boolean; running?: { port: number; token: string } } = {}): { root: string; folder: string; file: string } {
  const root = temp("project");
  const folder = path.join(root, "mason");
  const file = path.join(folder, "sources", "shop.yml");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, SOURCE);
  fs.mkdirSync(path.join(root, ".mason"), { mode: 0o700 });
  fs.writeFileSync(path.join(root, ".mason", "config.json"), JSON.stringify({ name: "shop", folder: "mason", remote: false, apiKey: "k".repeat(48), sourceServer: null, lastRun: null,
    running: o.running ? { pid: process.pid, controlUrl: `http://127.0.0.1:${o.running.port}`, token: o.running.token, postgresUrl: "postgresql://127.0.0.1:1/shop", postgresListener: { host: "127.0.0.1", tls: null } } : null,
    ...(o.recorded ? { projectReadOnly: true } : {}) }), { mode: 0o600 });
  return { root, folder, file };
}

/** Every file under `dir` but `.mason/`, with its bytes and mtime. */
function files(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const at = path.join(e.parentPath, e.name);
    const rel = path.relative(dir, at);
    if (!rel.startsWith(".mason")) out[rel] = `${fs.statSync(at).mtimeMs} ${fs.readFileSync(at, "base64")}`;
  }
  return out;
}

test("the authority: 1 refuses, 0 and unset do not, the run's record refuses whatever the environment says, and a value it cannot read refuses", () => {
  assert.equal(typeof projectWriteRefusal, "function", "src/cli/project.ts projectWriteRefusal");
  for (const v of [undefined, "", "0"]) assert.equal(projectReadOnlySetting({ MASON_PROJECT_READONLY: v }), false, String(v));
  assert.equal(projectReadOnlySetting({ MASON_PROJECT_READONLY: "1" }), true);
  for (const v of ["yes", "true", "on", "01", " 1", "-1"]) assert.deepEqual(projectReadOnlySetting({ MASON_PROJECT_READONLY: v }),
    { problem: `MASON_PROJECT_READONLY=${JSON.stringify(v)}: 1 (the project's files are deployed, and read-only here) or 0 (the default)` }, v);
  const plain = project();
  assert.equal(projectWriteRefusal(plain.root, {}), null);
  assert.equal(projectWriteRefusal(plain.root, { MASON_PROJECT_READONLY: "0" }), null);
  assert.equal(projectWriteRefusal(null, {}), null);
  assert.deepEqual(projectWriteRefusal(plain.root, { MASON_PROJECT_READONLY: "1" }), { message: READ_ONLY, code: "refused", why: WHY, fix: FIX,
    next: [["mason status", "what Mason syncs here, as the deployed files say"]] });
  assert.equal(projectWriteRefusal(null, { MASON_PROJECT_READONLY: "1" })?.message, READ_ONLY);
  const recorded = project({ recorded: true });
  for (const env of [{}, { MASON_PROJECT_READONLY: "0" }]) assert.equal(projectWriteRefusal(recorded.root, env)?.message, RECORDED, JSON.stringify(env));
  assert.equal(projectWriteRefusal(recorded.root, { MASON_PROJECT_READONLY: "1" })?.message, READ_ONLY);
  const bad = projectWriteRefusal(plain.root, { MASON_PROJECT_READONLY: "yes" });
  assert.equal(bad?.code, "refused");
  assert.match(bad!.message, /^MASON_PROJECT_READONLY="yes": .*, so whether the project's files may be written here cannot be told$/);
  // a config that cannot be read cannot say whether a run recorded it: refused, said
  const broken = project();
  fs.writeFileSync(path.join(broken.root, ".mason", "config.json"), '{"name": "sh');
  assert.match(projectWriteRefusal(broken.root, {})!.message, /^whether the project's files may be written here cannot be told: .*config\.json: it is not valid JSON/);
});

test("the check-and-write of mason add and mason remove (sourceToEdit): refused 409 with the Failure before the file is read, nothing written", () => {
  for (const [p, env, message] of [[project({ recorded: true }), {}, RECORDED], [project(), { MASON_PROJECT_READONLY: "1" }, READ_ONLY]] as const) {
    const was = files(p.root);
    let read = 0;
    assert.throws(() => sourceToEdit(p.folder, p.root, () => { read++; return { message: "never asked", code: "bad_source" }; }, env), (e: unknown) => {
      assert.ok(e instanceof Refusal);
      assert.equal(e.status, 409);
      assert.deepEqual([e.message, e.failure.message, e.failure.code, e.failure.why, e.failure.fix], [message, message, "refused", WHY, FIX]);
      return true;
    });
    assert.equal(read, 0, "the file's URL is not even resolved");
    assert.deepEqual(files(p.root), was);
  }
  // unset: the edit goes on as before (here to the file's URL, which this test's reader refuses)
  const p = project();
  assert.throws(() => sourceToEdit(p.folder, p.root, () => ({ message: "the reader's own refusal", code: "bad_source" }), {}), /the reader's own refusal/);
});

test("mason.yml (ensurePin) is not written into a read-only project; unset, it is", () => {
  for (const [p, env] of [[project({ recorded: true }), {}], [project(), { MASON_PROJECT_READONLY: "1" }]] as const) {
    const was = files(p.root);
    assert.equal(ensurePin(p.folder, "1.2.3", p.root, env), null);
    assert.deepEqual(files(p.root), was);
  }
  const p = project();
  assert.equal(ensurePin(p.folder, "1.2.3", p.root, {}), path.join(p.folder, "mason.yml"));
});

test("mason serve: MASON_PROJECT_READONLY is read as 1 or 0 on its settings' one report, and a deployed folder with no sources file gets none", () => {
  const cwd = temp("serve");
  const base = { DATABASE_URL: "postgres://me@127.0.0.1:1/shop", MASON_API_KEY: "k".repeat(48) };
  for (const v of ["1", "0", ""]) assert.ok(!("message" in serveSettings({ ...base, MASON_PROJECT_READONLY: v }, cwd)), v);
  for (const v of ["yes", "2", "abc", "-1", "1.5"]) {
    const s = serveSettings({ ...base, MASON_PROJECT_READONLY: v }, cwd);
    assert.ok("message" in s, v);
    assert.ok(s.message.includes(`MASON_PROJECT_READONLY=${JSON.stringify(v)}: 1 (the project's files are deployed, and read-only here) or 0 (the default)`), s.message);
  }
  const settings = serveSettings(base, cwd) as ServeSettings;
  fs.mkdirSync(settings.project, { recursive: true });
  const was = files(cwd);
  const refused = serveSource(settings, { ...base, MASON_PROJECT_READONLY: "1" });
  assert.ok("message" in refused);
  assert.deepEqual([refused.code, refused.message, refused.why], ["refused", `the project folder (${settings.project}) has no sources file, and ${READ_ONLY}`, WHY]);
  assert.match(refused.fix!, /^edit the files and deploy them: /);
  assert.deepEqual(refused.next, [["mason serve --help", "every setting, with its default"]], "a serve that did not start: its settings, not mason status");
  assert.deepEqual(files(cwd), was, "no sources file written");
  const wrote = serveSource(settings, base);
  assert.ok(!("message" in wrote) && wrote.wrote !== null, "unset: the file mason init writes, as before");
});

test("mason init under the setting: refused before the database is asked, nothing written; and in a project with no sources file a run recorded it in", async () => {
  const said: string[] = [];
  const io = { out: (m: string) => { said.push(m); }, err: (m: string) => { said.push(m); } };
  const empty = temp("init");
  assert.equal(await init(["postgres://me@127.0.0.1:1/shop", "--json"], empty, { io, env: { MASON_PROJECT_READONLY: "1" } }), 1);
  const v = JSON.parse(said.join("\n")) as { error: { code: string; message: string; why: string; fix: string } };
  assert.deepEqual([v.error.code, v.error.message, v.error.why, v.error.fix], ["refused", READ_ONLY, WHY, FIX]);
  assert.deepEqual(fs.readdirSync(empty), []);
  // a project with no sources file (whose sources file alone init writes): its run's record refuses it
  const p = project({ recorded: true });
  fs.rmSync(p.file);
  const was = files(p.root);
  said.length = 0;
  assert.equal(await init(["--json"], p.root, { io, env: {} }), 1);
  assert.equal((JSON.parse(said.join("\n")) as { error: { message: string } }).error.message, RECORDED);
  assert.deepEqual(files(p.root), was);
});

// ---------------------------------------------------------------- the run's command server, and the commands that ask it

const parsed = parseSource("postgres://me@127.0.0.1:1/shop");
const source = "source" in parsed ? parsed.source : assert.fail(parsed.problem);
const col = (name: string, type = "bigint") => ({ name, type, notNull: name === "id", comment: null });
const catalog: SourceTable[] = ["orders", "customers"].map((t) => ({ source: `public.${t}`, schema: "public", table: t, key: ["id"], rows: 3, bytes: 8192, comment: null,
  columns: [col("id"), col("note", "text")], foreignKeys: [] }));
const TOKEN = "r".repeat(64);

/** A run's command server over `p`, its copies faked: what mason add and remove ask with Mason up, and the page asks. */
async function runOver(p: { root: string; folder: string; file: string }): Promise<{ port: number; close: () => void }> {
  const ctx = {
    source, facts: () => ({ version: 160000, versionText: "16", standby: false, tables: catalog, systemIdentifier: null }), warnings: [], replication: () => null,
    port: 0, token: TOKEN, page: false, served: true, users: { file: path.join(p.root, ".mason", "users.json"), apiKey: "k".repeat(48), database: "shop", postgresUrl: "postgresql://127.0.0.1:1/shop" },
    listener: { openSessions: () => ({ open: 0, byClient: [] }), running: () => [] }, folder: () => p.folder, root: p.root, home: path.join(p.root, ".mason"), version: "test", startedAt: Date.now(),
    sourcesChanged: () => undefined, log: () => undefined, runUrl: "postgres://me@127.0.0.1:1/shop",
    readSource: () => ({ name: "shop", file: p.file, kind: "postgres", url: { literal: "postgres://me@127.0.0.1:1/shop" }, tables: [{ name: "orders", table: "public.orders", columns: null, exclude: [], key: null }],
      resolved: "postgres://me@127.0.0.1:1/shop", from: "the sources file" }),
    sources: () => ({ file: { name: "shop", file: p.file, kind: "postgres", url: { literal: "postgres://me@127.0.0.1:1/shop" }, tables: [{ name: "orders", table: "public.orders", columns: null, exclude: [], key: null }] }, problem: null }),
    duck: { copies: () => [], file: path.join(p.root, ".mason", "duck.db"), poll: async () => ({ at: "", tables: [] }), stream: async () => null, disk: () => ({ path: "/x", freeBytes: null, projectedBytes: null }),
      restarts: () => [], requests: { days: 7 } },
  } as unknown as RunContext;
  const server = createRunServer(ctx);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  ctx.port = (server.address() as { port: number }).port;
  return { port: ctx.port, close: () => { server.close(); } };
}

function call(port: number, method: string, at: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port, method, path: at, headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${TOKEN}`,
      ...(text ? { "Content-Type": "application/json" } : {}) } }, (res) => {
      let got = "";
      res.on("data", (b: Buffer) => { got += b.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(got) as Record<string, unknown> }));
    });
    req.on("error", reject);
    req.end(text);
  });
}

test("the run's POST /api/pick and /api/remove (the page's Add and Remove) are refused 409 with the Failure, nothing written; /api/state says why the page offers neither", async () => {
  const p = project({ recorded: true });
  const run = await runOver(p);
  try {
    const was = files(p.root);
    for (const [route, body] of [["/api/pick", { table: "public.customers", picked: true }], ["/api/pick", { table: "public.orders", picked: false }],
      ["/api/pick", { table: "public.orders", picked: true, sync: "poll 30s", keep: true }], ["/api/remove", { tables: ["public.orders"] }]] as const) {
      const r = await call(run.port, "POST", route, body);
      assert.equal(r.status, 409, `${route} ${JSON.stringify(body)}`);
      assert.equal(r.json.error, RECORDED);
      assert.deepEqual(r.json.failure, { code: "refused", message: RECORDED, why: WHY, fix: FIX, next: [{ command: "mason status", what: "what Mason syncs here, as the deployed files say" }] });
      assert.deepEqual(files(p.root), was, `${route}: nothing written`);
    }
    const state = await call(run.port, "GET", "/api/state");
    assert.equal(state.json.sourcesReadOnly, `${RECORDED}; ${FIX}`);
  } finally { run.close(); }
  // without the record or the setting: the page offers Add and Remove, and an add is written as before
  const open = project();
  const run2 = await runOver(open);
  try {
    assert.equal((await call(run2.port, "GET", "/api/state")).json.sourcesReadOnly, null);
    const added = await call(run2.port, "POST", "/api/pick", { table: "public.customers", picked: true });
    assert.equal(added.status, 200, JSON.stringify(added.json));
    assert.match(fs.readFileSync(open.file, "utf8"), /customers: \{\}/);
  } finally { run2.close(); }
});

test("mason add and mason remove with Mason up, beside a run that started read-only: refused with the Failure, whatever this shell says, nothing written", async () => {
  const p = project();
  const run = await runOver(p);
  try {
    // the project the commands run in names this run as up, and records its read-only start
    const config = JSON.parse(fs.readFileSync(path.join(p.root, ".mason", "config.json"), "utf8")) as Record<string, unknown>;
    fs.writeFileSync(path.join(p.root, ".mason", "config.json"), JSON.stringify({ ...config, projectReadOnly: true,
      running: { pid: process.pid, controlUrl: `http://127.0.0.1:${run.port}`, token: TOKEN, postgresUrl: "postgresql://127.0.0.1:1/shop", postgresListener: { host: "127.0.0.1", tls: null } } }), { mode: 0o600 });
    const was = files(p.root);
    for (const env of [{}, { MASON_PROJECT_READONLY: "0" }]) {
      for (const argv of [["add", "customers"], ["remove", "orders"]]) {
        const a = await runMason(p.root, [...argv, "--json"], matrixEnv(env));
        assert.equal(a.code, 1, a.stdout + a.stderr);
        const v = JSON.parse(a.stdout) as { error: { code: string; message: string; why: string; fix: string }; next: Array<{ command: string }> };
        assert.deepEqual([v.error.code, v.error.message, v.error.why, v.error.fix, v.next.map((n) => n.command)], ["refused", RECORDED, WHY, FIX, ["mason status"]], `${argv.join(" ")} ${JSON.stringify(env)}`);
        assert.deepEqual(files(p.root), was);
      }
    }
    // the run says the same, from the same record: the page offers no Add or Remove
    assert.equal((await call(run.port, "GET", "/api/state")).json.sourcesReadOnly, `${RECORDED}; ${FIX}`);
  } finally { run.close(); }
});
