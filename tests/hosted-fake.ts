/**
 * A FAKE HOSTED SERVICE AND THE RUNS AGAINST IT, for tests/cli-login.test.ts and tests/cli-login-service.test.ts: an
 * http server of the test's own on 127.0.0.1 (no network), the real CLI as a child process pointed at it, and `mason`,
 * which holds EVERY run to the rules no answer of the service may break (src/cli/hosted.ts's header): no secret on
 * either stream; a failure's code the CLI's own; no line a person reads begun by the service's text — logical lines on
 * a pipe, visual lines at the terminal's width for a run on a terminal (`terminal`).
 */
import { after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { matrixEnv, runMason, type Answer } from "./cli-matrix.ts";
import { exitOf, FAILURE_CODES } from "../src/cli/command.ts";

export const MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "main.ts");

/** A token as the service documents them: a prefix, then 43 base64url characters. */
export const newToken = (kind: "pat" | "ci" = "pat"): string => `masondata_${kind}_${randomBytes(32).toString("base64url")}`;

/** Every secret any run may have seen, and every answer: the last test holds them apart. */
export const SECRETS: string[] = [];
export const ANSWERS: Answer[] = [];
const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

export interface Req { at: number; method: string; path: string; headers: http.IncomingHttpHeaders; form: Record<string, string> }
export type Reply = { status: number; body?: unknown; raw?: string; headers?: Record<string, string> } | "drop";
export interface Script {
  device?: Reply;
  /** the n-th poll's answer (0-based) */
  token?: (n: number) => Reply;
  me?: Reply;
  revoke?: Reply;
}

/** The device code the fake hands out, by default: 1 s between polls, 60 s to approve, its pages on its own origin
 *  (`BASE` in any answer is the fake's own address). */
export const BASE = "http://BASE";
export const DEVICE = { device_code: "dev-code-1", user_code: "WDJBMJHT", verification_uri: `${BASE}/device`, verification_uri_complete: `${BASE}/device?user_code=WDJBMJHT`, expires_in: 60, interval: 1 };
export const ME = { email: "ada@example.com", name: "Ada", orgs: [{ slug: "acme", name: "Acme Inc", role: "owner" }, { slug: "beta", name: "beta", role: "viewer" }] };
export const pending: Reply = { status: 400, body: { error: "authorization_pending" } };
export const granted = (token: string): Reply => ({ status: 200, body: { access_token: token, token_type: "Bearer", expires_in: 7776000 } });

/** A fake service: answers as `script` says, records every request. */
export async function fakeService(script: Script): Promise<{ url: string; requests: Req[]; script: Script; close: () => Promise<void> }> {
  const requests: Req[] = [];
  let polls = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (b: Buffer) => { body += b.toString(); });
    req.on("end", () => {
      const p = new URL(req.url ?? "/", "http://x").pathname;
      requests.push({ at: Date.now(), method: req.method ?? "", path: p, headers: req.headers, form: Object.fromEntries(new URLSearchParams(body)) });
      const reply: Reply = p === "/oauth/device/code" ? script.device ?? { status: 200, body: DEVICE }
        : p === "/oauth/token" ? (script.token ?? (() => pending))(polls++)
        : p === "/v1/me" ? script.me ?? { status: 200, body: ME }
        : p === "/oauth/revoke" ? script.revoke ?? { status: 200, body: {} }
        : { status: 404, body: { error: { code: "not_found", message: "no such endpoint" }, next: [] } };
      if (reply === "drop") { req.socket.destroy(); return; }
      res.writeHead(reply.status, { "content-type": reply.raw === undefined ? "application/json" : "text/html", ...reply.headers });
      res.end(reply.raw ?? (reply.body === undefined ? "" : JSON.stringify(reply.body).replaceAll(BASE, `http://127.0.0.1:${port}`)));
    });
  });
  let port = 0;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, requests, script, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

/** A home of its own, for a run. */
export function home(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mason-login-"));
  made.push(d);
  return fs.realpathSync(d);
}

/** The environment of a run: its home, its service, more (MASON_TOKEN). */
export const envFor = (h: string, url: string, extra: Record<string, string> = {}): Record<string, string> => matrixEnv({ HOME: h, PATH: path.dirname(process.execPath), MASON_CLOUD_URL: url, ...extra });

