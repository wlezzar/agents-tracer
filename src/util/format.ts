// Number formatting for the text report. The viewer's client has its own copies, which differ in
// small ways (an en dash for a missing value), so it does not import these.

/**
 * A duration, rounded to what a person compares: `4.2s` under 9.95 seconds, then `12s`, `3m07s`,
 * and `1h05m`. A missing or NaN duration is `-`.
 */
export function fmt(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return '-';
  if (ms < 9950) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  const m = Math.round(s / 60);
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

/** `part` as a whole percentage of `whole`, such as `42%`; `-` when `whole` is not positive. */
export function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((100 * part) / whole)}%` : '-';
}

/** A token count: `950`, `12.3k`, `1.2M`. */
export function kTok(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}

/** `n` padded to two digits with a leading zero. */
export function two(n: number): string {
  return String(n).padStart(2, '0');
}
