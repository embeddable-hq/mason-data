/**
 * `mason ui --replica <org>/<name>` — A HOSTED REPLICA'S WEB PAGE, IN THE BROWSER OF THE ORGANISATION'S OWNER
 * (docs/HOSTED-API.md "A replica's page"). ONE request, `POST /v1/replicas/{org}/{name}/ui`, whose answer is a one-use,
 * short-lived address of the replica's page on the service's own origin; the CLI opens it as `mason ui` opens a run's
 * page and `mason login` its sign-in page (`openBrowser`), or prints it (`--no-open`, `--json`, a browser that would not
 * start). Who may ask (the owner's login alone), and the audit row of each page opened, are the service's: the CLI cannot
 * write that row and never says it did.
 *
 * Every value of the answer, and how it is held (src/cli/hosted.ts's header: a service's value is data, never structure):
 *
 *   value                      where it is printed                     what holds it
 *   every string, keys too     nowhere until held                      `carriesNoSecret`: an answer carrying a secret is refused whole
 *   url                        opened; printed where it was not        `pageUrl`: the service's own origin, no user, at most 2048, carries
 *                              opened, and in --json                   no secret as printed; then `OPENABLE`: letters, digits and
 *                                                                      `. : [ ] - _ ~ / ? = +` alone, so no shell reads it
 *   expiresAt                  a row, --json                           `isServiceTime`
 *   a failure's words          stderr's failure, --json error          `serviceFailure`: one line each, masked; the code by the status
 *   a failure's next           nowhere: never read                     the step is `failureNext`'s, by the status
 *   Retry-After                a next step's words                     `retryAfterOf`: 1 to 3600 seconds
 *
 * THE ADDRESS IS PRINTED ONLY WHERE THE PERSON NEEDS IT: opened in the browser, it is not printed (the browser used it,
 * and it opens the page once); printed when it was not opened, and in `--json` for the agent that passes it on. It is
 * never logged: this command writes no log. A 409 or a 503 (a replica not ready, its machine not connected) is said
 * with the next step, never waited on: the person runs the command again.
 */
import { failed, jsonText, reportText, serviceStyle, type Failure, type NextStep } from "./command.ts";
import { environmentToken, TOKEN_ENV } from "./credentials.ts";
import { call, carriesNoSecret, codeOfStatus, isFailure, isServiceTime, pageUrl, serviceFailure, serviceOf, unexpected, type Answer, type Service } from "./hosted.ts";
import { holdOutput } from "./output-gate.ts";
import { replicaText, tokenFor, type Replica } from "./replica.ts";
import { err as styleErr, out as styleOut } from "./style.ts";
import { OPENABLE, openBrowser, UI } from "./ui.ts";

const out = (m: string): void => { process.stdout.write(`${m}\n`); };
const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The request: the replica's page, asked of the service. Both parts are `REPLICA_PART`'s, safe in a path as they are. */
export const pagePath = (r: Replica): string => `/v1/replicas/${r.org}/${r.name}/ui`;

const STEP = "a replica's page was asked for";

/** A replica's page as the service answers it: the one-use address, and until when it opens the page. */
export interface ReplicaPage { url: string; expiresAt: string }

/**
 * `POST …/ui`'s answer (200), held: every string of it, each key included, put to the exact test first
 * (`carriesNoSecret`), then the address on the service's own origin (`pageUrl`, refused naming both when it is not) and
 * of the characters a browser is handed (`OPENABLE`), and the time to its grammar. The page, or a Failure said by the
 * status alone (or naming the other origin).
 */
export function heldPage(service: Service, a: Answer, secrets: readonly string[]): ReplicaPage | Failure {
  const j = a.json;
  if (!obj(j) || !carriesNoSecret(j, secrets)) return unexpected(service, a, STEP);
  const page = pageUrl(service, j.url, secrets);
  if (page !== null && "elsewhere" in page) {
    return { message: `${service.base} named a replica's page on another address: ${page.elsewhere}`, code: "refused",
      why: `a page is opened only on the service's own address, ${service.base}: anything else would send you to an address nobody chose`,
      fix: "check MASON_CLOUD_URL names the service you mean; if it does, the service is answering outside its documented API" };
  }
  if (page === null || !OPENABLE.test(page.href) || !isServiceTime(j.expiresAt)) return unexpected(service, a, STEP);
  return { url: page.href, expiresAt: j.expiresAt };
}

