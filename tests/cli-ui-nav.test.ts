/**
 * `MASON_UI_NAV_<ITEM>_URL` and `MASON_UI_NAV_LINKS` (src/cli/ui-nav.ts, issue 789): `mason serve`'s sidebar as the host
 * says it — an item replaced by a link to the host's page, and the host's own links. Each URL and label read by the link
 * back's one reading (src/cli/ui-back-link.ts); anything else refuses the start at every entrance that takes the
 * settings — `serveSettings`' one report and `startSettingRefusal` under `mason serve` — and `mason start` refuses them.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as serveModule from "../src/cli/serve.ts";
import * as projectModule from "../src/cli/project.ts";

// imported when the tests run: the file loads at a commit without the module, and each test that needs it fails by name
const navModule = await import("../src/cli/ui-nav.ts" as string).catch(() => ({})) as Partial<typeof import("../src/cli/ui-nav.ts")>;
const missing = (): never => assert.fail("src/cli/ui-nav.ts is not in this tree");
const uiNavSetting = navModule.uiNavSetting ?? missing;
const navLines = navModule.navLines ?? missing;
const { serveSettings, SERVE } = serveModule as unknown as typeof import("../src/cli/serve.ts");
const { newConfig, startSettingRefusal } = projectModule as unknown as typeof import("../src/cli/project.ts");

const KEY = "k".repeat(48);
const ENV = { DATABASE_URL: "postgres://mason:secret@db.internal:5432/app", MASON_API_KEY: KEY };
const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const project = (): Parameters<typeof startSettingRefusal>[0] => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnav-"));
  made.push(dir);
  fs.mkdirSync(path.join(dir, "mason", "sources"), { recursive: true });
  return { root: dir, folder: path.join(dir, "mason"), config: newConfig("shop", "mason") } as unknown as Parameters<typeof startSettingRefusal>[0];
};

/** What every entrance of mason serve says of the settings: the setting's own reading, the one report, the run's check. */
function everyEntrance(env: Record<string, string>): { setting: unknown; report: string | null; run: string | null } {
  const s = serveSettings({ ...ENV, ...env }, "/srv");
  const r = startSettingRefusal(project(), env, { serve: true });
  return { setting: uiNavSetting(env), report: "message" in s ? s.message : null, run: r === null ? null : r.message };
}

const ITEMS = [["OVERVIEW", "overview"], ["TABLES", "tables"], ["USERS", "users"], ["QUERIES", "queries"], ["USAGE", "usage"], ["SYNC_EVENTS", "syncEvents"]] as const;

test("taken: each item's URL as the URL parser serialises it, the host's links as given (labels as text, <script> too); unset, empty or [] is none", () => {
  const cases: Array<[Record<string, string>, unknown]> = [
    [{}, null],
    [{ MASON_UI_NAV_USERS_URL: "" }, null],
    [{ MASON_UI_NAV_LINKS: "" }, null],
    [{ MASON_UI_NAV_LINKS: "[]" }, null],
    [{ MASON_UI_NAV_USERS_URL: "/console/db/users?tab=1#x" }, { items: { users: "/console/db/users?tab=1#x" }, links: [] }],
    [{ MASON_UI_NAV_USERS_URL: "/a/../b" }, { items: { users: "/b" }, links: [] }],
    [{ MASON_UI_NAV_QUERIES_URL: "HTTPS://Console.Example.com" }, { items: { queries: "https://console.example.com/" }, links: [] }],
    [{ MASON_UI_NAV_LINKS: `[{"label":"Billing","url":"/billing"},{"url":"https://console.example.com/net","label":"<script>alert(1)</script> & co"}]` },
      { items: {}, links: [{ label: "Billing", url: "/billing" }, { label: "<script>alert(1)</script> & co", url: "https://console.example.com/net" }] }],
    [{ MASON_UI_NAV_LINKS: JSON.stringify(Array.from({ length: 5 }, (_, i) => ({ label: `L${i}`, url: `/l${i}` }))) },
      { items: {}, links: Array.from({ length: 5 }, (_, i) => ({ label: `L${i}`, url: `/l${i}` })) }],
  ];
  for (const [item, key] of ITEMS) cases.push([{ [`MASON_UI_NAV_${item}_URL`]: `/host/${key}` }, { items: { [key]: `/host/${key}` }, links: [] }]);
  cases.push([Object.fromEntries(ITEMS.map(([item, key]) => [`MASON_UI_NAV_${item}_URL`, `/host/${key}`])),
    { items: Object.fromEntries(ITEMS.map(([, key]) => [key, `/host/${key}`])), links: [] }]);
  for (const [env, want] of cases) {
    const e = everyEntrance(env);
    assert.deepEqual(e.setting, want, JSON.stringify(env));
    assert.equal(e.report, null, JSON.stringify(env));
    assert.equal(e.run, null, JSON.stringify(env));
  }
});

