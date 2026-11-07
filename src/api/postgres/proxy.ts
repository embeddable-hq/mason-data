/**
 * THE POSTGRES API BEHIND A TCP PROXY (`MASON_PG_PROXY_FROM`; docs/POSTGRES-API.md "Behind a TCP proxy"). Behind a TCP
 * load balancer or proxy (an AWS NLB, HAProxy, an edge of one's own) every connection's peer is the proxy, so the
 * request log could not say who sent what. A proxy that speaks the PROXY protocol v2 (haproxy's proxy-protocol.txt,
 * section 2.2) begins each connection with a binary header naming the client it carries. A header is a CLAIM about
 * where a connection came from, so it is believed only from an address the operator named:
 *   - a connection from a named address MUST begin with a valid v2 header, or it is refused;
 *   - a connection from any other address is read as before, and a PROXY header from it is refused, never believed;
 *   - unset, nothing is named and nothing changes.
 * The header is read whole before anything else on the connection is looked at (an SSLRequest, a direct TLS start, a
 * startup packet, a CancelRequest), and bounded in size (`MAX_PROXY_BODY`) and in time (`PROXY_HEADER_MS`).
 *
 * THE CLIENT'S ADDRESS HAS ONE READER (`clientAddress`): the source a named proxy's header carries, else the socket's
 * peer, a v4-mapped IPv6 address shown as IPv4 (`shownAddress`). The request log's `client_addr` and the session's log
 * line read it, never the socket.
 */

import { ALL_END, cidrOf, covers, inRanges, ipv6Text, rangeOf, shownAddress, V4_END, V4_START, type Range } from "../../lib/cidr.ts";

export { shownAddress };

/** the v2 header's first 12 bytes (section 2.2) */
export const PROXY_V2_SIGNATURE: Buffer = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]);
/** how a v1 (text) header begins */
const PROXY_V1_START: Buffer = Buffer.from("PROXY ", "latin1");
/** The most a header may carry past its 16 fixed bytes: the largest address block of the spec (two UNIX paths, 216
 *  bytes), which holds an IPv6 pair (36) and 180 bytes of TLVs. A header that says more is refused. */
export const MAX_PROXY_BODY = 216;
/** How long a named proxy has to send its whole header once it has connected. */
export const PROXY_HEADER_MS = 5_000;
/** the setting, as every message names it */
export const PROXY_SETTING = "MASON_PG_PROXY_FROM";

/** A header read: `LOCAL` (the proxy's own connection, a health check: the socket's address stands) or `PROXY`, whose
 *  source is the client it carries. */
export interface ProxyHeader { command: "LOCAL" | "PROXY"; source: { address: string; port: number } | null }

/** What the bytes so far are: too few to tell, a whole header and its length, or never a valid header (and why). */
export type ProxyRead = { more: true } | { header: ProxyHeader; length: number } | { refused: string };

/**
 * The PROXY v2 header at the start of `b`, read as section 2.2 says: the signature, version 2, the LOCAL or PROXY
 * command, TCP over IPv4 (0x11) or IPv6 (0x21) for a PROXY command, its length at most MAX_PROXY_BODY, and its TLVs
 * skipped, each held inside the block. Asked again as bytes arrive: a header split across reads is `more` until it is
 * whole, and a wrong byte is refused as soon as it arrives. A v1 (text) header is refused by name.
 */
