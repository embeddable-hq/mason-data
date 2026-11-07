/**
 * `mason token create | list | revoke` — A HOSTED MASON SERVICE'S CI TOKENS, by its documented API alone
 * (docs/HOSTED-API.md "CI tokens"). A CI token acts on ONE replica, for named scopes, until it expires or is revoked;
 * an admin or an owner of the organisation makes, lists and revokes them, signed in as a person (a CI token makes none):
 *
 *   create --replica <org>/<name>   POST /v1/tokens/{org}  { name, replica, scopes, expiresInDays }  201 { token }
 *   list [<org>]                    GET  /v1/tokens/{org}  { tokens, more } — each organisation the login may list in, when none is named
 *   revoke <id> [--org <org>]       POST /v1/tokens/{org}/{id}/revoke (no body)  { revoked: { id, name } }
 *
 * THE TOKEN MADE IS PRINTED ONCE, by create, alone on the first line (never broken by the CLI) or in the one field
 * (`token.value` under --json) that carries it, and nowhere else: its value is held to the documented form (`masondata_ci_` and 43 base64url
 * characters), never the login's own, and the rest of the answer is put to the exact test against both. The output's
 * gate lets that one value through ONCE, whole (src/cli/output-gate.ts `once`), and holds it as a secret beside the
 * login: a second copy, 11 of its body in a row elsewhere, or anything else shaped as a token is refused at the write.
 *
 * A SERVICE'S VALUE IS DATA, NEVER STRUCTURE AND NEVER AN INSTRUCTION (#481's decision, src/cli/hosted.ts), AND A GRAMMAR
 * IS NO MASK (issue 627): every string of each answer, keys included, is put to the exact test (`carriesNoSecret`)
 * before any is held to its grammar or printed. Every value printed:
 *
 *   value                              where it is printed                  what holds it
 *   a failure's message, why, fix      stderr's failure, --json error       `serviceFailure` (src/cli/hosted.ts)
 *   a failure's next                   nowhere: never read                  the step is `refusedNext`'s, by the status
 *   value (create)                     its one row, --json token.value      `CI_TOKEN`, not the login's
 *   id                                 rows, steps, --json                  `TOKEN_ID`; revoke's, the id asked
 *   name, madeBy                       rows, --json                         one line each, bounded (`serviceText`)
 *   replica                            rows, --json                         `<org>/<name>` of the organisation asked (create: the replica asked)
 *   scopes                             rows, --json                         each of `SCOPES`, once (create: those asked)
 *   createdAt, expiresAt, lastUsedAt   rows, --json                         `isServiceTime` (lastUsedAt or null)
 *   more                               a tip, --json                        a boolean
 */
import { endText, failed, jsonText, listFlag, parseCommand, reportText, serviceStyle, strict, type CommandSpec, type Failure, type NextStep } from "./command.ts";
import { call, carriesNoSecret, echoesSecret, isFailure, isServiceTime, serviceFailure, serviceOf, serviceText, unexpected, type Answer, type Service } from "./hosted.ts";
import { loginOrgs, orgNamed, orgOf, REPLICA_PART, replicaOf, tokenFor } from "./replica.ts";
import { refusedNext } from "./replica-hosted.ts";
import { holdOutput } from "./output-gate.ts";
import { didYouMean } from "../lib/did-you-mean.ts";
import { err as styleErr, out as styleOut, type Style } from "./style.ts";

/** What a CI token may be made for (docs/HOSTED-API.md): deploying the project, and the replica's users. */
export const SCOPES = ["deploy", "users"] as const;
type Scope = typeof SCOPES[number];
/** The documented form of a CI token: what create prints, once. */
const CI_TOKEN = /^masondata_ci_[A-Za-z0-9_-]{43}$/;
/** A token's id, as it goes into a path: letters, digits, `-` and `_`. */
export const TOKEN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_NAME = "ci";
const DEFAULT_DAYS = 90;
const MAX_DAYS = 365;
const MAX_TOKENS = 1000;
/** A list's answer is read up to this (a row a token). */
const MAX_LIST_BYTES = 1024 * 1024;
/** Who may make, list and revoke CI tokens: the roles of `GET /v1/me`. */
const MAKERS = ["admin", "owner"];

