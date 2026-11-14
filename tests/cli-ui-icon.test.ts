/**
 * `MASON_UI_ICON` (src/cli/ui-icon.ts, issue 969): `mason serve`'s page carries the host's icon in the browser's tab. A
 * `data:` URL of a PNG or SVG in base64, at most 4096 bytes, written into the page's HTML at the start; anything else
 * refuses the start at every entrance that takes the settings — `serveSettings`' one report and `startSettingRefusal`
 * under `mason serve` — and `mason start` refuses it. Unset, the page is served byte for byte as before.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRunServer, type RunContext } from "../src/cli/run-server.ts";
import { parseSource } from "../src/cli/preflight.ts";
import * as serveModule from "../src/cli/serve.ts";
import * as projectModule from "../src/cli/project.ts";

// imported when the tests run: the file loads at a commit without the module, and each test that needs it fails by name
const iconModule = await import("../src/cli/ui-icon.ts" as string).catch(() => ({})) as Partial<typeof import("../src/cli/ui-icon.ts")>;
const missing = (): never => assert.fail("src/cli/ui-icon.ts is not in this tree");
const uiIconSetting = iconModule.uiIconSetting ?? missing;
const pageWithIcon = iconModule.pageWithIcon ?? missing;
const { serveSettings, SERVE } = serveModule as unknown as typeof import("../src/cli/serve.ts");
const { newConfig, startSettingRefusal } = projectModule as unknown as typeof import("../src/cli/project.ts");

const KEY = "k".repeat(48);
const TOKEN = "t".repeat(48);
const ENV = { DATABASE_URL: "postgres://mason:secret@db.internal:5432/app", MASON_API_KEY: KEY };
const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const temp = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "micon-")); made.push(d); return d; };
const project = (): Parameters<typeof startSettingRefusal>[0] => {
  const dir = temp();
  fs.mkdirSync(path.join(dir, "mason", "sources"), { recursive: true });
  return { root: dir, folder: path.join(dir, "mason"), config: newConfig("shop", "mason") } as unknown as Parameters<typeof startSettingRefusal>[0];
};

/** What every entrance of mason serve says of the setting: its own reading, the one report, the run's check. */
function everyEntrance(v: string): { setting: unknown; report: string | null; run: string | null } {
  const env = { MASON_UI_ICON: v };
  const s = serveSettings({ ...ENV, ...env }, "/srv");
  const r = startSettingRefusal(project(), env, { serve: true });
  return { setting: uiIconSetting(env), report: "message" in s ? s.message : null, run: r === null ? null : r.message };
}

const b64 = (b: Buffer | string): string => Buffer.from(b).toString("base64");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A 1×1 PNG, whole. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const SVG_TEXT = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#0f766e"/></svg>`;
const SVG = b64(SVG_TEXT);
const PNG_URL = `data:image/png;base64,${PNG}`;
const SVG_URL = `data:image/svg+xml;base64,${SVG}`;

test("taken: a PNG and an SVG in a base64 data: URL, up to 4096 bytes, the type and base64 given back in lower case; unset or empty is none", () => {
  assert.deepEqual(everyEntrance(PNG_URL), { setting: PNG_URL, report: null, run: null });
  assert.deepEqual(everyEntrance(SVG_URL), { setting: SVG_URL, report: null, run: null });
  assert.deepEqual(everyEntrance(`DATA:Image/PNG;BASE64,${PNG}`), { setting: PNG_URL, report: null, run: null });
  const svgDeclared = `data:image/svg+xml;base64,${b64(`<?xml version="1.0"?>\n<svg viewBox="0 0 1 1"></svg>`)}`;
  assert.equal(everyEntrance(svgDeclared).setting, svgDeclared, "an XML declaration before the element");
  const largest = `data:image/png;base64,${b64(Buffer.concat([PNG_SIGNATURE, Buffer.alloc(4096 - 8)]))}`;
  assert.equal(everyEntrance(largest).setting, largest, "4096 bytes is taken");
  assert.equal(uiIconSetting({}), null);
  assert.equal(uiIconSetting({ MASON_UI_ICON: "" }), null, "set empty is unset");
});