export function readProxyHeader(b: Uint8Array): ProxyRead {
  for (let i = 0; i < Math.min(b.length, PROXY_V2_SIGNATURE.length); i++) {
    if (b[i] === PROXY_V2_SIGNATURE[i]) continue;
    const v1 = Math.min(b.length, PROXY_V1_START.length);
    if (b.subarray(0, v1).every((c, j) => c === PROXY_V1_START[j])) {
      return v1 < PROXY_V1_START.length ? { more: true } : { refused: "a PROXY protocol v1 (text) header: Mason reads version 2 alone (HAProxy's send-proxy-v2)" };
    }
    return { refused: "no PROXY protocol v2 header: its first 12 bytes are not the signature" };
  }
  if (b.length < 16) return { more: true };
  const version = b[12]! >> 4, command = b[12]! & 0x0f;
  if (version !== 2) return { refused: `a PROXY header of version ${version}: Mason reads version 2` };
  if (command > 1) return { refused: `a PROXY header with the command 0x${command.toString(16)}: only LOCAL (0x0) and PROXY (0x1) are defined` };
  const family = b[13]!, length = (b[14]! << 8) | b[15]!;
  if (length > MAX_PROXY_BODY) return { refused: `a PROXY header of ${length} bytes past its first 16: Mason reads at most ${MAX_PROXY_BODY}` };
  if (b.length < 16 + length) return { more: true };
  // LOCAL: the proxy's own connection (a health check); its address block is discarded, as the spec says
  if (command === 0) return { header: { command: "LOCAL", source: null }, length: 16 + length };
  const body = b.subarray(16, 16 + length);
  const addresses = family === 0x11 ? 12 : family === 0x21 ? 36 : null;
  if (addresses === null) {
    return { refused: `a PROXY header for family and transport 0x${family.toString(16).padStart(2, "0")}: Mason reads TCP over IPv4 (0x11) or IPv6 (0x21), and an UNSPEC one with LOCAL alone` };
  }
  if (length < addresses) return { refused: `a PROXY header of ${length} bytes past its first 16, too few for its addresses (${addresses})` };
  const source = family === 0x11
    ? { address: Array.from(body.subarray(0, 4)).join("."), port: (body[8]! << 8) | body[9]! }
    : { address: ipv6Text(body.subarray(0, 16)), port: (body[32]! << 8) | body[33]! };
  // the TLVs (type, a 2-byte length, the value): skipped, each held inside the block
  for (let at = addresses; at < length;) {
    if (length - at < 3) return { refused: "a PROXY header whose last TLV is cut short" };
    at += 3 + ((body[at + 1]! << 8) | body[at + 2]!);
    if (at > length) return { refused: "a PROXY header with a TLV past its end" };
  }
  return { header: { command: "PROXY", source }, length: 16 + length };
}

/** Whether a connection's first byte is a PROXY header's, v2 or v1: never a startup packet's (its length's first byte is
 *  0) nor a TLS ClientHello's (0x16). */
export const startsProxyHeader = (first: number): boolean => first === PROXY_V2_SIGNATURE[0] || first === PROXY_V1_START[0];

/**
 * THE CLIENT'S ADDRESS, THE ONE READER OF IT: the source the header of a named proxy carries, else the socket's peer
 * (a LOCAL header's connection is the proxy's own), shown as Mason shows an address (`shownAddress`); null when the
 * peer cannot be read.
 */
export function clientAddress(peer: string | undefined, header: ProxyHeader | null): string | null {
  return header?.source?.address ?? shownAddress(peer);
}

/** The addresses a PROXY header is believed from (`parseProxyFrom`): the entries as written, and the places they name. */
export interface ProxyFrom { entries: string[]; ranges: Range[] }

/** Whether `address` (as `shownAddress` shows one, or in any spelling of the same address) is among those `from` names. */
export const proxyNames = (from: ProxyFrom, address: string): boolean => inRanges(from.ranges, address);

/** what a prefix of 0 is refused with: a header believed from every address lets any client claim to be any other */
const EVERY = "so any client could claim to be any other: name the proxy's own addresses";

/**
 * `MASON_PG_PROXY_FROM` read: null when it is unset or empty (no header is believed from anyone, as before), the
 * addresses it names, or why not: every entry that is not an address or a CIDR, each said with what is wrong, or a list
 * whose entries TOGETHER name every IPv4 or every IPv6 address (read as places, never spellings), under which any
 * client could claim to be any other.
 */
export function parseProxyFrom(value: string | undefined): ProxyFrom | null | { problem: string } {
  if (value === undefined || value.trim() === "") return null;
  const entries = value.split(",").map((e) => e.trim());
  const ranges: Range[] = [], wrong: string[] = [];
  for (const e of entries) {
    if (e === "") { wrong.push("an empty entry between two commas"); continue; }
    const c = cidrOf(e, EVERY);
    if ("problem" in c) wrong.push(c.problem); else ranges.push(rangeOf(c));
  }
  const setting = `${PROXY_SETTING}=${JSON.stringify(value)}`;
  if (wrong.length) return { problem: `${setting}: ${wrong.join("; ")}` };
  const every = [
    ...(covers(ranges, V4_START, V4_END) ? ["every IPv4 address (0.0.0.0/0)"] : []),
    // IPv6's every address but the v4-mapped ones, which are IPv4's and judged above
    ...(covers(ranges, 0n, V4_START - 1n) && covers(ranges, V4_END + 1n, ALL_END) ? ["every IPv6 address (::/0)"] : []),
  ];
  if (every.length) return { problem: `${setting}: its entries together name ${every.join(" and ")}, so any client could claim to be any other: name the proxy's own addresses` };
  return { entries, ranges };
}
