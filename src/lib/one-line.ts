/**
 * TEXT AS ONE LINE, for whatever writes it inside a line of its own: a service's answer (src/cli/hosted.ts
 * `serviceText`), and every value that came from the network into a log line (`untrustedText`: `mason serve`'s MCP
 * endpoint, src/cli/mcp-http.ts). No character in it can end the line, move a cursor, clear a screen or reorder what a
 * person reads, so a client's value never starts a line of its own in a log a platform keeps.
 */

/** `t` AS ONE LINE (pure: no secret read, nothing recorded): every character that would break or reorder a line
 *  replaced by `?`, and no run of spaces. A value equal to its `oneLine` prints as it is. */
export function oneLine(s: string): string {
  // C0 (newline, return and tab with it), DEL and C1 (NEL with it); the zero-width and directional marks; the line and
  // paragraph separators; the bidi embeddings, overrides and isolates; the byte-order mark
  let t = s.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, "?");
  // and a lone surrogate, which is no character: --json would write it as an escape (`\udc00`), whose letters and
  // digits a reader reads (PR 645's review, round 2)
  t = t.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "?");
  // and no run of spaces: a value padded to a terminal's width aligns nothing, and leaves no gap to break at a column of
  // its choosing (src/cli/command.ts breaks every line that holds it: serviceStyle)
  return t.replace(/\s+/g, " ").trim();
}

/** the most characters of one value a log line holds, unless its site names fewer */
export const UNTRUSTED_MAX = 120;

/**
 * A VALUE FROM THE NETWORK, AS A LOG LINE MAY HOLD IT: a JSON-RPC method, id, params value or reason, a header, a
 * client's name, a token's claim, an error another server's answer made — `oneLine`'s, and at most `max` characters
 * (`…` where it was cut). Anything not a string is its JSON first. The ONE way such a value reaches a line `mason
 * serve`'s MCP endpoint logs (tests/cli-mcp-http.test.ts "no client starts a line of mason serve's log").
 */
export function untrustedText(v: unknown, max: number = UNTRUSTED_MAX): string {
  const s = typeof v === "string" ? v : (JSON.stringify(v) ?? String(v));
  const chars = [...oneLine(s)];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}
