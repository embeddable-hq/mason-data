/**
 * THE WEB PAGE'S OWN ERRORS (`POST /api/ui/error`, issue 923): when the page (src/web/app.js `reportErrors`) meets an
 * uncaught error or an unhandled rejection of its own, it tells the run WHERE it happened — `{ view, file, line, column,
 * name }` — and the run records a `ui_error` event (src/duck/events.ts), a failure: `mason logs --events`,
 * `/api/events?failed=1`, `mason status`'s recent errors, and `mason_ui_errors_total` on `/metrics`.
 *
 * NEVER THE ERROR'S WORDS: its message and its stack can quote text from the page, and that text can be synced data. So
 * the page sends neither, a body that carries a `message` or a `stack` is refused by name, and the event's message is
 * written HERE, from the validated fields alone (`uiErrorMessage`).
 *
 * ALL OF IT IS UNTRUSTED (CLAUDE.md "Security"): the route is behind the run's guard as every `/api/` route is
 * (src/cli/security.ts: the cookie or the token, the Host, the Origin of a change), and still every field is checked
 * here — a closed set of keys, each of its type and bounded, `view` one of the page's own views (src/web/routes.js),
 * `file` one of the page's own scripts (PAGE_ROUTES), never a URL — and anything else is refused (fail closed). A page
 * throwing in a loop cannot flood the events: at most UI_ERRORS_PER_MINUTE are recorded a minute for the whole run (the
 * rest are refused with 429 and only counted), and a repeat word for word is one event (src/duck/events.ts REPEAT_MS).
 */
import type { Failure } from "./command.ts";
import type { SyncEventInput } from "../duck/events.ts";
import { UNKNOWN_CODE } from "../lib/failure-facts.ts";

/** The largest body the route reads, bytes: five short fields fit many times over. */
export const UI_ERROR_BODY_MAX = 1024;
/** How many of the page's errors the run records in any minute, all pages and tabs together; the rest are counted only. */
export const UI_ERRORS_PER_MINUTE = 10;
/** The longest `file` and `name` taken, characters. */
const FILE_MAX = 128;
const NAME_MAX = 64;
/** The largest line or column taken: a script of the page is far shorter. */
const POSITION_MAX = 10_000_000;

/** The keys a report carries: these five, every one present (null where the page could not tell). */
export const UI_ERROR_FIELDS = ["view", "file", "line", "column", "name"] as const;

/** One report of the page, validated: what the event is written from. */
export interface UiErrorReport {
  /** the view the page showed (`overview`, `observability/queries`, `host`): src/web/routes.js */
  view: string;
  /** the page's own script it happened in, as its route names it without the leading slash (`app.js`,
   *  `pages/status.js`), or null when it was not one of the page's scripts or the browser did not say */
  file: string | null;
  line: number | null;
  column: number | null;
  /** the error's class (`TypeError`), or null when what was thrown was not an error */
  name: string | null;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * A REPORT'S BODY, VALIDATED, or the Failure that refuses it. `views`: the page's views (src/web/routes.js); `scripts`:
 * the page's own scripts, as routes (`/app.js`).
 */
export function uiErrorReport(body: unknown, views: ReadonlySet<string>, scripts: ReadonlySet<string>): UiErrorReport | Failure {
  const refused = (message: string, fix = `send { ${UI_ERROR_FIELDS.join(", ")} }: the web page's own report`): Failure => ({ message, code: "usage", fix });
  if (body === null || typeof body !== "object" || Array.isArray(body)) return refused("a report of the web page's error is a JSON object");
  const o = body as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (k === "message" || k === "stack") {
      return refused(`a report of the web page's error never carries its ${k}: it can quote the page's text, which can be synced data`,
        `send only { ${UI_ERROR_FIELDS.join(", ")} }`);
    }
    if (!(UI_ERROR_FIELDS as readonly string[]).includes(k)) return refused(`a report of the web page's error has no field ${JSON.stringify(k.slice(0, 40))}`);
  }
  for (const k of UI_ERROR_FIELDS) if (!(k in o)) return refused(`a report of the web page's error needs its ${k} (null where the page could not tell, but the view)`);
  const { view, file, line, column, name } = o;
  if (typeof view !== "string" || !views.has(view)) return refused("view is not one of the web page's views");
  if (file !== null && (typeof file !== "string" || file.length > FILE_MAX || !scripts.has(`/${file}`) || !/\.m?js$/.test(file))) {
    return refused("file is not one of the web page's own scripts (its path under the page, such as app.js), or null");
  }
  const position = (v: unknown): v is number | null => v === null || (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= POSITION_MAX);
  if (!position(line)) return refused(`line is a whole number, 0 to ${POSITION_MAX}, or null`);
  if (!position(column)) return refused(`column is a whole number, 0 to ${POSITION_MAX}, or null`);
  if (name !== null && (typeof name !== "string" || name.length > NAME_MAX || !IDENTIFIER.test(name))) {
    return refused(`name is the error's class, a name of at most ${NAME_MAX} letters, digits, _ or $ (such as TypeError), or null`);
  }
  return { view, file: file as string | null, line, column, name: name as string | null };
}

