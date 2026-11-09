/**
 * WHAT A DEPLOY CHANGES ON A REPLICA (issue 550; docs/HOSTED-API.md "What the deploy changes"): the files sent read
 * beside the files the replica runs now, both by Mason's own readers of a file's text — the sources file
 * (`parseSourceText`), the roles file (`parseRolesText`), mason.yml (`parseProjectText`), the generated tables by file —
 * so the plan is the one reading of each, on this machine and of what the service says the replica runs.
 *
 * The replica's project is the service's answer, untrusted: held to the deploy's own file grammar and bounds, each sha256
 * checked against its content, and every name of it that is printed goes through `serviceText` (one line, bounded,
 * masked), as every value of a service's does. A file of it these readers cannot read makes the plan unknown, said with
 * why: never a plan guessed.
 */
import { createHash } from "node:crypto";
import { MAX_FILE_BYTES, MAX_FILES, MAX_TOTAL_BYTES, PATH_SEGMENT } from "./deploy.ts";
import { serviceText } from "./hosted.ts";
import { effectiveSync, parseSourceText } from "./sources.ts";
import { parseRolesText, ROLES_FILE } from "./roles.ts";
import { GENERATED_DIR } from "./generated-files.ts";
import { PIN_FILE, versionText } from "../lib/project-version.ts";
import { parseProjectText } from "../lib/project-file.ts";
import { syncText } from "../lib/table-sync.ts";
import { bytesText } from "./commands.ts";

/** How many tables' sizes an answer may carry. */
export const MAX_SIZED_TABLES = 10_000;
/** The longest table name an answer may carry. */
export const MAX_TABLE_NAME = 300;

/** A table's size, as the replica counts it: null where it does not know. */
export interface TableSize { table: string; rows: number | null; bytes: number | null }
/** The project a replica runs now, as the service says it: its files (as a deploy sends them) and its tables' sizes. */
export interface ReplicaProject { files: Array<{ path: string; sha256: string; content: string }>; tables: TableSize[] }

export interface Plan {
  tables: { added: TableSize[]; removed: TableSize[]; changed: Array<{ table: string; columns: boolean; key: boolean; sync: { from: string; to: string } | null }> };
  generatedTables: { added: string[]; removed: string[]; changed: string[] };
  roles: { added: string[]; removed: string[]; changed: string[]; default: { from: string | null; to: string | null } | null };
  pin: { from: string | null; to: string | null } | null;
}

const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown): boolean => v === undefined || v === null || (Number.isSafeInteger(v) && (v as number) >= 0);
const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * THE REPLICA'S PROJECT, held: `undefined` when the service says none (absent or null: an older service, or one that
 * cannot ask the replica just now); null when it does not hold (a path outside the grammar, a sha256 that is not its
 * content's, past a bound, a size that is not a count), which makes the plan unknown, never guessed.
 */
export function heldProject(v: unknown): ReplicaProject | null | undefined {
  if (v === undefined || v === null) return undefined;
  if (!obj(v) || !Array.isArray(v.files) || v.files.length > MAX_FILES || !Array.isArray(v.tables) || v.tables.length > MAX_SIZED_TABLES) return null;
  const files: ReplicaProject["files"] = [], paths = new Set<string>();
  let total = 0;
  for (const f of v.files) {
    if (!obj(f) || typeof f.path !== "string" || typeof f.content !== "string" || typeof f.sha256 !== "string") return null;
    if (f.path.length > 255 || !f.path.split("/").every((s) => PATH_SEGMENT.test(s)) || paths.has(f.path)) return null;
    const size = Buffer.byteLength(f.content, "utf8");
    total += size;
    if (size > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES || f.sha256 !== sha(f.content)) return null;
    paths.add(f.path);
    files.push({ path: f.path, sha256: f.sha256, content: f.content });
  }
  const tables: TableSize[] = [];
  for (const t of v.tables) {
    if (!obj(t) || typeof t.table !== "string" || t.table === "" || t.table.length > MAX_TABLE_NAME || !count(t.rows) || !count(t.bytes)) return null;
    tables.push({ table: t.table, rows: typeof t.rows === "number" ? t.rows : null, bytes: typeof t.bytes === "number" ? t.bytes : null });
  }
  return { files, tables };
}

/**
 * THE TABLES A SERVICE'S `unconfirmed_removal` REFUSAL SAYS THE DEPLOY REMOVES (docs/HOSTED-API.md "What the deploy
 * changes"): its `removes`, held — `undefined` when it says none (an older service); `"unknown"` when it says it could
 * not tell; the list, each `{ table, rows, bytes }` once, when it names them; null when it does not hold (an empty
 * list, past a bound, a size that is no count, or a name that is not printable as it came: one line, within
 * `MAX_TABLE_NAME`, nothing `serviceText` would mask or replace). A name is sent back as confirmed exactly as it came,
 * so it must be exactly what a person was shown.
 */
export function heldRemoves(v: unknown, secrets: readonly string[]): TableSize[] | "unknown" | null | undefined {
  if (v === undefined) return undefined;
  if (v === "unknown") return "unknown";
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_SIZED_TABLES) return null;
  const out: TableSize[] = [], seen = new Set<string>();
  for (const t of v) {
    if (!obj(t) || typeof t.table !== "string" || t.table === "" || t.table.length > MAX_TABLE_NAME || seen.has(t.table) || !count(t.rows) || !count(t.bytes)) return null;
    if (serviceText(t.table, MAX_TABLE_NAME, secrets) !== t.table) return null;
    seen.add(t.table);
    out.push({ table: t.table, rows: typeof t.rows === "number" ? t.rows : null, bytes: typeof t.bytes === "number" ? t.bytes : null });
  }
  return out;
}

