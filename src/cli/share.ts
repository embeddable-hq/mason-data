/**
 * `mason share`: a run on a laptop reached by a tool in the cloud, through a free tunnel service, with TLS end to end
 * between that tool and Mason (docs/POSTGRES-API.md "From a cloud BI tool"). This is the command's side: it makes the
 * password, asks the run for a socket that requires TLS (`POST /api/share`, src/cli/share-run.ts), starts the tunnel's
 * client (src/cli/tunnel.ts) pointed at that socket, prints what to type into the tool, and holds all of it in the
 * foreground: the address is temporary by nature, and a share nobody is watching is a public login nobody is watching.
 *
 * ITS CONNECTION TO THE RUN IS THE SHARE: however this process ends the run closes the share, a `kill -9` included.
 *
 * A FREE TUNNEL ENDS THE SHARE WHEN IT ENDS: there is no reconnect, because a new tunnel is a new address the person would
 * have to copy anyway; this says so and exits 1 with what to run next, and the next run gives a new address and a new
 * password. WITH A PAID TOKEN the address survives, so the client is opened again, the password unchanged, and it is said.
 *
 * WHAT `--json` PRINTS IS ONE OBJECT, ONCE, when the address is known; everything after it (a reconnect, the end and
 * why) is on stderr with the exit code, so stdout stays one document.
 */
import { once } from "node:events";
import { createInterface } from "node:readline/promises";
import { failed, jsonText, parseCommand, reportText, type CommandSpec, type Failure, type NextStep } from "./command.ts";
import { guarded, runFailure } from "./commands.ts";
import { callRun, holdRun, type HeldAnswer } from "./control.ts";
import { reach } from "./state.ts";
import { err as styleErr, out as styleOut, stepRenderer } from "./style.ts";
import { alive, type DevRun } from "./runs.ts";
import { appEnvValue } from "../lib/dotenv.ts";
import { newSharePassword, shareSecret, type OpenedShare, type ShareChoice, type ShareTunnel } from "./share-run.ts";
import { probeShare, startTunnel, sweepTunnelFiles, TOKEN_RE, TUNNELS, tunnelPlan, type OpenTunnel, type TunnelPlan, type Via } from "./tunnel.ts";

const out = (m: string): void => { process.stdout.write(`${m}\n`); };
const say = (m: string): void => { process.stderr.write(`${m}\n`); };

const DEFAULT_TIMEOUT_S = 30;
/** The first wait before a dropped tunnel is opened again, and the longest. */
const RECONNECT_FIRST_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export const SHARE: CommandSpec & { needs: "run" } = {
  needs: "run",
  name: "share",
  summary: "share the synced data with a tool outside this machine: a temporary address, TLS end to end, a password for this run",
  usage: `usage: mason share [--role <role>] [--via pinggy|bore] [--timeout <seconds>] [--json]

  For a BI tool in the cloud, which cannot reach 127.0.0.1: opens a temporary public address for this project's Postgres
  API, through a free tunnel service, and prints what to type into the tool. It stays in the foreground: Ctrl-C ends
  the share. Your local tools notice nothing: the share has a socket of its own, and no session is dropped.

  The socket requires TLS of every connection, so a service that forwards bytes cannot read them. The certificate is
  self-signed (the tool connects with sslmode=require, and checks no certificate), so a malicious service could sit in
  the middle of the handshake: this is for trying Mason, on data you may send that way. mason serve on a host is the
  way to keep a dashboard running.

  The password is made here, printed once and good for this run alone: it is kept nowhere, works on this address only,
  and is gone when the share ends. A mason user's password and an API token are refused here. What the share reads is
  one role of mason/roles.yml: --role names it; with one role in the file that one is used, and with several you are
  asked, or with --json refused with the line to run. With no roles file it reads every synced table, and says so.

  --via pinggy (the default) needs only ssh; a free tunnel ends after about an hour, and the share with it: run mason
  share again for a new address and a new password. MASON_PINGGY_TOKEN (the shell or .env, never a flag: a command
  line is visible to every user of the machine), a paid Pinggy token, keeps the address, so a tunnel that drops is opened
  again by itself, the password unchanged. --via bore needs bore (cargo install bore-cli).

    mason share
    mason share --role sales
    mason share --via bore

  --role <role>       what it reads: a role of mason/roles.yml
  --via <tunnel>      pinggy (default) or bore
  --timeout <s>       how long the tunnel has to give its address (default ${DEFAULT_TIMEOUT_S})
  --json              as data, once the address is known: { share: { host, port, database, user, password, sslmode,
                      fingerprint, role, reads, via, endsAt (ISO 8601, or null), verified (the address answered with this
                      share's certificate; false: it could not be reached from this machine) }, next }; the command
                      then holds the share: the end is on stderr, exit 0 for Ctrl-C or SIGTERM, 1 otherwise
`,
  options: { role: { type: "string" }, via: { type: "string" }, timeout: { type: "string" }, json: { type: "boolean", default: false } },
  json: ["share", "next"],
};

