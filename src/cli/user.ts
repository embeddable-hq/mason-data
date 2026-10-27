/**
 * `mason user add | list | remove` — NAMED, REVOCABLE LOGINS FOR THE POSTGRES API, WITH NO EXPIRY
 * (docs/DESIGN.md "On a server", item 1 of the agreed plan; src/duck/users.ts holds the rules). A BI
 * tool's datasource stores ONE password: a user's lasts until it is removed.
 *
 * It runs as a second process beside the run (or beside `mason serve`: `docker compose exec mason mason user add
 * metabase`, the data folder's `.mason/`), so it needs the project, never the run: it edits `.mason/users.json` under
 * the file's lock, and the run's listener reads the change at its next connection or statement. The password is said
 * ONCE, by `add`, with the URL to paste (one URL builder, pg-url.ts `connectionUrl`) when the run is up and recorded
 * where it listens.
 */
import * as path from "node:path";
import { failed, jsonText, parseCommand, reportText, withEnd, type CommandSpec, type NextStep } from "./command.ts";
import { reach } from "./state.ts";
import { connectionUrl, listenerTips, postgresLink, psqlLine, type PostgresLink } from "./pg-url.ts";
import { changeUsers, keyFingerprint, newUserId, readUsers, underKey, userPassword, USER_NAME_RE, USER_NAME_RULE, USERS_FILE, type MasonUser } from "../duck/users.ts";
import { didYouMean } from "../lib/did-you-mean.ts";
import { out as styleOut } from "./style.ts";

const out = (m: string): void => { process.stdout.write(`${m}\n`); };

export const USER: CommandSpec & { needs: "project" } = {
  needs: "project",
  name: "user",
  summary: "the users the Postgres API takes: a name and a password that does not expire, for a BI tool or an app",
  usage: `usage: mason user add <name> [--json]
       mason user list [--json]
       mason user remove <name> [--json]

  A user of this project's Postgres API: a name and a password, as a BI tool's datasource form asks for them
  (Metabase, Grafana, Superset, Power BI) or an app's DATABASE_URL carries them. Its password does not expire:
  it connects until mason user remove, which refuses its next connection at once and
  ends the sessions it holds at their next statement, without a restart. The password is printed once, by add.
  The user name a tool sends must be the user's own.

  The list is .mason/users.json (names and ids, no password), beside the running Mason, which reads it again by itself.
  Rotating the API key (apiKey in .mason/config.json, MASON_API_KEY under mason serve) removes every user at once.

    mason user add metabase                    a user for Metabase: its password and the URL to paste
    mason user list
    mason user remove metabase                 metabase connects no more
    docker compose exec mason mason user add grafana   beside mason serve, in its data folder

  <name>    ${USER_NAME_RULE}
  --json    as data: add { user (the name), id, addedAt, password, database, and once Mason runs url, host, port,
            sslmode }; list { users: [{ name, id, addedAt, live }] }; remove { removed: { name, id, addedAt } }; next
`,
  options: { json: { type: "boolean", default: false } },
  json: ["user", "id", "addedAt", "password", "url", "host", "port", "database", "sslmode", "users", "removed", "next"],
};

/** The users of a project and why one is not live: added under an API key since rotated. */
const liveOf = (u: MasonUser, apiKey: string): boolean => underKey(u, apiKey);

