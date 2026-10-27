/**
 * THE DOCS AND THE TRANSLATOR KEEP TO THEIR RULES: docs/POSTGRES-API.md has no bullet glued onto another line, and the
 * translator has no `default:` that accepts — every switch's fall-through throws, so a statement nobody listed is
 * refused by name, never passed through on a guess.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const doc = fs.readFileSync(path.join(ROOT, "docs", "POSTGRES-API.md"), "utf8");

// a bullet begins a line: one glued after a bold title is an edit's leftover (the review of #508: the divergences' list
// read "- **Text sorts by bytes**- **Text sorts by bytes** …"), and a reader meets it
test("no bullet of the docs starts in the middle of a line", () => {
  const glued = doc.split("\n").map((l, i) => [i + 1, l] as const).filter(([, l]) => /[^\s(]- \*\*/.test(l));
  assert.deepEqual(glued.map(([n, l]) => `${n}: ${l.slice(0, 80)}`), []);
});

test("the translator's every switch default throws: nothing unlisted is accepted", () => {
  const src = fs.readFileSync(path.join(ROOT, "src", "api", "postgres", "translate.ts"), "utf8");
  const defaults = [...src.matchAll(/^\s*default:(.*)$/gm)];
  assert.ok(defaults.length >= 1, "expected the translator's statement switch to have a default");
  for (const m of defaults) {
    const line = src.slice(0, m.index).split("\n").length;
    // the default's own line, or the next non-empty line, must throw
    const rest = src.slice(m.index! + m[0].length).split("\n").map((l) => l.trim()).filter((l) => l !== "");
    const body = `${m[1]!.trim()} ${rest[0] ?? ""}`;
    assert.match(body, /^\s*throw |^\{?\s*throw /, `translate.ts:${line}: a default branch that does not throw accepts what nobody listed`);
  }
});
