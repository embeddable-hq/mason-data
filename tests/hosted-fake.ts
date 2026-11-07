/**
 * A FAKE HOSTED SERVICE AND THE RUNS AGAINST IT, for tests/cli-login.test.ts, tests/cli-login-service.test.ts,
 * tests/cli-login-terminal.test.ts and tests/cli-user-hosted.test.ts: an http server of the test's own on 127.0.0.1 (no
 * network; a `/v1/` request other than `/v1/me` answered by the script's `v1`), the real CLI as a child process pointed
 * at it, and `mason`,
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
import { createHash, randomBytes } from "node:crypto";
import { domainToASCII, domainToUnicode, fileURLToPath, pathToFileURL } from "node:url";
import { matrixEnv, runMason, type Answer } from "./cli-matrix.ts";
import { exitOf, FAILURE_CODES, type FailureCode } from "../src/cli/command.ts";

export const MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "main.ts");

/** A token as the service documents them: a prefix, then 43 base64url characters. */
export const newToken = (kind: "pat" | "ci" = "pat"): string => `masondata_${kind}_${randomBytes(32).toString("base64url")}`;

/** A token's body: the value after its documented prefix. */
export const bodyOf = (token: string): string => token.replace(/^masondata_(pat|ci)_/, "");

/**
 * THE TOKEN AN ECHO TEST SENDS: one fixed body, so the verdict of `bodyShown` on what a run printed is the same on every
 * run (a random one shared a run of 4 with the CLI's own words now and then: the review of PR 591, F1); each echo test
 * holds it to sharing none with its command's output when nothing is echoed (`bodyCovered` 0). Written in two parts, so
 * no line of this file is shaped as a token.
 */
const ECHO_BODY = "Qz7Vw2Xk9Pj4Ry8Tm3Lq6Hb1Ns5Gc0Fd-Ue_YoZi7Ka";
export const echoToken = (kind: "pat" | "ci" = "pat"): string => `masondata_${kind}_${ECHO_BODY}`;

/**
 * A TOKEN WHOSE BODY HOLDS A RUN EVERY GRAMMAR TAKES (issue 627): 11 lower case letters (an OAuth error's grammar), 11
 * digits (a time's fraction), then base64url of every kind; `n` picks one of two, so a command can hold two at once.
 * Fixed, so a run's verdict is the same at every run; written in parts, so no line of this file is shaped as a token.
 */
export const RUNS = [{ letters: "qzvwxkpjrtm", digits: "40718293651", rest: "Hb1Ns5Gc0Fd-Ue_YoZi7K" }, { letters: "hgfmwyqcbnx", digits: "93850261749", rest: "Lk2Pq7Rs-Tu_Vw8Xy3Za4" }] as const;
export const runToken = (kind: "pat" | "ci", n: 0 | 1 = 0): string => ["masondata", kind, `${RUNS[n].letters}${RUNS[n].digits}${RUNS[n].rest}`].join("_");
/** The forms a test gives a value of a hosted command's answer (issue 627): the token whole, its body, its body in lower
 *  case, and 11 of its characters in a row — its letters, or its digits for a value only digits fit. */
export const runForms = (token: string, n: 0 | 1 = 0): Array<{ what: string; value: string; digits: string }> => {
  const body = bodyOf(token);
  return [{ what: "the token whole", value: token, digits: token }, { what: "its body", value: body, digits: body },
    { what: "its body in lower case", value: body.toLowerCase(), digits: body.toLowerCase() }, { what: "11 of its characters in a row", value: RUNS[n].letters, digits: RUNS[n].digits }];
};
/** Whether `text` shows 11 of a token's body in a row, in any case, as it is or read past every character that is not a
 *  letter or a digit (pieces split by `/`, `.` or a space): what a refused answer must print none of. */
export const showsRun = (text: string, token: string): boolean => {
  for (const view of [(s: string) => s.toLowerCase(), (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "")]) {
    const t = view(text), b = view(bodyOf(token));
    for (let i = 0; i + 11 <= b.length; i++) if (t.includes(b.slice(i, i + 11))) return true;
  }
  return false;
};

/** Host labels whose IDNA form, as the URL parser prints a host, is `xn--` and 11 of a body lower-cased in a row: the
 *  Unicode label reads as no body character, its printed form as the run (PR 645's review). */