/** Every step login and logout give, in every state: their own, never the service's. */
export const OWN_STEP = /^ {2}(mason login|mason logout|env -u MASON_TOKEN mason login|unset MASON_CLOUD_URL|chmod (600|700) \S+)(\s|$)/;

/**
 * THE LINES THE CLI BEGINS, all of them (a line that begins otherwise is not the CLI's: a service's text took a line's
 * start): a blank; its one Next: heading; a tip; its one failure; its headlines and its progress; a row of its own
 * labels; after Next:, a step of its own (OWN_STEP); and a continuation, indented 4 or more (src/cli/command.ts
 * CONTINUATION). What follows the start is the CLI's to choose, the service's value inside it.
 */
const STARTS: readonly RegExp[] = [
  /^$/, /^Next:$/, /^Tip: \S/, /^[✘✗] mason (login|logout): \S/,
  /^(Signed in to |Signed out of |This machine is not signed in to |To sign in to |Waiting for the code to be approved )/,
  /^([✔✓] )?Approved$/, /^[✘✗] Waiting for the code to be approved /,
  /^ {2}(name|orgs|saved|account|revoked|removed from|file|page|code|why|fix) {2,}\S/,
  /^ {4,}\S/,
];

/** Columns as the CLI counts them for a line that holds a service's text: a character outside ASCII as two. */
const cols = (ch: string): number => ch.codePointAt(0)! <= 0x7e ? 1 : 2;

/**
 * WHAT A PERSON SEES of a stream on a terminal `width` columns wide: each line as the terminal last drew it (a spinner's
 * `\r` redraws keep their last), its cursor and colour codes gone, and a line longer than the width broken by the
 * terminal at the width, each piece a line of its own. Without a width, the logical lines (a pipe).
 */
export function seen(text: string, width: number | null): Array<{ line: string; byTerminal: boolean }> {
  const out: Array<{ line: string; byTerminal: boolean }> = [];
  for (const logical of text.split("\n")) {
    const drawn = logical.split("\r").pop()!.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    if (width === null) { out.push({ line: drawn, byTerminal: false }); continue; }
    let line = "", w = 0, piece = 0;
    for (const ch of drawn) {
      if (w + cols(ch) > width) { out.push({ line, byTerminal: piece++ > 0 }); line = ""; w = 0; }
      line += ch; w += cols(ch);
    }
    out.push({ line, byTerminal: piece > 0 });
  }
  return out;
}

/** What is wrong with what a person sees of one stream, as sentences: a line the CLI did not begin, a second Next: or
 *  failure, a step under Next: that is not the CLI's, a line the terminal broke. */
export function seenProblems(text: string, width: number | null): string[] {
  const p: string[] = [];
  const lines = seen(text, width);
  let afterNext = false, nexts = 0, failures = 0;
  for (const { line, byTerminal } of lines) {
    if (byTerminal) p.push(`the terminal broke a line, so a line begins where a value chose: ${JSON.stringify(line)}`);
    if (line === "Next:") { nexts++; afterNext = true; continue; }
    if (/^[✘✗] mason /.test(line)) failures++;
    if (afterNext && /^ {2}\S/.test(line)) { if (!OWN_STEP.test(line)) p.push(`a step the CLI does not give: ${JSON.stringify(line)}`); continue; }
    if (!STARTS.some((re) => re.test(line))) p.push(`a line the CLI does not begin: ${JSON.stringify(line)}`);
  }
  if (nexts > 1) p.push(`${nexts} Next: headings`);
  if (failures > 1) p.push(`${failures} failures`);
  return p;
}

/** The terminal a run is given (`mason(…, { terminal: 80 })`): a preload that makes its stdout and stderr say they are
 *  a terminal that wide, as a terminal's would, so the CLI draws for one; colour off, so what is seen is the text. The
 *  file is the seam, as tests/cli-matrix.ts containerMemoryEnv's: nothing in src/ reads a test's variable. */
function terminalEnv(width: number): Record<string, string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-terminal-"));
  made.push(dir);
  const hook = path.join(dir, "terminal.mjs");
  fs.writeFileSync(hook, `for (const s of [process.stdout, process.stderr]) {
  Object.defineProperty(s, "isTTY", { value: true, configurable: true });
  Object.defineProperty(s, "columns", { value: ${width}, configurable: true });
}
`);
  return { NODE_OPTIONS: `--import=${pathToFileURL(hook).href}`, NO_COLOR: "1" };
}

