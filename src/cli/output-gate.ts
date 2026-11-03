/**
 * THE OUTPUT'S GATE: every byte a hosted command writes, on stdout and on stderr, put to the exact test at the point it
 * is written (PR 645's class round: what was tested was not what was printed — a page tested whole and printed cut
 * inside a `%XX` escape, a name tested with a lone surrogate read as a separator and printed by --json as `\udc00`, a
 * page tested as it came and printed as the URL parser rewrote it). The per-value tests of src/cli/hosted.ts stay the
 * first line (`carriesNoSecret`, `pageUrl`, `serviceText`); this is the last, and the authority: the bytes written.
 *
 * WHAT IS READ: each stream's text as written, after every transformation the CLI makes — styling (colour, the CLI's
 * own line breaks: src/cli/command.ts serviceStyle), `JSON.stringify`'s escapes, a value's cut, the masks, the
 * spinner's redraws — and the two streams together (a log that takes `2>&1`). Each is read in eight ways: with its
 * terminal escapes and without them (what a log keeps; what a person sees), keeping `-` and `_` or not, and a `%XX`
 * escape decoded or read as the characters it is written with — each as src/cli/hosted.ts reads a value (`bodyRead`:
 * re-cased, in its compatibility form, every other character skipped). A run that crosses two writes is read whole:
 * each reading keeps the last `ECHO_RUN - 1` characters it read, and a raw tail is kept for the shapes.
 *
 * WHAT FIRES IT: `ECHO_RUN` of a held secret's body in a row in any reading, or anything shaped as a documented token
 * or (unless the command prints a password it made: `mason user add --replica`) a Mason user's password. Then the
 * write that would complete it is NOT written, nor anything after it: the command's refusal is written instead, in the
 * CLI's words (on stdout under --json, as its one object), and the process exits 1 (`gatedExit`). What was written
 * before showed at most `ECHO_RUN - 1` in a row.
 *
 * HONEST OUTPUT IS NEVER REFUSED BY CHANCE, by `ECHO_RUN`'s derivation (src/cli/hosted.ts): an honest output is
 * independent of the token, and a command writes a few KiB; read 8 ways and over 3 streams it is under 2^20
 * characters read, and the bound W × 43 × 2 × 31^-11 is under 10^-8. tests/cli-hosted.test.ts measures it with a fixed
 * seed over the honest outputs of deploy, login, logout and mason user --replica.
 *
 * ONE VALUE MAY BE PRINTED ONCE (`holdOutput`'s `once`: the CI token `mason token create` made, the one answer that
 * carries a token by design): its FIRST whole occurrence in a write (`onceAt`: exactly as it is; the CLI writes it on a
 * line of its own, never broken) is read as a separator, never as the secret it is, and is written; every other byte is read as before, the value held among the secrets, so a second
 * occurrence, a piece of it elsewhere (11 of its body in a row) or anything else shaped as a token is refused as any
 * secret is. What it allows is exactly that value, whole, one time, in one write.
 *
 * INERT until a command holds a secret (`holdOutput`): every other command writes as it always did.
 */
import { failed, serviceStyle, type Failure } from "./command.ts";
import { bodyRead, canonicalTexts, ECHO_RUN, echoViews, ESCAPES, shapedSecret, wholeInCanonical } from "./hosted.ts";
import { err as styleErr } from "./style.ts";

/** The eight readings: [with escapes, without] × [keeping `-` and `_`, not] × [a `%XX` decoded, not]. */
const READINGS = [true, false].flatMap((escapes) => [true, false].flatMap((keep) => [true, false].map((percent) => ({ escapes, keep, percent }))));
const TAIL = ECHO_RUN - 1;
/** The raw tail kept for the shapes and the secrets read whole: longer than any shape (a token is 56 characters, a
 *  password 55), and than any held secret written `%XX`-encoded (`rawTail`). */
const RAW_TAIL = 80;
const rawTail = (secrets: readonly string[]): number => Math.max(RAW_TAIL, ...secrets.map((x) => 3 * x.length));

