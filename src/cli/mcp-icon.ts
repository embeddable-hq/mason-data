/**
 * MASON'S ICON AS AN MCP CLIENT SHOWS IT (issue 1168): the `icons` of the server's `serverInfo` (MCP 2025-11-25's
 * `Implementation`, 2026-07-28's the same), sent in `initialize` over stdio and HTTP, and under 2026-07-28 in
 * `server/discover` (src/cli/mcp.ts `serverInfo`). Every other 2026-07-28 result's `_meta` serverInfo leaves the icons
 * out, so they are sent once, not in every answer (src/cli/mcp-http.ts `modernResult`).
 *
 * THE DEFAULT is Mason's brick logo, the web page's mark (src/web/index.html, `.brand .logo`): the white bricks on the
 * teal tile (`--cta`, #2b6f70), filled to the square's edge, so the one image reads on a light list and a dark one alike
 * (no `theme`). A 128x128 PNG, because every client that renders icons MUST read PNG and only SHOULD read SVG; a
 * connector list draws it at 16 to 64 px, which 128 covers at 2x. It is a `data:` URI: no request, no path a relay must
 * forward, no origin to check. Rendered once from that SVG by Chromium (1144 bytes); render it again the same way if the
 * logo changes.
 *
 * `MASON_MCP_ICON` (mason serve, beside MASON_MCP_URL) replaces it, for a deployment with its own brand:
 *   - a `data:image/png;base64,…` URL: strict base64, at most `ICON_BYTES_MAX` bytes, and a whole PNG file (`pngProblem`:
 *     the signature, an IHDR first, every chunk whole with its CRC, an IDAT, an IEND last, at most `ICON_SIDE_MAX` a
 *     side), its size read from the file;
 *   - or an `https:` URL on MASON_MCP_URL's own origin, as the spec's "Icons" asks a client to check ("Verify that
 *     icon URIs are from the same origin as the server"), with no user, password, query, fragment, control character
 *     or white space at either end.
 * NO SVG, in either form's media type: an SVG can carry script and fetch other addresses, and each client decides how
 * it renders one (the spec: "Consumers SHOULD take appropriate precautions when consuming SVGs as they can contain
 * executable JavaScript"). Sanitising one is a parser's work Mason does not take on; a PNG, which every client that
 * renders icons MUST read, carries neither. (MASON_UI_ICON, the browser tab's, takes an SVG: a tab's icon runs no
 * script.) Anything else refuses the start, never quoting the value (a secret pasted in the wrong place stays unsaid):
 * an address's scheme and host are said only once it reads as `https://<host>/…`.
 */
import * as zlib from "node:zlib";
import { ICON_BYTES_MAX } from "./ui-icon.ts";

/** MCP's `Icon` (schema 2025-11-25 and 2026-07-28). */
export interface McpIcon {
  src: string;
  mimeType?: string;
  sizes?: string[];
  theme?: "light" | "dark";
}

export const MCP_ICON_SETTING = "MASON_MCP_ICON";

/** The largest side of a PNG taken, in pixels: a connector list's icon, with room for 8x its largest use. */
export const ICON_SIDE_MAX = 1024;

