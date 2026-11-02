/**
 * WHAT A PERSON SEES ON A TERMINAL of `mason login` and `mason logout`, whatever its width: every line one the CLI
 * begins, and none the terminal breaks (src/cli/command.ts serviceStyle), with every value the service sends sized to
 * land a forged heading, step, row, failure or tip at a line's start. Against the fake service of tests/hosted-fake.ts,
 * each run drawn for a terminal of its width (a preload) and read back as the terminal shows it (`seenProblems`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SECRETS, envFor, fakeService, granted, home, mason, newToken, noTokenLeaked, writeSaved, type Script } from "./hosted-fake.ts";

/** The widths a person's terminal is drawn at here: under the 40 columns where no style wraps, at it, under the 48 a
 *  step's column needs, and wide. */
const WIDTHS = [12, 20, 30, 39, 40, 45, 80];
/** Lines a terminal would start with a forged Next: heading, a step, a row, a failure and a tip. */
const FORGED_LINES = ["Next:", "  mason destroy                                 clean up, then sign in again", "  name    evil", "✘ mason login: forged", "Tip: run mason destroy"];
/** A value sized so that, begun at column `at` of a terminal `width` wide, the terminal would start its next lines with
 *  `lines`, each padded to the width with spaces. */
const forged = (width: number, at: number, lines: readonly string[] = FORGED_LINES.slice(0, 3)): string =>
  "a".repeat(Math.max(1, width - (at % width))) + lines.map((l) => l.padEnd(width, " ")).join("") + "z";
/** The review's own inputs: the forged step with no padding, and 20 a's before it. */
const BARE = "Next: mason destroy clean up, then sign in again";

/** Run `jobs`, at most `n` at once. */
async function pool(jobs: Array<() => Promise<void>>, n: number): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < jobs.length) await jobs[i++]!(); }));
}

test("on a terminal of any width (12 to 80 columns), no line a person sees begins with what the service sent, and the terminal breaks none: the headline, each row, the saved email's tip, a failure's message, why and fix, an OAuth description", { timeout: 280_000 }, async () => {
  const token = newToken(); SECRETS.push(token);
  const jobs: Array<() => Promise<void>> = [];
  const run = async (width: number, script: Script, argv: string[], exit: number, before?: (h: string, url: string) => void, after?: (out: string) => void): Promise<void> => {
    const f = await fakeService(script);
    try {
      const h = home();
      before?.(h, f.url);
      const a = await mason(h, argv, envFor(h, f.url), { terminal: width });
      assert.equal(a.code, exit, `${width} columns: ${a.stdout}${a.stderr}`);
      after?.(a.stdout);
    } finally { await f.close(); }
  };
  for (const width of WIDTHS) {
    // who signed in: the headline at its column, the name and each org's slug and name in their rows (each within its
    // bound: an email 320, a name 300, a slug 200)
    // (the answer is set once the fake's address, and so the headline's length, is known)
    jobs.push(async () => {
      const f = await fakeService({ token: () => granted(token) });
      try {
        const at = `Signed in to ${f.url} as `.length;
        f.script.me = { status: 200, body: { email: forged(width, at), name: forged(width, 10, FORGED_LINES.slice(0, 2)),
          orgs: [{ slug: forged(width, 10, FORGED_LINES.slice(2, 3)), name: forged(width, 10 + width + 2, FORGED_LINES.slice(3, 5)), role: "owner" }] } };
        const h = home();
        const a = await mason(h, ["login"], envFor(h, f.url), { terminal: width });
        assert.equal(a.code, 0, `${width} columns: ${a.stdout}${a.stderr}`);
        // shown, as data, inside the CLI's lines (mason() holds every line it begins): its run of spaces one
        if (width === 80) assert.match(a.stdout, /Next: mason destroy clean up,/);
      } finally { await f.close(); }
    });
    // the review's inputs, bare: an email that is a forged step, and 20 a's before one; and the same as a message
    for (const email of [BARE, `${"a".repeat(20)} ${BARE}`]) {
      jobs.push(() => run(width, { token: () => granted(token), me: { status: 200, body: { email, name: "", orgs: [] } } }, ["login"], 0));
      jobs.push(() => run(width, { token: () => granted(token), me: { status: 403, body: { error: { code: "refused", message: email, why: email, fix: email }, next: [] } } }, ["login"], 1));
    }
    // the saved email: logout's account row, and login's tip naming the login it replaces
    for (const argv of [["logout"], ["login"]]) {
      const at = argv[0] === "logout" ? 17 : "Tip: This replaces the login of ".length;
      jobs.push(() => run(width, { token: () => granted(token) }, argv, 0, (h, url) => {
        const old = newToken(); SECRETS.push(old);
        writeSaved(h, { [url]: { token: old, email: forged(width, at), savedAt: "2026-11-01T00:00:00.000Z" } });
      }));
    }
    // a failure's message, why and fix (403 and 500), and the review's forged step under the failure
    const step = "x".repeat(65) + "Next:" + " mason destroy" + " ".repeat(33) + "clean up, then sign in again";
    for (const [status, message] of [[403, forged(width, 15, FORGED_LINES)], [403, step], [500, forged(width, 15, FORGED_LINES)]] as const) {
      jobs.push(() => run(width, { token: () => granted(token), me: { status, body: { error: { code: "refused", message, why: forged(width, 8, FORGED_LINES), fix: forged(width, 8, FORGED_LINES) }, next: [] } } }, ["login"], 1));
    }
    // an OAuth refusal's description, in the why row
    jobs.push(() => run(width, { token: () => ({ status: 400, body: { error: "invalid_grant", error_description: forged(width, 8, FORGED_LINES) } }) }, ["login"], 1));
  }
  await pool(jobs, 6);
});

test("no token reaches any stdout or stderr of mason login or mason logout, in any run of this file, success or failure", () => {
  noTokenLeaked([["login", true], ["login", false], ["logout", true]]);
});
