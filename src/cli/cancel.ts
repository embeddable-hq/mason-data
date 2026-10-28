/**
 * `mason cancel <session>`: stops the statement a session of the Postgres API is running, exactly as a client's own
 * cancel (the protocol's CancelRequest) stops it — the listener's one path (src/api/postgres/server.ts `interrupt`),
 * through the run's `POST /api/cancel` (src/cli/run-server.ts). The client is told 57014 "canceling statement due to
 * user request", and the request log records it as cancelled. `mason logs --running` lists the sessions.
 */
import { failed, jsonText, parseCommand, reportText, type CommandSpec, type NextStep } from "./command.ts";
import { out as styleOut } from "./style.ts";
import { callRun } from "./control.ts";
import { reach } from "./state.ts";
import { guarded, oneLine, runFailure, spanText } from "./commands.ts";
import type { RunningStatement } from "../api/postgres/server.ts";

const out = (m: string): void => { process.stdout.write(`${m}\n`); };

export const CANCEL_USAGE = `usage: mason cancel <session> [--statement <n>] [--json]

  Stops the statement a session of the Postgres API is running now, as the client's own cancel would: the client is
  told "canceling statement due to user request" (SQLSTATE 57014), its session stays open, and the request log keeps
  the statement as cancelled. mason logs --running lists the statements running now, with their sessions and numbers.

    mason logs --running
    mason cancel 12 --statement 340
    mason cancel 12

  --statement <n>   only that statement (its number in mason logs --running): if it ended and the session runs
                    another, nothing is cancelled and the answer says so. Without it, whatever the session runs now
                    is stopped, as a client's own cancel stops it.
  --json            as data: { cancelled: { session, statement, user, applicationName, method, startedAt, runningMs,
                    rows, query, queryTruncated } (the statement it stopped), next }
`;

export const CANCEL: CommandSpec & { needs: "run" } = {
  needs: "run",
  name: "cancel",
  summary: "stop the statement a session of the Postgres API is running, as the client's cancel would: mason cancel 12",
  usage: CANCEL_USAGE,
  options: { statement: { type: "string" }, json: { type: "boolean" } },
  json: ["cancelled", "next"],
};

export async function cancel(argv: string[]): Promise<number> {
  const f = parseCommand(CANCEL, argv);
  if (typeof f === "number") return f;
  const json = f.values.json === true;
  const running: NextStep = ["mason logs --running", "the statements running now, with their sessions"];
  if (f.positionals.length !== 1 || !/^[1-9]\d*$/.test(f.positionals[0]!)) {
    return failed("cancel", { message: f.positionals.length === 0 ? "name the session: mason cancel <session>" : `${f.positionals.join(" ")} is not a session's number`,
      code: "usage", fix: "mason logs --running lists each statement running with its session", next: [running], usage: CANCEL_USAGE }, { json });
  }
  const session = Number(f.positionals[0]);
  const statement = f.values.statement;
  if (statement !== undefined && (typeof statement !== "string" || !/^[1-9]\d*$/.test(statement))) {
    return failed("cancel", { message: `--statement ${String(statement)} is not a statement's number`, code: "usage",
      fix: "mason logs --running lists each statement running with its number", next: [running], usage: CANCEL_USAGE }, { json });
  }
  const w = await reach(CANCEL, json);
  if (w === null || !("run" in w)) return 1;
  const run = w.run;
  return guarded("cancel", json, async () => {
    const r = await callRun(run, "POST", "/api/cancel", { session, ...(statement !== undefined ? { statement: Number(statement) } : {}) });
    if (r.status !== 200) return failed("cancel", runFailure(r, [running]), { json });
    const c = (r.body as { cancelled: RunningStatement }).cancelled;
    const next: NextStep[] = [[`mason logs --requests --outcome cancelled -n 5`, "the statements cancelled, this one among them once it ended"], running];
    if (json) { out(jsonText(CANCEL, { cancelled: c }, next)); return 0; }
    out(reportText({
      headline: `Cancelled session ${c.session}'s statement: it ends now, and its client is told so (57014).`,
      details: [["Statement", oneLine(c.query) || "(no statement)"], ["Client", `${c.applicationName || "(no application_name)"}${c.user ? ` (user ${c.user})` : ""}`],
        ["Running", `${spanText(c.runningMs / 1000)}, ${c.rows.toLocaleString("en-US")} row${c.rows === 1 ? "" : "s"} sent`]],
      next,
    }, styleOut()));
    return 0;
  });
}
