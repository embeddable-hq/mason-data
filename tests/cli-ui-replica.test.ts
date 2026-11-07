/**
 * `mason ui --replica <org>/<name>` AGAINST A FAKE HOSTED SERVICE (tests/hosted-fake.ts: an http server of this test's on
 * 127.0.0.1, no network), and a fake browser (an `xdg-open` of this test's on PATH, which records what it was handed).
 * The contract is docs/HOSTED-API.md "A replica's page": the request, who may ask (the service decides: an owner's login,
 * never an admin's, a viewer's or a CI token), a replica not ready, an answer outside the contract, --no-open, --json,
 * and the wrong lines. Every run against the fake is held by `mason` to carrying no token, and to no line a person sees
 * begun by the service's text.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { envFor, fakeService, home, mason, newToken, SECRETS, writeSaved, type Lines, type Reply, type Req } from "./hosted-fake.ts";
import { runMason, type Answer } from "./cli-matrix.ts";

const R = "acme/shop";
const PAGE = "/v1/replicas/acme/shop/ui";
const EXPIRES = "2026-11-07T10:05:00.000Z";
/** The one-use address the fake answers by default: on its own origin (`BASE` is replaced by its address). */
const ADDRESS = "http://BASE/replicas/acme/shop/page?ticket=t1c2k3e4t5-one_use.x~y";

const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

const OWN_STEP = /^ {2}(mason login|mason replica (status acme\/shop|list acme)|mason ui --replica acme\/shop|env -u MASON_TOKEN mason ui --replica acme\/shop)(\s|$)/;
const LINES: Lines = {
  heads: ["The page of the replica ", "✘ mason ui: ", "✗ mason ui: ", "Tip: The address opens ", "Tip: The URL opens ", "Tip: Could not open a browser ",
    "This machine is not signed in to ", ...["url", "replica", "expires", "why", "fix"].map((l) => `  ${l} `)],
  steps: ["  mason login", "  mason replica ", "  mason ui --replica ", "  env -u MASON_TOKEN mason ui "], ownStep: OWN_STEP,
};

