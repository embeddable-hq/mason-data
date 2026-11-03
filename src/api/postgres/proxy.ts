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

/** An address as Mason shows it: IPv4 dotted, IPv6 in RFC 5952's form, a v4-mapped IPv6 one as IPv4; null when it is no
 *  address (undefined, a zone index, a name). */
export function shownAddress(text: string | undefined): string | null {
  if (text === undefined) return null;
  const v4 = ipv4Bytes(text);
  if (v4 !== null) return Array.from(v4).join(".");
  const v6 = ipv6Bytes(text);
  return v6 === null ? null : ipv6Text(v6);
}

/** An IPv4 address's 4 bytes, from dotted decimal with no leading zero; null for anything else. */
function ipv4Bytes(text: string): Uint8Array | null {
  const parts = text.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^(?:0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255)) return null;
  return Uint8Array.from(parts.map(Number));
}

/** An IPv6 address's 16 bytes (`::` once at most, an IPv4 tail); null for anything else, a zone index included. */
function ipv6Bytes(text: string): Uint8Array | null {
  if (!/^[0-9A-Fa-f:.]+$/.test(text)) return null;
  const halves = text.split("::");
  if (halves.length > 2 || (halves.length === 2 && halves[0]!.includes("."))) return null;
  const groups = (s: string): number[] | null => {
    if (s === "") return [];
    const out: number[] = [];
    const parts = s.split(":");
    for (const [i, p] of parts.entries()) {
      if (i === parts.length - 1 && p.includes(".")) {
        const v4 = ipv4Bytes(p);
        if (v4 === null) return null;
        out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      } else if (/^[0-9A-Fa-f]{1,4}$/.test(p)) out.push(parseInt(p, 16));
      else return null;
    }
    return out;
  };
  const head = groups(halves[0]!), tail = halves.length === 2 ? groups(halves[1]!) : [];
  if (head === null || tail === null) return null;
  const n = head.length + tail.length;
  if (halves.length === 1 ? n !== 8 : n > 7) return null;
  const all = [...head, ...new Array<number>(8 - n).fill(0), ...tail];
  return Uint8Array.from(all.flatMap((g) => [g >> 8, g & 0xff]));
}

/** whether 16 bytes are an IPv4 address mapped into IPv6 (::ffff:a.b.c.d) */
const v4Mapped = (b: Uint8Array): boolean => b.subarray(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff;

/** 16 bytes as Mason shows an IPv6 address: RFC 5952 (lower case, the longest run of two or more zero groups as `::`,
 *  the first of equal runs), and a v4-mapped one as its IPv4 address. */
function ipv6Text(b: Uint8Array): string {
  if (v4Mapped(b)) return Array.from(b.subarray(12, 16)).join(".");
  const g = Array.from({ length: 8 }, (_, i) => (b[2 * i]! << 8) | b[2 * i + 1]!);
  let at = -1, run = 0;
  for (let i = 0; i < 8;) {
    if (g[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > run) { at = i; run = j - i; }
    i = j;
  }
  const hex = g.map((x) => x.toString(16));
  return run < 2 ? hex.join(":") : `${hex.slice(0, at).join(":")}::${hex.slice(at + run).join(":")}`;
}

/** One entry of the setting as written: an address family, the network's bytes and its prefix. */
interface Cidr { family: 4 | 6; bytes: Uint8Array; prefix: number }

/**
 * EVERY ADDRESS IN ONE SPACE, as Mason means one: IPv6's 128 bits, an IPv4 address at its v4-mapped place
 * (::ffff:a.b.c.d), since a v4-mapped peer or header source IS that IPv4 client (`shownAddress`). What an entry names and
 * what the list covers are both read here, never from how an entry is spelt: `0.0.0.0/1,128.0.0.0/1` is every IPv4
 * address, as `0.0.0.0/0` is, and `::/64` holds every v4-mapped address, so every IPv4 one too.
 */
const V4_START = 0xffffn << 32n;
const V4_END = V4_START + (1n << 32n) - 1n;
const ALL_END = (1n << 128n) - 1n;

/** the places from `start` to `end`, both included */
interface Range { start: bigint; end: bigint }

/** The addresses a PROXY header is believed from (`parseProxyFrom`): the entries as written, and the places they name. */
export interface ProxyFrom { entries: string[]; ranges: Range[] }

const bigOf = (b: Uint8Array): bigint => b.reduce((n, x) => (n << 8n) | BigInt(x), 0n);

/** an address's place (`V4_START`), or null when it is no address */
function placeOf(address: string): bigint | null {
  const v4 = ipv4Bytes(address);
  if (v4 !== null) return V4_START | bigOf(v4);
  const v6 = ipv6Bytes(address);
  return v6 === null ? null : bigOf(v6);
}

/** the places an entry names */
function rangeOf(c: Cidr): Range {
  const start = c.family === 4 ? V4_START | bigOf(c.bytes) : bigOf(c.bytes);
  return { start, end: start + (1n << BigInt((c.family === 4 ? 32 : 128) - c.prefix)) - 1n };
}

/** Whether `address` (as `shownAddress` shows one, or in any spelling of the same address) is among those `from` names. */
export function proxyNames(from: ProxyFrom, address: string): boolean {
  const at = placeOf(address);
  return at !== null && from.ranges.some((r) => r.start <= at && at <= r.end);
}

/** whether `ranges` together hold every place from `lo` to `hi` */
function covers(ranges: readonly Range[], lo: bigint, hi: bigint): boolean {
  let next = lo;
  for (const r of [...ranges].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))) {
    if (r.start > next) return false;
    if (r.end >= next) next = r.end + 1n;
    if (next > hi) return true;
  }
  return next > hi;
}

