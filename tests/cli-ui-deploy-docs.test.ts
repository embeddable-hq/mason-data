/**
 * `MASON_UI_DEPLOY_DOCS_URL` (src/cli/ui-deploy-docs.ts, issue 1059): where `mason serve`'s Tables page sends a person to
 * change a deployed project. Unset, the README's "Change a deployed project". Set, the URL is read as the link back's
 * (`linkUrl`, the one reading); every other value refuses the start, at every entrance that takes the setting —
 * `serveSettings`' one report and `startSettingRefusal` under `mason serve` — and `mason start` refuses it. The run's state
 * says the URL as `pageDeployDocs`.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as serveModule from "../src/cli/serve.ts";
import * as projectModule from "../src/cli/project.ts";
import * as commands from "../src/cli/commands.ts";
import { runState, type RunContext } from "../src/cli/run-server.ts";
import { parseSource } from "../src/cli/preflight.ts";
import { linkUrl } from "../src/cli/ui-back-link.ts";

// imported when the tests run: the file loads at a commit without the module, and each test that needs it fails by name
const docsModule = await import("../src/cli/ui-deploy-docs.ts" as string).catch(() => ({})) as Partial<typeof import("../src/cli/ui-deploy-docs.ts")>;
const missing = (): never => assert.fail("src/cli/ui-deploy-docs.ts is not in this tree");
const uiDeployDocsSetting = docsModule.uiDeployDocsSetting ?? missing;
const deployDocsOf = docsModule.deployDocsOf ?? missing;
const { serveSettings, SERVE } = serveModule as unknown as typeof import("../src/cli/serve.ts");
const { newConfig, startSettingRefusal } = projectModule as unknown as typeof import("../src/cli/project.ts");

const README = "https://github.com/embeddable-hq/mason-data#change-a-deployed-project";
const KEY = "k".repeat(48);
const ENV = { DATABASE_URL: "postgres://mason:secret@db.internal:5432/app", MASON_API_KEY: KEY };
const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const project = (): Parameters<typeof startSettingRefusal>[0] => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdeploydocs-"));
  made.push(dir);
  fs.mkdirSync(path.join(dir, "mason", "sources"), { recursive: true });
  return { root: dir, folder: path.join(dir, "mason"), config: newConfig("shop", "mason") } as unknown as Parameters<typeof startSettingRefusal>[0];
};

/** What every entrance of mason serve says of the setting: its own reading, the one report, the run's check. */
function everyEntrance(value: string): { setting: unknown; report: string | null; run: string | null } {
  const env = { MASON_UI_DEPLOY_DOCS_URL: value };
  const s = serveSettings({ ...ENV, ...env }, "/srv");
  const r = startSettingRefusal(project(), env, { serve: true });
  return { setting: uiDeployDocsSetting(env), report: "message" in s ? s.message : null, run: r === null ? null : r.message };
}

test("the default: unset or empty, the page links to the README's Change a deployed project", () => {
  assert.equal(docsModule.DEPLOY_DOCS_DEFAULT, README);
  assert.equal(uiDeployDocsSetting({}), null);
  assert.equal(uiDeployDocsSetting({ MASON_UI_DEPLOY_DOCS_URL: "" }), null);
  assert.equal(deployDocsOf(null), README);
  const e = everyEntrance("");
  assert.equal(e.report, null);
  assert.equal(e.run, null);
});

test("taken: a path on the page's host or an https or http URL, as the URL parser serialises it", () => {
  const cases: Array<[string, string]> = [
    ["/docs/deploy", "/docs/deploy"],
    ["/help/a/../deploy?tab=1#steps", "/help/deploy?tab=1#steps"],
    ["https://console.example.com/docs/deploy", "https://console.example.com/docs/deploy"],
    ["HTTPS://Console.Example.com", "https://console.example.com/"],
    ["http://intranet.example.com:8080/deploy", "http://intranet.example.com:8080/deploy"],
  ];
  for (const [value, want] of cases) {
    const e = everyEntrance(value);
    assert.equal(e.setting, want, value);
    assert.equal(e.report, null, value);
    assert.equal(e.run, null, value);
    assert.equal(deployDocsOf(uiDeployDocsSetting({ MASON_UI_DEPLOY_DOCS_URL: value })), want, value);
  }
});

