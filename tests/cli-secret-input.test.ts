/**
 * src/cli/secret-input.ts against a FAKE TERMINAL and a FAKE PIPE: the hidden prompt echoes nothing, puts the terminal
 * back on every way out (the answer, Ctrl-C, an empty line, the stream's end or error, a signal), and leaves no listener
 * behind; the pipe is read whole, bounded in size and time, one trailing newline trimmed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readHidden, readPiped, type SecretInput } from "../src/cli/secret-input.ts";

class FakeInput extends EventEmitter implements SecretInput {
  isTTY: boolean;
  isRaw = false;
  modes: boolean[] = [];
  paused = true;
  setRawMode?: (on: boolean) => unknown;
  constructor(tty: boolean, rawMode = true) {
    super();
    this.isTTY = tty;
    if (rawMode) this.setRawMode = (on: boolean): unknown => { this.isRaw = on; this.modes.push(on); return this; };
  }
  resume(): this { this.paused = false; return this; }
  pause(): this { this.paused = true; return this; }
  type(s: string): void { this.emit("data", Buffer.from(s, "utf8")); }
}
class FakeOutput { text = ""; write(s: string): boolean { this.text += s; return true; } }

const listeners = (e: EventEmitter): number => e.eventNames().reduce((n, x) => n + e.listenerCount(x), 0);

test("the hidden prompt: the question on the output, raw mode on while it reads and off after, nothing typed written anywhere, edits and escape sequences read as a terminal sends them", async () => {
  const cases: Array<[string[], string]> = [
    [["postgres://u:pw@h/d\r"], "postgres://u:pw@h/d"],
    [["postg", "res://u:p", "w@h/d", "\n"], "postgres://u:pw@h/d"],
    [["\x1b[200~postgres://u:pw@h/d\x1b[201~\r"], "postgres://u:pw@h/d"],
    [["abc\x7f\x7f\x7fpostgres://u:pw@h/d\x1b[D\r"], "postgres://u:pw@h/d"],
    [["junk\x15postgres://u:pw@h/d\r"], "postgres://u:pw@h/d"],
    [["pösträß\r"], "pösträß"],
  ];
  for (const [chunks, want] of cases) {
    const input = new FakeInput(true), output = new FakeOutput(), signals = new EventEmitter();
    const read = readHidden(input, output, "URL: ", 2048, signals);
    for (const c of chunks) input.type(c);
    assert.deepEqual(await read, { value: want }, JSON.stringify(chunks));
    assert.equal(output.text, "URL: \n", "the question, and a line break for the Enter that was not echoed: nothing typed");
    assert.deepEqual(input.modes, [true, false]);
    assert.equal(input.paused, true);
    assert.equal(listeners(input), 0, "no listener left on the input");
    assert.equal(listeners(signals), 0, "no listener left on the signals");
  }
});

test("the hidden prompt cancels on Ctrl-C, Ctrl-D on an empty line, an empty line, a signal or the input's end, and refuses a line past its bound read to its end; the terminal put back each time", async () => {
  const cases: Array<[(i: FakeInput, s: EventEmitter) => void, unknown]> = [
    [(i) => i.type("\x03"), { none: "cancelled" }],
    [(i) => i.type("postgres://u:secret\x03"), { none: "cancelled" }],
    [(i) => i.type("\x04"), { none: "cancelled" }],
    [(i) => i.type("\r"), { none: "empty" }],
    [(_, s) => s.emit("SIGTERM"), { none: "cancelled" }],
    [(_, s) => s.emit("SIGINT"), { none: "cancelled" }],
    [(_, s) => s.emit("SIGHUP"), { none: "cancelled" }],
    [(i) => i.emit("end"), { none: "cancelled" }],
    [(i) => { i.type("postgres://u"); i.emit("end"); }, { none: "closed" }],
    [(i) => { i.type("x".repeat(30)); i.type("y\r"); }, { none: "too_long" }],
  ];
  for (const [act, want] of cases) {
    const input = new FakeInput(true), output = new FakeOutput(), signals = new EventEmitter();
    const read = readHidden(input, output, "URL: ", 20, signals);
    act(input, signals);
    assert.deepEqual(await read, want, act.toString());
    assert.deepEqual(input.modes, [true, false], act.toString());
    assert.equal(output.text, "URL: \n");
    assert.equal(listeners(input) + listeners(signals), 0);
  }
  // the stream's error: refused, the terminal put back
  const input = new FakeInput(true), signals = new EventEmitter();
  const read = readHidden(input, new FakeOutput(), "URL: ", 20, signals);
  input.emit("error", new Error("EIO"));
  await assert.rejects(read, /EIO/);
  assert.deepEqual(input.modes, [true, false]);
  assert.equal(listeners(input) + listeners(signals), 0);
  // the process's exit while it reads puts the terminal back (the listener it leaves until then)
  const held = new FakeInput(true), exits = new EventEmitter();
  void readHidden(held, new FakeOutput(), "URL: ", 20, exits);
  exits.emit("exit");
  assert.deepEqual(held.modes, [true, false]);
  held.type("\x03");
  // a terminal already raw is left raw; one with no raw mode is refused before the question is answered
  const raw = new FakeInput(true); raw.isRaw = true;
  const r2 = readHidden(raw, new FakeOutput(), "URL: ", 20, new EventEmitter());
  raw.type("abcdefgh\r");
  assert.deepEqual(await r2, { value: "abcdefgh" });
  assert.deepEqual(raw.modes, [true]);
  await assert.rejects(readHidden(new FakeInput(true, false), new FakeOutput(), "URL: ", 20, new EventEmitter()), /cannot turn its echo off/);
});

test("the pipe: read whole, one trailing newline trimmed, empty, more than one line, past its bound or silent past its time each said by kind", async () => {
  const cases: Array<[string[], unknown]> = [
    [["postgres://u:pw@h/d\n"], { value: "postgres://u:pw@h/d" }],
    [["postgres://u:pw@h/d\r\n"], { value: "postgres://u:pw@h/d" }],
    [["postgres://u:p", "w@h/d"], { value: "postgres://u:pw@h/d" }],
    [[""], { none: "empty" }],
    [["\n"], { none: "empty" }],
    [["a\nb\n"], { none: "lines" }],
    [["a\n\n"], { none: "lines" }],
    [["x".repeat(20)], { value: "x".repeat(20) }],
    [["x".repeat(20), "\r\n"], { value: "x".repeat(20) }],
    [["x".repeat(21)], { none: "too_long" }],
    [["x".repeat(30)], { none: "too_long" }],
  ];
  for (const [chunks, want] of cases) {
    const input = new FakeInput(false);
    const read = readPiped(input, 20, 5_000);
    for (const c of chunks) input.type(c);
    input.emit("end");
    assert.deepEqual(await read, want, JSON.stringify(chunks));
    assert.equal(listeners(input), 0);
  }
  const silent = new FakeInput(false);
  assert.deepEqual(await readPiped(silent, 20, 50), { none: "timeout" });
  assert.equal(listeners(silent), 0);
});
