/**
 * `MASON_UI_BACK_URL` and `MASON_UI_BACK_LABEL` (src/cli/ui-back-link.ts): `mason serve`'s page links back to the site
 * that links to it. A path on the page's host or an http(s) URL; every other scheme, credentials, a control character,
 * a `//host`, a backslash and a length past the bound refuse the start, at every entrance that takes the settings —
 * `serveSettings`' one report and `startSettingRefusal` under `mason serve` — and `mason start` refuses both.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as serveModule from "../src/cli/serve.ts";
import * as projectModule from "../src/cli/project.ts";

// imported when the tests run: the file loads at a commit without the module, and each test that needs it fails by name
const backModule = await import("../src/cli/ui-back-link.ts" as string).catch(() => ({})) as Partial<typeof import("../src/cli/ui-back-link.ts")>;
const missing = (): never => assert.fail("src/cli/ui-back-link.ts is not in this tree");
const uiBackLinkSetting = backModule.uiBackLinkSetting ?? missing;
const { serveSettings, SERVE } = serveModule as unknown as typeof import("../src/cli/serve.ts");
const { newConfig, startSettingRefusal } = projectModule as unknown as typeof import("../src/cli/project.ts");

const KEY = "k".repeat(48);
const ENV = { DATABASE_URL: "postgres://mason:secret@db.internal:5432/app", MASON_API_KEY: KEY };
const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const project = (): Parameters<typeof startSettingRefusal>[0] => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mback-"));
  made.push(dir);
  fs.mkdirSync(path.join(dir, "mason", "sources"), { recursive: true });
  return { root: dir, folder: path.join(dir, "mason"), config: newConfig("shop", "mason") } as unknown as Parameters<typeof startSettingRefusal>[0];
};

/** What every entrance of mason serve says of the settings: the setting's own reading, the one report, the run's check. */
function everyEntrance(env: Record<string, string>): { setting: unknown; report: string | null; run: string | null } {
  const s = serveSettings({ ...ENV, ...env }, "/srv");
  const r = startSettingRefusal(project(), env, { serve: true });
  return { setting: uiBackLinkSetting(env), report: "message" in s ? s.message : null, run: r === null ? null : r.message };
}

test("taken: a path on the page's host and an http(s) URL, each as the URL parser serialises it; the label as given, Back by default; unset is none", () => {
  const cases: Array<[Record<string, string>, unknown]> = [
    [{}, null],
    [{ MASON_UI_BACK_URL: "" }, null],
    [{ MASON_UI_BACK_URL: "/" }, { url: "/", label: "Back" }],
    [{ MASON_UI_BACK_URL: "/apps/portal?tab=data#top" }, { url: "/apps/portal?tab=data#top", label: "Back" }],
    [{ MASON_UI_BACK_URL: "/a/../b" }, { url: "/b", label: "Back" }],
    [{ MASON_UI_BACK_URL: "https://portal.example.com/apps" }, { url: "https://portal.example.com/apps", label: "Back" }],
    [{ MASON_UI_BACK_URL: "HTTP://Portal.Example.com" }, { url: "http://portal.example.com/", label: "Back" }],
    [{ MASON_UI_BACK_URL: "https://portal.example.com:8443/x", MASON_UI_BACK_LABEL: "Back to the portal" }, { url: "https://portal.example.com:8443/x", label: "Back to the portal" }],
    [{ MASON_UI_BACK_URL: "/x", MASON_UI_BACK_LABEL: "<b>Portal</b> & co" }, { url: "/x", label: "<b>Portal</b> & co" }],
    [{ MASON_UI_BACK_URL: "/x", MASON_UI_BACK_LABEL: "Zurück zum Portal" }, { url: "/x", label: "Zurück zum Portal" }],
    [{ MASON_UI_BACK_URL: "/x", MASON_UI_BACK_LABEL: "é".repeat(64) }, { url: "/x", label: "é".repeat(64) }],
  ];
  for (const [env, want] of cases) {
    const e = everyEntrance(env);
    assert.deepEqual(e.setting, want, JSON.stringify(env));
    assert.equal(e.report, null, JSON.stringify(env));
    assert.equal(e.run, null, JSON.stringify(env));
  }
});

