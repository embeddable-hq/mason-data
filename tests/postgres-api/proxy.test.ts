/**
 * THE PROXY PROTOCOL v2 HEADER AND THE ADDRESSES IT IS BELIEVED FROM (src/api/postgres/proxy.ts), held to haproxy's
 * proxy-protocol.txt section 2.2 by headers built from the spec alone (tests/postgres-api/wire.ts `proxyV2`): IPv4 and
 * IPv6 sources, LOCAL, UNSPEC, TLVs skipped, truncated at every length, an oversized length, a v1 (text) header and a
 * wrong signature refused, a header read one byte at a time; the client's address, the one reader of it; and
 * `MASON_PG_PROXY_FROM` read, every bad entry refused by name. The listener's side is tests/duck-proxy-wire.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { clientAddress, MAX_PROXY_BODY, parseProxyFrom, proxyNames, readProxyHeader, shownAddress, type ProxyFrom } from "../../src/api/postgres/proxy.ts";
import { proxyTlv, proxyV2, proxyV2Inet4, proxyV2Inet6, startup } from "./wire.ts";

const after = startup({ user: "mason", database: "shop" });

test("a v2 header for IPv4 names its source and port, and says where the client's own bytes begin", () => {
  const h = proxyV2Inet4("203.0.113.7", 51234);
  assert.equal(h.length, 28);
  assert.deepEqual(readProxyHeader(h), { header: { command: "PROXY", source: { address: "203.0.113.7", port: 51234 } }, length: 28 });
  assert.deepEqual(readProxyHeader(Buffer.concat([h, after])), { header: { command: "PROXY", source: { address: "203.0.113.7", port: 51234 } }, length: 28 },
    "the startup packet after it is the client's, never the header's");
});

test("a v2 header for IPv6 names its source in RFC 5952's form, a v4-mapped one as IPv4", () => {
  const read = (hex: string): unknown => { const r = readProxyHeader(proxyV2Inet6(hex, 443)); return "header" in r ? r.header.source : r; };
  assert.deepEqual(read("20010db8000000000000000000000007"), { address: "2001:db8::7", port: 443 });
  assert.deepEqual(read("20010db8000000000001000000000001"), { address: "2001:db8::1:0:0:1", port: 443 }, "the longest run of zeros, the first of two");
  assert.deepEqual(read("20010db8000100000001000100010001"), { address: "2001:db8:1:0:1:1:1:1", port: 443 }, "one zero group is never ::");
  assert.deepEqual(read("00000000000000000000000000000001"), { address: "::1", port: 443 });
  assert.deepEqual(read("00000000000000000000ffffc6336409"), { address: "198.51.100.9", port: 443 }, "as Mason shows every address");
  assert.deepEqual(readProxyHeader(proxyV2Inet6("20010db8000000000000000000000007", 1)), { header: { command: "PROXY", source: { address: "2001:db8::7", port: 1 } }, length: 52 });
});

test("LOCAL is the proxy's own connection, whatever its family: the socket's address stands; UNSPEC, UNIX and UDP with PROXY are refused", () => {
  assert.deepEqual(readProxyHeader(proxyV2(0, 0x00, Buffer.alloc(0))), { header: { command: "LOCAL", source: null }, length: 16 });
  assert.deepEqual(readProxyHeader(proxyV2(0, 0x11, proxyV2Inet4("203.0.113.7", 1).subarray(16))), { header: { command: "LOCAL", source: null }, length: 28 },
    "its address block discarded, as the spec says");
  for (const family of [0x00, 0x31, 0x12, 0x22, 0x10, 0x41]) {
    const r = readProxyHeader(proxyV2(1, family, Buffer.alloc(36)));
    assert.ok("refused" in r && /family and transport 0x/.test(r.refused), `0x${family.toString(16)}: ${JSON.stringify(r)}`);
  }
  const short = readProxyHeader(proxyV2(1, 0x11, Buffer.alloc(8)));
  assert.ok("refused" in short && /too few for its addresses \(12\)/.test(short.refused), JSON.stringify(short));
  const short6 = readProxyHeader(proxyV2(1, 0x21, Buffer.alloc(35)));
  assert.ok("refused" in short6 && /too few for its addresses \(36\)/.test(short6.refused), JSON.stringify(short6));
});

test("TLVs are skipped, each held inside the header: one cut short or past its end is refused", () => {
  const tlvs = Buffer.concat([proxyTlv(0xea, Buffer.from("\x01vpce-0123456789abcdef0", "latin1")), proxyTlv(0x04, Buffer.alloc(0))]);
  assert.deepEqual(readProxyHeader(proxyV2Inet4("10.1.2.3", 9, "10.0.0.1", 5433, tlvs)),
    { header: { command: "PROXY", source: { address: "10.1.2.3", port: 9 } }, length: 28 + tlvs.length });
  const past = readProxyHeader(proxyV2Inet4("10.1.2.3", 9, "10.0.0.1", 5433, Buffer.from([0xea, 0x00, 0x09, 1, 2])));
  assert.ok("refused" in past && /TLV past its end/.test(past.refused), JSON.stringify(past));
  const cut = readProxyHeader(proxyV2Inet4("10.1.2.3", 9, "10.0.0.1", 5433, Buffer.from([0xea, 0x00])));
  assert.ok("refused" in cut && /TLV is cut short/.test(cut.refused), JSON.stringify(cut));
});

test("a header is bounded: at most MAX_PROXY_BODY bytes past its first 16, refused past it before the rest is waited for", () => {
  assert.equal(MAX_PROXY_BODY, 216);
  const most = proxyV2Inet4("10.1.2.3", 9, "10.0.0.1", 5433, proxyTlv(0x04, Buffer.alloc(216 - 12 - 3)));
  assert.equal(most.length, 16 + 216);
  assert.ok("header" in readProxyHeader(most));
  const over = proxyV2Inet4("10.1.2.3", 9, "10.0.0.1", 5433, proxyTlv(0x04, Buffer.alloc(216 - 12 - 2)));
  const r = readProxyHeader(over.subarray(0, 16));
  assert.ok("refused" in r && /of 217 bytes past its first 16: Mason reads at most 216/.test(r.refused), JSON.stringify(r));
  const huge = readProxyHeader(Buffer.concat([proxyV2(1, 0x11, Buffer.alloc(0)).subarray(0, 14), Buffer.from([0xff, 0xff])]));
  assert.ok("refused" in huge, "a length of 65535 is refused at once, never buffered");
});

test("truncated at every length, a header is not yet one; read one byte at a time, it is the whole header", () => {
  for (const h of [proxyV2Inet4("203.0.113.7", 51234), proxyV2Inet6("20010db8000000000000000000000007", 443), proxyV2(0, 0, Buffer.alloc(0)),
    proxyV2Inet4("10.1.2.3", 9, "10.0.0.1", 5433, proxyTlv(0xea, Buffer.from("abc")))]) {
    for (let n = 0; n < h.length; n++) assert.deepEqual(readProxyHeader(h.subarray(0, n)), { more: true }, `${n} of ${h.length} bytes`);
    // as a listener reads it: the bytes so far, a byte more each time
    let held = Buffer.alloc(0), read: ReturnType<typeof readProxyHeader> = { more: true };
    for (const byte of Buffer.concat([h, after])) {
      held = Buffer.concat([held, Buffer.from([byte])]);
      read = readProxyHeader(held);
      if (!("more" in read)) break;
    }
    assert.ok("header" in read && read.length === h.length && held.length === h.length, JSON.stringify(read));
  }
});

test("anything else is refused as soon as a byte says so: a v1 (text) header, a wrong signature, a startup packet, another version or command", () => {
  const v1 = readProxyHeader(Buffer.from("PROXY TCP4 203.0.113.7 192.0.2.1 51234 5433\r\n", "latin1"));
  assert.ok("refused" in v1 && /v1 \(text\) header: Mason reads version 2 alone/.test(v1.refused), JSON.stringify(v1));
  assert.deepEqual(readProxyHeader(Buffer.from("PROX", "latin1")), { more: true }, "the start of a v1 header waits to be named");
  for (const wrong of [Buffer.from("\r\n\r\nX", "latin1"), after, Buffer.from([0x16, 0x03, 0x01]), Buffer.from("PROXYv2", "latin1"), Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0b])]) {
    const r = readProxyHeader(wrong);
    assert.ok("refused" in r, `${wrong.toString("hex")}: ${JSON.stringify(r)}`);
  }
  const sig = proxyV2(1, 0x11, Buffer.alloc(12));
  const version = Buffer.from(sig); version[12] = 0x11;
  const v = readProxyHeader(version);
  assert.ok("refused" in v && /version 1: Mason reads version 2/.test(v.refused), JSON.stringify(v));
  const command = Buffer.from(sig); command[12] = 0x22;
  const c = readProxyHeader(command);
  assert.ok("refused" in c && /command 0x2/.test(c.refused), JSON.stringify(c));
});

test("the client's address has one reader: a named proxy's header's source, else the socket's peer, a v4-mapped one as IPv4", () => {
  assert.equal(clientAddress("127.0.0.1", null), "127.0.0.1");
  assert.equal(clientAddress("::ffff:127.0.0.1", null), "127.0.0.1", "a dual-stack listener's IPv4 peer");
  assert.equal(clientAddress("2001:0DB8:0:0::7", null), "2001:db8::7");
  assert.equal(clientAddress("10.0.0.9", { command: "PROXY", source: { address: "203.0.113.7", port: 1 } }), "203.0.113.7");
  assert.equal(clientAddress("10.0.0.9", { command: "LOCAL", source: null }), "10.0.0.9", "LOCAL: the proxy's own connection");
  assert.equal(clientAddress(undefined, null), null);
  for (const no of ["fe80::1%eth0", "nlb.internal", "1.2.3", "010.0.0.1", "1::2::3", ":1", "1:", "12345::"]) assert.equal(shownAddress(no), null, no);
  assert.equal(shownAddress("::"), "::");
  assert.equal(shownAddress("::ffff:10.0.0.1"), "10.0.0.1");
});

test("MASON_PG_PROXY_FROM: unset or empty reads no header; addresses and CIDRs name the proxy, each family its own", () => {
  assert.equal(parseProxyFrom(undefined), null);
  assert.equal(parseProxyFrom(""), null);
  assert.equal(parseProxyFrom("  "), null);
  const from = parseProxyFrom("10.0.0.0/16, 2001:db8::/32,192.0.2.10") as ProxyFrom;
  assert.deepEqual(from.entries, ["10.0.0.0/16", "2001:db8::/32", "192.0.2.10"]);
  for (const [address, named] of [["10.0.0.1", true], ["10.0.255.254", true], ["10.1.0.1", false], ["192.0.2.10", true], ["192.0.2.11", false],
    ["2001:db8:ffff::1", true], ["2001:db9::1", false], ["::ffff:10.0.0.1", true], ["::ffff:10.1.0.1", false], ["fe80::1%eth0", false]] as const) {
    assert.equal(proxyNames(from, address), named, address);
  }
  assert.equal(proxyNames(parseProxyFrom("10.0.0.0/9") as ProxyFrom, "10.127.255.255"), true, "a prefix inside a byte");
  assert.equal(proxyNames(parseProxyFrom("10.0.0.0/9") as ProxyFrom, "10.128.0.0"), false);
  assert.equal(proxyNames(parseProxyFrom("::1") as ProxyFrom, "::1"), true, "one IPv6 address: /128");
  // an address is what it means, never how it is spelt: a v4-mapped one IS its IPv4 address, both ways
  assert.equal(proxyNames(parseProxyFrom("0.0.0.0/1,2001:db8::/32") as ProxyFrom, "::ffff:127.0.0.1"), true);
  assert.equal(proxyNames(parseProxyFrom("::1:0:0:0/80") as ProxyFrom, "10.0.0.1"), false, "a range beside the v4-mapped block names none of it");
  assert.equal(proxyNames(parseProxyFrom("::/88") as ProxyFrom, "::ffff:1.2.3.4"), false);
});

test("MASON_PG_PROXY_FROM that is not a CIDR list is refused, naming every bad entry, with a did-you-mean where one is a fair guess", () => {
  const problem = (v: string): string => { const r = parseProxyFrom(v); assert.ok(r !== null && "problem" in r, `${v}: ${JSON.stringify(r)}`); return r.problem; };
  assert.equal(problem("10.0.1.5/24"), 'MASON_PG_PROXY_FROM="10.0.1.5/24": "10.0.1.5/24" has bits set past its prefix: did you mean 10.0.1.0/24?');
  assert.match(problem("2001:db8::1/32"), /did you mean 2001:db8::\/32\?/);
  assert.match(problem("nlb.internal"), /"nlb\.internal" is not an address or a CIDR \(10\.0\.0\.0\/16, 2001:db8::\/32, or one address such as 10\.0\.4\.7; a host name is not looked up\)/);
  assert.match(problem("10.0.0.0/33"), /an IPv4 prefix is at most \/32/);
  assert.match(problem("::/129"), /an IPv6 prefix is at most \/128/);
  assert.match(problem("0.0.0.0/0"), /names every address, so any client could claim to be any other/);
  assert.match(problem("::ffff:10.0.0.0/104"), /IPv4 written as IPv6, which Mason reads as IPv4: did you mean 10\.0\.0\.0\/8\?/);
  assert.match(problem("::ffff:10.0.0.9"), /did you mean 10\.0\.0\.9\?/);
  assert.match(problem("::ffff:10.0.0.9/104"), /did you mean 10\.0\.0\.0\/8\?/, "the guess is the network, never an entry refused for its host bits");
  assert.match(problem("10.0.0.0/8,,"), /an empty entry between two commas/);
  assert.match(problem("fe80::1%eth0"), /is not an address or a CIDR/);
  assert.match(problem("10.0.0.0/-1"), /is not an address or a CIDR/);
  const two = problem("10.0.0.0/8,bad,10.0.0.1/8");
  assert.match(two, /^MASON_PG_PROXY_FROM="10\.0\.0\.0\/8,bad,10\.0\.0\.1\/8": "bad" is not an address .*; "10\.0\.0\.1\/8" has bits set past its prefix: did you mean 10\.0\.0\.0\/8\?$/);
});

// THE CLASS: what an entry or a list names is read from its MEANING, the places it covers, never from its spelling
// (review of PR 522: 0.0.0.0/0 was refused and 0.0.0.0/1,128.0.0.0/1, every IPv4 address too, was taken)
test("a list whose entries together name every IPv4 or every IPv6 address is refused, however it is split or spelt; a did-you-mean is never itself refused", () => {
  const problem = (v: string): string => { const r = parseProxyFrom(v); assert.ok(r !== null && "problem" in r, `${v}: ${JSON.stringify(r)}`); return r.problem; };
  for (const every4 of ["0.0.0.0/1,128.0.0.0/1", "128.0.0.0/1, 0.0.0.0/2, 64.0.0.0/2", "0.0.0.0/1,128.0.0.0/2,192.0.0.0/2,10.0.0.0/8",
    "::/64", "::fffe:0:0/95", "::/81,::8000:0:0/81", "0.0.0.0/1,128.0.0.0/1,2001:db8::/32"]) {
    assert.match(problem(every4), /its entries together name every IPv4 address \(0\.0\.0\.0\/0\), so any client could claim to be any other/, every4);
  }
  for (const every6 of ["::/1,8000::/1", "8000::/1,::/2,4000::/2", "::/1,8000::/2,c000::/2"]) {
    assert.match(problem(every6), /every IPv6 address \(::\/0\)/, every6);
  }
  assert.match(problem("::/1,8000::/1"), /every IPv4 address \(0\.0\.0\.0\/0\) and every IPv6 address/, "::/1 holds the v4-mapped addresses: both");
  // all but a sliver is not every address, and is the operator's word
  for (const most of ["0.0.0.0/1,128.0.0.0/2,192.0.0.0/3", "0.0.0.0/1", "8000::/1,4000::/2", "0.0.0.0/1,2001:db8::/32", "::/88"]) {
    assert.ok(!("problem" in (parseProxyFrom(most) as object)), most);
  }
  // a v4-mapped entry's guess is read as an entry first: one that names every address says so, never suggests it
  assert.equal(problem("::ffff:0:0/96"), 'MASON_PG_PROXY_FROM="::ffff:0:0/96": "::ffff:0:0/96" is IPv4 written as IPv6, which Mason reads as 0.0.0.0/0, and "0.0.0.0/0" names every address, so any client could claim to be any other: name the proxy\'s own addresses');
  assert.doesNotMatch(problem("::ffff:0:0/96"), /did you mean/);
  assert.match(problem("::ffff:0:0/129"), /an IPv6 prefix is at most \/128/, "a prefix past the family's is said as such, never turned into an IPv4 guess");
  // every did-you-mean the setting can give is an entry it takes
  for (const v of ["10.0.1.5/24", "2001:db8::1/32", "::ffff:10.0.0.9/104", "::ffff:10.0.0.9", "::ffff:192.168.1.1/120", "::ffff:255.255.255.255/97"]) {
    const guess = /did you mean (\S+)\?/.exec(problem(v))?.[1];
    assert.ok(guess !== undefined, v);
    assert.ok(!("problem" in (parseProxyFrom(guess) as object)), `${v} suggests ${guess}, which is refused`);
  }
});
