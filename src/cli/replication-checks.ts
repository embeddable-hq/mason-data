/**
 * WHAT A DATABASE NEEDS BEFORE MASON READS ITS CHANGE LOG (`mason start --replication`; src/cli/replication-mode.ts):
 * wal_level = logical, a user that may replicate, a free slot and WAL sender, a cap on the WAL a slot may hold
 * (`max_slot_wal_keep_size`). READ-ONLY: settings, the catalog and the statistics views — never a row of data, and
 * nothing is created, changed or granted. Each check that fails says what the database's owner runs to fix it.
 * (The whole of `mason doctor --production`, which also costed polling and checked the publication against the project's tables,
 * stayed in the private repository with the compiler; what the run itself needs is here.)
 */
import type { PgConnection } from "../cdc/pg-wire.ts";

/** One check, as `mason start` prints it: `warn` marks a cost to know about that refuses nothing; `sql` is the
 *  statement the database's owner runs to fix it (collected under the report). */
export interface ProductionCheck { name: string; ok: boolean | null; detail: string; warn?: boolean; sql?: string }

export interface ServerFacts {
  version: number; versionText: string; standby: boolean; user: string;
  walLevel: string;
  /** `max_slot_wal_keep_size` in MB; -1 is no cap */
  slotWalKeepMb: number;
  maxSlots: number; slotsUsed: number; maxSenders: number; sendersUsed: number;
  superuser: boolean; replication: boolean;
  /** RDS / Aurora: the rds_replication role exists here (null), and whether this user is in it */
  rds: { member: boolean } | null;
  /** Cloud SQL: the cloudsql.logical_decoding flag exists here */
  cloudSql: boolean;
  hotStandbyFeedback: boolean;
  idleInTransactionMs: number; statementTimeoutMs: number;
  /** WAL this server wrote per second since its statistics were reset (pg_stat_wal, Postgres 14+); null when unknown */
  walBytesPerSecond: number | null;
}

/** Everything the checks read of the server, in one statement: settings and roles only. */
export const SERVER_FACTS_SQL = `SELECT json_build_object(
  'version', current_setting('server_version_num')::int, 'version_text', current_setting('server_version'),
  'standby', pg_is_in_recovery(), 'user', current_user,
  'wal_level', current_setting('wal_level'),
  'slot_wal_keep_mb', (SELECT CASE WHEN setting = '-1' THEN -1 ELSE setting::bigint END FROM pg_settings WHERE name = 'max_slot_wal_keep_size'),
  'max_slots', current_setting('max_replication_slots')::int, 'slots_used', (SELECT count(*) FROM pg_replication_slots),
  'max_senders', current_setting('max_wal_senders')::int, 'senders_used', (SELECT count(*) FROM pg_stat_replication),
  'superuser', r.rolsuper, 'replication', r.rolreplication,
  'rds', CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rds_replication')
    THEN json_build_object('member', pg_has_role(current_user, 'rds_replication', 'member')) END,
  'cloud_sql', current_setting('cloudsql.logical_decoding', true) IS NOT NULL,
  'hot_standby_feedback', current_setting('hot_standby_feedback') = 'on',
  'idle_in_transaction_ms', (SELECT setting::bigint FROM pg_settings WHERE name = 'idle_in_transaction_session_timeout'),
  'statement_timeout_ms', (SELECT setting::bigint FROM pg_settings WHERE name = 'statement_timeout')
)::text FROM pg_roles r WHERE r.rolname = current_user`;

/** pg_stat_wal (Postgres 14+): the WAL written since the statistics were reset, and over how long. */
export const WAL_RATE_SQL = "SELECT wal_bytes::text, extract(epoch FROM now() - stats_reset)::text FROM pg_stat_wal";

