/**
 * `mason user`'s RULES (src/duck/users.ts): the password `mason_<id>_<mac>` with the MAC over the user's NAME and id
 * keyed by the API key; the list of live users a file with no secret, changed under a lock and written beside and
 * renamed; the listener's view of it read again whenever it changed, failing closed when it cannot be read; and every
 * refusal a login can meet, with its reason. The module is imported inside each test, so a run without it fails each
 * test by name (scripts/fails-without.ts).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ApiError } from "../src/api/error.ts";
import { mintToken, tokenProblem } from "../src/duck/token.ts";

const users = () => import("../src/duck/users.ts");
const KEY = "k".repeat(48), OTHER_KEY = "o".repeat(48);

const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const fileIn = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "duck-users-")); made.push(d); return path.join(d, ".mason", "users.json"); };

/** a user added as `mason user add` adds one */
async function add(file: string, name: string, apiKey = KEY): Promise<{ id: string; password: string }> {
  const u = await users();
  const id = u.newUserId();
  const r = u.changeUsers(file, (list) => [...list, { name, id, addedAt: "2026-10-26T12:00:00.000Z", key: u.keyFingerprint(apiKey) }]);
  assert.ok(Array.isArray(r));
  return { id, password: u.userPassword(apiKey, name, id) };
}

/** what a refused login throws: its status, and the reason a person reads */
function refused(f: () => unknown, status: number, reason: RegExp, user: string): void {
  assert.throws(f, (e: unknown) => e instanceof ApiError && e.status === status && reason.test(e.message) && e.userName === user ||
    assert.fail(`expected ${status} ${reason} for ${user}, got ${e instanceof ApiError ? `${e.status} ${e.message} (${e.userName})` : String(e)}`));
}

test("the password: mason_<16 hex id>_<32 hex MAC over the NAME and id, keyed by the API key>; never a token's shape", async () => {
  const u = await users();
  const id = "0123456789abcdef";
  const p = u.userPassword(KEY, "metabase", id);
  assert.match(p, /^mason_0123456789abcdef_[0-9a-f]{32}$/);
  assert.ok(u.isUserPassword(p));
  assert.equal(u.userPassword(KEY, "metabase", id), p, "deterministic: the same name, id and key make the same password");
  // the MAC binds each of the three
  assert.notEqual(u.userPassword(KEY, "grafana", id), p, "another name");
  assert.notEqual(u.userPassword(KEY, "metabase", "0123456789abcdee"), p, "another id");
  assert.notEqual(u.userPassword(OTHER_KEY, "metabase", id), p, "another API key");
  assert.match(u.newUserId(), /^[0-9a-f]{16}$/);
  assert.notEqual(u.newUserId(), u.newUserId());
  // a token is never read as a user's password, nor a user's as a token: the two shapes are apart
  const token = mintToken(KEY, 600).token;
  assert.ok(!u.isUserPassword(token));
  assert.match(tokenProblem(KEY, p) ?? "", /not a Mason user.s password or token/);
  assert.equal(tokenProblem(KEY, token), null);
  assert.ok(!u.isUserPassword(KEY), "the API key is no user's password");
  // the key's fingerprint is no secret and says which key: the same key, the same fingerprint
  assert.match(u.keyFingerprint(KEY), /^[0-9a-f]{16}$/);
  assert.equal(u.keyFingerprint(KEY), u.keyFingerprint(KEY));
  assert.notEqual(u.keyFingerprint(KEY), u.keyFingerprint(OTHER_KEY));
  assert.ok(!u.keyFingerprint(KEY).includes("k"), "it is not the key");
  // a user's name: what a form calls a user, lower case
  for (const ok of ["metabase", "grafana-prod", "bi.team_1", "a", "9lives"]) assert.ok(u.USER_NAME_RE.test(ok), ok);
  for (const bad of ["Metabase", "", "-x", "a b", "x".repeat(64), "naïve"]) assert.ok(!u.USER_NAME_RE.test(bad), bad);
});

