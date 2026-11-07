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
        assert.deepEqual(v.next.map((n) => n.command), [wanted]);
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