test("refused at every entrance of mason serve, naming the setting, what is wrong and what a valid value looks like, never quoting the value", () => {
  const way = "data:image/png;base64,… or data:image/svg+xml;base64,…, the file in base64 (base64 -w0 icon.png)";
  const at = "MASON_UI_ICON is set to";
  const notBase64 = `${at} a data: URL whose base64 is not valid (a character outside A-Z, a-z, 0-9, + and /, a space, or the wrong = padding): ${way}`;
  const cases: Array<[string, string]> = [
    ["https://cdn.example.com/icon.png", `${at} something other than a data: URL, and the icon is inline: ${way}`],
    ["javascript:alert(1)", `${at} something other than a data: URL, and the icon is inline: ${way}`],
    ["icon.png", `${at} something other than a data: URL, and the icon is inline: ${way}`],
    [" data:image/png;base64,AAAA", `${at} something other than a data: URL, and the icon is inline: ${way}`],
    ["data:image/png;base64", `${at} a data: URL with no comma before its data: ${way}`],
    [`data:image/jpeg;base64,${PNG}`, `${at} a data: URL of image/jpeg, and the icon is image/png or image/svg+xml: ${way}`],
    [`data:text/html;base64,${b64("<script>alert(1)</script>")}`, `${at} a data: URL of text/html, and the icon is image/png or image/svg+xml: ${way}`],
    [`data:;base64,${PNG}`, `${at} a data: URL of no media type, and the icon is image/png or image/svg+xml: ${way}`],
    [`data:"><script>alert(1)</script>;base64,${PNG}`, `${at} a data: URL of another media type, and the icon is image/png or image/svg+xml: ${way}`],
    [`data:image/svg+xml,${SVG_TEXT}`, `${at} a data: URL that is not ;base64 right after its type: ${way}`],
    [`data:image/svg+xml;charset=utf-8;base64,${SVG}`, `${at} a data: URL that is not ;base64 right after its type: ${way}`],
    [`data:image/png;base64;x=1,${PNG}`, `${at} a data: URL that is not ;base64 right after its type: ${way}`],
    ["data:image/png;base64,", `${at} a data: URL with no image after its comma: ${way}`],
    [`data:image/png;base64,${PNG}"><script>alert(1)</script>`, notBase64],
    [`data:image/png;base64,${PNG.slice(0, 20)} ${PNG.slice(20)}`, notBase64],
    [`data:image/png;base64,${PNG.replace(/\+/g, "-")}`, notBase64],
    [`data:image/png;base64,${PNG.replace(/=+$/, "")}`, notBase64],
    [`data:image/png;base64,${PNG.slice(0, 16)}%2B${PNG.slice(17)}`, notBase64],
    ["data:image/png;base64,YR==", notBase64],
    [`data:image/png;base64,${b64(Buffer.concat([PNG_SIGNATURE, Buffer.alloc(4097 - 8)]))}`, `${at} an image of 4097 bytes, and the icon is at most 4096 bytes: make it smaller`],
    [`data:image/png;base64,${"A".repeat(1_000_000)}`, `${at} an image of about 750000 bytes, and the icon is at most 4096 bytes: make it smaller`],
    [`data:image/png;base64,${SVG}`, `${at} a data: URL of image/png whose data is not a PNG file: encode the PNG file itself (base64 -w0 icon.png)`],
    [`data:image/svg+xml;base64,${PNG}`, `${at} a data: URL of image/svg+xml whose data is not an SVG file (UTF-8 text with an <svg> element): encode the SVG file itself (base64 -w0 icon.svg)`],
    [`data:image/svg+xml;base64,${b64("<html><body>no</body></html>")}`, `${at} a data: URL of image/svg+xml whose data is not an SVG file (UTF-8 text with an <svg> element): encode the SVG file itself (base64 -w0 icon.svg)`],
  ];
  for (const [v, problem] of cases) {
    const e = everyEntrance(v);
    assert.deepEqual(e, { setting: { problem }, report: `a setting is missing or wrong: ${problem}`, run: problem }, v.slice(0, 80));
    for (const said of [e.report!, e.run!]) {
      assert.ok(!said.includes("alert") && !said.includes("cdn.example") && !said.includes(PNG.slice(0, 12)) && !said.includes("AAAAAAAA"), `${v.slice(0, 40)}: never quoted`);
      assert.ok(said.length < 400, `${v.slice(0, 40)}: a short message, ${said.length}`);
    }
  }
  const r = startSettingRefusal(project(), { MASON_UI_ICON: "icon.png" }, { serve: true });
  assert.deepEqual(r && { code: r.code, fix: r.fix }, { code: "refused", fix: "set it as mason serve --help says, or unset it" });
});

