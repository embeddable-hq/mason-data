/**
 * `MASON_UI_ICON` (mason serve; issue 969): THE PAGE'S OWN ICON. A site that embeds Mason's page gives the browser's tab
 * an icon of its own. Unset, the page keeps its empty icon (`<link rel="icon" href="data:,">`), as before.
 *
 * The value is a `data:` URL, so the icon is inline: the browser makes no request for it, and the page's CSP
 * (`img-src 'self' data:`, src/cli/security.ts) already allows it. It is an operator's text put in the page's HTML, so it
 * is held to ONE form and refused otherwise, at the start, never quoting the value:
 *   - `data:image/png;base64,<data>` or `data:image/svg+xml;base64,<data>` (the type and `base64` in any case, given
 *     back in lower case), with no other parameter;
 *   - the data strict base64: only A–Z, a–z, 0–9, `+` and `/`, with its `=` padding, read back to the same text;
 *   - the image at most `ICON_BYTES_MAX` bytes;
 *   - a PNG that starts with PNG's signature, and an SVG that is UTF-8 text with an `<svg` element.
 * So what is written into the page holds only the fixed prefix and base64's letters: nothing that can end the attribute.
 * It is escaped as an attribute all the same (`iconLink`).
 *
 * The run writes it into the page's HTML once, when it starts (`pageWithIcon`, read by src/cli/run-server.ts), so the
 * tab has its icon before any script runs. It is not in `/api/state`, which the page asks every 2 s.
 */
export const UI_ICON_SETTING = "MASON_UI_ICON";

/** The largest image taken, in bytes: a tab's icon, far short of a page's weight in every request of it. */
export const ICON_BYTES_MAX = 4096;

/** The media types taken, as the page is given them. */
const ICON_TYPES = ["image/png", "image/svg+xml"] as const;

/** The base64 characters that encode `ICON_BYTES_MAX` bytes: past it, the image is too big without reading it. */
const ICON_DATA_MAX = Math.ceil(ICON_BYTES_MAX / 3) * 4;

/** PNG's signature: the first eight bytes of every PNG file. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** What a valid value looks like, said at the end of each problem. */
const WAY = "data:image/png;base64,… or data:image/svg+xml;base64,…, the file in base64 (base64 -w0 icon.png)";

/** The page's icon as the environment says it: null unset (or set empty), the `data:` URL the page is given, or what is wrong. */
export function uiIconSetting(env: Readonly<Record<string, string | undefined>>): string | null | { problem: string } {
  const v = env[UI_ICON_SETTING] ?? "";
  if (v === "") return null;
  const at = `${UI_ICON_SETTING} is set`;
  if (!/^data:/i.test(v)) return { problem: `${at} to something other than a data: URL, and the icon is inline: ${WAY}` };
  const comma = v.indexOf(",");
  if (comma < 0) return { problem: `${at} to a data: URL with no comma before its data: ${WAY}` };
  const parts = v.slice("data:".length, comma).toLowerCase().split(";");
  const type = parts[0]!;
  if (!(ICON_TYPES as readonly string[]).includes(type)) {
    // the type is named only when it reads as one (letters, digits and . + -, short): never the value's other text
    const named = /^[a-z0-9.+-]{1,40}\/[a-z0-9.+-]{1,40}$/.test(type) ? type : type === "" ? "no media type" : "another media type";
    return { problem: `${at} to a data: URL of ${named}, and the icon is image/png or image/svg+xml: ${WAY}` };
  }
  if (parts.length !== 2 || parts[1] !== "base64") return { problem: `${at} to a data: URL that is not ;base64 right after its type: ${WAY}` };
  const data = v.slice(comma + 1);
  if (data === "") return { problem: `${at} to a data: URL with no image after its comma: ${WAY}` };
  if (data.length > ICON_DATA_MAX) {
    return { problem: `${at} to an image of about ${Math.floor(data.length * 3 / 4)} bytes, and the icon is at most ${ICON_BYTES_MAX} bytes: make it smaller` };
  }
  const bytes = /^[A-Za-z0-9+/]*={0,2}$/.test(data) && data.length % 4 === 0 ? Buffer.from(data, "base64") : null;
  if (bytes === null || bytes.toString("base64") !== data) {
    return { problem: `${at} to a data: URL whose base64 is not valid (a character outside A-Z, a-z, 0-9, + and /, a space, or the wrong = padding): ${WAY}` };
  }
  if (bytes.length > ICON_BYTES_MAX) return { problem: `${at} to an image of ${bytes.length} bytes, and the icon is at most ${ICON_BYTES_MAX} bytes: make it smaller` };
  if (type === "image/png" && !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return { problem: `${at} to a data: URL of image/png whose data is not a PNG file: encode the PNG file itself (base64 -w0 icon.png)` };
  }
  if (type === "image/svg+xml" && !isSvg(bytes)) {
    return { problem: `${at} to a data: URL of image/svg+xml whose data is not an SVG file (UTF-8 text with an <svg> element): encode the SVG file itself (base64 -w0 icon.svg)` };
  }
  return `data:${type};base64,${data}`;
}

/** An SVG file: UTF-8 text with an `<svg` element. */
function isSvg(bytes: Buffer): boolean {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return false; } // not UTF-8: not an SVG file, which the caller refuses
  return /<svg[\s>]/.test(text);
}

/** The icon a run's page is given: the setting's URL, else none (a problem refused the start before the run reads it). */
export const iconOf = (s: string | null | { problem: string }): string | null => typeof s === "string" ? s : null;

/** The page's empty icon, as src/web/index.html writes it: what an icon replaces. */
export const EMPTY_ICON_LINK = `<link rel="icon" href="data:,">`;

const escAttr = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The page's icon element for a `data:` URL `uiIconSetting` gave, escaped as an attribute. */
export const iconLink = (url: string): string => `<link rel="icon" href="${escAttr(url)}">`;

/**
 * The page's HTML with its icon: the same bytes when there is none, else its empty icon replaced. A page without the
 * empty icon is a broken install, said, never served without the icon the operator set.
 */
export function pageWithIcon(html: Buffer, icon: string | null): Buffer {
  if (icon === null) return html;
  const text = html.toString("utf8");
  const at = text.indexOf(EMPTY_ICON_LINK);
  if (at < 0) throw new Error(`the web page's index.html has no ${EMPTY_ICON_LINK} for ${UI_ICON_SETTING} to replace: this Mason is installed incompletely — npm i -g @mason-data/cli again`);
  return Buffer.from(text.slice(0, at) + iconLink(icon) + text.slice(at + EMPTY_ICON_LINK.length), "utf8");
}
