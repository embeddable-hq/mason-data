/**
 * A log file an older Mason wrote, read back (issue 621): its lines held the source's password in a libpq `password=`
 * value, and `mason logs` showed them as they were. Every reader of a log file reads it through src/lib/log-read.ts,
 * which masks each line as it is read (`PasswordLineMask`, src/lib/secret-mask.ts) — `mason logs` whole, `--start`,
 * `--json`, `-f`; `mason start`'s watch and the supervisor's scan — and the run's memory of its log (`/api/logs`,
 * tests/cli-run-server.test.ts) is the same mask. Only that form is masked: an identifier holding the password's letters
 * reads whole (#620's decision). And the reader's own chunks never let a value through: whatever the cut, the lines read
 * are the same. The modules are imported when the tests run, so the file loads at a commit without them and each test
 * fails by name (scripts/fails-without.ts).
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { newConfig, writeConfig } from "../src/cli/project.ts";

type ReadMod = typeof import("../src/lib/log-read.ts");
type MaskMod = typeof import("../src/lib/secret-mask.ts");
const readMod = await import("../src/lib/log-read.ts" as string).catch(() => ({})) as Partial<ReadMod>;
const maskMod = await import("../src/lib/secret-mask.ts" as string).catch(() => ({})) as Partial<MaskMod>;
function need<M, K extends keyof M>(m: Partial<M>, k: K, where: string): M[K] {
  const v = m[k];
  if (v === undefined) assert.fail(`${where} has no ${String(k)}`);
  return v as M[K];
}
const LogReader = (): ReadMod["LogReader"] => need(readMod, "LogReader", "src/lib/log-read.ts");
const readLog = (file: string): string => { const r = new (LogReader())(file); return r.readAll() + r.rest(); };
const lineMask = (): InstanceType<MaskMod["PasswordLineMask"]> => new (need(maskMod, "PasswordLineMask", "src/lib/secret-mask.ts"))();
const masked = (text: string): string => { const m = lineMask(); return text.split("\n").map((l) => m.line(l)).join("\n"); };

const MAIN = path.resolve("src/cli/main.ts");
const at = (n: number): string => `2026-10-30T10:00:${String(n).padStart(2, "0")}.000Z`;
// the password is in names too, a table's and a user's (the reviews of PR 620: a substring mask cut them)
const conn = (pw: string): string => `host='db.internal' port='5432' dbname='app' user='reader' password=${pw} sslmode='prefer'`;
/** The lines an older Mason wrote: the connection string in its error, the password in every form libpq writes it. */
const OLD_LINES: Array<[string, string]> = [
  [`${at(1)} [sync] public.orders2024_archive: its first sync failed: IO Error: Unable to connect to Postgres at "${conn("'orders2024'")}": connection refused`,
    `${at(1)} [sync] public.orders2024_archive: its first sync failed: IO Error: Unable to connect to Postgres at "${conn("****")}": connection refused`],
  // escaped, as libpq quotes a password holding a quote and a backslash
  [`${at(2)} [sync] public.orders: poll failed: Unable to connect to Postgres at "${conn("'orders\\'2024\\\\x'")}"`,
    `${at(2)} [sync] public.orders: poll failed: Unable to connect to Postgres at "${conn("****")}"`],
  [`${at(3)} [cdc] stream failed: password=orders2024 host=db.internal`, `${at(3)} [cdc] stream failed: password=**** host=db.internal`],
  [`${at(4)} [sync] retry: PASSWORD = 'orders2024' x`, `${at(4)} [sync] retry: PASSWORD = **** x`],
  [`${at(5)} [sync] Password ='orders 2024'`, `${at(5)} [sync] Password =****`],
];
const SECRET_FORMS = ["'orders2024'", "orders\\'2024", "password=orders2024", "'orders 2024'"];
function noSecret(said: string, where: string): void {
  for (const s of SECRET_FORMS) assert.ok(!said.includes(s), `${where}: ${s} is shown:\n${said}`);
  assert.ok(!/password\s*=(?!\s*\*\*\*\*)/i.test(said), `${where}: a password= value is shown:\n${said}`);
}

test("a log's line is masked as maskPasswordKeyword masks it: every password= value, quoted, escaped, bare, any case, spaces round the =; identifiers holding the password read whole", () => {
  const maskPasswordKeyword = need(maskMod, "maskPasswordKeyword", "src/lib/secret-mask.ts");
  for (const [old, want] of OLD_LINES) {
    assert.equal(masked(old), want);
    assert.equal(masked(old), maskPasswordKeyword(old), "one line: the same answer as the whole-text mask");
  }
  for (const words of ["public.orders2024_archive: Binder Error: column \"v\" not found", "FATAL: password authentication failed for user \"orders2024\"",
    "the password was rotated", "user_password=x is a column's value"]) assert.equal(masked(words), words, "nothing but a password= value changes");
  // a text cut on the backslash of a quoted value (a line an older Mason's message ended there) is masked too
  assert.equal(maskPasswordKeyword("x password='ab\\"), "x password=****");
  assert.equal(masked("x password='ab\\"), "x password=****");
});

