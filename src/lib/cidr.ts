/**
 * ADDRESSES AND ADDRESS RANGES, READ BY ONE GRAMMAR: `MASON_PG_PROXY_FROM` (src/api/postgres/proxy.ts) and a `mason
 * user`'s address ranges (src/duck/users.ts `from`) both read an entry here. An entry is an IPv4 or IPv6 address, alone
 * (one address: /32 or /128) or with its prefix length, held to its family (`10.0.0.0/33` and `999.999.999.999/99` are
 * refused), with no bits set past the prefix (`10.0.1.5/24` is refused with its network as the guess), and no host name
 * (never looked up) nor zone index. An address is first held to `node:net`'s own reading (`isIPv4`, `isIPv6`), then
 * read into its bytes here, so nothing either reading refuses is ever taken.
 *
 * EVERY ADDRESS IN ONE SPACE, as Mason means one: IPv6's 128 bits, an IPv4 address at its v4-mapped place
 * (::ffff:a.b.c.d), since a v4-mapped peer or header source IS that IPv4 client (`shownAddress`). What an entry names and
 * what a list covers are both read here, never from how an entry is spelt: `0.0.0.0/1,128.0.0.0/1` is every IPv4
 * address, as `0.0.0.0/0` is, and `::/64` holds every v4-mapped address, so every IPv4 one too.
 */
import * as net from "node:net";

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
  if (!net.isIPv4(text)) return null;
  const parts = text.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^(?:0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255)) return null;
  return Uint8Array.from(parts.map(Number));
}

/** An IPv6 address's 16 bytes (`::` once at most, an IPv4 tail); null for anything else, a zone index included. */
export function ipv6Bytes(text: string): Uint8Array | null {
  // node:net takes a zone index (fe80::1%eth0): an address with one names no place here
  if (!/^[0-9A-Fa-f:.]+$/.test(text) || !net.isIPv6(text)) return null;
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
export function ipv6Text(b: Uint8Array): string {
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

/** One entry as written: an address family, the network's bytes and its prefix. */
export interface Cidr { family: 4 | 6; bytes: Uint8Array; prefix: number }

export const V4_START = 0xffffn << 32n;
export const V4_END = V4_START + (1n << 32n) - 1n;
export const ALL_END = (1n << 128n) - 1n;

/** the places from `start` to `end`, both included */
export interface Range { start: bigint; end: bigint }

const bigOf = (b: Uint8Array): bigint => b.reduce((n, x) => (n << 8n) | BigInt(x), 0n);

/** an address's place (`V4_START`), or null when it is no address */
function placeOf(address: string): bigint | null {
  const v4 = ipv4Bytes(address);
  if (v4 !== null) return V4_START | bigOf(v4);
  const v6 = ipv6Bytes(address);
  return v6 === null ? null : bigOf(v6);
}

/** the places an entry names */
export function rangeOf(c: Cidr): Range {
  const start = c.family === 4 ? V4_START | bigOf(c.bytes) : bigOf(c.bytes);
  return { start, end: start + (1n << BigInt((c.family === 4 ? 32 : 128) - c.prefix)) - 1n };
}

/** Whether `address` (as `shownAddress` shows one, or in any spelling of the same address) is in one of `ranges`; never
 *  for what is no address. */
export function inRanges(ranges: readonly Range[], address: string): boolean {
  const at = placeOf(address);
  return at !== null && ranges.some((r) => r.start <= at && at <= r.end);
}

/** whether `ranges` together hold every place from `lo` to `hi` */
export function covers(ranges: readonly Range[], lo: bigint, hi: bigint): boolean {
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

/** An entry as Mason writes it back: the network in `shownAddress`'s form, its prefix only when it is not one address. */
export const cidrText = (c: Cidr): string => `${text(c.family, c.bytes)}${c.prefix === (c.family === 4 ? 32 : 128) ? "" : `/${c.prefix}`}`;

/**
 * One entry read, or what is wrong with it, with a did-you-mean where one is a fair guess: a guess is offered only
 * once it is read as an entry itself, so it is never one that would be refused in turn. `everyRefused`: a prefix of 0
 * (every address of a family) is refused with these words (a PROXY header believed from anyone); else it is taken.
 */
export function cidrOf(entry: string, everyRefused: string | null = null): Cidr | { problem: string } {
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
    const meant = `${text(4, net4)}${p4 === 32 ? "" : `/${p4}`}`, read = cidrOf(meant, everyRefused);
    return { problem: "problem" in read
      ? `${quoted} is IPv4 written as IPv6, which Mason reads as ${meant}, and ${read.problem}`
      : `${quoted} is IPv4 written as IPv6, which Mason reads as IPv4: did you mean ${meant}?` };
  }
  if (prefix === 0 && everyRefused !== null) return { problem: `${quoted} names every address, ${everyRefused}` };
  const net = network(bytes, prefix);
  if (!prefixEqual(net, bytes, max)) return { problem: `${quoted} has bits set past its prefix: did you mean ${text(family, net)}/${prefix}?` };
  return { family, bytes: net, prefix };
}
