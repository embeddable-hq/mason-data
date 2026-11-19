/**
 * `MASON_MCP_ICON` (src/cli/mcp-icon.ts, issue 1168): the icon `mason serve`'s MCP endpoint sends in its serverInfo, in
 * place of Mason's own. A `data:` URL of a PNG or SVG in base64, read as MASON_UI_ICON is, or an `https:` address on
 * MASON_MCP_URL's own origin; anything else refuses the start on `serveSettings`' one report, never quoting the value,
 * and `mason start` refuses it as it refuses every MCP setting. What the endpoint sends is tests/cli-mcp-http.test.ts's.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as serveModule from "../src/cli/serve.ts";
import * as projectModule from "../src/cli/project.ts";

// imported when the tests run: the file loads at a commit without the module, and each test that needs it fails by name
const iconModule = await import("../src/cli/mcp-icon.ts" as string).catch(() => ({})) as Partial<typeof import("../src/cli/mcp-icon.ts")>;
const missing = (): never => assert.fail("src/cli/mcp-icon.ts is not in this tree");
const { serveSettings, SERVE } = serveModule as unknown as typeof import("../src/cli/serve.ts");
const { newConfig, startSettingRefusal } = projectModule as unknown as typeof import("../src/cli/project.ts");

const KEY = "k".repeat(48);
const ON = { DATABASE_URL: "postgres://mason:secret@db.internal:5432/app", MASON_API_KEY: KEY, MASON_HEALTH_HOST: "127.0.0.1",
  MASON_MCP_URL: "https://mason.example.test/mcp", MASON_MCP_ISSUER: "https://auth.example.test", MASON_MCP_JWKS_URL: "https://auth.example.test/.well-known/jwks.json" };
const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

/** a PNG of w x h: the signature and an IHDR chunk, which is all the setting reads */
const png = (w: number, h: number): string => {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0); ihdr.write("IHDR", 4, "latin1"); ihdr.writeUInt32BE(w, 8); ihdr.writeUInt32BE(h, 12); ihdr[16] = 8; ihdr[17] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr]).toString("base64");
};
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>').toString("base64");

/** the icons mason serve's settings give the endpoint, or the one report's message */
function icons(v: string): unknown {
  const r = serveSettings({ ...ON, MASON_MCP_ICON: v }, "/srv");
  return "message" in r ? r.message : r.mcp?.icons;
}

test("Mason's own icon is the default: a 128x128 PNG as a data: URI, small, in serverInfo's shape", () => {
  const def = iconModule.DEFAULT_MCP_ICONS ?? missing();
  assert.equal(def.length, 1);
  const { src, mimeType, sizes } = def[0]!;
  assert.deepEqual([mimeType, sizes], ["image/png", ["128x128"]]);
  const bytes = Buffer.from(src.slice("data:image/png;base64,".length), "base64");
  assert.ok(src.startsWith("data:image/png;base64,") && bytes.toString("base64") === src.slice(22), "strict base64 after data:image/png;base64,");
  assert.deepEqual((iconModule.pngSize ?? missing)(bytes), { width: 128, height: 128 });
  assert.ok(bytes.length <= 4096, `${bytes.length} bytes`);
  // unset (or set empty), the endpoint sends it
  for (const env of [{}, { MASON_MCP_ICON: "" }]) {
    const r = serveSettings({ ...ON, ...env }, "/srv");
    assert.ok(!("message" in r));
    assert.deepEqual(r.mcp?.icons, def);
  }
});

test("MASON_MCP_ICON replaces it: a data: PNG with its size read from the file, a data: SVG at any size, an https address on MASON_MCP_URL's origin", () => {
  assert.deepEqual(icons(`data:image/png;base64,${png(64, 48)}`), [{ src: `data:image/png;base64,${png(64, 48)}`, mimeType: "image/png", sizes: ["64x48"] }]);
  assert.deepEqual(icons(`DATA:Image/SVG+XML;BASE64,${SVG}`), [{ src: `data:image/svg+xml;base64,${SVG}`, mimeType: "image/svg+xml", sizes: ["any"] }]);
  assert.deepEqual(icons("https://mason.example.test/icon.svg"), [{ src: "https://mason.example.test/icon.svg", mimeType: "image/svg+xml" }]);
  assert.deepEqual(icons("https://MASON.example.test:443/brand/logo"), [{ src: "https://mason.example.test/brand/logo" }], "no extension: no mimeType, the response says it");
});

