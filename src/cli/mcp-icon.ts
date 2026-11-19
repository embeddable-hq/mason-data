/**
 * MASON'S ICON AS AN MCP CLIENT SHOWS IT (issue 1168): the `icons` of the server's `serverInfo` (MCP 2025-11-25's
 * `Implementation`, 2026-07-28's the same), sent in `initialize` over stdio and HTTP, and under 2026-07-28 in
 * `server/discover` and every result's `_meta` (src/cli/mcp.ts `serverInfo`, src/cli/mcp-http.ts `modernResult`).
 *
 * THE DEFAULT is Mason's brick logo, the web page's mark (src/web/index.html, `.brand .logo`): the white bricks on the
 * teal tile (`--cta`, #2b6f70), filled to the square's edge, so the one image reads on a light list and a dark one alike
 * (no `theme`). A 128x128 PNG, because every client that renders icons MUST read PNG and only SHOULD read SVG; a
 * connector list draws it at 16 to 64 px, which 128 covers at 2x. It is a `data:` URI: no request, no path a relay must
 * forward, no origin to check. Rendered once from that SVG by Chromium (1144 bytes); render it again the same way if the
 * logo changes.
 *
 * `MASON_MCP_ICON` (mason serve, beside MASON_MCP_URL) replaces it, for a deployment with its own brand:
 *   - a `data:` URL of a PNG or SVG in base64, held to `MASON_UI_ICON`'s one form (`iconDataUrl`, src/cli/ui-icon.ts:
 *     strict base64, at most `ICON_BYTES_MAX` bytes, a PNG's signature or an `<svg>`), its size read from the PNG;
 *   - or an `https:` URL on MASON_MCP_URL's own origin, as the spec's "Icons" asks a client to check ("Verify that
 *     icon URIs are from the same origin as the server"), with no user, password, query or fragment.
 * Anything else refuses the start, never quoting the value (a secret pasted in the wrong place stays unsaid).
 */
import { iconDataUrl } from "./ui-icon.ts";

/** MCP's `Icon` (schema 2025-11-25 and 2026-07-28). */
export interface McpIcon {
  src: string;
  mimeType?: string;
  sizes?: string[];
  theme?: "light" | "dark";
}

export const MCP_ICON_SETTING = "MASON_MCP_ICON";

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

/** A PNG's width and height, from its IHDR chunk (the first, right after the 8-byte signature), or null. */
export function pngSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24 || bytes.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** The media type an https: icon's path says by its extension; none otherwise (the client reads the response's). */
const TYPE_OF_EXTENSION: Readonly<Record<string, string>> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", svg: "image/svg+xml", webp: "image/webp" };

/**
 * MASON_MCP_ICON as the icons serverInfo sends: null unset or set empty (the default is sent), the icons, or what is
 * wrong. `endpoint` is MASON_MCP_URL as read already (null when it is not): an https: icon must be on its origin.
 */
export function mcpIconSetting(env: Readonly<Record<string, string | undefined>>, endpoint: URL | null): readonly McpIcon[] | null | { problem: string } {
  const v = env[MCP_ICON_SETTING] ?? "";
  if (v === "") return null;
  const at = `${MCP_ICON_SETTING} is set`;
  const way = `an https:// address on MASON_MCP_URL's origin (${endpoint === null ? "https://<its host>" : endpoint.origin}/icon.png), ` +
    "or data:image/png;base64,… or data:image/svg+xml;base64,…, the file in base64 (base64 -w0 icon.png)";
  if (/^data:/i.test(v)) {
    const url = iconDataUrl(MCP_ICON_SETTING, v);
    if (typeof url !== "string") return url;
    const mimeType = url.slice("data:".length, url.indexOf(";"));
    if (mimeType === "image/svg+xml") return [{ src: url, mimeType, sizes: ["any"] }];
    const size = pngSize(Buffer.from(url.slice(url.indexOf(",") + 1), "base64"));
    if (size === null || size.width === 0 || size.height === 0) {
      return { problem: `${at} to a data: URL of image/png with no image header (IHDR) after its signature: encode the PNG file itself (base64 -w0 icon.png)` };
    }
    return [{ src: url, mimeType, sizes: [`${size.width}x${size.height}`] }];
  }
  if (v.length > MAX_ICON_URL) return { problem: `${at} to ${v.length} characters: an address is at most ${MAX_ICON_URL}; ${way}` };
  let u: URL;
  try { u = new URL(v); } catch { return { problem: `${at} to what is neither a data: URL nor an address: ${way}` }; }
  // what may be said of it: the scheme and the host of a web address alone, never its path or the rest
  if (u.protocol !== "https:" && u.protocol !== "http:") return { problem: `${at} to what is neither a data: URL nor an https:// address: ${way}` };
  if (u.username !== "" || u.password !== "") {
    return { problem: `${at} to an address that carries a user or a password (${u.protocol}//****@${u.host}): a client fetches an icon without credentials; ${way}` };
  }
  if (u.search !== "" || u.hash !== "" || v.includes("?") || v.includes("#")) {
    return { problem: `${at} to an address that carries a query or a fragment (${u.protocol}//${u.host}/…): the address alone; ${way}` };
  }
  if (u.protocol !== "https:") return { problem: `${at} to an http:// address (${u.host}): a client takes an icon only over https:// or as a data: URL; ${way}` };
  if (endpoint === null) return { problem: `${at} to an address, and MASON_MCP_URL gives no address to hold it to: an https:// icon is on the endpoint's own origin` };
  if (u.origin !== endpoint.origin) {
    return { problem: `${at} to an address on ${u.origin}, and the endpoint is on ${endpoint.origin} (MASON_MCP_URL): a client takes an icon from the server's own origin alone; ${way}` };
  }
  const ext = /\.([a-z]+)$/i.exec(u.pathname)?.[1]?.toLowerCase();
  const mimeType = ext === undefined ? undefined : TYPE_OF_EXTENSION[ext];
  return [{ src: u.href, ...(mimeType !== undefined ? { mimeType } : {}) }];
}