export interface HostedToken { id: string; name: string; replica: string; scopes: Scope[]; madeBy: string | null; createdAt: string; lastUsedAt: string | null; expiresAt: string }

export const TOKEN: CommandSpec = {
  name: "token",
  summary: "a hosted Mason service's CI tokens: make one for a replica (printed once), list them, revoke one",
  usage: `usage: mason token create --replica <org>/<name> [--scope deploy|users …] [--name <name>] [--days <n>] [--json]
       mason token list [<org> | --org <org>] [--json]
       mason token revoke <id> [--org <org>] [--json]

  A CI token lets CI act on ONE replica of a hosted Mason service, for the scopes it was made with (deploy: mason
  deploy; users: mason user … --replica), until it expires or is revoked. CI reads it from MASON_TOKEN. An admin or
  an owner of the organisation makes, lists and revokes them, signed in as a person (mason login): a CI token
  makes none.

    mason token create --replica acme/shop --name github-actions
    mason token create --replica acme/shop --scope deploy --scope users --days 30 --json
    mason token list acme
    mason token revoke 3f1c9a2e --org acme

  --replica <org>/<name>   create: the replica it acts on (else MASON_REPLICA)
  --scope <scope,…>        create: what it may do, deploy or users; both: --scope deploy,users or the flag twice
                           (default deploy)
  --name <name>            create: what the list calls it, 1 to 64 characters (default ${DEFAULT_NAME})
  --days <n>               create: the days it acts, 1 to ${MAX_DAYS} (default ${DEFAULT_DAYS})
  --org <org>              list: the organisation, in place of the argument; revoke: the organisation it is of
  --json                   as data: its shape is at the end

  create makes one and prints it ONCE: the service does not keep it, and nothing shows it again, so store it at once
  (as MASON_TOKEN in CI's secrets). It is alone on the first line printed, never broken, or, with --json, in the
  one field token.value of the document, so a setup step can pipe it straight into a secret store. Nothing else
  this command prints ever holds it.

  list says the CI tokens of <org> that still act (never a token itself), or of every organisation this login is
  an admin or an owner of when none is named; revoke ends one at once, by its id (list says it), in --org, else in
  the one organisation this login is an admin or an owner of.

  The login is MASON_TOKEN, else this machine's (mason login); the service is MASON_CLOUD_URL, else the default.

  Exit status: 0 done; 1 not signed in, refused by the service (its words printed as they came, the code the
  CLI's own), or the service answered outside its contract; 2 a wrong command line.

  The --json answer: { token (create: { id, value (the token itself, this once), name,
    replica, scopes, createdAt, expiresAt }), tokens (list: [{ id, name, replica, scopes,
    madeBy, createdAt, lastUsedAt (null: never used), expiresAt }]), more (list: true when an
    organisation has more than the service lists), revokedToken (revoke: { org, id,
    name }), revoked (revoke: the same, kept until 1.0), next }
`,
  options: { replica: { type: "string" }, scope: { type: "string", multiple: true }, name: { type: "string" }, days: { type: "string" }, org: { type: "string" },
    json: { type: "boolean", default: false } },
  json: ["token", "tokens", "more", "revokedToken", "revoked", "next"],
};

const outStyle = (): Style => serviceStyle(styleOut());
const errStyle = (): Style => serviceStyle(styleErr());
const out = (m: string): void => { process.stdout.write(`${m}\n`); };
const fail = (f: Failure, json: boolean): number => failed("token", f, { json, style: errStyle() });
const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const MAY = "an admin or an owner";

/** Scopes as the service lists them: each one of `SCOPES`, once; null otherwise. In `SCOPES`' order. */
function scopesOf(v: unknown): Scope[] | null {
  if (!Array.isArray(v) || v.length < 1 || v.length > SCOPES.length || new Set(v).size !== v.length || !v.every((x) => (SCOPES as readonly unknown[]).includes(x))) return null;
  return SCOPES.filter((s) => v.includes(s));
}