/**
 * One run, held at once to carrying no secret on either stream, and to the service's values never shaping it: a
 * failure's code is one of FAILURE_CODES and exits as it says; no --json string holds a line break and every next step
 * is the CLI's; and every line a person sees is one the CLI began (`seenProblems`) — at `terminal` columns for a run on
 * a terminal, the logical lines of a pipe otherwise.
 */
export async function mason(h: string, argv: string[], env: Record<string, string>, o: { timeoutMs?: number; terminal?: number } = {}): Promise<Answer> {
  const a = await runMason(h, argv, o.terminal ? { ...env, ...terminalEnv(o.terminal) } : env, o.timeoutMs ?? 60_000);
  ANSWERS.push(a);
  const line = `mason ${argv.join(" ")}${o.terminal ? ` (a terminal ${o.terminal} wide)` : ""}`;
  const json = argv.includes("--json");
  if (json && a.code !== 0) {
    const e = (JSON.parse(a.stdout) as { error?: { code?: string } }).error;
    assert.ok(e?.code !== undefined && Object.hasOwn(FAILURE_CODES, e.code), `${line}: code ${e?.code} is not one of FAILURE_CODES`);
    assert.equal(a.code, exitOf({ message: "", code: e.code }), `${line}: exit ${a.code}, where ${e.code} exits ${exitOf({ message: "", code: e.code })}`);
  }
  for (const [stream, text] of json ? [["stderr", a.stderr]] as const : [["stdout", a.stdout], ["stderr", a.stderr]] as const) {
    const p = seenProblems(text, o.terminal ?? null);
    assert.deepEqual(p, [], `${line}: what a person sees of its ${stream}:\n${text}`);
  }
  if (json) {
    const walk = (v: unknown, at: string): void => {
      if (typeof v === "string") assert.doesNotMatch(v, /[\n\r\u0085\u2028\u2029]/, `${line} --json ${at} holds a line break: ${JSON.stringify(v)}`);
      else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
      else if (typeof v === "object" && v !== null) for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`);
    };
    walk(JSON.parse(a.stdout), "");
    for (const n of (JSON.parse(a.stdout) as { next: Array<{ command: string }> }).next) assert.match(`  ${n.command}`, OWN_STEP, `${line} --json: a step the CLI does not give`);
  }
  for (const s of SECRETS) {
    assert.ok(!a.stdout.includes(s) && !a.stderr.includes(s), `${line} printed a secret:\n${a.stdout}\n${a.stderr}`);
    assert.ok(!a.stdout.includes(s.slice(-43)) && !a.stderr.includes(s.slice(-43)), `${line} printed a secret's body`);
  }
  return a;
}

/** The last test of a file: no token reached any run's output, and the file ran each of `ran` (a command, and whether
 *  it succeeded), so the check covered what it says. */
export function noTokenLeaked(ran: ReadonlyArray<readonly [cmd: string, ok: boolean]>): void {
  for (const [cmd, ok] of ran) assert.ok(ANSWERS.some((a) => a.argv[0] === cmd && (a.code === 0) === ok), `the file ran mason ${cmd}, ${ok ? "succeeding" : "failing"}`);
  assert.ok(SECRETS.length >= 3);
  const leaks = ANSWERS.flatMap((a) => SECRETS.filter((s) => (a.stdout + a.stderr).includes(s.slice(-43))).map(() => `mason ${a.argv.join(" ")}`));
  assert.deepEqual(leaks, []);
}

export const credentials = (h: string): string => path.join(h, ".config", "mason", "credentials.json");
export const mode = (p: string): string => (fs.statSync(p).mode & 0o777).toString(8);
export const saved = (h: string): { version: number; logins: Record<string, { token: string; email: string; savedAt: string }> } => JSON.parse(fs.readFileSync(credentials(h), "utf8"));
/** A credentials file written as a login would leave it. */
export function writeSaved(h: string, logins: Record<string, { token: string; email: string; savedAt: string }>): void {
  fs.mkdirSync(path.dirname(credentials(h)), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(credentials(h)), 0o700);
  fs.writeFileSync(credentials(h), JSON.stringify({ version: 1, logins }), { mode: 0o600 });
}