test("refused at every entrance of mason serve, naming the setting and the way out, never quoting the URL: another scheme, credentials, a control character, //host, a backslash, too long", () => {
  const scheme = "MASON_UI_BACK_URL is set to a %s: URL: a path on this host (/something), or an https:// or http:// URL";
  const ascii = "MASON_UI_BACK_URL is set to a URL with a control character, a space or a character outside ASCII: write a host in its xn-- form and the rest %-encoded";
  const cases: Array<[string, string]> = [
    ["javascript:alert(1)", scheme.replace("%s", "javascript")],
    ["JavaScript:alert(document.cookie)", scheme.replace("%s", "javascript")],
    ["data:text/html,<script>alert(1)</script>", scheme.replace("%s", "data")],
    ["vbscript:msgbox", scheme.replace("%s", "vbscript")],
    ["file:///etc/passwd", scheme.replace("%s", "file")],
    ["ftp://example.com/", scheme.replace("%s", "ftp")],
    ["https:portal.example.com", scheme.replace("%s", "https")],
    ["portal.example.com/apps", "MASON_UI_BACK_URL is set to neither a path nor a URL: a path on this host (/something), or an https:// or http:// URL"],
    ["//evil.example.com/x", "MASON_UI_BACK_URL is set to a URL that starts with //, which a browser reads as another host: a path starts with one /, a URL with https://"],
    ["/.//evil.example.com", "MASON_UI_BACK_URL is set to a path that leaves this host: a path on this host, /something"],
    ["/\\evil.example.com", "MASON_UI_BACK_URL is set to a URL with a backslash, which a browser reads as /: write / or %5C"],
    ["https://admin:hunter2@portal.example.com/", "MASON_UI_BACK_URL is set to a URL with a user or a password in it, which the page would show to everyone who opens it: remove them"],
    ["https://admin@portal.example.com/", "MASON_UI_BACK_URL is set to a URL with a user or a password in it, which the page would show to everyone who opens it: remove them"],
    ["https://portal.example.com/a\nb", ascii],
    ["/a\tb", ascii],
    ["/a\u0000b", ascii],
    ["/a\u007fb", ascii],
    ["/a b", ascii],
    ["https://pörtal.example.com/", ascii],
    ["/a‮b", ascii],
    [` /x`, ascii],
    [`/${"a".repeat(2048)}`, "MASON_UI_BACK_URL is set to 2049 characters, and a link back is at most 2048: name a shorter one"],
  ];
  for (const [url, problem] of cases) {
    const e = everyEntrance({ MASON_UI_BACK_URL: url });
    assert.deepEqual(e.setting, { problem }, JSON.stringify(url));
    assert.equal(e.report, `a setting is missing or wrong: ${problem}`, JSON.stringify(url));
    assert.equal(e.run, problem, JSON.stringify(url));
    assert.ok(!e.report!.includes("hunter2") && !e.report!.includes("evil"), "the value is never quoted");
  }
  assert.ok(everyEntrance({ MASON_UI_BACK_URL: `/${"a".repeat(2047)}` }).report === null, "2048 characters is taken");
});

