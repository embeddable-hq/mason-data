/**
 * THE PROJECT'S GENERATED TABLES (issue 124): a folder beside the sources file, one file per table, the project's to
 * commit and review. The file's name is the table's: `requests.yml` is `public.requests`, `reports.daily.yml` is
 * `reports.daily`.
 *
 *   kind: scheduled               what the table promises: `scheduled` (any SELECT, up to target_lag behind its base)
 *   target_lag: 5m                how far behind it may be
 *   sql: |                        what it holds
 *     SELECT tenant_id, count(*) AS requests FROM events GROUP BY 1
 *   order_by: tenant_id           optional: what follows ORDER BY, over its columns, one SQL string
 *   comment: Requests per tenant. optional: COMMENT ON TABLE
 *
 * Read here for its shape alone: each mistake at its key, with the reason and the way out, all of a file's at once. What
 * its SQL means is the catalog's to say (src/duck/generated-plan.ts). A mistake never stops the run or another table,
 * unlike a sources file's: a table already deployed keeps serving what it was built from (src/duck/generated.ts).
 *
 * `GENERATED_KEYS` is the one list of keys: a key the reader takes and the guide says (`mason help generated`), so neither
 * can name one the other does not.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseDocument } from "yaml";
import { didYouMean } from "../lib/did-you-mean.ts";
import { parseLag } from "../lib/table-sync.ts";
import { shownPath, tableNameProblem } from "./sources.ts";
import type { GeneratedDefinition, GeneratedFileRefused, GeneratedRead } from "../duck/generated.ts";
import type { GeneratedRefusal } from "../duck/generated-plan.ts";

/** Where a project's generated tables are: `<folder>/generated_tables/`, beside `sources/`. */
export const GENERATED_DIR = "generated_tables";
export const generatedDir = (folder: string): string => path.join(folder, GENERATED_DIR);

/** Every key a file takes, and what it says, as a person reads it. */
export const GENERATED_KEYS = {
  kind: "required: how the table stays current. scheduled: any SELECT, up to target_lag behind its base. live is not available yet",
  sql: "required: the one SELECT that gives the table, over the tables the sources file syncs",
  target_lag: "required for scheduled: how far behind its base it may be, like 30s, 5m or 1h (at least 1s, at most 24h). Mason looks at each table every 5s, so a table under 5s can be up to 5s behind",
  order_by: "optional: the table's rows are written in this order, as what follows ORDER BY, over its columns, one SQL string",
  comment: "optional: the table's comment, as COMMENT ON TABLE",
} as const;

const KEYS = Object.keys(GENERATED_KEYS);
const LIVE_WHY = "A table kept current in its base's own write isn't built yet, and Mason never runs a table as another kind than its file says.";

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const refusal = (key: string | null, message: string, options: string[] = [], why: string | null = null): GeneratedRefusal => ({ key, message, why, options });

