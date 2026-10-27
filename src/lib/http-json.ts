/**
 * HTTP servers' shared plumbing: read a request body with a size cap, and write a JSON reply. Here the
 * run's command server reads it (src/cli/run-server.ts). In the ClickHouse stack this was cut from, its
 * Query API and its web UI each once held a copy; what differs between servers is a parameter
 * here, not a second copy — that API answered an oversized body with its own 413 error class and sent
 * CORS headers, the web UI did neither.
 */
import type * as http from "node:http";

/** The request body as UTF-8, rejected with `tooLarge(message)` once it passes `maxBytes`. */
export function readBody(
  req: http.IncomingMessage, maxBytes: number,
  tooLarge: (message: string) => Error = (m) => new Error(m),
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(tooLarge(`body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}