test("mason serve's: in its --help with the other MASON_UI_* settings and its bound; mason start refuses it, valid or not", () => {
  assert.match(SERVE.usage, /\n {4}MASON_UI_ICON {11}the web page's icon in the browser's tab: a data: URL of a PNG or SVG image in base64,\n/);
  assert.match(SERVE.usage, /the image at most 4096\s+bytes; it is inline, so the browser makes no request for it; any other value is refused\s+\(default unset: no icon\)/);
  const p = project();
  for (const v of [SVG_URL, "https://cdn.example.com/icon.png"]) {
    assert.deepEqual(startSettingRefusal(p, { MASON_UI_ICON: v }, { serve: false }),
      { message: "MASON_UI_ICON is mason serve's setting, and mason start ignores no setting silently", code: "refused",
        fix: "unset MASON_UI_ICON: mason start's page is yours alone, opened with mason ui" }, v.slice(0, 40));
  }
  assert.equal(startSettingRefusal(p, { MASON_UI_ICON: "" }, { serve: false }), null, "set empty is unset");
});

// ------------------------------------------------------------------ the page as the run serves it

const parsed = parseSource("postgres://me@localhost:5432/shop");
const source = "source" in parsed ? parsed.source : assert.fail(parsed.problem);
const INDEX = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "web", "index.html"));

/** A server's run with the page, its icon as given (absent: none). */
async function listening(pageIcon?: string | null): Promise<number> {
  const root = temp();
  const ctx = {
    source, facts: () => ({ version: 160000, versionText: "16", standby: false, tables: [], systemIdentifier: null }), warnings: [], replication: () => null,
    port: 0, token: TOKEN, page: true, served: true, ...(pageIcon === undefined ? {} : { pageIcon }),
    users: { file: path.join(root, "users.json"), apiKey: KEY, database: "shop", postgresUrl: "postgresql://localhost:5433/shop" },
    folder: () => null, root, home: root, version: "test", startedAt: Date.now(), sources: () => ({ file: null, problem: null }),
    sourcesChanged: () => undefined, log: () => undefined,
    listener: { openSessions: () => ({ open: 0, byClient: [] }), running: () => [], cancel: (session: number) => ({ unknown: session }) },
    logs: { capacity: 10, recent: () => [] },
    readSource: () => ({ message: "none", code: "bad_source" }), runUrl: "",
    duck: { copies: () => [], file: path.join(root, "duck.db"), poll: async () => ({ at: "2026-11-07T10:00:00.000Z", tables: [] }),
      stream: async () => null, disk: () => ({ path: "/x", freeBytes: null, projectedBytes: null }), restarts: () => [], requests: { days: 7 } },
  } as unknown as RunContext;
  const server = createRunServer(ctx);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  ctx.port = port;
  after(() => { server.closeAllConnections(); server.close(); });
  return port;
}

/** The page at `/`, as the browser that holds the run's cookie is answered. */
function page(port: number): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/", headers: { Host: `127.0.0.1:${port}`, Cookie: `mason_dev_${port}=${TOKEN}`, Connection: "close" }, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("served: the page's icon is the setting's data: URL, in place of its empty one, once; the CSP unchanged and covering it; unset, the page byte for byte as before", async () => {
  for (const url of [SVG_URL, PNG_URL]) {
    const p = await page(await listening(url));
    assert.equal(p.status, 200);
    const html = p.body.toString("utf8");
    const links = [...html.matchAll(/<link rel="icon"[^>]*>/g)].map((m) => m[0]);
    assert.deepEqual(links, [`<link rel="icon" href="${url}">`], url.slice(0, 30));
    assert.equal(Number(p.headers["content-length"]), p.body.length, "its length is the page's with the icon");
    assert.match(String(p.headers["content-security-policy"]), /img-src 'self' data:/, "data: images are allowed: the icon makes no request");
    // the rest of the page is as the file writes it
    assert.equal(html.replace(`<link rel="icon" href="${url}">`, `<link rel="icon" href="data:,">`), INDEX.toString("utf8"));
  }
  // unset (absent, or null as a run without the setting has it): the same bytes as the file, its icon empty
  for (const icon of [undefined, null]) {
    const p = await page(await listening(icon));
    assert.equal(p.status, 200);
    assert.ok(p.body.equals(INDEX), "the same bytes");
    assert.match(p.body.toString("utf8"), /<link rel="icon" href="data:,">/);
  }
});

test("the icon is escaped as an attribute where it is written, and a page without its empty icon is refused, never served without it", () => {
  assert.equal(pageWithIcon(Buffer.from(`<head><link rel="icon" href="data:,"></head>`), `data:"x"<&>`).toString(),
    `<head><link rel="icon" href="data:&quot;x&quot;&lt;&amp;&gt;"></head>`);
  const none = Buffer.from("<head></head>");
  assert.equal(pageWithIcon(none, null), none, "no icon: the same bytes");
  assert.throws(() => pageWithIcon(none, SVG_URL), /the web page's index\.html has no <link rel="icon" href="data:,"> for MASON_UI_ICON to replace/);
});