/**
 * ONE CI TOKEN AS THE SERVICE SAYS IT, held: of the organisation asked (`org`), every value to its grammar, its words one
 * line each; null when any does not hold. The answer around it has been put to the exact test.
 */
export function heldToken(v: unknown, org: string, secrets: readonly string[]): HostedToken | null {
  if (!obj(v) || typeof v.id !== "string" || !TOKEN_ID.test(v.id) || typeof v.name !== "string" || v.name.length < 1 || v.name.length > 200) return null;
  const replica = typeof v.replica === "string" ? v.replica.split("/") : [];
  if (replica.length !== 2 || replica[0] !== org || !REPLICA_PART.test(replica[1]!)) return null;
  const scopes = scopesOf(v.scopes);
  if (scopes === null || !isServiceTime(v.createdAt) || !isServiceTime(v.expiresAt)) return null;
  if (v.lastUsedAt !== undefined && v.lastUsedAt !== null && !isServiceTime(v.lastUsedAt)) return null;
  if (v.madeBy !== undefined && v.madeBy !== null && (typeof v.madeBy !== "string" || v.madeBy.length > 320)) return null;
  return { id: v.id, name: serviceText(v.name, 64, secrets), replica: `${org}/${replica[1]!}`, scopes, madeBy: typeof v.madeBy === "string" ? serviceText(v.madeBy, 320, secrets) : null,
    createdAt: v.createdAt, lastUsedAt: typeof v.lastUsedAt === "string" ? v.lastUsedAt : null, expiresAt: v.expiresAt };
}

/**
 * THE TOKEN CREATE MADE (`201 { token }`): its value in the documented form and not the login's, the rest of the answer
 * carrying neither (the exact test, against both: a copy of the value elsewhere is a second print), the replica and the
 * scopes those asked. The token and its value, or null.
 */
export function heldMade(json: unknown, asked: { org: string; name: string; scopes: readonly Scope[] }, login: readonly string[]): { token: HostedToken; value: string } | null {
  if (!obj(json) || !obj(json.token)) return null;
  const value = json.token.value;
  // the value is shaped as a token by design: what it may not be is an echo of the login's
  if (typeof value !== "string" || !CI_TOKEN.test(value) || login.includes(value) || echoesSecret(value, login)) return null;
  const rest = { ...json, token: { ...json.token, value: null } };
  if (!carriesNoSecret(rest, [...login, value])) return null;
  const token = heldToken(json.token, asked.org, [...login, value]);
  if (token === null || token.replica !== `${asked.org}/${asked.name}` || token.scopes.join() !== SCOPES.filter((s) => asked.scopes.includes(s)).join()) return null;
  return { token, value };
}

/** The service and the login, the output's gate holding the token; or the Failure. */
function signedIn(asked: string, again: string, json: boolean): { service: Service; token: string } | Failure {
  const service = serviceOf();
  if (isFailure(service)) return service;
  const token = tokenFor(service, { asked, again });
  if (isFailure(token)) return token;
  holdOutput({ command: "token", json, secrets: [token] });
  return { service, token };
}

const listStep = (org: string): NextStep => [`mason token list ${org}`, "the organisation's CI tokens"];

