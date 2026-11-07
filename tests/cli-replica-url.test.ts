/**
 * `mason replica create`'S DATABASE URL, FROM THE PERSON OR THE PIPE, NEVER A FLAG, AN ARGUMENT OR A FILE (issue 720),
 * against a fake hosted service (tests/replica-fake.ts): on a terminal a hidden prompt (stdin made a terminal by a
 * preload whose raw mode is recorded), else stdin; a URL on the command line refused (exit 2) with the line to run
 * instead; the replica named by the argument, --replica or MASON_REPLICA. Every run through `hosted` is held to printing
 * no part of the URL given (`URL_MARK`, its password), and to never reading, sending or printing the one .env holds.
 * A file of its own, importing nothing of the command's modules, so it loads at any commit (scripts/fails-without.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { envFor, fakeService, home, newToken } from "./hosted-fake.ts";
import { runMason } from "./cli-matrix.ts";
import { created, ENV_MARK, hosted, PASSWORD, project, URL_, URL_MARK } from "./replica-fake.ts";

const LINE = ["create", "acme/shop", "--region", "eu", "--size", "50"];

/** A preload that makes stdin a terminal: `isTTY`, and a raw mode each change of which is written to `log`. */
function terminalStdin(): { env: Record<string, string>; log: string } {
  const dir = home();
  const log = path.join(dir, "raw.log");
  const hook = path.join(dir, "tty-stdin.mjs");
  fs.writeFileSync(log, "");
  fs.writeFileSync(hook, `import * as fs from "node:fs";
const s = process.stdin;
let raw = false;
Object.defineProperty(s, "isTTY", { value: true, configurable: true });
Object.defineProperty(s, "isRaw", { get: () => raw, configurable: true });
s.setRawMode = (on) => { raw = on; fs.appendFileSync(${JSON.stringify(log)}, on ? "raw\\n" : "cooked\\n"); return s; };
`);
  return { env: { NODE_OPTIONS: `--import=${pathToFileURL(hook).href}` }, log };
}

const QUESTION = "DATABASE_URL, the database's URL (not shown; Ctrl-C cancels): ";

test("on a terminal, mason replica create asks for the URL on stderr with echo off (raw mode on while it reads, off after), and sends what was typed: pasted, bracketed, or edited with Backspace", async () => {
  for (const typed of [`${URL_}\r`, `\x1b[200~${URL_}\x1b[201~\r`, `xy\x7f\x7f${URL_}\n`]) {
    for (const json of [false, true]) {
      const t = terminalStdin();
      const { a, requests } = await hosted(() => created(), [...LINE, ...(json ? ["--json"] : [])], { cwd: project(), stdin: typed, env: t.env });
      assert.equal(a.code, 0, `${JSON.stringify(typed)}: ${a.stdout}${a.stderr}`);
      assert.ok(a.stderr.startsWith(`${QUESTION}\n`), `the question first, on stderr, then a line of its own:\n${a.stderr}`);
      assert.ok(!a.stdout.includes(QUESTION), "never on stdout");
      assert.equal(fs.readFileSync(t.log, "utf8"), "raw\ncooked\n", "echo off while it reads, back on after");
      assert.equal(JSON.parse(requests[0]!.body).sources[0].url, URL_, JSON.stringify(typed));
      if (!json) assert.match(a.stderr, /Mason checks the database \(DATABASE_URL, its URL typed at the prompt\)/);
    }
  }
});

