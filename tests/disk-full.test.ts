/**
 * A WRITE THAT FAILS FOR DISK SPACE (src/lib/disk-full.ts, issue 847): told by one test, said with one way out where a
 * write under .mason/ failed (never the source database's own full disk), and a file Mason rewrites replaced whole or
 * left as it was — never empty.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { DISK_WAY_OUT, isDiskFull, replaceFile, withDiskWayOut, writeFailureText } from "../src/lib/disk-full.ts";
import { errorText } from "../src/lib/secret-mask.ts";

const enospc = (): Error => Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });

test("a full disk is told by its code or its words, and nothing else is", () => {
  assert.ok(isDiskFull(enospc()));
  assert.ok(isDiskFull(Object.assign(new Error("quota"), { code: "EDQUOT" })));
  assert.ok(isDiskFull(new Error('TransactionContext Error: Failed to commit: Could not write file "/p/.mason/duck.db.wal": No space left on device')));
  assert.ok(!isDiskFull(Object.assign(new Error("permission denied"), { code: "EACCES" })));
  assert.ok(!isDiskFull(new Error("connection refused")));
});

test("a write under .mason/ that failed for disk space is given the way out once; the source's own full disk and every other text are left as they are", () => {
  const engine = 'TransactionContext Error: Failed to commit: Could not write file "/p/.mason/duck.db.wal": No space left on device';
  assert.equal(withDiskWayOut(engine), `${engine} (${DISK_WAY_OUT})`);
  assert.equal(withDiskWayOut(withDiskWayOut(engine)), withDiskWayOut(engine), "said once, however often it passes");
  // the engine's own wordings that already say it (openDuck, invalidatedReason) are not told it twice
  const own = "the synced data met a fatal error … No space left on device …; free disk where the synced data is (.mason/), or the restart meets the same error";
  assert.equal(withDiskWayOut(own), own);
  const source = "IO Error: ERROR: could not extend file \"base/16384/2619\": No space left on device";
  assert.equal(withDiskWayOut(source), source, "the database's disk is its own: no way out here");
  assert.equal(withDiskWayOut("orders: polled 3 rows"), "orders: polled 3 rows");
  // the sync's words of an error pass through it (src/lib/secret-mask.ts errorText)
  assert.equal(errorText(new Error(engine)), `${engine} (${DISK_WAY_OUT})`);
  assert.equal(writeFailureText("/p/.mason/restarts.json", enospc()), `/p/.mason/restarts.json could not be written (ENOSPC: no space left on device, write): ${DISK_WAY_OUT}`);
  assert.equal(writeFailureText("/p/.mason/restarts.json", new Error("EIO")), "/p/.mason/restarts.json could not be written (EIO)");
});

test("a file replaced whole, or left as it was when its write fails: never empty, nothing left beside it", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "disk-full-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "config.json");
  replaceFile(file, "{\"a\":1}\n");
  assert.equal(fs.readFileSync(file, "utf8"), "{\"a\":1}\n");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // the disk fills: the new file beside it begins (an empty file) and its write fails, as writeFileSync fails on a full disk
  const real = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (f: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    (real as (...a: unknown[]) => void)(f, "", ...rest.slice(1));
    throw enospc();
  });
  syncBuiltinESMExports();
  try { assert.throws(() => replaceFile(file, "{\"a\":2}\n"), /ENOSPC/); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(fs.readFileSync(file, "utf8"), "{\"a\":1}\n", "the file as it was");
  assert.deepEqual(fs.readdirSync(dir), ["config.json"], "what the failed write began is removed");
});