export async function readServerFacts(pg: PgConnection): Promise<ServerFacts> {
  const j = JSON.parse((await pg.query(SERVER_FACTS_SQL)).rows[0]?.[0] ?? "null") as Record<string, unknown> | null;
  if (j === null) throw new Error("the server's settings did not read (no pg_roles row for this user)");
  let walBytesPerSecond: number | null = null;
  if (Number(j.version) >= 140000 && j.standby !== true) {
    const r = (await pg.query(WAL_RATE_SQL)).rows[0];
    const bytes = Number(r?.[0]), seconds = Number(r?.[1]);
    // a reset moments ago says nothing about the rate: an hour of statistics at least
    if (Number.isFinite(bytes) && Number.isFinite(seconds) && seconds >= 3600) walBytesPerSecond = bytes / seconds;
  }
  return {
    version: Number(j.version), versionText: String(j.version_text), standby: j.standby === true, user: String(j.user),
    walLevel: String(j.wal_level), slotWalKeepMb: Number(j.slot_wal_keep_mb),
    maxSlots: Number(j.max_slots), slotsUsed: Number(j.slots_used), maxSenders: Number(j.max_senders), sendersUsed: Number(j.senders_used),
    superuser: j.superuser === true, replication: j.replication === true,
    rds: j.rds === null || j.rds === undefined ? null : { member: (j.rds as { member: boolean }).member === true },
    cloudSql: j.cloud_sql === true, hotStandbyFeedback: j.hot_standby_feedback === true,
    idleInTransactionMs: Number(j.idle_in_transaction_ms), statementTimeoutMs: Number(j.statement_timeout_ms), walBytesPerSecond,
  };
}

/** The slot Mason would read, if it exists: whether a reader holds it and whether Postgres invalidated it. */
export async function readSlotFacts(pg: PgConnection, slot: string): Promise<{ active: boolean; activePid: number | null; walStatus: string | null; plugin: string | null } | null> {
  const r = (await pg.query(`SELECT active::text, active_pid::text, wal_status, plugin FROM pg_replication_slots WHERE slot_name = '${slot.replace(/'/g, "''")}'`)).rows[0];
  return r ? { active: r[0] === "true", activePid: r[1] ? Number(r[1]) : null, walStatus: r[2] ?? null, plugin: r[3] ?? null } : null;
}

