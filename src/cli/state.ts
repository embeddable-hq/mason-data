/**
 * WHERE A PROJECT IS, SAID ONCE (the retrospective's item 3). Four bugs of two days were a command
 * meeting a state no one had run it in — a command before the run existed printed a stack, a config half-written
 * killed every command — because each command found out the state its own way. These are every state a command can
 * meet, in order, and the failure each answers with when a command needs more:
 *
 *   no_project   no .mason/ here or above                                     no_project
 *   bad_config   a .mason/config.json that cannot be read                      bad_config
 *   stopped      a project; Mason not running for it, or a run recorded
 *                that does not answer (a reboot: the pid dead, or another's)  not_running
 *   up           Mason running: its command server answers                    —
 *
 * A command declares what it needs (`CommandSpec.needs`: a project, or a run) and answers a state below it with that
 * state's CODE. Most ask `reach`, the one gate, and say the state's own words; a few word their own answer for a state
 * they handle — mason status and mason stop where Mason is not running (exit 0: that is their answer), mason logs,
 * mason start and mason doctor — and keep the state's code where they fail. tests/cli-state-matrix.test.ts (the states
 * without a run) and a run against a real Postgres (the states with one; no integration test yet) run every command in every state,
 * and hold each to the code of the state it met.
 */
import { failed, type CommandSpec, type Problem } from "./command.ts";
import { notRunning, ping, runOf, type DevRun } from "./runs.ts";
import { theProject, type Project } from "./project.ts";

/** What a command needs to do its work: a project (its files), or a run (Mason up for it). */
export type Need = "project" | "run";

/** Every state, in order, and what each meets. */
export const PROJECT_STATES = {
  no_project: { meets: null, codes: ["no_project"] },
  bad_config: { meets: null, codes: ["bad_config"] },
  stopped: { meets: "project", codes: ["not_running"] },
  up: { meets: "run", codes: [] },
} as const satisfies Record<string, { meets: Need | null; codes: readonly string[] }>;
export type ProjectState = keyof typeof PROJECT_STATES;

const RANK: Record<Need, number> = { project: 1, run: 2 };

/** Whether a command that needs `need` can work in `state`. */
export function meets(state: ProjectState, need: Need): boolean {
  const m = PROJECT_STATES[state].meets;
  return m !== null && RANK[m] >= RANK[need];
}

export type Where =
  | { state: "no_project" | "bad_config"; problem: Problem; project: null }
  | { state: "stopped"; problem: Problem; project: Project }
  | { state: "up"; project: Project; run: DevRun };

/** The state of the project a command run in `cwd` means (src/cli/project.ts theProject: the nearest). */
export async function whereIs(cwd: string = process.cwd()): Promise<Where> {
  const t = theProject(cwd);
  if ("problem" in t) return { state: t.code === "bad_config" ? "bad_config" : "no_project", problem: t, project: null };
  // ONE request says whether the run is up: its own pid answered (review of #434: a ping for each question was two per command)
  const run = runOf(t.project);
  const said = run ? await ping(run) : null;
  if (!run || said === null || said.pid !== run.pid) return { state: "stopped", problem: notRunning(t.project), project: t.project };
  return { state: "up", project: t.project, run };
}

/**
 * THE ONE GATE: the state, when it meets what `spec` needs; else its failure said (JSON under --json) and null. A
 * command's answer to "not here" is the state's, never one it words itself.
 */
export async function reach(spec: CommandSpec & { needs: Need }, json: boolean, cwd: string = process.cwd()): Promise<Where | null> {
  const w = await whereIs(cwd);
  if (meets(w.state, spec.needs)) return w;
  failed(spec.name, (w as Exclude<Where, { state: "up" }>).problem, { json });
  return null;
}
