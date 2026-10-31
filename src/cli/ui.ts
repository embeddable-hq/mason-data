/**
 * `mason ui` — THE WEB PAGE OF THE RUNNING MASON, IN THE BROWSER (src/web/, docs/WEB-UI.md): the Overview (what `mason
 * status` says), the Tables (`mason tables`, `add`, `remove`, `sync`), the Users (`mason user`) and Observability (`mason
 * logs`, `mason usage`), refreshed while the tab is seen. It prints the page's URL WITH the run's token (src/cli/security.ts: the first request trades it for an HttpOnly cookie and is redirected to a URL without
 * it) and opens the browser. The reader is the person at this terminal, whom `mason user add` already shows a
 * password once; the token is never written anywhere else — not in `mason start`'s output (its log is a file), not in
 * `mason status`, which prints the URL without it.
 *
 * Before it prints anything it ASKS the page (`GET /` with the run's token as the commands send it), so a run that serves
 * none (one from before the page) is said, never a URL that answers 404.
 *
 * `--ssh <user@server>` (src/cli/ui-ssh.ts, docs/WEB-UI.md "On a server") opens a server's page from this machine, through
 * the machine's own ssh, and stays in the foreground until Ctrl-C, as `mason share` does; it needs no project here. Its
 * URL carries a ticket for one use, never the run's token, which stays on the server. `--bridge` is what it runs there.
 */
import { spawn } from "node:child_process";
import { failed, jsonText, parseCommand, reportText, type CommandSpec, type NextStep } from "./command.ts";
import { reach } from "./state.ts";
import { bridge, openSshTunnel, targetProblem } from "./ui-ssh.ts";
import { version } from "./version.ts";
import { RunUnreachable } from "./control.ts";
import type { DevRun } from "./runs.ts";

const out = (m: string): void => { process.stdout.write(`${m}\n`); };
const say = (m: string): void => { process.stderr.write(`${m}\n`); };

const DEFAULT_TIMEOUT_S = 60;

