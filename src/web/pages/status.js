/**
 * THE STATUS PAGE (#status): what `mason status` prints — the database, each added table's copy (its bar, its percent
 * and the line `mason wait` shows), the warnings, the slow and refused counts, and readiness. Reads `/api/state` every
 * poll and the request log's counts every 30 s. Never the engine's name.
 */
import { code, esc, firstLine, n, percent, leftText, duration, entryName, rowsHtml } from "../shared.js";

const POLL_MS = 2000;

/**
 * What a copying table's line says, and how full its bar is: src/cli/readiness.ts `copyingText`, line for line, so the
 * page and `mason status` say one thing (tests/web-page.test.ts holds the two equal).
 */
export function copyingText(copied, rowsEstimate, p) {
  const shown = copied + (p?.rowsReading ?? 0);
  const estimate = rowsEstimate !== null && rowsEstimate > 0 ? rowsEstimate : null;
  const past = estimate !== null && shown > estimate;
  const fraction = p !== undefined ? p.share : estimate === null ? null : Math.min(0.99, shown / estimate);
  const of = estimate === null ? "" : past ? ` · past the ~${n(estimate)} estimated` : ` of ~${n(estimate)}`;
  const rowsText = (k) => past ? `${n(k)} rows${of}` : `${n(k)}${of} rows`;
  if (p === undefined) return { fraction, text: rowsText(copied) };
  const since = p.readingSeconds === null ? "" : ` (${duration(p.readingSeconds)})`;
  const chunks = (k) => `${k} chunk${k === 1 ? "" : "s"}`;
  if (p.rowsPerSecond === null) {
    const first = p.reading === 0 ? "about to read the first chunk" : `reading the first ${p.reading === 1 ? "chunk" : chunks(p.reading)}${since}`;
    return { fraction, text: copied === 0 ? `${first}${estimate === null ? "" : ` · ~${n(estimate)} rows to copy`}` : `${rowsText(copied)} · resumed, ${first}` };
  }
  const parts = [rowsText(shown)];
  const allIn = p.reading === 0 && p.chunksDone >= p.chunksTotal;
  if (allIn) parts.push(`every chunk read (${p.chunksDone}): checking it and swapping it in`);
  else parts.push(`${p.reading === 0 ? "starting the next chunk" : `${chunks(p.reading)} reading${since}`}, ${p.chunksDone} of ~${p.chunksTotal} in`);
  parts.push(`${n(Math.round(p.rowsPerSecond))} rows/s`);
  if (!allIn && p.secondsLeft !== null) parts.push(leftText(p.secondsLeft));
  return { fraction, text: parts.join(" · ") };
}

/**
 * AN ADDED TABLE'S LINE, as `mason status` and `mason wait` print it after its bar (src/cli/commands.ts `tableLines`):
 * its state (done, unsynced, failed, copying, waiting), how full its bar is, and what it says.
 */
export function tableLine(t) {
  if (t.error) return { state: "failed", fraction: 1, what: `its copy failed: ${firstLine(t.error)}` };
  if (t.copy?.phase === "copying") {
    const c = copyingText(t.copy.rowsCopied, t.rows, t.copy.progress);
    return { state: "copying", fraction: c.fraction ?? 0, what: /^\d/.test(c.text) ? `copying ${c.text}` : c.text };
  }
  if (!t.copy) return { state: "waiting", fraction: 0, what: "waiting for its copy to start" };
  if (t.unsynced) {
    return { state: "unsynced", fraction: 1, what: `${n(t.copy.rowsCopied ?? 0)} rows · copied, NOT kept current (${t.unsynced.reason}${t.unsynced.asOf ? `; as of ${t.unsynced.asOf.slice(0, 16).replace("T", " ")} UTC` : ""}) — mason sync ${entryName(t.table)}, or mason start --replication` };
  }
  return { state: "done", fraction: 1, what: `${n(t.copy.rowsCopied ?? 0)} rows · copied${t.copy.retired ? ` · ${t.copy.retired}` : ""}` };
}

/** `mason status`'s rows for the database (src/cli/commands.ts `sourceRows`): its sources file, its URL as the run masked it, how its changes arrive. */
export function sourceRows(s) {
  return [
    ...(s.source.file ? [["Source", `${s.source.file} (the tables it names are added)`]] : []),
    ["Database", s.source.demo ? `the demo database Mason hosts (${s.source.url} · Postgres ${s.source.version})`
      : `${s.source.url} · Postgres ${s.source.version}${s.source.standby ? " · a read replica" : ""}`],
    ["Changes", s.source.replication ? `logical replication: slot ${s.source.replication.slot}, publication ${s.source.replication.publication} ` +
        `(${s.source.replication.owned ? "Mason's own" : "named: read as it is, never altered"}) · mason start --poll goes back to polling`
      : `polling with SELECTs (xmin), every ${s.engine.pollSeconds} s · ${s.source.demo ? "the demo database is read by polling only" : "mason start --replication reads the database's change log instead"}`],
  ];
}