test("a value that runs on past its line is masked to its end within its entry, and never past it", () => {
  // a quoted password holding a newline: textEntry indents the rest under its head (src/lib/log.ts)
  assert.equal(masked(`${at(1)} [sync] failed: password='first\n    second' sslmode='prefer'\n    LINE 2`),
    `${at(1)} [sync] failed: password=****\n    **** sslmode='prefer'\n    LINE 2`);
  assert.equal(masked(`${at(1)} [sync] failed: password='a\n    b\n    c' x`), `${at(1)} [sync] failed: password=****\n    ****\n    **** x`);
  // the keyword at a line's end, its value on the next indented line
  assert.equal(masked(`${at(1)} [sync] failed: password =\n    'orders2024' x`), `${at(1)} [sync] failed: password =\n    **** x`);
  assert.equal(masked(`${at(1)} [sync] failed: password\n    = orders2024 x`), `${at(1)} [sync] failed: password\n    = **** x`);
  // a quote an older Mason left open (a message cut off) masks its own entry; the next entry, at the margin, reads whole
  assert.equal(masked(`${at(1)} [sync] failed: password='cut off\n    more\n${at(2)} [sync] public.orders2024: synced 'ok'`),
    `${at(1)} [sync] failed: password=****\n    ****\n${at(2)} [sync] public.orders2024: synced 'ok'`);
  // a blank line (a terminal's, dev.log) ends it too
  assert.equal(masked("password='cut\n\n  step one"), "password=****\n\n  step one");
});