test("the label: a control or format character, white space alone, past 64 characters, or set without the URL refuses the start; both problems on one line", () => {
  const control = "MASON_UI_BACK_LABEL has a control or format character (a line break, a tab, a direction mark): the link's label is one line of plain text";
  const cases: Array<[Record<string, string>, string]> = [
    [{ MASON_UI_BACK_URL: "/x", MASON_UI_BACK_LABEL: "Back\nNext: mason destroy" }, control],
    [{ MASON_UI_BACK_URL: "/x", MASON_UI_BACK_LABEL: "Back\u0007" }, control],
    [{ MASON_UI_BACK_URL: "/x", MASON_UI_BACK_LABEL: "Back\u0085" }, control],
    [{ MASON_UI_BACK_URL: "/x", MASON_UI_BACK_LABEL: "‮Back" }, control],
    [{ MASON_UI_BACK_URL: "/x", MASON_UI_BACK_LABEL: "Ba​ck" }, control],
    [{ MASON_UI_BACK_URL: "/x", MASON_UI_BACK_LABEL: "Back " }, control],
    [{ MASON_UI_BACK_URL: "/x", MASON_UI_BACK_LABEL: "   " }, "MASON_UI_BACK_LABEL is white space alone: name the link's label, or unset it (Back)"],
    [{ MASON_UI_BACK_URL: "/x", MASON_UI_BACK_LABEL: "é".repeat(65) }, "MASON_UI_BACK_LABEL is 65 characters, and the link's label is at most 64: name a shorter one"],
    [{ MASON_UI_BACK_LABEL: "Portal" }, "MASON_UI_BACK_LABEL is set without MASON_UI_BACK_URL, and the page has no link to label: set MASON_UI_BACK_URL too, or unset it"],
    [{ MASON_UI_BACK_URL: "javascript:x", MASON_UI_BACK_LABEL: "\t" },
      "MASON_UI_BACK_URL is set to a javascript: URL: a path on this host (/something), or an https:// or http:// URL; " + control],
  ];
  for (const [env, problem] of cases) {
    const e = everyEntrance(env);
    assert.deepEqual(e.setting, { problem }, JSON.stringify(env));
    assert.equal(e.report, `a setting is missing or wrong: ${problem}`, JSON.stringify(env));
    assert.equal(e.run, problem, JSON.stringify(env));
  }
  const r = startSettingRefusal(project(), { MASON_UI_BACK_URL: "data:x" }, { serve: true });
  assert.deepEqual(r && { code: r.code, fix: r.fix }, { code: "refused", fix: "set it as mason serve --help says, or unset it" });
});

test("mason serve's: in its --help with the other MASON_UI_* settings; mason start refuses either, naming it, valid or not", () => {
  assert.match(SERVE.usage, /\n {4}MASON_UI_BACK_URL {7}a link back to the site that links to the web page, at the top of its sidebar, in the same\n/);
  assert.match(SERVE.usage, /\n {4}MASON_UI_BACK_LABEL {5}the link's label, plain text on one line, at most 64 characters; set alone it is\n/);
  assert.match(SERVE.usage, /at most 2048 characters; any other scheme is refused/);
  const p = project();
  assert.deepEqual(startSettingRefusal(p, { MASON_UI_BACK_URL: "/portal" }, { serve: false }),
    { message: "MASON_UI_BACK_URL is mason serve's setting, and mason start ignores no setting silently", code: "refused",
      fix: "unset MASON_UI_BACK_URL: mason start's page is yours alone, opened with mason ui" });
  assert.deepEqual(startSettingRefusal(p, { MASON_UI_BACK_URL: "javascript:x", MASON_UI_BACK_LABEL: "Portal" }, { serve: false }),
    { message: "MASON_UI_BACK_URL and MASON_UI_BACK_LABEL are mason serve's settings, and mason start ignores no setting silently", code: "refused",
      fix: "unset MASON_UI_BACK_URL and MASON_UI_BACK_LABEL: mason start's page is yours alone, opened with mason ui" });
  assert.equal(startSettingRefusal(p, { MASON_UI_BACK_LABEL: "Portal" }, { serve: false })?.message,
    "MASON_UI_BACK_LABEL is mason serve's setting, and mason start ignores no setting silently");
  assert.equal(startSettingRefusal(p, { MASON_UI_BACK_URL: "" }, { serve: false }), null, "set empty is unset");
});