test("the file: none is no users; written beside and renamed, mode 0600, no password in it; a change sees the list as it is; a refusal writes nothing", async () => {
  const u = await users();
  const file = fileIn();
  assert.deepEqual(u.readUsers(file), { users: [] }, "no file: no users, never a failure");
  const a = await add(file, "metabase");
  const b = await add(file, "grafana");
  const read = u.readUsers(file);
  assert.ok("users" in read);
  assert.deepEqual(read.users.map((x) => [x.name, x.id]), [["metabase", a.id], ["grafana", b.id]]);
  const text = fs.readFileSync(file, "utf8");
  assert.ok(!text.includes(a.password) && !text.includes(a.password.split("_")[2]!), "no password, nor its MAC, is in the file");
  assert.ok(!text.includes(KEY), "nor the key");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ["users.json"], "no temp file or lock left beside it");
  const ino = fs.statSync(file).ino;
  // a refusal returns as it is and writes nothing
  const r = u.changeUsers(file, () => ({ refused: "taken" }));
  assert.deepEqual(r, { refused: "taken" });
  assert.equal(fs.statSync(file).ino, ino, "the file was not written");
  // a removal is a rename over the file: a reader sees the old list or the new one
  u.changeUsers(file, (list) => list.filter((x) => x.name !== "metabase"));
  assert.notEqual(fs.statSync(file).ino, ino, "replaced by a rename, never written in place");
  assert.deepEqual((u.readUsers(file) as { users: Array<{ name: string }> }).users.map((x) => x.name), ["grafana"]);
});

test("a removed user is KEPT with removedAt: the listener refuses it at login and mid-session as before, its name can be added again, malformed entries are still refused", async () => {
  const u = await users();
  const file = fileIn();
  const live = new u.LiveUsers(file, KEY);
  const m = await add(file, "metabase");
  const g = await add(file, "grafana");
  const token = live.login("metabase", m.password);
  u.changeUsers(file, (l) => l.map((x) => x.name === "metabase" ? { ...x, removedAt: "2026-10-27T09:00:00.000Z" } : x));
  const read = u.readUsers(file);
  assert.ok("users" in read);
  assert.deepEqual(read.users.map((x) => [x.name, x.removedAt]), [["metabase", "2026-10-27T09:00:00.000Z"], ["grafana", undefined]], "kept, marked");
  assert.deepEqual(read.users.filter(u.isActive).map((x) => x.name), ["grafana"]);
  // the held session's next statement and a new login: refused exactly as when the entry was deleted
  assert.throws(() => live.recheck(token), (e: unknown) => e instanceof ApiError && e.status === 401 && e.message === "the user \"metabase\" was removed" && e.userName === "metabase");
  refused(() => live.login("metabase", m.password), 401, /^the user "metabase" was removed \(mason user list shows the users; mason user add metabase makes it again, with a new password\)$/, "metabase");
  assert.deepEqual(live.now(), { users: [read.users[1]] }, "the listener's list holds the live users only");
  assert.equal(live.login("grafana", g.password).user, "grafana");
  // a name added again beside the removed entry: a new id; the removed one stays refused
  const again = await add(file, "metabase");
  assert.equal(live.login("metabase", again.password).jti, again.id);
  refused(() => live.login("metabase", m.password), 401, /was removed/, "metabase");
  // a malformed entry is still refused, a removedAt that is not a string too
  fs.writeFileSync(file, JSON.stringify({ users: [{ name: "x", id: "0123456789abcdef", addedAt: "t", key: "k", removedAt: 5 }] }));
  const bad = u.readUsers(file);
  assert.ok("problem" in bad && /users\[0\]\.removedAt is not a timestamp/.test(bad.problem), JSON.stringify(bad));
  fs.writeFileSync(file, JSON.stringify({ users: [{ name: "x", id: "0123456789abcdef", addedAt: "t" }] }));
  const bad2 = u.readUsers(file);
  assert.ok("problem" in bad2 && /users\[0\] is not \{ name, id, addedAt, key, role\?\[, removedAt\]\[, disabledAt\] \}/.test(bad2.problem), JSON.stringify(bad2));
});