test("an item's URL refused as the link back's, at every entrance, naming the setting and never quoting the URL: javascript:, data:, //host, a backslash, credentials, a control character, too long", () => {
  const scheme = (s: string) => `MASON_UI_NAV_USERS_URL is set to a ${s}: URL: a path on this host (/something), or an https:// or http:// URL`;
  const ascii = "MASON_UI_NAV_USERS_URL is set to a URL with a control character, a space or a character outside ASCII: write a host in its xn-- form and the rest %-encoded";
  const cases: Array<[string, string]> = [
    ["javascript:alert(1)", scheme("javascript")],
    ["JavaScript:alert(document.cookie)", scheme("javascript")],
    ["data:text/html,<script>alert(1)</script>", scheme("data")],
    ["users", "MASON_UI_NAV_USERS_URL is set to neither a path nor a URL: a path on this host (/something), or an https:// or http:// URL"],
    ["//evil.example.com/x", "MASON_UI_NAV_USERS_URL is set to a URL that starts with //, which a browser reads as another host: a path starts with one /, a URL with https://"],
    ["/.//evil.example.com", "MASON_UI_NAV_USERS_URL is set to a path that leaves this host: a path on this host, /something"],
    ["/\\evil.example.com", "MASON_UI_NAV_USERS_URL is set to a URL with a backslash, which a browser reads as /: write / or %5C"],
    ["https://admin:hunter2@console.example.com/", "MASON_UI_NAV_USERS_URL is set to a URL with a user or a password in it, which the page would show to everyone who opens it: remove them"],
    ["/a\nb", ascii], ["/a\u0000b", ascii], ["/a b", ascii], ["/a‮b", ascii],
    [`/${"a".repeat(2048)}`, "MASON_UI_NAV_USERS_URL is set to 2049 characters, and the Users item's link is at most 2048: name a shorter one"],
  ];
  for (const [url, problem] of cases) {
    const e = everyEntrance({ MASON_UI_NAV_USERS_URL: url });
    assert.deepEqual(e.setting, { problem }, JSON.stringify(url));
    assert.equal(e.report, `a setting is missing or wrong: ${problem}`, JSON.stringify(url));
    assert.equal(e.run, problem, JSON.stringify(url));
    assert.ok(!e.report!.includes("hunter2") && !e.report!.includes("evil"), "the value is never quoted");
  }
  assert.equal(everyEntrance({ MASON_UI_NAV_USERS_URL: `/${"a".repeat(2047)}` }).report, null, "2048 characters is taken");
  // every item is read so, and two problems are one line
  for (const [item] of ITEMS) assert.match(String((uiNavSetting({ [`MASON_UI_NAV_${item}_URL`]: "javascript:x" }) as { problem: string }).problem), new RegExp(`^MASON_UI_NAV_${item}_URL is set to a javascript: URL`));
  assert.deepEqual(uiNavSetting({ MASON_UI_NAV_TABLES_URL: "data:x", MASON_UI_NAV_USAGE_URL: "//x" }), { problem:
    "MASON_UI_NAV_TABLES_URL is set to a data: URL: a path on this host (/something), or an https:// or http:// URL; " +
    "MASON_UI_NAV_USAGE_URL is set to a URL that starts with //, which a browser reads as another host: a path starts with one /, a URL with https://" });
  const r = startSettingRefusal(project(), { MASON_UI_NAV_USERS_URL: "data:x" }, { serve: true });
  assert.deepEqual(r && { code: r.code, fix: r.fix }, { code: "refused", fix: "set them as mason serve --help says, or unset them" });
});

