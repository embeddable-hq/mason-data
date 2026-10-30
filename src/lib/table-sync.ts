/**
 * HOW A TABLE IS KEPT CURRENT AFTER ITS FIRST COPY: the sources file's `sync:` (GitHub issue 33), at the top of the
 * file as every table's default and on an entry for that table alone. ONE grammar, read by the one reader of the file
 * (src/cli/sources.ts `parseSourceText`) and by `mason add --sync` (src/cli/commands.ts), so a value is taken or refused
 * in the same words at both entrances:
 *
 *   off               nothing after the first copy until `mason sync <table>`, which polls it once, now (the default)
 *   poll <interval>   the xmin poll every <interval>: <n>s, <n>m or <n>h, a whole number, at least 1s, at most 24h
 *   replication       the database's change log, through the project's ONE slot and publication (src/duck/stream.ts):
 *                     the publication carries the replicated tables only, and the polled ones are polled beside it
 *
 * The engine never decides how a table is kept current by its size: the row count matters only to `mason add`, which
 * writes `sync: off` for a table over `BIG_TABLE_ROWS` when the file's default polls (src/cli/source-edit.ts).
 */
import { closest } from "./did-you-mean.ts";

/** a table's sync as the sources file says it: `off`, polled every `seconds` (`every` as written: `30s`, `5m`, `1h`), or
 *  streamed from the change log (`replication`) */
export type TableSync = { mode: "off" } | { mode: "poll"; every: string; seconds: number } | { mode: "replication" };
/** a sync the poll keeps: `off` or `poll <interval>` (a `replication` table is the stream's) */
export type PolledSync = Exclude<TableSync, { mode: "replication" }>;

/** the sync a table has when neither its entry nor the file says one: `off` (issue 33: Mason reads each table once,
 *  then only what you tell it to) */
export const DEFAULT_SYNC: TableSync = { mode: "off" };


/** the shortest interval a poll takes: below a second a full scan of the table on the source is the source's whole time */
export const MIN_POLL_SECONDS = 1;
/** the longest: a day. Longer is `off` with `mason sync <table>` from a scheduler (and an instant past a Date's range,
 *  a review finding: `poll 9999999999999s` broke every status line) */
export const MAX_POLL_SECONDS = 86_400;

/**
 * A TABLE THIS BIG IS NOT POLLED UNLESS ITS ENTRY SAYS SO (it was the run's POLL_ROW_LIMIT, which left such a table
 * copied and never polled, a rule found only by its effect): a poll scans its table whole on the source (no index covers
 * xmin) and counts it, and on a test server a 22 M-row table cost the production replica 12 s of scan and 2 s of count
 * at every poll. So `mason add` of a table the catalog estimates over this many rows, under a file whose default polls,
 * writes `sync: off` on its entry and says so with the alternatives. The stream applies a batch that changes a table
 * this big by time as well (src/duck/stream.ts `applySize`): each write by key is a scan of its key column.
 */
export const BIG_TABLE_ROWS = 1_000_000;

/** above this many rows a poll under `COSTLY_POLL_SECONDS` is warned of at `mason add`, with an estimate of its cost */
export const COSTLY_POLL_ROWS = 10_000_000;
export const COSTLY_POLL_SECONDS = 60;

const MODES = ["off", "poll", "replication"] as const;
const UNIT_SECONDS = { s: 1, m: 60, h: 3600 } as const;
/** the units a person may write for one of ours, said back as the one to write */
const UNIT_WORDS: Record<string, keyof typeof UNIT_SECONDS> = {
  s: "s", sec: "s", secs: "s", second: "s", seconds: "s", m: "m", min: "m", mins: "m", minute: "m", minutes: "m",
  h: "h", hr: "h", hrs: "h", hour: "h", hours: "h",
};
const EXAMPLES = "poll 5s, poll 5m or poll 1h";
/** what a sync is, said where one is wrong */
export const SYNC_FORMS = `off, poll <interval> (${EXAMPLES}) or replication`;

/** the value as the file writes it: `off`, `poll 30s` */
export function syncText(s: TableSync): string {
  return s.mode === "poll" ? `poll ${s.every}` : s.mode;
}

/** a span of seconds as an interval is written, in the largest unit it is a whole number of: 90 is `90s`, 120 `2m` */
export function intervalOf(seconds: number): string {
  const s = Math.max(MIN_POLL_SECONDS, Math.round(seconds));
  return s % 3600 === 0 ? `${s / 3600}h` : s % 60 === 0 ? `${s / 60}m` : `${s}s`;
}