/** A role from what a person typed: a choice's number or its name; null for anything else. */
export function chosenRole(answer: string, choices: readonly ShareChoice[]): string | null {
  const a = answer.trim();
  const byNumber = /^\d+$/.test(a) ? choices[Number(a) - 1] : undefined;
  return byNumber?.role ?? choices.find((c) => c.role === a)?.role ?? null;
}

/** Whether a person is there to ask: a terminal both ways, and no --json (never an environment variable). */
const canAsk = (json: boolean): boolean => !json && process.stdin.isTTY === true && process.stderr.isTTY === true;

/** Asks a person which role: the answer, or null for an empty line, an end of input or something that is no choice. */
async function askRole(choices: readonly ShareChoice[]): Promise<string | null> {
  say("Which role does this share read as? Anyone with its address and password reads what it reads.");
  choices.forEach((c, i) => say(`  ${i + 1}. ${c.role}: ${c.reads}${c.default ? " (the file's default)" : ""}`));
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const closed = once(rl, "close").then(() => null);
  const answer = await Promise.race([rl.question("Role (a number or a name): "), closed]);
  rl.close();
  return answer === null ? null : chosenRole(answer, choices);
}

/** The run's refusal with its own next steps (`failure.next`, src/cli/run-server.ts sendFailure). */
function refusalOf(reply: { status: number; body: Record<string, unknown> }): Failure {
  const next = (reply.body.failure as { next?: Array<{ command: string; what?: string }> } | undefined)?.next ?? [];
  return runFailure(reply, next.map((n): NextStep => n.what === undefined ? [n.command] : [n.command, n.what]));
}

/** The share opened by the run: asked once, and again with what a person chose. */
async function openOnRun(run: DevRun, secret: string, role: string | undefined, json: boolean): Promise<HeldAnswer | Failure> {
  const asked = await holdRun(run, "/api/share", { secret, ...(role !== undefined ? { role } : {}) });
  if ("first" in asked) return asked;
  const choices = asked.body.choices as ShareChoice[] | undefined;
  if (choices === undefined || role !== undefined || !canAsk(json)) return refusalOf(asked);
  const chosen = await askRole(choices);
  if (chosen === null) return refusalOf(asked);
  const again = await holdRun(run, "/api/share", { secret, role: chosen });
  return "first" in again ? again : refusalOf(again);
}

/** `mason status`'s and the report's words for when it ends. */
function endsText(endsAt: string | null, now: number): string {
  if (endsAt === null) return "when this command ends (Ctrl-C)";
  const minutes = Math.max(0, Math.round((Date.parse(endsAt) - now) / 60_000));
  return `in about ${minutes} minutes, at ${new Date(endsAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}: the free tunnel's limit (mason share again gives a new address and a new password)`;
}

/** What a tunnel's address is checked to be, once the client gave it: the Failure when something else answers there. */
async function verified(t: OpenTunnel, fingerprint: string): Promise<boolean | Failure> {
  const probe = await probeShare(t, fingerprint);
  if (probe === "other") {
    return { message: `${t.host}:${t.port} is not this share: something else answers there`, code: "failed", why: "the tunnel printed that address, and the certificate there is not this share's: its output may have changed, or something stands in the way",
      fix: "nothing was left open. Do not connect a tool to that address", next: [["mason share --via bore", "another tunnel"]] };
  }
  return probe === "same";
}

