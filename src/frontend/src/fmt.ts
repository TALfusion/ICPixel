/** Format e8s (bigint or number) as a human-readable ICP string.
 *  Shows up to 4 fractional digits, strips trailing zeros.
 *  Examples: 100_000_000n → "1", 150_000n → "0.0015", 0n → "0" */
export function fmtIcp(e8s: bigint | number): string {
  const v = typeof e8s === "number" ? BigInt(Math.round(e8s)) : e8s;
  if (v === 0n) return "0";
  const whole = v / 100_000_000n;
  const frac = v % 100_000_000n;
  if (frac === 0n) return `${whole}`;
  const fracStr = frac.toString().padStart(8, "0").slice(0, 4).replace(/0+$/, "");
  return fracStr.length > 0 ? `${whole}.${fracStr}` : `${whole}`;
}

/** Format e8s as approximate USD given a micro-rate (usd_per_icp × 1e6). */
export function fmtUsd(e8s: bigint, microRate: bigint): string {
  if (microRate === 0n) return "$?";
  const usdMicro = (e8s * microRate) / 100_000_000n;
  const dollars = Number(usdMicro) / 1_000_000;
  return `$${dollars.toFixed(2)}`;
}