/** What a stream has written, as the gate reads it: the last characters of each reading, and of the text. */
export interface Written { reads: string[]; raw: string; /** `raw` in the one reading, made once when it is first asked for */ canonical?: string[] }
export const nothingWritten = (): Written => ({ reads: READINGS.map(() => ""), raw: "" });

/**
 * WHETHER WRITING `text` AFTER `before` WOULD WRITE A SECRET (the gate's test, pure): `ECHO_RUN` of a held secret's body
 * in a row in any reading of the two together, or a shape. The stream as it would stand after it, either way.
 */
export function writes(before: Written, text: string, secrets: readonly string[], o: { passwords?: boolean } = {}): { secret: boolean; after: Written } {
  return writesAfter([before], readingsOf(text), secrets, o)[0]!;
}

/**
 * `fresh` (a text's readings, `readingsOf(text)`) written after each of `befores`: the text is read and scanned once,
 * and only where it meets each stream's tail again (a window of `ECHO_RUN` crossing into it lies within the tail and
 * the text's first `TAIL` characters).
 */
function writesAfter(befores: readonly Written[], fresh: Written, secrets: readonly string[], o: { passwords?: boolean }): Array<{ secret: boolean; after: Written }> {
  const inside = readingsCarry(fresh, secrets, o);
  const tail = rawTail(secrets);
  return befores.map((before) => {
    const meet: Written = { reads: before.reads.map((r, i) => r + fresh.reads[i]!.slice(0, TAIL)), raw: before.raw + fresh.raw.slice(0, tail) };
    const after: Written = { reads: before.reads.map((r, i) => (r + fresh.reads[i]!).slice(-TAIL)), raw: (before.raw + fresh.raw).slice(-tail) };
    return { secret: inside || readingsCarry(meet, secrets, o), after };
  });
}

/** `text`'s readings, after what was written before it (its tails): what `readingsCarry` tests. */
export function readingsOf(text: string, before: Written = nothingWritten()): Written {
  // a text with no escape, or no `%`, reads the same either way: each distinct reading is made once
  const stripped = text.includes("\x1b") ? text.replace(ESCAPES, "") : text, percents = text.includes("%");
  const made = new Map<string, string>();
  const read = (escapes: boolean, keep: boolean, percent: boolean): string => {
    const key = `${escapes && stripped !== text}${keep}${percent && percents}`;
    let r = made.get(key);
    if (r === undefined) { r = bodyRead(escapes ? text : stripped, keep, percent); made.set(key, r); }
    return r;
  };
  return { reads: READINGS.map(({ escapes, keep, percent }, i) => before.reads[i]! + read(escapes, keep, percent)), raw: before.raw + text };
}

/** Whether readings hold a secret: `run` of a held secret's body in a row in any of them, the secret whole, or a shape. */
export function readingsCarry(read: Written, secrets: readonly string[], o: { passwords?: boolean; run?: number } = {}): boolean {
  if (shapedSecret(read.raw, o) || shapedSecret(read.raw.replace(ESCAPES, ""), o)) return true;
  for (const secret of secrets) {
    if (!secret) continue;
    // whole, in the one reading, with its terminal escapes and without them (src/cli/hosted.ts wholeIn)
    read.canonical ??= canonicalTexts(read.raw);
    if (read.canonical.some((t) => wholeInCanonical(t, secret))) return true;
    for (const { keep, n, grams } of echoViews(secret, o.run ?? ECHO_RUN)) {
      if (n === 0) continue;
      // a text with no escape and no `%` reads the same in several ways: each distinct reading is scanned once
      const distinct = new Set(READINGS.flatMap((r, i) => r.keep === keep ? [read.reads[i]!] : []));
      for (const text of distinct) for (let j = 0; j + n <= text.length; j++) if (grams.has(text.slice(j, j + n))) return true;
    }
  }
  return false;
}