/** One side of a plan: what a project's files say, as Mason reads them. */
interface Side {
  /** each table the sources file names (`schema.table`), what it syncs of it */
  tables: Map<string, { columns: string; key: string; sync: string }>;
  /** each generated table, by its name, the sha256 of its file */
  generated: Map<string, string>;
  /** each role the roles file names, as it reads; null: no roles file */
  roles: Map<string, string> | null;
  rolesDefault: string | null;
  pin: string | null;
}

/** A role as it reads, its attributes' shapes included, so any change to it is seen. */
const roleText = (r: unknown): string => JSON.stringify(r, (_k, v: unknown) => v instanceof Map ? [...v.entries()] : v);
/** A generated table's name from its file: `daily.yml` is `public.daily`, `billing.daily.yml` `billing.daily`. */
const generatedName = (file: string): string => { const stem = file.replace(/\.ya?ml$/, ""); return stem.includes(".") ? stem : `public.${stem}`; };

/** One side, or why it cannot be read: whatever a reader throws on a file (the service's files are anyone's) is the
 *  file's problem, never a crash of the deploy. */
function sideOf(files: ReadonlyArray<{ path: string; sha256: string; content: string }>, whose: string): Side | { problem: string } {
  try { return readSide(files, whose); }
  catch (e) { return { problem: `${whose} files cannot be read here: ${(e as Error).message.split("\n")[0]}` }; }
}

function readSide(files: ReadonlyArray<{ path: string; sha256: string; content: string }>, whose: string): Side | { problem: string } {
  const cannot = (file: string, problem: string): { problem: string } => ({ problem: `${whose} ${file} cannot be read here: ${problem}` });
  const sources = files.filter((f) => /^sources\/[^/]+\.ya?ml$/.test(f.path));
  if (sources.length > 1) return { problem: `${whose} files hold ${sources.length} sources files, where a project has one` };
  const side: Side = { tables: new Map(), generated: new Map(), roles: null, rolesDefault: null, pin: null };
  const src = sources[0];
  if (src !== undefined) {
    const read = parseSourceText(src.content, src.path.replace(/^sources\/|\.ya?ml$/g, ""), src.path);
    if ("problems" in read) return cannot(src.path, read.problems[0] ?? "it is not a sources file");
    for (const e of read.tables) {
      side.tables.set(e.table, {
        columns: JSON.stringify([e.columns === null ? null : [...e.columns].sort(), [...e.exclude].sort()]),
        key: JSON.stringify(e.key),
        sync: syncText(effectiveSync(read, e).sync),
      });
    }
  }
  for (const f of files) {
    const m = new RegExp(`^${GENERATED_DIR}/([^/]+\\.ya?ml)$`).exec(f.path);
    if (m) side.generated.set(generatedName(m[1]!), f.sha256);
  }
  const roles = files.find((f) => f.path === ROLES_FILE);
  if (roles !== undefined) {
    const read = parseRolesText(roles.content, roles.path);
    if ("problems" in read) return cannot(roles.path, read.problems[0] ?? "it is not a roles file");
    side.roles = new Map(read.roles.map((r) => [r.name, roleText(r)]));
    side.rolesDefault = read.default;
  }
  const pin = files.find((f) => f.path === PIN_FILE);
  if (pin !== undefined) {
    const read = parseProjectText(pin.content, pin.path);
    if ("problem" in read) return { problem: `${whose} ${read.problem}` };
    side.pin = read.pin === null ? null : versionText(read.pin);
  }
  return side;
}

const sorted = (xs: Iterable<string>): string[] => [...xs].sort();
const diff = <T>(was: Map<string, T>, now: Map<string, T>): { added: string[]; removed: string[]; changed: string[] } => ({
  added: sorted([...now.keys()].filter((k) => !was.has(k))),
  removed: sorted([...was.keys()].filter((k) => !now.has(k))),
  changed: sorted([...now.keys()].filter((k) => was.has(k) && was.get(k) !== now.get(k))),
});

