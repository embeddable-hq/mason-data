/**
 * `mason upgrade --check`: BEFORE AN UPGRADE, WHICH SYNCED TABLES THE NEW RELEASE'S FIRST START READS AGAIN WHOLE (issue
 * 1069). Run with the command of the release a person upgrades to (`npx @mason-data/cli@<version> upgrade --check`),
 * while the Mason they run now is up. The running Mason cannot know what a later release checks, so the answer is this
 * release's: it asks the run what its synced data holds (`/api/state?storage=1`, `Sync.storedFacts`) and applies its
 * own checks to those facts through src/duck/reread.ts, the module its own start calls. It changes nothing.
 *
 * The facts are the run's answer, so they are held to their shape before anything reads them (`storedFactsOf`): a
 * shape this release does not read is said, never guessed at.
 */
import { failed, jsonText, parseCommand, reportText, synopsis, type CommandSpec, type Failure, type NextStep } from "./command.ts";
import { out as styleOut } from "./style.ts";
import { callRun } from "./control.ts";
import { reach } from "./state.ts";
import { bytesText, guarded, runFailure } from "./commands.ts";
import { version } from "./version.ts";
import { readAgain, type ReadAgain, type StoredFacts, type StoredTable } from "../duck/reread.ts";
import type { SourceColumnInfo } from "./preflight.ts";

const out = (m: string): void => { process.stdout.write(`${m}\n`); };

/** the release before the one that publishes what the synced data holds: a running Mason of this release or earlier
 *  cannot be checked */
export const UNCHECKED_THROUGH = "0.22.0";

export const UPGRADE_USAGE = `usage: mason upgrade --check [--json]

  Says, before you upgrade, which synced tables a newer release of Mason would read again whole from your database at
  its first start, and why. Run the command of the release you are upgrading to, in the project's folder, while the
  Mason you run now is up (npx @mason-data/cli@<version> upgrade --check). It changes nothing.

    mason upgrade --check
    mason upgrade --check --json

  --check   say which tables would be read again (mason upgrade changes nothing by itself)
  --json    as data: its shape is at the end

  It asks the running Mason what its synced data holds, and applies this release's own checks to it. They are the
  checks its first start makes. For each table it says why, how large it is, and whether the table keeps serving its
  synced data until its new sync is done. A whole read scans the table on your database once.

  It works only when the Mason running now is a release after ${UNCHECKED_THROUGH}. An older one does not say what its
  synced data holds, and the check says so: read the release notes instead, under "Before you upgrade". A command
  older than the Mason running refuses too. A release that reads something new about a column from your database can
  read more tables again than the check sees. Its release notes say so.

  The --json answer: { from (the running Mason's version), to (this command's), tables: [{ table, why (layout,
  columns, watermark or missing), reason, layout (for why layout), rows, bytes (the table's size on your database when
  it was synced), serves (it keeps serving its synced data until its new sync is done), held (held now for its
  columns: read again once that is fixed, not at the first start) }], next }
`;

export const UPGRADE: CommandSpec & { needs: "run" } = {
  needs: "run",
  name: "upgrade",
  summary: "before you upgrade, which synced tables the newer Mason reads again whole: run its mason upgrade --check",
  usage: UPGRADE_USAGE,
  options: { check: { type: "boolean" }, json: { type: "boolean" } },
  json: ["from", "to", "tables", "next"],
};

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const count = (x: unknown): x is number | null => x === null || (typeof x === "number" && Number.isFinite(x) && x >= 0);

/** a column as a record or the catalog says it: its name and type at least, the rest as the run sent it */
function columnOf(x: unknown): SourceColumnInfo | null {
  if (!isObject(x) || typeof x.name !== "string" || typeof x.type !== "string") return null;
  if (x.typeKind !== undefined && typeof x.typeKind !== "string") return null;
  if (x.domain !== undefined && x.domain !== true) return null;
  return x as unknown as SourceColumnInfo;
}

function columnsOf(x: unknown): SourceColumnInfo[] | null {
  if (!Array.isArray(x)) return null;
  const out = x.map(columnOf);
  return out.every((c) => c !== null) ? out as SourceColumnInfo[] : null;
}

function tableOf(x: unknown): StoredTable | null {
  if (!isObject(x) || typeof x.source !== "string" || typeof x.phase !== "string" || !count(x.rows) || !count(x.bytes) ||
    typeof x.watermark !== "boolean" || typeof x.present !== "boolean" || typeof x.keyed !== "boolean") return null;
  const record = x.record === null ? null : columnsOf(x.record);
  if (x.record !== null && record === null) return null;
  let stored: Array<[string, string]> | null = null;
  if (x.stored !== null) {
    if (!Array.isArray(x.stored) || !x.stored.every((c) => Array.isArray(c) && c.length === 2 && typeof c[0] === "string" && typeof c[1] === "string")) return null;
    stored = x.stored as Array<[string, string]>;
  }
  return { source: x.source, phase: x.phase, record, rows: x.rows, bytes: x.bytes, watermark: x.watermark, present: x.present, keyed: x.keyed, stored };
}

/** The run's `storage`, held to the shape this release reads: the facts, or null for any other shape. */
export function storedFactsOf(x: unknown): StoredFacts | null {
  if (!isObject(x) || x.format !== 1 || !Array.isArray(x.tables) || !Array.isArray(x.added) || !Array.isArray(x.held) || !x.held.every((h) => typeof h === "string")) return null;
  const tables = x.tables.map(tableOf);
  if (!tables.every((t) => t !== null)) return null;
  const added: StoredFacts["added"] = [];
  for (const a of x.added) {
    const columns = isObject(a) && typeof a.table === "string" ? columnsOf(a.columns) : null;
    if (columns === null) return null;
    added.push({ table: (a as { table: string }).table, columns });
  }
  return { format: 1, tables: tables as StoredTable[], added, held: x.held as string[] };
}