/** WHERE `value` IS WRITTEN WHOLE in `text`, exactly as it is (the CLI writes it alone, never broken: src/cli/token-hosted.ts);
 *  null when it is not. The span, from its first character to its last. */
export function onceAt(text: string, value: string): [number, number] | null {
  const i = text.indexOf(value);
  return i < 0 ? null : [i, i + value.length];
}

interface Held { command: string; json: boolean; secrets: string[]; passwords: boolean; once: string | null }
let held: Held | null = null;
let refused = false;
type Write = typeof process.stdout.write;
let originals: { out: Write; err: Write } | null = null;
const state = { out: nothingWritten(), err: nothingWritten(), both: nothingWritten() };

/** The refusal written in place of what the gate held back: the CLI's words alone. */
const REFUSAL: Failure = {
  message: "the service's answer would print a secret this command holds, so nothing more of it is printed",
  code: "refused",
  why: "what was about to be written held a secret this command holds (11 or more characters of a token's body in a row, or the database's password it sent), or something shaped as a token or a password: a hosted service's text is printed only when it carries none",
  fix: "a service that repeats the token it was sent is answering outside its documented API: sign in again (mason login), so this token is replaced, and revoke it in the service's web app if it was shared",
  next: [["mason login", "sign in again"]],
};

/**
 * Hold `secrets` from here on, for `command`, whose answer is `--json` or not; again with more (login's new token)
 * adds them. `passwords` false: this command prints a password it made (its answer's), so a password's shape is no
 * secret in its output. `once`: a secret this command prints one time, whole (above), held as a secret beside it.
 */
export function holdOutput(o: { command: string; json: boolean; secrets: readonly string[]; passwords?: boolean; once?: string }): void {
  const secrets = [...(held?.secrets ?? []), ...o.secrets.filter(Boolean), ...(o.once ? [o.once] : [])];
  held = { command: o.command, json: o.json, secrets, passwords: o.passwords ?? held?.passwords ?? true, once: o.once || (held?.once ?? null) };
}

/** Whether the gate held output back: the process then exits 1, whatever the command returned. */
export const outputRefused = (): boolean => refused;
export const gatedExit = (code: number): number => refused ? 1 : code;

/** The gate, on process.stdout and process.stderr, once, before anything else wraps them (src/cli/main.ts). */
export function installOutputGate(): void {
  if (originals !== null) return;
  originals = { out: process.stdout.write.bind(process.stdout) as Write, err: process.stderr.write.bind(process.stderr) as Write };
  const gate = (which: "out" | "err"): Write => ((chunk: unknown, ...rest: unknown[]): boolean => {
    const original = originals![which];
    const text = typeof chunk === "string" ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk).toString("utf8") : String(chunk);
    const done = rest.find((x): x is () => void => typeof x === "function");
    // nothing to write (exitWhenWritten's flush), or nothing held: as it always was; once refused, nothing more
    if (text === "") return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
    if (refused) { if (done) setImmediate(done); return true; }
    if (held === null) return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
    // the one value printed once, whole, the first time it is written: read as a separator (above)
    const once = held.once === null ? null : onceAt(text, held.once);
    const tested = once === null ? text : `${text.slice(0, once[0])} ${text.slice(once[1])}`;
    const [own, both] = writesAfter([state[which], state.both], readingsOf(tested), held.secrets, { passwords: held.passwords }) as [{ secret: boolean; after: Written }, { secret: boolean; after: Written }];
    if (!own.secret && !both.secret) {
      state[which] = own.after; state.both = both.after;
      if (once !== null) held = { ...held, once: null };
      return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
    }
    refused = true;
    const io = { out: (m: string) => { originals!.out(`${m}\n`); }, err: (m: string) => { originals!.err(`\n${m}\n`); } };
    failed(held.command, REFUSAL, { json: held.json, io, style: serviceStyle(styleErr()) });
    if (done) setImmediate(done);
    return true;
  }) as Write;
  process.stdout.write = gate("out");
  process.stderr.write = gate("err");
}
