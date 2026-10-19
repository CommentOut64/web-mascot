/** Allocate a complete idle cycle to a budget. Unmarked poses are immutable;
 * marked waits keep at least one tick. Largest remainders preserve the exact sum. */
export function idlePoseTicks(durations: number[], waits: number[], budget: number): number[] | null {
  if (!durations.length || !waits.length || waits.some((i) => i < 0 || i >= durations.length)) return null;
  const indices = [...new Set(waits)];
  const result = durations.map((duration) => Math.max(1, duration));
  const fixed = result.reduce((sum, ticks, i) => sum + (indices.includes(i) ? 0 : ticks), 0);
  const remaining = Math.max(indices.length, Math.round(budget) - fixed) - indices.length;
  const weights = indices.map((i) => Math.max(1, result[i] - 1));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const shares = weights.map((weight) => remaining * weight / total);
  indices.forEach((index, i) => { result[index] = 1 + Math.floor(shares[i]); });
  const order = shares.map((share, i) => ({ i, remainder: share - Math.floor(share) }))
    .sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  const extra = remaining - shares.reduce((sum, share) => sum + Math.floor(share), 0);
  for (let i = 0; i < extra; i++) result[indices[order[i].i]]++;
  return result;
}
