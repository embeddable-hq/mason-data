/**
 * `mason init [<postgres url>]` (a project directory is initiated as other CLIs do it, by `mason init`):
 * makes the folder it is run in a Mason project. The database's URL comes from the argument, else the folder's
 * `.env.local` or `.env` (`DATABASE_URL`, the variable web frameworks use), else the shell's. The database is checked as
 * `mason start` checks it (checkSource) and nothing is written when it fails, unless --skip-check says the database is
 * not up yet.
 *
 * It writes `.mason/config.json` (0600: the project's name and Mason's key), the project's source file
 * (`mason/sources/<database>.yml`, src/cli/sources.ts: `kind: postgres`, `url: ${DATABASE_URL}`, `tables: {}`) — the
 * URL itself in `.env`, never in a committed file (the sources file is the developer's to commit, so the URL stays out
 * of it): nothing more when it came from there, the line added when it came from the argument or the shell — and adds
 * `.mason/` and that .env to the folder's .gitignore. It refuses a folder that is in a project already (here or above)
 * — but for a project with no source file (one an older Mason made), whose source file it writes, nothing else changed.
 *
 * `mason init demo` (src/cli/demo.ts) writes the same files for a database Mason hosts itself: the demo's URL, on a port
 * free now, in `.env` (the one place the port is kept), the demo's four tables already added, and `demo: true` in the
 * config; there is nothing to connect to yet — `mason start` makes the database in `.mason/demo/`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { STDIO, endText, failed, jsonText, parseCommand, type CommandSpec, type Io, type NextStep } from "./command.ts";
import { checklist, out as styleOut, PLAIN, StepFailed } from "./style.ts";
import { checkSource, maskedUrl, parseSource, remoteConfirmation, remoteWarning } from "./preflight.ts";
import { cliPinProblem, ensurePin } from "./pin.ts";
import { version } from "./version.ts";
import { parseVersion, PIN_FILE } from "../lib/project-version.ts";
import { appDatabaseUrl, appEnvValue, appendEnvLine, ENV_FILE } from "../lib/dotenv.ts";
import { DEMO_DIR, NAME_RE, STATE_DIR, brokenProblem, findProject, ignoresStateDir, nameFromFolder, newConfig, writeConfig } from "./project.ts";
import { DEMO_ARG, DEMO_PORT, DEMO_TABLES, demoModule } from "./demo.ts";
import { freePort } from "./ports.ts";
import { newSourceText, OLD_TABLES_DIR, parseSourceText, shownPath, sourceFileNames, sourceNameFor, sourcesDir } from "./sources.ts";


export const INIT_USAGE = `usage: mason init [<postgres url> | demo] [--name <name>] [--folder <dir>] [--remote] [--skip-check] [--json]

  Makes this folder a Mason project — run it in your app's folder. It checks it can read the database (and writes
  nothing when it cannot), then creates:
    .mason/                   this machine's: Mason's key and, once Mason runs, its copy and state (gitignored)
    mason/sources/<db>.yml    the database and the tables to copy (mason add adds them) — commit it
    mason/mason.yml           the Mason version the project is written for — commit it: production runs that version
  The source file says url: \${DATABASE_URL}: the URL itself is in .env (written there when you give it here or it is
  only in the shell), never in a committed file. .mason/ and that .env go into .gitignore. Every other mason command
  then works anywhere in this folder. In a project with no source file (an older Mason's), it writes that file alone.
  mason init demo, in a new folder, makes a project on a demo database Mason hosts itself (a shop: customers, products,
  orders, order_items, its four tables added): mason start makes it in .mason/demo/ and changes it every few seconds.

    mason init                                          DATABASE_URL from .env.local, .env or the shell
    mason init postgres://me:secret@localhost:5432/shop
    mason init demo                                     a demo database Mason hosts itself: nothing to install
    mason init --folder db/mason --name shop-admin      the project's files elsewhere; another name
    mason init postgres://me:secret@db.example.com/shop --remote

  --name <name>     the project's name: the database name a tool connects to on the Postgres API (default: this folder's)
  --folder <dir>    where sources/ goes, relative to this folder (default mason; . for this folder itself)
  --remote          go ahead with a database on another machine (read the warnings mason init prints); not with demo
  --skip-check      write the project without connecting (the database is not up yet); mason start checks it; not with demo
  --json            as data: { name, root, folder, config, demo (true for the demo database's project, else false),
                    source: { name (the source's: its file's), file, url (as the file writes it), env (the .env line
                    written, its value masked, or null) }, database: { url (password masked), from, version, tables },
                    warnings, next }
`;

export const INIT: CommandSpec = {
  name: "init",
  summary: "make this folder a Mason project on your Postgres: mason init (DATABASE_URL from .env), mason init postgres://… or demo",
  usage: INIT_USAGE,
  options: { name: { type: "string" }, folder: { type: "string" }, remote: { type: "boolean" }, "skip-check": { type: "boolean" }, json: { type: "boolean" } },
  json: ["name", "root", "folder", "config", "demo", "source", "database", "warnings", "next"],
};

/** Why `name` cannot be this project's, or null: not a name the Postgres API's database and the slot take. */
export function nameProblem(name: string): string | null {
  if (!NAME_RE.test(name)) return `${JSON.stringify(name)} is not a project name: lower-case letters, digits, - and _, starting with a letter or digit (--name sets it)`;
  return null;
}

