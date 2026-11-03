/**
 * `mason login` AND `mason logout` — THIS MACHINE SIGNED IN TO A HOSTED MASON SERVICE (docs/HOSTED-API.md). They need
 * no project: a login is the person's, kept in their own config folder (src/cli/credentials.ts), never in a project.
 *
 * `mason login` is OAuth's device authorization grant (RFC 8628; src/cli/hosted.ts speaks it): it asks the service for
 * a code, says where to approve it — at once, on stderr, in plain lines, so a person in a terminal and a coding agent
 * relaying it both read it before the wait begins (a browser opens on a terminal, when one can) — polls at the
 * service's interval (five seconds more at each `slow_down`) until the code is approved, denied or expires, then asks
 * who signed in (`GET /v1/me`) and saves the token. Its answer is ONE report on stdout, or under `--json` ONE object,
 * once, when it ends: what it prints while waiting is progress, on stderr.
 *
 * `mason logout` revokes the saved token (best effort: a service that cannot be reached is said, with the way to revoke
 * it by hand) and removes the saved login either way.
 *
 * A TOKEN NEVER REACHES A COMMAND LINE, A LOG, THE OUTPUT OR `--json`: there is no flag that takes one; `MASON_TOKEN` is
 * read from the environment and never printed; and everything printed from the service is masked (`serviceText`).
 * `MASON_TOKEN` comes before a saved login (CI), so `mason login` with it set is refused, naming how to sign in anyway,
 * and `mason logout` says it cannot remove an environment variable.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { endText, failed, jsonText, parseCommand, reportText, serviceStyle, strict, type CommandSpec, type Failure, type NextStep } from "./command.ts";
import { environmentToken, readLogins, TOKEN_ENV, writeLogins, type Logins } from "./credentials.ts";
import { DEFAULT_SERVICE_URL, expired, isFailure, pollToken, revoke, serviceOf, serviceText, startDevice, whoAmI, type DeviceCode, type Me, type Service } from "./hosted.ts";
import { err as styleErr, out as styleOut, stepRenderer, type Style } from "./style.ts";
import { openBrowser } from "./ui.ts";

const out = (m: string): void => { process.stdout.write(`${m}\n`); };
/** Everything these commands print can hold the service's text, so it is drawn in serviceStyle (src/cli/command.ts):
 *  on a terminal the CLI breaks every line itself, and a person never sees a line begin with what the service sent. */
const outStyle = (): Style => serviceStyle(styleOut());
const errStyle = (): Style => serviceStyle(styleErr());
const fail = (cmd: "login" | "logout", f: Failure, o: { json: boolean }): number => failed(cmd, f, { json: o.json, style: errStyle() });
const say = (m: string): void => { process.stderr.write(`${m}\n`); };

export const LOGIN: CommandSpec = {
  name: "login",
  summary: "sign this machine in to a hosted Mason service, by a code you approve in your browser",
  usage: `usage: mason login [--json]

  Signs this machine in to a hosted Mason service: it prints a page and a code, opens the page in your browser
  when it runs in a terminal, and waits while you sign in there and approve the code (until the code expires, as
  the service says; Ctrl-C stops it). It then says who is signed in and their organisations, and keeps the login in
  ~/.config/mason/credentials.json ($XDG_CONFIG_HOME/mason/ when that is set), readable by you alone, never in a
  project. Signing in again replaces this machine's login to that service, and revokes the one it replaces.

  The page and the code are printed on stderr at once, as plain lines, so a coding agent can pass them on to you
  before the wait ends; the answer is printed when it ends.

  The service is ${DEFAULT_SERVICE_URL} unless MASON_CLOUD_URL names another (https://, or http:// for one on
  this machine). With MASON_TOKEN set (CI), every command uses that token before a saved login, so mason login is
  refused: run it without the variable (env -u MASON_TOKEN mason login) to sign in anyway.

    mason login
    MASON_CLOUD_URL=http://127.0.0.1:8080 mason login     a service on this machine

  --json    as data, once signed in: { service (its address), email, name, orgs: [{ slug, name, role }], file (where
            the login is kept), replaced (null, or the login it replaced: { email, revoked }), next }
`,
  options: { json: { type: "boolean", default: false } },
  json: ["service", "email", "name", "orgs", "file", "replaced", "next"],
};

export const LOGOUT: CommandSpec = {
  name: "logout",
  summary: "sign this machine out of a hosted Mason service: its login revoked and removed",
  usage: `usage: mason logout [--json]

  Signs this machine out of the hosted Mason service (MASON_CLOUD_URL, else ${DEFAULT_SERVICE_URL}): it revokes
  the login on the service, then removes it from ~/.config/mason/credentials.json. When the service cannot be
  reached the login is still removed here, and it says the login was NOT revoked and how to revoke it: sign in to
  the service's web app and revoke it there. Logins to other services stay.

  MASON_TOKEN in the environment is not a saved login: logout cannot remove it, and says so while it is set.

    mason logout
    MASON_CLOUD_URL=http://127.0.0.1:8080 mason logout    a service on this machine

  --json    as data: { service, signedOut (a saved login was removed), email (its account, null when there was
            none), revoked (true, false when the service did not take it, null when there was nothing to revoke),
            revokeError (why not, else null), environmentToken (MASON_TOKEN is set, and still used), file, next }
`,
  options: { json: { type: "boolean", default: false } },
  json: ["service", "signedOut", "email", "revoked", "revokeError", "environmentToken", "file", "next"],
};

