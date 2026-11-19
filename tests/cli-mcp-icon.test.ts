/**
 * `MASON_MCP_ICON` (src/cli/mcp-icon.ts, issue 1168): the icon `mason serve`'s MCP endpoint sends in its serverInfo, in
 * place of Mason's own. A whole PNG as a `data:` URL in base64, or an `https:` address on MASON_MCP_URL's own origin;
 * never an SVG (it can carry script); anything else refuses the start on `serveSettings`' one report, never quoting the
 * value, and `mason start` refuses it as it refuses every MCP setting. What the endpoint sends is
 * tests/cli-mcp-http.test.ts's.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
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

/** a PNG chunk: its length, type, data and CRC */
const chunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([len, body, crc]);
};
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ihdr = (w: number, h: number): Buffer => { const d = Buffer.alloc(13); d.writeUInt32BE(w, 0); d.writeUInt32BE(h, 4); d[8] = 8; d[9] = 0; return chunk("IHDR", d); };
/** a whole grey PNG of w x h, its IHDR saying `said` when given (a file that lies about its size) */
const pngFile = (w: number, h: number, said?: [number, number]): Buffer =>
  Buffer.concat([SIGNATURE, ihdr(...(said ?? [w, h])), chunk("IDAT", zlib.deflateSync(Buffer.alloc((w + 1) * h))), chunk("IEND", Buffer.alloc(0))]);
const dataPng = (b: Buffer): string => `data:image/png;base64,${b.toString("base64")}`;
const svgData = (svg: string): string => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

/** the icons mason serve's settings give the endpoint, or the one report's message */
function icons(v: string): unknown {
  const r = serveSettings({ ...ON, MASON_MCP_ICON: v }, "/srv");
  return "message" in r ? r.message : r.mcp?.icons;
}

test("Mason's own icon is the default: a whole 128x128 PNG as a data: URI, small, in serverInfo's shape", () => {
  const def = iconModule.DEFAULT_MCP_ICONS ?? missing();
  assert.equal(def.length, 1);
  const { src, mimeType, sizes } = def[0]!;
  assert.deepEqual([mimeType, sizes], ["image/png", ["128x128"]]);
  const bytes = Buffer.from(src.slice("data:image/png;base64,".length), "base64");
  assert.ok(src.startsWith("data:image/png;base64,") && bytes.toString("base64") === src.slice(22), "strict base64 after data:image/png;base64,");
  assert.deepEqual((iconModule.pngProblem ?? missing)(bytes), { width: 128, height: 128 }, "a whole PNG: chunks, CRCs, IDAT, IEND");
  assert.ok(bytes.length <= 4096, `${bytes.length} bytes`);
  // unset (or set empty), the endpoint sends it
  for (const env of [{}, { MASON_MCP_ICON: "" }]) {
    const r = serveSettings({ ...ON, ...env }, "/srv");
    assert.ok(!("message" in r));
    assert.deepEqual(r.mcp?.icons, def);
  }
});

test("MASON_MCP_ICON replaces it: a whole data: PNG with its size read from the file, or an https address on MASON_MCP_URL's origin", () => {
  assert.deepEqual(icons(dataPng(pngFile(64, 48))), [{ src: dataPng(pngFile(64, 48)), mimeType: "image/png", sizes: ["64x48"] }]);
  assert.deepEqual(icons(`DATA:Image/PNG;BASE64,${pngFile(1024, 1).toString("base64")}`), [{ src: dataPng(pngFile(1024, 1)), mimeType: "image/png", sizes: ["1024x1"] }]);
  assert.deepEqual(icons("https://mason.example.test/icon.png"), [{ src: "https://mason.example.test/icon.png", mimeType: "image/png" }]);
  assert.deepEqual(icons("https://MASON.example.test:443/brand/logo"), [{ src: "https://mason.example.test/brand/logo" }], "no extension: no mimeType, the response says it");
});

