/**
 * ONE TABLE IN THE SYNCED DATA, WHATEVER ITS SPELLING (issue 996). DuckDB stores and finds a schema's and a table's name
 * without regard to ASCII case: `"public"."Gdup"` and `public.gdup` are one table there, and a DROP of one drops the
 * other (a letter outside ASCII keeps its case: `"Égal"` and `"égal"` are two). So whether two names are one table (a
 * synced table's and a generated table's, two generated files') is decided by this key alone, never by comparing the
 * names as written. A column's name is held by the same rule (issue 1019): `"U"` and `u` are one column there, so two
 * columns of one table, or of one generated table's SELECT, are told apart by this key too (`caseClashes`).
 */
export function relationKey(name: string): string { return name.replace(/[A-Z]/g, (c) => c.toLowerCase()); }

/**
 * THE NAMES THE SYNCED DATA WOULD TAKE FOR ONE (issue 1019): each group of two or more of `names` that share a
 * `relationKey`, in the order the names come, the groups in the order their first name comes. The engine holds a
 * column's name by the same rule as a table's, so a table with columns `"U"` and `u` cannot be synced (its first sync
 * failed for ever with `Column with name "u" already exists`), and two tables `"Orders"` and `orders` would be one. A
 * check that two names are one in the synced data asks this or `relationKey`, never a comparison of their spellings.
 */
export function caseClashes(names: readonly string[]): string[][] {
  const groups = new Map<string, string[]>();
  for (const n of names) {
    const k = relationKey(n);
    const g = groups.get(k);
    if (g === undefined) groups.set(k, [n]);
    else if (!g.includes(n)) g.push(n);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}
