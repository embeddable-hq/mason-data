/** A word as the shell reads it back: bare when it is safe, else single-quoted (the `mason …` lines the CLI and the API print). */
export function shellWord(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}
