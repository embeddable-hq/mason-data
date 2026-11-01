/**
 * `mason share` (src/cli/share.ts, src/cli/share-run.ts, src/cli/tunnel.ts): the pure pieces first — the tunnel's output
 * read, ssh's config, the role decided — then the command END TO END: real processes against a real run of a demo
 * project, over a STUB tunnel binary found through PATH, never a real service. The stub is a shell script named ssh (or
 * bore): it records its arguments and the file -F names, prints an address, and does what its `mode` file says. The
 * address it prints by default is 127.0.0.1 and the port it was pointed at, so the probe, the TLS and the logins all run
 * for real. The listener's own rules (two sockets, the cap on logins) are tests/postgres-api/tls.test.ts's.
 *
 * The password must be absent from everything but the one report: each step that can leak it is read for it.
 */
import { after, afterEach, describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as tls from "node:tls";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { DuckDBInstance } from "@duckdb/node-api";
import { matrixEnv, runMason, type Answer } from "./cli-matrix.ts";
import { alive, masonProcess } from "../src/cli/runs.ts";
import { supervisorOf } from "../src/cli/supervise.ts";
import { unassignedPort } from "./test-ports.ts";
import { mintToken, tokenProblem } from "../src/duck/token.ts";
import { isUserPassword, listenerLogins, LiveUsers, userPassword } from "../src/duck/users.ts";
import { NO_ROLES, type RoleGrants, type RolesLive } from "../src/duck/grants.ts";
import { whereParts } from "../src/duck/row-filter.ts";
import type { ShareDoor, ShareSocket } from "../src/api/postgres/server.ts";
// read from the modules when the tests run: the file loads at a commit without them, and each test fails by name
// (scripts/fails-without.ts)
const absent = (): Record<string, unknown> => ({});
const { lastLines, pinggyConfig, probeShare, tunnelAddress, tunnelEnds, tunnelPlan } = await import("../src/cli/tunnel.ts" as string).catch(absent) as typeof import("../src/cli/tunnel.ts");
const { newSharePassword, RunShares, shareRole, shareSecret, tunnelReport } = await import("../src/cli/share-run.ts" as string).catch(absent) as typeof import("../src/cli/share-run.ts");
const { chosenRole, inOrder } = await import("../src/cli/share.ts" as string).catch(absent) as typeof import("../src/cli/share.ts");

/** a share's password: `mason_share_`, then the 192 random bits as hex */
const SHARE_PASSWORD_RE = /^mason_share_[0-9a-f]{48}$/;

const MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "main.ts");

// ------------------------------------------------------------------ the pieces

