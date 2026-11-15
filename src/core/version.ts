// Comparing the version numbers of Locus and of the plugin Claude Code keeps for it. They are not
// always equal and "different" is not "older": Claude Code updates its own copy of the plugin the
// moment a release is published, which can be well before this app is reinstalled.

/** Negative if a is older than b, 0 if the same, positive if a is newer. Missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[.+-]/).map((p) => parseInt(p, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}
