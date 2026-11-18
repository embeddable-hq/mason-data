/**
 * MASON'S HIDDEN COLUMNS IN A SYNCED TABLE (issue 998). Mason adds columns of its own to a synced table: a stored JSON
 * path's (`__mason_json_…`, src/duck/kept-route.ts `hiddenName`), a plain numeric's scale (`__mason_scale_…`,
 * src/duck/scale-column.ts) and a reference's key number (`__mason_ref_…`, src/duck/reference-keys.ts). A source table may name a column anything, those names included, in any case.
 *
 * So a column is hidden only when the ledger's record of the copy does not name it: the source columns the copy holds,
 * as recorded at its swap (`_mason.copy_state.columns`), or for a copy in progress its side table's
 * (`_mason.copy_progress.columns`). A name's pattern only tells which kind of hidden column it is, and only among the
 * columns the record leaves out. Never decide by the pattern alone: a source column named like a stored path's column
 * was dropped at the next start, its values lost, and its table's poll and the whole stream stopped.
 *
 * The one module that tells a synced table's hidden columns from its source columns. Every place that decides whether a
 * column is hidden, to read, drop, hide, add or fill it, asks it. One place rewords by the pattern and decides nothing:
 * src/duck/store.ts `pgErrorOf`, whose Binder error says "a numeric's scale" for a quoted scale column's name.
 */
import { HIDDEN_RE } from "./kept-route.ts";
import { SCALE_RE } from "./scale-column.ts";
import { NUMBER_RE } from "./reference-keys.ts";

/** what a hidden column holds: a stored JSON path, a plain numeric's scale, a reference's key number, or something this
 *  Mason does not know */
export type HiddenKind = "json" | "scale" | "number" | "unknown";

/** whether `columns` (a copy's recorded source columns) name `name`, compared as the engine compares names: case-insensitively */
export function sourceHas(columns: readonly string[], name: string): boolean {
  const n = name.toLowerCase();
  return columns.some((c) => c.toLowerCase() === n);
}

/** the columns of a synced table (`physical`, in its order) that its recorded source columns (`recorded`) do not name,
 *  each with its kind */
export function hiddenColumns(physical: readonly string[], recorded: readonly string[]): Array<{ name: string; kind: HiddenKind }> {
  return physical.filter((c) => !sourceHas(recorded, c)).map((name) => ({ name, kind: HIDDEN_RE.test(name) ? "json" : SCALE_RE.test(name) ? "scale" : NUMBER_RE.test(name) ? "number" : "unknown" }));
}

/** the columns of a synced table (`physical`, in its order) that a statement lists: its recorded source columns' */
export function visibleColumns(physical: readonly string[], recorded: readonly string[]): string[] {
  return physical.filter((c) => sourceHas(recorded, c));
}