/**
 * WHAT TO RUN AFTER THE SERVICE REFUSED: the CLI's own, by the status (never the service's `next`). A 401 or 403 is a
 * login that may not (only the organisation's owner opens a replica's page; a CI token never does), a 404 a replica the
 * login does not see, a 409 or 503 a replica not ready or not connected: its state, and the command again when the
 * service's `Retry-After` says.
 */
export function failureNext(status: number, r: Replica, retryAfter: number | null, env: NodeJS.ProcessEnv = process.env): NextStep[] {
  const named = replicaText(r);
  if (status === 401 || status === 403) {
    return environmentToken(env) !== null
      ? [[`env -u ${TOKEN_ENV} mason ui --replica ${named}`, `with your own login, not ${TOKEN_ENV}: a CI token never opens a page`]]
      : [["mason login", "sign in as the organisation's owner: only an owner opens a replica's page"]];
  }
  if (status === 404) return [[`mason replica list ${r.org}`, "the replicas this login sees"]];
  if (status === 409 || status === 503) {
    return [[`mason replica status ${named}`, "whether it is ready"],
      [`mason ui --replica ${named}`, retryAfter !== null ? `again in ${retryAfter} s, as the service asks` : "again in a moment"]];
  }
  return [[`mason ui --replica ${named}`, "again in a moment"]];
}

/** A refusal said as the service worded it; a 409 or 503 it sent without its words is said in the CLI's. */
export function refusalOf(service: Service, a: Answer, r: Replica, secrets: readonly string[], env: NodeJS.ProcessEnv = process.env): Failure {
  const next = failureNext(a.status, r, a.retryAfter, env);
  const notReady = a.status === 409 || a.status === 503;
  const again = a.retryAfter !== null ? `try again in ${a.retryAfter} s` : "try again in a moment";
  const said = serviceFailure(a, secrets, () => next);
  if (said !== null) return notReady && said.fix === undefined ? { ...said, fix: `${again}; mason replica status ${replicaText(r)} says whether it is ready` } : said;
  if (notReady) {
    return { message: `the replica ${replicaText(r)} is not ready to open its page (HTTP ${a.status})`, code: codeOfStatus(a.status),
      why: a.status === 409 ? "it is not ready yet: being made, deleted, or failed" : "its machine is not connected to the service now",
      fix: `${again}; mason replica status ${replicaText(r)} says whether it is ready`, next };
  }
  return unexpected(service, a, STEP);
}

/** `mason ui --replica <org>/<name>`: the page asked for, then opened, printed, or said as --json. */
export async function hostedUi(r: Replica, o: { open: boolean; json: boolean }): Promise<number> {
  const fail = (f: Failure): number => failed("ui", f, { json: o.json, style: serviceStyle(styleErr()) });
  const service = serviceOf();
  if (isFailure(service)) return fail(service);
  const token = tokenFor(service, { asked: "a replica's page is asked for", again: `mason ui --replica ${replicaText(r)}` });
  if (isFailure(token)) return fail(token);
  // from here every byte written is put to the exact test against the token (src/cli/output-gate.ts)
  holdOutput({ command: "ui", json: o.json, secrets: [token] });
  const secrets = [token];
  const a = await call(service, "POST", pagePath(r), { token });
  if (isFailure(a)) return fail(a);
  if (a.status !== 200) return fail(refusalOf(service, a, r, secrets));
  const page = heldPage(service, a, secrets);
  if (isFailure(page)) return fail(page);
  const named = replicaText(r);
  const next: NextStep[] = [[`mason replica status ${named}`, "the replica's state, in this terminal"], [`mason ui --replica ${named}`, "a new address: each opens the page once"]];
  if (o.json) { out(jsonText(UI, { url: page.url, replica: named, expiresAt: page.expiresAt }, next)); return 0; }
  const couldNot = o.open ? await openBrowser(page.url) : null;
  const opened = o.open && couldNot === null;
  out(reportText({
    headline: opened ? `The page of the replica ${named}, opened in your browser` : `The page of the replica ${named}`,
    // opened, the address is not printed: the browser used it, and it opens the page once
    details: [...(opened ? [] : [["url", page.url] as [string, string]]), ["replica", named], ["expires", page.expiresAt]],
    tips: [
      ...(couldNot !== null ? [`Could not open a browser (${couldNot}): open the URL yourself.`] : []),
      opened ? "The address opens the page once: for another tab, run the command again." : "The URL opens the page once, for you alone, until it expires: paste it nowhere else.",
    ],
    next,
  }, serviceStyle(styleOut())));
  return 0;
}
