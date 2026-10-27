/**
 * "DID YOU MEAN …?" (the CLI's errors must be as clear as they can be — a coding agent fixes a file
 * from the message alone). The closest of `candidates` to a name that is not one of them: a different case, a typo
 * of a letter or two (edit distance, transpositions counted once), or a name it is the start of. Null when nothing is
 * close enough to be a fair guess: a wrong suggestion is worse than none. Dependency-free.
 */

/** Optimal-string-alignment distance: insertions, deletions, substitutions and adjacent swaps, each 1. */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]!;
}

/** The candidate `name` most likely meant, or null. */
export function closest(name: string, candidates: Iterable<string>): string | null {
  const lower = name.toLowerCase();
  let best: string | null = null, bestScore = Infinity;
  for (const c of new Set(candidates)) {
    if (c === name) continue;
    const cl = c.toLowerCase();
    // a different case, or one is the start of the other (`created` for `created_at`, `metric` for `metrics`)
    const score = cl === lower ? 0 : (cl.startsWith(lower) || lower.startsWith(cl)) && Math.min(cl.length, lower.length) >= 3 ? 1 : editDistance(lower, cl);
    if (score < bestScore) { best = c; bestScore = score; }
  }
  // a typo is a letter or two, never a third of the word
  const allowed = Math.max(1, Math.min(2, Math.floor(name.length / 3)));
  return best !== null && bestScore <= allowed ? best : null;
}

/** ` — did you mean \`x\`?`, or "" when nothing is close. */
export function didYouMean(name: string, candidates: Iterable<string>): string {
  const c = closest(name, candidates);
  return c === null ? "" : ` — did you mean \`${c}\`?`;
}
