/**
 * HOW A TABLE IS KEPT CURRENT AFTER ITS FIRST COPY: the sources file's `sync:` (GitHub issue 33), at the top of the
 * file as every table's default and on an entry for that table alone. ONE grammar, read by the one reader of the file
 * (src/cli/sources.ts `parseSourceText`) and by `mason add --sync` (src/cli/commands.ts), so a value is taken or refused
 * in the same words at both entrances:
 *
 *   off               nothing after the first copy until `mason sync <table>`, which polls it once, now (the default)
 *   poll <interval>   the xmin poll every <interval>: <n>s, <n>m or <n>h, a whole number, at least 1s
 *
 * `replication` is a word of the grammar but not of this release: logical replication is still the project's
 * (`mason start --replication`), and the value is refused with that way out. The engine never decides how a table is
 * kept current by its size: the row count matters only to `mason add`, which writes `sync: off` for a table over
 * `BIG_TABLE_ROWS` when the file's default polls (src/cli/source-edit.ts).
 */
import { closest } from "./did-you-mean.ts";

/** a table's sync as the sources file says it: `off`, or polled every `seconds` (`every` as written: `30s`, `5m`, `1h`) */
export type TableSync = { mode: "off" } | { mode: "poll"; every: string; seconds: number };

/** the sync a table has when neither its entry nor the file says one: `off` (issue 33: Mason reads each table once,
 *  then only what you tell it to) */
export const DEFAULT_SYNC: TableSync = { mode: "off" };

/** the shortest interval a poll takes: below a second a full scan of the table on the source is the source's whole time */
export const MIN_POLL_SECONDS = 1;

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
export const SYNC_FORMS = `off, or poll <interval> (${EXAMPLES})`;

/** the value as the file writes it: `off`, `poll 30s` */
export function syncText(s: TableSync): string {
  return s.mode === "off" ? "off" : `poll ${s.every}`;
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
  const written = `${m[1]}${unit}`;
  if (!Number.isInteger(n)) return { problem: `${v}: an interval is a whole number — write poll ${intervalOf(seconds)}` };
  if (seconds < MIN_POLL_SECONDS) return { problem: `${v} is under the shortest interval, ${MIN_POLL_SECONDS}s: write poll ${MIN_POLL_SECONDS}s or longer` };
  if (written !== v) return { problem: `${JSON.stringify(v)}: write poll ${written}` };
  return { every: written, seconds };
}

/**
 * A `sync:` VALUE READ, or what is wrong with it in the words a person fixes it from (the key is the caller's to say):
 * the line to write, a `did you mean` for a misspelt mode, the floor for a short interval, and for `replication` that
 * it is not in this release yet and what keeps every table current meanwhile.
 */
export function parseSync(v: unknown): TableSync | { problem: string } {
  if (typeof v !== "string" || v.trim() === "") {
    const read = v === null || v === undefined ? "nothing" : typeof v === "boolean" ? `the boolean ${String(v)}` : typeof v === "number" ? `the number ${String(v)}` : "a list or a map";
    return { problem: `is ${read}: write ${SYNC_FORMS}` };
  }
  const words = v.trim().split(/\s+/);
  const mode = words[0]!, rest = words.slice(1).join(" ");
  if (mode === "off") return rest === "" ? { mode: "off" } : { problem: `off takes no interval: write off, or poll ${rest}` };
  if (mode === "replication") {
    return { problem: "replication is not in this release yet: mason start --replication keeps every table current (write off or poll <interval> here)" };
  }
  if (mode === "poll") {
    if (rest === "") return { problem: `poll needs its interval: write ${EXAMPLES} (at least ${MIN_POLL_SECONDS}s)` };
    const i = parseInterval(rest);
    return "problem" in i ? i : { mode: "poll", ...i };
  }
  // a misspelt mode: the line it may have meant, its interval kept when it reads as one
  const near = closest(mode, MODES);
  const meant = near === "poll" && rest !== "" && !("problem" in parseInterval(rest)) ? `poll ${rest}` : near;
  return { problem: `${mode} is not a sync${meant !== null ? ` — did you mean \`${meant}\`?` : ""}: write ${SYNC_FORMS}` };
}

/** a sync for a person: `off`, `polled every 30s` */
export function syncWords(s: TableSync): string {
  return s.mode === "off" ? "off" : `polled every ${s.every}`;
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
 * `MASON_POLL_MS` SET IS REFUSED, never run on a default (CLAUDE.md: a renamed setting refuses the start, naming the
 * line to write): how often a table is polled is the sources file's `sync:`, per table. Null when it is unset.
 */
export function pollMsRetired(env: Readonly<Record<string, string | undefined>>): string | null {
  const v = env.MASON_POLL_MS;
  if (v === undefined || v === "") return null;
  const ms = Number(v);
  const line = `sync: poll ${Number.isFinite(ms) && ms >= MIN_POLL_SECONDS * 1000 ? intervalOf(ms / 1000) : "5s"}`;
  return `MASON_POLL_MS=${v} is no longer read: how often each table is polled is the sources file's sync: — write ${line} at its top ` +
    "(every table) or on a table's entry, then unset MASON_POLL_MS";
}
