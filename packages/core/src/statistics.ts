type Money = number | null;
export function cents(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid_integer_cents");
  return BigInt(value);
}
function round(n: bigint, d: bigint): number {
  const result = (2n * n + d) / (2n * d);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("amount_out_of_range");
  return Number(result);
}
export function distribution(values: readonly number[]) {
  const prices = values.map(cents).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    n = prices.length;
  const q = (num: number, den: number): Money => {
    if (n < 8) return null;
    const h = BigInt(n - 1) * BigInt(num),
      d = BigInt(den),
      i = Number(h / d),
      rem = h % d;
    const lower = prices[i],
      upper = prices[Math.min(i + 1, n - 1)];
    if (lower === undefined || upper === undefined) throw new Error("quantile_index_out_of_range");
    return round(lower * (d - rem) + upper * rem, d);
  };
  const k = Math.floor(n / 20),
    kept = prices.slice(k, n - k);
  return {
    median_cents: q(1, 2),
    p25_cents: q(1, 4),
    p75_cents: q(3, 4),
    trimmed_mean_cents:
      n < 8
        ? null
        : round(
            kept.reduce((sum, p) => sum + p, 0n),
            BigInt(kept.length),
          ),
    observed_min_cents: n ? Number(prices[0]) : null,
    observed_max_cents: n ? Number(prices[n - 1]) : null,
  };
}
