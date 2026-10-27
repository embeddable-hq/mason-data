/**
 * `mason ui` — THE WEB PAGE OF THE RUNNING MASON, IN THE BROWSER (src/web/, docs/WEB-UI.md): what `mason status` says,
 * refreshed while the tab is seen, and the users of `mason user`. It prints the page's URL WITH the run's token (src/cli/security.ts: the first request trades it for an HttpOnly cookie and is redirected to a URL without
 * it) and opens the browser. The reader is the person at this terminal, whom `mason user add` already shows a
 * password once; the token is never written anywhere else — not in `mason start`'s output (its log is a file), not in
 * `mason status`, which prints the URL without it.
 *
 * Before it prints anything it ASKS the page (`GET /` with the run's token as the commands send it), so a run that serves
 * none (`mason serve`'s, or one from before the page) is said, never a URL that answers 404.
 */
import { spawn } from "node:child_process";
import { failed, jsonText, parseCommand, reportText, type CommandSpec, type NextStep } from "./command.ts";
import { reach } from "./state.ts";
import { RunUnreachable } from "./control.ts";
import type { DevRun } from "./runs.ts";

const out = (m: string): void => { process.stdout.write(`${m}\n`); };

export const UI: CommandSpec & { needs: "run" } = {
  needs: "run",
  name: "ui",
  summary: "the status page and the users, in your browser",
  usage: `usage: mason ui [--no-open] [--json]

  Opens the running Mason's web page in your browser: what mason status says (the database, each table's copy and
  its progress, the slow and refused statements, whether it is ready), refreshed every 2 s while the tab is open, and
  the users of mason user — add one (its password shown once, with the URL to paste) or remove one.

  The URL carries this run's token: the page trades it for a cookie at once and drops it from the address
  bar. It is printed for you alone, like a user's password: paste it nowhere else. Every mason start makes a new
  token, so after a restart run mason ui again. The page is mason start's: mason serve serves none (off this
  machine it would need TLS and a login).

    mason ui
    mason ui --no-open        print the URL, open no browser
    mason ui --json

  --no-open   print the URL only
  --json      as data: { url (with this run's token), port }, next; it never opens a browser
`,
  options: { "no-open": { type: "boolean", default: false }, json: { type: "boolean", default: false } },
  json: ["url", "port", "next"],
};

const NEXT: readonly NextStep[] = [["mason status", "the same, in this terminal"], ["mason user list", "the users"]];

/** The command that opens a URL in the person's browser, by platform (macOS `open`, Windows `start`, else `xdg-open`). */
export function openCommand(platform: NodeJS.Platform, url: string): [command: string, args: string[]] {
  if (platform === "darwin") return ["open", [url]];
  // start's first quoted argument is a window title: "" so the URL is the thing started
  if (platform === "win32") return ["cmd", ["/c", "start", "", url]];
  return ["xdg-open", [url]];
}

/** Open `url` in the browser: null once the opener started, else why it could not (the URL is printed either way). */
function openBrowser(url: string): Promise<string | null> {
  const [command, args] = openCommand(process.platform, url);
  return new Promise((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", (e) => resolve(`${command}: ${e.message}`));
    child.once("spawn", () => { child.unref(); resolve(null); });
  });
}

/** Whether the run serves the page: its `GET /` answered, with the token the commands send. */
async function servesPage(run: DevRun): Promise<boolean> {
  let res: Response;
  try { res = await fetch(`${run.control.url}/`, { headers: { Authorization: `Bearer ${run.control.token}` }, signal: AbortSignal.timeout(10_000) }); }
  catch (e) {
    throw new RunUnreachable(`Mason for ${run.name} (pid ${run.pid}) does not answer at ${run.control.url}`, (e as { cause?: { code?: string } }).cause?.code ?? (e as Error).message);
  }
  await res.arrayBuffer();
  return res.status === 200 && /^text\/html/.test(res.headers.get("content-type") ?? "");
}

export async function ui(argv: string[]): Promise<number> {
  const f = parseCommand(UI, argv);
  if (typeof f === "number") return f;
  const json = f.values.json === true;
  if (f.positionals.length) return failed("ui", { message: `mason ui takes no argument: ${f.positionals.join(" ")}`, code: "usage", usage: UI.usage }, { json });
  const w = await reach(UI, json);
  if (w === null || w.state !== "up") return 1;
  const run = w.run;
  if (!await servesPage(run)) {
    return failed("ui", { message: `Mason for ${run.name} serves no web page`, code: "refused",
      why: "the page is mason start's: this is mason serve's run, or a run started by a Mason from before the page",
      fix: "on your machine, mason stop && mason start runs it with the page; a server's Mason is read with mason status",
      next: [["mason status", "what it is doing, in this terminal"]] }, { json });
  }
  const url = `${run.control.url}/?token=${encodeURIComponent(run.control.token)}`;
  const port = Number(new URL(run.control.url).port);
  if (json) { out(jsonText(UI, { url, port }, NEXT)); return 0; }
  const couldNot = f.values["no-open"] === true ? null : await openBrowser(url);
  const opened = f.values["no-open"] !== true && couldNot === null;
  out(reportText({
    headline: opened ? `Mason's web page, opened in your browser` : `Mason's web page`,
    details: [["url", url], ["project", run.name]],
    tips: [
      ...(couldNot !== null ? [`Could not open a browser (${couldNot}): open the URL yourself.`] : []),
      "The URL carries this run's token, traded for a cookie on the first visit: paste it nowhere else. After a restart, mason ui again.",
    ],
    next: NEXT,
  }));
  return 0;
}