test("a DISABLED user is kept with disabledAt and its password: its login (right password) refused user_disabled in Postgres's words, mid-session too; a wrong password still a wrong one; enabled, the same password connects", async () => {
  const u = await users();
  const file = fileIn();
  const live = new u.LiveUsers(file, KEY);
  const m = await add(file, "metabase");
  const token = live.login("metabase", m.password);
  u.changeUsers(file, (l) => l.map((x) => x.name === "metabase" ? { ...x, disabledAt: "2026-10-28T09:00:00.000Z" } : x));
  const read = u.readUsers(file);
  assert.ok("users" in read);
  assert.deepEqual(read.users.map((x) => [x.name, x.disabledAt, u.isActive(x), u.isDisabled(x)]), [["metabase", "2026-10-28T09:00:00.000Z", true, true]], "kept, marked, not removed");
  const disabled = (e: unknown): boolean => e instanceof ApiError && e.status === 401 && e.code === "user_disabled" && e.userName === "metabase";
  assert.throws(() => live.recheck(token), (e: unknown) => disabled(e) && (e as Error).message === "the user \"metabase\" was disabled");
  assert.throws(() => live.login("metabase", m.password), (e: unknown) => disabled(e) &&
    (e as Error).message === "role \"metabase\" is not permitted to log in");
  // its state is said only to the holder of its password: a forged one is a wrong password, as for any user
  refused(() => live.login("metabase", `mason_${m.id}_${"0".repeat(32)}`), 401, /^not a password of this project's users: mason user list shows them$/, "metabase");
  // enabled: disabledAt gone, the same id, so the same password and the held token are live again
  u.changeUsers(file, (l) => l.map((x) => { const { disabledAt: _, ...rest } = x; return rest; }));
  assert.equal(live.login("metabase", m.password).jti, m.id);
  assert.doesNotThrow(() => live.recheck(token));
  // a disabledAt that is not a string: refused as the file mason user writes is not
  fs.writeFileSync(file, JSON.stringify({ users: [{ name: "x", id: "0123456789abcdef", addedAt: "t", key: "k", disabledAt: true }] }));
  const bad = u.readUsers(file);
  assert.ok("problem" in bad && /users\[0\]\.disabledAt is not a timestamp as mason user disable writes it/.test(bad.problem), JSON.stringify(bad));
});

test("the file's lock: a held one waits, then refuses saying what holds it; one left by a process that died is taken", async () => {
  const u = await users();
  const file = fileIn();
  await add(file, "metabase");
  const lock = `${file}.lock`;
  fs.writeFileSync(lock, "");
  const t0 = Date.now();
  assert.throws(() => u.changeUsers(file, (l) => l), /users\.json\.lock is held by another mason user command .*run it again once that one ends/);
  assert.ok(Date.now() - t0 >= 4000, "it waited for the other command first");
  assert.ok(fs.existsSync(lock), "another's lock is never removed while it is fresh");
  // a lock older than 30 s was left by a process that died holding it
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  await add(file, "grafana");
  assert.ok(!fs.existsSync(lock));
  assert.deepEqual((u.readUsers(file) as { users: Array<{ name: string }> }).users.map((x) => x.name), ["metabase", "grafana"]);
});

test("a file that cannot be read is a problem, never an empty list; a change refuses to write over it", async () => {
  const u = await users();
  const file = fileIn();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const [text, why] of [["{\"users\": [", /is not valid JSON/], ["[]", /is not \{ "users": \[ … \] \}/],
    ["{\"users\": [{\"name\": \"Metabase\", \"id\": \"0123456789abcdef\", \"addedAt\": \"x\", \"key\": \"y\"}]}", /users\[0\] is not \{ name, id, addedAt, key, role\?\[, removedAt\]\[, disabledAt\] \}/]] as const) {
    fs.writeFileSync(file, text);
    const r = u.readUsers(file);
    assert.ok("problem" in r && why.test(r.problem), `${text}: ${JSON.stringify(r)}`);
    assert.throws(() => u.changeUsers(file, (l) => l), why);
    assert.equal(fs.readFileSync(file, "utf8"), text, "left as it was");
  }
});