/** The way out of a slot another reader holds, in the words of the command that met it. */
/** Bytes as a person reads them: 1.4 GiB, 312 MiB, 18 KiB. */
export function bytesText(n: number): string {
  const units = ["bytes", "KiB", "MiB", "GiB", "TiB"];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return i === 0 ? `${n} bytes` : `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

const q = (s: string): string => /^[a-z_][a-z0-9_]*$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`;

/**
 * A `max_slot_wal_keep_size` to suggest: a day of this server's WAL at its measured rate, rounded up to a whole GB, at
 * least 4 GB; null when the rate is unknown (a standby, Postgres 13, statistics reset within the hour).
 */
export function suggestedWalCapGb(bytesPerSecond: number | null): number | null {
  if (bytesPerSecond === null) return null;
  return Math.max(4, Math.ceil((bytesPerSecond * 86_400) / 1024 ** 3));
}

/** What wal_level = logical takes on this server: its provider's way, or postgresql.conf's. */
function walLevelFix(f: ServerFacts): string {
  if (f.rds) return "set rds.logical_replication = 1 in the DB parameter group (Aurora: the DB cluster parameter group), then reboot the instance";
  if (f.cloudSql) return "set the database flag cloudsql.logical_decoding = on (the instance restarts)";
  return "set wal_level = logical (ALTER SYSTEM SET wal_level = logical, or postgresql.conf; a managed Postgres: its parameter or flag of that name), then restart Postgres";
}

/** The checks of the server for the stream (REPLICATION). */
export function replicationChecks(f: ServerFacts, slot: string, slotState: Awaited<ReturnType<typeof readSlotFacts>>): ProductionCheck[] {
  const out: ProductionCheck[] = [];
  out.push(f.walLevel === "logical"
    ? { name: "wal_level", ok: true, detail: "logical" }
    : { name: "wal_level", ok: false, detail: `${f.walLevel}: logical replication needs logical. To fix: ${walLevelFix(f)}. Or poll the table instead: give its entry sync: poll <interval> in the sources file (SELECTs alone, no change log)` });
  if (f.standby) {
    out.push(f.version >= 160000
      ? { name: "standby", ok: true, warn: !f.hotStandbyFeedback,
        detail: `a read replica (Postgres 16+ decodes on a standby)${f.hotStandbyFeedback ? "" : ". hot_standby_feedback is off: the primary may remove catalog rows the slot still needs, which invalidates it (Mason then rebuilds from scratch) — turn it on"}` }
      : { name: "standby", ok: false, detail: `a read replica on Postgres ${f.versionText}: logical decoding on a standby needs Postgres 16. Point Mason at the primary, upgrade the replica, or poll the table: give its entry sync: poll <interval> in the sources file` });
  }
  const canReplicate = f.superuser || f.replication || f.rds?.member === true;
  out.push(canReplicate
    ? { name: "replication role", ok: true, detail: `${f.user} may replicate${f.superuser ? " (a superuser)" : f.rds?.member ? " (rds_replication)" : " (REPLICATION)"}` }
    : { name: "replication role", ok: false, detail: `${f.user} may not open a replication connection`,
      sql: f.rds ? `GRANT rds_replication TO ${q(f.user)};` : `ALTER ROLE ${q(f.user)} WITH REPLICATION;` });
  const free = f.maxSlots - f.slotsUsed;
  if (slotState) {
    out.push(slotState.walStatus === "lost"
      ? { name: "slot", ok: true, warn: true, detail: `${slot} exists and Postgres invalidated it (wal_status lost): Mason drops it and rebuilds from scratch at its start` }
      : slotState.active
        ? { name: "slot", ok: false, detail: `${slot} is in use by another reader${slotState.activePid !== null ? ` (pid ${slotState.activePid} on the database)` : ""}: one slot has one reader. ` +
          `Stop the other Mason for this project (mason stop). A run that crashed holds it until its connection ends${slotState.activePid !== null ? `: SELECT pg_terminate_backend(${slotState.activePid}) ends it now` : ""}` }
        : { name: "slot", ok: true, detail: `${slot} exists (${slotState.plugin ?? "?"}, ${slotState.walStatus ?? "?"}): Mason resumes from it` });
  } else {
    out.push(free >= 1
      ? { name: "slot", ok: true, detail: `${slot} is made at Mason's first start (${f.slotsUsed} of max_replication_slots ${f.maxSlots} in use)` }
      : { name: "slot", ok: false, detail: `every replication slot is taken (${f.slotsUsed} of max_replication_slots ${f.maxSlots}): raise max_replication_slots (a restart), or drop a slot nobody reads` });
  }
  out.push(f.maxSenders - f.sendersUsed >= 1
    ? { name: "wal senders", ok: true, detail: `${f.sendersUsed} of max_wal_senders ${f.maxSenders} in use` }
    : { name: "wal senders", ok: false, detail: `every WAL sender is in use (${f.sendersUsed} of max_wal_senders ${f.maxSenders}): raise max_wal_senders (a restart)` });
  const gb = suggestedWalCapGb(f.walBytesPerSecond);
  const size = gb === null ? "a day of this database's WAL" : `${gb}GB`;
  const basis = gb === null ? "" : ` (a day of the WAL this server writes: ${bytesText(f.walBytesPerSecond!)}/s since its statistics were reset)`;
  out.push(f.slotWalKeepMb >= 0
    ? { name: "WAL cap", ok: true, detail: `max_slot_wal_keep_size = ${f.slotWalKeepMb >= 1024 ? `${(f.slotWalKeepMb / 1024).toFixed(f.slotWalKeepMb % 1024 ? 1 : 0)}GB` : `${f.slotWalKeepMb}MB`}: past it Postgres drops the slot rather than fill its disk, and Mason rebuilds from scratch${gb !== null && f.slotWalKeepMb < gb * 1024 ? `. A day of this server's WAL is about ${gb}GB${basis}: an outage longer than the cap's worth means a rebuild` : ""}` }
    : { name: "WAL cap", ok: false,
      detail: `max_slot_wal_keep_size is unlimited: while Mason is stopped its slot holds every byte of WAL, until the disk fills and Postgres stops taking writes. Cap it at the outage you want Mason to survive, e.g. ${size}${basis}` +
        (f.rds || f.cloudSql ? ` — in the ${f.rds ? "DB parameter group" : "database flags"} (max_slot_wal_keep_size, in MB)` : ""),
      ...(f.rds || f.cloudSql ? {} : { sql: `ALTER SYSTEM SET max_slot_wal_keep_size = '${gb ?? 4}GB';\nSELECT pg_reload_conf();` }) });
  return out;
}

/** What polling costs this database: a scan of every replicated table at each poll, and the delete check's keys. */
