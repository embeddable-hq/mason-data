/**
 * THE DATABASE'S PASSWORD, HELD BY ONE RULE AT EVERY BOUNDARY (PR 660's review, B1), against a fake hosted service
 * (tests/replica-fake.ts): echoed by the service in every value `mason replica create` prints, in every form, it is never
 * printed whole; one under MIN_PASSWORD is not sent. A file of its own, importing nothing of the command's module, so it
 * loads at any commit (scripts/fails-without.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { envFor, fakeService, home, newToken, type Reply } from "./hosted-fake.ts";
import { runMason } from "./cli-matrix.ts";
import { CHECKS, created, hosted, project, replicaOf } from "./replica-fake.ts";

/** Whether `text` shows `password` whole: as written, in any case, or %-encoded (as a URL writes it), or decoded from that. */
const showsPassword = (text: string, password: string): boolean => {
  const t = text.toLowerCase(), decoded = text.replace(/%([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))).toLowerCase();
  return [password, encodeURIComponent(password)].some((p) => t.includes(p.toLowerCase()) || decoded.includes(p.toLowerCase()));
};

test("the database's password is held by ONE rule at every boundary, whatever its length from 8 and its alphabet: echoed in a value held to a grammar (hostId, region, an allowlist entry, a key), in a check's words, a refusal's words or a pending change's failure — as written, re-cased or %-encoded — it is never printed whole; one under 8 is not sent (PR 660's review, B1)", { timeout: 600_000 }, async () => {
  const passwords = ["abcdefgh", "ab3def6hjk", "Zq8vLm2Xr7Tp", "!*!*!*!*!*!*!*!*!*!*!*a1", "!!!!!!!!!!!!!!!!ab", "pass word 1", "pässwörd99", "deadbeefcafe"];
  const forms = [(p: string) => p, (p: string) => p.toUpperCase(), (p: string) => encodeURIComponent(p)];
  const slots: Array<[string, (e: string) => Reply]> = [
    ["hostId", (e) => created({ hostId: e })],
    ["region", (e) => created({ region: e })],
    ["an allowlist entry", (e) => created({ allowlist: [`${e}/1`] })],
    ["a key", (e) => ({ status: 201, body: { replica: { ...replicaOf(), [e]: 1 }, checks: CHECKS } })],
    ["a check's detail", (e) => ({ status: 201, body: { replica: replicaOf(), checks: [{ ...CHECKS[0], checks: [{ name: "connects", status: "ok", detail: `connected with ${e}` }] }] } })],
    ["a check's name and missing", (e) => ({ status: 201, body: { replica: replicaOf(), checks: [{ ...CHECKS[0], checks: [{ name: e, status: "ok", detail: "x" }], missing: [e] }] } })],
    ["a refusal's words", (e) => ({ status: 403, body: { error: { code: "refused", message: `refused ${e}`, why: e, fix: `x${e}x` } } })],
    ["a pending change's failure", (e) => created({ pending: [{ change: "allowlist", state: "failed", attempts: 1, failure: `could not ${e}` }] })],
  ];
  let runs = 0;
  for (const [i, password] of passwords.entries()) {
    const root = project({ url: `postgres://app:${encodeURIComponent(password)}@db.example:5432/app` });
    for (const [j, [what, reply]] of slots.entries()) {
      const form = forms[(i + j) % forms.length]!;
      const json = (i + j) % 2 === 0 ? ["--json"] : [];
      const { a, requests } = await hosted(() => reply(form(password)), ["create", "acme/shop", "--region", "eu", "--size", "50", ...json], { cwd: root });
      runs++;
      assert.equal(JSON.parse(requests[0]!.body).sources[0].url, `postgres://app:${encodeURIComponent(password)}@db.example:5432/app`, "the URL is sent as it was read");
      assert.ok(!showsPassword(a.stdout + a.stderr, password), `${JSON.stringify(password)} in ${what} (${form("x") === "x" ? "as written" : form("x") === "X" ? "re-cased" : "encoded"}) was printed:\n${a.stdout}${a.stderr}`);
    }
  }
  assert.equal(runs, passwords.length * slots.length);
  // under 8 characters, whatever they are: refused before a byte is sent, its length said, never it
  for (const short of ["x", "ab3d", "!*!*a1", "hunter2"]) {
    const fake = await fakeService({ v1: () => created() });
    try {
      const a = await runMason(project({ url: `postgres://app:${encodeURIComponent(short)}@db.example:5432/app` }), ["replica", "create", "acme/shop", "--region", "eu", "--size", "50", "--json"], envFor(home(), fake.url, { MASON_TOKEN: newToken() }));
      const e = (JSON.parse(a.stdout) as { error: { code: string; message: string } }).error;
      assert.deepEqual([a.code, e.code], [1, "refused"], short);
      assert.equal(e.message, `the password in DATABASE_URL (DATABASE_URL in .env) is ${[...short].length} character${short.length === 1 ? "" : "s"} long, under the 8 this command sends`);
      assert.ok(!a.stdout.includes(short) || short === "x", short);
      assert.deepEqual(fake.requests, [], `${short}: nothing sent`);
    } finally { await fake.close(); }
  }
});
