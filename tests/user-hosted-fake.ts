/**
 * THE FAKE SERVICE'S RUNS OF `mason user … --replica`, for tests/cli-user-hosted.test.ts, tests/cli-user-hosted-refusals.test.ts
 * and tests/cli-user-hosted-terminal.test.ts (split so each file runs within the suite's bound on a loaded machine):
 * the replica's name and paths, the lines mason user begins (tests/hosted-fake.ts's rule in its words), one run against
 * a fresh fake (`hosted`), the answers the run's /api/users gives, and the last test of each file.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { ANSWERS, envFor, fakeService, home, mason, newToken, SECRETS, type Lines, type Reply, type Req } from "./hosted-fake.ts";
import type { Answer } from "./cli-matrix.ts";
import { connectionUrl, psqlLine } from "../src/cli/pg-url.ts";

export const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

export const R = "acme/shop";
export const USERS = "/v1/replicas/acme/shop/users";
/** The steps under Next: and in --json, the CLI's own: the local command's, each naming the replica, or mason login. */
export const OWN_STEP = /^ {2}(mason login|mason user (add|list|remove|enable|disable|from)( \S+)?( --any)? --replica acme\/shop)(\s|$)/;
/** The lines mason user begins (tests/hosted-fake.ts's rule, in its words); a list's row is begun by a user's name. On a
 *  terminal `width` wide a head longer than the line may be broken by the CLI within a word, exactly at its limit. */
export const linesFor = (names: readonly string[] = [], width: number | null = null): Lines => {
  const heads = ["The user ", "No users yet for ", "✘ mason user: ", "✗ mason user: ",
    "Tip: Paste it into the tool now: ", "Tip: It never expires: ", "Tip: Rotating the API key ", "Tip: Last used: ", "Tip: Adding ", "Tip: It connects no more until ", "Tip: A connection from any other address ",
    ...["url", "psql", "user", "password", "database", "attributes", "role", "from", "host", "port", "ssl mode", "disabled", "added", "sessions", "why", "fix"].map((l) => `  ${l} `)];
  return { heads, steps: ["  mason user ", "  mason login"], ownStep: OWN_STEP,
    row: (line) => /^\d+ users?( |$)/.test(line) || (((m) => m !== null && names.includes(m[1]!))(/^ {2}([a-z0-9][a-z0-9_.-]*)( |$)/.exec(line)))
      || (width !== null && [...line].length === width - 1 && heads.some((h) => h.startsWith(line))) };
};

/** One run against a fresh fake whose replica endpoints `v1` answers, signed in by MASON_TOKEN; its requests. */
export async function hosted(v1: (r: Req) => Reply | Promise<Reply>, argv: string[], o: { extra?: Record<string, string>; terminal?: number; names?: readonly string[]; cwd?: string } = {}): Promise<{ a: Answer; requests: Req[]; token: string; home: string }> {
  const token = newToken("ci"); SECRETS.push(token);
  const fake = await fakeService({ v1 });
  const h = home();
  try {
    const a = await mason(o.cwd ?? h, ["user", ...argv], envFor(h, fake.url, { MASON_TOKEN: token, ...o.extra }), { lines: linesFor(o.names, o.terminal ?? null), ...(o.terminal ? { terminal: o.terminal } : {}) });
    return { a, requests: fake.requests.filter((r) => r.path.startsWith("/v1/")), token, home: h };
  } finally { await fake.close(); }
}

export const ID = "0123456789abcdef";
export const PASSWORD = `mason_${ID}_${"9".repeat(32)}`;
export const AT = "2026-11-02T10:00:00.000Z";
export const LINK = { url: "", host: "db.example", port: 5433, database: "shop", sslmode: "require" as const };
export const addedAnswer = (name: string, more: Record<string, unknown> = {}): Record<string, unknown> => {
  const password = `mason_${ID}_${"9".repeat(32)}`;
  const url = connectionUrl(LINK, name, password);
  return { user: name, id: ID, addedAt: AT, password, database: "shop", url, psql: psqlLine(url), host: "db.example", port: 5433, sslmode: "require", roleFrom: "none", ...more };
};
export const row = (name: string, more: Record<string, unknown> = {}): Record<string, unknown> => ({ name, id: ID, addedAt: AT, removedAt: null, disabledAt: null, live: true, lastUsedAt: null,
  url: connectionUrl(LINK, name, null), roleFrom: "none", ...more });
export const listAnswer = (users: unknown[], more: Record<string, unknown> = {}): Reply => ({ status: 200, body: { users, lastUsedNote: null, urlNote: null, requestLogDays: 7, next: [{ command: "mason destroy" }], ...more } });
export const ok = (body: unknown): Reply => ({ status: 200, body });

/** The last test of a file: no run printed a token, nor put one on its command line, and the file ran at least `min`. */
export function noTokenPrinted(min: number): void {
  test("no run of mason user --replica printed a token, nor put one on its command line", () => {
    assert.ok(ANSWERS.length >= min, `the runs above are here (${ANSWERS.length})`);
    for (const a of ANSWERS) {
      for (const s of SECRETS) assert.ok(!a.stdout.includes(s) && !a.stderr.includes(s) && !a.argv.some((x) => x.includes(s)), `mason ${a.argv.join(" ")} printed a token`);
      assert.doesNotMatch(a.stdout + a.stderr, /masondata_(pat|ci)_[A-Za-z0-9_-]{43}/, `mason ${a.argv.join(" ")}`);
    }
  });
}
