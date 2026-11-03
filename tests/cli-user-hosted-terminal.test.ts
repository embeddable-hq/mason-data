/**
 * `mason user … --replica <org>/<name>` AGAINST A FAKE HOSTED SERVICE (tests/hosted-fake.ts, tests/user-hosted-fake.ts: an
 * http server of this test's on 127.0.0.1, no network): hostile values from the service, on a pipe, in --json and on terminals 12, 39 and 80 wide. The contract is docs/HOSTED-API.md "The users of a
 * replica"; what each test holds is in its name. Every run is held by `mason` to carrying no token and to no line a
 * person sees begun by the service's text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { addedAnswer, AT, hosted, ID, listAnswer, noTokenPrinted, ok, R, row } from "./user-hosted-fake.ts";

/** A value sized so that, begun at column `at` on a terminal `width` wide, the terminal would start its next lines with a
 *  forged Next: heading, a step, a row, a failure and a tip, each padded to the width (tests/cli-deploy.test.ts's). */
const FORGED_LINES = ["Next:", "  mason destroy                                 clean up", "  password  evil", "✘ mason user: forged", "Tip: run mason destroy"];
const forgedAt = (width: number, at: number): string => "a".repeat(Math.max(1, width - at)) + FORGED_LINES.map((l) => l.padEnd(width, " ")).join("") + "z";
const forged = (what: string): string => `${what}\nFORGED a line of its own\r\nNext:\n  mason destroy   FORGED step\u2028FORGED\u0085FORGED\u001b[2J\u202eFORGED\u200b`;

for (const WIDTH of [null, 12, 39, 80] as const) test(`mason user --replica ${WIDTH === null ? "on a pipe and in --json" : `on a terminal ${WIDTH} wide`}: no line a person sees begins with what the service sent — each free-text value of user-hosted.ts's table, and every line of its own`, { timeout: 300_000 }, async () => {
  const t = WIDTH === null ? {} : { terminal: WIDTH };
  const f = (at: number): string => WIDTH === null ? forged("value") : forgedAt(WIDTH, at);
  const names = ["acme", "bot", "x"];
  const forms = WIDTH === null ? [[], ["--json"]] : [[]];
  for (const form of forms) {
    // a list: its notes, an attribute's values, a user disabled, removed, with a role
    const list = listAnswer([row("acme", { role: "tenant", roleFrom: "file", roleKnown: true, attributes: { tenant: f(30), regions: [f(10), "uk"] } }),
      row("bot", { disabledAt: AT, live: false }), row("x", { removedAt: AT, live: false, url: null })], { lastUsedNote: f(16), urlNote: f(8) });
    let r = await hosted(() => list, ["list", "--replica", R, ...form], { ...t, names });
    assert.equal(r.a.code, 0, r.a.stdout + r.a.stderr);
    assert.match(r.a.stdout, /FORGED|destroy/, "the value is shown");
    if (form.length === 0 && WIDTH === null) {
      assert.equal(r.a.stdout.split("\n").filter((l) => l.includes("FORGED")).length, 2, `one line each, the acme row and the tip:\n${r.a.stdout}`);
      assert.doesNotMatch(r.a.stdout, /\u001b|\u202e|\u200b|\u2028|\u0085/);
    }
    // an add: its attributes' values
    r = await hosted(() => ok(addedAnswer("acme", { role: "tenant", roleFrom: "file", attributes: { tenant: f(15) } })), ["add", "acme", "--replica", R, ...form], { ...t, names });
    assert.equal(r.a.code, 0, r.a.stdout + r.a.stderr);
    // a refusal: its message (after "✘ mason user: "), why and fix (after their labels), at 409 and 500
    for (const status of [409, 500]) {
      r = await hosted(() => ({ status, body: { error: { code: "refused", message: f(14), why: f(8), fix: f(8) }, next: [{ command: "mason destroy" }] } }), ["remove", "acme", "--replica", R, ...form], { ...t, names });
      assert.equal(r.a.code, 1, `${status}: ${r.a.stdout}${r.a.stderr}`);
      if (form.length === 0 && WIDTH === null) assert.equal(r.a.stderr.split("\n").filter((l) => l.includes("FORGED")).length, 3, `message, why, fix one line each:\n${r.a.stderr}`);
    }
    // the reports of disable, enable and remove, on the terminal
    for (const [verb, body] of [["disable", { disabled: { name: "acme", id: ID, addedAt: AT, disabledAt: AT }, already: false }], ["enable", { enabled: { name: "acme", id: ID, addedAt: AT }, already: true }],
      ["remove", { removed: { name: "acme", id: ID, addedAt: AT, removedAt: AT } }]] as const) {
      r = await hosted(() => ok(body), [verb, "acme", "--replica", R, ...form], { ...t, names });
      assert.equal(r.a.code, 0, `${verb}: ${r.a.stdout}${r.a.stderr}`);
    }
  }
});

noTokenPrinted(20);