export async function share(argv: string[]): Promise<number> {
  const f = parseCommand(SHARE, argv);
  if (typeof f === "number") return f;
  const v = f.values as { role?: string; via?: string; timeout?: string; json: boolean };
  const json = v.json;
  if (f.positionals.length) return failed("share", { message: "it takes no argument: --role names what it reads", code: "usage", usage: SHARE.usage }, { json });
  const via = (v.via ?? "pinggy") as Via;
  if (!TUNNELS.includes(via)) return failed("share", { message: `--via must be ${TUNNELS.join(" or ")}, not ${JSON.stringify(v.via)}`, code: "usage", usage: SHARE.usage }, { json });
  const timeoutS = v.timeout === undefined ? DEFAULT_TIMEOUT_S : Number(v.timeout);
  if (!Number.isFinite(timeoutS) || timeoutS <= 0) return failed("share", { message: `--timeout is a number of seconds, not ${JSON.stringify(v.timeout)}`, code: "usage" }, { json });
  const w = await reach(SHARE, json);
  if (w === null || !("run" in w)) return 1;
  const { run, project } = w;
  const token = via === "pinggy" ? appEnvValue(project.root, "MASON_PINGGY_TOKEN")?.value ?? null : null;
  if (token !== null && !TOKEN_RE.test(token)) {
    return failed("share", { message: "MASON_PINGGY_TOKEN is not a token: it holds a character no Pinggy token has", code: "usage", fix: "set it to the token as the Pinggy dashboard shows it" }, { json });
  }
  return guarded("share", json, async () => {
    sweepTunnelFiles(project.dir, alive);
    const password = newSharePassword();
    const held = await openOnRun(run, shareSecret(password), v.role, json);
    if ("message" in held) return failed("share", held, { json });
    const opened = held.first as unknown as OpenedShare;
    return holding({ run, held, opened, password, json, plan: () => tunnelPlan(via, { port: opened.port, home: project.dir, token }), timeoutMs: timeoutS * 1000 });
  });
}

interface Holding { run: DevRun; held: HeldAnswer; opened: OpenedShare; password: string; json: boolean; plan: () => TunnelPlan; timeoutMs: number }

/** The share from its socket on: the tunnel, the report, and the wait for its end. Everything is left closed on every way out. */
/** `send`, each call begun once the one before ended: an "up" must never be overtaken and set back by its "opening". */
export function inOrder<T>(send: (t: T) => Promise<void>): (t: T) => Promise<void> {
  let last = Promise.resolve();
  return (t) => (last = last.then(() => send(t)));
}

async function holding(h: Holding): Promise<number> {
  const { run, held, opened, password, json } = h;
  const tell = inOrder(async (t: ShareTunnel): Promise<void> => {
    // what mason status shows, and the run's way to stop the client: the run gone is said by `held.ended`, the share's end
    await callRun(run, "POST", `/api/share/${encodeURIComponent(opened.user)}`, t).catch((e: unknown) => say(`  the run was not told of the tunnel: ${(e as Error).message}`));
  });
  const stop = new Promise<NodeJS.Signals>((resolve) => { process.once("SIGINT", () => resolve("SIGINT")); process.once("SIGTERM", () => resolve("SIGTERM")); });
  const runEnded = held.ended.then((why) => ({ runEnded: why ?? "the connection to Mason was lost" }));
  const steps = stepRenderer({ line: (t) => { if (!json) say(t); }, live: !json && process.stderr.isTTY ? { write: (t) => { process.stderr.write(t); } } : null, style: styleErr() });
  steps.done(`A socket of its own for the share, TLS required (127.0.0.1:${opened.port})`);
  const open = async (): Promise<{ tunnel: OpenTunnel; verified: boolean } | Failure> => {
    const plan = h.plan();
    const t = await startTunnel(plan, { timeoutMs: h.timeoutMs, onPid: (pid) => { void tell({ pid, via: plan.via, state: "opening" }); } });
    if ("message" in t) return t;
    const checked = await verified(t, opened.fingerprint);
    if (typeof checked !== "boolean") { t.stop(); return checked; }
    return { tunnel: t, verified: checked };
  };
  const plan = h.plan();
  steps.begin(`Opening a tunnel (${plan.via})`);
  const opening = open();
  const first = await Promise.race([opening, stop, runEnded]);
  if (typeof first === "string" || "runEnded" in first) {
    // ended while it opened: the tunnel, if it comes, goes at once
    void opening.then((o) => { if ("tunnel" in o) o.tunnel.stop(); }).catch((e: unknown) => say(`  the tunnel: ${(e as Error).message}`));
    steps.fail();
    held.close();
    return typeof first === "string" ? 0 : failed("share", ended(first.runEnded), { json });
  }
  if ("message" in first) { steps.fail(); held.close(); return failed("share", first, { json }); }
  let tunnel = first.tunnel;
  steps.done(`Tunnel open: ${tunnel.host}:${tunnel.port}`);
  await tell({ host: tunnel.host, port: tunnel.port, endsAt: tunnel.endsAt, state: "up", pid: tunnel.pid });
  const next: NextStep[] = [["mason status", "the share, its sessions and the logins refused"], ["mason logs --requests", "what the tool asks"]];
  if (json) {
    out(jsonText(SHARE, { share: { host: tunnel.host, port: tunnel.port, database: opened.database, user: opened.user, password, sslmode: "require", fingerprint: opened.fingerprint,
      role: opened.role, reads: opened.reads, via: plan.via, endsAt: tunnel.endsAt, verified: first.verified } }, next));
  } else {
    const st = styleOut();
    out(reportText({
      headline: "Sharing the synced data with a tool outside this machine",
      details: [["host", tunnel.host], ["port", String(tunnel.port)], ["database", opened.database], ["user", opened.user], ["password", password], ["sslmode", "require"],
        ["certificate", `SHA-256 ${opened.fingerprint}`], ["reads", opened.role === null ? `${opened.reads} (this project has no roles file)` : `the role ${opened.role}: ${opened.reads}`],
        ["via", plan.via], ["ends", endsText(tunnel.endsAt, Date.now())]],
      tips: [
        "Paste it into the tool now: the password is printed this once, is kept nowhere, and ends with this command.",
        ...(opened.role === null ? ["With no roles file, anyone with this address and password reads every synced table: mason/roles.yml narrows it."] : []),
        ...(first.verified ? [] : [`${tunnel.host}:${tunnel.port} could not be reached from this machine, so it is not verified: a firewall here may be why, and a tool elsewhere may reach it.`]),
        "A self-signed certificate: a service that forwards bytes cannot read them, a malicious one could sit in the middle. For anything lasting: mason help production.",
      ],
      next,
    }, st));
    say("Holding the share: Ctrl-C ends it.");
  }
  // THE WAIT: the signal, the run, or the tunnel; a tunnel that keeps its address is opened again
  for (;;) {
    const end = await Promise.race([stop, runEnded, tunnel.ended.then((why) => ({ tunnelEnded: why }))]);
    if (typeof end === "string") {
      tunnel.stop();
      await Promise.race([tunnel.ended, new Promise((r) => setTimeout(r, 2_500).unref())]);
      held.close();
      if (json) say("The share ended.");
      else out(reportText({ headline: "The share ended: its address no longer answers, and its password no longer works", next: [["mason share", "a new address and a new password"]] }));
      return 0;
    }
    if ("runEnded" in end) { tunnel.stop(); held.close(); return failed("share", ended(end.runEnded), { json: false }); }
    if (!plan.reconnects) { held.close(); return failed("share", { ...ended(`its tunnel closed (${end.tunnelEnded})`), fix: "a free tunnel lasts about an hour: the address is gone, and the password no longer works" }, { json: false }); }
    const again = await reconnect({ open, tell, why: end.tunnelEnded, stop, runEnded, was: tunnel });
    if (again === null) continue;   // a signal or the run's end: the next turn of the loop reads it
    tunnel = again;
  }
}

