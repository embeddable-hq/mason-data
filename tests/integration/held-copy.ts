/**
 * A COPY THE TEST HOLDS (the Sync's `onChunk` test hook, src/duck/sync.ts `readChunks`): while held, every chunk of
 * `source`'s copy waits inside its transaction, read and not committed, so the copy cannot end before the test releases
 * it. A test that needs something to happen WHILE a copy runs holds it, rather than betting on the copy outlasting it: a
 * copy's time is the machine's (the 400,000-row copy of duck-poll's "beside the polls" once took 0.89 s on a CI runner,
 * one poll pass ran beside it, and the test failed; .claude/rules/duck-testing.md "Testing").
 *
 * Held from the start (`armed`, the default) or from `hold()`, until `release()`; `held()` is true once a chunk waits
 * since the hold began — the copy's snapshot pinned by then (`beginCopy` precedes every chunk). Release it first thing
 * in a `finally`, before `sync.stop()`: a stop interrupts DuckDB's statements, never this promise. A hold never released
 * fails the chunk after `limitMs`, said by name, so a test that forgot one fails instead of hanging.
 */
import type { ChunkEvent } from "../../src/duck/sync.ts";

export interface HeldCopy {
  /** for the Sync's options: `new Sync(…, { onChunk: held.onChunk })` */
  onChunk: (e: ChunkEvent) => Promise<void>;
  /** a chunk of the copy has waited since the hold began */
  held: () => boolean;
  /** holds the copy's chunks from now on, until `release()` */
  hold: () => void;
  /** lets every waiting chunk, and every later one, go on */
  release: () => void;
}

export function heldCopy(source: string, armed = true, limitMs = 120_000): HeldCopy {
  let gate: { released: Promise<void>; release: () => void } | null = null;
  let held = false;
  const hold = (): void => {
    if (gate !== null) return;
    let open!: () => void;
    const released = new Promise<void>((r) => { open = r; });
    gate = { released, release: open };
    held = false;
  };
  const release = (): void => {
    gate?.release();
    gate = null;
  };
  if (armed) hold();
  return {
    onChunk: async (e) => {
      const g = gate;
      if (g === null || e.source !== source || e.phase !== "read") return;
      held = true;
      let timer: NodeJS.Timeout | undefined;
      const limit = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`the test held ${source}'s copy for ${limitMs / 1000} s and never released it (heldCopy: release() in a finally)`)), limitMs);
        timer.unref();
      });
      try { await Promise.race([g.released, limit]); }
      finally { clearTimeout(timer); }
    },
    held: () => held,
    hold,
    release,
  };
}
