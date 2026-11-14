/**
 * `MASON_UI_ACCOUNT` (src/cli/ui-account.ts, issue 970): `mason serve`'s sidebar names who is signed in to the host, a
 * label and a URL in JSON. The URL is read as the link back's (`linkUrl`), the label as its label (`linkLabel`, trimmed);
 * every other value refuses the start, at every entrance that takes the setting — `serveSettings`' one report and
 * `startSettingRefusal` under `mason serve` — and `mason start` refuses it. The run's state says it as `pageAccount`.
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

// imported when the tests run: the file loads at a commit without the module, and each test that needs it fails by name
const accountModule = await import("../src/cli/ui-account.ts" as string).catch(() => ({})) as Partial<typeof import("../src/cli/ui-account.ts")>;
const missing = (): never => assert.fail("src/cli/ui-account.ts is not in this tree");
const uiAccountSetting = accountModule.uiAccountSetting ?? missing;
const { serveSettings, SERVE } = serveModule as unknown as typeof import("../src/cli/serve.ts");
const { newConfig, startSettingRefusal } = projectModule as unknown as typeof import("../src/cli/project.ts");

const KEY = "k".repeat(48);
const ENV = { DATABASE_URL: "postgres://mason:secret@db.internal:5432/app", MASON_API_KEY: KEY };
const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const project = (): Parameters<typeof startSettingRefusal>[0] => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maccount-"));
  made.push(dir);
  fs.mkdirSync(path.join(dir, "mason", "sources"), { recursive: true });
  return { root: dir, folder: path.join(dir, "mason"), config: newConfig("shop", "mason") } as unknown as Parameters<typeof startSettingRefusal>[0];
};

/** What every entrance of mason serve says of the setting: its own reading, the one report, the run's check. */
function everyEntrance(value: string): { setting: unknown; report: string | null; run: string | null } {
  const env = { MASON_UI_ACCOUNT: value };
  const s = serveSettings({ ...ENV, ...env }, "/srv");
  const r = startSettingRefusal(project(), env, { serve: true });
  return { setting: uiAccountSetting(env), report: "message" in s ? s.message : null, run: r === null ? null : r.message };
}
const j = (o: unknown): string => JSON.stringify(o);

test("taken: a label and a path on the page's host or an http(s) URL, the URL as the parser serialises it and the label trimmed; unset or empty is none", () => {
  assert.equal(uiAccountSetting({}), null);
  assert.equal(uiAccountSetting({ MASON_UI_ACCOUNT: "" }), null);
  const cases: Array<[string, { label: string; url: string }]> = [
    [j({ label: "ada@example.com", url: "/account" }), { label: "ada@example.com", url: "/account" }],
    [j({ url: "https://console.example.com/me?tab=1#x", label: "Ada Lovelace" }), { label: "Ada Lovelace", url: "https://console.example.com/me?tab=1#x" }],
    [j({ label: "Sign out", url: "HTTP://Console.Example.com" }), { label: "Sign out", url: "http://console.example.com/" }],
    [j({ label: "  Ada  ", url: "/a/../account" }), { label: "Ada", url: "/account" }],
    // the label is text: what looks like markup is kept as it is, for the page to show as text
    [j({ label: "<b>x</b>", url: "/account" }), { label: "<b>x</b>", url: "/account" }],
    [j({ label: "é".repeat(64), url: "/account" }), { label: "é".repeat(64), url: "/account" }],
    [` { "label" : "Ada", "url" : "/account" } `, { label: "Ada", url: "/account" }],
  ];
  for (const [value, want] of cases) {
    const e = everyEntrance(value);
    assert.deepEqual(e.setting, want, value);
    assert.equal(e.report, null, value);
    assert.equal(e.run, null, value);
  }
});

