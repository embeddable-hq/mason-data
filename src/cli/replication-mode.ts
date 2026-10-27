/**
 * `mason start --replication` (the journey to production, item 6): a project's run reading its database's
 * change log as production does — a publication, a replication slot, `wal_level = logical` — instead of polling it with
 * SELECTs (src/cdc/poll.ts). A developer then meets the setup production needs on their own database first. The mode is
 * the project's (`.mason/config.json` `changes`), kept between starts until `--poll` takes it back.
 *
 * What it costs the developer's database, said where it happens: Mason creates its slot there (`mason_<deployment>`), and
 * a slot holds WAL while nobody reads it — so `mason stop` says so, and `mason destroy`, or going back to polling, drops
 * it (`dropOwnReplication`), verified gone, by the name the start that made it RECORDED (`madeReplication`), never one
 * computed again. The PUBLICATION is Mason's own (`mason_<deployment>`, made and dropped with
 * the slot) unless the operator names one (`--publication <name>`, else `PG_PUBLICATION`, else the one
 * an earlier start recorded): that one is the database owner's, read as it is and never created, altered or dropped
 * (src/duck/publication.ts) — on a read replica it is the only way, since CREATE PUBLICATION is refused on a standby.
 *
 * In the ClickHouse service this was cut from, the two modes kept row versions that could not continue each other (a
 * counter per table against WAL positions): a switch was a copy from scratch, which that service did by itself. The DuckDB
 * prototype keeps its copies through a switch: each table is caught up by one poll from its watermark (src/duck/sync.ts
 * `prepareReplication`), and `mason start` says so.
 */
import { createHash } from "node:crypto";
import { replicationNames } from "../cdc/source.ts";
import type { ChangeSource } from "../cdc/poll.ts";
import { connectSource, systemIdentifier, type Source } from "./preflight.ts";
import type { ProjectConfig } from "./project.ts";
import { readServerFacts, readSlotFacts, replicationChecks, type ProductionCheck, type ServerFacts } from "./replication-checks.ts";

/** Postgres's longest identifier (NAMEDATALEN - 1): a longer slot name is refused, a longer publication's cut with a notice. */
export const PG_NAME_BYTES = 63;

/**
 * THE NAME A SOURCE'S SLOT AND PUBLICATION ARE MADE FROM, `dev_<project>_<source>` (src/cdc/source.ts replicationNames
 * puts `mason_` before it): one per project AND source, the source the sources file's name, since a project will sync
 * several databases, each with a slot of its own. Lower case, `_` for any other character, as a slot's name must be. A
 * project (48 at most) and a source (48) can pass Postgres's 63 bytes: then a readable prefix and `_` and 8 hex
 * characters of the whole name's sha256, so two names sharing a long prefix never meet and none is ever cut silently.
 */
export function deploymentOf(project: string, source: string): string {
  const full = `dev_${project}_${source}`.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const room = PG_NAME_BYTES - "mason_".length;
  if (full.length <= room) return full;
  return `${full.slice(0, room - 9)}_${createHash("sha256").update(full).digest("hex").slice(0, 8)}`;
}

/** The slot and publication a project's run reads in replication mode; `owned` when the publication is Mason's own. */
export interface ProjectReplication { publication: string; slot: string; owned: boolean }

/**
 * The publication and slot a project's run reads: the publication `named` (the flag, `PG_PUBLICATION` or the recorded
 * one: `namedPublication`), else Mason's own — by the change reader's own rule (src/cdc/source.ts `replicationNames`),
 * which also says whether it is Mason's to make. The slot is always the project's own.
 */
export function projectReplication(name: string, source: string, named: string | null = null): ProjectReplication {
  const { publication, slot, owned } = replicationNames(named ? { PG_PUBLICATION: named } : {}, deploymentOf(name, source));
  return { publication, slot, owned };
}

/**
 * WHAT REPLICATION MODE MADE ON THE DATABASE, as the start that made it recorded it (`config.json` `replication`): what
 * `--poll` and `mason destroy` drop. Recorded, never computed again, so a name that changes since — the sources file
 * renamed, the naming rule — never leaves a slot that nobody drops, holding the database's WAL for ever. A project with
 * no record (none started in replication mode since it was kept) has the names the rule gives now.
 */
export function madeReplication(cfg: Pick<ProjectConfig, "name" | "publication" | "replication">, source: string): ProjectReplication {
  return cfg.replication ?? projectReplication(cfg.name, source, cfg.publication ?? null);
}

/** The publication an operator named, and where: `--publication`, else `PG_PUBLICATION`, else the one an earlier start
 *  of this copy recorded (`config.json` `publication`), else none (Mason's own). */
export function namedPublication(flag: string | null, env: NodeJS.ProcessEnv, recorded: string | null | undefined): { name: string; from: "flag" | "env" | "recorded" } | null {
  if (flag) return { name: flag, from: "flag" };
  if (env.PG_PUBLICATION) return { name: env.PG_PUBLICATION, from: "env" };
  if (recorded) return { name: recorded, from: "recorded" };
  return null;
}