test("MASON_UI_NAV_LINKS refused at every entrance, each problem saying the entry and the way out: not JSON, not a list, too many, an entry not an object, a key it does not take, no label or url, a bad label or URL, too long", () => {
  const at = "MASON_UI_NAV_LINKS";
  const control = `${at}'s entry 1's label has a control or format character (a line break, a tab, a direction mark): the link's label is one line of plain text`;
  const link = (o: Record<string, unknown>) => JSON.stringify([o]);
  const cases: Array<[string, string]> = [
    ["{label: Billing}", `${at} is not JSON: write a list of links, [{"label":"Billing","url":"/billing"}]`],
    [`{"label":"Billing","url":"/billing"}`, `${at} is not a list: write a list of links, [{"label":"Billing","url":"/billing"}]`],
    ["null", `${at} is not a list: write a list of links, [{"label":"Billing","url":"/billing"}]`],
    [JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ label: `L${i}`, url: `/l${i}` }))), `${at} has 6 links, and the sidebar takes at most 5: keep the ones the page's readers need`],
    [`["/billing"]`, `${at}'s entry 1 is not an object: each link is {"label": …, "url": …} or {"label": …, "view": …}`],
    [`[[1]]`, `${at}'s entry 1 is not an object: each link is {"label": …, "url": …} or {"label": …, "view": …}`],
    [link({ lable: "Billing", url: "/billing" }), `${at}'s entry 1 has a key a link does not take (its 1st) — did you mean \`label\`?: a link is {"label": …, "url": …} or {"label": …, "view": …}; ${at}'s entry 1 has no label: give it "label", the text the sidebar shows`],
    [link({ label: "Billing", url: "/billing", target: "_blank" }), `${at}'s entry 1 has a key a link does not take (its 3rd): a link is {"label": …, "url": …} or {"label": …, "view": …}`],
    [link({ url: "/billing" }), `${at}'s entry 1 has no label: give it "label", the text the sidebar shows`],
    [link({ label: "Billing" }), `${at}'s entry 1 has no url: give it "url", a path on this host (/something) or an https:// URL, or "view", a path relative to the page's own address`],
    [link({ label: 7, url: 8 }), `${at}'s entry 1 has no label: give it "label", the text the sidebar shows; ${at}'s entry 1 has no url: give it "url", a path on this host (/something) or an https:// URL, or "view", a path relative to the page's own address`],
    [link({ label: "Bill\ning", url: "/billing" }), control],
    [link({ label: "‮Billing", url: "/billing" }), control],
    [link({ label: "  ", url: "/billing" }), `${at}'s entry 1's label is white space alone: name the link`],
    [link({ label: "é".repeat(65), url: "/billing" }), `${at}'s entry 1's label is 65 characters, and the link's label is at most 64: name a shorter one`],
    [link({ label: "Billing", url: "javascript:alert(1)" }), `${at}'s entry 1 has its url set to a javascript: URL: a path on this host (/something), or an https:// or http:// URL`],
    [link({ label: "Billing", url: "data:text/html,x" }), `${at}'s entry 1 has its url set to a data: URL: a path on this host (/something), or an https:// or http:// URL`],
    [link({ label: "Billing", url: "//evil.example.com" }), `${at}'s entry 1 has its url set to a URL that starts with //, which a browser reads as another host: a path starts with one /, a URL with https://`],
    [link({ label: "Billing", url: "/\\evil.example.com" }), `${at}'s entry 1 has its url set to a URL with a backslash, which a browser reads as /: write / or %5C`],
    [link({ label: "Billing", url: "https://admin:hunter2@evil.example.com/" }), `${at}'s entry 1 has its url set to a URL with a user or a password in it, which the page would show to everyone who opens it: remove them`],
    [link({ label: "Billing", url: "/a\tb" }), `${at}'s entry 1 has its url set to a URL with a control character, a space or a character outside ASCII: write a host in its xn-- form and the rest %-encoded`],
    [link({ label: "Billing", url: `/${"a".repeat(2048)}` }), `${at}'s entry 1 has its url set to 2049 characters, and a link is at most 2048: name a shorter one`],
    [JSON.stringify([{ label: "Billing", url: "/billing" }, { label: "\t", url: "ftp://x" }]),
      `${at}'s entry 2's label has a control or format character (a line break, a tab, a direction mark): the link's label is one line of plain text; ${at}'s entry 2 has its url set to a ftp: URL: a path on this host (/something), or an https:// or http:// URL`],
    [" ".repeat(16_385), `${at} is 16385 characters, and the list is at most 16384: name fewer or shorter links`],
  ];
  for (const [text, problem] of cases) {
    const e = everyEntrance({ MASON_UI_NAV_LINKS: text });
    assert.deepEqual(e.setting, { problem }, text.slice(0, 80));
    assert.equal(e.report, `a setting is missing or wrong: ${problem}`, text.slice(0, 80));
    assert.equal(e.run, problem, text.slice(0, 80));
    assert.ok(!e.report!.includes("hunter2") && !e.report!.includes("evil"), "a value is never quoted");
  }
});