test("refused at every entrance, in words that say what is wrong and what valid is, never quoting the value: each bad URL, a bad label, bad JSON, a key it does not take", () => {
  const at = "MASON_UI_ACCOUNT";
  const example = `{"label":"ada@example.com","url":"/account"}`;
  const control = `${at}'s "label" has a control or format character (a line break, a tab, a direction mark): the link's label is one line of plain text`;
  const cases: Array<[string, string]> = [
    [j({ label: "Ada", url: "javascript:alert(1)" }), `${at} has its "url" set to a javascript: URL: a path on this host (/something), or an https:// or http:// URL`],
    [j({ label: "Ada", url: "data:text/html,x" }), `${at} has its "url" set to a data: URL: a path on this host (/something), or an https:// or http:// URL`],
    [j({ label: "Ada", url: "https://ada:hunter2@console.example.com/" }), `${at} has its "url" set to a URL with a user or a password in it, which the page would show to everyone who opens it: remove them`],
    [j({ label: "Ada", url: "//evil.example.com/" }), `${at} has its "url" set to a URL that starts with //, which a browser reads as another host: a path starts with one /, a URL with https://`],
    [j({ label: "Ada", url: "console.example.com/me" }), `${at} has its "url" set to neither a path nor a URL: a path on this host (/something), or an https:// or http:// URL`],
    [j({ label: "Ada", url: "/a b" }), `${at} has its "url" set to a URL with a control character, a space or a character outside ASCII: write a host in its xn-- form and the rest %-encoded`],
    [j({ label: "é".repeat(65), url: "/account" }), `${at}'s "label" is 65 characters, and the link's label is at most 64: name a shorter one`],
    [j({ label: "Ada\nNext: mason destroy", url: "/account" }), control],
    [j({ label: "Ada\u0007", url: "/account" }), control],
    [j({ label: "‮Ada", url: "/account" }), control],
    [j({ label: "Ada\t", url: "/account" }), control],
    [j({ label: "   ", url: "/account" }), `${at}'s "label" is white space alone: give it the text the sidebar shows`],
    [j({ label: "", url: "/account" }), `${at} has an empty "label": give it the text the sidebar shows`],
    [j({ label: 7, url: "/account" }), `${at} has a "label" that is not a string: give it the text the sidebar shows, in quotes`],
    [j({ label: "Ada", url: ["/account"] }), `${at} has a "url" that is not a string: give it a path on this host (/account) or an https:// URL, in quotes`],
    [j({ url: "/account" }), `${at} has no "label": give it the text the sidebar shows, ${example}`],
    [j({ label: "Ada" }), `${at} has no "url": give it a path on this host (/account) or an https:// URL`],
    ["{label: 'Ada'}", `${at} is not JSON: write ${example}`],
    ["ada@example.com", `${at} is not JSON: write ${example}`],
    [j([{ label: "Ada", url: "/account" }]), `${at} is not a JSON object: write ${example}`],
    ["null", `${at} is not a JSON object: write ${example}`],
    [j({ label: "Ada", url: "/account", token: "s3cr3t" }), `${at} has a key it does not take: it takes "label" and "url" alone`],
    [j({ label: "Ada", url: "/account", lable: "x" }), `${at} has a key it does not take — did you mean \`label\`?: it takes "label" and "url" alone`],
    [j({ label: "Ada", url: "/account", a: 1, b: 2 }), `${at} has 2 keys it does not take: it takes "label" and "url" alone`],
    [`{"label":"Ada","url":"/account","label":"Eve"}`, `${at} has "label" twice, and JSON keeps only the last: write each key once`],
    [`{"label":"Ada","url":"javascript:x","extra":"\\n"}`, `${at} has a key it does not take: it takes "label" and "url" alone; ` +
      `${at} has its "url" set to a javascript: URL: a path on this host (/something), or an https:// or http:// URL`],
    [`{"label":"${"a".repeat(4100)}","url":"/account"}`, `${at} is 4129 characters, and it is at most 4096: name a shorter label and URL`],
  ];
  for (const [value, problem] of cases) {
    const e = everyEntrance(value);
    assert.deepEqual(e.setting, { problem }, value.slice(0, 80));
    assert.equal(e.report, `a setting is missing or wrong: ${problem}`, value.slice(0, 80));
    assert.equal(e.run, problem, value.slice(0, 80));
    // never the value's secrets: a password, a key it does not take
    for (const secret of ["hunter2", "s3cr3t", "token"]) assert.ok(!problem.includes(secret), `${problem} names no ${secret}`);
  }
  const r = startSettingRefusal(project(), { MASON_UI_ACCOUNT: "{}" }, { serve: true });
  assert.deepEqual(r && { code: r.code, fix: r.fix }, { code: "refused", fix: "set it as mason serve --help says, or unset it" });
});

