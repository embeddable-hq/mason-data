/**
 * Exits once everything written has reached the reader. On a pipe, stdout and stderr can be asynchronous (macOS; Linux
 * once a pipe is full) and process.exit drops what is still queued: `mason status --json | jq` read 65,536 bytes of
 * 138,668 (#435), and bootstrap's last lines — its FAIL lines and the verdict the service reads a failed step's reason
 * from — could be cut the same way. One exit for every process whose output a parent reads (tests/conventions.test.ts).
 */
export function exitWhenWritten(code: number): void {
  const streams = [process.stdout, process.stderr];
  let waiting = streams.length;
  for (const s of streams) {
    let settled = false;
    const done = (): void => { if (settled) return; settled = true; if (--waiting === 0) process.exit(code); };
    // a reader that went away (EPIPE: `mason status --json | head -c 100`) can take nothing more, so there is nothing
    // left to wait for on that stream; the exit code stays the process's
    s.on("error", done);
    s.write("", done);
  }
}