/** A browser of this test's: an `xdg-open` on PATH that writes what it was handed to a file. */
function browser(): { dir: string; opened: () => string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-browser-"));
  made.push(dir);
  const record = path.join(dir, "opened.txt");
  fs.writeFileSync(path.join(dir, "xdg-open"), `#!/bin/sh\nprintf '%s\\n' "$@" >> '${record}'\n`, { mode: 0o755 });
  return { dir, opened: () => {
    // the opener is detached: give it a moment to have written
    for (let i = 0; i < 50 && !fs.existsSync(record); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    return fs.existsSync(record) ? fs.readFileSync(record, "utf8").split("\n").filter(Boolean) : [];
  } };
}

const pageAnswer = (more: Record<string, unknown> = {}): Exclude<Reply, "drop"> => ({ status: 200, body: { url: ADDRESS, expiresAt: EXPIRES, ...more } });
const refusal = (status: number, code: string, message: string, more: Record<string, unknown> = {}): Exclude<Reply, "drop"> =>
  ({ status, body: { error: { code, message, ...more }, next: [{ command: "mason destroy" }] } });

/**
 * One run of `mason ui …` against a fresh fake whose replica endpoint `v1` answers: signed in by MASON_TOKEN (a CI
 * token), or by a saved login (`saved`). Its requests, the fake's address and what the browser was handed.
 */
async function run(v1: (r: Req) => Reply, argv: string[], o: { token?: string; saved?: boolean; extra?: Record<string, string>; checked?: boolean } = {}):
  Promise<{ a: Answer; requests: Req[]; base: string; opened: string[] }> {
  const token = o.token ?? newToken(o.saved ? "pat" : "ci"); SECRETS.push(token);
  const fake = await fakeService({ v1 });
  const h = home();
  const b = browser();
  try {
    if (o.saved) writeSaved(h, { [fake.url]: { token, email: "ada@example.com", savedAt: EXPIRES } });
    const env = envFor(h, fake.url, { ...(o.saved ? {} : { MASON_TOKEN: token }), PATH: `${b.dir}${path.delimiter}${path.dirname(process.execPath)}`, ...o.extra });
    const a = o.checked === false ? await runMason(h, ["ui", ...argv], env, 60_000) : await mason(h, ["ui", ...argv], env, { lines: LINES });
    return { a, requests: fake.requests.filter((r) => r.path.startsWith("/v1/")), base: fake.url, opened: b.opened() };
  } finally { await fake.close(); }
}

test("mason ui --replica: one POST to the replica's page endpoint with the login as Bearer, the address opened in the browser and not printed", async () => {
  const r = await run(() => pageAnswer(), ["--replica", R], { saved: true });
  assert.equal(r.a.code, 0, r.a.stdout + r.a.stderr);
  assert.deepEqual(r.requests.map((q) => [q.method, q.path, q.search, q.body]), [["POST", PAGE, "", ""]]);
  assert.match(String(r.requests[0]!.headers.authorization), /^Bearer masondata_pat_/);
  const address = ADDRESS.replace("http://BASE", r.base);
  assert.deepEqual(r.opened, [address], "the browser is handed the one-use address, exactly");
  assert.ok(r.a.stdout.startsWith("The page of the replica acme/shop, opened in your browser\n"), r.a.stdout);
  assert.ok(!r.a.stdout.includes("ticket=") && !r.a.stderr.includes("ticket="), "opened, the address is printed nowhere");
  assert.match(r.a.stdout, /\n {2}replica +acme\/shop\n {2}expires +2026-11-07T10:05:00\.000Z\n/);
  assert.match(r.a.stdout, /\n {2}mason replica status acme\/shop +the replica's state/);
  assert.match(r.a.stdout, /\n {2}mason ui --replica acme\/shop +a new address/);
});

test("mason ui --replica --no-open: the address printed in its row, for the person, and no browser", async () => {
  const r = await run(() => pageAnswer(), ["--replica", R, "--no-open"], { saved: true });
  assert.equal(r.a.code, 0, r.a.stderr);
  assert.deepEqual(r.opened, []);
  assert.ok(r.a.stdout.startsWith("The page of the replica acme/shop\n"), r.a.stdout);
  assert.ok(r.a.stdout.includes(`\n  url       ${ADDRESS.replace("http://BASE", r.base)}\n`), r.a.stdout);
  assert.match(r.a.stdout, /Tip: The URL opens the page once, for you alone/);
});

test("mason ui --replica, a browser that will not start: the address printed, and why", async () => {
  const fake = await fakeService({ v1: () => pageAnswer() });
  const h = home();
  try {
    const token = newToken("ci"); SECRETS.push(token);
    // a PATH with no xdg-open: the opener cannot start
    const a = await mason(h, ["ui", "--replica", R], envFor(h, fake.url, { MASON_TOKEN: token }), { lines: LINES });
    assert.equal(a.code, 0, a.stderr);
    assert.ok(a.stdout.startsWith("The page of the replica acme/shop\n"), a.stdout);
    assert.ok(a.stdout.includes(`/replicas/acme/shop/page?ticket=`), "the address the person must open themselves");
    assert.match(a.stdout, /Tip: Could not open a browser \(xdg-open: [^)]*\): open the URL yourself\./);
  } finally { await fake.close(); }
});

test("mason ui --replica --json: one object { url, replica, expiresAt, next }, never a browser", async () => {
  const r = await run(() => pageAnswer({ next: [{ command: "mason destroy" }], extra: "ignored" }), ["--replica", R, "--json"], { saved: true });
  assert.equal(r.a.code, 0, r.a.stderr);
  assert.deepEqual(r.opened, [], "--json never opens a browser");
  const j = JSON.parse(r.a.stdout) as Record<string, unknown>;
  assert.deepEqual(j, { url: ADDRESS.replace("http://BASE", r.base), replica: R, expiresAt: EXPIRES,
    next: [{ command: "mason replica status acme/shop", what: "the replica's state, in this terminal" }, { command: "mason ui --replica acme/shop", what: "a new address: each opens the page once" }] });
  assert.equal(r.a.stderr, "");
});

test("mason ui with MASON_REPLICA: the replica's page, said on stderr; --replica comes first", async () => {
  let r = await run(() => pageAnswer(), ["--no-open"], { extra: { MASON_REPLICA: R } });
  assert.equal(r.a.code, 0, r.a.stderr);
  assert.deepEqual(r.requests.map((q) => q.path), [PAGE]);
  assert.equal(r.a.stderr, "using MASON_REPLICA=acme/shop (--replica names another; unset MASON_REPLICA for none)\n");
  r = await run(() => pageAnswer(), ["--replica", R, "--no-open"], { extra: { MASON_REPLICA: "other/one" } });
  assert.deepEqual(r.requests.map((q) => q.path), [PAGE]);
  assert.equal(r.a.stderr, "");
});

test("mason ui --replica as a login that is not the owner: the service's words, refused, exit 1, the way out mason login, nothing opened", async () => {
  const words = "only the organisation's owner opens a replica's page";
  for (const json of [false, true]) {
    const r = await run(() => refusal(403, "forbidden", words, { fix: "ask the owner of acme" }), ["--replica", R, ...(json ? ["--json"] : [])], { saved: true });
    assert.equal(r.a.code, 1);
    assert.deepEqual(r.opened, []);
    if (json) {
      const j = JSON.parse(r.a.stdout) as { error: { code: string; message: string; why: string; fix: string }; next: Array<{ command: string }> };
      assert.deepEqual(j.error, { code: "refused", message: words, why: "the service said forbidden, HTTP 403", fix: "ask the owner of acme" });
      assert.deepEqual(j.next.map((n) => n.command), ["mason login"], "the CLI's step, never the service's");
    } else {
      assert.ok(r.a.stderr.includes(`mason ui: ${words}`), r.a.stderr);
      assert.match(r.a.stderr, /mason login +sign in as the organisation's owner/);
    }
  }
});

test("mason ui --replica with a CI token in MASON_TOKEN: refused by the service (403), the way out the person's own login", async () => {
  const r = await run((q) => String(q.headers.authorization).startsWith("Bearer masondata_ci_") ? refusal(403, "forbidden", "a CI token cannot open a replica's page") : pageAnswer(),
    ["--replica", R, "--json"]);
  assert.equal(r.a.code, 1);
  assert.deepEqual(r.opened, []);
  const j = JSON.parse(r.a.stdout) as { error: { code: string; message: string }; next: Array<{ command: string }> };
  assert.equal(j.error.code, "refused");
  assert.equal(j.error.message, "a CI token cannot open a replica's page");
  assert.deepEqual(j.next.map((n) => n.command), ["env -u MASON_TOKEN mason ui --replica acme/shop"]);
});

test("mason ui --replica, a replica not ready (409) or not connected (503) with Retry-After: said with when to try again, never waited on", async () => {
  // the service's words, and the CLI's fix and steps naming the seconds it asked for
  let r = await run(() => ({ ...refusal(409, "not_ready", "the replica acme/shop is still being made"), headers: { "retry-after": "30" } }), ["--replica", R, "--json"]);
  assert.equal(r.a.code, 1);
  let j = JSON.parse(r.a.stdout) as { error: { code: string; message: string; fix: string }; next: Array<{ command: string; what: string }> };
  assert.equal(j.error.code, "refused");
  assert.equal(j.error.message, "the replica acme/shop is still being made");
  assert.equal(j.error.fix, "try again in 30 s; mason replica status acme/shop says whether it is ready");
  assert.deepEqual(j.next, [{ command: "mason replica status acme/shop", what: "whether it is ready" }, { command: "mason ui --replica acme/shop", what: "again in 30 s, as the service asks" }]);
  assert.equal(r.requests.length, 1, "one request: no loop");
  // a 503 with no words of the service's (a proxy's page): said in the CLI's
  r = await run(() => ({ status: 503, raw: "<html>unavailable</html>", headers: { "retry-after": "12" } }), ["--replica", R]);
  assert.equal(r.a.code, 1);
  assert.ok(r.a.stderr.includes("mason ui: the replica acme/shop is not ready to open its page (HTTP 503)"), r.a.stderr);
  assert.match(r.a.stderr, /its machine is not connected/);
  assert.match(r.a.stderr, /try again in 12 s/);
  assert.ok(!r.a.stderr.includes("<html>"), "the body is never said");
  assert.deepEqual(r.opened, []);
  assert.equal(r.requests.length, 1);
  r = await run(() => refusal(503, "not_connected", "the replica's machine is not connected"), ["--replica", R, "--json"]);
  j = JSON.parse(r.a.stdout) as typeof j;
  assert.equal(j.error.code, "failed");
  assert.equal(j.next[1]!.what, "again in a moment");
});

test("mason ui --replica, a replica the login does not see (404): not_found, the way out the organisation's replicas", async () => {
  const r = await run(() => refusal(404, "not_found", "no replica acme/shop"), ["--replica", R, "--json"], { saved: true });
  assert.equal(r.a.code, 1);
  const j = JSON.parse(r.a.stdout) as { error: { code: string }; next: Array<{ command: string }> };
  assert.equal(j.error.code, "not_found");
  assert.deepEqual(j.next.map((n) => n.command), ["mason replica list acme"]);
});

test("mason ui --replica, an answer outside the contract: refused before anything is opened or printed of it", async () => {
  const token = newToken("pat");
  const cases: Array<[what: string, body: Record<string, unknown> | ((q: Req) => Record<string, unknown>), said: RegExp]> = [
    ["another origin", { url: "https://elsewhere.example/replicas/acme/shop/page?ticket=x", expiresAt: EXPIRES }, /named a replica's page on another address: https:\/\/elsewhere\.example/],
    ["javascript:", { url: "javascript:alert(document.cookie)", expiresAt: EXPIRES }, /named a replica's page on another address: javascript:\/\//],
    ["a file", { url: "file:///etc/passwd", expiresAt: EXPIRES }, /named a replica's page on another address/],
    ["over-long", { url: `http://BASE/p?ticket=${"a".repeat(2100)}`, expiresAt: EXPIRES }, /where a replica's page was asked for/],
    ["holding the token", { url: `http://BASE/p?ticket=${token}`, expiresAt: EXPIRES }, /where a replica's page was asked for/],
    ["holding the token's body", { url: `http://BASE/p?ticket=${token.slice(-43)}`, expiresAt: EXPIRES }, /where a replica's page was asked for/],
    ["the token in another key", { url: ADDRESS, expiresAt: EXPIRES, note: token }, /where a replica's page was asked for/],
    ["a user in it", (q) => ({ url: `http://u:p@${String(q.headers.host)}/p`, expiresAt: EXPIRES }), /where a replica's page was asked for/],
    ["a character a shell reads", { url: "http://BASE/p?ticket=a&b=c", expiresAt: EXPIRES }, /where a replica's page was asked for/],
    ["a percent escape", { url: "http://BASE/p?ticket=%41", expiresAt: EXPIRES }, /where a replica's page was asked for/],
    ["no expiresAt", { url: ADDRESS }, /where a replica's page was asked for/],
    ["a time outside its grammar", { url: ADDRESS, expiresAt: "soon" }, /where a replica's page was asked for/],
    ["no url", { expiresAt: EXPIRES }, /where a replica's page was asked for/],
  ];
  for (const [what, body, said] of cases) {
    const r = await run((q) => ({ status: 200, body: typeof body === "function" ? body(q) : body }), ["--replica", R], { token, saved: true });
    assert.equal(r.a.code, 1, `${what}: ${r.a.stdout}${r.a.stderr}`);
    assert.deepEqual(r.opened, [], `${what}: nothing opened`);
    assert.equal(r.a.stdout, "", `${what}: nothing printed on stdout`);
    assert.match(r.a.stderr, said, what);
    assert.ok(!r.a.stderr.includes("ticket="), `${what}: nothing of the address said`);
  }
  // an answer that is not JSON
  const r = await run(() => ({ status: 200, raw: "<html></html>" }), ["--replica", R, "--json"], { saved: true });
  assert.equal(r.a.code, 1);
  assert.equal((JSON.parse(r.a.stdout) as { error: { code: string } }).error.code, "failed");
});

test("mason ui --replica, not signed in: refused with the way out, nothing sent", async () => {
  const fake = await fakeService({ v1: () => pageAnswer() });
  const h = home();
  try {
    const a = await mason(h, ["ui", "--replica", R, "--json"], envFor(h, fake.url), { lines: LINES });
    assert.equal(a.code, 1);
    assert.equal((JSON.parse(a.stdout) as { error: { code: string } }).error.code, "refused");
    assert.deepEqual(fake.requests, []);
  } finally { await fake.close(); }
});

test("mason ui --replica beside --ssh, --bridge, --mason, --timeout or --local-port, or a replica not <org>/<name>: a wrong line, exit 2, nothing sent", async () => {
  for (const extra of [["--ssh", "deploy@server"], ["--bridge"], ["--mason", "mason"], ["--timeout", "10s"], ["--local-port", "51000"], ["--bridge", "--local-port", "51000"]]) {
    for (const json of [false, true]) {
      const r = await run(() => pageAnswer(), ["--replica", R, ...extra, ...(json ? ["--json"] : [])], { checked: false });
      assert.equal(r.a.code, 2, `${extra.join(" ")}: ${r.a.stdout}${r.a.stderr}`);
      assert.deepEqual(r.requests, [], extra.join(" "));
      assert.deepEqual(r.opened, []);
      const message = `--replica opens a hosted replica's page: it goes with --no-open and --json alone, not ${extra.filter((x) => x.startsWith("--")).join(", ")}`;
      if (json) assert.deepEqual((JSON.parse(r.a.stdout) as { error: { code: string; message: string } }).error, { code: "usage", message });
      else assert.ok(r.a.stderr.includes(`mason ui: ${message}`) && r.a.stderr.includes("usage: mason ui"), r.a.stderr);
    }
  }
  const r = await run(() => pageAnswer(), ["--replica", "Acme/shop/x"], { checked: false });
  assert.equal(r.a.code, 2);
  assert.match(r.a.stderr, /--replica "Acme\/shop\/x" is not <org>\/<name>/);
  assert.deepEqual(r.requests, []);
  // MASON_REPLICA never turns --ssh or --bridge to a replica: they name their own target (a wrong --ssh is still --ssh's)
  const s = await run(() => pageAnswer(), ["--ssh", "bad target"], { checked: false, extra: { MASON_REPLICA: R } });
  assert.equal(s.a.code, 2);
  assert.match(s.a.stderr, /--ssh: /);
  assert.deepEqual(s.requests, []);
});

test("mason ui --replica on a narrow terminal: every line the person sees is one the CLI began, the service's address included", async () => {
  for (const width of [24, 40, 80]) {
    for (const reply of [pageAnswer(), refusal(403, "forbidden", `only the owner ${"x".repeat(60)} opens it`)]) {
      const fake = await fakeService({ v1: () => reply });
      const h = home();
      try {
        const token = newToken("pat"); SECRETS.push(token);
        writeSaved(h, { [fake.url]: { token, email: "ada@example.com", savedAt: EXPIRES } });
        const a = await mason(h, ["ui", "--replica", R, "--no-open"], envFor(h, fake.url), { lines: LINES, terminal: width });
        assert.equal(a.code, reply.status === 200 ? 0 : 1, `${width}: ${a.stdout}${a.stderr}`);
      } finally { await fake.close(); }
    }
  }
});