/**
 * .gitignore with `.mason/` and each of `files` (the one DATABASE_URL was read from) added where it does not ignore them
 * already, and what was added; null when nothing is. Reading the URL from a file and leaving that file committable
 * was the defect (on the test server, `git add .` in a new folder committed the database password), so the
 * file is ignored with the state. A line already covering it — exact, anchored, or a glob like `.env*` — is enough.
 */
export function withIgnored(gitignore: string | null, files: string[] = []): { text: string; added: string[] } | null {
  const text = gitignore ?? "";
  const added: string[] = [];
  let tail = "";
  if (!ignoresStateDir(text)) { added.push(`${STATE_DIR}/`); tail += `# Mason: this machine's key, copy and state (mason init)\n${STATE_DIR}/\n`; }
  for (const f of files) if (!ignoresFile(text, f)) { added.push(f); tail += `# the database URL mason/sources/ names (mason init)\n${f}\n`; }
  if (added.length === 0) return null;
  const head = text === "" ? "" : text.endsWith("\n") ? text : `${text}\n`;
  return { text: head + tail, added };
}

/** Whether a .gitignore line ignores the file `name` (at the root): its name, anchored or not, or a glob matching it. */
export function ignoresFile(gitignore: string, name: string): boolean {
  return gitignore.split("\n").map((l) => l.trim()).some((l) => {
    if (l === "" || l.startsWith("#") || l.startsWith("!") || l.endsWith("/")) return false;
    const pattern = l.replace(/^\//, "");
    if (pattern.includes("/")) return false;
    const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`);
    return re.test(name);
  });
}

/**
 * Whether `file` in `root` is committed in git — then ignoring it changes nothing and init says what to run. Without
 * git, or outside a repository, git answers with another status or does not run: the file is not known to be
 * committed, and nothing is said (a read with a safe default).
 */
export function committedInGit(root: string, file: string): boolean {
  const r = spawnSync("git", ["ls-files", "--error-unmatch", "--", file], { cwd: root, encoding: "utf8" });
  return r.status === 0;
}

/**
 * WHERE THE SOURCE FILE'S URL IS KEPT: the variable `url: ${…}` names and the `.env` line that gives it this URL — null
 * when the folder's .env.local or .env gives it already. DATABASE_URL when the folder's files give it no other value
 * (one only in the shell is written down: the next shell may not have it); else MASON_DATABASE_URL, so the app's own
 * DATABASE_URL is never changed under it. A problem when both name other databases.
 */
export function urlVariable(root: string, url: string): { variable: string; line: string | null } | { problem: string } {
  for (const variable of ["DATABASE_URL", "MASON_DATABASE_URL"]) {
    const inFiles = appEnvValue(root, variable, {});
    if (inFiles === null) return { variable, line: `${variable}=${url}` };
    if (inFiles.value === url) return { variable, line: null };
  }
  return { problem: "this folder's .env names DATABASE_URL and MASON_DATABASE_URL for other databases: set one of them to the database Mason copies from, then mason init again" };
}

/** `.env` with `line` added (made when there is none). */
const addEnvLine = (root: string, line: string): void => appendEnvLine(root, line, "the database Mason copies from (mason/sources/ names it; never commit this file)");

/** A `.env` line as it is said: its value's password masked. */
const maskedLine = (line: string): string => { const eq = line.indexOf("="); return `${line.slice(0, eq)}=${maskedUrl(line.slice(eq + 1))}`; };

export async function init(argv: string[], cwd = process.cwd(), deps: { io?: Io; version?: string } = {}): Promise<number> {
  const io = deps.io ?? STDIO;
  const { out: say } = io;
  const f = parseCommand(INIT, argv);
  if (typeof f === "number") return f;
  const json = f.values.json === true;
  const usage = (message: string, fix?: string): number => failed("init", { message, code: "usage", fix }, { json, io });
  if (f.positionals.length > 1) return failed("init", { message: "one postgres:// URL at most", code: "usage", usage: INIT_USAGE }, { json, io });
  // THE DEMO (src/cli/demo.ts): a database Mason hosts, made by mason start; there is nothing to check, nor elsewhere
  const demo = f.positionals[0] === DEMO_ARG;
  if (demo) {
    for (const flag of ["remote", "skip-check"] as const) {
      if (f.values[flag] === true) return failed("init", { message: `--${flag} means nothing for the demo database: it is on this machine, made and hosted by mason start`, code: "usage", fix: "mason init demo, without it", usage: INIT_USAGE }, { json, io });
    }
  }
  let root = path.resolve(cwd);
  const existing = findProject(root);
  // a project whose config cannot be read is still this folder's: a second init over it would hide the first's data
  if (existing && "broken" in existing) return failed("init", brokenProblem(existing), { json, io });
  // A PROJECT WITH NO SOURCE FILE (an older Mason's): its source file is written, its config kept; any other is refused
  const sourceless = existing !== null && sourceFileNames(existing.folder).length === 0 ? existing : null;
  if (existing && sourceless === null) {
    const src = sourceFileNames(existing.folder)[0]!;
    const file = path.join(sourcesDir(existing.folder), src);
    const parsedFile = parseSourceText(fs.readFileSync(file, "utf8"), src.replace(/\.ya?ml$/, ""), file);
    // the variable the file itself names, else its literal URL is where the database is said
    const where = !("problems" in parsedFile) && "env" in parsedFile.url
      ? `change ${parsedFile.url.env} in ${path.join(existing.root, ENV_FILE)} (url: in ${shownPath(existing.root, file)} names it), or url: itself`
      : `change url: in ${shownPath(existing.root, file)}`;
    return failed("init", { message: `${existing.root === root ? "this folder is" : `this folder is inside ${existing.root}, which is`} already the Mason project ${existing.config.name}`, code: "refused",
      fix: `to point it at another database, ${where}`, next: [["mason status", "what it is doing"]] }, { json, io });
  }
  if (sourceless && demo) {
    return failed("init", { message: `this folder is the Mason project ${sourceless.config.name} already: mason init demo makes a project of its own`, code: "refused",
      fix: "run it in a new folder (mkdir mason-demo && cd mason-demo && mason init demo)", next: [["mason init", "this project's source file, on your database"]] }, { json, io });
  }
  if (sourceless && (f.values.name !== undefined || f.values.folder !== undefined)) {
    return usage(`this folder is the Mason project ${sourceless.config.name} already, whose source file is all mason init writes here: it takes no --name or --folder`, "mason init [<postgres url>], in the project's folder");
  }
  if (sourceless) root = sourceless.root;
  const name = sourceless?.config.name ?? (f.values.name as string | undefined) ?? nameFromFolder(root);
  const folderArg = (f.values.folder as string | undefined) ?? "mason";
  const folder = sourceless?.folder ?? path.resolve(root, folderArg);
  if (path.relative(root, folder).startsWith("..")) return usage(`--folder ${folderArg} is outside this folder`, "the project's files go in this folder or below it");
  if (fs.existsSync(folder) && !fs.statSync(folder).isDirectory()) return usage(`${folder} is a file, not a folder`, "--folder <dir> chooses another");
  const named = nameProblem(name);
  if (named) return usage(named);

  // the demo's URL names a port free now, and is the one place the port is kept: mason start reads it from there
  let url = demo ? (await demoModule()).demoUrl(await freePort(DEMO_PORT)) : f.positionals[0] ?? null;
  let from = "";
  let envFile: string | null = null; // the folder's file the URL was read from (.env.local or .env): ignored with .mason/
  if (url === null) {
    const found = appDatabaseUrl(root);
    if (!found) {
      // the fixes ARE the next commands, so a coding agent reads them as such too
      return failed("init", { message: "which database? none is named, and this folder has no DATABASE_URL", code: "usage",
        fix: "give its URL on the command line, or put it in this folder's .env as DATABASE_URL=postgres://… (your app's, usually)",
        next: [["mason init postgres://user:password@localhost:5432/your_app", "its URL, given"], ["mason init", "again, once .env has DATABASE_URL"],
          ["mason init demo", "a demo database Mason makes itself: nothing to install"]] }, { json, io });
    }
    url = found.url;
    from = ` (DATABASE_URL in ${found.from})`;
    envFile = found.file;
  }
  const parsed = parseSource(url);
  if ("problem" in parsed) return usage(parsed.problem);
  const remote = f.values.remote === true || sourceless?.config.remote === true;
  // THE SOURCE FILE: one already here (a clone of the project) is kept; else written, its URL a variable of .env
  const kept = sourceFileNames(folder)[0] ?? null;
  if (demo && kept !== null) {
    // a clone's sources file names the team's database: the demo never takes its place
    return failed("init", { message: `${path.relative(root, path.join(sourcesDir(folder), kept))} is already here: mason init demo makes a project of its own`, code: "refused",
      fix: "run it in a new folder (mkdir mason-demo && cd mason-demo && mason init demo), or mason init here for the database that file names" }, { json, io });
  }
  const keptText = kept === null ? null : fs.readFileSync(path.join(sourcesDir(folder), kept), "utf8");
  const keptFile = kept === null ? null : parseSourceText(keptText!, kept.replace(/\.ya?ml$/, ""), path.join(sourcesDir(folder), kept));
  const keptVar = keptFile !== null && !("problems" in keptFile) && "env" in keptFile.url ? keptFile.url.env : null;
  // a kept file's variable gets this URL in .env when the folder's files give it none; one they give another value is said
  const keptValue = keptVar === null ? null : appEnvValue(root, keptVar, {});
  const where = kept === null ? urlVariable(root, url)
    : { variable: keptVar ?? "", line: keptVar !== null && keptValue === null ? `${keptVar}=${url}` : null };
  if ("problem" in where) return failed("init", { message: where.problem, code: "refused" }, { json, io });

  // WHAT IT DOES, AS A CHECKLIST (each item it is doing, with a spinner left of it that turns into a checkmark when
  // done): live on a terminal, the finished lines anywhere else (src/cli/style.ts checklist); under
  // --json none of it, the facts as one document at the end
  const st = deps.io ? PLAIN : styleOut();
  const line = (t: string): void => { if (!json) say(t); };
  const steps = checklist({ line, live: !deps.io && !json && process.stdout.isTTY ? { write: (t) => { process.stdout.write(t); } } : null, style: st });
  const db = maskedUrl(parsed.source.url);
  line(st.bold(`Making ${name} a Mason project in ${root}`));
  const notes: string[] = [];
  if (keptValue !== null && keptValue.value !== url) notes.push(`${kept} reads ${keptVar} from ${keptValue.from}, which is ${maskedUrl(keptValue.value)}: mason start copies from that one, not ${db}`);
  let database: { url: string; from: string | null; version: string | null; tables: number | null } = { url: db, from: from ? from.slice(2, -1) : null, version: null, tables: null };
  const rel = (p: string): string => path.relative(root, p) || ".";
  const sourceFile = kept !== null ? path.join(sourcesDir(folder), kept) : path.join(sourcesDir(folder), `${sourceNameFor(parsed.source.database)}.yml`);
  // the folder an older Mason listed the tables in: read by nothing (no backwards compatibility before v1.0), said
  const oldTables = path.join(folder, OLD_TABLES_DIR);
  if (fs.existsSync(oldTables)) notes.push(`${rel(oldTables)}/ is an older Mason's, which this one does not read: mason add each table again, then remove it`);
  // A DATABASE ON ANOTHER MACHINE, NOT CONFIRMED: not a failed step (the check passed, or was skipped) but a stop before
  // anything is written, said as one failure (remoteConfirmation) — the same words whether the check ran or not
  const confirmRemote = (): number => failed("init", remoteConfirmation(parsed.source.host, { cmd: "mason init",
    wayOut: "run the same mason init again with --remote: that says yes, copy from that machine",
    next: [["mason init --remote <url>", "the same command, confirmed"]] }), { json, io });
  try {
    if (demo) {
      // nothing exists yet: mason start makes the database (src/demo/source.ts) at its first start
      await steps.step("Choosing the demo database's port", () => null,
        () => `The demo database will be ${db}: mason start makes it in ${STATE_DIR}/${DEMO_DIR}/ and seeds it (nothing to connect to yet)`);
    } else if (f.values["skip-check"] === true) {
      if (parsed.source.remote && !remote) return confirmRemote();
      await steps.step(`Not checking ${db}${from}`, () => null, () => `Not checking ${db}${from} (--skip-check): mason start checks it`);
    } else {
      // the check's own words are its failure's (an error, then the ways out); on success its facts are the step's line
      const said: string[] = [];
      let needsRemote = false;
      const checked = await steps.step(`Connecting to ${db}${from}`, async () => {
        const c = await checkSource(url, { remote, cmd: "mason init", say: (m) => said.push(m) });
        if ("exit" in c) throw new StepFailed(said.filter((m) => !/: connecting to /.test(m)).join("\n"), c.exit);
        if ("needsRemote" in c) { needsRemote = true; return c.needsRemote; }
        return c;
      }, (c) => `Connected to ${db}${from}: Postgres ${c.facts.versionText}${c.facts.standby ? " (a read replica)" : ""}, ${c.facts.tables.length} table(s) this user can read`);
      if (needsRemote) {
        // the other warnings (a primary, a serverless host) stand; the remote one is the confirmation's own words
        for (const w of checked.warnings.filter((w) => w !== remoteWarning(checked.source))) line(`  ! ${w}`);
        return confirmRemote();
      }
      notes.push(...checked.warnings);
      database = { ...database, version: checked.facts.versionText, tables: checked.facts.tables.length };
    }
    if (sourceless) await steps.step(`Keeping ${STATE_DIR}/config.json`, () => undefined, () => `Kept ${STATE_DIR}/config.json: the project ${name}, its key and its copy`);
    else {
      await steps.step(`Writing ${STATE_DIR}/config.json`, () => {
        writeConfig(path.join(root, STATE_DIR), newConfig(name, path.relative(root, folder) || ".", remote, { demo }));
      }, () => `Wrote ${STATE_DIR}/config.json: Mason's key (this machine's)`);
    }
    if (kept !== null) {
      await steps.step(`Keeping ${rel(sourceFile)}`, () => undefined, () => `Kept ${rel(sourceFile)}: the database and the tables this project copies`);
      if (keptFile !== null && "problems" in keptFile) notes.push(`${rel(sourceFile)} has ${keptFile.problems.length === 1 ? "a mistake" : "mistakes"}, which mason start refuses: ${keptFile.problems.join("; ")}`);
    } else {
      await steps.step(`Writing ${rel(sourceFile)}`, () => {
        fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
        fs.writeFileSync(sourceFile, newSourceText(`\${${where.variable}}`, demo ? DEMO_TABLES : []));
      }, () => `Wrote ${rel(sourceFile)}: the database (url: \${${where.variable}}) and the tables to copy, ${demo ? `the demo's ${DEMO_TABLES.length} added` : "none yet (mason add)"} — commit it`);
    }
    if (where.line !== null) {
      const envLine = where.line;
      await steps.step(`Writing ${where.variable} to .env`, () => addEnvLine(root, envLine), () => `Wrote ${maskedLine(envLine)} to .env: the URL the source file names, kept out of git`);
      envFile = ENV_FILE;
    }
    // THE VERSION PIN (src/cli/pin.ts): what production's image is held to. A checkout's mason (`dev`) has none to write
    const cli = deps.version ?? version();
    const pinFile = rel(path.join(folder, PIN_FILE));
    if (parseVersion(cli) !== null) {
      await steps.step(`Writing ${pinFile}`, () => ensurePin(folder, cli),
        (wrote) => wrote ? `Wrote ${pinFile}: version ${cli}, the Mason this project is written for — commit it` : `Kept ${pinFile}`);
      const pinned = cliPinProblem(folder, cli);
      if (pinned) notes.push(pinned);
    }
    const gi = path.join(root, ".gitignore");
    const ignored = [`${STATE_DIR}/`, ...(envFile ? [envFile] : [])].join(" and ");
    await steps.step(`Ignoring ${ignored} in .gitignore`, () => {
      const before = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : null;
      const after = withIgnored(before, envFile ? [envFile] : []);
      if (after !== null) fs.writeFileSync(gi, after.text);
      return after === null ? "already" : before === null ? "made" : after.added.join(" and ");
    }, (r) => r === "already" ? `.gitignore already ignores ${ignored}` : r === "made" ? `Made .gitignore, ignoring ${ignored}` : `Added ${r} to .gitignore`);
    if (envFile && committedInGit(root, envFile)) {
      notes.push(`${envFile} holds the database URL (DATABASE_URL) and is committed in git: git rm --cached ${envFile} takes it out of the next commit (the file stays); then change the password`);
    }
  } catch (e) {
    if (!(e instanceof StepFailed)) throw e;
    // the step's own words (checkSource's: what is wrong, then the ways out as hints): the first line is the failure,
    // the rest its fix
    const [first, ...rest] = e.message.split("\n").map((l) => l.replace(/^mason init: /, ""));
    return failed("init", { message: first ?? e.message, code: e.exit === 2 ? "usage" : "failed", exit: e.exit, fix: rest.length ? rest.map((l) => l.replace(/^\s*- /, "")).join("\n") : undefined,
      why: parsed.source.remote ? undefined : `the database's URL is ${db}${from}` }, { json, io });
  }
  const next: NextStep[] = demo ? [
    ["mason start", "the demo database and Mason, in the background: its tables copied, then kept current"],
    ["mason status", "the copy keeping up with the demo's changes"],
    ["mason user add <name>", "a user for psql or a BI tool: its password and URL, printed once"],
  ] : [
    ["mason start", "Mason in the background, for this folder"],
    ["mason tables", "the database's tables and their columns"],
    ["mason add <table>", "copy a table into Mason"],
  ];
  if (json) {
    say(jsonText(INIT, { name, root, folder: path.relative(root, folder) || ".", config: path.join(root, STATE_DIR, "config.json"), demo,
      source: { name: path.basename(sourceFile).replace(/\.ya?ml$/, ""), file: sourceFile, url: keptFile !== null && !("problems" in keptFile) ? ("env" in keptFile.url ? `\${${keptFile.url.env}}` : maskedUrl(keptFile.url.literal)) : `\${${where.variable}}`,
        env: where.line === null ? null : maskedLine(where.line) },
      database, warnings: notes }, next));
    return 0;
  }
  for (const n of notes) say(`  ! ${n}`);
  say(endText({ tips: [demo ? "The demo database runs inside mason start, read by polling: a new order every few seconds; mason destroy removes it with the copy"
    : "Mason only reads your database: no setting, slot or publication is needed or made"], next }, st));
  return 0;
}