/** Where a person may approve the code, for the browser to open: a plain https (or this machine's http) URL, and none
 *  of the characters a shell or `cmd /c start` reads (the service's URL is not ours). */
const OPENABLE = /^https?:\/\/[A-Za-z0-9.:[\]-]+(?:\/[A-Za-z0-9._~/?=+-]*)?$/;

/** An organisation as a line: its slug, its name when it says more, the role. */
const orgLine = (o: Me["orgs"][number]): string => `${o.slug}${o.name && o.name !== o.slug ? ` (${o.name})` : ""}, ${o.role}`;

export async function login(argv: string[]): Promise<number> {
  const f = parseCommand(LOGIN, argv);
  if (typeof f === "number") return f;
  const json = f.values.json === true;
  if (f.positionals.length) return fail("login", { message: "it takes no argument", code: "usage", why: "the service is MASON_CLOUD_URL's, else the default", usage: LOGIN.usage }, { json });
  const service = serviceOf();
  if (isFailure(service)) return fail("login", service, { json });
  if (environmentToken() !== null) {
    return fail("login", { message: `${TOKEN_ENV} is set in this environment, so a login would not be used`, code: "refused",
      why: `every command sends ${TOKEN_ENV} before a saved login: a new login to ${service.base} would be shadowed by it`,
      fix: `to sign in anyway, run it without the variable: env -u ${TOKEN_ENV} mason login (the login is used once ${TOKEN_ENV} is unset)`,
      next: [[`env -u ${TOKEN_ENV} mason login`, "sign in, for when MASON_TOKEN is unset"]] }, { json });
  }
  // the file is checked BEFORE the person spends a minute approving a code: a folder others can read is said now
  const before = readLogins();
  if (isFailure(before)) return fail("login", before, { json });

  // what this command holds that the service may echo before it sends a token: the login it replaces (src/cli/hosted.ts
  // `carriesNoSecret`: an answer that carries it is refused whole)
  const held = before.logins.logins[service.base] ? [before.logins.logins[service.base]!.token] : [];
  const code = await startDevice(service, held);
  if (isFailure(code)) return fail("login", code, { json });
  const token = await approved(service, code, json, held);
  if (isFailure(token)) return fail("login", token, { json });

  // who signed in, before anything is saved: a token the service will not say who it is is never kept
  const me = await whoAmI(service, token, held);
  if (isFailure(me)) { await revoke(service, token); return fail("login", me, { json }); }
  // read again just before the write, so a login another command saved meanwhile is kept
  const now = readLogins();
  if (isFailure(now)) { await revoke(service, token); return fail("login", now, { json }); }
  const was = now.logins.logins[service.base] ?? null;
  const logins: Logins = { version: 1, logins: { ...now.logins.logins, [service.base]: { token, email: me.email, savedAt: new Date().toISOString() } } };
  const saved = writeLogins(logins);
  if (isFailure(saved)) { await revoke(service, token); return fail("login", saved, { json }); }
  // the login it replaced is revoked, so this machine never leaves a token it no longer holds alive on the service
  const replaced = was === null || was.token === token ? null : { email: serviceText(was.email, 320, [token, was.token]), revokeError: await revoke(service, was.token) };

  // what the service said, as it may be shown, in the report and in --json alike: printable, bounded, no token in it
  const secrets = [token, ...(was ? [was.token] : [])];
  const email = serviceText(me.email, 320, secrets), name = serviceText(me.name, 300, secrets);
  const orgs = me.orgs.map((o) => ({ slug: serviceText(o.slug, 200, secrets), name: serviceText(o.name, 200, secrets), role: serviceText(o.role, 32, secrets) }));
  const next: NextStep[] = [["mason logout", `sign this machine out of ${service.base}`]];
  if (json) {
    out(jsonText(LOGIN, { service: service.base, email, name, orgs, file: saved.file,
      replaced: replaced === null ? null : { email: replaced.email, revoked: replaced.revokeError === null } }, next));
    return 0;
  }
  out(reportText({
    headline: `Signed in to ${service.base} as ${email}`,
    details: [
      ...(name ? [["name", name] as [string, string]] : []),
      ...(orgs.length ? orgs.map((o, i): [string, string] => [i === 0 ? "orgs" : "", orgLine(o)]) : [["orgs", "none yet"] as [string, string]]),
      ["saved", saved.file],
    ],
    tips: replaced === null ? undefined : replaced.revokeError === null
      ? [`This replaces the login of ${replaced.email}, which is revoked.`]
      : [`This replaces the login of ${replaced.email}, which was NOT revoked (${replaced.revokeError}): sign in to ${service.base} in a browser and revoke it there.`],
    next,
  }, outStyle()));
  return 0;
}