/** an interval (`<n>s|m|h`) read, or why it is not one, with the interval to write when there is one */
function parseInterval(v: string): { every: string; seconds: number } | { problem: string } {
  const m = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/i.exec(v);
  const how = `an interval is <n>s, <n>m or <n>h, a whole number, at least ${MIN_POLL_SECONDS}s (${EXAMPLES})`;
  if (m === null) return { problem: `${JSON.stringify(v)} is not an interval: ${how}` };
  const n = Number(m[1]), word = m[2]!.toLowerCase();
  if (word === "ms") return { problem: `${v} is under the shortest interval, ${MIN_POLL_SECONDS}s (a poll scans the table whole on your database): write poll ${MIN_POLL_SECONDS}s or longer` };
  const unit = UNIT_WORDS[word];
  if (unit === undefined) {
    const days = /^(d|day|days)$/.test(word) ? `: write poll ${intervalOf(n * 86_400)}` : "";
    return { problem: `${v}: ${word} is not a unit of an interval — ${days ? `days are hours${days}` : how}` };
  }
  const seconds = n * UNIT_SECONDS[unit];
  if (!Number.isInteger(n)) return { problem: `${v}: an interval is a whole number — write poll ${intervalOf(seconds)}` };
  if (seconds < MIN_POLL_SECONDS) return { problem: `${v} is under the shortest interval, ${MIN_POLL_SECONDS}s: write poll ${MIN_POLL_SECONDS}s or longer` };
  if (seconds > MAX_POLL_SECONDS) return { problem: `${v} is over the longest interval, ${intervalOf(MAX_POLL_SECONDS)}: write poll ${intervalOf(MAX_POLL_SECONDS)}, or off with mason sync <table> run by a scheduler` };
  // the number as a number is written (`05s` is `5s`): two spellings of one interval would read as a change of sync
  const canonical = `${n}${unit}`;
  if (canonical !== v) return { problem: `${JSON.stringify(v)}: write poll ${canonical}` };
  return { every: canonical, seconds };
}

/**
 * A `sync:` VALUE READ, or what is wrong with it in the words a person fixes it from (the key is the caller's to say):
 * the line to write, a `did you mean` for a misspelt mode, the floor for a short interval. Whether a table CAN be
 * replicated (a primary key, a replica identity) is the catalog's, said at the entry (src/cli/sources.ts entryProblems).
 */
export function parseSync(v: unknown): TableSync | { problem: string } {
  if (typeof v !== "string" || v.trim() === "") {
    const read = v === null || v === undefined ? "nothing" : typeof v === "boolean" ? `the boolean ${String(v)}` : typeof v === "number" ? `the number ${String(v)}` : "a list or a map";
    return { problem: `is ${read}: write ${SYNC_FORMS}` };
  }
  const words = v.trim().split(/\s+/);
  const mode = words[0]!, rest = words.slice(1).join(" ");
  if (mode === "off") return rest === "" ? { mode: "off" } : { problem: `off takes no interval: write off, or poll ${rest}` };
  if (mode === "replication") return rest === "" ? { mode: "replication" } : { problem: `replication takes no interval: write replication, or poll ${rest}` };
  if (mode === "poll") {
    if (rest === "") return { problem: `poll needs its interval: write ${EXAMPLES} (at least ${MIN_POLL_SECONDS}s)` };
    const i = parseInterval(rest);
    return "problem" in i ? i : { mode: "poll", ...i };
  }
  // a misspelt mode: the line it may have meant, its interval kept when it reads as one
  const near = closest(mode, MODES);
  const meant = near === "poll" && rest !== "" && !("problem" in parseInterval(rest)) ? `poll ${rest}` : near;
  // a question ends its sentence: "did you mean `poll 5s`? Write off, …"
  return { problem: meant !== null ? `${mode} is not a sync — did you mean \`${meant}\`? Write ${SYNC_FORMS}` : `${mode} is not a sync: write ${SYNC_FORMS}` };
}

/** a sync for a person: `off`, `polled every 30s`, `replicated` */
export function syncWords(s: TableSync): string {
  return s.mode === "off" ? "off" : s.mode === "replication" ? "replicated" : `polled every ${s.every}`;
}

/** how long ago an instant was, as a status line reads: `4 s ago`, `12 min ago`, `5 h ago`, `3 days ago` */
export function agoText(iso: string, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 90) return `${s} s ago`;
  if (s < 90 * 60) return `${Math.round(s / 60)} min ago`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86_400);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/**
 * THE TOP OF THE SOURCES FILE that a retired setting's way out edits (the review of PR 48: every file `mason init`
 * writes already has a `sync:` line at its top, so "write sync: replication at the top" made it two, a file the run
 * refuses): the file as a person names it, and the values its top-level `sync:` and `publication:` lines hold as
 * written — null where it has no such line, or there is no file (src/cli/sources.ts `sourcesTop` reads it).
 */
