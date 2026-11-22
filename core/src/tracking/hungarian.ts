/**
 * Minimum-cost assignment (Hungarian / Kuhn-Munkres). cost is rows x cols (any shape).
 * Returns pairs [row, col]; callers filter by their own threshold.
 */
export function hungarian(cost: number[][], rows: number, cols: number): [number, number][] {
  if (!rows || !cols) return [];
  const transposed = rows > cols;
  const n = transposed ? cols : rows;
  const m = transposed ? rows : cols;
  const a = (i: number, j: number): number => (transposed ? cost[j]![i]! : cost[i]![j]!);
  const INF = 1e18;
  const u = new Array(n + 1).fill(0), v = new Array(m + 1).fill(0);
  const p = new Array(m + 1).fill(0), way = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(m + 1).fill(INF);
    const used = new Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF, j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = a(i0 - 1, j - 1) - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const out: [number, number][] = [];
  for (let j = 1; j <= m; j++) if (p[j]) out.push(transposed ? [j - 1, p[j] - 1] : [p[j] - 1, j - 1]);
  return out;
}
