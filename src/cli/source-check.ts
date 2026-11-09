/**
 * CAN THE DATABASE SERVE THIS PROJECT, AS ITS FILES SAY IT? (issue 779) Every check `mason start` makes against the
 * database before it opens anything, run at once and each problem kept — never the first alone — so one answer names
 * every problem with its fix: the connection, the tables the sources file names (`entryProblems`, the start's own:
 * missing, unreadable — no SELECT, no USAGE on the schema, row-level security that hides every row —, a column, a key,
 * a replica identity), logical replication for the tables whose `sync:` is `replication` (`readinessVerdict`: wal_level,
 * the role, a free slot and WAL sender), a publication the file names (`namedPublicationVerdict`: it exists, carries
 * each table), and the roles file against the tables' columns. Each fact is read by the module the start reads it
 * with; this module only gathers. `mason serve --check` answers it (src/cli/serve.ts), so a deploy can ask before it
 * changes anything.
 *
 * READ-ONLY: one connection, SELECTs on settings and catalogs, never a row of data beyond what the start's catalog read
 * counts, nothing made, altered or dropped.
 */
import type { PgConnection } from "../cdc/pg-wire.ts";
import { connectSource, maskedUrl, parseSource, readSourceFacts, versionProblem, type SourceFacts, type SourceTable } from "./preflight.ts";
import { addedTables, copiedColumns, entryProblems, effectiveSync, replicatedEntries, shownPath, type ProjectSource, type SourceFile } from "./sources.ts";
import { namedPublication, projectReplication, readinessVerdict } from "./replication-mode.ts";
import { readServerFacts, readSlotFacts, type ProductionCheck, type ServerFacts } from "./replication-checks.ts";
import { gapProblem, gapStatements, namedPublicationVerdict, readNamedPublication, type NamedPublicationVerdict } from "../duck/publication.ts";
import { readRoles, roleProblems, type CopiedTable } from "./roles.ts";
import { readGenerated } from "./generated-files.ts";
import type { AddedTable } from "../duck/sync.ts";

/** What a problem is about: a closed set a program can branch on. */
export const SOURCE_PROBLEM_CODES = {
  unreachable: "the database cannot be connected to with the URL the sources file names",
  version: "the database's Postgres is older than Mason reads",
  missing_table: "a table the sources file names is not one the database has that this user can read (no such table, no SELECT on it, or no USAGE on its schema)",
  table: "a table the sources file names cannot be synced as its entry says: a column or key it lacks, no primary key, its replica identity, or row-level security that hides every row",
  replication: "the database cannot serve logical replication for the tables whose sync: is replication: wal_level, the role, a free slot or WAL sender, a read replica",
  publication: "the publication the sources file names does not exist, or does not carry a table whose sync: is replication",
  roles: "the roles file names a table the sources file does not sync, or a column the synced table lacks",
} as const;
export type SourceProblemCode = keyof typeof SOURCE_PROBLEM_CODES;

/** One problem: what it is about, the table (as the sources file names it, `schema.table`) or null, what is wrong, the
 *  way out in words, and the statement the database's owner runs when there is one (Mason never runs it). */
export interface SourceProblem { code: SourceProblemCode; table: string | null; message: string; fix: string; sql: string | null }

/** The check's answer: every problem, and how many tables it held to the database (`replicated` of them by replication). */
export interface SourceCheck { problems: SourceProblem[]; tables: number; replicated: number }

/**
 * THE TABLES AGAINST THE CATALOG (pure): each entry's problems as the start says them (`entryProblems`), a problem
 * each, and the tables that pass, as the run would sync them (`addedTables`).
 */