export const UI: CommandSpec & { needs: "run" } = {
  needs: "run",
  name: "ui",
  summary: "the status, tables, users and statements, in your browser",
  usage: `usage: mason ui [--no-open] [--json]
       mason ui --ssh <user@server> [--mason <command>] [--timeout <seconds>] [--no-open] [--json]

  Opens the running Mason's web page in your browser, refreshed while the tab is open: the Overview (what mason status
  says: whether the synced data is ready, the database, the sync, the statements and the recent errors); the Tables (add,
  remove or sync one, as mason add, remove and sync do); the Users of mason user (add one, its password shown once with
  the URL to paste, or remove one); and Observability: the statements running and that ran (mason logs --requests,
  cancel one), usage over time (mason usage), and the sync's events (mason logs --events).

  The URL carries this run's token: the page trades it for a cookie at once and drops it from the address
  bar. It is printed for you alone, like a user's password: paste it nowhere else. Every mason start makes a new
  token, so after a restart run mason ui again.

  --ssh opens a server's page (mason serve's) from this machine, with nothing public: it runs your ssh, so your
  ~/.ssh/config, keys and SSO apply, starts mason there, and forwards a free local port to the page, which listens on the
  server's loopback alone. It stays in the foreground: Ctrl-C closes the tunnel. It needs no project here. Its URL
  carries a ticket for one use, never the run's token, which stays on the server. The server's Mason must be this
  version or close to it, and must be a command ssh can run: --mason says how, for a container or a folder.

    mason ui
    mason ui --no-open        print the URL, open no browser
    mason ui --json
    mason ui --ssh deploy@mason.example.com
    mason ui --ssh deploy@mason.example.com --mason "docker exec -i mason-mason-1 mason"
    mason ui --ssh deploy@mason.example.com --mason "cd /var/lib/mason && mason" --timeout 120 --no-open
    mason ui --bridge --local-port 51000      what --ssh runs on the server; its stdout is a stream, not for reading

  --no-open            print the URL only
  --ssh <target>       the server, as you give it to ssh: user@server, or a Host of your ssh config
  --mason <command>    how to run mason on the server (default mason); a shell's text, kept to ssh's command line
  --timeout <s>        how long ssh and the server have to answer (default ${DEFAULT_TIMEOUT_S}): a passphrase or a touch counts
  --bridge             the server's end of --ssh, on stdin and stdout
  --local-port <n>     the port the browser names, for --bridge: the laptop's
  --json               as data: { url (with this run's token; with --ssh a ticket for one use), port, server, project,
                       version (with --ssh: the server's Mason, for what its answer may lack) }, next; it never opens a
                       browser. With --ssh it then holds the tunnel: the end is on stderr, exit 0 for Ctrl-C or SIGTERM, 1 otherwise
`,
  options: { "no-open": { type: "boolean", default: false }, json: { type: "boolean", default: false }, ssh: { type: "string" }, mason: { type: "string" },
    timeout: { type: "string" }, bridge: { type: "boolean", default: false }, "local-port": { type: "string" } },
  json: ["url", "port", "server", "project", "version", "next"],
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

/**
 * THE PAGE OF A SERVER (the header): the tunnel, the URL once, and held until Ctrl-C or until it drops. As `mason share`:
 * what `--json` prints is one object, once, and everything after it is on stderr, so stdout stays one document. The
 * signals are heard before ssh starts: a Ctrl-C at a passphrase ends both.
 */
async function overSsh(target: string, mason: string, timeoutMs: number, open: boolean, json: boolean): Promise<number> {
  let signalled: NodeJS.Signals | null = null;
  const signal = new Promise<NodeJS.Signals>((resolve) => {
    const heard = (s: NodeJS.Signals): void => { signalled = s; resolve(s); };
    process.once("SIGINT", heard); process.once("SIGTERM", heard);
  });
  const t = await openSshTunnel({ target, mason, timeoutMs, interactive: !json && process.stdin.isTTY === true });
  if ("message" in t) return signalled !== null ? 0 : failed("ui", t, { json });
  const next: readonly NextStep[] = [[`mason ui --ssh ${target}`, "again, once this one is closed: a new port and a new ticket"]];
  if (json) out(jsonText(UI, { url: t.url, port: t.port, server: target, project: t.project, version: t.serverVersion }, next));
  else {
    const couldNot = open ? await openBrowser(t.url) : null;
    out(reportText({
      headline: open && couldNot === null ? `${t.project} on ${target}, opened in your browser` : `${t.project} on ${target}`,
      details: [["url", t.url], ["server", target], ["project", t.project], ["version", t.serverVersion]],
      tips: [
        ...(couldNot !== null ? [`Could not open a browser (${couldNot}): open the URL yourself.`] : []),
        ...(t.serverVersion !== version() ? [`This machine's Mason is ${version()}: the page is the server's.`] : []),
        "The URL carries a ticket for one use, and works for 5 minutes. Ctrl-C closes the tunnel.",
      ],
      next,
    }));
  }
  const how = await Promise.race([signal.then((s) => ({ signal: s })), t.ended.then((why) => ({ why }))]);
  if ("signal" in how) { await t.stop(); say(`the tunnel to ${target} is closed`); return 0; }
  return failed("ui", { message: `the tunnel to ${target} dropped`, code: "failed", why: how.why, fix: "is the server up, and this machine online? The page in your browser stops answering until a new tunnel opens one", next }, { json: false });
}

export async function ui(argv: string[]): Promise<number> {
  const f = parseCommand(UI, argv);
  if (typeof f === "number") return f;
  const json = f.values.json === true;
  const v = f.values as { ssh?: string; mason?: string; timeout?: string; bridge: boolean; "local-port"?: string; "no-open": boolean };
  const wrong = (message: string): number => failed("ui", { message, code: "usage", usage: UI.usage }, { json });
  if (f.positionals.length) return wrong(`mason ui takes no argument: ${f.positionals.join(" ")}`);
  if (v.bridge) {
    if (v.ssh !== undefined || v.mason !== undefined || v.timeout !== undefined || json) return wrong("--bridge is mason ui --ssh's own end on the server: it goes with --local-port alone");
    const port = Number(v["local-port"]);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return wrong(`--bridge needs --local-port, a port number, not ${JSON.stringify(v["local-port"] ?? "")}`);
    return bridge(port);
  }
  if (v["local-port"] !== undefined) return wrong("--local-port goes with --bridge");
  if (v.ssh === undefined && (v.mason !== undefined || v.timeout !== undefined)) return wrong(`${v.mason !== undefined ? "--mason" : "--timeout"} goes with --ssh <user@server>`);
  if (v.ssh !== undefined) {
    const problem = targetProblem(v.ssh);
    if (problem !== null) return wrong(`--ssh: ${problem}`);
    if (v.mason !== undefined && (v.mason.trim() === "" || /[\r\n]/.test(v.mason))) return wrong("--mason is one line of shell that runs mason on the server");
    const seconds = v.timeout === undefined ? DEFAULT_TIMEOUT_S : Number(v.timeout);
    if (!Number.isFinite(seconds) || seconds <= 0) return wrong(`--timeout is a number of seconds, not ${JSON.stringify(v.timeout)}`);
    return overSsh(v.ssh, v.mason ?? "mason", seconds * 1000, !v["no-open"], json);
  }
  const w = await reach(UI, json);
  if (w === null || w.state !== "up") return 1;
  const run = w.run;
  if (w.project.config.served === true) {
    return failed("ui", { message: `Mason for ${run.name} runs on this server: its page is opened from your own machine`, code: "refused",
      why: "the page listens on this machine's loopback alone, and a browser on a server has no one in front of it",
      fix: "on your machine, mason ui --ssh <user@server> (mason ui --help: for a container, --mason)", next: [["mason status", "what it is doing, in this terminal"]] }, { json });
  }
  if (!await servesPage(run)) {
    return failed("ui", { message: `Mason for ${run.name} serves no web page`, code: "refused",
      why: "this run was started by a Mason from before the page",
      fix: "mason stop && mason start runs it with the page",
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
