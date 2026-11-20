/**
 * A CHECKPOINT A TEST TAKES BESIDE A LIVE SYNC (issues 926 and 1188): the checkpoint DuckDB takes at 16 MiB of log and
 * at every stop, taken here by hand.
 *
 * DuckDB 2.0 refuses a plain CHECKPOINT ("there are other write transactions active") while any transaction that began
 * before the last committed UPDATE or DDL is still open, on any connection. The sync reads on connections of its own
 * beside the test: the catalog at the end of each pass, and the stored JSON paths' review every 10 s. A poll's commit
 * updates the table's row count, and a compaction's swap is DDL. So a plain checkpoint failed whenever one of those
 * reads was in flight. FORCE waits for those transactions to end and aborts none (measured on DuckDB 2.0.0). It runs on
 * the writer's turn, so it never lands inside a poll's or a stream batch's open transaction, where DuckDB refuses it.
 *
 * FORCE waits as long as an older transaction stays open. So the checkpoint is held to a time limit. Past it, the
 * checkpoint is interrupted, the writer's turn ends, and the test fails with what was still open, never a hang until
 * CI's job limit. The limit counts from the call, the wait for the writer's turn included. A turn that comes after the
 * limit runs nothing.
 */
import type { DuckStore } from "../../src/duck/store.ts";

/** how long a checkpoint may wait, its turn included: far above any checkpoint the tests take, far below CI's job */
export const CHECKPOINT_LIMIT_MS = 120_000;

/** what the helper needs of a Sync: its writer's turn (private on Sync, so it is reached by a cast, as tests do) */
interface Turns { onWriter<T>(f: () => Promise<T>): Promise<T> }

/** a FORCE CHECKPOINT on `sync`'s writer turn, failed by name after `limitMs` */
export async function checkpoint(sync: object, store: DuckStore, limitMs = CHECKPOINT_LIMIT_MS): Promise<void> {
  const began = Date.now();
  let expired = false;
  let running = false;
  const turn = (sync as Turns).onWriter(async () => {
    // the limit passed while the turn was awaited: the test has failed already, so nothing runs
    if (expired) return;
    running = true;
    try { await store.writer.run("FORCE CHECKPOINT"); }
    catch (e) {
      // the interrupt the limit sent ends the checkpoint, and the failure below says why. Any other error is the test's
      if (!(expired && /interrupt/i.test(e instanceof Error ? e.message : String(e)))) throw e;
    } finally { running = false; }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<"limit">((resolve) => { timer = setTimeout(() => resolve("limit"), limitMs); });
  const first = await Promise.race([turn.then(() => "done" as const), limit]).finally(() => clearTimeout(timer));
  if (first === "done") return;
  // read before the interrupt, while the checkpoint's own statement and the ones it waits for are both still in flight
  const open = whatIsOpen(sync, store);
  const reached = running;
  expired = true;
  if (reached) {
    store.writer.interrupt();
    // the turn ends with the interrupt, caught above; any other failure of it is thrown here, the more specific
    await turn;
  }
  throw new Error(`the checkpoint did not end within ${limitMs / 1000} s (${Date.now() - began} ms). ` +
    (reached
      ? "FORCE CHECKPOINT waits for every transaction that began before the last committed write, and one stayed open. It was interrupted."
      : "The writer's turn never came: the sync held it the whole time, and the checkpoint never ran.") +
    `\n${open}`);
}

/**
 * WHAT WAS STILL OPEN, as the test can see it. DuckDB 2.0 lists no transactions, so this names the engine's requests in
 * flight (each with its caller's frame in the repository: `src/duck/sync.ts:1234`, or a test's), and the sync's own
 * rebuild and catch-up. A transaction open between two of its statements has no request in flight, and is said so.
 */
function whatIsOpen(sync: object, store: DuckStore): string {
  const pending = (store as unknown as { executor?: { pending?: Map<number, { site?: { stack?: string } }> } }).executor?.pending;
  const others = [...(pending?.values() ?? [])].map((p) => callerOf(p.site?.stack)).filter((at) => at !== HERE);
  const s = sync as { rebuildingNow?: { source: string; kind: string; since: number } | null; catchingUp?: { source: string; phase: string; startedAt: number } | null };
  const lines = [
    pending === undefined
      ? "The engine's requests in flight could not be read (the store's executor has no `pending`)."
      : others.length === 0
        ? "No other request was in flight on the engine: the open transaction is between two of its statements (a BEGIN not yet committed)."
        : `${others.length} other request(s) in flight on the engine, from: ${others.map((at) => at ?? "an unknown caller").join("; ")}.`,
  ];
  if (s.rebuildingNow) lines.push(`The sync was rebuilding ${s.rebuildingNow.source} (${s.rebuildingNow.kind}) for ${Date.now() - s.rebuildingNow.since} ms.`);
  if (s.catchingUp) lines.push(`The sync was catching up ${s.catchingUp.source} (${s.catchingUp.phase}) for ${Date.now() - s.catchingUp.startedAt} ms.`);
  return lines.join("\n");
}

/** this file, as a caller's frame names it: the checkpoint's own request is left out of what is open */
const HERE = "tests/integration/checkpoint.ts";

/**
 * The first frame of a request's caller in the repository, past the engine's bridge (src/duck/executor.ts and
 * src/duck/store.ts): `src/duck/sync.ts:1234`. This file's own frames are named by the file alone (`HERE`).
 */
function callerOf(stack: string | undefined): string | null {
  if (stack === undefined) return null;
  const root = new URL("../../", import.meta.url).pathname;
  for (const line of stack.split("\n")) {
    const m = /^\s*at (?:.*? \()?(?:file:\/\/)?(\/[^():]+):(\d+):\d+\)?$/.exec(line);
    if (m === null || !m[1]!.startsWith(root)) continue;
    const rel = m[1]!.slice(root.length);
    if (rel.includes("node_modules/") || rel === "src/duck/executor.ts" || rel === "src/duck/store.ts") continue;
    return rel === HERE ? HERE : `${rel}:${m[2]}`;
  }
  return null;
}