export interface SourcesTop { shown: string; sync: string | null; publication: string | null }

/**
 * THE EDIT THAT MAKES THE TOP'S `key:` SAY ONE OF `values`, in words a person (or an agent) applies as written: change
 * the line the file has, keep one that already says it, or write it when the file has none. `anyPoll`: any
 * `poll <interval>` already written is kept (for "poll it", whatever the interval).
 */
export function topEdit(top: SourcesTop, key: "sync" | "publication", values: readonly string[], anyPoll = false): string {
  const now = top[key] === null ? null : top[key]!.trim().replace(/\s+/g, " ");
  const said = (v: string): boolean => now !== null && (now === v || (anyPoll && v.startsWith("poll ") && now.startsWith("poll ")));
  const kept = values.find(said);
  if (kept !== undefined && now !== null) return `keep ${key}: ${now} at the top of ${top.shown}`;
  const to = values.map((v) => `${key}: ${v}`).join(" or ");
  return now === null ? `write ${to} at the top of ${top.shown}` : `change ${key}: ${now} at the top of ${top.shown} to ${to}`;
}

/**
 * `MASON_POLL_MS` SET IS REFUSED, never run on a default (CLAUDE.md: a renamed setting refuses the start, naming the
 * line to write): how often a table is polled is the sources file's `sync:`, per table. Null when it is unset; else what
 * is wrong, why and the way out — a Failure's fields for `mason start` (before it spawns, and the run itself), joined on
 * one line of `mason serve`'s settings report (`pollMsRetiredText`). `top` is read only when it is set.
 */
export function pollMsRetired(env: Readonly<Record<string, string | undefined>>, top: () => SourcesTop): { message: string; why: string; fix: string } | null {
  const v = env.MASON_POLL_MS;
  if (v === undefined || v === "") return null;
  const ms = Number(v);
  const every = `poll ${Number.isFinite(ms) && ms >= MIN_POLL_SECONDS * 1000 ? intervalOf(Math.min(ms / 1000, MAX_POLL_SECONDS)) : "5s"}`;
  return { message: `MASON_POLL_MS=${v} is no longer read`, why: "how often each table is polled is its sync: in the sources file",
    fix: `${topEdit(top(), "sync", [every])} (every table; a table's entry may say its own), then unset MASON_POLL_MS` };
}

/** the same, as one line */
export function pollMsRetiredText(env: Readonly<Record<string, string | undefined>>, top: () => SourcesTop): string | null {
  const r = pollMsRetired(env, top);
  return r === null ? null : `${r.message}: ${r.why} — ${r.fix}`;
}

/** what every retired way of choosing a whole project's changes is told: where it is said now, so what runs is what is
 *  committed — how each table is kept current (`sync`), the publication replication reads (`publication`), or both */
function saidInTheFile(what: { sync: boolean; publication: boolean }): string {
  const said = [...(what.sync ? ["how each table is kept current is its sync: in the sources file (at the top for every table, on an entry for that one)"] : []),
    ...(what.publication ? [`the publication replication reads is ${what.sync ? "its" : "the sources file's"} publication:`] : [])];
  return `${said.join(", and ")}, so what runs is what is committed`;
}

/**
 * `mason start --replication`, `--poll` AND `--publication <name>` ARE GONE (issue 33, PR 3; no backwards compatibility
 * before v1.0): each answers, without starting, with the edit to make at the top of the sources file (`top`, read only
 * when a removed flag is given) — its `sync:` line to `replication` or `poll 5m`, its `publication:` to the name —
 * every one given on ONE report, one coherent way out (a publication goes with replication). Null when none is given.
 * Read from the raw command line, before the options are parsed, so a removed flag is answered as removed and never
 * as an unknown option.
 */
