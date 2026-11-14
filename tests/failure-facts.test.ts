/**
 * A FAILURE'S CODE AND ORIGIN (src/lib/failure-facts.ts, issue 924): the code is an SQLSTATE, an errno, the engine's or
 * JavaScript's error class, else `unknown`, never empty; the origin is the first frame in Mason's own code as a file and
 * a line, relative to Mason's source root, never a path outside it, a function's name or arguments, or the message.
 * Offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// imported when the tests run: at a commit without the module this file still loads, and each test fails by name
type Facts = typeof import("../src/lib/failure-facts.ts");
const facts = (): Promise<Facts> => import("../src/lib/failure-facts.ts" as string) as Promise<Facts>;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const at = (file: string, line: number, fn = "Sync.poll"): string => `    at ${fn} (${pathToFileURL(path.join(ROOT, file)).href}:${line}:7)`;
const withStack = (message: string, frames: readonly string[], e: Error = new Error(message)): Error => {
  e.stack = [`${e.name}: ${message}`, ...frames].join("\n");
  return e;
};

test("the code: a Postgres SQLSTATE (its own field, or Postgres's words inside the engine's), an errno, the engine's class, a JavaScript class, else unknown", async () => {
  const { failureCode, UNKNOWN_CODE } = await facts();
  assert.equal(UNKNOWN_CODE, "unknown");
  assert.equal(failureCode(Object.assign(new Error("relation \"t\" does not exist"), { code: "42P01" })), "42P01", "a driver's error carries its SQLSTATE");
  assert.equal(failureCode({ fields: { code: "53200" }, message: "out of memory" }), "53200", "a StatementError's fields");
  assert.equal(failureCode(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" })), "ECONNREFUSED", "a system error's errno");
  assert.equal(failureCode(new Error("Binder Error: Failed to prepare query \"SELECT 1\": ERROR:  relation \"public.t\" does not exist\nLINE 1: …")), "42P01",
    "Postgres's words passed on by the engine, without their SQLSTATE");
  assert.equal(failureCode(new Error("IO Error: Unable to connect to Postgres at \"sslmode='prefer'\": connection to server at \"localhost\" (127.0.0.1), port 1 failed: Connection refused")), "ECONNREFUSED",
    "the system's words passed on by the engine");
  assert.equal(failureCode(new Error("IO Error: Could not write file \"x\": No space left on device")), "ENOSPC");
  assert.equal(failureCode(new Error("public.w: writing its 2 changed row(s) by key: Conversion Error: Could not convert string 'abc' to INT32")), "conversion_error",
    "the engine's class, behind a wrapper's words");
  assert.equal(failureCode(new Error("Out of Memory Error: failed to allocate data")), "out_of_memory_error");
  assert.equal(failureCode(new TypeError("Cannot read properties of undefined")), "TypeError", "a JavaScript error's class");
  assert.equal(failureCode(new Error("Invalid Error: Failed to execute query: ERROR:  une erreur en français")), "unknown", "Postgres's words it does not know: unknown, never the wrapper's class");
  assert.equal(failureCode(new Error("something went wrong")), "unknown");
  assert.equal(failureCode("a string thrown"), "unknown");
  assert.equal(failureCode(null), "unknown");
  assert.equal(failureCode(Object.assign(new Error("x"), { code: "" })), "unknown", "never an empty code");
  // a wrapper (`cause`) is read innermost first
  const inner = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
  assert.equal(failureCode(new Error("public.t: reading its changed rows: canceling statement", { cause: inner })), "57014");
});

test("the origin: the first frame in Mason's src/, a file and a line; node_modules, node: internals, tests, the thread bridge and the error's own constructor skipped", async () => {
  const { originOf } = await facts();
  assert.equal(originOf(withStack("x", [at("src/duck/sync.ts", 1234)])), "src/duck/sync.ts:1234");
  assert.equal(originOf(withStack("x", [
    "    at Parser.parse (node:internal/streams/readable:12:3)",
    at("node_modules/@duckdb/node-api/lib/index.js", 40, "DuckDBConnection.run"),
    at("src/duck/executor.ts", 484, "RemoteConnection.run"),
    at("tests/" + "duck-poll.itest.ts", 9, "TestContext.<anonymous>"),
    `    at async Sync.poll (${pathToFileURL(path.join(ROOT, "src/duck/sync.ts")).href}:3640:11)`,
  ])), "src/duck/sync.ts:3640", "the bridge, a dependency, a node internal and a test are none of them");
  class PgLikeError extends Error {}
  assert.equal(originOf(withStack("x", [at("src/api/postgres/server.ts", 496, "new PgLikeError"), at("src/api/postgres/server.ts", 2707, "Session.execute")], new PgLikeError("x"))),
    "src/api/postgres/server.ts:2707", "where errors are made is not where this one was");
  // never a path outside Mason's source, whatever the frame
  assert.equal(originOf(withStack("x", [`    at f (${pathToFileURL(path.join(os.homedir(), "secret", "app.js")).href}:1:1)`, "    at f (/etc/passwd:1:1)", "    at <anonymous>"])), null);
  assert.equal(originOf(withStack("x", [at("src/" + "../../outside.ts", 3)])), null, "a path that leaves the root");
  // the message never reaches it, even a line of it shaped like a frame of a real file, or naming one made up
  const real = pathToFileURL(path.join(ROOT, "src/duck/sync.ts")).href;
  assert.equal(originOf(withStack(`a row's text\n    at evil (${real}:1:1)`, [])), null, "a frame-shaped line of the message is no frame");
  assert.equal(originOf(withStack(`a row's text\n    at evil (${real}:1:1)`, [at("src/duck/store.ts", 897)])), "src/duck/store.ts:897");
  assert.equal(originOf(withStack("x", [at("src/" + "secret_customer_name.ts", 1)])), null, "a file Mason does not have");
  const bare = new Error("secret row value");
  bare.stack = "Error: secret row value";
  assert.equal(originOf(bare), null, "a stack with no frame: null");
  assert.equal(originOf("a string thrown"), null);
  assert.equal(originOf(undefined), null);
  // a wrapper's own frame says what was being done; its cause, where it failed
  const cause = withStack("Conversion Error", [at("src/duck/sync.ts", 3650)]);
  assert.equal(originOf(withStack("public.t: writing", [at("src/duck/sync.ts", 3592)], new Error("public.t: writing", { cause }))), "src/duck/sync.ts:3650");
  // an error with no Mason frame of its own falls back to its wrapper's
  assert.equal(originOf(withStack("outer", [at("src/duck/sync.ts", 3592)], new Error("outer", { cause: withStack("inner", []) }))), "src/duck/sync.ts:3592");
});

test("the origin of a real throw in Mason's code is its file and line, relative, with no function name and no word of the message", async () => {
  const { originOf, originHere } = await facts();
  const { messageOf } = await import("../src/lib/secret-mask.ts");
  let caught: unknown;
  // a real frame in src/: secret-mask's messageOf over a value whose message getter throws from inside it
  try { messageOf({ toString() { throw new Error("the row's secret value"); } } as unknown as Error); } catch (e) { caught = e; }
  // the throw is in this test (a toString of the test's own), so the first Mason frame is messageOf's call of String()
  assert.match(originOf(caught) ?? "", /^src\/lib\/secret-mask\.ts:\d+$/);
  assert.doesNotMatch(originOf(caught)!, /secret value|messageOf/);
  // originHere: the caller of the function named, from inside Mason's code
  function here(): string | null { return originHere(here); }
  assert.equal(here(), null, "called from a test, no Mason frame is above it");
});