export async function user(argv: string[]): Promise<number> {
  const f = parseCommand(USER, argv);
  if (typeof f === "number") return f;
  const json = f.values.json === true;
  const usage = (message: string): number => failed("user", { message, code: "usage", usage: USER.usage }, { json });
  const [verb, name, ...rest] = f.positionals;
  if (verb === undefined) return usage("add, list or remove: mason user add <name> makes a user");
  if (!["add", "list", "remove"].includes(verb)) return usage(`there is no mason user ${verb}: add, list or remove${didYouMean(verb, ["add", "list", "remove"])}`);
  if (verb === "list" ? name !== undefined : rest.length) return usage(`mason user ${verb} takes ${verb === "list" ? "no name" : "one name"}: ${[name, ...rest].filter(Boolean).join(" ")} is too many`);
  if (verb !== "list") {
    if (name === undefined) return usage(`mason user ${verb} <name>: which user`);
    if (!USER_NAME_RE.test(name)) return usage(`${JSON.stringify(name)} is not a user name: ${USER_NAME_RULE}`);
  }
  const w = await reach(USER, json);
  if (w === null || w.project === null) return 1;
  const project = w.project;
  const file = path.join(project.dir, USERS_FILE);
  const apiKey = project.config.apiKey;
  const cantChange = (e: unknown): number => failed("user", { message: `the list of users could not be changed: ${(e as Error).message}`, code: "failed",
    fix: `${file} is the list (mason user writes it): repair it, or move it aside, which removes every user` }, { json });

  if (verb === "list") {
    const r = readUsers(file);
    if ("problem" in r) return failed("user", { message: `the list of users cannot be read: ${r.problem}`, code: "bad_config", why: "no user connects while it cannot be read",
      fix: `repair ${file}, or move it aside, which removes every user` }, { json });
    const next: NextStep[] = [["mason user add <name>", "a user for a tool: its password and URL, printed once"], ...(r.users.length ? [["mason user remove <name>", "that user connects no more"] as NextStep] : [])];
    if (json) { out(jsonText(USER, { users: r.users.map((u) => ({ name: u.name, id: u.id, addedAt: u.addedAt, live: liveOf(u, apiKey) })) }, next)); return 0; }
    const s = styleOut();
    if (!r.users.length) { out(withEnd(`${s.bold(`No users yet for ${project.config.name}.`)}`, { next })); return 0; }
    const width = Math.max(...r.users.map((u) => u.name.length));
    const lines = r.users.map((u) => `  ${s.cyan(u.name.padEnd(width))}   ${s.dim(`id ${u.id} · added ${u.addedAt.slice(0, 16).replace("T", " ")} UTC`)}` +
      (liveOf(u, apiKey) ? "" : `   ${s.yellow("does not connect: the API key was rotated since it was added")}`));
    const rotated = r.users.filter((u) => !liveOf(u, apiKey));
    out(withEnd(`${s.bold(`${r.users.length} user${r.users.length === 1 ? "" : "s"} of ${project.config.name}`)}\n${lines.join("\n")}`,
      { ...(rotated.length ? { tips: [`A user added under another API key does not connect: mason user remove ${rotated[0]!.name}, then mason user add ${rotated[0]!.name}.`] } : {}), next }));
    return 0;
  }

  if (verb === "remove") {
    let removed: MasonUser | undefined;
    let live: string[] = [];
    let r;
    try {
      r = changeUsers(file, (users) => {
        removed = users.find((u) => u.name === name);
        live = users.map((u) => u.name);
        return removed === undefined ? { refused: "unknown" } : users.filter((u) => u !== removed);
      });
    } catch (e) { return cantChange(e); }
    if (!Array.isArray(r)) {
      return failed("user", { message: `there is no user ${JSON.stringify(name)}${didYouMean(name!, live)}`, code: "not_found",
        why: live.length ? `the users: ${live.join(", ")}` : "this project has no users", next: [["mason user list", "the users"]] }, { json });
    }
    const gone = removed!;
    const next: NextStep[] = [["mason user list", "the users left"], ["mason user add <name>", "a new user, with a new password"]];
    if (json) { out(jsonText(USER, { removed: { name: gone.name, id: gone.id, addedAt: gone.addedAt } }, next)); return 0; }
    out(reportText({ headline: `The user ${gone.name} removed: it connects no more`,
      details: [["user", gone.name], ["added", gone.addedAt], ["sessions", w.state === "up" ? "those it holds end at their next statement" : "none: Mason is not running"]],
      tips: [`Adding ${gone.name} again makes a new password: the old one never connects again.`], next }));
    return 0;
  }

  // add
  const fingerprint = keyFingerprint(apiKey);
  let added: MasonUser | undefined;
  let replaced = false;
  let r;
  try {
    r = changeUsers(file, (users) => {
      const was = users.find((u) => u.name === name);
      // a user added under a key since rotated connects no more: its name is free, said
      if (was !== undefined && was.key === fingerprint) return { refused: "taken" };
      replaced = was !== undefined;
      added = { name: name!, id: newUserId(), addedAt: new Date().toISOString(), key: fingerprint };
      return [...users.filter((u) => u !== was), added];
    });
  } catch (e) { return cantChange(e); }
  if (!Array.isArray(r)) {
    return failed("user", { message: `there is already a user ${JSON.stringify(name)}`, code: "refused",
      why: "a name names one user, so removing it means one thing; its password is not kept, so it cannot be printed again",
      fix: `mason user remove ${name}, then mason user add ${name} (a new password; the old one stops connecting), or add another name (${name}-2) and remove ${name} once the tool uses it`,
      next: [["mason user list", "the users"], [`mason user remove ${name}`, "then add it again, with a new password"]] }, { json });
  }
  const u = added!;
  const password = userPassword(apiKey, u.name, u.id);
  const run = w.state === "up" ? w.run : null;
  const link: PostgresLink | null = run ? postgresLink(run.postgresUrl) : null;
  const url = link === null ? null : connectionUrl(link, u.name, password);
  const next: NextStep[] = link === null
    ? [["mason start", "start Mason: then mason status prints where the Postgres API listens"], ["mason user list", "the users"]]
    : [["mason user list", "the users"], [`mason user remove ${u.name}`, "it connects no more"]];
  if (json) {
    out(jsonText(USER, { user: u.name, id: u.id, addedAt: u.addedAt, password, database: link?.database ?? project.config.name,
      ...(link !== null ? { url, host: link.host, port: link.port, sslmode: link.sslmode ?? "disable" } : {}) }, next));
    return 0;
  }
  out(reportText({
    headline: `The user ${u.name} added${replaced ? " (in place of one the API key's rotation had removed)" : ""}: its password is printed this once`,
    details: [
      ...(url !== null ? [["url", url] as const, ["psql", psqlLine(url)] as const] : []),
      ["user", u.name], ["password", password], ["database", link?.database ?? project.config.name],
      ...(link !== null ? [["host", link.host] as const, ["port", String(link.port)] as const, ...(link.sslmode ? [["ssl mode", link.sslmode] as const] : [])] : []),
    ],
    tips: [
      "Paste it into the tool now: Mason keeps no copy of the password. Lost, remove the user and add it again.",
      ...(link === null ? ["Mason is not running: mason start, then mason status says the host and port this user connects to."] : []),
      ...listenerTips(run?.postgresListener ?? null),
      "It never expires: mason user remove ends it, at once and for every session it holds.",
      "Rotating the API key (apiKey in .mason/config.json, MASON_API_KEY under mason serve) removes every user at once.",
    ],
    next,
  }));
  return 0;
}