/** The event's message, written from the validated fields alone: never a word the page sent beyond them. */
export function uiErrorMessage(r: UiErrorReport): string {
  const what = r.name === null ? "an error" : `${/^[AEIOU]/.test(r.name) ? "an" : "a"} ${r.name}`;
  const where = r.file === null ? "" : ` in ${r.file}${r.line === null ? "" : ` at line ${r.line}${r.column === null ? "" : `, column ${r.column}`}`}`;
  return `the web page hit ${what} on its ${r.view} view${where}\n` +
    "The error's own words stay in the browser, in its console: the page never sends them, since they can quote synced data.";
}

/** The event's code and origin (src/duck/events.ts, issue 924), from the validated fields alone: its code the error's
 *  class (`TypeError`), else `unknown`; its origin the page's own script and line as Mason's source names it (the page
 *  is served from src/web/, so `app.js` at line 12 is `src/web/app.js:12`), else null. */
export function uiErrorFacts(r: UiErrorReport): { code: string; origin: string | null } {
  return { code: r.name ?? UNKNOWN_CODE, origin: r.file === null || r.line === null ? null : `src/web/${r.file}:${r.line}` };
}

/**
 * THE RUN'S RECORD OF THE PAGE'S ERRORS: each valid report counted (`total`, what `/metrics` says), and recorded as a
 * `ui_error` event unless UI_ERRORS_PER_MINUTE were recorded in the minute before it.
 */
export class UiErrors {
  /** the valid reports since the process started, recorded or not */
  total = 0;
  private readonly recorded: number[] = [];
  private readonly record: (e: SyncEventInput) => void;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private droppedSaid = -Infinity;

  constructor(record: (e: SyncEventInput) => void, log: (line: string) => void, now: () => number = Date.now) {
    this.record = record; this.log = log; this.now = now;
  }

  /** One valid report: true when recorded, false when over the minute's limit (counted only). */
  take(r: UiErrorReport): boolean {
    this.total++;
    const now = this.now();
    while (this.recorded.length > 0 && now - this.recorded[0]! >= 60_000) this.recorded.shift();
    if (this.recorded.length >= UI_ERRORS_PER_MINUTE) {
      // said at most once a minute, with no word of the report but its class: the log is read by people too
      if (now - this.droppedSaid >= 60_000) {
        this.droppedSaid = now;
        this.log(`web page: more than ${UI_ERRORS_PER_MINUTE} errors of the page in a minute; the rest of this minute's are counted (mason_ui_errors_total), not recorded`);
      }
      return false;
    }
    this.recorded.push(now);
    this.record({ kind: "ui_error", table: null, message: uiErrorMessage(r), ...uiErrorFacts(r) });
    return true;
  }
}
