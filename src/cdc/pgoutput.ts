/**
 * THE `pgoutput` DECODER (protocol version 1): Postgres's built-in logical decoding output, the messages
 * inside the replication stream's XLogData. Pure — a Buffer in, a message out — so every message shape is
 * pinned by tests/cdc-pgoutput.test.ts against bytes built by hand from the protocol reference (Postgres's own documentation):
 * https://www.postgresql.org/docs/current/protocol-logicalrep-message-formats.html
 *
 * Version 1 is enough: no streamed in-progress transactions (the server hands a transaction over only at
 * its commit, which is what makes "acknowledge only complete transactions" simple), no two-phase commit.
 */

/** One column value of a tuple: text, SQL NULL, or a TOASTed value the server left out because it did not change. */
export type TupleValue = { kind: "text"; text: string } | { kind: "null" } | { kind: "unchanged" };

export interface RelationColumn { name: string; typeOid: number; typmod: number; isKey: boolean }

export type PgOutputMessage =
  | { type: "begin"; finalLsn: bigint; commitTime: bigint; xid: number }
  | { type: "commit"; commitLsn: bigint; endLsn: bigint; commitTime: bigint }
  | { type: "relation"; relid: number; namespace: string; name: string; replicaIdentity: string; columns: RelationColumn[] }
  | { type: "insert"; relid: number; tuple: TupleValue[] }
  | { type: "update"; relid: number; oldKey: TupleValue[] | null; tuple: TupleValue[] }
  | { type: "delete"; relid: number; key: TupleValue[] }
  | { type: "truncate"; relids: number[] }
  | { type: "other"; tag: string };

class Cursor {
  private readonly b: Buffer;
  i = 0;
  constructor(b: Buffer) { this.b = b; }
  byte(): string { return String.fromCharCode(this.b[this.i++]!); }
  int8(): number { return this.b.readInt8(this.i++); }
  int16(): number { const v = this.b.readInt16BE(this.i); this.i += 2; return v; }
  int32(): number { const v = this.b.readInt32BE(this.i); this.i += 4; return v; }
  uint32(): number { const v = this.b.readUInt32BE(this.i); this.i += 4; return v; }
  int64(): bigint { const v = this.b.readBigUInt64BE(this.i); this.i += 8; return v; }
  cstr(): string {
    const end = this.b.indexOf(0, this.i);
    if (end < 0) throw new Error("pgoutput: unterminated string");
    const s = this.b.toString("utf8", this.i, end);
    this.i = end + 1;
    return s;
  }
  bytes(n: number): Buffer { const v = this.b.subarray(this.i, this.i + n); this.i += n; return v; }
}

function tuple(c: Cursor): TupleValue[] {
  const n = c.int16();
  const out: TupleValue[] = [];
  for (let k = 0; k < n; k++) {
    const kind = c.byte();
    if (kind === "n") out.push({ kind: "null" });
    else if (kind === "u") out.push({ kind: "unchanged" });
    else if (kind === "t") { const len = c.int32(); out.push({ kind: "text", text: c.bytes(len).toString("utf8") }); }
    else if (kind === "b") throw new Error("pgoutput: a binary column value arrived, but the reader asks for text");
    else throw new Error(`pgoutput: unknown tuple column kind ${JSON.stringify(kind)}`);
  }
  return out;
}

export function decode(data: Buffer): PgOutputMessage {
  const c = new Cursor(data);
  const tag = c.byte();
  switch (tag) {
    case "B": return { type: "begin", finalLsn: c.int64(), commitTime: c.int64(), xid: c.int32() };
    case "C": { c.int8(); return { type: "commit", commitLsn: c.int64(), endLsn: c.int64(), commitTime: c.int64() }; }
    case "R": {
      const relid = c.uint32(), namespace = c.cstr(), name = c.cstr(), replicaIdentity = c.byte();
      const n = c.int16();
      const columns: RelationColumn[] = [];
      for (let k = 0; k < n; k++) {
        const flags = c.int8();
        columns.push({ isKey: (flags & 1) === 1, name: c.cstr(), typeOid: c.uint32(), typmod: c.int32() });
      }
      return { type: "relation", relid, namespace, name, replicaIdentity, columns };
    }
    case "I": { const relid = c.uint32(); expect(c.byte(), "N", "insert"); return { type: "insert", relid, tuple: tuple(c) }; }
    case "U": {
      const relid = c.uint32();
      let marker = c.byte();
      let oldKey: TupleValue[] | null = null;
      if (marker === "K" || marker === "O") { oldKey = tuple(c); marker = c.byte(); }
      expect(marker, "N", "update");
      return { type: "update", relid, oldKey, tuple: tuple(c) };
    }
    case "D": {
      const relid = c.uint32();
      const marker = c.byte();
      if (marker !== "K" && marker !== "O") throw new Error(`pgoutput: delete carries ${marker}, expected K or O`);
      return { type: "delete", relid, key: tuple(c) };
    }
    case "T": {
      const n = c.int32();
      c.int8(); // options: CASCADE / RESTART IDENTITY
      const relids: number[] = [];
      for (let k = 0; k < n; k++) relids.push(c.uint32());
      return { type: "truncate", relids };
    }
    // Origin, Type and logical decoding messages carry nothing the reader stores
    default: return { type: "other", tag };
  }
}

function expect(got: string, want: string, what: string): void {
  if (got !== want) throw new Error(`pgoutput: ${what} carries ${JSON.stringify(got)} where ${want} was expected`);
}
