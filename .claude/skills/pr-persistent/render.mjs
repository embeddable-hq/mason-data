// pr-persistent's render: replays the pinned pr-loop-slim.js beside this file against answers.json, and writes the
// prompt of each stage it starts next to next/<name>.md. The run folder is the folder this file sits in (SKILL.md
// pins it there), so it reads nothing from a checkout and needs no environment.
//
// stdout is control lines only, because the coordinator reads it and forwards nothing (issue 304):
//   STAGE "<label>" (<phase>) <options JSON>: <run>/next/<name>.md   a stage to start; its prompt is in that file
//   NULL "<label>": <why>                                            a recorded answer read as null, a failed agent
//   DONE: <status>                                                   the run is over; result.json holds its result
// A real failure (a bad answers.json, a thrown error) exits 1 with ONE stderr line: what is wrong, and what to do.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const RUN = path.dirname(url.fileURLToPath(import.meta.url));
/** A failure the coordinator must fix before the render can say anything. */
class Refused extends Error {}

const name = (label) => label.replace(/[^a-z0-9]+/gi, "-").replace(/-$/, "");
/** Where the agent of `label` writes its result: the one value answers.json may record for it, beside null. */
const resultPath = (label) => path.join(RUN, "results", `${name(label)}.json`);

function readJson(file, what) {
  const at = path.join(RUN, file);
  let text;
  try {
    text = fs.readFileSync(at, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") throw new Refused(`${at} does not exist: ${what}`);
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Refused(`${at} is not JSON (${e.message}): ${what}`);
  }
}

// An answer is read as the Workflow tool reads an agent's result: one that fails the schema its agent() call carries
// is null, the result of an agent that failed. Why it failed is the first thing printed.
const problem = (v, s, at) => {
  if (s.enum && !s.enum.includes(v)) return `${at} is ${JSON.stringify(v)}, not one of ${s.enum.join(", ")}`;
  const min = (x) => (s.minimum !== undefined && x < s.minimum ? `${at} is below ${s.minimum}` : null);
  switch (s.type) {
    case "object": {
      if (!v || typeof v !== "object" || Array.isArray(v)) return `${at} is not an object`;
      const gone = (s.required ?? []).find((k) => !Object.hasOwn(v, k));
      if (gone) return `${at}.${gone} is missing`;
      for (const [k, p] of Object.entries(s.properties ?? {})) { const w = Object.hasOwn(v, k) ? problem(v[k], p, `${at}.${k}`) : null; if (w) return w; }
      return null;
    }
    case "array": {
      if (!Array.isArray(v)) return `${at} is not an array`;
      for (const [i, x] of v.entries()) { const w = s.items ? problem(x, s.items, `${at}[${i}]`) : null; if (w) return w; }
      return null;
    }
    case "string": return typeof v === "string" ? null : `${at} is not a string`;
    case "number": return typeof v === "number" && Number.isFinite(v) ? min(v) : `${at} is not a number`;
    case "integer": return Number.isInteger(v) ? min(v) : `${at} is not an integer`;
    case "boolean": return typeof v === "boolean" ? null : `${at} is not a boolean`;
    default: return null;
  }
};

/** The answer recorded for `label`, read from the file its agent wrote: null when the agent failed, wrote no file, or
 * wrote one that is not JSON or fails the stage's schema, each said on a NULL line. */
function answerOf(label, schema, recorded) {
  if (recorded === null) return null;
  const nul = (why) => { console.log(`NULL ${JSON.stringify(label)}: ${why}; read as null, an agent that failed, as the Workflow tool would`); return null; };
  let text;
  try {
    text = fs.readFileSync(recorded, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return nul(`the result file ${recorded} does not exist`);
    throw e;
  }
  let a;
  try {
    a = JSON.parse(text);
  } catch (e) {
    return nul(`the result file ${recorded} is not JSON (${String(e.message).replace(/\s+/g, " ")})`);
  }
  const why = a === null || !schema ? null : problem(a, schema, "answer");
  return why ? nul(why) : a;
}

async function main() {
  const args = readJson("args.json", "write the run's args (SKILL.md, step 1) beside render.mjs");
  const answers = readJson("answers.json", "it maps each stage's label to its results path, or to null when its agent failed: write {} to start");
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    throw new Refused(`${path.join(RUN, "answers.json")} is not an object: it maps each stage's label to its results path, or to null when its agent failed`);
  }
  // The coordinator records a path, never the JSON: a value that is not exactly its label's results path (the JSON
  // itself, or another stage's file) would be read as another answer, silently, so it is refused before anything runs.
  for (const [label, v] of Object.entries(answers)) {
    if (v === null || v === resultPath(label)) continue;
    const shown = JSON.stringify(v) ?? String(v);
    throw new Refused(`answers.json records ${JSON.stringify(label)} as ${shown.length > 80 ? `${shown.slice(0, 77)}...` : shown}: record the results path ${resultPath(label)} (or null when the agent failed), never the JSON nor another stage's path, then render again`);
  }
  let src;
  try {
    src = fs.readFileSync(path.join(RUN, "pr-loop-slim.js"), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") throw new Refused(`${path.join(RUN, "pr-loop-slim.js")} does not exist: PIN pr-loop-slim.js into the run folder (SKILL.md, step 1)`);
    throw e;
  }
  if (!/^export const meta = /.test(src)) throw new Refused("the pinned pr-loop-slim.js no longer begins with `export const meta`: fix render.mjs to load it as the Workflow tool does");
  const run = new (Object.getPrototypeOf(async () => {}).constructor)("args", "agent", "phase", "log", "workflow", "parallel", src.replace(/^export const meta/, "const meta"));

  const STOP = Symbol("stop"), next = [];
  const agent = async (prompt, opts) => {
    if (Object.hasOwn(answers, opts.label)) return answerOf(opts.label, opts.schema, answers[opts.label]);
    next.push({ prompt, opts });
    throw STOP;
  };
  const parallel = (thunks) => Promise.all(thunks.map((t) => t()));
  fs.rmSync(path.join(RUN, "next"), { recursive: true, force: true });
  fs.mkdirSync(path.join(RUN, "next"));
  fs.mkdirSync(path.join(RUN, "results"), { recursive: true });
  try {
    const result = await run(args, agent, () => {}, () => {}, () => { throw new Error("pr-loop-slim calls no workflow"); }, parallel);
    fs.writeFileSync(path.join(RUN, "result.json"), JSON.stringify(result, null, 2));
    console.log(`DONE: ${result.status}`);
  } catch (e) {
    if (e !== STOP) throw e;
    for (const { prompt, opts } of next) {
      const { label, phase, schema, ...on } = opts;
      const file = path.join(RUN, "next", `${name(label)}.md`);
      fs.writeFileSync(file, `${prompt}\n\nBefore you end your turn, write your result, ONE JSON value matching this schema (the Workflow tool enforces it on pr-loop-slim's agents), to ${resultPath(label)}, and end your report with that path. The schema: ${JSON.stringify(schema)}`);
      console.log(`STAGE ${JSON.stringify(label)} (${phase}) ${JSON.stringify(on)}: ${file}`);
    }
  }
}

try {
  await main();
} catch (e) {
  // ONE line, so the coordinator reads the failure without a stack: a refusal says what to do; anything else is a
  // fault of the pinned script or of this render, said as such.
  const what = e instanceof Refused ? e.message : `replaying the pinned pr-loop-slim.js threw ${String(e?.stack ?? e).split("\n").slice(0, 2).map((s) => s.trim()).join(" ")}: read that line of the pinned copy, and fix the answer it read or render.mjs`;
  process.stderr.write(`render.mjs: ${what}\n`);
  process.exitCode = 1;
}
