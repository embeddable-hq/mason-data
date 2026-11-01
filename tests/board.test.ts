import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// scripts/board.ts calls GitHub; what is held here is what it refuses before it calls anything: a status not on the
// board, or a command it does not know, exits 2 with the choices, so no card is ever moved to a status that is not one
const run = (...args: string[]) => spawnSync(process.execPath, ["scripts/board.ts", ...args], { encoding: "utf8", env: { ...process.env, GH_TOKEN: "none" } });

test("a status the board does not have is refused with every status it has, before GitHub is asked", () => {
  const r = run("status", "174", "Reviewing");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /"Reviewing" is no status of the board: one of "Backlog", "In progress", "Implementing", "In review", "Fixing", "CI \/ queued", "Needs Tom", "Done"/);
});

// a bug's severity is the board's Severity field (CLAUDE.md "What a session finds"): a level the field does not have is
// refused with the four it has, and the one meant when it is a typo or another case, before GitHub is asked
test("a severity the board does not have is refused with the four it has, and the one meant, before GitHub is asked", () => {
  for (const [level, meant] of [["high", "High"], ["Crtical", "Critical"], ["med", "Medium"], ["Severe", null]] as const) {
    const r = run("severity", "174", level);
    assert.equal(r.status, 2, level);
    assert.match(r.stderr, new RegExp(`^"${level}" is no severity of the board: one of "Critical", "High", "Medium", "Low"`), level);
    if (meant === null) assert.doesNotMatch(r.stderr, /did you mean/, level);
    else assert.ok(r.stderr.includes(`did you mean \`${meant}\`?`), `${level}: ${r.stderr}`);
  }
});

test("a command it does not know, or a missing argument, says how it is used", () => {
  for (const args of [["move", "174", "Done"], ["status", "174"], ["severity", "174"], ["severity", "x", "High"], ["severity", "174", "High", "Low"], ["sub", "x", "a title", "--from", "Opus 5.5"], []]) {
    const r = run(...args);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, /^usage: scripts\/board\.ts status <issue> <status> \| scripts\/board\.ts severity <issue> <Critical\|High\|Medium\|Low> \| scripts\/board\.ts sub <parent> <title> --from <model> \[<status>\]/, args.join(" "));
  }
});

test("a sub-issue is refused without the model its body names, as every posting must (CLAUDE.md \"Git workflow\")", () => {
  for (const args of [["sub", "124", "124 · a piece"], ["sub", "124", "124 · a piece", "--from"], ["sub", "124", "124 · a piece", "--from", "--x"]]) {
    const r = run(...args);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, /^sub needs --from <model>/, args.join(" "));
  }
});

test("a call to GitHub that fails says gh's words and the way out, never a stack", () => {
  const r = spawnSync(process.execPath, ["scripts/board.ts", "status", "174", "Done"], { encoding: "utf8", env: { ...process.env, PATH: "/nonexistent" } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^gh api repos\/embeddable-hq\/mason-data\/issues\/174 failed: .*gh auth refresh -h github\.com -s project/);
  assert.doesNotMatch(r.stderr, /at .*\.ts:\d+/);
  // a known severity reaches GitHub the same way, through the one call that says gh's words
  const s = spawnSync(process.execPath, ["scripts/board.ts", "severity", "174", "High"], { encoding: "utf8", env: { ...process.env, PATH: "/nonexistent" } });
  assert.equal(s.status, 1);
  assert.match(s.stderr, /^gh api repos\/embeddable-hq\/mason-data\/issues\/174 failed: .*gh auth refresh -h github\.com -s project/);
});