test("on a terminal, Ctrl-C, Ctrl-D or Enter on an empty line cancels before anything is sent, the terminal put back; nothing of what was typed is printed", async () => {
  for (const [typed, message] of [["\x03", "cancelled: no URL was given, and nothing was sent"], [`postgres://app_reader:${PASSWORD}@db-${URL_MARK}\x03`, "cancelled: no URL was given, and nothing was sent"],
    ["\x04", "cancelled: no URL was given, and nothing was sent"], ["\r", "cancelled: no URL was typed, and nothing was sent"], ["", "cancelled: no URL was given, and nothing was sent"]] as const) {
    for (const json of [false, true]) {
      const t = terminalStdin();
      const { a, requests } = await hosted(() => created(), [...LINE, ...(json ? ["--json"] : [])], { cwd: project(), stdin: typed, env: t.env });
      assert.equal(a.code, 1, `${JSON.stringify(typed)}: ${a.stdout}${a.stderr}`);
      assert.deepEqual(requests, [], "nothing sent");
      assert.equal(fs.readFileSync(t.log, "utf8"), "raw\ncooked\n", `${JSON.stringify(typed)}: the terminal put back`);
      if (json) assert.deepEqual(Object.values((JSON.parse(a.stdout) as { error: { code: string; message: string } }).error).slice(0, 2), ["refused", message]);
      else assert.match(a.stderr, new RegExp(`^✗ mason replica: ${message}$`, "m"));
    }
  }
});