/** Mason's brick logo, a 128x128 PNG in base64 (see above). */
const MASON_ICON_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAAELUlEQVR4nOzczU4TURjG8VcoxgCCovIN8l1KW9SFxi8IRW7ElSaSiDcg3oEu2L" +
  "jyRkDwW8PG0FIoVkRoEFCiVMAEwXoMiZtzZjGVOc+YPL/lG9OO/OmcOe2UQPj2kBBOgRAUA4AxABgDgDEAGAOAMQAYA4AxABgDgDEAGAOAMQAY" +
  "A4AxAFhAXEo8uC9okaE7xrmfj80JXwFgDADGAGAMAMYAYAwAxgBgDADGAGAMAMYAYAwAxgBgDADGAGAMAMYAYAwAxgBgDADGAGAMAMYAYAwAxg" +
  "Bgru+Mm0y/F7/y87E5OcQ/VYDFUxAYA4AxABgDgDEAGAOAud4HnG9rE/e+bm6mV1b0eXlxcUdtreCklpez29v6vL2m5lhJibg3mU67+veuAzwa" +
  "vCXurW1s9A/f0+eHA4H8HvCgxO4OG+cPb96oLC8X93z6FSX1n+msq9Pnn7PZmUxGQJKZjDoAfR6qr8/vp58He2tAXyRsnE9MTwvIRML81H3hsN" +
  "hiMUA4Ypw7/RQsmEgkjHOn3xUv2AsQaWwwLmvTS0tqiRbr1LKUNJ39TpWVhRsaxBarl6ED3d3G+ehUXKxzOvXZ/PUXywGcl4GEWOe8AETEIqsB" +
  "rgSDgcJCff5iNvVzd1cs+rGz8zKV0udHioouBzvEIqsBigKBq6FOfb67t/d8dlYsepWaU0+qzy8Fg+ogxSLbb0X45FrI6aRneQEQ+wGuRc0Bxu" +
  "L21uFcLvc4bg7QH7G6AIj9AMdLSyONjfr829ZW/OOiWBFfXFRPp8+jpxvV4YldgHdD4ddCPrn+2QcIEEMvA/5ZAAQSIFhXq3ab+ly9M6x2p+Ix" +
  "9RRzy5/0uTqkIOKNccwHMk5b4jHvt8SjU1PG+cCZbkHABAAuA75aAAQV4EJbm9pz6vM379JqjyqeUQ/+em5On6uDudjRLgiYAGq32dMV0ud/ts" +
  "QzM+KZZ8mZX7mcPu/p6ioswPwoYB/KQ7bEvrr+2QcL0Gt6BShPksmc6Zf036mHfZo0v7x6QyEBgQVQe86zTU36XO1R3y4siAfUwxo3wOeam+1v" +
  "gP9C3hcUizqdhTy5FhqPO51/MNc/+5ABnD77HvdmGXD6CCyGWwAEG6C1urquokKfz6+uZtbX5UCpB1QPq8/VAbRUVQkO+NbEmMPL/8BfBI7vP0" +
  "ejAuX6GzL53Zro5Es2+2FtTZ+fOFraUlUtB2d+dWX9u+Hei+bKypOmN6by5vbWRH5FCYx3R4MxABgDgDEAGAOAMQBYHt+QGRQvXR8ZES/57fjz" +
  "+I5Yq/zP/Hb8PAWBMQAYA4AxABgDgDEAGAOAMQAYA4AxABgDgDEAGAOAMQAYA4AxABgDgDEAGAOAMQAYA4AxABgDgDEAGAOA8RsyYHwFgDEAGA" +
  "OAMQAYA4AxABgDgDEAGAOAMQAYA4AxABgDgDEAGAOA/QYAAP//bO8iywAAAAZJREFUAwA4whw82M7Y1AAAAABJRU5ErkJggg==";

/** The icon every Mason MCP server sends unless MASON_MCP_ICON names another. */
export const DEFAULT_MCP_ICONS: readonly McpIcon[] = [{ src: `data:image/png;base64,${MASON_ICON_PNG}`, mimeType: "image/png", sizes: ["128x128"] }];

/** The longest https: icon address taken. */
const MAX_ICON_URL = 2048;

/** The base64 characters that encode `ICON_BYTES_MAX` bytes: past it, the image is too big without reading it. */
const ICON_DATA_MAX = Math.ceil(ICON_BYTES_MAX / 3) * 4;

/** PNG's signature: the first eight bytes of every PNG file. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * WHAT IS WRONG WITH A PNG FILE, or its size: the signature; then chunks to the file's last byte, each whole (its
 * length within the file, its CRC right); IHDR first, 13 bytes, its width and height 1 to `ICON_SIDE_MAX`; at least one
 * IDAT; IEND last and nothing after it. The pixels are not decoded: the client decodes them, and a file that says what
 * a PNG says, whole, is one a client's decoder is built for.
 */