export function removedStartFlags(argv: readonly string[], top: () => SourcesTop): { message: string; why: string; fix: string } | null {
  let replication = false, poll = false, publication: string | null | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") break;
    if (a === "--replication" || a.startsWith("--replication=")) replication = true;
    else if (a === "--poll" || a.startsWith("--poll=")) poll = true;
    else if (a.startsWith("--publication=")) publication = a.slice("--publication=".length) || null;
    else if (a === "--publication") { const v = argv[i + 1]; publication = v !== undefined && !v.startsWith("-") ? v : null; }
  }
  const given = [...(replication ? ["--replication"] : []), ...(poll ? ["--poll"] : []), ...(publication !== undefined ? ["--publication"] : [])];
  if (given.length === 0) return null;
  const t = top();
  const named = given.length === 1 ? `${given[0]} is gone` : `${given.slice(0, -1).join(", ")} and ${given.at(-1)} are gone`;
  const pub = publication === undefined ? null : topEdit(t, "publication", [publication ?? "<name>"]);
  let fix: string;
  if (replication) {
    // every table from the change log (or polled, when --poll said that too), and the publication beside it
    const sync = topEdit(t, "sync", poll ? ["replication", "poll 5m"] : ["replication"]);
    // two lines to write at the same top are one instruction: "write sync: replication and publication: app_pub at the top of …"
    const at = ` at the top of ${t.shown}`;
    const both = pub !== null && !poll && sync.startsWith("write ") && pub.startsWith("write ") && sync.endsWith(at) && pub.endsWith(at);
    fix = both ? `${sync.slice(0, -at.length)} and ${pub.slice("write ".length)}`
      : `${sync}${poll ? " (or each table's own on its entry)" : ""}${pub ? `, and ${pub}` : ""}`;
  } else if (pub !== null) {
    // a publication is read only by replication: it names the tables that are replicated, the others are polled or off
    fix = `${poll ? "a publication goes with replication: " : ""}${pub}, with sync: replication on the entries of the tables it carries` +
      `${poll ? " and sync: poll 5m (any interval) on the others" : ""}`;
  } else {
    const edit = topEdit(t, "sync", ["poll 5m"], true);
    fix = `${edit} (${edit.startsWith("keep ") ? "every table is polled already; a table's entry may say its own"
      : "any interval: poll 5s, poll 1h; or sync: off, the default, and mason sync <table> when you need it"})`;
  }
  return { message: `${named}: the sources file says it now`, why: saidInTheFile({ sync: replication || poll, publication: publication !== undefined }),
    fix: `${fix}, then mason start` };
}

/**
 * `MASON_CHANGES` SET IS REFUSED, never run on a default (CLAUDE.md: a removed setting refuses the start, naming the
 * edit to make): how each table is kept current is the sources file's `sync:` (`top`, read only when it is set). Null
 * when it is unset; else a Failure's fields, joined on one line of `mason serve`'s settings report
 * (`changesRetiredText`).
 */
export function changesRetired(env: Readonly<Record<string, string | undefined>>, top: () => SourcesTop): { message: string; why: string; fix: string } | null {
  const v = env.MASON_CHANGES;
  if (v === undefined || v === "") return null;
  const edit = v === "replication" ? topEdit(top(), "sync", ["replication"]) : v === "poll" ? topEdit(top(), "sync", ["poll 5m"], true)
    : topEdit(top(), "sync", ["replication", "poll 5m"]);
  return { message: `MASON_CHANGES=${v} is no longer read`, why: saidInTheFile({ sync: true, publication: false }),
    fix: `${edit} (every table; a table's entry may say its own), then unset MASON_CHANGES` };
}

/** the same, as one line */
export function changesRetiredText(env: Readonly<Record<string, string | undefined>>, top: () => SourcesTop): string | null {
  const r = changesRetired(env, top);
  return r === null ? null : `${r.message}: ${r.why} — ${r.fix}`;
}

/**
 * A DURATION IN MILLISECONDS as a person reads it, the one formatter of a statement's, a sync's or a percentile's time
 * (the web page's `msText`, src/web/shared.js, held equal by the tests): `512 ms` under a second, then `13.7 s`, then
 * `2 min 5 s`, then `1 h 4 min` (a 13,703 ms statement read as thirteen thousand of something).
 */
export function msText(ms: number): string {
  const v = Math.max(0, ms);
  if (Math.round(v) < 1000) return `${Math.round(v)} ms`;
  const tenths = Math.round(v / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)} s`;
  const s = Math.round(v / 1000);
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
  const m = Math.round(s / 60);
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

/**
 * WHAT A SYNC DID TO ONE TABLE, in the words `mason sync` prints on its line and the web page's Sync now says
 * (src/cli/sync.ts `syncedReport`, src/web/pages/tables.js, held equal) — and a sync by hand records as its `synced`
 * event (src/duck/sync.ts pollNow), so the event and the answer the person read are one sentence.
 */
export function syncedText(t: { changed: number; deleted: number; rows: number; ms: number }): string {
  const n = (x: number): string => x.toLocaleString("en-US");
  return `${n(t.changed)} changed, ${n(t.deleted)} deleted, ${n(t.rows)} rows now · ${msText(t.ms)}`;
}
