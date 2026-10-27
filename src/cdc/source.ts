/**
 * THE REPLICATION SLOT, and the names a run replicates through (src/duck/sync.ts, src/cli/replication-mode.ts). The
 * slot is the one object Mason creates on the source (its user needs the REPLICATION attribute); a publication is read,
 * never created there, unless it is Mason's own (src/duck/publication.ts; CLAUDE.md "We are read-only on a customer's
 * Postgres").
 */
import { PgConnection, parseLsn, pgIdent, pgLiteral, type PgConnectOptions } from "./pg-wire.ts";
import { parsePort } from "../lib/port.ts";

/**
 * The publication and slot a project replicates through: `PG_PUBLICATION` / `PG_SLOT_NAME`, else Mason's own
 * `mason_<name>`. A publication of Mason's own name is one Mason may create; any other is the database owner's and is
 * only ever read.
 */
export function replicationNames(env: NodeJS.ProcessEnv, deployment: string): { publication: string; slot: string; owned: boolean } {
  const own = `mason_${deployment.replace(/[^A-Za-z0-9_]/g, "_")}`;
  const publication = env.PG_PUBLICATION || own;
  return { publication, slot: env.PG_SLOT_NAME || own, owned: publication === own };
}

/** The connection options from the `PG_*` environment (DATABASE_URL already laid under it). */
export function pgOptions(env: NodeJS.ProcessEnv, replication = false): PgConnectOptions {
  const need = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`${k} is not set (DATABASE_URL, or the PG_* variables)`);
    return v;
  };
  const port = parsePort("PG_PORT", env.PG_PORT, 5432);
  if (port.problem !== undefined) throw new Error(port.problem);
  return {
    host: need("PG_HOST"), port: port.port, database: need("PG_DATABASE"), user: need("PG_USER"),
    password: env.PG_PASSWORD ?? "", sslmode: (env.PG_SSLMODE || "prefer") as NonNullable<PgConnectOptions["sslmode"]>,
    replication, applicationName: replication ? "mason-cdc" : "mason",
  };
}

// ------------------------------------------------------------------ the slot

export interface SlotState {
  exists: boolean; active: boolean; activePid: string | null; plugin: string | null; database: string | null; confirmedFlush: string | null;
  /** Postgres 13+: `reserved` / `extended` / `unreserved` / `lost` — lost once the slot retained more WAL than
   *  `max_slot_wal_keep_size` and Postgres freed it (pg_replication_slots.wal_status) */
  walStatus: string | null;
  /** the WAL the slot holds on the source, from its restart_lsn to the WAL position now, in bytes */
  retainedBytes: bigint | null;
  /** how many more bytes of WAL may be written before the slot is lost (safe_wal_size); null = no cap */
  safeBytes: bigint | null;
}

const NO_SLOT: SlotState = { exists: false, active: false, activePid: null, plugin: null, database: null, confirmedFlush: null,
  walStatus: null, retainedBytes: null, safeBytes: null };

export async function readSlot(pg: PgConnection, slot: string): Promise<SlotState> {
  const r = await pg.query(`SELECT plugin, database, active, active_pid::text, confirmed_flush_lsn::text, wal_status, safe_wal_size::text, ` +
    `pg_wal_lsn_diff((CASE WHEN pg_is_in_recovery() THEN pg_last_wal_replay_lsn() ELSE pg_current_wal_lsn() END), restart_lsn)::text ` +
    `FROM pg_replication_slots WHERE slot_name = ${pgLiteral(slot)}`);
  const row = r.rows[0];
  if (!row) return NO_SLOT;
  const big = (v: string | null | undefined): bigint | null => (v === null || v === undefined || v === "" ? null : BigInt(v.split(".")[0]!));
  return { exists: true, plugin: row[0]!, database: row[1]!, active: row[2] === "t", activePid: row[3] ?? null, confirmedFlush: row[4] ?? null,
    walStatus: row[5] ?? null, safeBytes: big(row[6]), retainedBytes: big(row[7]) };
}

/** Drop the slot (it must not be active). */
export async function dropSlot(pg: PgConnection, slot: string): Promise<void> {
  await pg.query(`SELECT pg_drop_replication_slot(${pgLiteral(slot)})`);
}

/** Where the source's WAL is now: the insert position on a primary, the replayed position on a standby (a
 *  logical slot on a standby decodes only what it has replayed). */
export async function currentLsn(pg: PgConnection): Promise<bigint> {
  const r = await pg.query("SELECT (CASE WHEN pg_is_in_recovery() THEN pg_last_wal_replay_lsn() ELSE pg_current_wal_lsn() END)::text");
  return parseLsn(r.rows[0]?.[0] ?? "");
}

/** Create the slot over a replication connection; returns the WAL position it starts at. */
export async function createSlot(repl: PgConnection, slot: string): Promise<string> {
  // NOEXPORT_SNAPSHOT: the first copy reads each table by key pages, each its own statement (the stream's
  // versions win wherever they overlap) — no long snapshot to hold open.
  const r = await repl.query(`CREATE_REPLICATION_SLOT ${pgIdent(slot)} LOGICAL pgoutput NOEXPORT_SNAPSHOT`);
  return r.rows[0]?.[1] ?? "";
}