export function pngProblem(bytes: Buffer): string | { width: number; height: number } {
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return "whose data is not a PNG file (no PNG signature)";
  let at = PNG_SIGNATURE.length;
  let size: { width: number; height: number } | null = null;
  let idat = false, iend = false;
  while (at < bytes.length) {
    if (iend) return "with data after its IEND chunk";
    if (at + 12 > bytes.length) return "that is cut short (a chunk's header past the end of the file)";
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString("latin1", at + 4, at + 8);
    if (length > bytes.length - at - 12) return "that is cut short (a chunk longer than the rest of the file)";
    const crc = bytes.readUInt32BE(at + 8 + length);
    if (zlib.crc32(bytes.subarray(at + 4, at + 8 + length)) !== crc) return "with a chunk whose CRC is wrong";
    if (size === null) {
      if (type !== "IHDR" || length !== 13) return "whose first chunk is not a 13-byte IHDR";
      size = { width: bytes.readUInt32BE(at + 8), height: bytes.readUInt32BE(at + 12) };
      if (size.width < 1 || size.height < 1 || size.width > ICON_SIDE_MAX || size.height > ICON_SIDE_MAX) {
        return `of ${size.width}x${size.height} pixels, and an icon is 1 to ${ICON_SIDE_MAX} pixels a side`;
      }
    } else if (type === "IDAT") idat = true;
    else if (type === "IEND") iend = true;
    at += 12 + length;
  }
  if (size === null) return "that is cut short (no IHDR chunk)";
  if (!idat) return "with no image data (no IDAT chunk)";
  if (!iend) return "that is cut short (no IEND chunk)";
  return size;
}

/** The media type an https: icon's path says by its extension; none otherwise (the client reads the response's). */
const TYPE_OF_EXTENSION: Readonly<Record<string, string>> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };

/**
 * MASON_MCP_ICON as the icons serverInfo sends: null unset or set empty (the default is sent), the icons, or what is
 * wrong. `endpoint` is MASON_MCP_URL as read already (null when it is not): an https: icon must be on its origin.
 */