export function tableCheck(src: SourceFile, facts: Pick<SourceFacts, "tables">, database: string, root: string): { problems: SourceProblem[]; added: AddedTable[]; streamed: AddedTable[] } {
  const shown = shownPath(root, src.file);
  const problems: SourceProblem[] = [];
  const ok = [];
  // every table the database has under sync: replication, with the columns its entry syncs, whatever else is wrong with
  // it: what a named publication must carry, so its gaps are on the same answer — but never one that cannot be
  // replicated (`unreplicable`), which no statement this check prints may name
  const streamed: AddedTable[] = [];
  for (const e of src.tables) {
    const t = facts.tables.find((x) => x.source === e.table);
    const sync = effectiveSync(src, e).sync;
    if (t !== undefined && sync.mode === "replication" && !unreplicable(t)) {
      const keep = new Set(copiedColumns(t, e));
      streamed.push({ ...t, columns: t.columns.filter((c) => keep.has(c.name)), foreignKeys: [], sync });
    }
    const said = entryProblems(t, e, facts.tables, database, sync);
    if (t === undefined) {
      for (const m of said) problems.push({ code: "missing_table", table: e.table, message: m,
        fix: `remove tables.${e.name} from ${shown}, or have the database's owner make it or grant this user SELECT on it and USAGE on its schema (mason tables lists what it can read)`, sql: null });
    } else if (said.length) {
      for (const m of said) problems.push({ code: "table", table: e.table, message: m, fix: `change tables.${e.name} in ${shown}, or the table on the database, as said`, sql: null });
    } else ok.push(e);
  }
  const added = addedTables({ ...src, tables: ok }, facts.tables, database, root);
  // every entry kept passed entryProblems, which is all addedTables refuses by: a refusal here is a bug of this module
  if (!Array.isArray(added)) throw new Error(`the tables that passed were refused: ${added.message}`);
  return { problems, added, streamed };
}

/**
 * A TABLE LOGICAL REPLICATION CANNOT CARRY (entryProblems refuses it under sync: replication): no primary key (with or
 * without a `key:`), or REPLICA IDENTITY NOTHING. A publication carrying it makes the application's own UPDATEs and
 * DELETEs on it fail ("does not have a replica identity and publishes updates"), so no publication statement may name it.
 */
export const unreplicable = (t: Pick<SourceTable, "key" | "replicaIdentity">): boolean => t.key.length === 0 || t.replicaIdentity === "n";

/** What refuses logical replication, a problem each (pure): `readinessVerdict`'s refusals, in its words. */
export function replicationProblems(refused: readonly ProductionCheck[], shown: string): SourceProblem[] {
  const poll = `or give the replicated tables' entries sync: poll <interval> in ${shown}, which needs none of this`;
  return refused.map((c) => ({ code: "replication", table: null, message: `${c.name}: ${c.detail}`,
    fix: c.sql ? `the database's owner runs ${c.sql.replace(/\n/g, " ")} — ${poll}` : `change the database as said — ${poll}`, sql: c.sql ?? null }));
}

/** What a named publication lacks, a problem each (pure): the whole publication's refusal, else each table's gap. */
export function publicationProblems(v: NamedPublicationVerdict, publication: string, shown: string): SourceProblem[] {
  const way = `or give its entry sync: poll <interval> in ${shown}, which needs no publication`;
  const one = (table: string | null, gap: string): SourceProblem => {
    const sql = gapStatements(gap);
    const what = gapProblem(gap);
    return { code: "publication", table, message: `publication ${publication}: ${what}`,
      fix: sql !== null ? `the database's owner runs ${sql} (Mason never alters a publication it is given) — ${way}` : `the database's owner changes publication ${publication} as said — ${way}`, sql };
  };
  if (v.refused !== null) return [one(null, v.refused)];
  return [...v.tables].sort(([a], [b]) => a.localeCompare(b)).map(([table, gap]) => one(table, gap));
}

/**
 * THE PROJECT'S OWN SLOT IN USE IS THE RUN THAT SERVES IT NOW (pure): a deploy is checked beside the replica's running
 * Mason, which reads the slot through one WAL sender, both freed when it restarts on the new files. So its reader is not
 * "another reader" here, and its sender is counted free. Another process holding the slot is told apart by nothing in
 * the catalog: the start that follows refuses it then, by name.
 */