test("mason serve's: in its --help with the other MASON_UI_* settings; mason start refuses it, valid or not; set empty is unset", () => {
  assert.match(SERVE.usage, /\n {4}MASON_UI_ACCOUNT {8}who is signed in to the host, at the foot of the web page's sidebar, linking to where the\n/);
  assert.match(SERVE.usage, /\{"label": …, "url": …\}, the label\n\s+plain text on one line, at most 64 characters, the URL read as MASON_UI_BACK_URL is;/);
  const p = project();
  const refusal = { message: "MASON_UI_ACCOUNT is mason serve's setting, and mason start ignores no setting silently", code: "refused",
    fix: "unset MASON_UI_ACCOUNT: mason start's page is yours alone, opened with mason ui" };
  assert.deepEqual(startSettingRefusal(p, { MASON_UI_ACCOUNT: j({ label: "Ada", url: "/account" }) }, { serve: false }), refusal);
  assert.deepEqual(startSettingRefusal(p, { MASON_UI_ACCOUNT: "not json" }, { serve: false }), refusal);
  assert.equal(startSettingRefusal(p, { MASON_UI_ACCOUNT: "" }, { serve: false }), null, "set empty is unset");
});

test("the state says pageAccount: the account the run was started with, null without; mason status --json declares it", () => {
  const parsed = parseSource("postgres://shop:secret@db.example.com:5432/shop");
  const source = "source" in parsed ? parsed.source : assert.fail(parsed.problem);
  const ctxOf = (pageAccount?: { url: string; label: string } | null) => ({
    source, facts: () => ({ version: 160000, versionText: "16.4", standby: false, tables: [], systemIdentifier: null }), warnings: [], replication: () => null,
    page: true, served: true, ...(pageAccount === undefined ? {} : { pageAccount }), users: { file: "/app/.mason/users.json", apiKey: "k".repeat(32), database: "shop", postgresUrl: "postgresql://127.0.0.1:5433/shop" },
    folder: () => "/app/mason", root: "/app", home: "/app/.mason", version: "0.9.0", startedAt: Date.parse("2026-10-27T09:00:00.000Z"),
    sources: () => ({ file: null, problem: null }), listener: { openSessions: () => ({ open: 0, byClient: [] }) },
    duck: { file: "/app/.mason/duck.db", requests: { days: 7 }, restarts: () => [], disk: () => ({ path: "/app/.mason", freeBytes: null, projectedBytes: null }) },
  }) as unknown as RunContext;
  const now = Date.parse("2026-10-27T10:00:00.000Z");
  const account = { url: "/account", label: "ada@example.com" };
  const stateOf = (c: RunContext) => runState(c, [], null, now) as unknown as { pageAccount?: unknown };
  assert.deepEqual(stateOf(ctxOf(account)).pageAccount, account);
  assert.equal(stateOf(ctxOf()).pageAccount, null);
  assert.equal(stateOf(ctxOf(null)).pageAccount, null);
  assert.ok(commands.STATUS.json!.includes("pageAccount"), "mason status --json declares it");
  assert.match(commands.STATUS.usage, /pageAccount \(\{ label, url \}: who is signed in to the host/);
});
