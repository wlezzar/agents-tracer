import type { ViewSegment } from '../../view/types.js';
import { isIdle } from './categories.js';

// The timeline's time axis. Real time (epoch ms) maps to display time through pieces: stretches
// shown at their length, and idle stretches of at least GAP_MIN collapsed to a short gap. The
// viewport is a window [v0, v1] of display time.

/** A stretch of real time [r0, r1] shown as display time [d0, d1]; `gap` marks a collapsed one. */
export interface Piece {
  readonly r0: number;
  readonly r1: number;
  readonly d0: number;
  readonly d1: number;
  readonly gap: boolean;
}

/** The shortest idle stretch that is collapsed. */
export const GAP_MIN = 120e3;

/** What the mapping reads of a lane: what keeps time from collapsing. */
export interface MappedLane {
  readonly seg: readonly ViewSegment[];
  readonly spans: readonly { readonly s: number; readonly e: number }[];
  readonly turns: readonly { readonly ts: number }[];
}

/**
 * The pieces from T0 to T1. Without `compress`, one piece at real length. With it, the active
 * stretches of every lane (non-idle segments, spans, turn starts), merged across gaps shorter than
 * GAP_MIN, keep their length, and every gap between them of GAP_MIN or more shows as a collapsed
 * piece of a fixed length.
 */
export function buildPieces(lanes: readonly MappedLane[], T0: number, T1: number, compress: boolean): Piece[] {
  if (!compress) return [{ r0: T0, r1: T1, d0: 0, d1: Math.max(1, T1 - T0), gap: false }];
  const iv: [number, number][] = [];
  for (const l of lanes) {
    for (const [s, e, b] of l.seg) if (!isIdle(b)) iv.push([s, e]);
    for (const sp of l.spans) iv.push([sp.s, Math.max(sp.e, sp.s)]);
    for (const t of l.turns) iv.push([t.ts, t.ts]);
  }
  iv.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [s, e] of iv) {
    const last = merged.at(-1);
    if (last && s - last[1] < GAP_MIN) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  const activeTotal = merged.reduce((a, [s, e]) => a + (e - s), 0);
  const show = Math.max(20e3, activeTotal * 0.006);
  const pieces: Piece[] = [];
  let c = T0;
  let d = 0;
  const lin = (r0: number, r1: number): void => {
    if (r1 <= r0) return;
    pieces.push({ r0, r1, d0: d, d1: d + (r1 - r0), gap: false });
    d += r1 - r0;
  };
  const gapOrLin = (r0: number, r1: number): void => {
    if (r1 - r0 >= GAP_MIN) {
      pieces.push({ r0, r1, d0: d, d1: d + show, gap: true });
      d += show;
    } else lin(r0, r1);
  };
  for (const [s, e] of merged) {
    if (s > c) gapOrLin(c, s);
    lin(Math.max(c, s), e);
    c = Math.max(c, e);
  }
  if (T1 > c) gapOrLin(c, T1);
  if (!pieces.length) return [{ r0: T0, r1: T1 + 1, d0: 0, d1: T1 + 1 - T0, gap: false }];
  return pieces;
}

/**
 * A mapping between real and display time over its pieces, which are never empty. Times before
 * the first piece or after the last map at real length.
 */
export class TimeMap {
  readonly pieces: readonly Piece[];
  private readonly first: Piece;
  private readonly last: Piece;

  constructor(pieces: readonly Piece[]) {
    const [first] = pieces;
    const last = pieces.at(-1);
    if (first === undefined || last === undefined) throw new Error('a time map needs a piece');
    this.pieces = pieces;
    this.first = first;
    this.last = last;
  }

  /** The display time of the end. */
  get total(): number {
    return this.last.d1;
  }

  /** The last piece whose `lo` bound is at most `v`. */
  private find(v: number, lo: 'r0' | 'd0'): Piece {
    let a = 0;
    let b = this.pieces.length - 1;
    while (a < b) {
      const m = (a + b + 1) >> 1;
      if ((this.pieces[m]?.[lo] ?? Infinity) <= v) a = m;
      else b = m - 1;
    }
    return this.pieces[a] ?? this.first;
  }

  toDisp(t: number): number {
    const { first, last } = this;
    if (t <= first.r0) return first.d0 - (first.r0 - t);
    if (t >= last.r1) return last.d1 + (t - last.r1);
    const p = this.find(t, 'r0');
    return p.d0 + ((t - p.r0) * (p.d1 - p.d0)) / Math.max(1, p.r1 - p.r0);
  }