test("a key of a MASON_UI_NAV_LINKS entry that a link does not take is never quoted, whatever it is (a secret pasted as a key): its place is named", () => {
  const at = "MASON_UI_NAV_LINKS";
  const takes = (n: string) => `${at}'s entry 1 has a key a link does not take (its ${n}): a link is {"label": …, "url": …} or {"label": …, "view": …}`;
  for (const [text, problem] of [
    [`[{"label":"Billing","url":"/billing","password=hunter2":1}]`, takes("3rd")],
    [`[{"hunter2":"x","label":"Billing","url":"/billing"}]`, takes("1st")],
    [JSON.stringify([{ label: "Billing", ["k‮".repeat(3)]: 1, url: "/billing" }]), takes("2nd")],
    [`[{"label":"Billing","url":"/billing","1":2}]`, takes("3rd")],
    [`[{"label":"Billing","url":"/billing","a":1,"b":2,"c":3,"d":4,"e":5,"f":6,"g":7,"h":8,"i":9}]`,
      ["3rd", "4th", "5th", "6th", "7th", "8th", "9th", "10th", "11th"].map(takes).join("; ")],
  ] as const) {
    const e = everyEntrance({ MASON_UI_NAV_LINKS: text });
    assert.deepEqual(e.setting, { problem }, text);
    assert.equal(e.report, `a setting is missing or wrong: ${problem}`, text);
    assert.equal(e.run, problem, text);
    for (const secret of ["hunter2", "password", "k‮"]) assert.ok(!e.report!.includes(secret), `${text}: the key is never quoted`);
  }
});

test("a key written twice in a MASON_UI_NAV_LINKS entry refuses the start, naming the entry and the places, as JSON.parse reads the keys (escapes, white space before the colon), never a key nested in a value", () => {
  const at = "MASON_UI_NAV_LINKS";
  const twice = (entry: number, key: string, places: string) => `${at}'s entry ${entry} has ${key} twice (its ${places}), and JSON keeps only the last: write each key once`;
  for (const [text, problem] of [
    [`[{"label":"a","label":"b","url":"/x"}]`, twice(1, `"label"`, "1st, 2nd")],
    [`[{"label":"a","url":"/x","\\u006cabel":"b"}]`, twice(1, `"label"`, "1st, 3rd")],
    [`[{"url":"/x" , "label" \n : "a","url"\t:"/y"}]`, twice(1, `"url"`, "1st, 3rd")],
    [`[{"label":"a","url":"/x","url":"/y","url":"/z"}]`, `${at}'s entry 1 has "url" 3 times (its 2nd, 3rd, 4th), and JSON keeps only the last: write each key once`],
    [`[{"label":"a","url":"/x","hunter2":1,"hunter2":2}]`,
      `${at}'s entry 1 has a key a link does not take (its 3rd): a link is {"label": …, "url": …} or {"label": …, "view": …}; ${twice(1, "a key", "3rd, 4th")}`],
    // the entry is the list's, counted past strings holding commas, brackets, braces, colons and escaped quotes
    [`["a,[{\\"label\\":1,\\"label\\":2}]:", {"label":"a","url":"/x"}, {"label":"b","url":"/y","label":"c"}]`,
      `${at}'s entry 1 is not an object: each link is {"label": …, "url": …} or {"label": …, "view": …}; ${twice(3, `"label"`, "1st, 3rd")}`],
    // a key nested in a value is not the entry's: the value is refused as it is
    [`[{"label":{"label":1,"label":2},"url":"/x"}]`, `${at}'s entry 1 has no label: give it "label", the text the sidebar shows`],
  ] as const) {
    const e = everyEntrance({ MASON_UI_NAV_LINKS: text });
    assert.deepEqual(e.setting, { problem }, text);
    assert.equal(e.report, `a setting is missing or wrong: ${problem}`, text);
    assert.equal(e.run, problem, text);
  }
  // a key that is a string's text, or a value equal to a key, is no repeat
  for (const text of [`[{"label":"url","url":"/label"}]`, `[{"label":"a\\"label\\":","url":"/x"}]`]) {
    assert.equal(everyEntrance({ MASON_UI_NAV_LINKS: text }).report, null, text);
  }
});