/** The mode a start runs: the flag, else the project's, else polling. */
export function changesOf(flag: ChangeSource | null, recorded: ChangeSource | undefined): ChangeSource {
  return flag ?? recorded ?? "poll";
}

/**
 * Whether the developer's database can be read by replication: what refuses it (wal_level, the role — REPLICATION, a
 * superuser, or RDS's rds_replication membership, as `replicationChecks` reads them — a free slot and WAL sender, a
 * standby before 16, and a standby with no publication named: Mason cannot make its own there), and what is only worth
 * saying (the WAL cap), from the production checks' own rules.
 */
export function readinessVerdict(facts: ServerFacts, slot: string, slotFacts: Awaited<ReturnType<typeof readSlotFacts>>, repl: Pick<ProjectReplication, "publication" | "owned">): { refused: ProductionCheck[]; warnings: ProductionCheck[] } {
  const checks = replicationChecks(facts, slot, slotFacts);
  // a standby takes no CREATE PUBLICATION (it is read-only): the publication must be the primary's, named
  if (facts.standby && repl.owned) {
    checks.push({ name: "publication", ok: false, detail: `this database is a read replica, where Mason cannot make its publication ${repl.publication} (CREATE ` +
      "PUBLICATION is refused on a standby). Create one on the primary for the tables you add, then name it: mason start --replication --publication <name>" });
  }
  // a laptop's database has no cap on its slots by default: worth saying, never a reason to refuse a dev run
  return { refused: checks.filter((x) => x.ok === false && x.name !== "WAL cap"), warnings: checks.filter((x) => (x.name === "WAL cap" && x.ok === false) || x.warn === true) };
}

export async function replicationReadiness(source: Source, repl: ProjectReplication): Promise<{ refused: ProductionCheck[]; warnings: ProductionCheck[] } | { failure: string }> {
  const c = await connectSource(source);
  if ("failure" in c) return { failure: c.failure.message };
  try {
    return readinessVerdict(await readServerFacts(c.pg), repl.slot, await readSlotFacts(c.pg, repl.slot), repl);
  } finally { c.pg.close(); }
}

/** The statements that remove what replication mode made, for a person to run when Mason could not: the slot, and the
 *  publication only when it is Mason's own (a named one is its owner's). */
export function dropStatements(o: ProjectReplication): string {
  return `SELECT pg_drop_replication_slot('${o.slot}') FROM pg_replication_slots WHERE slot_name = '${o.slot}' AND NOT active;` +
    (o.owned ? ` DROP PUBLICATION IF EXISTS ${o.publication};` : "");
}

/**
 * Drop what replication mode made on the developer's database — the slot, and the publication when it is Mason's own,
 * never one the operator named — and verify it is gone: what was dropped, in words. A slot a reader still holds is never
 * dropped (the run must be stopped first): that is a failure.
 */
export async function dropOwnReplication(source: Source, o: ProjectReplication, from: { systemIdentifier: string | null } | null = null): Promise<string[]> {
  const c = await connectSource(source);
  if ("failure" in c) throw new Error(`could not connect to drop them: ${c.failure.message}`);
  const pg = c.pg;
  const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`;
  try {
    // the server the copy came from (its system identifier, recorded at the copy): another one has none of its slot
    if (from?.systemIdentifier) {
      const now = await systemIdentifier(pg);
      if (now !== null && now !== from.systemIdentifier) {
        throw new Error(`${source.database} on ${source.host} is another server than the copy came from (system identifier ${now}, the copy's ${from.systemIdentifier}), where the slot is: put that server's URL back in the sources file and run mason destroy again, or drop them there by hand`);
      }
    }
    const dropped: string[] = [];
    const slot = await readSlotFacts(pg, o.slot);
    if (slot) {
      if (slot.active) throw new Error(`replication slot ${o.slot} is in use by a reader: stop it first`);
      await pg.query(`SELECT pg_drop_replication_slot(${lit(o.slot)})`);
      dropped.push(`replication slot ${o.slot}`);
    }
    const hasPub = async (): Promise<boolean> => (await pg.query(`SELECT 1 FROM pg_publication WHERE pubname = ${lit(o.publication)}`)).rows.length > 0;
    if (o.owned && await hasPub()) {
      await pg.query(`DROP PUBLICATION IF EXISTS "${o.publication.replace(/"/g, '""')}"`);
      dropped.push(`publication ${o.publication}`);
    }
    // verified, never assumed: a slot left behind holds the database's WAL for ever
    if (await readSlotFacts(pg, o.slot)) throw new Error(`replication slot ${o.slot} is still there after pg_drop_replication_slot`);
    if (o.owned && await hasPub()) throw new Error(`publication ${o.publication} is still there after DROP PUBLICATION`);
    return dropped;
  } finally { pg.close(); }
}
