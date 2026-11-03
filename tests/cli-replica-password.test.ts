/**
 * THE DATABASE'S PASSWORD, HELD BY ONE READING AT EVERY BOUNDARY (PR 660's review, B1, and its class round, R2-B1),
 * against a fake hosted service (tests/replica-fake.ts): echoed by the service in every value `mason replica create`
 * prints, in every form of tests/hosted-fake.ts `ECHO_FORMS`, it is never printed whole; one under MIN_PASSWORD, or one
 * the CLI's own words hold (R2-B2), is not sent. A file of its own, importing nothing of the command's module, so it
 * loads at any commit (scripts/fails-without.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ECHO_FORMS, envFor, fakeService, home, newToken, printsWhole, type Reply } from "./hosted-fake.ts";
import { runMason, type Answer } from "./cli-matrix.ts";
import { CHECKS, created, hosted, project, replicaOf } from "./replica-fake.ts";

/** Every value create prints that a service sends, as a slot an echo is put in. */
const SLOTS: ReadonlyArray<readonly [string, (e: string) => Reply]> = [
  ["hostId", (e) => created({ hostId: e })],
  ["region", (e) => created({ region: e })],
  ["an allowlist entry", (e) => created({ allowlist: [`${e}/1`] })],
  ["a key", (e) => ({ status: 201, body: { replica: { ...replicaOf(), [e]: 1 }, checks: CHECKS } })],
  ["a check's detail", (e) => ({ status: 201, body: { replica: replicaOf(), checks: [{ ...CHECKS[0], checks: [{ name: "connects", status: "ok", detail: `connected with ${e}` }] }] } })],
  ["a check's name and missing", (e) => ({ status: 201, body: { replica: replicaOf(), checks: [{ ...CHECKS[0], checks: [{ name: e, status: "ok", detail: "x" }], missing: [e] }] } })],
  ["a refusal's words", (e) => ({ status: 403, body: { error: { code: "refused", message: `refused ${e}`, why: e, fix: `x${e}x` } } })],
  ["a pending change's failure", (e) => created({ pending: [{ change: "allowlist", state: "failed", attempts: 1, failure: `could not ${e}` }] })],
];

/** Run `jobs`, at most `n` at once. */
async function pool<T>(jobs: Array<() => Promise<T>>, n: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < jobs.length) { const k = i++; out[k] = await jobs[k]!(); } }));
  return out;
}

const urlOf = (password: string): string => `postgres://app:${encodeURIComponent(password)}@db.example:5432/app`;

test("the database's password is held by ONE reading at every boundary: echoed by the service in EVERY form (ECHO_FORMS: its case, %XX, each normal form, its accents dropped, full-width, a zero-width, control or escape between its characters, other spaces) through EVERY printed value — a value held to a grammar, a key, a check's words, a refusal's, a pending change's failure — it is never printed whole, for a person or in --json (PR 660, B1 and R2-B1)", { timeout: 900_000 }, async () => {
  // the widest alphabets (accents and a ß, symbols with few letters); tests/cli-hosted.test.ts holds nine through each boundary
  const passwords = ["Ünïcödé-straße", "!*!*!*!*zz"];
  const jobs: Array<() => Promise<string | null>> = [];
  for (const password of passwords) {
    const root = project({ url: urlOf(password) });
    for (const [what, form] of ECHO_FORMS) for (const [slot, reply] of SLOTS) for (const json of [false, true]) {
      // one form a run, both readers: a person's every other pair, --json the rest
      if ((ECHO_FORMS.findIndex(([w]) => w === what) + SLOTS.findIndex(([s]) => s === slot)) % 2 !== (json ? 1 : 0)) continue;
      jobs.push(async () => {
        const { a, requests } = await hosted(() => reply(form(password)), ["create", "acme/shop", "--region", "eu", "--size", "50", ...(json ? ["--json"] : [])], { cwd: root });
        if (requests.length === 0 || JSON.parse(requests[0]!.body).sources[0].url !== urlOf(password)) return `${password}: the URL was not sent as it was read`;
        return printsWhole(a.stdout + a.stderr, password) ? `${JSON.stringify(password)} ${what} in ${slot}${json ? " (--json)" : ""} was printed:\n${a.stdout}${a.stderr}` : null;
      });
    }
  }
  assert.equal(jobs.length, passwords.length * ECHO_FORMS.length * SLOTS.length);
  const problems = (await pool(jobs, 8)).filter((x): x is string => x !== null);
  assert.deepEqual(problems, []);
});

/** A create in a project whose URL holds `password`, against a fake that would answer; the run and what it sent. */
async function notSent(password: string, json: boolean): Promise<{ a: Answer; sent: number }> {
  const fake = await fakeService({ v1: () => created() });
  try {
    const a = await runMason(project({ url: urlOf(password) }), ["replica", "create", "acme/shop", "--region", "eu", "--size", "50", ...(json ? ["--json"] : [])], envFor(home(), fake.url, { MASON_TOKEN: newToken() }));
    return { a, sent: fake.requests.length };
  } finally { await fake.close(); }
}

test("a password under 8 characters, in the one reading — however it is written: 7 letters, symbols, spaces, zero-width marks — is not sent, and the refusal names neither it nor its length", async () => {
  for (const short of ["x", "ab3d", "!*!*a1", "hunter2", " ".repeat(8), "a​b​c​d​e​f​g"]) {
    for (const json of [false, true]) {
      const { a, sent } = await notSent(short, json);
      const said = json ? (JSON.parse(a.stdout) as { error: { code: string; message: string } }).error : null;
      assert.equal(a.code, 1, `${JSON.stringify(short)}: ${a.stdout}${a.stderr}`);
      if (said) assert.deepEqual([said.code, said.message], ["refused", "the password in DATABASE_URL (DATABASE_URL in .env) is shorter than the 8 characters this command sends"]);
      else assert.match(a.stderr, /^✗ mason replica: the password in DATABASE_URL \(DATABASE_URL in \.env\) is shorter than the 8 characters this command sends$/m);
      assert.equal(sent, 0, `${JSON.stringify(short)}: nothing sent`);
    }
  }
});

test("a password the CLI's own words hold (its lines, its steps, the replica's name, the service's address) is refused before anything is sent, for a person and with --json alike, never blaming the service and never naming it; an honest run of any other password is never refused by the gate (PR 660's review, R2-B2)", async () => {
  for (const password of ["variable", "readsitby", "environment", "database", "thereplica", "acme/shop", "Created acme", "createitagain"]) {
    for (const json of [false, true]) {
      const { a, sent } = await notSent(password, json);
      const all = a.stdout + a.stderr;
      assert.equal(a.code, 1, `${password}: ${all}`);
      assert.equal(sent, 0, `${password}: nothing sent`);
      assert.match(all, /the password in DATABASE_URL \(DATABASE_URL in \.env\) is in the words this command prints itself/, password);
      assert.doesNotMatch(all, /the service's answer|sign in again/, `${password}: never the service's fault`);
    }
  }
  // the honest runs of a password the CLI's words do not hold: made, ready, exit 0, both readers alike
  for (const password of ["Zq8vLm2Xr7Tp", "Ünïcödé-pw", "!*!*!*!*zz"]) {
    for (const json of [[], ["--json"]]) {
      const { a } = await hosted(() => created(), ["create", "acme/shop", "--region", "eu", "--size", "50", ...json], { cwd: project({ url: urlOf(password) }) });
      assert.equal(a.code, 0, `${password} ${json.join("")}: ${a.stdout}${a.stderr}`);
      assert.ok(!printsWhole(a.stdout + a.stderr, password));
    }
  }
});