/**
 * THE PLAN: what sending `sent` changes on a replica that runs `running` — tables added and removed (each with its size
 * where the replica says it), tables whose columns, key or sync change, generated tables and roles added, removed or
 * changed, the default role and the pin — or why it cannot be told. Every name in it is one line, masked
 * (`serviceText`): what is printed and what is sent back as confirmed are the same words.
 */
export function planOf(sent: ReadonlyArray<{ path: string; sha256: string; content: string }>, running: ReplicaProject, secrets: readonly string[]): Plan | { problem: string } {
  // a reader's problem quotes the file it read (a key, a value): one line, bounded, masked, as a service's words are
  const now = sideOf(sent, "this project's");
  if ("problem" in now) return { problem: serviceText(now.problem, 500, secrets) };
  const was = sideOf(running.files, "the replica's");
  if ("problem" in was) return { problem: serviceText(was.problem, 500, secrets) };
  const shown = (name: string): string => serviceText(name, MAX_TABLE_NAME, secrets);
  const sizes = new Map(running.tables.map((t) => [t.table, t]));
  const sized = (table: string): TableSize => ({ table: shown(table), rows: sizes.get(table)?.rows ?? null, bytes: sizes.get(table)?.bytes ?? null });
  const t = diff(was.tables, now.tables);
  const changed = sorted([...now.tables.keys()].filter((k) => was.tables.has(k))).flatMap((k) => {
    const a = was.tables.get(k)!, b = now.tables.get(k)!;
    if (a.columns === b.columns && a.key === b.key && a.sync === b.sync) return [];
    return [{ table: shown(k), columns: a.columns !== b.columns, key: a.key !== b.key, sync: a.sync === b.sync ? null : { from: a.sync, to: b.sync } }];
  });
  const g = diff(was.generated, now.generated);
  const r = diff(was.roles ?? new Map<string, string>(), now.roles ?? new Map<string, string>());
  const names = (xs: string[]): string[] => xs.map(shown);
  const def = (v: string | null): string | null => v === null ? null : shown(v);
  return {
    tables: { added: t.added.map(sized), removed: t.removed.map(sized), changed },
    generatedTables: { added: names(g.added), removed: names(g.removed), changed: names(g.changed) },
    roles: { added: names(r.added), removed: names(r.removed), changed: names(r.changed),
      default: was.rolesDefault === now.rolesDefault ? null : { from: def(was.rolesDefault), to: def(now.rolesDefault) } },
    pin: was.pin === now.pin ? null : { from: was.pin, to: now.pin },
  };
}

/** A table's size for a person: `1,200,000 rows, 700.0 MiB`, either alone, or `size not known`. */
export function sizeText(t: TableSize): string {
  const parts = [...(t.rows === null ? [] : [`${t.rows.toLocaleString("en-US")} row${t.rows === 1 ? "" : "s"}`]), ...(t.bytes === null ? [] : [bytesText(t.bytes)])];
  return parts.length ? parts.join(", ") : "size not known";
}

/** Tables removed, each with its size, in a line. */
export const removedText = (removed: readonly TableSize[]): string => removed.map((t) => `${t.table} (${sizeText(t)})`).join(", ");

/** What a re-sync of a removed table costs, in the CLI's words (said in the plan, the question and the refusal). */
export const RESYNC = "its synced data is dropped, and syncing it again is a new first sync, reading every row from the source";

/** The plan as rows for a person, a change a row (`[verb, what]`); none when it changes nothing. */
export function planRows(plan: Plan): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  for (const x of plan.tables.added) rows.push(["adds", `table ${x.table} (${sizeText(x)}): its first sync starts`]);
  for (const x of plan.tables.removed) rows.push(["removes", `table ${x.table} (${sizeText(x)}): ${RESYNC}`]);
  for (const x of plan.tables.changed) {
    const what = [...(x.columns ? ["its columns"] : []), ...(x.key ? ["its key"] : []), ...(x.sync ? [`its sync (${x.sync.from} to ${x.sync.to})`] : [])];
    rows.push(["changes", `table ${x.table}: ${what.join(", ")}`]);
  }
  for (const [verb, xs] of [["adds", plan.generatedTables.added], ["removes", plan.generatedTables.removed], ["changes", plan.generatedTables.changed]] as const) {
    for (const x of xs) rows.push([verb, `generated table ${x}`]);
  }
  for (const [verb, xs] of [["adds", plan.roles.added], ["removes", plan.roles.removed], ["changes", plan.roles.changed]] as const) {
    for (const x of xs) rows.push([verb, `role ${x}`]);
  }
  if (plan.roles.default) rows.push(["changes", `the default role: ${plan.roles.default.from ?? "none"} to ${plan.roles.default.to ?? "none"}`]);
  if (plan.pin) rows.push(["changes", `the pin: ${plan.pin.from === null ? "none" : `Mason ${plan.pin.from}`} to ${plan.pin.to === null ? "none" : `Mason ${plan.pin.to}`}`]);
  return rows;
}