export function ownReaderFreed(server: ServerFacts, slot: Awaited<ReturnType<typeof readSlotFacts>>): { server: ServerFacts; slot: Awaited<ReturnType<typeof readSlotFacts>> } {
  if (slot === null || !slot.active) return { server, slot };
  return { server: { ...server, sendersUsed: Math.max(0, server.sendersUsed - 1) }, slot: { ...slot, active: false, activePid: null } };
}

/** The roles file against the tables the project syncs (pure): a table that failed above is known by name alone. */
export function rolesProblems(folder: string, root: string, src: SourceFile, added: readonly AddedTable[]): SourceProblem[] {
  const roles = readRoles(folder, root);
  if (roles === null) return [];
  const fix = "edit the roles file as said";
  if ("message" in roles) return [{ code: "roles", table: null, message: `${roles.message}${roles.why ? `: ${roles.why.replace(/\n/g, "; ")}` : ""}`, fix: roles.fix ?? fix, sql: null }];
  const generated = readGenerated(folder, root);
  const copied: CopiedTable[] = [
    ...src.tables.map((e) => added.find((t) => t.source === e.table) ?? { source: e.table, columns: null }),
    ...[...generated.definitions, ...generated.refused].map((g) => ({ source: g.name, columns: [], pending: true as const })),
  ];
  return roleProblems(roles, copied).map((m) => ({ code: "roles", table: null, message: m, fix, sql: null }));
}

/**
 * THE CHECK, against the database as it is now: connect as the run will, read what the start reads, and gather every
 * problem. `name` is the project's (the replication slot's name, MASON_NAME under mason serve); `folder` the project
 * folder and `root` what its paths are shown relative to.
 */
export async function checkProjectSource(src: ProjectSource, o: { name: string; folder: string; root: string; env: NodeJS.ProcessEnv }): Promise<SourceCheck> {
  const shown = shownPath(o.root, src.file);
  const replicated = replicatedEntries(src).length;
  const counted = { tables: src.tables.length, replicated };
  const parsed = parseSource(src.resolved, src.from);
  if ("problem" in parsed) return { ...counted, problems: [{ code: "unreachable", table: null, message: parsed.problem, fix: `write ${src.from} as said`, sql: null }] };
  const c = await connectSource(parsed.source);
  if ("failure" in c) {
    return { ...counted, problems: [{ code: "unreachable", table: null, message: `could not connect to ${maskedUrl(src.resolved)}: ${c.failure.message}`,
      fix: c.failure.hints.length ? c.failure.hints.join("; ") : `check the URL ${src.from} names: its host, port, user and password`, sql: null }] };
  }
  try { return { ...counted, problems: await problemsOver(c.pg, src, parsed.source.database, shown, o) }; } finally { c.pg.close(); }
}

async function problemsOver(pg: PgConnection, src: ProjectSource, database: string, shown: string, o: { name: string; folder: string; root: string; env: NodeJS.ProcessEnv }): Promise<SourceProblem[]> {
  const facts = await readSourceFacts(pg, undefined, { collations: false });
  const old = versionProblem(facts);
  if (old !== null) return [{ code: "version", table: null, message: old, fix: "point the sources file at a database on Postgres 13 or later", sql: null }];
  const { problems, added, streamed } = tableCheck(src, facts, database, o.root);
  if (replicatedEntries(src).length > 0) {
    const named = namedPublication(src, o.env);
    const repl = projectReplication(o.name, src.name, named?.name ?? null);
    const own = ownReaderFreed(await readServerFacts(pg), await readSlotFacts(pg, repl.slot));
    problems.push(...replicationProblems(readinessVerdict(own.server, repl.slot, own.slot, repl).refused, shown));
    if (named !== null && streamed.length > 0) {
      const identities = new Map(streamed.map((t) => [t.source, t.replicaIdentity ?? "d"]));
      problems.push(...publicationProblems(namedPublicationVerdict(await readNamedPublication(pg, named.name, streamed), streamed, identities), named.name, shown));
    }
  }
  problems.push(...rolesProblems(o.folder, o.root, src, added));
  return problems;
}

/** A problem as one line a person reads: what is wrong, then its fix. */
export const problemLine = (p: SourceProblem): string => `${p.message} — fix: ${p.fix}`;

