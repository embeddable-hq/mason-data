/**
 * A `node --test` REPORTER: each test FILE's wall time, in ms, as ONE JSON object { "<path>": ms } at the end of the run
 * (scripts/ci-shards.ts gives it to a unit shard's run beside the spec reporter, and reads it into the shard's record).
 * The time is the runner's own: with process isolation the runner reports each file as a test of its own, one
 * `test:complete` whose `duration_ms` is the file's whole life (its load, its top-level awaits, its hooks, every test),
 * sent also for a file that failed to load. The per-test events are never summed: they leave out the load and the hooks.
 *
 * That event is told apart by its shape: at nesting 0, at line 1 column 1, and named for its file (Node names it by the
 * path as given on the command line; a basename is taken too). A top-level test named like its file is a `test()` call,
 * which never sits at line 1 column 1 of a file whose import of `test` comes first. A path is spelt as
 * scripts/ci-shards.ts's `testFiles` spells it: relative to the run's directory, with '/'. Node's builtins only: CI's
 * final jobs read what this writes with no `npm ci` (tests/conventions.test.ts).
 */
import * as path from "node:path";

interface Complete { name: string; nesting: number; line?: number; column?: number; file?: string; details: { duration_ms: number } }

/** Whether a `test:complete` event is a file's own, and its path as the shards spell it */
export function fileOf(e: Complete, cwd: string): string | null {
  if (e.nesting !== 0 || e.line !== 1 || e.column !== 1 || e.file === undefined) return null;
  if (path.resolve(cwd, e.name) !== e.file && e.name !== path.basename(e.file)) return null;
  return path.relative(cwd, e.file).split(path.sep).join("/");
}

export default async function* testTimes(source: AsyncIterable<{ type: string; data: unknown }>): AsyncGenerator<string> {
  const times: Record<string, number> = {};
  const cwd = process.cwd();
  for await (const e of source) {
    if (e.type !== "test:complete") continue;
    const d = e.data as Complete;
    const file = fileOf(d, cwd);
    if (file !== null) times[file] = Math.round(d.details.duration_ms);
  }
  yield `${JSON.stringify(times)}\n`;
}