/** How many of `xs` were in the last day, or why they could not be read. */
const countLine = (label, r, count, tail) => "failure" in r
  ? `<p class="count">${esc(label)}: could not read them (${esc(firstLine(r.failure.message))}; ${code("mason logs")} has the detail)</p>`
  : `<p class="count">${esc(label)}: <strong>${n(count(r))}</strong> in the last day${tail(r)}</p>`;

/**
 * THE STATUS SECTION from `/api/state` (and the counts of `/api/slow`, `/api/refused`; each `{ failure }` when it could
 * not be read): what `mason status` prints — the database, each added table's copy (its bar, percent and the line
 * `mason wait` shows), the warnings, the slow and refused counts, and readiness. Never the engine's name.
 */
export function renderStatus(s, requests = {}) {
  const parts = [rowsHtml([...sourceRows(s), ...s.warnings.map((w) => ["Warning", w])])];
  const picked = s.tables.filter((t) => t.added);
  if (!picked.length) {
    parts.push(`<p class="readiness">No table added yet (${n(s.tables.length)} in the database).</p>`,
      `<p class="dim">${code("mason tables")} lists them; ${code("mason add <table>")} copies one.</p>`);
    return parts.join("");
  }
  // as tableLines orders them: the finished first, in the order they finished, then the failed, the copying, the waiting
  const rank = { done: 0, unsynced: 0, failed: 1, copying: 2, waiting: 3 };
  const lines = picked.map((t) => ({ t, l: tableLine(t) }))
    .sort((a, b) => rank[a.l.state] - rank[b.l.state] || (a.t.copy?.updatedAt ?? "").localeCompare(b.t.copy?.updatedAt ?? "") || a.t.table.localeCompare(b.t.table));
  parts.push(`<h3>Tables (${picked.length} of ${s.tables.length} added)</h3>`,
    `<table class="tables"><thead><tr><th scope="col">Table</th><th scope="col">Copy</th><th scope="col"></th></tr></thead><tbody>${lines.map(({ t, l }) =>
      `<tr class="t-${l.state}"><th scope="row">${code(t.table)}</th>` +
      `<td class="bar"><progress max="100" value="${Math.floor(Math.max(0, Math.min(1, l.fraction)) * 100)}"></progress> <span class="pct">${percent(l.fraction)}</span></td>` +
      `<td class="what">${esc(l.what)}${t.error && t.error.includes("\n") ? `<details><summary>the whole error</summary><pre>${esc(t.error)}</pre></details>` : ""}</td></tr>`).join("")}</tbody></table>`);
  if (requests.slow) parts.push(countLine("Slow queries", requests.slow, (r) => r.slow.length, (r) => ` (${n(r.slowMs / 1000)} s or more)`));
  if (requests.refused) parts.push(countLine("Refused queries", requests.refused, (r) => r.total ?? r.refused.length, () => ""));
  if (requests.slow || requests.refused) parts.push(`<p class="dim">${code("mason status")} lists them; ${code("mason logs --requests")} every one.</p>`);
  const r = s.readiness;
  if (r) {
    if (r.ready) parts.push(`<p class="readiness ok">Ready: every added table is copied and served.</p>`);
    else if (r.failed.length) parts.push(`<p class="readiness bad">Failed:</p><ul class="bullets">${r.failed.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`);
    else parts.push(`<p class="readiness">Under way:</p><ul class="bullets">${r.waiting.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`);
  }
  return parts.join("");
}

/** A read as `renderStatus` takes it: the body, or `{ failure }` when it could not be read; undefined before any read. */
const asRequest = (r) => r === undefined ? undefined : r.failure ? { failure: r.failure } : r.body;

export const page = {
  id: "status",
  title: "Status",
  create(ctx) {
    return {
      reads: () => [{ path: "/api/state", everyMs: POLL_MS }, { path: "/api/slow", everyMs: 30_000 }, { path: "/api/refused", everyMs: 30_000 }],
      actions: {},
      view() {
        const st = ctx.read("/api/state");
        const requests = { slow: asRequest(ctx.read("/api/slow")), refused: asRequest(ctx.read("/api/refused")) };
        return { status: st?.body ? renderStatus(st.body, requests) : st?.failure ? "" : `<p class="dim">Asking Mason…</p>` };
      },
    };
  },
};