export function punyLabels(body: string, most: number): string[] {
  const runs = body.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 11);
  const labels: string[] = [];
  for (const w of runs) for (let i = 0; i + 11 <= w.length && labels.length < most; i++) {
    for (const prefix of ["", "a", "ab", "z", "zz"]) {
      const ascii = `xn--${prefix}${w.slice(i, i + 11)}`, u = domainToUnicode(ascii);
      if (u && u !== ascii && !/[a-z0-9]/i.test(u) && domainToASCII(u) === ascii) { labels.push(u); break; }
    }
  }
  return labels;
}

/**
 * THE OUTPUT GATE'S FALSE-REFUSAL RATE ON HONEST OUTPUT, measured (PR 645's class round): each text as a command wrote
 * it (a stream, and the two together), read once as the gate reads it, against `tokens` random tokens from a fixed
 * seed (`passwords` false for a command that prints the password it made). How many the gate refuses at `ECHO_RUN` (none may be), and at a run of `short` (chance meets it, within the
 * bound src/cli/hosted.ts derives: W × 43 × 2 × 31^-n for W characters read), so the measurement can see the model.
 */
export async function measureGate(texts: readonly string[], seed: string, tokens: number, o: { short?: number; passwords?: boolean } = {}): Promise<{ refused: number; shortRefused: number; shortBound: number; bound: number }> {
  const { readingsOf, readingsCarry } = await import("../src/cli/output-gate.ts");
  const { ECHO_RUN } = await import("../src/cli/hosted.ts");
  const short = o.short ?? 5, passwords = o.passwords ?? true;
  const reads = texts.map((t) => readingsOf(t));
  const chars = reads.reduce((n, r) => n + r.reads.reduce((m, x) => m + x.length, 0), 0);
  let counter = 0, pool = Buffer.alloc(0);
  const bytes = (n: number): Buffer => {
    while (pool.length < n) pool = Buffer.concat([pool, createHash("sha256").update(`${seed}:${counter++}`).digest()]);
    const out = pool.subarray(0, n); pool = pool.subarray(n); return out;
  };
  let refused = 0, shortRefused = 0;
  for (let i = 0; i < tokens; i++) {
    const token = `masondata_ci_${bytes(32).toString("base64url")}`;
    if (reads.some((r) => readingsCarry(r, [token], { passwords }))) refused++;
    if (reads.some((r) => readingsCarry(r, [token], { run: short, passwords }))) shortRefused++;
  }
  const bound = (n: number): number => chars * 43 * 2 * 31 ** -n;
  return { refused, shortRefused, shortBound: Math.ceil(bound(short) * tokens), bound: bound(ECHO_RUN) };
}

/**
 * The forms a service may echo a token it was sent in, besides the token whole (issue 540; the review of PR 591): each
 * by what it is, the text each of a failure's message, why and fix carries, and whether the words printed are exact
 * (else a mask may take in a letter beside it that is the body's next, by chance, or one field is shown).
 */