test("a URL whose fragment names a view that is replaced refuses the start, at every entrance: the page would go round in a loop (two and three items, aliases and sub-routes, /?a#tables, https://, itself); one naming a view not replaced, or none, is taken", () => {
  const loop = (setting: string, view: string, by: string) => `${setting} is set to a URL whose #fragment names the page's ${view} view, which ${by}: ` +
    "where the URL is this page, it would send the page round in a loop. Name the host's page without that fragment, or with one of a view no MASON_UI_NAV_*_URL replaces";
  const U = "MASON_UI_NAV_USERS_URL", T = "MASON_UI_NAV_TABLES_URL", Q = "MASON_UI_NAV_QUERIES_URL", O = "MASON_UI_NAV_OVERVIEW_URL", S = "MASON_UI_NAV_SYNC_EVENTS_URL";
  const cases: Array<[Record<string, string>, string[]]> = [
    // two items, each the other's (the review's B1: loaded one and the other for ever)
    [{ [U]: "/#tables", [T]: "/#users" }, [loop(T, "Users", `${U} replaces`), loop(U, "Tables", `${T} replaces`)]],
    [{ [U]: "/?a#tables", [T]: "/?b#users" }, [loop(T, "Users", `${U} replaces`), loop(U, "Tables", `${T} replaces`)]],
    // three in a ring: each URL names a replaced view
    [{ [U]: "/#tables", [T]: "/#observability/queries", [Q]: "/#users" },
      [loop(T, "Queries", `${Q} replaces`), loop(U, "Tables", `${T} replaces`), loop(Q, "Users", `${U} replaces`)]],
    // aliases and sub-routes, as the page's router maps them; an https:// URL as a path
    [{ [U]: "https://console.example.com/mason/#queries?range=7d", [Q]: "/q" }, [loop(U, "Queries", `${Q} replaces`)]],
    [{ [U]: "/#observability", [Q]: "/q" }, [loop(U, "Queries", `${Q} replaces`)]],
    [{ [U]: "/#status", [O]: "/o" }, [loop(U, "Overview", `${O} replaces`)]],
    [{ [U]: "/#overview?x=1", [O]: "/o" }, [loop(U, "Overview", `${O} replaces`)]],
    [{ [U]: "/#logs", [S]: "/s" }, [loop(U, "Sync events", `${S} replaces`)]],
    [{ [U]: "/#observability/logs", [S]: "/s" }, [loop(U, "Sync events", `${S} replaces`)]],
    // itself
    [{ [U]: "/#users" }, [loop(U, "Users", "it replaces itself")]],
    [{ [U]: "/#users?tab=1" }, [loop(U, "Users", "it replaces itself")]],
    [{ [O]: "https://console.example.com/#status" }, [loop(O, "Overview", "it replaces itself")]],
  ];
  for (const [env, problems] of cases) {
    const problem = problems.join("; ");
    const e = everyEntrance(env);
    assert.deepEqual(e.setting, { problem }, JSON.stringify(env));
    assert.equal(e.report, `a setting is missing or wrong: ${problem}`, JSON.stringify(env));
    assert.equal(e.run, problem, JSON.stringify(env));
  }
  // taken: a fragment naming a view NOT replaced (a single pointer into the page), naming none, or no fragment
  for (const [env, items] of [
    [{ [U]: "/#tables" }, { users: "/#tables" }],
    [{ [U]: "/?a#observability/usage?range=7d", [T]: "/#overview" }, { users: "/?a#observability/usage?range=7d", tables: "/#overview" }],
    [{ [U]: "/#top", [T]: "/t#" }, { users: "/#top", tables: "/t" }],
    [{ [O]: "/" }, { overview: "/" }],
    [{ [U]: "/#%75sers" }, { users: "/#%75sers" }],
  ] as const) {
    const e = everyEntrance(env);
    assert.deepEqual(e.setting, { items, links: [] }, JSON.stringify(env));
    assert.equal(e.report, null, JSON.stringify(env));
  }
});

test("the sidebar's items are the page's own: each NAV_ITEMS key is a view of src/web/routes.js, the one list the router reads", async () => {
  const routes = await import("../src/web/routes.js" as string) as { NAV_ITEM_VIEWS: Record<string, string>; VIEW_HASHES: Record<string, string> };
  assert.deepEqual(navModule.NAV_ITEMS!.map((i) => i.item), Object.keys(routes.NAV_ITEM_VIEWS));
  assert.deepEqual(Object.values(routes.NAV_ITEM_VIEWS).sort(), Object.keys(routes.VIEW_HASHES).sort(), "every view an item");
});