/**
 * The page and the code said, then the wait: a poll every `interval` seconds (five more at each slow_down, RFC 8628
 * 3.5), until the token, a refusal, or the code's expiry. On a terminal a spinner turns beside the wait; elsewhere the
 * wait is one line.
 */
async function approved(service: Service, code: DeviceCode, json: boolean, held: readonly string[]): Promise<string | Failure> {
  const page = code.verificationUriComplete ?? code.verificationUri;
  const s = errStyle();
  say(reportText({ headline: `To sign in to ${service.base}, open this page and approve the code:`,
    details: [["page", page], ["code", code.verificationUriComplete ? `${code.userCode} (the page shows it: check they match)` : `${code.userCode} (enter it on the page)`]] }, s));
  const terminal = !json && process.stderr.isTTY === true;
  if (terminal) {
    const couldNot = OPENABLE.test(page) ? await openBrowser(page) : "the page's address is not one Mason opens by itself";
    if (couldNot !== null) say(endText({ tips: [`Could not open a browser (${couldNot}): open the page yourself.`] }, s).replace(/^\n/, ""));
  }
  const minutes = Math.max(1, Math.round(code.expiresIn / 60));
  const full = `Waiting for the code to be approved (it expires in ${minutes} min; Ctrl-C stops)`;
  // a spinner's line is redrawn in place, so it must never reach the terminal's edge (src/cli/command.ts serviceStyle):
  // the longest label that fits beside its frame, else no spinner and the wait said once, broken as any line
  const room = (process.stderr.columns ?? 0) - 1 - 6;
  const label = terminal ? [full, "Waiting for approval", "Waiting"].find((l) => l.length <= room) : undefined;
  const live = label !== undefined;
  const steps = stepRenderer({ line: (t) => say(strict(t, s)), live: live ? process.stderr : null, style: s });
  if (live) steps.begin(label); else say(strict(`${full} …`, s));
  const deadline = Date.now() + code.expiresIn * 1000;
  let interval = code.interval;
  for (;;) {
    if (Date.now() + interval * 1000 > deadline) { if (live) steps.fail(); return expired(code); }
    await sleep(interval * 1000);
    const p = await pollToken(service, code, held);
    if ("pending" in p) continue;
    if ("slowDown" in p) { interval += 5; continue; }
    if (isFailure(p)) { if (live) steps.fail(); return p; }
    if (live) steps.done("Approved"); else say("Approved");
    return p.token;
  }
}

export async function logout(argv: string[]): Promise<number> {
  const f = parseCommand(LOGOUT, argv);
  if (typeof f === "number") return f;
  const json = f.values.json === true;
  if (f.positionals.length) return fail("logout", { message: "it takes no argument", code: "usage", why: "the service is MASON_CLOUD_URL's, else the default", usage: LOGOUT.usage }, { json });
  const service = serviceOf();
  if (isFailure(service)) return fail("logout", service, { json });
  const fromEnv = environmentToken() !== null;
  const envTip = fromEnv ? [`${TOKEN_ENV} is set in this environment, and every command still uses it: logout cannot remove an environment variable. Unset it (unset ${TOKEN_ENV}), and revoke it in the service's web app if it was shared.`] : [];
  const read = readLogins();
  if (isFailure(read)) return fail("logout", read, { json });
  const entry = read.logins.logins[service.base];
  if (entry === undefined) {
    const next: NextStep[] = [["mason login", `sign this machine in to ${service.base}`]];
    if (json) { out(jsonText(LOGOUT, { service: service.base, signedOut: false, email: null, revoked: null, revokeError: null, environmentToken: fromEnv, file: read.file }, next)); return 0; }
    out(reportText({ headline: `This machine is not signed in to ${service.base}`, details: [["file", read.file]], tips: envTip, next }, outStyle()));
    return 0;
  }
  const revokeError = await revoke(service, entry.token);
  // removed whether or not the service took the revoke: a person who logs out means this machine to hold it no more
  const rest = { ...read.logins.logins };
  delete rest[service.base];
  const written = writeLogins({ version: 1, logins: rest });
  if (isFailure(written)) return fail("logout", written, { json });
  const email = serviceText(entry.email, 320, [entry.token]);
  const next: NextStep[] = [["mason login", `sign in to ${service.base} again`]];
  if (json) {
    out(jsonText(LOGOUT, { service: service.base, signedOut: true, email, revoked: revokeError === null, revokeError, environmentToken: fromEnv, file: written.file }, next));
    return 0;
  }
  const notRevoked: string | undefined = revokeError === null ? undefined
    : `The login was NOT revoked (${revokeError}), so it still works on the service until it expires: sign in to ${service.base} in a browser and revoke this machine's login there.`;
  out(reportText({
    headline: revokeError === null ? `Signed out of ${service.base}` : `Signed out of ${service.base} on this machine, but the login was NOT revoked`,
    details: [["account", email], ["revoked", revokeError === null ? "yes: the service takes this login no more" : "no"], ["removed from", written.file]],
    tips: [...(notRevoked ? [notRevoked] : []), ...envTip],
    next,
  }, outStyle()));
  return 0;
}
