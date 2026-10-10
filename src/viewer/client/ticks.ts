import { clock, dayStr } from './format.js';
import type { Scale } from './timeMap.js';

// The time axis's ticks: a step that leaves at least 80 pixels between ticks, local round times in
// the shown pieces that are not collapsed, at least 64 pixels apart.

export const STEPS = [
  1e3, 2e3, 5e3, 10e3, 15e3, 30e3, 60e3, 120e3, 300e3, 600e3, 900e3, 1800e3, 3600e3, 7200e3, 10800e3, 21600e3, 43200e3,
  86400e3,
] as const;

export interface Tick {
  readonly x: number;
  readonly label: string;
}

/** The ticks of the scale's window; a local midnight reads as its date when the session spans days. */
export function ticks(scale: Scale, multiDay: boolean): Tick[] {
  const { view, left, plotW } = scale;
  const msPerPx = (view.v1 - view.v0) / plotW;
  const step = STEPS.find((s) => s / msPerPx >= 80) ?? 86400e3;
  const out: Tick[] = [];
  let lastX = -Infinity;
  for (const p of scale.map.pieces) {
    if (p.gap || p.d1 < view.v0 || p.d0 > view.v1) continue;
    const off = new Date(p.r0).getTimezoneOffset() * -60000;
    for (let t = Math.ceil((p.r0 + off) / step) * step - off; t <= p.r1; t += step) {
      const x = scale.xt(t);
      if (x < left || x > left + plotW || x - lastX < 64) continue;
      const d = new Date(t);
      const midnight = d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0;
      out.push({ x, label: multiDay && midnight ? dayStr(t) : clock(t, step < 60e3) });
      lastX = x;
    }
  }
  return out;
}

/**
 * The longest head of `text` that fits in `w` pixels with an ellipsis, as `measure` measures it:
 * the text itself when it fits, else empty when not even one character does.
 */
export function fitText(measure: (text: string) => number, text: string, w: number): string {
  if (w <= 0) return '';
  if (measure(text) <= w) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (measure(`${text.slice(0, m)}…`) <= w) lo = m;
    else hi = m - 1;
  }
  return lo ? `${text.slice(0, lo)}…` : '';
}