export async function token(argv: string[]): Promise<number> {
  const f = parseCommand(TOKEN, argv);
  if (typeof f === "number") return f;
  const json = f.values.json === true;
  const usage = (message: string, fix?: string): number => fail({ message, code: "usage", ...(fix ? { fix } : {}), usage: TOKEN.usage }, json);
  const [verb, arg, ...rest] = f.positionals;
  const VERBS = ["create", "list", "revoke"];
  if (verb === undefined) return usage("create, list or revoke: mason token create --replica <org>/<name> makes one");
  if (!VERBS.includes(verb)) return usage(`there is no mason token ${verb}: create, list or revoke${didYouMean(verb, VERBS)}`);
  const extra = verb === "create" ? [arg, ...rest].filter((x) => x !== undefined) : rest;
  if (extra.length) return usage(`mason token ${verb} takes ${verb === "create" ? "no argument (the replica is --replica)" : verb === "list" ? "one organisation at most" : "one id"}: ${extra.join(" ")} is too many`);
  for (const k of ["replica", "scope", "name", "days"] as const) if (verb !== "create" && f.values[k] !== undefined) return usage(`--${k} goes with mason token create`);
  if (verb === "create" && f.values.org !== undefined) return usage("--org goes with mason token list and revoke", "create names it: --replica <org>/<name>");
  if (verb === "list") {
    const org = orgOf(typeof f.values.org === "string" ? f.values.org : undefined, arg, TOKEN.usage);
    if (org !== null && isFailure(org)) return fail(org, json);
    return list(org, json);
  }
  if (verb === "revoke") {
    if (arg === undefined || !TOKEN_ID.test(arg)) return usage(arg === undefined ? "mason token revoke names the token's id: mason token revoke <id>" : `${JSON.stringify(serviceText(arg, 100))} is not a CI token's id`,
      "its id is what mason token list says first on its line, letters, digits, - and _ (never the token itself)");
    const org = typeof f.values.org === "string" ? orgNamed(f.values.org, TOKEN.usage) : null;
    if (org !== null && isFailure(org)) return fail(org, json);
    return revoke(arg, org, json);
  }
  const r = replicaOf(typeof f.values.replica === "string" ? f.values.replica : undefined, TOKEN.usage);
  if (r === null) return usage("mason token create names the replica it acts on", "--replica <org>/<name>, or MASON_REPLICA=<org>/<name>");
  if (isFailure(r)) return fail(r, json);
  // a comma list or the flag repeated, the same (src/cli/command.ts listFlag)
  const listed = listFlag(f.values.scope);
  const asked = listed === undefined ? [] : listed.split(",");
  for (const s of asked) if (!(SCOPES as readonly string[]).includes(s)) return usage(`--scope ${JSON.stringify(serviceText(s, 100))} is not a scope${didYouMean(s, SCOPES)}`, `a CI token's scopes are ${SCOPES.join(" and ")}`);
  if (new Set(asked).size !== asked.length) return usage("a --scope is named twice", "name each scope once");
  const scopes = (asked.length ? asked : ["deploy"]) as Scope[];
  const name = typeof f.values.name === "string" ? f.values.name : DEFAULT_NAME;
  if ([...name].length < 1 || [...name].length > 64 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name) || name.trim() !== name) return usage("--name is 1 to 64 characters, with no control character or space at either end", "--name github-actions");
  const daysText = typeof f.values.days === "string" ? f.values.days : String(DEFAULT_DAYS);
  if (!/^[1-9]\d{0,2}$/.test(daysText) || Number(daysText) > MAX_DAYS) return usage(`--days ${JSON.stringify(serviceText(daysText, 100))} is not 1 to ${MAX_DAYS}`, "a CI token acts a whole number of days: --days 90");
  return create({ org: r.org, name: r.name }, { label: name, scopes, days: Number(daysText) }, json);
}

/** What to run after the service refused: the CLI's own, by the status, naming the role that may. */
const refused = (a: Answer, org: string, again: NextStep, secrets: readonly string[], service: Service, step: string): Failure =>
  serviceFailure(a, secrets, (st) => st === 404 && again[0].startsWith("mason token revoke") ? [listStep(org)] : refusedNext(st, org, MAY, again)) ?? unexpected(service, a, step);

