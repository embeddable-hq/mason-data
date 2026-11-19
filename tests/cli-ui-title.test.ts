/**
 * `MASON_UI_TITLE_FILE` (src/cli/ui-title.ts, issue 1181): `mason serve`'s web page shows the first line of a file in its
 * header box, in place of the database's name. The file is read bounded, as plain text, again each time the page loads
 * (never on the page's polls), and a file that gives no label leaves the box as it is without the setting, said by
 * `mason status` and its `--json`, and logged once per reason. Unset, `/api/state` and `mason status` are as before.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRunServer, type RunContext } from "../src/cli/run-server.ts";
import { parseSource } from "../src/cli/preflight.ts";
import * as serveModule from "../src/cli/serve.ts";
import * as projectModule from "../src/cli/project.ts";
import * as commandsModule from "../src/cli/commands.ts";
import { matrixEnv, runMason } from "./cli-matrix.ts";

// imported when the tests run: the file loads at a commit without the module, and each test that needs it fails by name
const titleModule = await import("../src/cli/ui-title.ts" as string).catch(() => ({})) as Partial<typeof import("../src/cli/ui-title.ts")>;
const missing = (): never => assert.fail("src/cli/ui-title.ts is not in this tree");
const readTitleFile = titleModule.readTitleFile ?? missing;
const uiTitleFileSetting = titleModule.uiTitleFileSetting ?? missing;
const TitleFile = titleModule.TitleFile ?? (class { constructor() { missing(); } } as unknown as NonNullable<typeof titleModule.TitleFile>);
const { serveSettings, SERVE } = serveModule as unknown as typeof import("../src/cli/serve.ts");
const { newConfig, startSettingRefusal } = projectModule as unknown as typeof import("../src/cli/project.ts");

const KEY = "k".repeat(48);
const ENV = { DATABASE_URL: "postgres://mason:secret@db.internal:5432/app", MASON_API_KEY: KEY };
const made: string[] = [];
after(() => { for (const d of made) { fs.chmodSync(d, 0o700); fs.rmSync(d, { recursive: true, force: true }); } });
const tmp = (prefix = "mtitle-"): string => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); made.push(d); return d; };
const project = (): Parameters<typeof startSettingRefusal>[0] => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "mason", "sources"), { recursive: true });
  return { root: dir, folder: path.join(dir, "mason"), config: newConfig("shop", "mason") } as unknown as Parameters<typeof startSettingRefusal>[0];
};
const file = (content: string | Buffer): string => { const f = path.join(tmp(), "title.txt"); fs.writeFileSync(f, content); return f; };
const label = async (content: string | Buffer): Promise<string | null> => (await readTitleFile(file(content))).label;
const problemOf = async (f: string): Promise<string | null> => (await readTitleFile(f)).problem?.code ?? null;

// ------------------------------------------------------------------ the reader

test("the first line only, as plain text: \\n, \\r\\n or \\r ends it; trimmed; a BOM dropped; white space made one space", async () => {
  assert.equal(await label("Production analytics (EU)\nsecond line\n"), "Production analytics (EU)");
  assert.equal(await label("Production analytics (EU)\r\nsecond line\r\n"), "Production analytics (EU)", "CRLF: no \\r kept");
  assert.equal(await label("Old Mac\rsecond"), "Old Mac");
  assert.equal(await label("no line end at all"), "no line end at all");
  assert.equal(await label("   padded   \n"), "padded");
  assert.equal(await label("﻿with a BOM\n"), "with a BOM");
  assert.equal(await label("a\tb    c\n"), "a b c", "a tab is a space, runs of white space one space");
  assert.equal(await label("Données de prod · 東京 🇯🇵\n"), "Données de prod · 東京 🇯🇵", "any script, emoji included");
  assert.equal(await label("<b>\"bold\"</b> & 'x'\n"), "<b>\"bold\"</b> & 'x'", "the run keeps it as text: the page escapes it");
});

test("control and invisible characters: a control is a space, a bidi control or zero-width character dropped, the joiners kept", async () => {
  assert.equal(await label("a\u0000b\u0007c\u001bd\u007fe\n"), "a b c d e", "C0, DEL: a space each");
  assert.equal(await label("a\u0085b c d\n"), "a b c d", "NEL and the line and paragraph separators: a space");
  assert.equal(await label("safe‮gnp.exe‬\n"), "safegnp.exe", "a bidi override dropped: it cannot reorder the page's text");
  assert.equal(await label("⁦iso⁩‎‏؜\n"), "iso", "isolates and marks dropped");
  assert.equal(await label("zero​width­soft⁠joiner\n"), "zerowidthsoftjoiner");
  assert.equal(await label("👩‍💻 ab‌c\n"), "👩‍💻 ab‌c", "ZWJ and ZWNJ kept: emoji and scripts need them");
  assert.equal(await label("‮​\t \n"), null, "nothing left: no label");
});

test("a line over 80 characters is cut on a whole character, ending in …; never inside a UTF-8 sequence or an emoji", async () => {
  const MAX = titleModule.TITLE_CHARS_MAX ?? missing();
  assert.equal(MAX, 80);
  assert.equal(await label(`${"x".repeat(80)}\n`), "x".repeat(80), "80 is kept whole");
  assert.equal(await label(`${"x".repeat(81)}\n`), `${"x".repeat(79)}…`);
  const cut = (await label(`${"é".repeat(200)}\n`))!;
  assert.equal(cut, `${"é".repeat(79)}…`, "two-byte characters: whole ones");
  const emoji = (await label(`${"a".repeat(78)}👍🏽 tail\n`))!;
  assert.equal(emoji, `${"a".repeat(78)}…`, "an emoji with its modifier (two code points) that does not fit is left out whole");
  assert.ok([...emoji].length <= MAX);
  const words = (await label(`${"word ".repeat(40)}\n`))!;
  assert.ok(!/ …$/.test(words) && words.endsWith("…"), "no space before the …");
});

test("a huge file is read only to the 1024-byte cap: its first line within it, a character cut by the cap left out, never called bad UTF-8", async () => {
  assert.equal(titleModule.TITLE_BYTES_MAX, 1024);
  const big = path.join(tmp(), "big.txt");
  // 32 MiB of one line: what is read is the first 1024 bytes alone, whatever the file's size
  fs.writeFileSync(big, Buffer.alloc(32 * 1024 * 1024, "y"));
  const opened: number[] = [];
  const real = fs.promises.open;
  // count the bytes asked of the file: the reader's handle is wrapped to record each read's length
  (fs.promises as { open: typeof real }).open = (async (...a: Parameters<typeof real>) => {
    const h = await real(...a);
    const read = h.read.bind(h) as (b: Buffer, o: number, l: number, p: number) => Promise<{ bytesRead: number }>;
    (h as unknown as { read: typeof read }).read = async (b, o, l, p) => { opened.push(l); return read(b, o, l, p); };
    return h;
  }) as typeof real;
  try {
    const t = await readTitleFile(big);
    assert.equal(t.label, `${"y".repeat(79)}…`);
  } finally { (fs.promises as { open: typeof real }).open = real; }
  assert.ok(opened.length > 0 && opened.reduce((a, b) => a + b, 0) <= 1024, `asked for ${opened.join("+")} bytes`);
  // a three-byte character cut by the cap (bytes 1023-1025): left out, the line before it kept
  const cutAtCap = Buffer.concat([Buffer.alloc(1023, " "), Buffer.from("€ more")]);
  assert.equal(await label(Buffer.concat([Buffer.from("A"), cutAtCap.subarray(1)])), "A");
  // a newline past the cap is never reached: the line is what the cap held
  assert.equal(await label(`${"z".repeat(2000)}\nsecond`), `${"z".repeat(79)}…`);
});

test("a failure gives no label and says why, by a stable code: empty, missing, a folder, a pipe, no permission, bad UTF-8", async () => {
  assert.deepEqual(await readTitleFile(file("")), { label: null, problem: { code: "empty", message: "its first line is empty" } });
  assert.equal(await problemOf(file("\nsecond line")), "empty", "an empty first line: no label, though the second has words");
  assert.deepEqual(await readTitleFile(path.join(tmp(), "nope.txt")), { label: null, problem: { code: "missing", message: "the file does not exist" } });
  assert.equal(await problemOf(path.join(file("x"), "under-a-file")), "missing", "a path through a file");
  assert.deepEqual(await readTitleFile(tmp()), { label: null, problem: { code: "not_a_file", message: "it names a folder, not a file" } });
  if (process.platform !== "win32") {
    const fifo = path.join(tmp(), "pipe");
    const { execFileSync } = await import("node:child_process");
    execFileSync("mkfifo", [fifo]);
    // no writer: a blocking open would wait for ever; the reader opens it without blocking, and refuses it
    assert.equal(await problemOf(fifo), "not_a_file", "a pipe: refused, never waited on");
    if (process.getuid?.() !== 0) {
      const locked = file("secret label\n");
      fs.chmodSync(locked, 0o000);
      assert.deepEqual(await readTitleFile(locked), { label: null, problem: { code: "no_permission", message: "Mason's user may not read it" } });
      const shut = tmp();
      const inside = path.join(shut, "t.txt");
      fs.writeFileSync(inside, "label\n");
      fs.chmodSync(shut, 0o000);
      assert.equal(await problemOf(inside), "no_permission", "a folder Mason may not enter");
      fs.chmodSync(shut, 0o700);
    }
  }
  assert.deepEqual(await readTitleFile(file(Buffer.from([0x41, 0xff, 0x42, 0x0a]))), { label: null, problem: { code: "not_utf8", message: "its first line is not UTF-8 text" } });
  assert.equal(await problemOf(file(Buffer.from([0x41, 0xc3, 0x0a]))), "not_utf8", "a sequence the line ends inside");
  assert.equal(await problemOf(file(Buffer.from([0xed, 0xa0, 0x80, 0x0a]))), "not_utf8", "a surrogate encoded");
  assert.equal(await label(Buffer.concat([Buffer.from("fine\n"), Buffer.from([0xff, 0xfe])])), "fine", "bad bytes after the first line are not read as its");
  // nothing said names the path: the page and its log are read by every viewer
  for (const f of [path.join(tmp(), "secret-name.txt"), tmp()]) assert.ok(!JSON.stringify(await readTitleFile(f)).includes(path.basename(f)));
});

test("TitleFile: read() reads now, last() says the last read; each reason logged once, never again on each load", async () => {
  const f = path.join(tmp(), "title.txt");
  const lines: string[] = [];
  const t = new TitleFile(f, (l) => lines.push(l));
  assert.deepEqual(t.last(), { label: null, problem: null }, "before the first read");
  for (let i = 0; i < 3; i++) await t.read();
  assert.deepEqual(t.last().problem?.code, "missing");
  fs.writeFileSync(f, "");
  for (let i = 0; i < 3; i++) await t.read();
  fs.writeFileSync(f, "Ops\n");
  assert.deepEqual(await t.read(), { label: "Ops", problem: null });
  fs.rmSync(f);
  await t.read();
  assert.deepEqual(lines, [
    "MASON_UI_TITLE_FILE: the file does not exist, so the web page's header shows the database",
    "MASON_UI_TITLE_FILE: its first line is empty, so the web page's header shows the database",
  ], "one line per reason, the missing file's not said again");
  assert.ok(lines.every((l) => !l.includes(f)), "the log names no path");
});

// ------------------------------------------------------------------ the setting at each entrance

test("the setting: a path, relative to the folder mason serve runs in; never read at the start; a wrong name refused at every entrance", () => {
  assert.equal(uiTitleFileSetting({}, "/srv"), null);
  assert.equal(uiTitleFileSetting({ MASON_UI_TITLE_FILE: "" }, "/srv"), null, "set empty is unset");
  assert.equal(uiTitleFileSetting({ MASON_UI_TITLE_FILE: "label.txt" }, "/srv"), path.resolve("/srv", "label.txt"));
  const s = serveSettings({ ...ENV, MASON_UI_TITLE_FILE: "/nowhere/label.txt" }, "/srv");
  assert.ok(!("message" in s), "a file that does not exist yet does not refuse the start");
  if (!("message" in s)) assert.equal(s.ui.titleFile, "/nowhere/label.txt");
  const unset = serveSettings(ENV, "/srv");
  if (!("message" in unset)) assert.ok(!("titleFile" in unset.ui), "unset: the settings are as before");
  assert.equal(startSettingRefusal(project(), { MASON_UI_TITLE_FILE: "/nowhere/label.txt" }, { serve: true }), null);
  for (const [wrong, hint] of [["MASON_UI_TITLE", " — did you mean `MASON_UI_TITLE_FILE`?"], ["MASON_UI_TITLE_PATH", ""]] as const) {
    const problem = `${wrong} is not a setting${hint}: the web page's label is read from a file, named by MASON_UI_TITLE_FILE`;
    const report = serveSettings({ ...ENV, [wrong]: "Production" }, "/srv");
    assert.equal("message" in report ? report.message : null, `a setting is missing or wrong: ${problem}`, wrong);
    for (const serve of [true, false]) {
      assert.deepEqual(startSettingRefusal(project(), { [wrong]: "Production" }, { serve }),
        { message: problem, code: "refused", fix: `unset ${wrong}, and name the file in MASON_UI_TITLE_FILE (mason serve --help)` }, `${wrong} serve=${serve}`);
    }
  }
});

test("mason serve's: in its --help with the other MASON_UI_* settings, its bounds and that every viewer sees it; mason start refuses it", () => {
  const usage = SERVE.usage.replace(/\s+/g, " ");
  assert.match(SERVE.usage, /\n {4}MASON_UI_TITLE_FILE {5}a file whose first line is the label in the web page's header box, in place of the\n/);
  assert.match(usage, /Mason reads it again each time the page loads, so an edit shows with no restart\. Every viewer of the page sees it\./);
  assert.match(usage, /at most the first 1024 bytes, takes the first line, makes each control character a space, drops invisible ones, and cuts it to 80 characters\./);
  assert.match(usage, /has an empty first line leaves the box showing the database's name, and mason status says why \(default unset: the database's name\)/);
  assert.ok(SERVE.usage.indexOf("MASON_UI_ICON ") < SERVE.usage.indexOf("MASON_UI_TITLE_FILE") && SERVE.usage.indexOf("MASON_UI_TITLE_FILE") < SERVE.usage.indexOf("MASON_MCP_URL "), "with the other MASON_UI_* settings");
  assert.deepEqual(startSettingRefusal(project(), { MASON_UI_TITLE_FILE: "label.txt" }, { serve: false }),
    { message: "MASON_UI_TITLE_FILE is mason serve's setting, and mason start ignores no setting silently", code: "refused",
      fix: "unset MASON_UI_TITLE_FILE: mason start's page is yours alone, opened with mason ui" });
  assert.equal(startSettingRefusal(project(), { MASON_UI_TITLE_FILE: "" }, { serve: false }), null, "set empty is unset");
  const status = (commandsModule as unknown as typeof import("../src/cli/commands.ts")).STATUS;
  assert.ok(status.json?.includes("pageTitle"), "mason status --json declares it");
  assert.match(status.usage.replace(/\s+/g, " "), /pageTitle \(only with mason serve's MASON_UI_TITLE_FILE: \{ label, problem \}/);
});

// ------------------------------------------------------------------ the run: the page's load, its polls, mason status

const KEYS_BEFORE = ["pageSocket", "mcp"];

/** A run's command server over a project folder whose config records it: a server's, with the title file or none. */
async function runningProject(titleFile: string | null, log: string[] = []): Promise<{ app: string; ctx: RunContext; close: () => Promise<void> }> {
  const app = tmp("mtitle-run-");
  fs.mkdirSync(path.join(app, "mason", "sources"), { recursive: true });
  fs.writeFileSync(path.join(app, "mason", "sources", "shop.yml"), "kind: postgres\nurl: postgres://me@127.0.0.1:1/shop\ndatabase: shop\ntables: {}\n");
  fs.mkdirSync(path.join(app, ".mason"), { mode: 0o700 });
  const parsed = parseSource("postgres://me@localhost:5432/shop");
  assert.ok("source" in parsed);
  const postgresUrl = "postgresql://localhost:5433/shop?sslmode=require";
  const ctx = {
    page: true, served: true, users: { file: path.join(app, ".mason", "users.json"), apiKey: KEY, database: "shop", postgresUrl },
    ...(titleFile === null ? {} : { pageTitle: new TitleFile(titleFile, (l) => log.push(l)) }),
    source: parsed.source, facts: () => ({ version: 180000, versionText: "18", standby: false, tables: [], systemIdentifier: null }), warnings: [], replication: () => null, port: 0,
    token: "t0ken-of-the-run", folder: () => path.join(app, "mason"), root: app, home: path.join(app, ".mason"), version: "test", startedAt: Date.now(), sources: () => ({ file: null, problem: null }), sourcesChanged: () => {}, log: () => {},
    readSource: () => ({ message: "not read here", code: "bad_source" }), runUrl: "postgres://me@localhost:5432/shop",
    listener: { openSessions: () => ({ open: 0, byClient: [] }), running: () => [], cancel: (session: number) => ({ unknown: session }) },
    logs: { capacity: 2000, recent: () => [] },
    duck: { copies: () => [], file: path.join(app, "duck.db"), refused: () => null, poll: async () => ({ at: "", tables: [] }), stream: async () => null, disk: () => ({ path: "/x", freeBytes: null, projectedBytes: null }),
      requests: { days: 7, unsupported: async () => [], page: async () => ({ requests: [], before: null }), slow: async () => [], refused: async () => ({ total: 0, refused: [] }),
        summary: async () => { throw new Error("not asked here"); }, window: async () => { throw new Error("not asked here"); }, clients: async () => ({ clients: [], total: { clients: 0, sessions: 0 } }),
        slowest: async () => [], durationsBy: async () => new Map(), lastUsed: async (u: unknown[]) => u.map(() => null) },
      events: { days: 7, recent: async () => [] }, usage: { days: 7, sampleSeconds: 60, samples: async () => [], copySizes: async () => [], lastMeasure: () => null, statementTotals: () => ({ completed: 0, refused: 0, failed: 0, cancelled: 0, completedMs: 0 }), lastDurations: () => null },
      restarts: () => [] },
  } as unknown as RunContext;
  const server = createRunServer(ctx);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  ctx.port = (server.address() as { port: number }).port;
  fs.writeFileSync(path.join(app, ".mason", "config.json"), JSON.stringify({ name: "shop", folder: "mason", remote: false, apiKey: KEY, sourceServer: null, served: true,
    running: { pid: process.pid, controlUrl: `http://127.0.0.1:${ctx.port}`, token: ctx.token, postgresUrl,
      postgresListener: { host: "0.0.0.0", tls: "self-signed", fingerprint: "AB:CD" } }, lastRun: null }), { mode: 0o600 });
  return { app, ctx, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

/** What the browser holding the run's cookie is answered at `path`. */
const asPage = async (ctx: RunContext, at: string): Promise<Response> =>
  fetch(`http://127.0.0.1:${ctx.port}/${at}`, { headers: { Cookie: `mason_dev_${ctx.port}=${ctx.token}` } });
const pollState = async (ctx: RunContext): Promise<Record<string, unknown>> => await (await asPage(ctx, "api/state")).json() as Record<string, unknown>;

test("an edit of the file shows at the next load of the page, with no restart; the page's polls never read the file", async () => {
  const f = path.join(tmp(), "label.txt");
  fs.writeFileSync(f, "Production analytics (EU)\n");
  const { ctx, close } = await runningProject(f);
  try {
    assert.equal((await asPage(ctx, "")).status, 200, "the page loads");
    assert.deepEqual((await pollState(ctx)).pageTitle, { label: "Production analytics (EU)", problem: null });
    fs.writeFileSync(f, "Staging\n");
    assert.deepEqual((await pollState(ctx)).pageTitle, { label: "Production analytics (EU)", problem: null }, "a poll answers the last read");
    fs.rmSync(f);
    assert.deepEqual((await pollState(ctx)).pageTitle, { label: "Production analytics (EU)", problem: null }, "a poll never touches the file");
    fs.writeFileSync(f, "Staging\n");
    await asPage(ctx, "");
    assert.deepEqual((await pollState(ctx)).pageTitle, { label: "Staging", problem: null }, "the next load reads it again");
    // what the page asks besides the document reads nothing either
    fs.writeFileSync(f, "Later\n");
    for (const at of ["app.js", "app.css", "api/state?fresh=0"]) await asPage(ctx, at);
    assert.equal(((await pollState(ctx)).pageTitle as { label: string }).label, "Staging");
  } finally { await close(); }
});

test("mason status says the label, or why there is none (text and --json, a stable code), read as it asks; logged once per reason", async () => {
  const f = path.join(tmp(), "label.txt");
  const log: string[] = [];
  const { app, ctx, close } = await runningProject(f, log);
  const run = (argv: string[]) => runMason(app, argv, matrixEnv());
  try {
    let st = await run(["status", "--json"]);
    assert.equal(st.code, 0, st.stdout + st.stderr);
    assert.deepEqual((JSON.parse(st.stdout) as { pageTitle: unknown }).pageTitle, { label: null, problem: { code: "missing", message: "the file does not exist" } });
    assert.match((await run(["status"])).stdout,
      /^ {2}Web UI label +none: MASON_UI_TITLE_FILE: the file does not exist, so the page's header shows the database$/m);
    // the page's load and mason status read it again: the reason is not logged again
    await asPage(ctx, "");
    await run(["status"]);
    assert.deepEqual(log, ["MASON_UI_TITLE_FILE: the file does not exist, so the web page's header shows the database"]);
    fs.writeFileSync(f, Buffer.from([0xff, 0x0a]));
    st = await run(["status", "--json"]);
    assert.deepEqual((JSON.parse(st.stdout) as { pageTitle: unknown }).pageTitle, { label: null, problem: { code: "not_utf8", message: "its first line is not UTF-8 text" } },
      "mason status reads it as it asks: no page load needed");
    fs.writeFileSync(f, "Production analytics (EU)\n");
    st = await run(["status", "--json"]);
    assert.deepEqual((JSON.parse(st.stdout) as { pageTitle: unknown }).pageTitle, { label: "Production analytics (EU)", problem: null });
    assert.match((await run(["status"])).stdout, /^ {2}Web UI label +Production analytics \(EU\) {2}\(MASON_UI_TITLE_FILE, read again each time the page loads\)$/m);
    assert.ok(!JSON.stringify(await pollState(ctx)).includes(f), "the state never names the file");
    assert.equal(log.length, 2);
  } finally { await close(); }
});

test("unset: /api/state, mason status and its --json are as before — no pageTitle, no row", async () => {
  const { app, ctx, close } = await runningProject(null);
  const run = (argv: string[]) => runMason(app, argv, matrixEnv());
  try {
    await asPage(ctx, "");
    const state = await pollState(ctx);
    assert.ok(!("pageTitle" in state), "no key in the state");
    const keys = Object.keys(state);
    assert.equal(keys.indexOf(KEYS_BEFORE[1]!) - keys.indexOf(KEYS_BEFORE[0]!), 1, "pageSocket and mcp side by side, as before");
    const st = await run(["status", "--json"]);
    assert.equal(st.code, 0, st.stdout + st.stderr);
    assert.ok(!("pageTitle" in (JSON.parse(st.stdout) as object)), "no key in mason status --json");
    assert.doesNotMatch((await run(["status"])).stdout, /Web UI label|MASON_UI_TITLE_FILE/);
  } finally { await close(); }
});