test("a MASON_UI_NAV_* that is no setting refuses the start with a did you mean, never ignored; with the others' problems on one line", () => {
  const list = "MASON_UI_NAV_OVERVIEW_URL, MASON_UI_NAV_TABLES_URL, MASON_UI_NAV_USERS_URL, MASON_UI_NAV_QUERIES_URL, MASON_UI_NAV_USAGE_URL, MASON_UI_NAV_SYNC_EVENTS_URL, MASON_UI_NAV_LINKS";
  const cases: Array<[Record<string, string>, string]> = [
    [{ MASON_UI_NAV_USER_URL: "/host/users" }, `MASON_UI_NAV_USER_URL is not a setting — did you mean \`MASON_UI_NAV_USERS_URL\`?: the sidebar's settings are ${list}`],
    [{ MASON_UI_NAV_LINK: "[]" }, `MASON_UI_NAV_LINK is not a setting — did you mean \`MASON_UI_NAV_LINKS\`?: the sidebar's settings are ${list}`],
    [{ MASON_UI_NAV_LOGS_URL: "/x" }, `MASON_UI_NAV_LOGS_URL is not a setting: the sidebar's settings are ${list}`],
  ];
  for (const [env, problem] of cases) {
    const e = everyEntrance(env);
    assert.deepEqual(e.setting, { problem }, JSON.stringify(env));
    assert.equal(e.report, `a setting is missing or wrong: ${problem}`);
    assert.equal(e.run, problem);
  }
  assert.equal(uiNavSetting({ MASON_UI_NAV_USER_URL: "" }), null, "set empty is unset");
});

