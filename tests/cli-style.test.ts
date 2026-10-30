/**
 * Colour, width and the spinner (src/cli/style.ts: colour to make output easier to read and scan, and a loading
 * indicator for any command that does not answer at once): styled only for a person at a terminal, never for a pipe, a
 * file or a coding agent.
 */
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as assert from "node:assert/strict";
import { colourOn, PLAIN, spinUntilOutput, styleFor, visibleLength, wrap } from "../src/cli/style.ts";
import { nextBlock, reportText } from "../src/cli/command.ts";
import { topUsage } from "../src/cli/registry.ts";

test("colour only at a terminal; NO_COLOR turns it off, FORCE_COLOR on", () => {
  assert.equal(colourOn({ isTTY: true }, {}), true);
  assert.equal(colourOn({ isTTY: false }, {}), false, "a pipe, a file, a coding agent's shell");
  assert.equal(colourOn({}, {}), false);
  assert.equal(colourOn({ isTTY: true }, { NO_COLOR: "1" }), false, "https://no-color.org");
  assert.equal(colourOn({ isTTY: false }, { FORCE_COLOR: "1" }), true);
  assert.equal(colourOn({ isTTY: true }, { FORCE_COLOR: "0" }), true, "FORCE_COLOR=0 forces nothing");
  assert.equal(styleFor({ isTTY: false, columns: 80 }, {}).width, null, "never wrapped off a terminal");
  assert.equal(styleFor({ isTTY: true, columns: 100 }, {}).width, 100);
  assert.equal(styleFor({ isTTY: true, columns: 100 }, {}).cyan("x"), "\x1b[36mx\x1b[39m");
  assert.equal(styleFor({ isTTY: true, columns: 100 }, { NO_COLOR: "1" }).cyan("x"), "x", "no colour, still the width");
});

test("wrap: at the width, every line after the first under its column; a long word whole; no width, one line", () => {
  assert.equal(wrap("one two three four five", null, 4), "one two three four five");
  assert.equal(wrap("aaaa bbbb cccc dddd", 30, 10, 10), "aaaa bbbb cccc dddd");
  // 40 wide, 10 used before the first line and under it: 29 to a line
  assert.equal(wrap("aaaa bbbb cccc dddd eeee ffff gggg", 40, 10), "aaaa bbbb cccc dddd eeee ffff\n          gggg");
  assert.equal(wrap("aaaa bbbb cccc dddd eeee ffff gggg hhhh", 40, 10, 20), "aaaa bbbb cccc dddd\n          eeee ffff gggg hhhh", "a first line that starts further in holds less");
  assert.equal(visibleLength("\x1b[1mbold\x1b[22m"), 4);
});

test("mason --help on a terminal: the steps bold, the commands cyan, a summary wrapped under its own column", () => {
  const s = styleFor({ isTTY: true, columns: 90 }, {});
  const text = topUsage(s);
  assert.match(text, /\n {2}\x1b\[1mSet up\x1b\[22m\n/);
  assert.match(text, /\n {4}\x1b\[36mmason init {3}\x1b\[39m {3}\x1b\[2mmake this folder a Mason project/);
  const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
  for (const line of plain.split("\n")) assert.ok(line.length <= 90, `wider than the terminal: ${line}`);
  // a summary's next line starts under the summaries, never under the command names
  assert.match(plain, /\n {4}mason init {6}make this folder a Mason project on your Postgres: mason init \(its\n {20}URL from \.env\)/);
  assert.equal(topUsage(PLAIN), topUsage(PLAIN).replace(/\x1b/g, ""), "plain has no codes");
});

test("Next: and a report on a terminal: Next and the headline bold, commands cyan, what they do dim", () => {
  const s = styleFor({ isTTY: true, columns: 100 }, {});
  assert.equal(nextBlock([["mason wait", "until it is done"]], s), `\n\x1b[1mNext:\x1b[22m\n  \x1b[36m${"mason wait".padEnd(44)}\x1b[39m  \x1b[2muntil it is done\x1b[22m`);
  assert.match(reportText({ headline: "Added x", details: [["copy", "starts now"]] }, s), /^\x1b\[1mAdded x\x1b\[22m\n {2}\x1b\[2mcopy\x1b\[22m {3}starts now$/);
  assert.equal(nextBlock([["mason wait", "until it is done"]], PLAIN), `\nNext:\n  ${"mason wait".padEnd(44)}  until it is done`);
});

/** A stream as the spinner sees one: what was written to it, in order. */
function fake(isTTY: boolean): { isTTY: boolean; written: string[]; write: (t: string) => boolean } {
  const s = { isTTY, written: [] as string[], write: (t: string): boolean => { s.written.push(t); return true; } };
  return s;
}

test("the spinner: on a terminal, after the delay, until the command's first output, cleared before it — drawn by a thread a blocked command cannot starve", async () => {
  const out = fake(false), err = fake(true);
  const writeOut = out.write;
  const file = path.join(os.tmpdir(), `mason-spinner-${process.pid}.txt`);
  const fd = fs.openSync(file, "w+");
  let stop = (): void => {};
  try {
    stop = spinUntilOutput("mason tables", { delayMs: 10, out, err, env: { NO_COLOR: "1" }, fd });
    // THE COMMAND BLOCKS THE EVENT LOOP (mason list showed no spinner: it spawnSyncs
    // docker): the frames must land anyway. Busy until two are drawn: the worker starts in ~100 ms here, far later on a
    // loaded machine (npm test runs the files side by side), so the deadline is generous and the wait ends at the frames
    const until = Date.now() + 10_000;
    const second = /⠙ mason tables/;
    while (Date.now() < until && !second.test(fs.readFileSync(file, "utf8"))) { /* busy: no timer on this thread runs */ }
    const drawn = fs.readFileSync(file, "utf8");
    assert.match(drawn, /^\r\x1b\[2K⠋ mason tables …\r\x1b\[2K⠙ mason tables …/, "the first frames, while the main thread was busy");
    out.write("NAME  STATE\n");
    assert.match(fs.readFileSync(file, "utf8"), /\r\x1b\[2K$/, "cleared before the output");
    assert.deepEqual(out.written, ["NAME  STATE\n"]);
    assert.equal(out.write, writeOut, "the stream's own write is back");
    const size = fs.fstatSync(fd).size;
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(fs.fstatSync(fd).size, size, "no frame after the output");
  } finally {
    // stopped whatever was asserted: a worker left drawing writes into the next file to take this fd's number
    stop();
    fs.closeSync(fd); fs.rmSync(file, { force: true });
  }
});

test("the spinner: none for a command that answers at once, and none off a terminal", async () => {
  const quick = { out: fake(false), err: fake(true) };
  const file = path.join(os.tmpdir(), `mason-spinner-quick-${process.pid}.txt`);
  const fd = fs.openSync(file, "w+");
  try {
    spinUntilOutput("mason help", { delayMs: 50, ...quick, fd })();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(fs.readFileSync(file, "utf8"), "", "stopped before the delay: nothing drawn, nothing to clear");
  } finally { fs.closeSync(fd); fs.rmSync(file, { force: true }); }
  const piped = { out: fake(false), err: fake(false) };
  const stop = spinUntilOutput("mason tables", { delayMs: 5, ...piped });
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(piped.err.written, [], "a pipe never sees one");
  stop();
});