test("a bad MASON_MCP_ICON refuses mason serve's start on its one report, never quoting the value; mason start refuses it as an MCP setting", () => {
  const at = "MASON_MCP_ICON is set to";
  const cases: Array<[string, RegExp]> = [
    ["icon.png", new RegExp(`${at} what is neither a data: URL nor an address: an https:// address on MASON_MCP_URL's origin \\(https://mason\\.example\\.test/icon\\.png\\)`)],
    ["javascript:alert(1)", new RegExp(`${at} what is neither a data: URL nor an https:// address`)],
    ["file:///etc/secret-icon.png", new RegExp(`${at} what is neither a data: URL nor an https:// address`)],
    ["http://mason.example.test/icon.png", new RegExp(`${at} an http:// address \\(mason\\.example\\.test\\): a client takes an icon only over https:// or as a data: URL`)],
    ["https://cdn.example.test/icon.png", new RegExp(`${at} an address on https://cdn\\.example\\.test, and the endpoint is on https://mason\\.example\\.test \\(MASON_MCP_URL\\): a client takes an icon from the server's own origin alone`)],
    ["https://mason.example.test:8443/icon.png", /an address on https:\/\/mason\.example\.test:8443, and the endpoint is on https:\/\/mason\.example\.test /],
    ["https://admin:hunter2@mason.example.test/icon.png", new RegExp(`${at} an address that carries a user or a password \\(https://\\*\\*\\*\\*@mason\\.example\\.test\\)`)],
    ["https://mason.example.test/icon.png?token=sekrit", new RegExp(`${at} an address that carries a query or a fragment \\(https://mason\\.example\\.test/…\\)`)],
    [`https://mason.example.test/${"a".repeat(2100)}`, new RegExp(`${at} 2127 characters: an address is at most 2048`)],
    ["data:image/gif;base64,R0lGODlh", new RegExp(`${at} a data: URL of image/gif, and the icon is image/png or image/svg\\+xml`)],
    [`data:image/png;base64,${SVG}`, new RegExp(`${at} a data: URL of image/png whose data is not a PNG file`)],
    [`data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64")}`, new RegExp(`${at} a data: URL of image/png with no image header \\(IHDR\\)`)],
    [`data:image/png;base64,${"A".repeat(6000)}`, new RegExp(`${at} an image of about 4500 bytes, and the icon is at most 4096 bytes`)],
  ];
  for (const [v, re] of cases) {
    const said = icons(v);
    assert.ok(typeof said === "string", `${v.slice(0, 40)}: refused`);
    assert.match(said, /^a setting is missing or wrong: /, v.slice(0, 40));
    assert.match(said, re, v.slice(0, 40));
    for (const secret of ["hunter2", "sekrit", "alert", "etc/secret", "R0lGOD", "brand"]) assert.ok(!said.includes(secret), `${v.slice(0, 40)}: never quoted (${secret})`);
  }
  // set alone, the endpoint is on and wants its address
  const r = serveSettings({ DATABASE_URL: ON.DATABASE_URL, MASON_API_KEY: KEY, MASON_HEALTH_HOST: "127.0.0.1", MASON_MCP_ICON: `data:image/png;base64,${png(1, 1)}` }, "/srv");
  assert.ok("message" in r);
  assert.match(r.message, /MASON_MCP_URL is not set, and the MCP endpoint is on \(MASON_MCP_ICON set\)/);
  // mason start: an MCP setting, refused by name
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-icon-")); made.push(dir);
  fs.mkdirSync(path.join(dir, "mason", "sources"), { recursive: true });
  const p = { root: dir, folder: path.join(dir, "mason"), config: newConfig("shop", "mason") } as unknown as Parameters<typeof startSettingRefusal>[0];
  assert.deepEqual(startSettingRefusal(p, { MASON_MCP_ICON: "https://mason.example.test/icon.png" }, { serve: false }),
    { message: "MASON_MCP_ICON is mason serve's setting, and mason start ignores no setting silently", code: "refused",
      fix: "unset MASON_MCP_ICON: an agent on this machine runs mason mcp (mason help mcp)" });
});

test("mason serve --help lists MASON_MCP_ICON with its forms and its default", () => {
  assert.match(SERVE.usage, /\n {4}MASON_MCP_ICON {10}the icon an MCP client shows for the endpoint \(its serverInfo icons\): a data: URL of a PNG\n/);
  assert.match(SERVE.usage, /an https:\/\/ address on MASON_MCP_URL's\s+own origin; any other value is refused \(default Mason's logo, a 128x128 PNG\)/);
});
