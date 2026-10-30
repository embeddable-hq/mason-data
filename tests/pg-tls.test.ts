/**
 * THE RUN'S POSTGRES LISTENER OFF THIS MACHINE (src/cli/pg-tls.ts, src/api/postgres/listener.ts pgListenerSettings,
 * src/cli/self-signed-cert.ts): `mason start` reads where and how it listens with the one reader of it — off
 * loopback only with TLS or MASON_PG_PLAIN=1, refused in the Failure shape before anything starts — and
 * `--self-signed-tls` makes a certificate Node and OpenSSL both read, kept in .mason/ (0600) and served again. The TLS
 * round trip against the real listener is tests/duck-users-wire.test.ts's.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pgListenerSettings } from "../src/api/postgres/listener.ts";
import { plainListenerProblem, problemText } from "../src/api/postgres/plain.ts";
import { selfSignedCertificate } from "../src/cli/self-signed-cert.ts";
import { ensureSelfSigned, listenerText, runListenerSettings, SELF_SIGNED_FILES } from "../src/cli/pg-tls.ts";
import { failureText } from "../src/cli/command.ts";
import { PLAIN } from "../src/cli/style.ts";
import { matrixEnv, runMason } from "./cli-matrix.ts";

const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (prefix: string): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };

test("a self-signed certificate made with Node alone: it parses, it is signed by its own key, the key is its own, valid from an hour ago for ten years", () => {
  const now = new Date("2026-10-26T12:00:00Z");
  const s = selfSignedCertificate("mason-shop", { now });
  const x = new crypto.X509Certificate(s.cert);
  assert.equal(x.subject, "CN=mason-shop");
  assert.equal(x.issuer, "CN=mason-shop", "self-signed: its issuer is itself");
  assert.ok(x.verify(x.publicKey), "the signature is its own key's");
  assert.ok(x.checkPrivateKey(crypto.createPrivateKey(s.key)), "the key written beside it is its key");
  assert.equal(new Date(x.validFrom).toISOString(), "2026-10-26T11:00:00.000Z");
  assert.equal(new Date(x.validTo).toISOString(), "2036-10-26T12:00:00.000Z");
  assert.match(x.serialNumber, /^[0-9A-F]{32}$/, "a 16-byte positive serial");
  // from 2050 a time is a GeneralizedTime (RFC 5280), and still reads back
  assert.equal(new Date(new crypto.X509Certificate(selfSignedCertificate("x", { now: new Date("2045-01-01T00:00:00Z") }).cert).validTo).toISOString(), "2055-01-01T00:00:00.000Z");
  // two certificates never share a key or a serial
  const t = new crypto.X509Certificate(selfSignedCertificate("mason-shop", { now }).cert);
  assert.notEqual(t.serialNumber, x.serialNumber);
  assert.notEqual(t.fingerprint256, x.fingerprint256);
});

test("one reader of where and how the listener listens: loopback plain, off loopback TLS or MASON_PG_PLAIN=1, the two files together", () => {
  assert.deepEqual(pgListenerSettings({ MASON_PG_PORT: "5440" }, "127.0.0.1"), { host: "127.0.0.1", port: 5440, tls: null });
  assert.deepEqual(pgListenerSettings({ MASON_PG_HOST: "0.0.0.0", MASON_PG_TLS_CERT: "/c.pem", MASON_PG_TLS_KEY: "/k.pem" }, "127.0.0.1"),
    { host: "0.0.0.0", port: 5433, tls: { cert: "/c.pem", key: "/k.pem" } });
  assert.deepEqual(pgListenerSettings({ MASON_PG_HOST: "10.0.0.5", MASON_PG_PLAIN: "1" }, "127.0.0.1"), { host: "10.0.0.5", port: 5433, tls: null });
  const plain = pgListenerSettings({ MASON_PG_HOST: "0.0.0.0" }, "127.0.0.1");
  assert.ok("problem" in plain && plain.kind === "plain");
  // in parts for mason start, and as ONE line for the service, word for word what it said before the parts existed
  assert.equal(problemText(plain), plainListenerProblem("0.0.0.0", undefined, false));
  assert.equal(problemText(plain), "the Postgres API would listen PLAIN on 0.0.0.0, off loopback: a token travels as the password in clear on that network. " +
    "Set MASON_PG_TLS_CERT and MASON_PG_TLS_KEY (PEM files) to require TLS, or MASON_PG_PLAIN=1 to say the port is published on a private network " +
    "(a compose or Kubernetes network, a 127.0.0.1 publish on the host) — docs/POSTGRES-API.md \"Connecting\"");
  const half = pgListenerSettings({ MASON_PG_TLS_CERT: "/c.pem" }, "127.0.0.1");
  assert.ok("problem" in half && half.kind === "tls_pair");
  const value = pgListenerSettings({ MASON_PG_HOST: "0.0.0.0", MASON_PG_PLAIN: "yes" }, "127.0.0.1");
  assert.ok("problem" in value && value.kind === "plain_value");
  const port = pgListenerSettings({ MASON_PG_PORT: "x" }, "127.0.0.1");
  assert.ok("problem" in port && port.kind === "port");
});

test("the run's listener: the shell's host with the port mason start chose; off loopback without a certificate refused as a Failure (what, why, the way out, next)", () => {
  const home = "/p/.mason";
  // the DuckDB run listened on 127.0.0.1 whatever MASON_PG_HOST said, with no TLS: now the shell's host is the host
  assert.deepEqual(runListenerSettings({}, { port: 5444, selfSigned: false, home }), { host: "127.0.0.1", port: 5444, tls: null });
  assert.deepEqual(runListenerSettings({ MASON_PG_HOST: "0.0.0.0", MASON_PG_PORT: "9999", MASON_PG_TLS_CERT: "/c", MASON_PG_TLS_KEY: "/k" }, { port: 5444, selfSigned: false, home }),
    { host: "0.0.0.0", port: 5444, tls: { cert: "/c", key: "/k" } }, "the port is the one mason start chose");
  // --self-signed-tls names the project's own files through the same two variables
  assert.deepEqual(runListenerSettings({ MASON_PG_HOST: "0.0.0.0" }, { port: 5444, selfSigned: true, home }),
    { host: "0.0.0.0", port: 5444, tls: { cert: path.join(home, SELF_SIGNED_FILES.cert), key: path.join(home, SELF_SIGNED_FILES.key) } });
  const refused = runListenerSettings({ MASON_PG_HOST: "0.0.0.0" }, { port: 5444, selfSigned: false, home });
  assert.ok("problem" in refused);
  const text = failureText("start", { ...refused, message: refused.problem }, PLAIN);
  assert.equal(text.replace(/\nNext:[^]*$/, ""),
    "✗ mason start: the Postgres API would listen PLAIN on 0.0.0.0, off loopback\n" +
    "  why   a token travels as the password in clear on that network\n" +
    "  fix   Set MASON_PG_TLS_CERT and MASON_PG_TLS_KEY (PEM files) to require TLS, or MASON_PG_PLAIN=1 to say the port is published on a private network " +
    "(a compose or Kubernetes network, a 127.0.0.1 publish on the host) — docs/POSTGRES-API.md \"Connecting\". Or mason start --self-signed-tls: a certificate made for this project in .mason/\n");
  assert.match(text, /\nNext:\n {2}mason start --self-signed-tls +TLS from a certificate made in \.mason\/ \(clients connect with sslmode=require\)$/);
  assert.equal(refused.code, "refused");
  // a team's own proxy terminating TLS says so, and the listener stays plain
  assert.deepEqual(runListenerSettings({ MASON_PG_HOST: "10.0.0.5", MASON_PG_PLAIN: "1" }, { port: 5444, selfSigned: false, home }), { host: "10.0.0.5", port: 5444, tls: null });
  // two certificates named: a wrong line
  const both = runListenerSettings({ MASON_PG_TLS_CERT: "/c", MASON_PG_TLS_KEY: "/k" }, { port: 5444, selfSigned: true, home });
  assert.ok("problem" in both && both.code === "usage");
  assert.match(both.problem, /--self-signed-tls makes a certificate, and MASON_PG_TLS_CERT \/ MASON_PG_TLS_KEY name one/);
});

test("what the listener serves, one line: its address, TLS and whose certificate, or plain and where", () => {
  assert.equal(listenerText({ host: "127.0.0.1", tls: null }, 5433), "127.0.0.1:5433, plain: this machine only");
  assert.equal(listenerText({ host: "0.0.0.0", tls: "self-signed", fingerprint: "AB:CD" }, 5433),
    "0.0.0.0:5433 (every address of this machine), TLS required: a self-signed certificate (.mason/postgres-tls.crt), SHA-256 AB:CD");
  assert.equal(listenerText({ host: "10.0.0.5", tls: "certificate", fingerprint: "EF" }, 6432), "10.0.0.5:6432, TLS required: the certificate MASON_PG_TLS_CERT names, SHA-256 EF");
  assert.match(listenerText({ host: "10.0.0.5", tls: null }, 6432), /^10\.0\.0\.5:6432, PLAIN under MASON_PG_PLAIN=1/);
  assert.match(listenerText({ host: "::", tls: null }, 1), /^\[::\]:1 \(every address/);
});

test("--self-signed-tls's files: made 0600 in .mason/, the same served again, made again when the key is not its own or it expired", () => {
  const home = tmp("mason-tls-");
  const first = ensureSelfSigned(home);
  assert.match(first.said ?? "", /^made a self-signed certificate: \.mason\/postgres-tls\.crt$/);
  for (const f of Object.values(SELF_SIGNED_FILES)) assert.equal(fs.statSync(path.join(home, f)).mode & 0o777, 0o600, `${f} is the developer's alone`);
  const x = new crypto.X509Certificate(fs.readFileSync(path.join(home, SELF_SIGNED_FILES.cert)));
  assert.equal(x.fingerprint256, first.fingerprint);
  assert.equal(x.subject, "CN=mason", "a certificate is handed to whoever connects, before any login");
  assert.equal(x.issuer, "CN=mason");
  const again = ensureSelfSigned(home);
  assert.deepEqual(again, { fingerprint: first.fingerprint, said: null }, "a later start serves the same certificate: a tool that pinned it keeps connecting");
  // another key beside it: made again, said why
  fs.writeFileSync(path.join(home, SELF_SIGNED_FILES.key), selfSignedCertificate("other").key);
  const rekeyed = ensureSelfSigned(home);
  assert.notEqual(rekeyed.fingerprint, first.fingerprint);
  assert.match(rekeyed.said ?? "", /was not the key of \.mason\/postgres-tls\.crt/);
  // expired: made again
  const later = ensureSelfSigned(home, new Date(Date.now() + 11 * 365 * 86_400_000));
  assert.notEqual(later.fingerprint, rekeyed.fingerprint);
  assert.match(later.said ?? "", /the one in \.mason\/ expired/);
  // one a project made before it named nothing: made again, so the name stops being handed out, and said: its fingerprint moves
  const named = selfSignedCertificate("mason-shop");
  fs.writeFileSync(path.join(home, SELF_SIGNED_FILES.cert), named.cert);
  fs.writeFileSync(path.join(home, SELF_SIGNED_FILES.key), named.key);
  const renamed = ensureSelfSigned(home);
  assert.match(renamed.said ?? "", /^made a new self-signed certificate: the one in \.mason\/ named this project to whoever connected$/);
  assert.equal(new crypto.X509Certificate(fs.readFileSync(path.join(home, SELF_SIGNED_FILES.cert))).subject, "CN=mason");
});

test("mason start refuses a plain listener off loopback before it starts anything, in the Failure shape, as a person and with --json, in the background and attached", async () => {
  const root = tmp("mason-tls-start-");
  fs.mkdirSync(path.join(root, ".mason"), { mode: 0o700 });
  fs.mkdirSync(path.join(root, "mason", "sources"), { recursive: true });
  fs.writeFileSync(path.join(root, ".mason", "config.json"), JSON.stringify({
    name: "shop", source: "postgres://mason:secret@127.0.0.1:1/shop", folder: "mason", remote: false, apiKey: "k".repeat(48),
    sourceServer: null, lastRun: null, running: null,
  }), { mode: 0o600 });
  const env = matrixEnv({ HOME: tmp("mason-tls-home-"), PATH: path.dirname(process.execPath), MASON_PG_HOST: "0.0.0.0" });
  for (const attach of [false, true]) {
    const p = await runMason(root, ["start", ...(attach ? ["--attach"] : [])], env);
    assert.equal(p.code, 1, p.stdout + p.stderr);
    assert.match(p.stderr, /^✗ mason start: the Postgres API would listen PLAIN on 0\.0\.0\.0, off loopback\n {2}why {3}a token travels as the password in clear on that network\n {2}fix {3}Set MASON_PG_TLS_CERT and MASON_PG_TLS_KEY .* Or mason start --self-signed-tls: a certificate made for this project in \.mason\/\n\nNext:\n {2}mason start --self-signed-tls /);
    assert.doesNotMatch(p.stdout + p.stderr, /Connecting to/, "refused before the database is connected to");
  }
  const j = await runMason(root, ["start", "--json"], env);
  assert.equal(j.code, 1, j.stdout + j.stderr);
  const v = JSON.parse(j.stdout) as { error: { code: string; message: string; why: string; fix: string }; next: Array<{ command: string }> };
  assert.deepEqual([v.error.code, v.error.message, v.error.why], ["refused", "the Postgres API would listen PLAIN on 0.0.0.0, off loopback", "a token travels as the password in clear on that network"]);
  assert.match(v.error.fix, /MASON_PG_TLS_CERT and MASON_PG_TLS_KEY.*MASON_PG_PLAIN=1.*--self-signed-tls/);
  assert.deepEqual(v.next.map((n) => n.command), ["mason start --self-signed-tls"]);
  // the flag beside a certificate the shell names: a wrong line
  const both = await runMason(root, ["start", "--self-signed-tls", "--json"], { ...env, MASON_PG_TLS_CERT: "/c.pem", MASON_PG_TLS_KEY: "/k.pem" });
  assert.equal(both.code, 2, both.stdout + both.stderr);
  assert.equal((JSON.parse(both.stdout) as { error: { code: string } }).error.code, "usage");
  assert.ok(!fs.existsSync(path.join(root, ".mason", "dev.log")), "nothing was spawned");
});