export function mcpIconSetting(env: Readonly<Record<string, string | undefined>>, endpoint: URL | null): readonly McpIcon[] | null | { problem: string } {
  const v = env[MCP_ICON_SETTING] ?? "";
  if (v === "") return null;
  const at = `${MCP_ICON_SETTING} is set`;
  const way = `a PNG: data:image/png;base64,… (base64 -w0 icon.png), at most ${ICON_BYTES_MAX} bytes and ${ICON_SIDE_MAX} pixels a side, ` +
    `or an https:// address on MASON_MCP_URL's origin (${endpoint === null ? "https://<its host>" : endpoint.origin}/icon.png)`;
  // before any reading of it: a URL parser drops or encodes what the operator would not see in the address
  if (/[\u0000-\u001f\u007f]/.test(v)) return { problem: `${at} to a value with a control character in it (a line break, a tab, a NUL …): ${way}` };
  if (v.trim() !== v) return { problem: `${at} to a value with white space at its start or end: ${way}` };
  if (/^data:/i.test(v)) return dataIcon(v, at, way);
  if (v.length > MAX_ICON_URL) return { problem: `${at} to ${v.length} characters: an address is at most ${MAX_ICON_URL}; ${way}` };
  let u: URL;
  try { u = new URL(v); } catch { return { problem: `${at} to what is neither a data: URL nor an address: ${way}` }; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { problem: `${at} to what is neither a data: URL nor an https:// address: ${way}` };
  // its scheme and host are said only when the value reads as one, `https://<host>…`: from `https:SECRET` the parser
  // makes a host of what was never written as one
  const written = /^https?:\/\/[^/\\?#]/i.test(v);
  const said = (s: string): string => written ? ` (${s})` : "";
  if (u.username !== "" || u.password !== "") {
    return { problem: `${at} to an address that carries a user or a password${said(`${u.protocol}//****@${u.host}`)}: a client fetches an icon without credentials; ${way}` };
  }
  if (u.search !== "" || u.hash !== "" || v.includes("?") || v.includes("#")) {
    return { problem: `${at} to an address that carries a query or a fragment${said(`${u.protocol}//${u.host}/…`)}: the address alone; ${way}` };
  }
  if (u.protocol !== "https:") return { problem: `${at} to an http:// address${said(u.host)}: a client takes an icon only over https:// or as a data: URL; ${way}` };
  if (!written) return { problem: `${at} to an address not written as https://<host>/<path>: ${way}` };
  if (endpoint === null) return { problem: `${at} to an address, and MASON_MCP_URL gives no address to hold it to: an https:// icon is on the endpoint's own origin` };
  if (u.origin !== endpoint.origin) {
    return { problem: `${at} to an address on ${u.origin}, and the endpoint is on ${endpoint.origin} (MASON_MCP_URL): a client takes an icon from the server's own origin alone; ${way}` };
  }
  const ext = /\.([a-z0-9]+)$/i.exec(u.pathname)?.[1]?.toLowerCase();
  if (ext === "svg" || ext === "svgz") return { problem: `${at} to an address of an SVG file, which can carry script: give a PNG instead; ${way}` };
  const mimeType = ext === undefined ? undefined : TYPE_OF_EXTENSION[ext];
  return [{ src: u.href, ...(mimeType !== undefined ? { mimeType } : {}) }];
}

/** A `data:` value: a PNG in strict base64, whole, or what is wrong (its type named only when it reads as one). */
function dataIcon(v: string, at: string, way: string): readonly McpIcon[] | { problem: string } {
  const comma = v.indexOf(",");
  if (comma < 0) return { problem: `${at} to a data: URL with no comma before its data: ${way}` };
  const parts = v.slice("data:".length, comma).toLowerCase().split(";");
  const type = parts[0]!;
  if (type === "image/svg+xml") return { problem: `${at} to a data: URL of an SVG image, which can carry script and fetch other addresses, and an MCP client decides how to render it: give a PNG instead; ${way}` };
  if (type !== "image/png") {
    const named = /^[a-z0-9.+-]{1,40}\/[a-z0-9.+-]{1,40}$/.test(type) ? type : type === "" ? "no media type" : "another media type";
    return { problem: `${at} to a data: URL of ${named}, and the icon is image/png: ${way}` };
  }
  if (parts.length !== 2 || parts[1] !== "base64") return { problem: `${at} to a data: URL that is not ;base64 right after its type: ${way}` };
  const data = v.slice(comma + 1);
  if (data === "") return { problem: `${at} to a data: URL with no image after its comma: ${way}` };
  if (data.length > ICON_DATA_MAX) return { problem: `${at} to an image of about ${Math.floor(data.length * 3 / 4)} bytes, and the icon is at most ${ICON_BYTES_MAX} bytes: make it smaller` };
  const bytes = /^[A-Za-z0-9+/]*={0,2}$/.test(data) && data.length % 4 === 0 ? Buffer.from(data, "base64") : null;
  if (bytes === null || bytes.toString("base64") !== data) {
    return { problem: `${at} to a data: URL whose base64 is not valid (a character outside A-Z, a-z, 0-9, + and /, or the wrong = padding): ${way}` };
  }
  if (bytes.length > ICON_BYTES_MAX) return { problem: `${at} to an image of ${bytes.length} bytes, and the icon is at most ${ICON_BYTES_MAX} bytes: make it smaller` };
  const png = pngProblem(bytes);
  if (typeof png === "string") return { problem: `${at} to a data: URL of image/png ${png}: encode the PNG file itself (base64 -w0 icon.png)` };
  const src = `data:image/png;base64,${data}`;
  return [{ src, mimeType: "image/png", sizes: [`${png.width}x${png.height}`] }];
}