test("the reader's chunks never let a value through: a file read 1, 2, … bytes at a time reads as it does whole, a password= cut anywhere, a character's bytes too", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "log-read-"));
  try {
    const file = path.join(dir, "mason.log");
    const text = [...OLD_LINES.map(([old]) => old), `${at(6)} [sync] failed: password='ünï\n    cødé' sslmode='prefer'`, `${at(7)} [sync] dönë`].join("\n") + "\n" + `${at(8)} [sync] last password='unended`;
    fs.writeFileSync(file, text);
    const whole = readLog(file);
    noSecret(whole, "read whole");
    assert.ok(whole.includes("ünï") === false && whole.includes("cødé") === false && whole.includes("dönë"), whole);
    assert.ok(whole.endsWith(`${at(8)} [sync] last password=****`), "the last line, unended, read and masked");
    const R = LogReader();
    for (let chunk = 1; chunk <= Buffer.byteLength(text) + 1; chunk++) {
      const r = new R(file, { chunk });
      let got = "";
      for (let t = r.read(); t !== null; t = r.read()) {
        assert.ok(t === "" || t.endsWith("\n"), `chunk ${chunk}: a line released whole`);
        noSecret(t, `chunk ${chunk}`);
        got += t;
      }
      got += r.rest();
      assert.equal(got, whole, `chunk ${chunk}`);
      assert.equal(r.offset, Buffer.byteLength(text));
    }
    // a file appended to while it is read (mason logs -f, mason start's watch): a value cut between two writes
    fs.writeFileSync(file, "");
    const r = new R(file);
    let got = "";
    const old = OLD_LINES[0]![0];
    const cut = old.indexOf("'orders2024'") + 4;
    for (const piece of [old.slice(0, cut), old.slice(cut), "\n", `${at(9)} [sync] next\n`]) {
      fs.appendFileSync(file, piece);
      const t = r.readAll();
      noSecret(t, `after ${JSON.stringify(piece)}`);
      got += t;
    }
    assert.equal(got, `${OLD_LINES[0]![1]}\n${at(9)} [sync] next\n`);
    // a new run that starts the file over is read from its start
    fs.writeFileSync(file, `${at(10)} [sync] begun again\n`);
    assert.equal(r.readAll(), `${at(10)} [sync] begun again\n`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("mason logs, --start, their --json, and -n show an older Mason's lines masked, in mason.log and dev.log, identifiers whole; --since and --until are the request log's, refused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-logs-mask-"));
  try {
    writeConfig(path.join(dir, ".mason"), newConfig("shop", "mason"));
    fs.writeFileSync(path.join(dir, ".mason", "mason.log"), OLD_LINES.map(([old]) => `${old}\n`).join(""));
    const devOld = ["--- mason start 2026-10-30T10:00:00.000Z ---", "Starting Mason for shop", "  ✗ Connecting to postgres://reader:****@db.internal:5432/app",
      `mason start: could not connect: Unable to connect to Postgres at "${conn("'orders2024'")}"`, "  password = orders2024", `FATAL: password authentication failed for user "orders2024"`];
    const devWant = [...devOld.slice(0, 3), `mason start: could not connect: Unable to connect to Postgres at "${conn("****")}"`, "  password = ****", devOld[5]!];
    fs.writeFileSync(path.join(dir, ".mason", "dev.log"), devOld.join("\n") + "\n");
    const mason = (...args: string[]) => spawnSync(process.execPath, [MAIN, "logs", ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
    const plain = mason();
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(plain.stdout, OLD_LINES.map(([, want]) => `${want}\n`).join(""));
    const json = mason("--json");
    assert.equal(json.status, 0, json.stderr);
    noSecret(json.stdout, "mason logs --json");
    assert.deepEqual((JSON.parse(json.stdout) as { lines: unknown }).lines, OLD_LINES.map(([, want]) => ({ at: want.slice(0, 24), text: want.slice(25) })));
    const one = mason("-n", "1", "--json");
    assert.deepEqual((JSON.parse(one.stdout) as { lines: unknown }).lines, [{ at: at(5), text: "[sync] Password =****" }]);
    const start = mason("--start");
    assert.equal(start.status, 0, start.stderr);
    assert.equal(start.stdout, devWant.join("\n") + "\n");
    const startJson = mason("--start", "--json");
    assert.equal(startJson.status, 0, startJson.stderr);
    noSecret(startJson.stdout, "mason logs --start --json");
    assert.deepEqual((JSON.parse(startJson.stdout) as { lines: Array<{ text: string }> }).lines.map((l) => l.text), devWant);
    assert.match(plain.stdout, /public\.orders2024_archive/, "a name holding the password reads whole");
    assert.match(start.stdout, /for user "orders2024"$/m);
    // the request log's time filters are not the log file's: refused, nothing of the file printed
    for (const args of [["--since", "1h"], ["--until", "2026-10-31"], ["--start", "--since", "1h"], ["--since", "1h", "--json"], ["--until", "1h", "--start", "--json"]]) {
      const r = mason(...args);
      assert.equal(r.status, 2, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
      noSecret(r.stdout + r.stderr, args.join(" "));
      assert.ok(!(r.stdout + r.stderr).includes("public.orders2024_archive"), "none of the file is printed");
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("mason logs -f masks the lines it follows, a password= value cut between two of the run's writes included", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-logs-follow-"));
  try {
    writeConfig(path.join(dir, ".mason"), newConfig("shop", "mason"));
    const file = path.join(dir, ".mason", "mason.log");
    fs.writeFileSync(file, `${OLD_LINES[2]![0]}\n`);
    const follow = spawn(process.execPath, [MAIN, "logs", "-f"], { cwd: dir, env: { ...process.env, NO_COLOR: "1" } });
    let said = "";
    follow.stdout.on("data", (b: Buffer) => { said += b.toString(); });
    follow.stderr.on("data", (b: Buffer) => { said += b.toString(); });
    const until = async (want: string): Promise<void> => {
      for (const end = Date.now() + 15_000; !said.includes(want) && Date.now() < end;) await new Promise((r) => setTimeout(r, 50));
      assert.ok(said.includes(want), `waited for ${JSON.stringify(want)}:\n${said}`);
    };
    try {
      await until(OLD_LINES[2]![1]);
      const old = OLD_LINES[0]![0];
      const cut = old.indexOf("'orders2024'") + 4;
      fs.appendFileSync(file, old.slice(0, cut));
      await new Promise((r) => setTimeout(r, 1500));   // three of -f's reads, the line half written
      fs.appendFileSync(file, `${old.slice(cut)}\n${at(9)} [sync] next\n`);
      await until(`${at(9)} [sync] next`);
      noSecret(said, "mason logs -f");
      assert.equal(said, `${OLD_LINES[2]![1]}\n${OLD_LINES[0]![1]}\n${at(9)} [sync] next\n`);
    } finally { follow.kill(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("mason logs -f shows a last line no newline ended (a run killed mid-write), as it stands, masked; more of it, and the lines after, as they come", async () => {
  // the review of PR 641 (B1): -f waited for the newline, and a stopped run's last words never came
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-logs-unended-"));
  try {
    writeConfig(path.join(dir, ".mason"), newConfig("shop", "mason"));
    const file = path.join(dir, ".mason", "mason.log");
    fs.writeFileSync(file, `${at(0)} [x] one\n${at(1)} [x] the run died mid-li`);
    const follow = spawn(process.execPath, [MAIN, "logs", "-f"], { cwd: dir, env: { ...process.env, NO_COLOR: "1" } });
    let said = "";
    follow.stdout.on("data", (b: Buffer) => { said += b.toString(); });
    follow.stderr.on("data", (b: Buffer) => { said += b.toString(); });
    const until = async (want: string): Promise<void> => {
      for (const end = Date.now() + 15_000; !said.endsWith(want) && Date.now() < end;) await new Promise((r) => setTimeout(r, 50));
      assert.equal(said, want);
    };
    try {
      await until(`${at(0)} [x] one\n${at(1)} [x] the run died mid-li`);
      // the line completed by a later write, then one half written with its password cut, shown masked as it stands
      const old = OLD_LINES[0]![0];
      const cut = old.indexOf("'orders2024'") + 4;
      fs.appendFileSync(file, `ne\n${old.slice(0, cut)}`);
      await until(`${at(0)} [x] one\n${at(1)} [x] the run died mid-line\n${old.slice(0, old.indexOf("'orders2024'"))}****`);
      fs.appendFileSync(file, `${old.slice(cut)}\n`);
      await until(`${at(0)} [x] one\n${at(1)} [x] the run died mid-line\n${OLD_LINES[0]![1]}\n`);
      noSecret(said, "mason logs -f");
    } finally { follow.kill(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a follow's answers, one after another, are the masked lines with the unended one's masked text so far, however the file is written", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "log-follow-"));
  try {
    const file = path.join(dir, "mason.log");
    const text = [...OLD_LINES.map(([old]) => old), `${at(6)} [sync] failed: password='ünï\n    cødé' sslmode='prefer'`, `${at(7)} [sync] dönë`].join("\n") + "\n";
    const R = LogReader();
    const whole = new R(file);
    fs.writeFileSync(file, text);
    const want = whole.readAll();
    // every cut of the file into two writes, a follow after each, at chunk sizes that cut inside lines too
    for (const chunk of [3, 64, 1 << 20]) {
      for (let cut = 0; cut <= text.length; cut += 7) {
        fs.writeFileSync(file, "");
        const r = new R(file, { chunk });
        let shown = r.follow();
        fs.appendFileSync(file, text.slice(0, cut));
        const half = r.follow();
        // a keyword whose value is not written yet ends it with no value: nothing to mask, and nothing shown
        noSecret(half.replace(/password\s*(?:=\s*)?$/i, ""), `chunk ${chunk}, cut ${cut}`);
        shown += half;
        assert.equal(shown, want.slice(0, shown.length), `chunk ${chunk}, cut ${cut}: what is shown so far is the masked text's start`);
        fs.appendFileSync(file, text.slice(cut));
        shown += r.follow();
        assert.equal(shown, want, `chunk ${chunk}, cut ${cut}`);
        assert.equal(r.follow(), "", "nothing more, nothing said");
      }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the reader's work is linear in what it reads: a long line is read again once, never once a chunk, and nothing of it is held between chunks", () => {
  // the review of PR 641 (B2): the partial joined to every 1 MiB chunk and split again, a 256 MiB line 36 s against 4.7
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "log-work-"));
  try {
    const file = path.join(dir, "mason.log");
    const long = `${at(1)} [x] ${"a".repeat(200_000)} password='orders2024' ${"b".repeat(50_000)}`;
    fs.writeFileSync(file, `${long}\n${at(2)} [x] short\n${long}`);
    const R = LogReader();
    for (const chunk of [64, 4096]) {
      const r = new R(file, { chunk });
      const got = r.readAll() + r.rest();
      noSecret(got, `chunk ${chunk}`);
      const { read, searched } = r.work;
      const size = fs.statSync(file).size;
      assert.equal(searched, size, `chunk ${chunk}: every byte searched for a newline once`);
      assert.ok(read <= 2 * size, `chunk ${chunk}: ${read} bytes read for a file of ${size}: a line's bytes read again once at most, never once a chunk (held and joined to each chunk, ${Math.round(size * size / chunk / 2)})`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the supervisor's scan of the run's terminal reads it through the reader: a fatal line is masked before it is recorded", async () => {
  const { scanLog } = await import("../src/cli/supervise.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "log-scan-"));
  try {
    const file = path.join(dir, "dev.log");
    fs.writeFileSync(file, `before\nmason: ready\nFATAL ERROR: out of memory near password='orders2024' x\n`);
    const r = scanLog(file, 0);
    assert.equal(r.fatal, "out of memory near password=**** x");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
