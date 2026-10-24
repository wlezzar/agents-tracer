// How the viewer writes durations, token counts, times, and excerpts. These differ from the text
// report's (src/util): a missing value is an en dash, and dates are the browser's short ones.

/** A duration: `4.2s`, `42s`, `4m02s`, `4h02m`; `–` for a missing one. */
export function fmt(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return '–';
  if (ms < 9950) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  const m = Math.round(s / 60);
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

/** A token count: `950`, `1.2k`, `3.4M`; `–` for a missing one. */
export function kTok(n: number | null | undefined): string {
  if (n == null) return '–';
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}

/** A size in bytes: `12K`, or `3.4M` from a megabyte. */
export function bytes(n: number): string {
  const k = Math.round(n / 1024);
  return k >= 1024 ? `${(n / (1024 * 1024)).toFixed(1)}M` : `${k}K`;
}

export function two(n: number): string {
  return String(n).padStart(2, '0');
}

/** A local time of day, `14:05:09`, or `14:05` without seconds. */
export function clock(t: number, secs = true): string {
  const d = new Date(t);
  return `${two(d.getHours())}:${two(d.getMinutes())}${secs ? `:${two(d.getSeconds())}` : ''}`;
}

/** A local date in the browser's short form, such as `Mar 14`. */
export function dayStr(t: number): string {
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** A time as the viewer shows it: with its date when the session spans days; `–` for a missing one. */
export function stamp(t: number | null | undefined, multiDay: boolean): string {
  if (t == null) return '–';
  return multiDay ? `${dayStr(t)} ${clock(t)}` : clock(t);
}

/** Whether two times fall on different local days. */
export function spansDays(t0: number, t1: number): boolean {
  return new Date(t0).toDateString() !== new Date(t1).toDateString();
}

/** `a` as a share of `b`, `42%`; `–` when `b` is not positive. */
export function pct(a: number, b: number | null | undefined): string {
  return b != null && b > 0 ? `${Math.round((100 * a) / b)}%` : '–';
}

/** A text on one line, whitespace collapsed, cut to `n` characters with an ellipsis. */
export function oneLine(s: string | null | undefined, n = 140): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** The text with its first letter capitalized. */
export function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