  toReal(d: number): number {
    const { first, last } = this;
    if (d <= first.d0) return first.r0 - (first.d0 - d);
    if (d >= last.d1) return last.r1 + (d - last.d1);
    const p = this.find(d, 'd0');
    return p.r0 + ((d - p.d0) * (p.r1 - p.r0)) / Math.max(1, p.d1 - p.d0);
  }
}

/** The window of display time the timeline shows. */
export interface Viewport {
  readonly v0: number;
  readonly v1: number;
}

/**
 * The window kept within the timeline: at least 200 ms wide, at most the whole with 2% slack on
 * each side, and not past either end by more than the slack.
 */
export function clampView({ v0, v1 }: Viewport, total: number): Viewport {
  const slack = total * 0.02;
  let span = Math.max(v1 - v0, 200);
  if (span > total + 2 * slack) span = total + 2 * slack;
  let a = v0;
  let b = a + span;
  if (a < -slack) {
    a = -slack;
    b = a + span;
  }
  if (b > total + slack) {
    b = total + slack;
    a = b - span;
  }
  return { v0: a, v1: b };
}

/** The whole timeline, with 1% to spare on each side. */
export function fitView(total: number): Viewport {
  return clampView({ v0: -total * 0.01, v1: total * 1.01 }, total);
}

/** Zoomed by `factor` (below 1 zooms in) about the display time `d`. */
export function zoomView(v: Viewport, d: number, factor: number, total: number): Viewport {
  return clampView({ v0: d - (d - v.v0) * factor, v1: d + (v.v1 - d) * factor }, total);
}

/** Moved by `dd` of display time. */
export function panView(v: Viewport, dd: number, total: number): Viewport {
  return clampView({ v0: v.v0 + dd, v1: v.v1 + dd }, total);
}

/** The real stretch [r0, r1] with 12% (at least 1.5 s) of padding on each side. */
export function zoomToRealView(map: TimeMap, r0: number, r1: number): Viewport {
  const d0 = map.toDisp(r0);
  const d1 = map.toDisp(Math.max(r1, r0 + 1));
  const pad = Math.max((d1 - d0) * 0.12, 1500);
  return clampView({ v0: d0 - pad, v1: d1 + pad }, map.total);
}

/**
 * The window that brings the real stretch [r0, r1] into view, zooming only when it does not fit:
 * one that fits it when it is wider than 90% of the window; about ten times its length around it
 * when it would be under 6 pixels wide; else the window panned to center it when it is near or
 * past an edge; else the window as it is.
 */
export function revealView(v: Viewport, map: TimeMap, r0: number, r1: number, plotW: number): Viewport {
  const d0 = map.toDisp(r0);
  const d1 = map.toDisp(Math.max(r1, r0 + 1));
  const span = v.v1 - v.v0;
  if (d1 - d0 > span * 0.9) return zoomToRealView(map, r0, r1);
  if (((d1 - d0) / span) * plotW < 6) {
    const half = Math.max((d1 - d0) * 5, 30e3);
    return clampView({ v0: (d0 + d1) / 2 - half, v1: (d0 + d1) / 2 + half }, map.total);
  }
  if (d0 < v.v0 + span * 0.05 || d1 > v.v1 - span * 0.05)
    return panView(v, (d0 + d1) / 2 - (v.v0 + v.v1) / 2, map.total);
  return v;
}

/** Display time and x in pixels, for a plot of `plotW` pixels that starts at `left`. */
export class Scale {
  readonly map: TimeMap;
  readonly view: Viewport;
  readonly left: number;
  readonly plotW: number;

  constructor(map: TimeMap, view: Viewport, left: number, plotW: number) {
    this.map = map;
    this.view = view;
    this.left = left;
    this.plotW = plotW;
  }

  /** The x of a display time. */
  x(d: number): number {
    return this.left + ((d - this.view.v0) / (this.view.v1 - this.view.v0)) * this.plotW;
  }

  /** The display time at x. */
  d(x: number): number {
    return this.view.v0 + ((x - this.left) / this.plotW) * (this.view.v1 - this.view.v0);
  }

  /** The x of a real time. */
  xt(t: number): number {
    return this.x(this.map.toDisp(t));
  }
}