async function create(r: { org: string; name: string }, o: { label: string; scopes: Scope[]; days: number }, json: boolean): Promise<number> {
  const again: NextStep = [`mason token create --replica ${r.org}/${r.name}`, "make it again"];
  const s = signedIn("a CI token is made", "mason token create", json);
  if (isFailure(s)) return fail(s, json);
  const { service, token: login } = s;
  const a = await call(service, "POST", `/v1/tokens/${r.org}`, { token: login, json: { name: o.label, replica: r.name, scopes: o.scopes, expiresInDays: o.days } });
  if (isFailure(a)) {
    return fail({ ...a, why: `${a.why ?? "no answer"}; whether a token was made is not known, and it is never shown again`,
      fix: `mason token list ${r.org} says the tokens that act: revoke any you did not see made, then make it again`, next: [listStep(r.org), again] }, json);
  }
  if (a.status !== 201) return fail(refused(a, r.org, again, [login], service, "a CI token was made"), json);
  const made = heldMade(a.json, { org: r.org, name: r.name, scopes: o.scopes }, [login]);
  if (made === null) {
    // the service answered 201: a token may have been made, whose value nobody has now been shown
    const f = unexpected(service, a, "a CI token was made");
    return fail({ ...f, why: `${f.why}; a token may have been made all the same, and it was not shown`,
      fix: `mason token list ${r.org} says the tokens that act: revoke one you did not see made (mason token revoke <id> --org ${r.org}), then make it again`, next: [listStep(r.org)] }, json);
  }
  // the one print of the token: the gate lets this value through once, whole (src/cli/output-gate.ts)
  holdOutput({ command: "token", json, secrets: [], once: made.value });
  const t = made.token;
  const next: NextStep[] = [listStep(r.org), [`mason token revoke ${t.id} --org ${r.org}`, "end it"]];
  if (json) {
    out(jsonText(TOKEN, { token: { id: t.id, value: made.value, name: t.name, replica: t.replica, scopes: t.scopes, createdAt: t.createdAt, expiresAt: t.expiresAt } }, next));
    return 0;
  }
  // THE TOKEN ON A LINE OF ITS OWN, FIRST, written alone and never broken by the CLI (PR 660's review, B2: a value to copy
  // is no service text to break at the width — a line break inside it would be copied with it). A terminal narrower
  // than it wraps it softly, which a copy joins. It cannot begin a line of anyone's making: held to `CI_TOKEN`, it has
  // no space, no colon and no control character, so no piece of it is a step, a heading or a failure.
  process.stdout.write(`${made.value}\n`);
  out(reportText({ headline: `Made a CI token for ${t.replica}: the line above is the token, printed this once`,
    details: [["id", t.id], ["name", t.name], ["scopes", t.scopes.join(", ")], ["expires", t.expiresAt]],
    tips: ["Store it now, as MASON_TOKEN in your CI's secrets: the service does not keep it, and nothing shows it again.",
      `It acts on ${t.replica} alone, for ${t.scopes.join(" and ")}, until it expires or is revoked.`], next }, outStyle()));
  return 0;
}

