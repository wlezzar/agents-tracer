import type { ViewGroup, ViewLane, ViewSpan, ViewTurn } from '../../view/types.js';
import { isIdle } from './categories.js';
import type { Scale } from './timeMap.js';

// Where things sit on the lanes canvas: each lane's rows of spans, the lanes and group headers top
// to bottom, and what a point hits.

/** The width of the lane labels, left of the plot. */
export const LABEL_W = 250;
/** A lane's padding above its state track, the track's height, the gap below it, a row's height, and the padding below the rows. */
export const PAD_T = 15;
export const STATE_H = 8;
export const GAP = 4;
export const ROW_H = 16;
export const PAD_B = 7;
/** A group header's height. */
export const GROUP_H = 26;
/** The margin right of the plot. */
export const RIGHT = 10;

/** A span with the row it is drawn on. */
export type LaneSpan = ViewSpan & { readonly row: number };

/** A turn with its active time. */
export type LaneTurn = ViewTurn & { readonly active: number };

/** A lane as the viewer lays it out. */
export interface Lane extends ViewLane {
  readonly spans: readonly LaneSpan[];
  readonly turns: readonly LaneTurn[];
  /** The indexes of the spans on each row. */
  readonly byRow: readonly (readonly number[])[];
  /** Its rows of spans: at least 2. */
  readonly rows: number;
  /** Its top on the canvas; null while its group is collapsed. */
  y: number | null;
  height: number;
}

/**
 * The row of each span: model calls on row 0; each tool call on the first row from 1 whose last
 * span ended by its start (a span is at least 1 ms long).
 */
export function packRows(spans: readonly ViewSpan[]): { rows: number[]; byRow: number[][] } {
  const ends: number[] = [];
  const rows: number[] = [];
  const byRow: number[][] = [[]];
  spans.forEach((s, i) => {
    let row = 0;
    if (s.t !== 'm') {
      let r = 0;
      while (r < ends.length && (ends[r] ?? -Infinity) > s.s) r++;
      ends[r] = Math.max(s.e, s.s + 1);
      row = r + 1;
    }
    rows.push(row);
    (byRow[row] ??= []).push(i);
  });
  return { rows, byRow };
}

/** A lane of the view data, laid out: its spans' rows and its turns' active time. */
export function laneOf(l: ViewLane): Lane {
  const { rows, byRow } = packRows(l.spans);
  const count = Math.max(2, byRow.length);
  for (let r = 0; r < count; r++) byRow[r] ??= [];
  return {
    ...l,
    spans: l.spans.map((s, i) => ({ ...s, row: rows[i] ?? 0 })),
    turns: l.turns.map((t) => ({ ...t, active: t.b.filter(([k]) => !isIdle(k)).reduce((a, [, v]) => a + v, 0) })),
    byRow,
    rows: count,
    y: null,
    height: 0,
  };
}

/** The height of a lane. */
export function laneHeight(l: Pick<Lane, 'rows'>): number {
  return PAD_T + STATE_H + GAP + l.rows * ROW_H + PAD_B;
}

/** A band of the lanes canvas: a group's header, or a lane. */
export type LayoutItem =
  | { readonly type: 'group'; readonly g: ViewGroup; readonly y: number; readonly h: number; readonly n: number }
  | { readonly type: 'lane'; readonly l: Lane; readonly y: number; readonly h: number };

/**
 * The bands top to bottom, by group: each group but the session's has a header, then its lanes
 * unless it is collapsed. Sets each lane's `y` (null when collapsed) and `height`; returns the
 * bands and their total height.
 */