/** `x.y.z` as numbers, or null for any other version (`dev`, `main-<sha>`) */
const release = (v: string): [number, number, number] | null => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
};

/** -1, 0 or 1 as `a` is older than, the same as or newer than `b`; null where either is not a release */
export function compareReleases(a: string, b: string): number | null {
  const x = release(a), y = release(b);
  if (x === null || y === null) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return 0;
}

/** a name or a reason as a person reads it: a character that prints as nothing (a byte-order mark, a zero-width space,
 *  a direction mark) written as its escape, so a column whose name starts with one is seen to */
const visible = (s: string): string => s.replace(/[\u00AD\u200B-\u200F\u2028-\u202E\u2060-\u2064\uFEFF]/g, (c) => `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`);

/** a table's size as a person reads it: its rows, and its size on the database when it was synced */
function sizeText(t: ReadAgain): string {
  const parts = [...(t.rows === null ? [] : [`${t.rows.toLocaleString("en-US")} row${t.rows === 1 ? "" : "s"}`]),
    ...(t.bytes === null ? [] : [`${bytesText(t.bytes)} on your database`])];
  return parts.length > 0 ? parts.join(", ") : "size not known";
}

const NEXT: readonly NextStep[] = [["mason status", "each synced table, and how it is kept current"],
  ["mason wait", "after the upgrade: waits until every table is synced"]];

/** What the check says: the headline, a line per table, and the tips. */
export function checkReport(from: string, to: string, tables: readonly ReadAgain[]): { headline: string; details: Array<readonly [string, string]>; tips: string[] } {
  const n = tables.length;
  const headline = n === 0
    ? `Upgrading from Mason ${from} to ${to} reads no synced table again whole.`
    : `Upgrading from Mason ${from} to ${to} reads ${n === 1 ? "1 synced table" : `${n} synced tables`} again whole from your database, once, at the first start.`;
  const details = tables.map((t) => [visible(t.table), `${sizeText(t)} · ${visible(t.reason)} · ${t.serves ? "serves its synced data until then" : "not served until its new sync is done"}` +
    `${t.held ? " · held now for its columns (mason status says why): read again once that is fixed" : ""}`] as const);
  const tips = [
    ...(n > 0 ? ["Each whole read scans its table on your database. Plan for it before you upgrade."] : []),
    ...(compareReleases(from, to) === 0 ? [`This command is the same release as the Mason running now. Run the newer release's command: npx @mason-data/cli@<version> upgrade --check`] : []),
  ];
  return { headline, details, tips };
}

export async function upgrade(argv: string[]): Promise<number> {
  const f = parseCommand(UPGRADE, argv);
  if (typeof f === "number") return f;
  const json = f.values.json === true;
  if (f.positionals.length > 0) {
    return failed("upgrade", { message: `it takes no argument (${f.positionals.join(" ")}): a project is its folder`, code: "usage",
      fix: "run it in the project's folder: cd <folder> && mason upgrade --check, or mason -C <folder> upgrade --check", usage: synopsis(UPGRADE),
      next: [["mason upgrade --help", "its usage, with every option"]] }, { json });
  }
  if (f.values.check !== true) {
    return failed("upgrade", { message: "mason upgrade changes nothing by itself: run it with --check", code: "usage",
      fix: "npx @mason-data/cli@<version> upgrade --check says which tables that release would read again", usage: UPGRADE_USAGE,
      next: [["mason upgrade --check", "which synced tables this release would read again whole"]] }, { json });
  }
  const w = await reach(UPGRADE, json);
  if (w === null || !("run" in w)) return 1;
  const run = w.run;
  const to = version();
  return guarded("upgrade", json, async () => {
    const r = await callRun(run, "GET", "/api/state?storage=1");
    if (r.status !== 200) return failed("upgrade", runFailure(r, [...NEXT]), { json });
    const engine = r.body.engine as { version?: unknown } | undefined;
    const from = typeof engine?.version === "string" ? engine.version : "unknown";
    if (compareReleases(to, from) === -1) {
      return failed("upgrade", { message: `this command is Mason ${to}, older than the Mason running now (${from}), so it cannot say what a newer release reads again`, code: "refused",
        fix: "run the command of the release you are upgrading to: npx @mason-data/cli@<version> upgrade --check", next: [...NEXT] }, { json });
    }
    if (r.body.storage === undefined) {
      return failed("upgrade", { message: `the Mason running now (${from}) does not say what its synced data holds, so this cannot tell which tables ${to} would read again`, code: "failed",
        why: `a Mason says it from the release after ${UNCHECKED_THROUGH} on`,
        fix: `read the release notes of every release after ${from}, up to ${to}: each one's "Before you upgrade" says which tables it reads again`, next: [...NEXT] }, { json });
    }
    const facts = storedFactsOf(r.body.storage);
    if (facts === null) {
      const failure: Failure = { message: `the Mason running now (${from}) says what its synced data holds in a form Mason ${to} does not read`, code: "failed",
        fix: `read the release notes of every release after ${from}, up to ${to}: each one's "Before you upgrade" says which tables it reads again`, next: [...NEXT] };
      return failed("upgrade", failure, { json });
    }
    const tables = readAgain(facts);
    if (json) { out(jsonText(UPGRADE, { from, to, tables }, NEXT)); return 0; }
    out(reportText({ ...checkReport(from, to, tables), next: NEXT }, styleOut()));
    return 0;
  });
}
