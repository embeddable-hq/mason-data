#!/usr/bin/env node
/**
 * A RUN KILLED AT A STEP, for tests/duck-generated.test.ts: builds `counts` in `<dir>`, changes its base, and SIGKILLs itself
 * when the next run reaches `<step>`. It exits only by that signal; anything else is the test's failure.
 */
import { MASON_SCHEMA } from "../src/duck/store.ts";
import { built, COUNTS, withWorld } from "./duck-generated-world.ts";

const [dir, step] = process.argv.slice(2);
let armed = false;
await withWorld({ counts: COUNTS }, async (w) => {
  const first = await w.until(built);
  await w.store.writer.run("INSERT INTO public.events VALUES (9, 9, 'query', 'ok', '9', '2026-01-03 00:00:00+00', NULL, 1, NULL)");
  // as a poll records it: what a restart reads as "a base moved since the build"
  await w.store.writer.run(`INSERT OR REPLACE INTO ${MASON_SCHEMA}.poll_state (source, snapshot, polled_at, sync) VALUES ('public.events', '100:100:', now() + INTERVAL 1 MINUTE, 'off')`);
  armed = true;
  w.sync.generated.changed("public.events");
  await w.until((s) => s.lastRun?.at !== first.lastRun?.at);
}, { dir: dir!, onStep: (s) => { if (armed && s === step) process.kill(process.pid, "SIGKILL"); } });
console.error(`the run never reached ${step}`);
process.exit(3);
