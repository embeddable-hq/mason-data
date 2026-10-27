/**
 * A SELF-SIGNED X.509 CERTIFICATE, MADE WITH NODE ALONE (`mason start --self-signed-tls`, src/cli/pg-tls.ts).
 * `node:crypto` generates the key and signs, but has no API that writes a certificate, and the tree has no library that
 * does — so the certificate is DER written here: one shape, no extensions, nothing parsed. RFC 5280 §4.1:
 *
 *   Certificate     ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signature BIT STRING }
 *   TBSCertificate  ::= SEQUENCE { [0] version v3, serialNumber, signature, issuer, validity, subject, subjectPublicKeyInfo }
 *
 * RSA 2048 with SHA-256: the key every TLS client takes (a hosted BI tool's JVM included); ECDSA would do for most.
 * Node's own `X509Certificate` reads it back and verifies its signature (tests/pg-tls.test.ts), and a real handshake
 * against the Postgres listener uses it. What a self-signed certificate gives is ENCRYPTION — a client with
 * `sslmode=require` checks no certificate — never proof of whose server it is: that is a certificate a CA signed.
 */
import * as crypto from "node:crypto";

const tlv = (tag: number, content: Buffer): Buffer => {
  const n = content.length;
  if (n < 0x80) return Buffer.concat([Buffer.from([tag, n]), content]);
  const len: number[] = [];
  for (let m = n; m > 0; m >>= 8) len.unshift(m & 0xff);
  return Buffer.concat([Buffer.from([tag, 0x80 | len.length, ...len]), content]);
};
const seq = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts));

function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split(".").map(Number);
  const bytes = [40 * a! + b!];
  for (const n of rest) {
    const groups: number[] = [];
    for (let m = n; ; m = Math.floor(m / 128)) { groups.unshift(m % 128); if (m < 128) break; }
    bytes.push(...groups.map((g, i) => (i < groups.length - 1 ? g | 0x80 : g)));
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** a positive INTEGER from its big-endian bytes */
const integer = (bytes: Buffer): Buffer => tlv(0x02, bytes[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);

/** UTCTime through 2049, GeneralizedTime from 2050 (RFC 5280 §4.1.2.5) */
function time(d: Date): Buffer {
  const iso = d.toISOString();   // 2026-10-26T12:34:56.789Z
  const digits = iso.slice(0, 19).replace(/[-T:]/g, "");
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${digits.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${digits}Z`));
}

const name = (commonName: string): Buffer => seq(tlv(0x31, seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from(commonName, "utf8")))));

const pem = (label: string, der: Buffer): string =>
  `-----BEGIN ${label}-----\n${der.toString("base64").replace(/.{1,64}/g, "$&\n")}-----END ${label}-----\n`;

export interface SelfSigned { cert: string; key: string }

/** A new RSA key and a certificate for it, signed by itself, valid from an hour ago (a client's clock behind) for
 *  `years`; both PEM. */
export function selfSignedCertificate(commonName: string, o: { now?: Date; years?: number } = {}): SelfSigned {
  const now = o.now ?? new Date();
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const serial = crypto.randomBytes(16);
  serial[0] = (serial[0]! & 0x7f) | 0x40;   // positive, and never a leading zero byte
  const notAfter = new Date(now);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + (o.years ?? 10));
  const sha256WithRsa = seq(oid("1.2.840.113549.1.1.11"), tlv(0x05, Buffer.alloc(0)));
  const tbs = seq(
    tlv(0xa0, integer(Buffer.from([2]))),   // [0] EXPLICIT version: v3
    integer(serial),
    sha256WithRsa,
    name(commonName),
    seq(time(new Date(now.getTime() - 3_600_000)), time(notAfter)),
    name(commonName),
    publicKey.export({ type: "spki", format: "der" }),   // SubjectPublicKeyInfo, as DER already
  );
  const signature = crypto.sign("sha256", tbs, privateKey);   // PKCS#1 v1.5, the algorithm named above
  const der = seq(tbs, sha256WithRsa, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  return { cert: pem("CERTIFICATE", der), key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}
