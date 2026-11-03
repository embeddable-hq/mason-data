/**
 * THE FAKE SERVICE'S RUNS OF `mason replica`, for tests/cli-replica.test.ts and tests/cli-replica-password.test.ts
 * (split so each file runs within the suite's bound): the replica's answers, the lines mason replica begins
 * (tests/hosted-fake.ts's rule in its words), a project whose sources file names its database by a variable, and one
 * run against a fresh fake (`hosted`), held to carrying no token and never the database's password.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { envFor, fakeService, home, mason, newToken, SECRETS, type Lines, type Reply, type Req } from "./hosted-fake.ts";
import type { Answer } from "./cli-matrix.ts";

export const AT = "2026-11-02T10:00:00.000Z";
/** The database's password: long enough (12) to be held by the exact test and the output's gate, as the token is. */
export const PASSWORD = "Zq8vLm2Xr7Tp";
export const URL_ = `postgres://app_reader:${PASSWORD}@db.example:5432/app`;
export const REPLICAS = "/v1/replicas/acme";
export const ONE = `${REPLICAS}/shop`;
export const replicaOf = (more: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ org: "acme", name: "shop", region: "eu", sizeGb: 50, hostId: "brisk-otter-4821", state: "ready", createdAt: AT, allowlist: [], pending: [], ...more });
export const CHECKS = [{ source: "app", outcome: "passed", checks: [{ name: "connects", status: "ok", detail: "Postgres 16 answers" },
  { name: "the role", status: "warn", detail: "it may write to a synced table", fix: "a role that only reads" }], missing: [] }];
export const created = (more: Record<string, unknown> = {}): Reply => ({ status: 201, body: { replica: replicaOf(more), checks: CHECKS }, headers: { "retry-after": "1" } });
export const ok = (body: unknown, headers?: Record<string, string>): Reply => ({ status: 200, body, ...(headers ? { headers } : {}) });

/** The lines mason replica begins (tests/hosted-fake.ts's rule, in its words); a list's row is begun by a replica's name. */
export const OWN_STEP = /^ {2}(mason login|mason doctor|mason replica (create|list|status)( \S+)*|mason (deploy|token create) --replica acme\/shop)(\s|$)/;
export const LINES: Lines = {
  heads: ["Created ", "Creating ", "acme/shop on ", "No replicas yet in ", "Mason's checks of the database ", "✘ mason replica: ", "✗ mason replica: ",
    "  ok ", "  !  ", "  !! ", "  ?  ", "  The creation's answer was lost ", "  checking: ", "  creating: ", "Tip: The service does not keep ", "Tip: acme has more ",
    ...["state", "region", "size", "host", "created", "allowlist", "pending", "why", "fix"].map((l) => `  ${l} `)],
  steps: ["  mason login", "  mason doctor", "  mason replica ", "  mason deploy ", "  mason token "], ownStep: OWN_STEP,
  row: (line) => /^\d+ replicas? in /.test(line) || /^ {2}(acme|beta)\/[a-z]+ /.test(line),
};

/** A project whose sources file names its database by DATABASE_URL, set in its .env (or as `env` says). */
export function project(o: { url?: string | null; file?: string } = {}): string {
  const root = home();
  fs.mkdirSync(path.join(root, ".mason"), { mode: 0o700 });
  fs.mkdirSync(path.join(root, "mason", "sources"), { recursive: true });
  fs.writeFileSync(path.join(root, ".mason", "config.json"), JSON.stringify({ name: "shop", folder: "mason", remote: false, apiKey: "k".repeat(48), sourceServer: null, running: null, lastRun: null }), { mode: 0o600 });
  fs.writeFileSync(path.join(root, "mason", "sources", "app.yml"), o.file ?? "kind: postgres\nurl: ${DATABASE_URL}\ntables:\n  orders: {}\n");
  if (o.url !== null) fs.writeFileSync(path.join(root, ".env"), `DATABASE_URL=${o.url ?? URL_}\n`);
  return root;
}

/** One run in `cwd` against a fresh fake whose replica endpoints `v1` answers, signed in by MASON_TOKEN; its requests. */
export async function hosted(v1: (r: Req) => Reply | Promise<Reply>, argv: string[], o: { cwd?: string; token?: string; terminal?: number; me?: Reply; lines?: Lines; input?: string } = {}): Promise<{ a: Answer; requests: Req[]; token: string; url: string }> {
  const token = o.token ?? newToken("pat"); SECRETS.push(token);
  const fake = await fakeService({ v1, ...(o.me ? { me: o.me } : {}) });
  const h = home();
  try {
    const a = await mason(o.cwd ?? h, ["replica", ...argv], envFor(h, fake.url, { MASON_TOKEN: token }), { lines: o.lines ?? LINES, ...(o.terminal ? { terminal: o.terminal } : {}),
      ...(o.input !== undefined ? { input: o.input, prompt: "> " } : {}) });
    // the database's URL: never its password, in any form a run prints
    for (const text of [a.stdout, a.stderr]) assert.ok(!text.includes(PASSWORD) && !text.toLowerCase().includes(PASSWORD.toLowerCase()), `mason replica ${argv.join(" ")} printed the database's password:\n${a.stdout}${a.stderr}`);
    assert.ok(!a.argv.some((x) => x.includes(PASSWORD) || x.includes("postgres://")), "the URL is never on the command line");
    return { a, requests: fake.requests.filter((r) => r.path.startsWith("/v1/")), token, url: fake.url };
  } finally { await fake.close(); }
}