test("a login: the user's name and its password; every refusal 401 with its reason, the name asked for kept for the request log", async () => {
  const u = await users();
  const file = fileIn();
  const live = new u.LiveUsers(file, KEY);
  const m = await add(file, "metabase");
  const g = await add(file, "grafana");
  assert.deepEqual(live.login("metabase", m.password), { filters: [], subject: undefined, user: "metabase", jti: m.id });
  assert.deepEqual(live.login("grafana", g.password), { filters: [], subject: undefined, user: "grafana", jti: g.id });
  // the user name must be the user's: the password says whose it is (the holder has it already)
  // another user's password is refused as a wrong password is: naming whose it is handed the name (which, with the
  // password, is the login) to anyone holding only the password (found on the test server)
  refused(() => live.login("mason", m.password), 401, /^not a password of this project's users: mason user list shows them$/, "mason");
  refused(() => live.login("grafana", m.password), 401, /^not a password of this project's users/, "grafana");
  // a MAC that does not verify: forged, or another project's
  refused(() => live.login("metabase", `mason_${m.id}_${"0".repeat(32)}`), 401, /^not a password of this project's users: mason user list shows them$/, "metabase");
  refused(() => live.login("metabase", u.userPassword(OTHER_KEY, "metabase", "fedcba9876543210")), 401, /not a password of this project's users \(or the API key was rotated, which removes every user\)/, "metabase");
  refused(() => live.login("metabase", "hunter2"), 401, /not a Mason user's password/, "metabase");
  // removed: its own name and password, so it is said as removed
  u.changeUsers(file, (l) => l.filter((x) => x.name !== "metabase"));
  refused(() => live.login("metabase", m.password), 401, /^the user "metabase" was removed \(mason user list shows the users; mason user add metabase makes it again, with a new password\)$/, "metabase");
  assert.equal(live.login("grafana", g.password).user, "grafana", "the others connect as before");
});

test("rotating the API key removes every user at once: no MAC verifies under the new key, and the reason says it", async () => {
  const u = await users();
  const file = fileIn();
  const m = await add(file, "metabase", KEY);
  const rotated = new u.LiveUsers(file, OTHER_KEY);
  refused(() => rotated.login("metabase", m.password), 401, /^the API key was rotated since the user "metabase" was added, which removes every user: mason user remove metabase, then mason user add metabase$/, "metabase");
  const user = (await users()).readUsers(file) as { users: Array<import("../src/duck/users.ts").MasonUser> };
  assert.ok(u.underKey(user.users[0]!, KEY) && !u.underKey(user.users[0]!, OTHER_KEY));
});

test("the listener's view is read again whenever the file changed, so a removal refuses the next login and a held session's next statement", async () => {
  const u = await users();
  const file = fileIn();
  const live = new u.LiveUsers(file, KEY);
  assert.deepEqual(live.now(), { users: [] });
  const m = await add(file, "metabase");
  const token = live.login("metabase", m.password);
  assert.doesNotThrow(() => live.recheck(token));
  // another process's change, as mason user remove makes it: seen at once
  u.changeUsers(file, () => []);
  assert.throws(() => live.recheck(token), (e: unknown) => e instanceof ApiError && e.status === 401 && e.message === "the user \"metabase\" was removed" && e.userName === "metabase");
  // added again under the same name: a NEW id, so the old session's user is still not live, and the new password is
  const again = await add(file, "metabase");
  assert.throws(() => live.recheck(token), /was removed/);
  assert.equal(live.login("metabase", again.password).jti, again.id);
  assert.throws(() => live.login("metabase", m.password), /was removed/, "the old password never connects again");
  // a token's session is no user's: nothing to ask
  assert.doesNotThrow(() => live.recheck({ filters: [], subject: undefined }));
});

test("FAIL CLOSED: a list that cannot be read refuses every user's login and statement 503 with the reason, never as live; read again once repaired", async () => {
  const u = await users();
  const file = fileIn();
  const live = new u.LiveUsers(file, KEY);
  const m = await add(file, "metabase");
  const token = live.login("metabase", m.password);
  const good = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, "{ not json");
  refused(() => live.login("metabase", m.password), 503, /^the list of users cannot be read, so no user can connect: .*users\.json is not valid JSON/, "metabase");
  assert.throws(() => live.recheck(token), (e: unknown) => e instanceof ApiError && e.status === 503 && /the list of users cannot be read/.test(e.message));
  // an unreadable file (no permission) is a problem too, never "no users"
  fs.writeFileSync(file, good);
  fs.chmodSync(file, 0o000);
  try {
    if (process.getuid?.() !== 0) refused(() => live.login("metabase", m.password), 503, /cannot be read/, "metabase");
  } finally { fs.chmodSync(file, 0o600); }
  // repaired: read again even when its stamp is the one last seen (a problem is never cached)
  assert.equal(live.login("metabase", m.password).user, "metabase");
});

test("the run's wiring: a user's password goes to the users file, anything else is a token as before, the API key refused by name", async () => {
  const u = await users();
  const file = fileIn();
  const logins = u.listenerLogins(new u.LiveUsers(file, KEY), KEY);
  assert.equal(logins.recheckMs, 0, "a user's session is asked before every statement: a stat");
  const m = await add(file, "metabase");
  assert.equal((await logins.authenticate(m.password, "metabase")).user, "metabase");
  assert.deepEqual(await logins.authenticate(mintToken(KEY, 600).token, "anyone"), { filters: [], subject: undefined }, "a token's session: any user name");
  await assert.rejects(async () => logins.authenticate(KEY, "metabase"), /the API key is not a password here: mason user add <name> makes a user whose password does not expire/);
  await assert.rejects(async () => logins.authenticate(m.password, "grafana"), /not a password of this project's users/);
});