test("refused at every entrance in plain words, never quoting the value: a javascript: URL, a //host, a URL with a user or password, and the rest of the link back's rules", () => {
  const at = "MASON_UI_DEPLOY_DOCS_URL is set";
  const cases: Array<[string, string]> = [
    ["javascript:alert(1)", `${at} to a javascript: URL: a path on this host (/something), or an https:// or http:// URL`],
    ["JavaScript:alert(1)", `${at} to a javascript: URL: a path on this host (/something), or an https:// or http:// URL`],
    ["data:text/html,x", `${at} to a data: URL: a path on this host (/something), or an https:// or http:// URL`],
    ["//evil.example.com/deploy", `${at} to a URL that starts with //, which a browser reads as another host: a path starts with one /, a URL with https://`],
    ["/.//evil.example.com", `${at} to a path that leaves this host: a path on this host, /something`],
    ["/\\evil.example.com", `${at} to a URL with a backslash, which a browser reads as /: write / or %5C`],
    ["http://admin:hunter2@intranet.example.com/deploy", `${at} to a URL with a user or a password in it, which the page would show to everyone who opens it: remove them`],
    ["https://admin@console.example.com/", `${at} to a URL with a user or a password in it, which the page would show to everyone who opens it: remove them`],
    ["docs.example.com/deploy", `${at} to neither a path nor a URL: a path on this host (/something), or an https:// or http:// URL`],
    ["/deploy steps", `${at} to a URL with a control character, a space or a character outside ASCII: write a host in its xn-- form and the rest %-encoded`],
    [`/${"a".repeat(2048)}`, `${at} to 2049 characters, and the link to the deploy steps is at most 2048: name a shorter one`],
  ];
  for (const [value, problem] of cases) {
    const e = everyEntrance(value);
    assert.deepEqual(e.setting, { problem }, value.slice(0, 80));
    assert.equal(e.report, `a setting is missing or wrong: ${problem}`, value.slice(0, 80));
    assert.equal(e.run, problem, value.slice(0, 80));
    assert.ok(!problem.includes("hunter2") && !problem.includes("evil") && !problem.includes("alert"), `${problem} quotes nothing of the value`);
    // the one reading: what the link back says of the same value, under this setting's name
    assert.deepEqual(linkUrl(value, at, "the link to the deploy steps"), { problem }, value.slice(0, 80));
  }
  const r = startSettingRefusal(project(), { MASON_UI_DEPLOY_DOCS_URL: "javascript:x" }, { serve: true });
  assert.deepEqual(r && { code: r.code, fix: r.fix }, { code: "refused", fix: "set it as mason serve --help says, or unset it" });
});

test("the module reads the URL by the link back's one reading, never a copy of its rules", () => {
  const text = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "cli", "ui-deploy-docs.ts"), "utf8");
  assert.match(text, /import \{ linkUrl \} from "\.\/ui-back-link\.ts";/);
  assert.ok(!/new URL\(|https\?|username|\\\\/.test(text.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")), "no URL rule of its own");
});

test("mason serve's: in its --help with its default; mason start refuses it, valid or not; set empty is unset", () => {
  assert.match(SERVE.usage, /\n {4}MASON_UI_DEPLOY_DOCS_URL {2}where the web page sends a person to change this deployed project, from its Tables\n/);
  assert.ok(SERVE.usage.includes(`read as MASON_UI_BACK_URL is\n                            (default ${README})\n`), SERVE.usage);
  const p = project();
  const refusal = { message: "MASON_UI_DEPLOY_DOCS_URL is mason serve's setting, and mason start ignores no setting silently", code: "refused",
    fix: "unset MASON_UI_DEPLOY_DOCS_URL: mason start's page is yours alone, opened with mason ui" };
  assert.deepEqual(startSettingRefusal(p, { MASON_UI_DEPLOY_DOCS_URL: "/docs/deploy" }, { serve: false }), refusal);
  assert.deepEqual(startSettingRefusal(p, { MASON_UI_DEPLOY_DOCS_URL: "javascript:x" }, { serve: false }), refusal);
  assert.equal(startSettingRefusal(p, { MASON_UI_DEPLOY_DOCS_URL: "" }, { serve: false }), null, "set empty is unset");
});

test("the state says pageDeployDocs: the URL the run was started with, else the README's; mason status --json declares it", () => {
  const parsed = parseSource("postgres://shop:secret@db.example.com:5432/shop");
  const source = "source" in parsed ? parsed.source : assert.fail(parsed.problem);
  const ctxOf = (pageDeployDocs?: string) => ({
    source, facts: () => ({ version: 160000, versionText: "16.4", standby: false, tables: [], systemIdentifier: null }), warnings: [], replication: () => null,
    page: true, served: true, ...(pageDeployDocs === undefined ? {} : { pageDeployDocs }), users: { file: "/app/.mason/users.json", apiKey: "k".repeat(32), database: "shop", postgresUrl: "postgresql://127.0.0.1:5433/shop" },
    folder: () => "/app/mason", root: "/app", home: "/app/.mason", version: "0.9.0", startedAt: Date.parse("2026-10-27T09:00:00.000Z"),
    sources: () => ({ file: null, problem: null }), listener: { openSessions: () => ({ open: 0, byClient: [] }) },
    duck: { file: "/app/.mason/duck.db", requests: { days: 7 }, restarts: () => [], disk: () => ({ path: "/app/.mason", freeBytes: null, projectedBytes: null }) },
  }) as unknown as RunContext;
  const now = Date.parse("2026-10-27T10:00:00.000Z");
  const stateOf = (c: RunContext) => runState(c, [], null, now) as unknown as { pageDeployDocs?: unknown };
  assert.equal(stateOf(ctxOf("/docs/deploy")).pageDeployDocs, "/docs/deploy");
  assert.equal(stateOf(ctxOf()).pageDeployDocs, README);
  assert.ok(commands.STATUS.json!.includes("pageDeployDocs"), "mason status --json declares it");
  assert.match(commands.STATUS.usage, /pageDeployDocs \(the URL the page's Tables page\n\s+links to for changing a deployed project/);
});
