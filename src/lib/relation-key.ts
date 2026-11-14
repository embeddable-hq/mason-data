/**
 * ONE TABLE IN THE SYNCED DATA, WHATEVER ITS SPELLING (issue 996). DuckDB stores and finds a schema's and a table's name
 * without regard to ASCII case: `"public"."Gdup"` and `public.gdup` are one table there, and a DROP of one drops the
 * other (a letter outside ASCII keeps its case: `"Égal"` and `"égal"` are two). So whether two names are one table (a
 * synced table's and a generated table's, two generated files') is decided by this key alone, never by comparing the
 * names as written.
 */
export function relationKey(name: string): string { return name.replace(/[A-Z]/g, (c) => c.toLowerCase()); }