test("mason serve's: in its --help with the other MASON_UI_* settings, said at its start; mason start refuses any, naming it, valid or not", () => {
  assert.match(SERVE.usage, /\n {4}MASON_UI_NAV_<ITEM>_URL {2}an item of the web page's sidebar links to the host's own page instead, in the same tab,\n/);
  assert.match(SERVE.usage, /<ITEM> is OVERVIEW, TABLES, USERS, QUERIES, USAGE or SYNC_EVENTS/);
  assert.match(SERVE.usage, /\n {4}MASON_UI_NAV_LINKS {6}the host's own links in the sidebar, a group of their own, in the same tab: a JSON list\n {28}of at most 5 \{"label": …, "url": …\}/);
  assert.deepEqual(navLines(null), []);
  assert.deepEqual(navLines({ items: { users: "/u", syncEvents: "/s" }, links: [{ label: "Billing", url: "/b" }, { label: "Net\"work", url: "/n" }] }), [
    "the sidebar's Users, Sync events link to the host's pages (MASON_UI_NAV_USERS_URL, MASON_UI_NAV_SYNC_EVENTS_URL)",
    `the sidebar links to "Billing", "Net\\"work" (MASON_UI_NAV_LINKS)`]);
  assert.deepEqual(navLines({ items: { tables: "/t" }, links: [] }), ["the sidebar's Tables links to the host's page (MASON_UI_NAV_TABLES_URL)"]);
  const p = project();
  assert.deepEqual(startSettingRefusal(p, { MASON_UI_NAV_USERS_URL: "/host/users" }, { serve: false }),
    { message: "MASON_UI_NAV_USERS_URL is mason serve's setting, and mason start ignores no setting silently", code: "refused",
      fix: "unset MASON_UI_NAV_USERS_URL: mason start's page is yours alone, opened with mason ui" });
  assert.deepEqual(startSettingRefusal(p, { MASON_UI_NAV_LINKS: "nope", MASON_UI_NAV_OVERVIEW_URL: "javascript:x" }, { serve: false }),
    { message: "MASON_UI_NAV_OVERVIEW_URL and MASON_UI_NAV_LINKS are mason serve's settings, and mason start ignores no setting silently", code: "refused",
      fix: "unset MASON_UI_NAV_OVERVIEW_URL and MASON_UI_NAV_LINKS: mason start's page is yours alone, opened with mason ui" });
  // a name that is no setting is said so, as mason serve says it (with its did you mean), never called mason serve's
  const list = "MASON_UI_NAV_OVERVIEW_URL, MASON_UI_NAV_TABLES_URL, MASON_UI_NAV_USERS_URL, MASON_UI_NAV_QUERIES_URL, MASON_UI_NAV_USAGE_URL, MASON_UI_NAV_SYNC_EVENTS_URL, MASON_UI_NAV_LINKS";
  assert.deepEqual(startSettingRefusal(p, { MASON_UI_NAV_FOO: "1" }, { serve: false }),
    { message: `MASON_UI_NAV_FOO is not a setting: the sidebar's settings are ${list}`, code: "refused",
      fix: "unset MASON_UI_NAV_FOO: mason start's page is yours alone, opened with mason ui" });
  assert.equal(startSettingRefusal(p, { MASON_UI_NAV_USER_URL: "/x" }, { serve: false })?.message,
    `MASON_UI_NAV_USER_URL is not a setting — did you mean \`MASON_UI_NAV_USERS_URL\`?: the sidebar's settings are ${list}`, "a misspelt one");
  assert.equal(startSettingRefusal(p, { MASON_UI_NAV_USER_URL: "/x", MASON_UI_NAV_LINKS: "[]" }, { serve: false })?.message,
    `MASON_UI_NAV_USER_URL is not a setting — did you mean \`MASON_UI_NAV_USERS_URL\`?: the sidebar's settings are ${list}; ` +
    "MASON_UI_NAV_LINKS is mason serve's setting, and mason start ignores no setting silently", "beside one of mason serve's");
  assert.equal(startSettingRefusal(p, { MASON_UI_NAV_USERS_URL: "" }, { serve: false }), null, "set empty is unset");
});

// ------------------------------------------------------------------ the host's views and card (issue 814)

const hostModule = await import("../src/cli/ui-host-view.ts" as string).catch(() => ({})) as Partial<typeof import("../src/cli/ui-host-view.ts")>;
const uiOverviewCardSetting = hostModule.uiOverviewCardSetting ?? missing;

/** What every entrance of mason serve says of MASON_UI_OVERVIEW_CARD: the setting's own reading, the one report, the run's check. */
function cardEntrance(v: string): { setting: unknown; report: string | null; run: string | null } {
  const env = { MASON_UI_OVERVIEW_CARD: v };
  const s = serveSettings({ ...ENV, ...env }, "/srv");
  const r = startSettingRefusal(project(), env, { serve: true });
  return { setting: uiOverviewCardSetting(env), report: "message" in s ? s.message : null, run: r === null ? null : r.message };
}

/** Each path a view or the card is refused for, and the problem's words after "<where> to ". */
const WAY = "a path relative to the page's own address, host/status.json";
const PATH_REFUSALS: Array<[string, string]> = [
  ["https://console.example.com/status.json", `a URL with a scheme: ${WAY}`],
  ["javascript:alert(1)", `a URL with a scheme: ${WAY}`],
  ["data:application/json,{}", `a URL with a scheme: ${WAY}`],
  ["//evil.example.com/x", `a path that starts with //, which a browser reads as another host: ${WAY}`],
  ["/host/status.json", `a path from the host's root, which misses the page under a proxy's prefix: ${WAY}`],
  ["../status.json", `a path with a .. segment, which climbs out of the page's address: ${WAY}`],
  ["host/../../x", `a path with a .. segment, which climbs out of the page's address: ${WAY}`],
  ["host/%2E%2e/x", `a path with a .. segment, which climbs out of the page's address: ${WAY}`],
  ["host\\status.json", "a path with a backslash, which a browser reads as /: write / or %5C"],
  ["host/a b", "a path with a control character, a space or a character outside ASCII: write it %-encoded"],
  ["host/é", "a path with a control character, a space or a character outside ASCII: write it %-encoded"],
  ["host/status.json#x", "a path with a #fragment, which is never sent: remove it"],
  [`h/${"a".repeat(2047)}`, "2049 characters, and a view's path is at most 2048: name a shorter one"],
];

test("a host's view in MASON_UI_NAV_LINKS: { label, view } taken beside links, its path as written; counted within the 5; MASON_UI_OVERVIEW_CARD taken; unset or empty, none", () => {
  const links = [{ label: "Billing", url: "/billing" }, { label: "Server", view: "host/status.json" }, { label: "<img src=x onerror=alert(1)>", view: "./a/b?x=1&y=..%2F" }];
  const e = everyEntrance({ MASON_UI_NAV_LINKS: JSON.stringify(links) });
  assert.deepEqual(e, { setting: { items: {}, links }, report: null, run: null });
  const six = JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ label: `V${i}`, view: `v/${i}` })));
  assert.equal(everyEntrance({ MASON_UI_NAV_LINKS: six }).run, "MASON_UI_NAV_LINKS has 6 links, and the sidebar takes at most 5: keep the ones the page's readers need");
  assert.deepEqual(cardEntrance("host/card.json"), { setting: "host/card.json", report: null, run: null });
  assert.deepEqual(cardEntrance("card?for=overview"), { setting: "card?for=overview", report: null, run: null });
  assert.equal(uiOverviewCardSetting({}), null);
  assert.equal(uiOverviewCardSetting({ MASON_UI_OVERVIEW_CARD: "" }), null, "set empty is unset");
});