async function list(org: string | null, json: boolean): Promise<number> {
  const s = signedIn("the CI tokens are asked for", org === null ? "mason token list" : `mason token list ${org}`, json);
  if (isFailure(s)) return fail(s, json);
  const { service, token: login } = s, secrets = [login];
  const orgs = org !== null ? [org] : await loginOrgs(service, login, "mason token list <org>", MAKERS);
  if (isFailure(orgs)) return fail(orgs, json);
  const slugs = orgs.map((o) => typeof o === "string" ? o : o.slug);
  const tokens: HostedToken[] = [];
  const more: string[] = [];
  for (const slug of slugs) {
    const a = await call(service, "GET", `/v1/tokens/${slug}`, { token: login, maxBytes: MAX_LIST_BYTES });
    if (isFailure(a)) return fail(a, json);
    if (a.status !== 200) return fail(refused(a, slug, listStep(slug), secrets, service, "the CI tokens were asked for"), json);
    const j = a.json;
    if (!obj(j) || !Array.isArray(j.tokens) || j.tokens.length > MAX_TOKENS || typeof j.more !== "boolean" || !carriesNoSecret(j, secrets)) return fail(unexpected(service, a, "the CI tokens were asked for"), json);
    for (const v of j.tokens) { const t = heldToken(v, slug, secrets); if (t === null) return fail(unexpected(service, a, "the CI tokens were asked for"), json); tokens.push(t); }
    if (j.more) more.push(slug);
  }
  const where = slugs.length === 1 ? slugs[0]! : slugs.length === 0 ? "no organisation this login is an admin or an owner of" : `${slugs.length} organisations`;
  const first = tokens[0];
  const next: NextStep[] = first !== undefined
    ? [[`mason token revoke ${first.id} --org ${first.replica.split("/")[0]!}`, "end one"], ["mason token create --replica <org>/<name>", "another"]]
    : [["mason token create --replica <org>/<name>", "make one"]];
  if (json) { out(jsonText(TOKEN, { tokens, more: more.length > 0 }, next)); return 0; }
  const st = outStyle();
  const head = tokens.length ? `${tokens.length} CI token${tokens.length === 1 ? "" : "s"} that act, in ${where}` : `No CI tokens that act, in ${where}`;
  const lines = tokens.map((t) => `  ${t.id}   ${t.name}: ${t.replica}, ${t.scopes.join(" and ")}, until ${t.expiresAt}, last used ${t.lastUsedAt ?? "never"}${t.madeBy ? `, made by ${t.madeBy}` : ""}`);
  const tips = more.map((o) => `${o} has more CI tokens than the service lists at once: its web app lists them all`);
  const end = endText({ tips, next }, st);
  out(strict(`${st.bold(head)}${lines.length ? `\n${lines.join("\n")}` : ""}${end ? `\n${end}` : ""}`, st));
  return 0;
}

async function revoke(id: string, named: string | null, json: boolean): Promise<number> {
  const s = signedIn("a CI token is revoked", `mason token revoke ${id}`, json);
  if (isFailure(s)) return fail(s, json);
  const { service, token: login } = s, secrets = [login];
  let org = named;
  if (org === null) {
    const orgs = await loginOrgs(service, login, `mason token revoke ${id} --org <org>`, MAKERS);
    if (isFailure(orgs)) return fail(orgs, json);
    if (orgs.length !== 1) {
      return fail({ message: orgs.length ? `this login is an admin or an owner of ${orgs.length} organisations: which one is the token of?` : "this login is an admin or an owner of no organisation",
        code: orgs.length ? "usage" : "refused", why: "an admin or an owner of a token's organisation revokes it",
        fix: orgs.length ? `name it: mason token revoke ${id} --org <org> (${orgs.map((o) => o.slug).join(", ")})` : "sign in as an admin or an owner of its organisation",
        next: orgs.length ? orgs.slice(0, 3).map((o): NextStep => [`mason token revoke ${id} --org ${o.slug}`]) : [["mason login", `sign in as ${MAY}`]] }, json);
    }
    org = orgs[0]!.slug;
  }
  const again: NextStep = [`mason token revoke ${id} --org ${org}`, "revoke it again"];
  const a = await call(service, "POST", `/v1/tokens/${org}/${id}/revoke`, { token: login });
  if (isFailure(a)) return fail({ ...a, why: `${a.why ?? "no answer"}; whether it was revoked is not known`, fix: `mason token list ${org} says whether it still acts; revoke it again if it does`, next: [listStep(org), again] }, json);
  if (a.status !== 200) return fail(refused(a, org, again, secrets, service, "a CI token was revoked"), json);
  const j = a.json;
  if (!obj(j) || !carriesNoSecret(j, secrets) || !obj(j.revoked) || j.revoked.id !== id || typeof j.revoked.name !== "string" || j.revoked.name.length > 200) return fail(unexpected(service, a, "a CI token was revoked"), json);
  const revoked = { org, id, name: serviceText(j.revoked.name, 64, secrets) };
  const next: NextStep[] = [listStep(org)];
  if (json) { out(jsonText(TOKEN, { revokedToken: revoked, revoked }, next)); return 0; }
  out(reportText({ headline: `Revoked the CI token ${id} of ${org}: it acts no more`, details: [["name", revoked.name]], next }, outStyle()));
  return 0;
}