/** The share's end as a failure: what ended it, and the one way on. */
const ended = (why: string): Failure => ({ message: `the share ended: ${why}`, code: "failed", next: [["mason share", "a new address and a new password"]] });

/** Opens a dropped tunnel again until it is up, saying so each time; null when a signal or the run's end came first. */
async function reconnect(o: { open: () => Promise<{ tunnel: OpenTunnel; verified: boolean } | Failure>; tell: (t: ShareTunnel) => Promise<void>; why: string; stop: Promise<unknown>; runEnded: Promise<unknown>; was: OpenTunnel }): Promise<OpenTunnel | null> {
  say(`The tunnel dropped (${o.why}): opening it again; the password stays the same.`);
  await o.tell({ state: "reconnecting" });
  let waitMs = RECONNECT_FIRST_MS;
  for (;;) {
    const waited = await Promise.race([new Promise((r) => setTimeout(() => r("waited"), waitMs).unref()), o.stop.then(() => "ended"), o.runEnded.then(() => "ended")]);
    if (waited === "ended") return null;
    const opening = o.open();
    const got = await Promise.race([opening, o.stop.then(() => null), o.runEnded.then(() => null)]);
    if (got === null) {
      void opening.then((a) => { if ("tunnel" in a) a.tunnel.stop(); }).catch((e: unknown) => say(`  the tunnel: ${(e as Error).message}`));
      return null;
    }
    if ("tunnel" in got) {
      const t = got.tunnel;
      const moved = t.host !== o.was.host || t.port !== o.was.port;
      say(moved ? `Reconnected, at a NEW address: host ${t.host}, port ${t.port}. The password is the same; the tool needs the new host and port.` : `Reconnected: ${t.host}:${t.port}, the same address and password.`);
      await o.tell({ host: t.host, port: t.port, endsAt: t.endsAt, state: "up", pid: t.pid });
      return t;
    }
    say(`  not yet: ${got.message}${got.why ? ` (${got.why})` : ""}; trying again in ${waitMs / 1000} s`);
    waitMs = Math.min(waitMs * 2, RECONNECT_MAX_MS);
  }
}