test("MASON_MCP_ICON takes no SVG, harmless or not, as data: or by address: refused with the way out, a PNG", () => {
  const svgs = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><iframe xmlns="http://www.w3.org/1999/xhtml" src="javascript:alert(1)"/></foreignObject></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://tracker.example.test/pixel"/></svg>',
  ];
  for (const svg of svgs) {
    const said = icons(svgData(svg));
    assert.ok(typeof said === "string", `${svg.slice(0, 60)}: refused`);
    assert.match(said, /MASON_MCP_ICON is set to a data: URL of an SVG image, which can carry script and fetch other addresses, and an MCP client decides how to render it: give a PNG instead; a PNG: data:image\/png;base64,…/);
    assert.ok(!said.includes("alert") && !said.includes("tracker"), "never quoted");
  }
  assert.match(icons(`data:image/svg+xml;utf8,${svgs[1]}`) as string, /a data: URL of an SVG image[^;]*: give a PNG instead/);
  assert.match(icons("https://mason.example.test/icon.svg") as string, /MASON_MCP_ICON is set to an address of an SVG file, which can carry script: give a PNG instead/);
  assert.match(icons("https://mason.example.test/icon.SVGZ") as string, /an address of an SVG file/);
});

const at = "MASON_MCP_ICON is set to";

/** each value refused on the one report, with its words, quoting nothing of the value */
function refused(cases: Array<[string, RegExp]>): void {
  for (const [v, re] of cases) {
    const said = icons(v);
    assert.ok(typeof said === "string", `${JSON.stringify(v.slice(0, 40))}: refused`);
    assert.match(said, /^a setting is missing or wrong: /, v.slice(0, 40));
    assert.match(said, re, JSON.stringify(v.slice(0, 40)));
    for (const secret of ["hunter2", "sekrit", "alert", "etc/secret", "R0lGOD", "SECRET", "secret"]) assert.ok(!said.includes(secret), `${JSON.stringify(v.slice(0, 40))}: never quoted (${secret}): ${said}`);
  }
}