/** The file's text read as a definition, or everything wrong with it. */
export function parseGeneratedText(text: string, name: { schema: string; table: string }, file: string): GeneratedDefinition | GeneratedFileRefused {
  const at = { name: `${name.schema}.${name.table}`, schema: name.schema, table: name.table, file };
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) return { ...at, kind: null, refusals: [refusal(null, `it is not YAML: ${doc.errors[0]!.message.split("\n")[0]}`)] };
  const v: unknown = doc.toJS();
  if (!isPlain(v)) return { ...at, kind: null, refusals: [refusal(null, `it is ${v === null || v === undefined ? "empty" : "not a mapping"}`, ["write kind: scheduled, target_lag: 5m and sql: SELECT …"])] };
  const refusals: GeneratedRefusal[] = [];
  for (const k of Object.keys(v)) if (!KEYS.includes(k)) refusals.push(refusal(k, `is not a key${didYouMean(k, KEYS)}`, [`a generated table takes ${KEYS.join(", ")}`]));
  const kind = typeof v.kind === "string" ? v.kind : null;
  const lagWritten = v.target_lag !== undefined;
  const lag = lagWritten ? parseLag(v.target_lag) : null;
  if (v.kind === undefined || v.kind === null) refusals.push(refusal("kind", "is missing", ["write kind: scheduled with a target_lag, e.g. target_lag: 5m"], "Mason never decides how a table stays current for you."));
  else if (kind === "live") {
    refusals.push(refusal("kind", "live isn't available yet", ["set kind: scheduled with a target_lag, e.g. target_lag: 5m"], LIVE_WHY));
    if (lagWritten) refusals.push(refusal("target_lag", "contradicts kind: live", ["remove target_lag", "or set kind: scheduled"], "A live table is as fresh as its base, so it has no lag to choose."));
  } else if (kind !== "scheduled") refusals.push(refusal("kind", `${String(v.kind)} is not a kind${kind === null ? "" : didYouMean(kind, ["live", "scheduled"])}`, ["write kind: scheduled with a target_lag, e.g. target_lag: 5m"]));
  else if (!lagWritten) refusals.push(refusal("target_lag", "is missing", ["write how stale is acceptable, e.g. target_lag: 5m"], "A scheduled table may lag its base, so its file says by how much."));
  if (lag !== null && "problem" in lag) refusals.push(refusal("target_lag", lag.problem));
  const text1 = (key: string): string | null => {
    const x = v[key];
    if (x === undefined) return null;
    if (typeof x === "string" && x.trim() !== "") return x;
    refusals.push(refusal(key, key === "order_by" ? "is one SQL string, as after ORDER BY" : "is empty or not text", key === "order_by" ? ["write order_by: day, tenant_id: a list would split on the commas inside an expression"] : []));
    return null;
  };
  const sql = text1("sql");
  if (v.sql === undefined) refusals.push(refusal("sql", "is missing", ["write sql: | and the SELECT that gives the table"]));
  const orderBy = text1("order_by"), comment = text1("comment");
  if (refusals.length > 0 || sql === null || lag === null || "problem" in lag) return { ...at, kind, refusals };
  return { ...at, sql, orderBy: orderBy?.trim() ?? null, targetLag: lag, comment };
}

/** a file's name as the table it names: `requests.yml`, `reports.daily.yml`; or why it names none */
function tableOfFile(file: string): { schema: string; table: string } | string {
  const name = file.replace(/\.ya?ml$/, "");
  const bad = tableNameProblem(name);
  if (bad !== null) return bad;
  const dot = name.indexOf(".");
  const schema = dot < 0 ? "public" : name.slice(0, dot), table = dot < 0 ? name : name.slice(dot + 1);
  if (schema === "_mason" || schema === "information_schema" || schema.startsWith("pg_") || table.startsWith("pg_") || table.includes("__mason")) return `${name} is a name Postgres or Mason keeps for itself`;
  return { schema, table };
}

/** The folder as it is now: every definition in shape, and every file refused. A folder that is not there holds none. */
export function readGenerated(folder: string, root: string): GeneratedRead {
  const dir = generatedDir(folder);
  let names: string[];
  try { names = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f) && !f.startsWith(".")).sort(); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { definitions: [], refused: [] };
    throw e;
  }
  const out: GeneratedRead = { definitions: [], refused: [] };
  const seen = new Map<string, string>();
  for (const name of names) {
    const full = path.join(dir, name), shown = shownPath(root, full);
    const stem = name.replace(/\.ya?ml$/, "");
    const t = tableOfFile(name);
    if (typeof t === "string") {
      const dot = stem.indexOf(".");
      out.refused.push({ name: dot < 0 ? `public.${stem}` : stem, schema: dot < 0 ? "public" : stem.slice(0, dot), table: dot < 0 ? stem : stem.slice(dot + 1), file: shown, kind: null, refusals: [refusal(null, t, ["rename the file: its name is the table's"])] });
      continue;
    }
    const table = `${t.schema}.${t.table}`, before = seen.get(table);
    if (before !== undefined) {
      out.refused.push({ name: table, ...t, file: shown, kind: null, refusals: [refusal(null, `names the table ${table}, as ${before} does`, ["keep one"])] });
      continue;
    }
    seen.set(table, shown);
    let text: string;
    try { text = fs.readFileSync(full, "utf8"); }
    catch (e) { out.refused.push({ name: table, ...t, file: shown, kind: null, refusals: [refusal(null, `it cannot be read: ${(e as Error).message}`)] }); continue; }
    const read = parseGeneratedText(text, t, shown);
    if ("refusals" in read) out.refused.push(read); else out.definitions.push(read);
  }
  return out;
}
