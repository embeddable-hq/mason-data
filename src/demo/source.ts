// A PLACEHOLDER for the demo database, replaced at merge by the real module built on another branch: its contract alone.
export const DEMO_DATABASE = "demo";
export const DEMO_USER = "demo";

/** `postgres://demo@127.0.0.1:<port>/demo` */
export function demoUrl(port: number): string {
  return `postgres://${DEMO_USER}@127.0.0.1:${port}/${DEMO_DATABASE}`;
}

const STUB = "stub: the demo source is built on another branch";

export class DemoSource {
  /** boots PGlite at `dir` (made if absent), seeds the schema at the folder's first open, listens on 127.0.0.1:`port`
   *  (throws an Error naming the port when it is held); `log` gets one line per notable event */
  static open(o: { dir: string; port: number; log: (line: string) => void }): Promise<DemoSource> {
    void o;
    return Promise.reject(new Error(STUB));
  }
  get port(): number { throw new Error(STUB); }
  get url(): string { throw new Error(STUB); }
  get seeded(): boolean { throw new Error(STUB); }
  /** one round of changes (a new order with its items, an older order's status moved on): what it did, one line */
  change(): Promise<string> { return Promise.reject(new Error(STUB)); }
  /** ends every connection, the listener and PGlite, its data flushed to `dir`; idempotent */
  close(): Promise<void> { return Promise.reject(new Error(STUB)); }
}