test("a bad MASON_MCP_ICON refuses mason serve's start on its one report, never quoting the value; mason start refuses it as an MCP setting", () => {
  refused([
    ["icon.png", new RegExp(`${at} what is neither a data: URL nor an address: a PNG: data:image/png;base64,… \\(base64 -w0 icon\\.png\\), at most 4096 bytes and 1024 pixels a side, or an https:// address on MASON_MCP_URL's origin \\(https://mason\\.example\\.test/icon\\.png\\)`)],
    ["javascript:alert(1)", new RegExp(`${at} what is neither a data: URL nor an https:// address`)],
    ["file:///etc/secret-icon.png", new RegExp(`${at} what is neither a data: URL nor an https:// address`)],
    ["http://mason.example.test/icon.png", new RegExp(`${at} an http:// address \\(mason\\.example\\.test\\): a client takes an icon only over https:// or as a data: URL`)],
    ["https://cdn.example.test/icon.png", new RegExp(`${at} an address on https://cdn\\.example\\.test, and the endpoint is on https://mason\\.example\\.test \\(MASON_MCP_URL\\): a client takes an icon from the server's own origin alone`)],
    ["https://mason.example.test:8443/icon.png", /an address on https:\/\/mason\.example\.test:8443, and the endpoint is on https:\/\/mason\.example\.test /],
    ["https://admin:hunter2@mason.example.test/icon.png", new RegExp(`${at} an address that carries a user or a password \\(https://\\*\\*\\*\\*@mason\\.example\\.test\\)`)],
    ["https://mason.example.test/icon.png?token=sekrit", new RegExp(`${at} an address that carries a query or a fragment \\(https://mason\\.example\\.test/…\\)`)],
    [`https://mason.example.test/${"a".repeat(2100)}`, new RegExp(`${at} 2127 characters: an address is at most 2048`)],
    ["data:image/gif;base64,R0lGODlh", new RegExp(`${at} a data: URL of image/gif, and the icon is image/png`)],
    [`data:image/png;base64,${Buffer.from("<svg/>").toString("base64")}`, new RegExp(`${at} a data: URL of image/png whose data is not a PNG file \\(no PNG signature\\)`)],
    [`data:image/png;base64,${"A".repeat(6000)}`, new RegExp(`${at} an image of about 4500 bytes, and the icon is at most 4096 bytes`)],
  ]);
  // set alone, the endpoint is on and wants its address
  const r = serveSettings({ DATABASE_URL: ON.DATABASE_URL, MASON_API_KEY: KEY, MASON_HEALTH_HOST: "127.0.0.1", MASON_MCP_ICON: dataPng(pngFile(1, 1)) }, "/srv");
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

test("an https value with a control character or white space at an end is refused before a URL parser drops or encodes it", () => {
  refused([
    ["https://mason.example.test/icon.png\nX", new RegExp(`${at} a value with a control character in it \\(a line break, a tab, a NUL …\\)`)],
    ["https://mason.exam\nple.test/icon.png", /a value with a control character in it/],
    ["https://mason.example.test/icon\r.png", /a value with a control character in it/],
    ["https://mason.example.test/\ticon.png", /a value with a control character in it/],
    ["https://mason.example.test/icon.png\u0000", /a value with a control character in it/],
    ["https://mason.example.test/icon.png\u007f", /a value with a control character in it/],
    [" https://mason.example.test/icon.png", new RegExp(`${at} a value with white space at its start or end`)],
    ["https://mason.example.test/icon.png ", /a value with white space at its start or end/],
  ]);
});

test("an address not written as https://<host>/… is refused without the host a URL parser made of it (https:SECRET)", () => {
  refused([
    ["https:SECRETHOST", new RegExp(`${at} an address not written as https://<host>/<path>`)],
    ["https:/SECRETHOST/icon.png", /an address not written as https:\/\/<host>\/<path>/],
    ["https:\\\\SECRETHOST\\icon.png", /an address not written as https:\/\/<host>\/<path>/],
    ["https:SECRETUSER:pw@x/icon.png", new RegExp(`${at} an address that carries a user or a password: a client`)],
    ["https:SECRETHOST/icon.png?q", new RegExp(`${at} an address that carries a query or a fragment: the address alone`)],
    ["http:SECRETHOST/icon.png", new RegExp(`${at} an http:// address: a client takes`)],
  ]);
});

test("a data: PNG is a whole file within bounds: a truncated one, one with no IDAT or IEND, a wrong CRC, bytes after IEND, or absurd dimensions are refused", () => {
  const sig = SIGNATURE.toString("base64");
  const whole = pngFile(2, 2);
  refused([
    [`data:image/png;base64,${sig}`, new RegExp(`${at} a data: URL of image/png that is cut short \\(no IHDR chunk\\)`)],
    [dataPng(Buffer.concat([SIGNATURE, ihdr(2, 2)])), /a data: URL of image\/png with no image data \(no IDAT chunk\)/],
    [dataPng(whole.subarray(0, whole.length - 12)), /a data: URL of image\/png that is cut short \(no IEND chunk\)/],
    [dataPng(whole.subarray(0, whole.length - 5)), /a data: URL of image\/png that is cut short \(a chunk's header past the end of the file\)/],
    [dataPng(whole.subarray(0, 47)), /a data: URL of image\/png that is cut short \(a chunk longer than the rest of the file\)/],
    [dataPng(Buffer.concat([whole, Buffer.from([0])])), /a data: URL of image\/png with data after its IEND chunk/],
    [dataPng(Buffer.concat([whole.subarray(0, 20), Buffer.from([whole[20]! ^ 1]), whole.subarray(21)])), /a data: URL of image\/png with a chunk whose CRC is wrong/],
    [dataPng(pngFile(1, 1, [4294967295, 4294967295])), /a data: URL of image\/png of 4294967295x4294967295 pixels, and an icon is 1 to 1024 pixels a side/],
    [dataPng(pngFile(1025, 1)), /a data: URL of image\/png of 1025x1 pixels, and an icon is 1 to 1024 pixels a side/],
    [dataPng(pngFile(1, 1, [0, 1])), /of 0x1 pixels/],
  ]);
});

test("mason serve --help lists MASON_MCP_ICON with its forms, no SVG, and its default; the lines around it unchanged", () => {
  assert.match(SERVE.usage, /\n {4}MASON_MCP_ICON {10}the icon an MCP client shows for the endpoint \(its serverInfo icons\): a PNG, as a data: URL\n/);
  assert.match(SERVE.usage, /data:image\/png;base64,…, at most 4096 bytes and 1024 pixels a side\), or\s+an https:\/\/ address on MASON_MCP_URL's own origin; never an SVG, which can carry script; any\s+other value is refused \(default Mason's logo, a 128x128 PNG\)\n {4}MASON_PG_HOST, MASON_PG_PORT {2}the Postgres API's address/);
  assert.match(SERVE.usage, /\(default unset: no browser origin\)\n {4}MASON_MCP_ICON /);
});