test("a URL on mason replica's command line — an argument, --url, --url=, another flag's value, NAME=, a connection string's password — is refused (exit 2) before anything is read or sent, never repeated, with the exact line to run instead", async () => {
  const fake = await fakeService({ v1: () => created() });
  try {
    const url = URL_;
    const forms: Array<[string[], string]> = [
      [[...LINE, url], "mason replica create acme/shop --region eu --size 50 < url.txt"],
      [[...LINE, "--url", url], "mason replica create acme/shop --region eu --size 50 < url.txt"],
      [[...LINE, `--url=${url}`], "mason replica create acme/shop --region eu --size 50 < url.txt"],
      [[...LINE, `--database-url=${url.replace("postgres://", "postgresql://")}`], "mason replica create acme/shop --region eu --size 50 < url.txt"],
      [["create", "--replica", "acme/shop", "--region", url, "--size", "50"], "mason replica create acme/shop --region <region> --size 50 < url.txt"],
      [[...LINE, `DATABASE_URL=${url}`], "mason replica create acme/shop --region eu --size 50 < url.txt"],
      [[...LINE, `host=db-${URL_MARK}.example password=${PASSWORD}`], "mason replica create acme/shop --region eu --size 50 < url.txt"],
      [["create", url], "mason replica create <org>/<name> --region <region> --size <gb> < url.txt"],
      [["status", "acme/shop", url], "mason replica create <org>/<name> --region <region> --size <gb> < url.txt"],
    ];
    for (const [argv, line] of forms) for (const json of [false, true]) {
      const a = await runMason(project(), ["replica", ...argv, ...(json ? ["--json"] : [])], envFor(home(), fake.url, { MASON_TOKEN: newToken() }), 60_000, undefined, URL_);
      const all = a.stdout + a.stderr;
      assert.equal(a.code, 2, `${argv.join(" ")}: ${all}`);
      for (const mark of [PASSWORD, URL_MARK, "postgres://", "postgresql://"]) assert.ok(!all.includes(mark), `${argv.join(" ")} repeated ${mark}:\n${all}`);
      const wanted = json ? line.replace(" < url.txt", " --json < url.txt") : line;
      if (json) {
        const v = JSON.parse(a.stdout) as { error: { code: string; message: string; fix: string }; next: Array<{ command: string }> };
        assert.deepEqual([v.error.code, v.error.message], ["usage", "a database URL is never taken on mason replica's command line"]);
        assert.ok(v.error.fix.startsWith(`give it on stdin: ${wanted} `), v.error.fix);
        assert.deepEqual(v.next.map((n) => n.command), [wanted, "mason replica --help"]);
      } else {
        assert.match(a.stderr, /^✗ mason replica: a database URL is never taken on mason replica's command line$/m);
        assert.ok(a.stderr.includes(wanted), a.stderr);
      }
    }
    assert.deepEqual(fake.requests, [], "nothing was sent");
  } finally { await fake.close(); }
});

test("mason replica create names its replica as every hosted command does: the argument, --replica, or MASON_REPLICA (said on stderr)", async () => {
  const root = project();
  for (const [argv, env, said] of [[["create", "--replica", "acme/shop"], {}, false], [["create"], { MASON_REPLICA: "acme/shop" }, true], [["create", "acme/shop"], { MASON_REPLICA: "other/one" }, false]] as Array<[string[], Record<string, string>, boolean]>) {
    const { a, requests } = await hosted(() => created(), [...argv, "--region", "eu", "--size", "50"], { cwd: root, env });
    assert.equal(a.code, 0, `${argv.join(" ")}: ${a.stdout}${a.stderr}`);
    assert.deepEqual(requests.map((q) => `${q.method} ${q.path}`), ["POST /v1/replicas/acme"]);
    assert.equal(JSON.parse(requests[0]!.body).name, "shop");
    assert.equal(a.stderr.includes("using MASON_REPLICA=acme/shop"), said, a.stderr);
  }
});

test("the URL comes from stdin alone: a project with no .env creates, and one whose .env or shell sets the variable never has that value read, sent or printed", async () => {
  for (const [root, env] of [[project({ env: null }), {}], [project(), {}], [project({ env: null }), { DATABASE_URL: `postgres://shell:Sh3llpass${ENV_MARK}@h/d` }]] as Array<[string, Record<string, string>]>) {
    const { a, requests } = await hosted(() => created(), [...LINE, "--json"], { cwd: root, env, stdin: `${URL_}\n` });
    assert.equal(a.code, 0, a.stdout);
    assert.equal(JSON.parse(requests[0]!.body).sources[0].url, URL_);
    assert.ok(!requests[0]!.body.includes(ENV_MARK));
  }
});

test("a sources file naming a variable other than DATABASE_URL is refused before the URL is asked for (a replica sets that one alone), with the line to write", async () => {
  for (const json of [false, true]) {
    const t = terminalStdin();
    const root = project({ file: "kind: postgres\nurl: ${MASON_DATABASE_URL}\ntables:\n  orders: {}\n" });
    const { a, requests } = await hosted(() => created(), [...LINE, ...(json ? ["--json"] : [])], { cwd: root, stdin: `${URL_}\r`, env: t.env });
    assert.equal(a.code, 1, a.stdout + a.stderr);
    assert.deepEqual(requests, [], "nothing sent");
    assert.equal(fs.readFileSync(t.log, "utf8"), "", "nothing asked: the terminal never went raw");
    assert.ok(!a.stderr.includes(QUESTION));
    const said = json ? (JSON.parse(a.stdout) as { error: { code: string; message: string; fix: string } }).error : null;
    if (said) {
      assert.deepEqual([said.code, said.message], ["refused", "mason/sources/app.yml: url: ${MASON_DATABASE_URL} names a variable a replica does not set"]);
      assert.match(said.fix, /^write url: \$\{DATABASE_URL\} in mason\/sources\/app\.yml /);
    } else assert.match(a.stderr, /^✗ mason replica: mason\/sources\/app\.yml: url: \$\{MASON_DATABASE_URL\} names a variable a replica does not set$/m);
  }
});

test("a URL a service would refuse is refused after it is read and before anything is sent, saying what is wrong and never repeating it: no password, no database, a parameter other than sslmode, several hosts, a port below 1024; sslmode alone passes", async () => {
  const host = `db-${URL_MARK}.example`;
  const cases: Array<[string, RegExp]> = [
    [`postgres://app_reader@${host}:5432/app`, /^it has no password: /],
    [`postgres://app_reader:${PASSWORD}@${host}:5432`, /^it names no database: /],
    [`postgres://app_reader:${PASSWORD}@${host}:5432/`, /^it names no database: /],
    [`postgres://app_reader:${PASSWORD}@${host}:5432/app?host=/tmp`, /^it has the parameter host after the \?: a replica takes sslmode alone/],
    [`postgres://app_reader:${PASSWORD}@${host}:5432/app?sslmode=require&hostaddr=10.0.0.1`, /^it has the parameter hostaddr after the \?/],
    [`postgres://app_reader:${PASSWORD}@${host}:5432/app?application_name=x`, /^it has the parameter application_name after the \?/],
    [`postgres://app_reader:${PASSWORD}@${host}:5432/app?${URL_MARK}=1`, /^it has a parameter after the \?/],
    [`postgres://app_reader:${PASSWORD}@${host}:5432,other-${URL_MARK}:5432/app`, /^it names more than one host: /],
    [`postgres://app_reader:${PASSWORD}@${host}:80/app`, /^its port is below 1024: /],
    [`postgres://app_reader:${PASSWORD}@${host}:1023/app`, /^its port is below 1024: /],
  ];
  const root = project();
  for (const [url, why] of cases) {
    const { a, requests } = await hosted(() => created(), [...LINE, "--json"], { cwd: root, stdin: url });
    const e = (JSON.parse(a.stdout) as { error: { code: string; message: string; why: string } }).error;
    assert.equal(a.code, 1, `${url}: ${a.stdout}`);
    assert.deepEqual([e.code, e.message], ["refused", "the URL given for DATABASE_URL (read from stdin) is not a database URL a replica can be made for"], url);
    assert.match(e.why, why, url);
    assert.deepEqual(requests, [], `${url}: nothing sent`);
  }
  for (const url of [`postgres://app_reader:${PASSWORD}@${host}:5432/app?sslmode=require`, `postgres://app_reader:${PASSWORD}@${host}:1024/app`, `postgres://app_reader:${PASSWORD}@${host}/app`]) {
    const { a, requests } = await hosted(() => created(), [...LINE, "--json"], { cwd: root, stdin: url });
    assert.equal(a.code, 0, `${url}: ${a.stdout}`);
    assert.equal(JSON.parse(requests[0]!.body).sources[0].url, url);
  }
});

test("what a service refuses after the URL is sent is said in its words, the code the CLI's, sent once: a host that does not resolve or resolves to a private address, a port, a URL without a password or database, a parameter (400); a CLI too old (400, 426); a launch it could not start (503 with Retry-After: said, never waited for)", async () => {
  const root = project();
  const refusal = (status: number, code: string, message: string, headers?: Record<string, string>): { status: number; body: unknown; headers?: Record<string, string> } =>
    ({ status, body: { error: { code, message } }, ...(headers ? { headers } : {}) });
  const cases: Array<[ReturnType<typeof refusal>, string]> = [
    [refusal(400, "bad_request", "the database's host does not resolve"), "refused"],
    [refusal(400, "bad_request", "the database's host resolves to a private address"), "refused"],
    [refusal(400, "bad_request", "the database's port is below 1024"), "refused"],
    [refusal(400, "bad_request", "the URL has no password or no database name"), "refused"],
    [refusal(400, "bad_request", "the URL has a parameter other than sslmode"), "refused"],
    [refusal(400, "bad_request", "this Mason is too old for this service: upgrade it"), "refused"],
    [refusal(426, "upgrade_required", "this Mason is too old for this service: upgrade it"), "refused"],
    [refusal(503, "unavailable", "the replica could not be launched just now", { "retry-after": "30" }), "failed"],
  ];
  for (const [reply, code] of cases) {
    const message = (reply.body as { error: { message: string } }).error.message;
    const j = await hosted(() => reply, [...LINE, "--json"], { cwd: root });
    const e = (JSON.parse(j.a.stdout) as { error: { code: string; message: string; why: string } }).error;
    assert.equal(j.a.code, 1, j.a.stdout);
    assert.deepEqual([e.code, e.message], [code, message], "the service's words, as they came");
    assert.equal(j.requests.length, 1, "sent once, never retried or waited for");
    if (reply.status === 503) assert.match(e.why, /the service said unavailable, HTTP 503; the service asks for another try in 30 s: run the same command again then$/);
    const p = await hosted(() => reply, LINE, { cwd: root });
    assert.equal(p.a.code, 1);
    assert.ok(p.a.stderr.includes(`✗ mason replica: ${message}`), p.a.stderr);
  }
});