function prefixEqual(a: Uint8Array, b: Uint8Array, bits: number): boolean {
  for (let i = 0; i * 8 < bits; i++) {
    const mask = bits - i * 8 >= 8 ? 0xff : (0xff << (8 - (bits - i * 8))) & 0xff;
    if ((a[i]! & mask) !== (b[i]! & mask)) return false;
  }
  return true;
}

/** the network `bytes` / `prefix` names, its host bits cleared */
function network(bytes: Uint8Array, prefix: number): Uint8Array {
  return bytes.map((x, i) => i * 8 >= prefix ? 0 : prefix - i * 8 >= 8 ? x : x & ((0xff << (8 - (prefix - i * 8))) & 0xff));
}

const text = (family: 4 | 6, bytes: Uint8Array): string => family === 4 ? Array.from(bytes).join(".") : ipv6Text(bytes);

/** One entry read, or what is wrong with it, with a did-you-mean where one is a fair guess: a guess is offered only
 *  once it is read as an entry itself, so it is never one that would be refused in turn. */
function cidrOf(entry: string): Cidr | { problem: string } {
  const quoted = JSON.stringify(entry);
  const m = /^([^/]*)(?:\/(\d{1,3}))?$/.exec(entry);
  const v4 = m === null ? null : ipv4Bytes(m[1]!), v6 = m === null || v4 !== null ? null : ipv6Bytes(m[1]!);
  if (m === null || (v4 === null && v6 === null)) {
    return { problem: `${quoted} is not an address or a CIDR (10.0.0.0/16, 2001:db8::/32, or one address such as 10.0.4.7; a host name is not looked up)` };
  }
  const family = v4 !== null ? 4 : 6, bytes = (v4 ?? v6)!, max = family === 4 ? 32 : 128;
  const prefix = m[2] === undefined ? max : Number(m[2]);
  if (prefix > max) return { problem: `${quoted}: an IPv${family} prefix is at most /${max}` };
  if (family === 6 && v4Mapped(bytes) && prefix >= 96) {
    const p4 = prefix - 96, net4 = network(bytes.subarray(12, 16), p4);
    const meant = `${text(4, net4)}${p4 === 32 ? "" : `/${p4}`}`, read = cidrOf(meant);
    return { problem: "problem" in read
      ? `${quoted} is IPv4 written as IPv6, which Mason reads as ${meant}, and ${read.problem}`
      : `${quoted} is IPv4 written as IPv6, which Mason reads as IPv4: did you mean ${meant}?` };
  }
  if (prefix === 0) return { problem: `${quoted} names every address, so any client could claim to be any other: name the proxy's own addresses` };
  const net = network(bytes, prefix);
  if (!prefixEqual(net, bytes, max)) return { problem: `${quoted} has bits set past its prefix: did you mean ${text(family, net)}/${prefix}?` };
  return { family, bytes: net, prefix };
}

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
    const c = cidrOf(e);
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