test("the tunnel's output: the address in Pinggy's and bore's shapes, through colours, never a port that is none", () => {
  assert.deepEqual(tunnelAddress("pinggy", "You are not authenticated.\r\n\x1b[32mtcp://rnxyz.a.free.pinggy.link:43211\x1b[0m\r\n"), { host: "rnxyz.a.free.pinggy.link", port: 43211 });
  assert.deepEqual(tunnelAddress("bore", "2026-10-30T10:00:00Z INFO bore_cli::client: \x1b[3mlistening at\x1b[0m bore.pub:12345".replace(/\x1b\[\d+m/g, "")), { host: "bore.pub", port: 12345 });
  assert.equal(tunnelAddress("pinggy", "http://localhost:4300\nhttps://x.pinggy.link"), null, "the web debugger and an HTTP address are no TCP address");
  assert.equal(tunnelAddress("pinggy", "tcp://a.example:99999"), null);
  assert.equal(tunnelAddress("bore", "tcp://a.example:1234"), null, "each tunnel's own shape");
});

test("when a free tunnel ends: what its client says, else its limit; a token's has no end", () => {
  const now = Date.parse("2026-10-30T10:00:00Z");
  assert.equal(tunnelEnds({ free: true }, "Your tunnel will expire in 45 minutes", now), "2026-10-30T10:45:00.000Z");
  assert.equal(tunnelEnds({ free: true }, "nothing said", now), "2026-10-30T11:00:00.000Z");
  assert.equal(tunnelEnds({ free: false }, "expires in 45 minutes", now), null);
});

test("what a failure repeats of a client's output is its last lines, the token masked", () => {
  assert.equal(lastLines("one\ntwo\r\n\x1b[31mthree\x1b[0m\nsecret-token+tcp@pro.pinggy.io: Permission denied\n", "secret-token"), "two / three / <token>+tcp@pro.pinggy.io: Permission denied");
});

test("ssh is held to never asking: its config takes every choice, the token is in the config alone, nothing of the developer's is read", () => {
  const free = pinggyConfig({ token: null, knownHosts: "/p/.mason/share-known-hosts" });
  assert.match(free, /^ {2}User tcp$/m);
  assert.match(free, /^ {2}HostName free\.pinggy\.io$/m);
  assert.match(free, /^ {2}StrictHostKeyChecking accept-new$/m);
  assert.match(free, /^ {2}UserKnownHostsFile "\/p\/\.mason\/share-known-hosts"$/m);
  assert.match(free, /^ {2}PubkeyAuthentication no$/m);
  assert.match(free, /^ {2}ExitOnForwardFailure yes$/m);
  const plan = tunnelPlan("pinggy", { port: 54321, home: "/p/.mason", token: "tok-123" });
  assert.deepEqual(plan.args, ["-F", `/p/.mason/share-tunnel-${process.pid}.ssh`, "-T", "-R0:127.0.0.1:54321", "mason-share"]);
  assert.ok(!plan.args.join(" ").includes("tok-123"), "a command line is every user's to read");
  assert.match(plan.file?.text ?? "", /^ {2}User tok-123\+tcp$/m);
  assert.match(plan.file?.text ?? "", /^ {2}HostName pro\.pinggy\.io$/m);
  assert.equal(plan.env.SSH_ASKPASS, "true", "a question is answered with nothing, never put to a person");
  assert.equal(plan.env.SSH_ASKPASS_REQUIRE, "force");
  assert.equal(plan.reconnects, true);
  assert.equal(tunnelPlan("pinggy", { port: 1, home: "/p", token: null }).reconnects, false, "a free tunnel's share ends with it");
  assert.equal(tunnelPlan("bore", { port: 1, home: "/p", token: null }).reconnects, false);
});

const grant = (name: string, tables: string[] | "all"): RoleGrants => ({ name, file: "mason/roles.yml", all: tables === "all", tables: new Map(tables === "all" ? [] : tables.map((t) => [t, { table: t, all: true, columns: [] }])) });
const live = (grants: RoleGrants[], o: Partial<RolesLive> = {}): RolesLive => ({ file: "mason/roles.yml", grants: new Map(grants.map((g) => [g.name, g])), problem: null, default: null, ...o });

test("what a share reads: the one answer used and said, several refused naming each with the line to run, a bad file refused whatever is asked", () => {
  assert.deepEqual(shareRole(undefined, NO_ROLES), { role: null, reads: "every synced table" });
  assert.deepEqual(shareRole(undefined, live([grant("everything", "all")], { default: "everything" })), { role: "everything", reads: "every synced table" });
  assert.deepEqual(shareRole("sales", live([grant("sales", ["public.orders"]), grant("everything", "all")])), { role: "sales", reads: "1 synced table: public.orders" });
  const several = shareRole(undefined, live([grant("sales", ["public.orders", "public.customers"]), grant("everything", "all")], { default: "everything" }));
  assert.ok("failure" in several);
  assert.equal(several.failure.code, "usage");
  assert.equal(several.failure.message, "mason/roles.yml names 2 roles: mason share needs to know which one this address reads as");
  assert.deepEqual(several.failure.next, [["mason share --role everything", "reads every synced table"], ["mason share --role sales", "reads 2 synced tables: public.orders, public.customers"]]);
  assert.match(several.failure.fix ?? "", /--role everything: reads every synced table \(the file's default\)/);
  assert.deepEqual(several.choices?.map((c) => c.role), ["everything", "sales"], "the default first");
  const typo = shareRole("sale", live([grant("sales", ["public.orders"]), grant("other", "all")]));
  assert.ok("failure" in typo);
  assert.equal(typo.failure.code, "not_found");
  assert.match(typo.failure.message, /did you mean/);
  const none = shareRole("sales", NO_ROLES);
  assert.ok("failure" in none);
  assert.match(none.failure.fix ?? "", /write mason\/roles\.yml:\n {2}roles:\n {4}sales:/);
  const empty = shareRole(undefined, live([]));
  assert.ok("failure" in empty);
  assert.equal(empty.failure.code, "not_found");
  const bad = shareRole("sales", live([grant("sales", "all")], { problem: "line 3 is wrong" }));
  assert.ok("failure" in bad);
  assert.equal(bad.failure.code, "bad_roles");
  // the catalog could not check the filters: the file may be right, so it is not said to be wrong
  const unchecked = shareRole("sales", live([grant("sales", "all")], { problem: "the roles' row filters could not be checked by the catalog: gone", checkFailed: true }));
  assert.ok("failure" in unchecked);
  assert.deepEqual(unchecked.failure, { message: "nothing is shared: the roles' row filters could not be checked by the catalog: gone", code: "failed",
    why: "the file may be right: a share opens only on filters Postgres has read", fix: "mason logs says why, then mason share again", next: [["mason logs", "the run's log"]] });
  assert.deepEqual(shareRole("Not A Role", NO_ROLES).constructor, Object);
  assert.equal((shareRole("Not A Role", NO_ROLES) as { failure: { code: string } }).failure.code, "usage");
});

test("a role whose rows need an attribute is no share's: named, refused saying why, and left out of the choices", () => {
  const parts = whereParts("tenant_id = :tenant");
  assert.ok(Array.isArray(parts));
  const filter = { table: "public.orders", at: "roles.tenant.tables.orders", where: { text: "tenant_id = :tenant", parts } };
  const tenant: RoleGrants = { ...grant("tenant", ["public.orders"]), filters: new Map([["public.orders", filter]]) };
  const whereOnly = whereParts("status = 'paid'");
  assert.ok(Array.isArray(whereOnly));
  const paid: RoleGrants = { ...grant("paid", ["public.orders"]), filters: new Map([["public.orders", { table: "public.orders", at: "roles.paid.tables.orders", where: { text: "status = 'paid'", parts: whereOnly } }]]) };
  const sales = grant("sales", ["public.customers"]);

  const named = shareRole("tenant", live([tenant, sales]));
  assert.ok("failure" in named);
  assert.deepEqual(named.failure, {
    message: "a share cannot read as the role tenant: its rows depend on :tenant, and a share's login has no attributes", code: "refused",
    why: "roles.tenant.tables.orders.where reads :tenant (tenant_id = :tenant)",
    fix: "--role sales: reads 1 synced table: public.customers",
    next: [["mason share --role sales", "reads 1 synced table: public.customers"], ["mason user add <name> --role tenant --set tenant=<value>", "a login that carries the values, for a tool that can reach this machine"]],
  });
  // a filter that reads no attribute is a share's: only what a password cannot carry is refused
  assert.deepEqual(shareRole("paid", live([tenant, paid])), { role: "paid", reads: "1 synced table: public.orders" });
  // the role left is no file's one answer: a default says what a local user gets, and a public address never widens it
  const left = shareRole(undefined, live([tenant, sales]));
  assert.ok("failure" in left);
  assert.equal(left.failure.code, "usage");
  assert.equal(left.failure.message, "mason/roles.yml names 2 roles: mason share needs to know which one this address reads as");
  assert.deepEqual(left.choices?.map((c) => c.role), ["sales"]);
  const widened = shareRole(undefined, live([{ ...tenant, name: "tenant" }, grant("everything", "all")], { default: "tenant" }));
  assert.ok("failure" in widened, "default: tenant and an all-tables role: never every table without asking");
  assert.equal(widened.failure.message, "mason/roles.yml names 2 roles: mason share needs to know which one this address reads as");
  assert.equal(widened.failure.fix, "--role everything: reads every synced table\nleft out, because a share's login has no attributes: tenant");
  assert.deepEqual(widened.choices?.map((c) => c.role), ["everything"]);
  // a file of one role that can be shared stays the one answer
  assert.deepEqual(shareRole(undefined, live([paid])), { role: "paid", reads: "1 synced table: public.orders" });
  // a typo of a role left out still finds it, and says what it is
  const typo = shareRole("tenat", live([tenant, sales]));
  assert.ok("failure" in typo);
  assert.equal(typo.failure.code, "not_found");
  assert.match(typo.failure.message, /^there is no role tenat in mason\/roles\.yml.*did you mean.*tenant/);
  assert.equal(typo.failure.why, "the roles: sales, tenant (its rows depend on an attribute, so a share cannot read as it)");
  const several = shareRole(undefined, live([tenant, sales, paid]));
  assert.ok("failure" in several);
  assert.deepEqual(several.choices?.map((c) => c.role), ["sales", "paid"]);
  assert.match(several.failure.fix ?? "", /^left out, because a share's login has no attributes: tenant$/m);
  const none = shareRole(undefined, live([tenant]));
  assert.ok("failure" in none);
  assert.equal(none.failure.code, "refused");
  assert.equal(none.failure.message, "no role of mason/roles.yml can be shared: the rows of each depend on an attribute, and a share's login has no attributes");
  assert.equal(none.failure.fix, "add a role to mason/roles.yml whose rows need no attribute, then mason share --role <role>");
});

test("a person's answer: a number or a name; anything else is no choice", () => {
  const choices = [{ role: "everything", reads: "", default: true }, { role: "sales", reads: "", default: false }];
  assert.equal(chosenRole("2", choices), "sales");
  assert.equal(chosenRole(" sales \n", choices), "sales");
  assert.equal(chosenRole("3", choices), null);
  assert.equal(chosenRole("", choices), null);
  assert.equal(chosenRole("0", choices), null);
});

/** A RunShares over a socket that records what it is told. */
function fakeShares(): { shares: InstanceType<typeof RunShares>; door: () => ShareDoor; closed: () => number; lines: string[]; ended: string[]; stopped: Array<[number, number]> } {
  let door: ShareDoor | null = null, closed = 0;
  const lines: string[] = [], ended: string[] = [], stopped: Array<[number, number]> = [];
  const socket: ShareSocket = { port: 40001, sessions: 0, endSessions: (jti) => { ended.push(jti); return 1; }, close: async () => { closed++; } };
  const shares = new RunShares({
    listener: { openShare: async (d) => { door = d; return socket; }, checkRoles: async () => NO_ROLES }, database: "shop", log: (l) => lines.push(l), stopTunnel: (pid, port) => stopped.push([pid, port]),
    certificate: () => ({ cert: Buffer.from("c"), key: Buffer.from("k"), fingerprint: "AA:BB" }),
  });
  return { shares, door: () => door!, closed: () => closed, lines, ended, stopped };
}

test("a share's password is recognisably Mason's: its own shape, no user's and no token's, refused on the run's own listener, and whole in a URL", () => {
  const KEY = "the-project-api-key";
  const password = newSharePassword();
  assert.match(password, SHARE_PASSWORD_RE);
  assert.notEqual(newSharePassword(), password, "made new each time");
  assert.ok(!isUserPassword(password), "no user's by its shape");
  assert.ok(isUserPassword(userPassword(KEY, "local", "0123456789abcdef")), "the check tells them apart: a user's still is one");
  assert.match(tokenProblem(KEY, password) ?? "", /not a Mason user.s password or token/);
  // what the run's own listener does with it, wired as src/cli/dev.ts wires it: no users file is needed to refuse it
  const logins = listenerLogins(new LiveUsers(path.join(os.tmpdir(), "mason-share-no-such-project", "users.json"), KEY), KEY);
  const notHere = /a mason share password logs in only at the address mason share printed, never on this port/;
  assert.throws(() => logins.authenticate(password, "share_abc123"), notHere, "told where it works, never to make a user");
  assert.throws(() => logins.authenticate("mason_share_cut-short", "share_abc123"), notHere, "a part of one is said the same");
  // every character is one a URL leaves alone: `mason share` prints no URL, and a person who writes one needs no escaping
  assert.equal(encodeURIComponent(password), password);
  assert.equal(new URL(`postgres://share_abc123:${password}@127.0.0.1:5433/mason`).password, password);
});

test("the run holds a share's password as its hash, for its user alone: another's name, a token and a user's password refused, the login gone with the share", async () => {
  const f = fakeShares();
  const password = newSharePassword();
  assert.match(password, SHARE_PASSWORD_RE);
  const opened = await f.shares.open({ secret: shareSecret(password) });
  assert.ok("user" in opened);
  assert.match(opened.user, /^share_[0-9a-f]{6}$/);
  assert.ok(!JSON.stringify(f.shares.state()).includes(shareSecret(password)), "not even its hash leaves the run");
  assert.deepEqual(await f.door().authenticate(password, opened.user), { filters: [], subject: undefined, user: opened.user, jti: opened.user });
  for (const [p, u] of [[password, "someone"], ["wrong", opened.user], [userPassword("a-key", opened.user, "0123456789abcdef"), opened.user]] as const) {
    assert.throws(() => f.door().authenticate(p, u), (e: { status: number; code: string; userName: string }) => e.status === 401 && e.code === "invalid_share" && e.userName === u);
  }
  // the check is the same for all of them; a refusal names what it was given, by its shape, and where that works
  assert.throws(() => f.door().authenticate(userPassword("a-key", opened.user, "0123456789abcdef"), opened.user), /that is a mason user's password: it logs in on the run's own port, never at a share's address/);
  assert.throws(() => f.door().authenticate(mintToken("a-key", 600).token, opened.user), /that is an API token: it logs in on the run's own port/);
  assert.throws(() => f.door().authenticate("wrong", opened.user), /not this share's password/);
  assert.throws(() => f.door().authenticate(password, "someone"), /not this share's password/);
  await f.door().recheck({ jti: opened.user });
  await f.shares.close(opened.user, "the test");
  assert.throws(() => f.door().authenticate(password, opened.user), /not this share's password/);
  await assert.rejects(Promise.resolve(f.door().recheck({ jti: opened.user })), /the share ended/);
  assert.ok(!f.lines.join("\n").includes(password));
});

test("a second share meets the same socket with a login of its own; one closing ends its own sessions and tunnel client, the last closes the socket", async () => {
  const f = fakeShares();
  const a = await f.shares.open({ secret: shareSecret("a") });
  const b = await f.shares.open({ secret: shareSecret("b") });
  assert.ok("user" in a && "user" in b);
  assert.equal(a.port, b.port);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.notEqual(a.user, b.user);
  assert.equal(f.shares.update(a.user, { pid: 77, via: "pinggy", host: "x.example", port: 5, state: "up" }), true);
  assert.equal(f.shares.update("share_nobody", { state: "up" }), false);
  assert.equal(f.shares.state()?.shares.find((s) => s.user === a.user)?.host, "x.example");
  await f.shares.close(a.user, "its command went away");
  assert.deepEqual(f.ended, [a.user]);
  assert.deepEqual(f.stopped, [[77, 40001]], "its tunnel client stopped, by its pid and the port it must name");
  assert.equal(f.closed(), 0, "the other share still holds the socket");
  assert.equal((await f.door().authenticate("b", b.user)).user, b.user);
  await f.shares.close(b.user, "its command went away");
  assert.equal(f.closed(), 1);
  assert.equal(f.shares.state(), null);
});

test("refused logins are logged once a minute with how many, and name no source; the counts are kept for mason status", async () => {
  const f = fakeShares();
  await f.shares.open({ secret: shareSecret("a") });
  for (let i = 0; i < 5; i++) f.door().refused?.(`scanner${i}`);
  f.door().dropped?.("did not log in in time");
  const said = f.lines.filter((l) => l.includes("login refused"));
  assert.equal(said.length, 1, f.lines.join("\n"));
  assert.match(said[0]!, /a login refused for the user "scanner0"; who cannot be known: every connection through a tunnel comes from 127\.0\.0\.1$/);
  assert.equal(f.shares.state()?.refusedLogins, 5);
  assert.equal(f.shares.state()?.droppedConnections, 1);
});

test("refused logins are rows of the request log up to ten a minute; every one is counted", async () => {
  const f = fakeShares();
  await f.shares.open({ secret: shareSecret("a") });
  const rows = Array.from({ length: 25 }, (_, i) => f.door().refused?.(`scanner${i}`));
  assert.deepEqual(rows, Array.from({ length: 25 }, (_, i) => i < 10));
  assert.equal(f.shares.state()?.refusedLogins, 25);
});

test("what the command reports of its tunnel is kept field by field, its types held: a pid is a process the run may stop", () => {
  const good = { via: "pinggy", host: "a.example", port: 4242, endsAt: "2026-10-30T19:37:41.557Z", state: "up", pid: 123 };
  assert.deepEqual(tunnelReport(good), good);
  assert.deepEqual(tunnelReport({ endsAt: null }), { endsAt: null });
  assert.deepEqual(tunnelReport({ pid: 5, extra: "kept nowhere" }), { pid: 5 });
  for (const bad of [null, [], "x", { pid: "1" }, { pid: -1 }, { pid: 1.5 }, { pid: 2 ** 40 }, { port: 0 }, { port: 70_000 }, { state: "gone" }, { endsAt: "soon" }, { host: 5 }, { host: "x".repeat(300) }, { via: "" }]) {
    assert.equal(tunnelReport(bad), null, JSON.stringify(bad));
  }
});

test("what the command tells the run arrives in the order it was said: a slow \"opening\" is never overtaken by its \"up\"", async () => {
  const seen: string[] = [];
  const tell = inOrder(async (t: string) => {
    if (t === "opening") await new Promise((r) => setTimeout(r, 30));
    seen.push(t);
  });
  void tell("opening");
  await tell("up");
  assert.deepEqual(seen, ["opening", "up"]);
});

test("the certificate that cannot be made is the command's failure, and leaves no share", async () => {
  const shares = new RunShares({ listener: { openShare: () => Promise.reject(new Error("never")), checkRoles: async () => NO_ROLES }, database: "shop", log: () => undefined,
    certificate: () => ({ message: "the self-signed certificate could not be written", code: "failed" }) });
  const r = await shares.open({ secret: shareSecret("a") });
  assert.ok("failure" in r);
  assert.equal(r.failure.message, "the self-signed certificate could not be written");
  assert.equal(shares.state(), null);
});

test("the probe: nothing listening is no verdict, a server that takes no TLS is another thing", async () => {
  const closed = await new Promise<number>((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const a = s.address() as net.AddressInfo; s.close(() => resolve(a.port)); }); });
  assert.equal(await probeShare({ host: "127.0.0.1", port: closed }, "AA", 2_000), "unknown");
  const plain = net.createServer((c) => { c.once("data", () => c.write("N")); });
  await new Promise<void>((r) => plain.listen(0, "127.0.0.1", r));
  assert.equal(await probeShare({ host: "127.0.0.1", port: (plain.address() as net.AddressInfo).port }, "AA", 2_000), "other");
  plain.close();
  const silent = net.createServer();
  await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
  assert.equal(await probeShare({ host: "127.0.0.1", port: (silent.address() as net.AddressInfo).port }, "AA", 200), "unknown");
  silent.close();
});

// ------------------------------------------------------------------ the command, end to end

async function postgresExtension(): Promise<string | null> {
  const instance = await DuckDBInstance.create(":memory:");
  const c = await instance.connect();
  try { await c.run("INSTALL postgres; LOAD postgres;"); return null; }
  catch (e) { return (e as Error).message; }
  finally { c.closeSync(); instance.closeSync(); }
}
const noExtension = await postgresExtension();
const skip = noExtension === null ? false : `DuckDB's postgres extension did not load (${noExtension}); the first copy on a machine with network installs it, and this runs`;

const said = (a: Answer): string => `exit ${a.code}\n--- stdout\n${a.stdout}\n--- stderr\n${a.stderr}`;
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mason-share-")));
const home = path.join(root, ".mason");
const stubs = path.join(root, "stub-bin");
const stubState = path.join(root, "stub-state");
const pgPort = await unassignedPort();
const env = matrixEnv({ MASON_PG_PORT: String(pgPort), PATH: `${stubs}:/usr/bin:/bin`, STUB_STATE: stubState });
const mason = (argv: string[], timeoutMs = 120_000, extra: Record<string, string> = {}): Promise<Answer> => runMason(root, argv, { ...env, ...extra }, timeoutMs);
/** The certificate a connection is handed, before any login. */
const peerCertificate = (port: number): Promise<tls.DetailedPeerCertificate> => new Promise((resolve, reject) => {
  const socket = net.connect(port, "127.0.0.1", () => socket.write(Buffer.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f])));
  socket.once("error", reject);
  socket.once("data", () => {
    const secure = tls.connect({ socket, rejectUnauthorized: false }, () => { const c = secure.getPeerCertificate(true); secure.destroy(); resolve(c); });
    secure.once("error", reject);
  });
});

const config = (): { apiKey: string; running?: { pid: number; postgresUrl: string; controlUrl: string; token: string } | null } => JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));

/** the stub tunnel: records, prints its address, then does what `mode` says */
const STUB = `#!/bin/sh
mkdir -p "$STUB_STATE"
echo $$ >> "$STUB_STATE/pids"
printf '%s\\n' "$@" > "$STUB_STATE/args"
env > "$STUB_STATE/env"
while [ $# -gt 0 ]; do
  case "$1" in
    -F) cp "$2" "$STUB_STATE/config"; stat -f %Lp "$2" > "$STUB_STATE/config-mode" 2>/dev/null || stat -c %a "$2" > "$STUB_STATE/config-mode"; shift ;;
    -R0:127.0.0.1:*) port=\${1##*:} ;;
    local) shift; port=$1 ;;
  esac
  shift
done
mode=$(cat "$STUB_STATE/mode" 2>/dev/null || echo ok)
case "$mode" in
  silent) ;;
  noisy) echo "the new format of a tunnel service" ;;
  fail) echo "$MASON_STUB_LINE" >&2; exit 255 ;;
  other) echo "tcp://127.0.0.1:$(cat "$STUB_STATE/other-port")" ;;
  bore) echo "listening at 127.0.0.1:$port" ;;
  *) echo "You are not authenticated. Your tunnel will expire in 60 minutes."; echo "tcp://127.0.0.1:$port" ;;
esac
while :; do
  [ -f "$STUB_STATE/drop" ] && { rm -f "$STUB_STATE/drop"; echo "connection reset by the relay" >&2; exit 1; }
  sleep 0.1
done
`;

interface Share { child: ChildProcess; stdout: () => string; stderr: () => string; exited: Promise<number | null> }

const started: Share[] = [];
function startShare(argv: string[] = [], extra: Record<string, string> = {}): Share {
  const child = spawn(process.execPath, [MAIN, "share", ...argv], { cwd: root, env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout!.on("data", (b: Buffer) => { stdout += b.toString(); });
  child.stderr!.on("data", (b: Buffer) => { stderr += b.toString(); });
  const share: Share = { child, stdout: () => stdout, stderr: () => stderr, exited: new Promise((r) => child.once("close", (code) => r(code))) };
  started.push(share);
  return share;
}

async function until<T>(read: () => T | null | undefined | false | Promise<T | null | undefined | false>, what: string, ms = 30_000): Promise<T> {
  for (const end = Date.now() + ms; ;) {
    const v = await read();
    if (v) return v;
    if (Date.now() > end) throw new Error(`waited ${ms} ms for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const rowOf = (text: string, label: string): string => new RegExp(`^ {2}${label} +(.+)$`, "m").exec(text)?.[1] ?? "";
const reported = (s: Share): Promise<{ host: string; port: number; user: string; password: string; database: string }> => until(() => {
  const o = s.stdout();
  if (!o.includes("Next:")) return null;
  return { host: rowOf(o, "host"), port: Number(rowOf(o, "port")), user: rowOf(o, "user"), password: rowOf(o, "password"), database: rowOf(o, "database") };
}, `the report (stderr: ${s.stderr()})`);

const client = (port: number, o: { user: string; password: string; database: string }, ssl: pg.ClientConfig["ssl"] = { rejectUnauthorized: false }): pg.Client =>
  new pg.Client({ ...o, host: "127.0.0.1", port, ssl, connectionTimeoutMillis: 10_000 });
const status = async (): Promise<{ share: { port: number; refusedLogins: number; shares: Array<{ user: string; host: string | null; role: string | null; state: string }> } | null }> => {
  const a = await mason(["status", "--json"]);
  assert.equal(a.code, 0, said(a));
  return JSON.parse(a.stdout) as Awaited<ReturnType<typeof status>>;
};
const portClosed = (port: number): Promise<boolean> => new Promise((resolve) => {
  const c = net.connect(port, "127.0.0.1");
  c.once("connect", () => { c.destroy(); resolve(false); });
  c.once("error", () => resolve(true));
});
const stubAlive = (): number[] => (fs.existsSync(path.join(stubState, "pids")) ? fs.readFileSync(path.join(stubState, "pids"), "utf8").trim().split("\n").map(Number) : []).filter(alive);
const mode = (m: string): void => { fs.writeFileSync(path.join(stubState, "mode"), m); };
/** a share ended, the listener with it, whichever way: nothing of it left */
async function gone(port: number): Promise<void> {
  await until(async () => (await status()).share === null, "the share gone from mason status");
  await until(() => portClosed(port), "the share's socket closed");
}
/** every file in .mason/ that is text, read for `secret` (the copy's own file is read too: a password is no row of it) */
function inHome(secret: string): string[] {
  return fs.readdirSync(home, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && !/\.(wal|tmp)$/.test(e.name))
    .map((e) => path.join(e.parentPath, e.name)).filter((f) => fs.readFileSync(f).includes(secret));
}

after(async () => {
  if (fs.existsSync(path.join(home, "config.json"))) {
    const stop = await mason(["stop"]);
    if (stop.code !== 0) process.stderr.write(`cli-share: mason stop at the end failed:\n${said(stop)}\n`);
    const sup = supervisorOf(home);
    if (sup !== null) process.kill(sup, "SIGKILL");
    const pid = config().running?.pid;
    if (pid !== undefined && alive(pid) && masonProcess(pid)) process.kill(pid, "SIGKILL");
  }
  fs.rmSync(root, { recursive: true, force: true });
});

if (skip !== false) test("mason share end to end", { skip }, () => undefined);
describe("mason share, against a real run and a stub tunnel", { timeout: 300_000, skip }, () => {
  // a step that failed leaves no share for the next
  afterEach(async () => {
    for (const s of started.splice(0)) { if (s.child.exitCode === null && s.child.signalCode === null) s.child.kill("SIGKILL"); await s.exited; }
    await until(() => stubAlive().length === 0, "the tunnel clients ended");
    mode("ok");
  });

  test("set up: a demo project, up, its tables synced", async () => {
    fs.mkdirSync(stubs, { recursive: true });
    fs.mkdirSync(stubState, { recursive: true });
    fs.writeFileSync(path.join(stubs, "ssh"), STUB, { mode: 0o755 });
    const init = await mason(["init", "demo"]);
    assert.equal(init.code, 0, said(init));
    const own = await unassignedPort();
    fs.writeFileSync(path.join(root, ".env"), fs.readFileSync(path.join(root, ".env"), "utf8").replace(/127\.0\.0\.1:\d+/, `127.0.0.1:${own}`));
    const start = await mason(["start"]);
    assert.equal(start.code, 0, said(start));
    const wait = await mason(["wait", "--timeout", "60"]);
    assert.equal(wait.code, 0, said(wait));
  });

  test("the report: the stub's address, pointed at the share's socket; plain refused there, the password there alone; status shows it; its end ends everything", async () => {
    const s = startShare();
    const r = await reported(s);
    const out = s.stdout();
    assert.match(r.password, SHARE_PASSWORD_RE, "the report's password row, as it was made");
    assert.match(out, /^Sharing the synced data with a tool outside this machine$/m);
    assert.doesNotMatch(out.split("\n")[0]!, /pinggy/i, "the tunnel's vendor is in no headline");
    assert.equal(r.host, "127.0.0.1");
    assert.notEqual(r.port, pgPort);
    assert.equal(rowOf(out, "sslmode"), "require");
    assert.match(rowOf(out, "certificate"), /^SHA-256 ([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    assert.equal(rowOf(out, "via"), "pinggy");
    assert.match(rowOf(out, "ends"), /^in about 60 minutes, at /);
    assert.match(rowOf(out, "reads"), /^the role everything: every synced table/, "the file's one role, said");
    assert.doesNotMatch(out, /mason user add/, "the share's password is the login; no user is asked for");
    assert.match(out, /^Next:\n {2}mason status/m);
    const args = fs.readFileSync(path.join(stubState, "args"), "utf8");
    assert.ok(args.includes(`-R0:127.0.0.1:${r.port}\n`), `pointed at the share's socket: ${args}`);
    assert.ok(!args.includes(`:${pgPort}`), "never the plain one");

    // what any connection is handed before a login: the certificate, which names no project
    const peer = await peerCertificate(r.port);
    assert.equal(peer.subject.CN, "mason");
    assert.ok(!peer.raw.includes(path.basename(root)), "the project's name is in no field of it");
    const bad = await fetch(`${config().running!.controlUrl}/api/share/${r.user}`, { method: "POST", headers: { authorization: `Bearer ${config().running!.token}` }, body: JSON.stringify({ pid: "1" }) });
    assert.equal(bad.status, 400, "a report that is not one is refused");

    // a real client: TLS required there, a session on the synced data
    const secure = client(r.port, r);
    await secure.connect();
    assert.equal((await secure.query("SHOW ssl")).rows[0].ssl, "on");
    assert.ok(Number((await secure.query("SELECT count(*) AS n FROM orders")).rows[0].n) > 0);
    await assert.rejects(client(r.port, r, false).connect(), (e: pg.DatabaseError) => e.code === "28000" && /requires TLS/.test(e.message));
    // the run's own port still takes a plain connection, and not this password
    await assert.rejects(client(pgPort, r, false).connect(), (e: pg.DatabaseError) => e.code === "28P01" && /a mason share password logs in only at the address mason share printed, never on this port/.test(e.message));
    const user = await mason(["user", "add", "local"]);
    assert.equal(user.code, 0, said(user));
    const localPassword = /^ {2}password +(.+)$/m.exec(user.stdout)![1]!;
    const local = client(pgPort, { user: "local", password: localPassword, database: r.database }, false);
    await local.connect();
    assert.equal((await local.query("SHOW ssl")).rows[0].ssl, "off");
    // a user's password and an API token are refused on the share's socket
    await assert.rejects(client(r.port, { user: "local", password: localPassword, database: r.database }).connect(), (e: pg.DatabaseError) => e.code === "28P01" && /that is a mason user's password/.test(e.message));
    await assert.rejects(client(r.port, { user: "anyone", password: mintToken(config().apiKey, 600).token, database: r.database }).connect(), (e: pg.DatabaseError) => e.code === "28P01" && /that is an API token/.test(e.message));

    const st = await status();
    assert.equal(st.share?.port, r.port);
    assert.equal(st.share?.refusedLogins, 2);
    assert.deepEqual(st.share?.shares.map((x) => [x.user, x.host, x.state]), [[r.user, "127.0.0.1", "up"]]);
    const person = await mason(["status"]);
    assert.match(person.stdout, new RegExp(`Share +127\\.0\\.0\\.1:${r.port} via pinggy, as ${r.user}, reads as the role everything, ends in about \\d+ min`));
    assert.match(person.stdout, /Share socket +127\.0\.0\.1:\d+, TLS required, SHA-256 [0-9A-F:]+ · 1 session, 2 logins refused, 0 dropped before a login/);

    // THE PASSWORD IS NOWHERE BUT THE REPORT: the log, status, the request log, the run's files
    assert.ok(!person.stdout.includes(r.password));
    assert.ok(!JSON.stringify(st).includes(r.password));
    await until(async () => (await mason(["logs", "--requests", "--json"])).stdout.includes(r.user), "the share's statements in the request log");
    for (const argv of [["logs"], ["logs", "--requests", "--json"], ["logs", "--events", "--json"], ["status", "--json"]]) {
      const a = await mason(argv);
      assert.ok(!(a.stdout + a.stderr).includes(r.password), `mason ${argv.join(" ")} carries the password`);
    }
    assert.deepEqual(inHome(r.password), [], "no file of the run's holds it");
    assert.deepEqual(inHome(shareSecret(r.password)), [], "nor its hash");
    assert.ok(!fs.readFileSync(path.join(home, "users.json"), "utf8").includes("share_"), "it is no row of users.json");
    assert.match(fs.readFileSync(path.join(home, "mason.log"), "utf8"), /share: a login refused for the user "local"; who cannot be known/);

    // the tunnel ends: the command says so, exit 1, the socket and the password gone, the plain session on
    const closed = new Promise<void>((resolve) => { secure.once("error", () => resolve()); secure.once("end", () => resolve()); });
    fs.writeFileSync(path.join(stubState, "drop"), "");
    assert.equal(await s.exited, 1);
    await closed;
    assert.match(s.stderr(), /^✗ mason share: the share ended: its tunnel closed \(ssh exited 1: .*connection reset by the relay\)$/m);
    assert.match(s.stderr(), /^Next:\n {2}mason share +a new address and a new password$/m);
    await gone(r.port);
    assert.equal((await local.query("SELECT 1 AS a")).rows[0].a, 1, "no plain session was dropped");
    await local.end();
    assert.equal(fs.existsSync(path.join(home, `share-tunnel-${s.child.pid}.ssh`)), false, "its config is not left");
  });

  test("kill -9 of the command: the run closes the share through its connection going away, and stops the tunnel client", async () => {
    const s = startShare();
    const r = await reported(s);
    const pids = stubAlive();
    assert.equal(pids.length, 1);
    s.child.kill("SIGKILL");
    await s.exited;
    await gone(r.port);
    await until(() => stubAlive().length === 0, "the tunnel client stopped by the run");
  });

  test("Ctrl-C: exit 0, said, nothing left", async () => {
    const s = startShare();
    const r = await reported(s);
    s.child.kill("SIGINT");
    assert.equal(await s.exited, 0, s.stderr());
    assert.match(s.stdout(), /The share ended: its address no longer answers, and its password no longer works/);
    await gone(r.port);
    assert.deepEqual(stubAlive(), []);
  });

  test("--json is one object with the declared keys, printed once the address is known; the end is on stderr", async () => {
    const s = startShare(["--json"]);
    const v = await until(() => { try { return JSON.parse(s.stdout()) as Record<string, unknown>; } catch { return null; } }, "one JSON object");
    assert.deepEqual(Object.keys(v), ["share", "next"]);
    const share = v.share as Record<string, unknown>;
    assert.deepEqual(Object.keys(share), ["host", "port", "database", "user", "password", "sslmode", "fingerprint", "role", "reads", "via", "endsAt", "verified"]);
    assert.match(share.password as string, SHARE_PASSWORD_RE);
    assert.equal(share.sslmode, "require");
    assert.equal(share.verified, true, "the address answered with the share's own certificate");
    assert.equal(share.role, "everything");
    fs.writeFileSync(path.join(stubState, "drop"), "");
    assert.equal(await s.exited, 1);
    assert.doesNotThrow(() => JSON.parse(s.stdout()), "stdout stays one document");
    assert.match(s.stderr(), /the share ended/);
    await gone(share.port as number);
  });

  test("a second mason share: the same socket, its own password; the first ending leaves the second", async () => {
    const a = startShare(), b = startShare();
    const [ra, rb] = await Promise.all([reported(a), reported(b)]);
    assert.equal(ra.port, rb.port);
    assert.notEqual(ra.password, rb.password);
    assert.equal(rowOf(a.stdout(), "certificate"), rowOf(b.stdout(), "certificate"));
    a.child.kill("SIGINT");
    await a.exited;
    await assert.rejects(client(ra.port, ra).connect(), (e: pg.DatabaseError) => e.code === "28P01");
    const c = client(rb.port, rb);
    await c.connect();
    await c.end();
    b.child.kill("SIGINT");
    await b.exited;
    await gone(rb.port);
  });

  test("the tunnel's output not understood: a clear failure in the time given, nothing left open", async () => {
    mode("noisy");
    try {
      const began = Date.now();
      const s = startShare(["--timeout", "1"]);
      assert.equal(await s.exited, 1);
      assert.ok(Date.now() - began < 20_000, `the time given is 1 s, and it took ${Date.now() - began} ms`);
      assert.match(s.stderr(), /^✗ mason share: the tunnel gave no address in 1 s$/m);
      assert.match(s.stderr(), /why +ssh printed: the new format of a tunnel service/);
      assert.match(s.stderr(), /--via bore is another tunnel/);
      assert.equal((await status()).share, null);
      assert.deepEqual(stubAlive(), []);
    } finally { mode("ok"); }
  });

  test("an address that is not this share is refused, never reported", async () => {
    mode("other");
    fs.writeFileSync(path.join(stubState, "other-port"), String(pgPort));
    try {
      const s = startShare();
      assert.equal(await s.exited, 1, s.stdout());
      assert.match(s.stderr(), new RegExp(`mason share: 127\\.0\\.0\\.1:${pgPort} is not this share: something else answers there`));
      assert.doesNotMatch(s.stdout(), /password/);
      assert.equal((await status()).share, null);
    } finally { mode("ok"); }
  });

  test("a client that fails at once is said with its own last line, its token masked; a missing binary is named", async () => {
    mode("fail");
    try {
      const s = startShare([], { MASON_PINGGY_TOKEN: "tok-secret-123", MASON_STUB_LINE: "tok-secret-123+tcp@pro.pinggy.io: Permission denied" });
      assert.equal(await s.exited, 1);
      assert.match(s.stderr(), /the tunnel ended before it gave an address/);
      assert.match(s.stderr(), /<token>\+tcp@pro\.pinggy\.io: Permission denied/);
      assert.ok(!s.stderr().includes("tok-secret-123"));
    } finally { mode("ok"); }
    const bore = await mason(["share", "--via", "bore"]);
    assert.equal(bore.code, 1, said(bore));
    assert.match(bore.stderr, /mason share: bore is not on this machine's PATH, and --via bore needs it/);
    assert.match(bore.stderr, /cargo install bore-cli/);
    const j = await mason(["share", "--via", "bore", "--json"]);
    assert.equal((JSON.parse(j.stdout) as { error: { code: string } }).error.code, "not_found");
    const via = await mason(["share", "--via", "ngrok"]);
    assert.equal(via.code, 2, said(via));
    assert.match(via.stderr, /--via must be pinggy or bore, not "ngrok"/);
    assert.equal((await status()).share, null);
  });

  test("--via bore: bore's own arguments and output", async () => {
    fs.writeFileSync(path.join(stubs, "bore"), STUB, { mode: 0o755 });
    mode("bore");
    try {
      const s = startShare(["--via", "bore"]);
      const r = await reported(s);
      assert.equal(rowOf(s.stdout(), "via"), "bore");
      assert.match(rowOf(s.stdout(), "ends"), /^when this command ends/);
      assert.deepEqual(fs.readFileSync(path.join(stubState, "args"), "utf8").trim().split("\n"), ["local", String(r.port), "--local-host", "127.0.0.1", "--to", "bore.pub"]);
      s.child.kill("SIGINT");
      await s.exited;
      await gone(r.port);
    } finally { mode("ok"); fs.rmSync(path.join(stubs, "bore")); }
  });

  test("a token: never on a command line, its file 0600 and gone once the tunnel is up; a dropped tunnel opened again with the same password, said", async () => {
    const s = startShare([], { MASON_PINGGY_TOKEN: "tok-123" });
    const r = await reported(s);
    assert.ok(!fs.readFileSync(path.join(stubState, "args"), "utf8").includes("tok-123"), "the token in the arguments");
    assert.match(fs.readFileSync(path.join(stubState, "config"), "utf8"), /^ {2}User tok-123\+tcp$/m);
    assert.equal(fs.readFileSync(path.join(stubState, "config-mode"), "utf8").trim(), "600");
    assert.deepEqual(fs.readdirSync(home).filter((f) => f.startsWith("share-tunnel-")), [], "removed once ssh has read it");
    assert.match(rowOf(s.stdout(), "ends"), /^when this command ends/);
    fs.writeFileSync(path.join(stubState, "drop"), "");
    await until(() => s.stderr().includes("Reconnected:"), `the reconnect (stderr: ${s.stderr()})`);
    assert.match(s.stderr(), /The tunnel dropped \(ssh exited 1: .*\): opening it again; the password stays the same\./);
    const c = client(r.port, r);
    await c.connect();
    await c.end();
    assert.equal((await status()).share?.shares[0]?.state, "up");
    s.child.kill("SIGINT");
    assert.equal(await s.exited, 0);
    await gone(r.port);
  });

  test("a stale token file a kill -9 left is removed by the next share", async () => {
    const stale = path.join(home, "share-tunnel-4194304.ssh");
    fs.writeFileSync(stale, "User tok+tcp", { mode: 0o600 });
    const s = startShare();
    const r = await reported(s);
    assert.equal(fs.existsSync(stale), false);
    s.child.kill("SIGINT");
    await s.exited;
    await gone(r.port);
  });

  test("the role: two in the file refused for an agent with each line to run; --role held by the listener; no roles file said plainly", async () => {
    const roles = path.join(root, "mason", "roles.yml");
    const original = fs.readFileSync(roles, "utf8");
    fs.writeFileSync(roles, "default: everything\n\nroles:\n  everything:\n    tables: all\n  buyers:\n    tables:\n      public.customers: {}\n");
    try {
      await until(async () => ((JSON.parse((await mason(["status", "--json"])).stdout) as { roles?: { roles: string[] } }).roles?.roles.length ?? 0) === 2, "the listener's roles");
      const refused = await mason(["share", "--json"]);
      assert.equal(refused.code, 2, said(refused));
      const v = JSON.parse(refused.stdout) as { error: { code: string; message: string }; next: Array<{ command: string }> };
      assert.equal(v.error.code, "usage");
      assert.equal(v.error.message, "mason/roles.yml names 2 roles: mason share needs to know which one this address reads as");
      assert.deepEqual(v.next.map((n) => n.command), ["mason share --role everything", "mason share --role buyers"]);
      const person = await mason(["share"]);
      assert.equal(person.code, 2, "no terminal, so no question: the same refusal");
      assert.match(person.stderr, /--role buyers: reads 1 synced table: public\.customers/);
      const typo = await mason(["share", "--role", "buyer"]);
      assert.equal(typo.code, 1, said(typo));
      assert.match(typo.stderr, /there is no role buyer in mason\/roles\.yml.*did you mean/);

      const s = startShare(["--role", "buyers"]);
      const r = await reported(s);
      assert.match(rowOf(s.stdout(), "reads"), /^the role buyers: 1 synced table: public\.customers/);
      const c = client(r.port, r);
      await c.connect();
      assert.ok(Number((await c.query("SELECT count(*) AS n FROM customers")).rows[0].n) > 0);
      await assert.rejects(c.query("SELECT count(*) FROM orders"), (e: pg.DatabaseError) => e.code === "42501" && e.message === "permission denied for table orders");
      await c.end();
      assert.equal((await status()).share?.shares[0]?.role, "buyers");
      s.child.kill("SIGINT");
      await s.exited;
      await gone(r.port);

      // what a share cannot read as is refused at its start, in the failure's one shape, for both readers
      fs.writeFileSync(roles, "default: everything\n\nroles:\n  everything:\n    tables: all\n  tenant:\n    attributes: [who]\n    tables:\n      public.customers: { where: \"id = :who\" }\n");
      await until(async () => ((JSON.parse((await mason(["status", "--json"])).stdout) as { roles?: { roles: string[] } }).roles?.roles.includes("tenant") ?? false), "the listener's roles");
      const needs = await mason(["share", "--role", "tenant", "--json"]);
      assert.equal(needs.code, 1, said(needs));
      const n = JSON.parse(needs.stdout) as { error: { code: string; message: string; why: string }; next: Array<{ command: string }> };
      assert.equal(n.error.code, "refused");
      assert.equal(n.error.message, "a share cannot read as the role tenant: its rows depend on :who, and a share's login has no attributes");
      assert.equal(n.error.why, "roles.tenant.tables.public.customers.where reads :who (id = :who)");
      assert.deepEqual(n.next.map((x) => x.command), ["mason share --role everything", "mason user add <name> --role tenant --set who=<value>"]);
      const told = await mason(["share", "--role", "tenant"]);
      assert.equal(told.code, 1, said(told));
      assert.match(told.stderr, /^✗ mason share: a share cannot read as the role tenant/m);
      assert.match(told.stderr, /fix +--role everything: reads every synced table/);
      assert.equal((await status()).share, null, "nothing opened");

      fs.writeFileSync(roles, "default: everything\n\nroles:\n  everything:\n    tables: all\n  broken:\n    tables:\n      public.customers: { where: \"nope = 1\" }\n");
      await until(async () => ((JSON.parse((await mason(["status", "--json"])).stdout) as { roles?: { roles: string[] } }).roles?.roles.includes("broken") ?? false), "the listener's roles");
      const broken = await mason(["share", "--role", "broken", "--json"]);
      assert.equal(broken.code, 1, said(broken));
      const b = JSON.parse(broken.stdout) as { error: { code: string; message: string; fix: string } };
      assert.equal(b.error.code, "bad_roles");
      assert.match(b.error.message, /roles\.broken\.tables\.public\.customers\.where: column "nope" does not exist/);
      assert.match(b.error.fix, /^repair .*roles\.yml, then mason share$/);

      fs.rmSync(roles);
      await until(async () => ((JSON.parse((await mason(["status", "--json"])).stdout) as { roles?: { file: string | null } }).roles?.file ?? null) === null, "the roles file gone");
      const all = startShare();
      const a = await reported(all);
      assert.match(rowOf(all.stdout(), "reads"), /^every synced table \(this project has no roles file\)$/);
      assert.match(all.stdout(), /With no roles file, anyone with this address and password reads every synced table/);
      all.child.kill("SIGINT");
      await all.exited;
      await gone(a.port);
    } finally { fs.writeFileSync(roles, original); }
  });

  /** the page's request to the run: its cookie and its Origin, as a browser on the page sends them */
  const fromPage = async (method: string, p: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> & { failure?: { message: string; fix?: string } } }> => {
    const base = config().running!.controlUrl;
    const port = new URL(base).port;
    const r = await fetch(`${base}${p}`, { method, headers: { Cookie: `mason_dev_${port}=${config().running!.token}`, Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json() as Record<string, unknown> & { failure?: { message: string; fix?: string } } };
  };

  test("the web page's Connect from anywhere on a real run: the stub's tunnel at the share's socket, TLS required, the password nowhere after; one share at a time with mason share; Stop sharing ends it all", async () => {
    const opened = await fromPage("POST", "/api/share", { from: "page", confirmed: true });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    const r = opened.body as unknown as { user: string; host: string; port: number; password: string; database: string };
    assert.match(r.password, SHARE_PASSWORD_RE);
    const args = fs.readFileSync(path.join(stubState, "args"), "utf8");
    const socket = Number(/-R0:127\.0\.0\.1:(\d+)/.exec(args)?.[1]);
    assert.equal(r.port, socket, "the stub's address is the share's own socket");
    const secure = client(r.port, r);
    await secure.connect();
    assert.equal((await secure.query("SHOW ssl")).rows[0].ssl, "on");
    await secure.end();
    await assert.rejects(client(r.port, r, false).connect(), (e: pg.DatabaseError) => e.code === "28000" && /requires TLS/.test(e.message), "plain refused at the shared socket");
    const st = await status();
    assert.deepEqual(st.share?.shares.map((s) => [s.user, (s as { from?: string }).from, s.state]), [[r.user, "page", "up"]]);
    const stateText = JSON.stringify((await fromPage("GET", "/api/state")).body);
    assert.ok(!stateText.includes(r.password), "no later /api/state carries the password");
    assert.deepEqual(inHome(r.password), [], "no file of .mason/ holds it, the log included");
    // a mason share while the page's is open: refused, naming it
    const cmd = await mason(["share", "--json"]);
    assert.equal(cmd.code, 1, said(cmd));
    assert.match(cmd.stdout, new RegExp(`a share is open already: ${r.user}, opened by the web page`));
    assert.equal((await fromPage("POST", `/api/share/${r.user}/beat`)).status, 200);
    const stopped = await fromPage("DELETE", `/api/share/${r.user}`);
    assert.equal(stopped.status, 200);
    await gone(r.port);
    await until(() => stubAlive().length === 0, "the tunnel's client ended");
    assert.deepEqual(fs.readdirSync(home).filter((f) => /^share-tunnel-/.test(f)), [], "no tunnel file left");
    // and the other order: a mason share open, the page refused
    const s = startShare();
    await reported(s);
    const refused = await fromPage("POST", "/api/share", { from: "page", confirmed: true });
    assert.equal(refused.status, 409);
    assert.match(refused.body.failure?.fix ?? "", /Ctrl-C in the terminal running mason share ends it/);
  });

  test("the run stopping with the page's share open ends it and its tunnel's client; the next start sweeps a tunnel file a killed run left", async () => {
    const opened = await fromPage("POST", "/api/share", { from: "page", confirmed: true });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    assert.equal(stubAlive().length, 1);
    const stop = await mason(["stop"]);
    assert.equal(stop.code, 0, said(stop));
    await until(() => stubAlive().length === 0, "the tunnel's client ended with the run");
    const left = path.join(home, "share-tunnel-999999.ssh");
    fs.writeFileSync(left, "Host mason-share\n", { mode: 0o600 });
    const start = await mason(["start"]);
    assert.equal(start.code, 0, said(start));
    assert.ok(!fs.existsSync(left), "swept at the start");
    const wait = await mason(["wait", "--timeout", "60"]);
    assert.equal(wait.code, 0, said(wait));
  });

  test("the run stopping ends the share: the command says why and exits 1", async () => {
    const s = startShare();
    await reported(s);
    const stop = await mason(["stop"]);
    assert.equal(stop.code, 0, said(stop));
    assert.equal(await s.exited, 1);
    assert.match(s.stderr(), /mason share: the share ended: Mason is stopping/);
    await until(() => stubAlive().length === 0, "the tunnel client ended");
  });
});

// ------------------------------------------------------------------ the web page's share (src/cli/page-share.ts)

const { PageShares } = await import("../src/cli/page-share.ts" as string).catch(absent) as typeof import("../src/cli/page-share.ts");

/** A tunnel that opens at once, ends when told, and records being stopped; `fail` makes it fail as tunnel.ts would. */
function fakeTunnel(o: { fail?: Failure } = {}): { start: NonNullable<import("../src/cli/page-share.ts").PageShareDeps["start"]>; stops: () => number; drop: (why: string) => void; plans: string[][] } {
  let stops = 0, finish: (why: string) => void = () => undefined;
  const plans: string[][] = [];
  return {
    stops: () => stops, drop: (why) => finish(why), plans,
    start: async (plan, opts) => {
      plans.push([plan.bin, ...plan.args]);
      if (o.fail !== undefined) return o.fail;
      opts.onPid?.(4242);
      const ended = new Promise<string>((r) => { finish = r; });
      return { host: "relay.example", port: 41234, endsAt: new Date(Date.now() + 3_600_000).toISOString(), pid: 4242, ended, stop: () => { stops++; finish("it was ended (SIGTERM)"); } };
    },
  };
}
type Failure = import("../src/cli/command.ts").Failure;

function pageShares(o: { fail?: Failure; boundMs?: number; probe?: "same" | "other" | "unknown" } = {}) {
  const f = fakeShares();
  const t = fakeTunnel(o.fail !== undefined ? { fail: o.fail } : {});
  const page = new PageShares({ shares: f.shares, home: os.tmpdir(), log: (l) => f.lines.push(l), start: t.start, probe: async () => o.probe ?? "same", ...(o.boundMs !== undefined ? { boundMs: o.boundMs } : {}) });
  return { f, t, page };
}

test("the page's share is the command's share: one login of RunShares on the TLS socket, a tunnel of tunnel.ts pointed at it; its password in the one answer alone", async () => {
  const { f, t, page } = pageShares();
  const r = await page.open({});
  assert.ok("user" in r, JSON.stringify(r));
  assert.match(r.password, SHARE_PASSWORD_RE, "the command's own password, made by newSharePassword");
  assert.deepEqual([r.host, r.port, r.sslmode, r.fingerprint], ["relay.example", 41234, "require", "AA:BB"]);
  assert.equal(t.plans[0]![0], "ssh", "the free tunnel, over ssh, as mason share's default");
  assert.ok(t.plans[0]!.some((a) => a.endsWith(`:${40001}`)), "pointed at the share's own socket");
  assert.equal((await f.door().authenticate(r.password, r.user)).user, r.user, "the password logs in at the share's socket");
  const st = f.shares.state()!;
  assert.deepEqual(st.shares.map((s) => [s.user, s.from, s.host, s.state]), [[r.user, "page", "relay.example", "up"]]);
  for (const where of [JSON.stringify(st), f.lines.join("\n")]) assert.ok(!where.includes(r.password) && !where.includes(shareSecret(r.password)), "neither the password nor its hash in the state or the log");
  assert.ok(page.beat(r.user));
  assert.equal(await page.stop(r.user), true);
  assert.equal(t.stops(), 1, "Stop sharing stops the tunnel's client");
  assert.equal(f.shares.state(), null);
  assert.deepEqual([f.shares.ended?.user, f.shares.ended?.from, f.shares.ended?.why], [r.user, "page", "Stop sharing, on the web page"]);
  assert.equal(page.beat(r.user), false, "a beat for a share ended is refused");
  assert.throws(() => f.door().authenticate(r.password, r.user), /not this share's password/);
});

test("the page stops checking in: past the bound with no beat the share ends, its tunnel's client with it; a beat in time holds it", async () => {
  const { f, t, page } = pageShares({ boundMs: 150 });
  const r = await page.open({});
  assert.ok("user" in r);
  for (let i = 0; i < 4; i++) { await new Promise((ok) => setTimeout(ok, 60)); assert.ok(page.beat(r.user), "held by beats"); }
  assert.notEqual(f.shares.state(), null);
  await new Promise((ok) => setTimeout(ok, 400));
  assert.equal(f.shares.state(), null, "no beat for the bound: ended");
  assert.equal(t.stops(), 1);
  assert.match(f.shares.ended?.why ?? "", /the web page stopped checking in/);
});

test("the tunnel ends while the page's share is open: the share ends, said why; a tunnel that fails is the page's words and leaves nothing", async () => {
  const { f, t, page } = pageShares();
  const r = await page.open({});
  assert.ok("user" in r);
  t.drop("ssh exited 255: the relay closed the session");
  await new Promise((ok) => setTimeout(ok, 20));
  assert.equal(f.shares.state(), null);
  assert.match(f.shares.ended?.why ?? "", /its tunnel closed \(ssh exited 255/);
  const noSsh = pageShares({ fail: { message: "ssh is not on this machine's PATH, and --via pinggy needs it", code: "not_found", fix: "install it, or use --via bore" } });
  const refused = await noSsh.page.open({});
  assert.ok("failure" in refused);
  assert.match(refused.failure.message, /^ssh is not on this machine, and Connect from anywhere needs it$/);
  assert.match(refused.failure.fix ?? "", /install the OpenSSH client/);
  const offline = pageShares({ fail: { message: "the tunnel ended before it gave an address", code: "failed", why: "ssh exited 255: ssh: Could not resolve hostname", fix: "is this machine online? Port 443 outbound is all it needs" } });
  const off = await offline.page.open({});
  assert.ok("failure" in off);
  assert.match(off.failure.fix ?? "", /is this machine online\? .*nothing was left open/);
  for (const x of [refused.failure, off.failure]) assert.doesNotMatch(JSON.stringify(x), /--via|pinggy|bore|duck/i, "the page's words: no flag of the command's, no provider, no engine");
  assert.equal(noSsh.f.shares.state(), null);
  assert.equal(offline.f.shares.state(), null);
  const other = pageShares({ probe: "other" });
  const wrong = await other.page.open({});
  assert.ok("failure" in wrong);
  assert.match(wrong.failure.message, /is not this share: something else answers there/);
  assert.equal(other.t.stops(), 1);
  assert.equal(other.f.shares.state(), null);
});

test("one share at a time between the page and mason share, in either order: refused naming the open one and how it ends; two commands still share", async () => {
  const { f, page } = pageShares();
  const cmd = await f.shares.open({ secret: shareSecret("a") });
  assert.ok("user" in cmd);
  f.shares.update(cmd.user, { host: "cmd.example", port: 7 });
  const refused = await page.open({});
  assert.ok("failure" in refused);
  assert.match(refused.failure.message, new RegExp(`a share is open already: ${cmd.user}, opened by mason share at cmd.example:7`));
  assert.match(refused.failure.fix ?? "", /Ctrl-C in the terminal running mason share ends it/);
  const second = await f.shares.open({ secret: shareSecret("b") });
  assert.ok("user" in second, "a second mason share meets the same socket, as before");
  await f.shares.closeAll("the test");
  const r = await page.open({});
  assert.ok("user" in r);
  const cmdRefused = await f.shares.open({ secret: shareSecret("c") });
  assert.ok("failure" in cmdRefused);
  assert.match(cmdRefused.failure.message, new RegExp(`opened by the web page at relay.example:41234`));
  assert.match(cmdRefused.failure.fix ?? "", /Stop sharing on the web page's Overview ends it/);
  const again = await page.open({});
  assert.ok("failure" in again && /a share is open already/.test(again.failure.message));
  assert.equal(f.shares.state()?.shares.length, 1);
  await f.shares.closeAll("Mason is stopping");
  assert.match(f.shares.ended?.why ?? "", /Mason is stopping/);
});

test("the page's role: with two roles, the choices offered and the role chosen is the one shared, as mason share --role", async () => {
  const f = fakeShares();
  const two = { ...NO_ROLES, file: "mason/roles.yml", grants: new Map([["sales", { name: "sales", all: false, tables: new Map([["public.orders", {}]]) }], ["ops", { name: "ops", all: true, tables: new Map() }]]) } as unknown as RolesLive;
  const shares = new RunShares({ listener: { openShare: async () => ({ port: 40001, sessions: 0, endSessions: () => 0, close: async () => undefined }), checkRoles: async () => two }, database: "shop", log: () => undefined,
    certificate: () => ({ cert: Buffer.from("c"), key: Buffer.from("k"), fingerprint: "AA:BB" }) });
  const page = new PageShares({ shares, home: os.tmpdir(), log: () => undefined, start: fakeTunnel().start, probe: async () => "same" });
  const asked = await page.choices();
  assert.ok("failure" in asked && asked.choices !== undefined);
  assert.deepEqual(asked.choices.map((c) => c.role).sort(), ["ops", "sales"]);
  const none = await page.open({});
  assert.ok("failure" in none, "no role named with two: refused, nothing opened");
  const r = await page.open({ role: "sales" });
  assert.ok("user" in r);
  assert.equal(r.role, "sales");
  void f;
  await shares.closeAll("the test");
  const one = new PageShares({ shares: fakeShares().shares, home: os.tmpdir(), log: () => undefined, start: fakeTunnel().start, probe: async () => "same" });
  assert.deepEqual(await one.choices(), { role: null, reads: "every synced table" }, "no roles file: no picker");
});