test("a host view's path and MASON_UI_OVERVIEW_CARD refused at every entrance, never quoting the value: a URL, //, /, .., a backslash, a space, a fragment, too long; both url and view; view not text", () => {
  const at = "MASON_UI_NAV_LINKS";
  for (const [v, why] of PATH_REFUSALS) {
    const view = everyEntrance({ MASON_UI_NAV_LINKS: JSON.stringify([{ label: "Billing", url: "/billing" }, { label: "Server", view: v }]) });
    const problem = `${at}'s entry 2 has its view set to ${why}`;
    assert.deepEqual(view, { setting: { problem }, report: `a setting is missing or wrong: ${problem}`, run: problem }, v);
    const card = cardEntrance(v);
    const cardProblem = `MASON_UI_OVERVIEW_CARD is set to ${why}`;
    assert.deepEqual(card, { setting: { problem: cardProblem }, report: `a setting is missing or wrong: ${cardProblem}`, run: cardProblem }, v);
    for (const said of [view.report!, card.report!]) assert.ok(!said.includes("evil") && !said.includes("status.json#x") && !said.includes("alert"), `${v}: never quoted`);
  }
  const cases: Array<[unknown, string]> = [
    [{ label: "Server", url: "/server", view: "host/status.json" }, `${at}'s entry 1 has both "url" and "view": give it one, "url" for a link elsewhere or "view" for a view the page shows`],
    [{ label: "Server", view: 7 }, `${at}'s entry 1 has its view set to no text: give it "view", ${WAY}`],
    [{ label: "Server", view: "" }, `${at}'s entry 1 has its view set to nothing: ${WAY}`],
    [{ view: "host/status.json" }, `${at}'s entry 1 has no label: give it "label", the text the sidebar shows`],
    [{ label: "Server", veiw: "host/status.json" }, `${at}'s entry 1 has a key a link does not take (its 2nd) — did you mean \`view\`?: a link is {"label": …, "url": …} or {"label": …, "view": …}; ` +
      `${at}'s entry 1 has no url: give it "url", a path on this host (/something) or an https:// URL, or "view", a path relative to the page's own address`],
  ];
  for (const [entry, problem] of cases) {
    const e = everyEntrance({ MASON_UI_NAV_LINKS: JSON.stringify([entry]) });
    assert.deepEqual(e, { setting: { problem }, report: `a setting is missing or wrong: ${problem}`, run: problem }, JSON.stringify(entry));
  }
});

test("the host's views and card are mason serve's: in its --help, said at its start; mason start refuses MASON_UI_OVERVIEW_CARD, valid or not", () => {
  assert.match(SERVE.usage, /or \{"label": …, "view": …\}, a view of the host's the page shows inside itself at #host\/<n>/);
  assert.match(SERVE.usage, /\n {4}MASON_UI_OVERVIEW_CARD {2}a card of the host's on the web page's Overview, beside Mason's own/);
  assert.deepEqual(navLines({ items: {}, links: [{ label: "Billing", url: "/b" }, { label: "Server", view: "host/s" }, { label: "Plans", view: "host/p" }] }), [
    `the sidebar links to "Billing" (MASON_UI_NAV_LINKS)`,
    `the sidebar shows the host's views "Server", "Plans", read from the page's address (MASON_UI_NAV_LINKS)`]);
  assert.deepEqual(navLines({ items: {}, links: [{ label: "Server", view: "host/s" }] }), [`the sidebar shows the host's view "Server", read from the page's address (MASON_UI_NAV_LINKS)`]);
  const p = project();
  for (const v of ["host/card.json", "https://evil.example.com/"]) {
    assert.deepEqual(startSettingRefusal(p, { MASON_UI_OVERVIEW_CARD: v }, { serve: false }),
      { message: "MASON_UI_OVERVIEW_CARD is mason serve's setting, and mason start ignores no setting silently", code: "refused",
        fix: "unset MASON_UI_OVERVIEW_CARD: mason start's page is yours alone, opened with mason ui" }, v);
  }
  assert.equal(startSettingRefusal(p, { MASON_UI_OVERVIEW_CARD: "" }, { serve: false }), null, "set empty is unset");
  // a view is an entry of MASON_UI_NAV_LINKS: mason start refuses it as it refuses the list
  assert.equal(startSettingRefusal(p, { MASON_UI_NAV_LINKS: JSON.stringify([{ label: "Server", view: "host/s" }]) }, { serve: false })?.message,
    "MASON_UI_NAV_LINKS is mason serve's setting, and mason start ignores no setting silently");
});