export function echoForms(token: string): Array<{ what: string; fields: [string, string, string]; exact: boolean }> {
  const body = bodyOf(token);
  const pieces = (n: number): string[] => body.match(new RegExp(`.{1,${n}}`, "g"))!;
  const each = (what: string, form: string, exact = true) => ({ what, fields: [form, form, form] as [string, string, string], exact });
  return [
    each("its body", body),
    each("its body split by spaces", pieces(4).join(" ")),
    each("its body in upper case", body.toUpperCase()),
    each("its body in lower case, split by dashes", body.toLowerCase().match(/.{1,5}/g)!.join("-")),
    each("its body URL-encoded", [...body].map((c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`).join("")),
    each("a 12-character slice of its body", body.slice(9, 21), false),
    each("its body 11 characters at a time, a letter between", pieces(11).join(" x "), false),
    each("its body 4 characters at a time, a colour code between", pieces(4).join("\u001b[31m"), false),
    { what: "8 characters of its body in each of message, why and fix", fields: [body.slice(0, 8), body.slice(8, 16), body.slice(16, 24)], exact: false },
  ];
}

/**
 * How many of a token's body characters `text` shows, in every run of 4 or more of them together (the rule
 * src/cli/hosted.ts `heldRuns` keeps, decided here apart from it: by brute force over every common substring). The
 * text is read case-blind, every percent escape decoded, every character as its compatibility decomposition without
 * its combining marks, and every separator skipped — once keeping `-` and `_` and once skipping them too. `known` are
 * the parts of a run's output that differ from run to run and are not the service's (its folders, the service's
 * address and port), read as a separator, so a count over all a command printed is the same on every run.
 */
export function bodyCovered(text: string, token: string, known: ReadonlyArray<string | undefined> = []): number {
  for (const k of [...known].filter((x): x is string => !!x).sort((a, b) => b.length - a.length)) text = text.split(k).join(" ");
  const read = [...text.replace(/%([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))).normalize("NFKD")]
    .filter((c) => !/\p{M}/u.test(c)).join("").toLowerCase();
  const raw = bodyOf(token).toLowerCase(), covered = new Set<number>();
  for (const kept of [/[a-z0-9_-]/, /[a-z0-9]/]) {
    const seen = [...read].filter((c) => kept.test(c)).join("");
    const at = [...raw].map((c, i) => [c, i] as const).filter(([c]) => kept.test(c)), body = at.map(([c]) => c).join("");
    const least = Math.min(4, body.length);
    for (let i = 0; i < body.length; i++) {
      for (let n = least; i + n <= body.length && seen.includes(body.slice(i, i + n)); n++) for (let d = 0; d < n; d++) covered.add(at[i + d]![1]);
    }
  }
  return covered.size;
}

/** Whether `text` shows more than a quarter of a token's body (`bodyCovered`): what a command may show in all, so it is
 *  run over all a command printed, its streams together. */
export function bodyShown(text: string, token: string, known: ReadonlyArray<string | undefined> = []): boolean {
  return bodyCovered(text, token, known) > Math.floor([...bodyOf(token)].filter((c) => /[A-Za-z0-9_-]/.test(c)).length / 4);
}

/** Every secret any run may have seen, and every answer: the last test holds them apart. */
export const SECRETS: string[] = [];
export const ANSWERS: Answer[] = [];
const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

export interface Req { at: number; method: string; path: string; search: string; headers: http.IncomingHttpHeaders; form: Record<string, string>; body: string }
/** `json`: a JSON body as text (one too deep for JSON.stringify to write); `raw`: a body that is not JSON. */
export type Reply = { status: number; body?: unknown; raw?: string; json?: string; headers?: Record<string, string> } | "drop";
export interface Script {
  device?: Reply;
  /** the n-th poll's answer (0-based) */
  token?: (n: number) => Reply;
  me?: Reply;
  revoke?: Reply;
  /** any other request (a replica's endpoints): its answer, else 404 */
  v1?: (r: Req) => Reply | Promise<Reply>;
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
    req.on("end", async () => {
      const u = new URL(req.url ?? "/", "http://x"), p = u.pathname;
      const r: Req = { at: Date.now(), method: req.method ?? "", path: p, search: u.search, headers: req.headers, form: Object.fromEntries(new URLSearchParams(body)), body };
      requests.push(r);
      const reply: Reply = p === "/oauth/device/code" ? script.device ?? { status: 200, body: DEVICE }
        : p === "/oauth/token" ? (script.token ?? (() => pending))(polls++)
        : p === "/v1/me" ? script.me ?? { status: 200, body: ME }
        : p === "/oauth/revoke" ? script.revoke ?? { status: 200, body: {} }
        : script.v1 ? await script.v1(r)
        : { status: 404, body: { error: { code: "not_found", message: "no such endpoint" }, next: [] } };
      if (reply === "drop") { req.socket.destroy(); return; }
      res.writeHead(reply.status, { "content-type": reply.raw === undefined ? "application/json" : "text/html", ...reply.headers });
      res.end(reply.raw ?? (reply.json ?? (reply.body === undefined ? "" : JSON.stringify(reply.body))).replaceAll(BASE, `http://127.0.0.1:${port}`));
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
 * THE LINES THE CLI BEGINS, all of them: a line that begins otherwise is not the CLI's (a service's text took a line's
 * start). Each is the start of a line the CLI writes; on a terminal too narrow for one, the CLI breaks it at a space
 * (src/cli/command.ts strictLines), so a line may also be a WORD-PREFIX of one ("Signed in", "  mason", "✗ mason").
 * Besides these: a blank, the one `Next:`, and a continuation, indented 4 or more (command.ts CONTINUATION).
 */
const HEADS: readonly string[] = [
  "Signed in to ", "Signed out of ", "This machine is not signed in to ", "To sign in to ",
  "Waiting for the code to be approved ", "Waiting for approval", "Waiting", "Approved", "✔ Approved", "✓ Approved",
  "✘ Waiting", "✗ Waiting", "✘ mason login: ", "✗ mason login: ", "✘ mason logout: ", "✗ mason logout: ",
  "Tip: This replaces the login of ", "Tip: The login was NOT revoked ", "Tip: MASON_TOKEN is set ", "Tip: Could not open a browser ",
  ...["name", "orgs", "saved", "account", "revoked", "removed from", "file", "page", "code", "why", "fix"].map((l) => `  ${l} `),
];
/** The steps under Next:, the CLI's own (OWN_STEP), as the start of their line. */
const STEP_HEADS: readonly string[] = ["  mason login", "  mason logout", "  env -u MASON_TOKEN mason login", "  unset MASON_CLOUD_URL", "  chmod 600 ", "  chmod 700 "];

/** Whether `line` is begun as one of `heads` begins (or is a word-prefix of one: the rest broken onto its continuations). */
const begunAs = (line: string, heads: readonly string[]): boolean => heads.some((h) => {
  if (line.startsWith(h)) return h.endsWith(" ") || line.length === h.length || /^\s/.test(line.slice(h.length));
  const l = line.trimEnd();
  return l.trim() !== "" && h.startsWith(l) && (h.length === l.length || h[l.length] === " ");
});

/** Columns as the CLI counts them for a line that holds a service's text: a character outside ASCII as two. */
const cols = (ch: string): number => ch.codePointAt(0)! <= 0x7e ? 1 : 2;

/**
 * WHAT A PERSON SEES of a stream on a terminal `width` columns wide: each line as the terminal last drew it (a spinner's
 * `\r` redraws keep their last), its cursor and colour codes gone, and a line longer than the width broken by the
 * terminal at the width, each piece a line of its own. Without a width, the logical lines (a pipe).
 */
export function seen(text: string, width: number | null, unbroken?: (line: string) => boolean): Array<{ line: string; byTerminal: boolean }> {
  const out: Array<{ line: string; byTerminal: boolean }> = [];
  for (const logical of text.split("\n")) {
    const drawn = logical.split("\r").pop()!.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    // a value to copy, which the CLI writes alone and never breaks (`Lines.unbroken`): the terminal's soft wrap, which a
    // copy joins, is its line's, and is read as one
    if (width === null || unbroken?.(drawn) === true) { out.push({ line: drawn, byTerminal: false }); continue; }
    let line = "", w = 0, piece = 0;
    for (const ch of drawn) {
      if (w + cols(ch) > width) { out.push({ line, byTerminal: piece++ > 0 }); line = ""; w = 0; }
      line += ch; w += cols(ch);
    }
    out.push({ line, byTerminal: piece > 0 });
  }
  return out;
}

/** What is wrong with what a person sees of one stream, as sentences: a line the CLI did not begin, a second Next:,
 *  a failure where there is none or a second, a step under Next: that is not the CLI's, a line the terminal broke.
 *  `failed`: the run failed and this is its stderr, which then holds exactly one failure. */
/** The lines a command begins, for a command other than login and logout (`mason(…, { lines })`): its heads, the steps
 *  under its Next:, and a test of a line of its own data (a list's row, begun by a name the test gave). */
export interface Lines { heads: readonly string[]; steps: readonly string[]; ownStep: RegExp; row?: (line: string) => boolean;
  /** a logical line the CLI writes alone, to be copied, which only the terminal may wrap (the CI token mason token create
   *  prints: held to a grammar with no space, colon or control, so no piece of it can begin a line of the CLI's) */
  unbroken?: (line: string) => boolean }

export function seenProblems(text: string, width: number | null, failed: boolean | null = null, lines?: Lines): string[] {
  // every hosted command that names a replica says on stderr when MASON_REPLICA chose it (src/cli/replica.ts envChoseText;
  // these tests name acme/shop)
  const heads = [...(lines?.heads ?? HEADS), "using MASON_REPLICA=acme/shop "], steps = lines?.steps ?? STEP_HEADS;
  const p: string[] = [];
  let afterNext = false, nexts = 0, failures = 0;
  for (const { line, byTerminal } of seen(text, width, lines?.unbroken)) {
    if (byTerminal) p.push(`the terminal broke a line, so a line begins where a value chose: ${JSON.stringify(line)}`);
    if (line === "") continue;
    if (line === "Next:") { nexts++; afterNext = true; continue; }
    if (/^ {4,}\S/.test(line)) continue;
    if (/^[✘✗] mason/.test(line)) failures++;
    if (afterNext && /^ {2}\S/.test(line)) { if (!begunAs(line, steps)) p.push(`a step the CLI does not give: ${JSON.stringify(line)}`); continue; }
    if (!begunAs(line, heads) && !(lines?.row?.(line) ?? false)) p.push(`a line the CLI does not begin: ${JSON.stringify(line)}`);
  }
  if (nexts > 1) p.push(`${nexts} Next: headings`);
  if (failed !== null && failures !== (failed ? 1 : 0)) p.push(`${failures} failures, where the run ${failed ? "failed once" : "did not fail"}`);
  else if (failures > 1) p.push(`${failures} failures`);
  return p;
}

/** The terminal a run is given (`mason(…, { terminal: 80 })`): a preload that makes its stdout and stderr say they are
 *  a terminal that wide, as a terminal's would, so the CLI draws for one; colour off, so what is seen is the text. The
 *  file is the seam, as tests/cli-matrix.ts containerMemoryEnv's: nothing in src/ reads a test's variable. */
function terminalEnv(width: number, stdin = false): Record<string, string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-terminal-"));
  made.push(dir);
  const hook = path.join(dir, "terminal.mjs");
  // a person at it (`stdin`): its stdin says it is the terminal too, and what they type is the run's `stdin`
  fs.writeFileSync(hook, `${stdin ? `Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });\n` : ""}for (const s of [process.stdout, process.stderr]) {
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
export async function mason(h: string, argv: string[], env: Record<string, string>, o: { timeoutMs?: number; terminal?: number; lines?: Lines; stdin?: string; prompt?: string } = {}): Promise<Answer> {
  // a `prompt` is a person typing `stdin` at the terminal: its stdin says it is the terminal too
  const a = await runMason(h, argv, o.terminal ? { ...env, ...terminalEnv(o.terminal, o.prompt !== undefined) } : env, o.timeoutMs ?? 60_000, undefined, o.stdin);
  ANSWERS.push(a);
  // what a person sees at a terminal they type at: the terminal echoes the line typed after the run's `prompt`
  const echoed = (text: string): string => {
    const at = o.prompt === undefined || o.stdin === undefined || !o.terminal ? -1 : text.indexOf(o.prompt);
    const line = o.stdin?.split("\n")[0] ?? "";
    return at < 0 ? text : `${text.slice(0, at + o.prompt!.length)}${line}${o.stdin!.includes("\n") ? "\n" : ""}${text.slice(at + o.prompt!.length)}`;
  };
  const line = `mason ${argv.join(" ")}${o.terminal ? ` (a terminal ${o.terminal} wide)` : ""}`;
  const json = argv.includes("--json");
  if (json && a.code !== 0) {
    const e = (JSON.parse(a.stdout) as { error?: { code?: string } }).error;
    assert.ok(e?.code !== undefined && Object.hasOwn(FAILURE_CODES, e.code), `${line}: code ${e?.code} is not one of FAILURE_CODES`);
    assert.equal(a.code, exitOf({ message: "", code: e.code as FailureCode }), `${line}: exit ${a.code}, where ${e.code} exits ${exitOf({ message: "", code: e.code as FailureCode })}`);
  }
  for (const [stream, text] of json ? [["stderr", echoed(a.stderr)]] as const : [["stdout", a.stdout], ["stderr", echoed(a.stderr)]] as const) {
    const p = seenProblems(text, o.terminal ?? null, stream === "stderr" && !json ? a.code !== 0 : null, o.lines);
    assert.deepEqual(p, [], `${line}: what a person sees of its ${stream}:\n${text}`);
  }
  if (json) {
    const walk = (v: unknown, at: string): void => {
      if (typeof v === "string") assert.doesNotMatch(v, /[\n\r\u0085\u2028\u2029]/, `${line} --json ${at} holds a line break: ${JSON.stringify(v)}`);
      else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
      else if (typeof v === "object" && v !== null) for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`);
    };
    walk(JSON.parse(a.stdout), "");
    for (const n of (JSON.parse(a.stdout) as { next: Array<{ command: string }> }).next) assert.match(`  ${n.command}`, o.lines?.ownStep ?? OWN_STEP, `${line} --json: a step the CLI does not give`);
  }
  for (const s of SECRETS) {
    assert.ok(!a.stdout.includes(s) && !a.stderr.includes(s), `${line} printed a secret:\n${a.stdout}\n${a.stderr}`);
    assert.ok(!a.stdout.includes(s.slice(-43)) && !a.stderr.includes(s.slice(-43)), `${line} printed a secret's body`);
    assert.ok(!bodyShown(`${a.stdout}\n${a.stderr}`, s, [h, env.HOME, env.MASON_CLOUD_URL]), `${line} printed more than a quarter of a secret's body, in some form:\n${a.stdout}\n${a.stderr}`);
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

/**
 * EVERY FORM A SERVICE MAY ECHO A PASSWORD IN (PR 660's class round, R2-B1), each by what it is: what a test holds every
 * boundary to. Each is read by a person, or a terminal, or a log, as the password: its case, its `%XX` escapes, each
 * Unicode normal form, its accents dropped, its full-width letters, a zero-width or control character or a terminal
 * escape between its characters, its white space another. What no reading reaches (a homoglyph, base64, a reversal)
 * is out of this list, and said in docs/HOSTED-API.md.
 */
export const ECHO_FORMS: ReadonlyArray<readonly [what: string, form: (p: string) => string]> = [
  ["as written", (p) => p],
  ["upper case", (p) => p.toUpperCase()],
  ["lower case", (p) => p.toLowerCase()],
  ["URL-encoded", (p) => encodeURIComponent(p)],
  ["every byte %XX", (p) => [...new TextEncoder().encode(p)].map((b) => `%${b.toString(16).padStart(2, "0").toUpperCase()}`).join("")],
  ["NFC", (p) => p.normalize("NFC")],
  ["NFD", (p) => p.normalize("NFD")],
  ["NFKC", (p) => p.normalize("NFKC")],
  ["NFKD", (p) => p.normalize("NFKD")],
  ["NFD, every byte %XX", (p) => [...new TextEncoder().encode(p.normalize("NFD"))].map((b) => `%${b.toString(16).padStart(2, "0")}`).join("")],
  ["its accents dropped", (p) => p.normalize("NFD").replace(/\p{M}/gu, "")],
  ["full-width", (p) => [...p].map((c) => /[!-~]/.test(c) ? String.fromCodePoint(c.codePointAt(0)! + 0xfee0) : c).join("")],
  ["a zero-width mark between its characters", (p) => [...p].join("​")],
  ["a control character between its characters", (p) => [...p].join("\u0007")],
  ["a terminal escape between its characters", (p) => [...p].join("\u001b[1m")],
  ["its spaces no-break spaces", (p) => p.replace(/ /g, " ")],
];

/**
 * WHAT A PERSON READS OF A TEXT, as this test reads it (its own reading, apart from src/'s): terminal escapes, controls
 * and format characters gone, `%XX` runs decoded, every compatibility form decomposed, marks gone, case folded, white
 * space one space. A password is printed whole when what a person reads of the output holds what a person reads of it.
 */
export function personReads(text: string): string {
  let t = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g, "");
  t = t.replace(/(?:%[0-9a-f]{2})+/gi, (run) => { try { return decodeURIComponent(run); } catch { return run; } });
  t = t.normalize("NFKD").replace(/[\p{M}\p{Cf}]/gu, "").toUpperCase().toLowerCase().normalize("NFKD").replace(/[\p{M}\p{Cf}]/gu, "");
  return t.replace(/[^\S\n]| /g, " ").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/ +/g, " ");
}
/** Whether a person reads `password` whole in `text` (`personReads`). */
export const printsWhole = (text: string, password: string): boolean => personReads(text).includes(personReads(password).trim());