export function relayout(
  groups: readonly ViewGroup[],
  lanes: readonly Lane[],
  collapsed: ReadonlySet<string>,
): { layout: LayoutItem[]; contentH: number } {
  const layout: LayoutItem[] = [];
  let y = 0;
  for (const g of groups) {
    const ls = lanes.filter((l) => l.group === g.id);
    if (!ls.length) continue;
    if (g.id !== 'main') {
      layout.push({ type: 'group', g, y, h: GROUP_H, n: ls.length });
      y += GROUP_H;
      if (collapsed.has(g.id)) {
        for (const l of ls) l.y = null;
        continue;
      }
    }
    for (const l of ls) {
      const h = laneHeight(l);
      layout.push({ type: 'lane', l, y, h });
      l.y = y;
      l.height = h;
      y += h;
    }
  }
  return { layout, contentH: y };
}

/** What a point of the lanes canvas is on. */
export type Hit =
  | { readonly type: 'group'; readonly g: ViewGroup }
  | { readonly type: 'label'; readonly l: Lane }
  | { readonly type: 'lane'; readonly l: Lane }
  | { readonly type: 'turn'; readonly l: Lane; readonly i: number }
  | { readonly type: 'seg'; readonly l: Lane; readonly i: number }
  | { readonly type: 'span'; readonly l: Lane; readonly i: number };

/** What can be selected: a span, a stretch of the state track, or a turn. */
export type Selection = Extract<Hit, { type: 'span' | 'seg' | 'turn' }>;

export function isSelection(h: Hit | null): h is Selection {
  return h !== null && (h.type === 'span' || h.type === 'seg' || h.type === 'turn');
}

/** Whether two hits are on the same thing. */
export function sameHit(a: Hit | null, b: Hit | null): boolean {
  if (a === null || b?.type !== a.type) return false;
  const lane = (h: Hit) => ('l' in h ? h.l : undefined);
  const index = (h: Hit) => ('i' in h ? h.i : undefined);
  const group = (h: Hit) => ('g' in h ? h.g : undefined);
  return lane(a) === lane(b) && index(a) === index(b) && group(a) === group(b);
}

/**
 * What the point (px, py) of the lanes canvas (py from the top of the content) hits: a group's
 * header; a lane's label; a turn marker within 6 pixels above the state track; a stretch of the
 * track; the nearest span of the row within 5 pixels, the shortest one when several cover it;
 * else the lane.
 */
export function hitTest(layout: readonly LayoutItem[], scale: Scale, px: number, py: number): Hit | null {
  const it = layout.find((x) => py >= x.y && py < x.y + x.h);
  if (!it) return null;
  if (it.type === 'group') return { type: 'group', g: it.g };
  const l = it.l;
  if (px < LABEL_W) return { type: 'label', l };
  const ys = it.y + PAD_T;
  if (py < ys - 1) {
    let best = -1;
    let bd = 6;
    for (const [i, t] of l.turns.entries()) {
      const d = Math.abs(scale.xt(t.ts) - px);
      if (d < bd) {
        best = i;
        bd = d;
      }
    }
    if (best >= 0) return { type: 'turn', l, i: best };
  }
  if (py >= ys - 2 && py < ys + STATE_H + 2) {
    const t = scale.map.toReal(scale.d(px));
    const i = l.seg.findIndex(([s, e]) => t >= s && t < e);
    if (i >= 0) return { type: 'seg', l, i };
  }
  const row = Math.floor((py - (ys + STATE_H + GAP)) / ROW_H);
  if (row >= 0 && row < l.rows) {
    let best: LaneSpan | null = null;
    let bestIndex = -1;
    let bd = 5;
    for (const i of l.byRow[row] ?? []) {
      const s = l.spans[i];
      if (s === undefined) continue;
      const x0 = scale.xt(s.s);
      const x1 = Math.max(scale.xt(s.e), x0 + 1);
      const d = px < x0 ? x0 - px : px > x1 ? px - x1 : 0;
      if (d < bd || (d === 0 && bd === 0 && best !== null && s.e - s.s < best.e - best.s)) {
        best = s;
        bestIndex = i;
        bd = d;
      }
    }
    if (best !== null) return { type: 'span', l, i: bestIndex };
  }
  return { type: 'lane', l };
}
