import type { Bucket } from '../../view/types.js';
import { failed, isIdle } from './categories.js';
import type { Lane, LaneSpan } from './layout.js';

// The rows of the trace tab: a lane's spans that pass the filters, and, in time order without a
// filter, its turns and its idle stretches of a minute or more between them.

/** The trace's kind filter, the values of its select. */
export type TraceKind = 'all' | 'model' | 'tools' | 'shell' | 'other' | 'failed' | 'slow';

export function isTraceKind(value: string): value is TraceKind {
  return ['all', 'model', 'tools', 'shell', 'other', 'failed', 'slow'].includes(value);
}

export interface TraceSort {
  readonly by: 'time' | 'dur';
  /** 1 ascending, -1 descending. */
  readonly dir: 1 | -1;
}

export interface TraceFilter {
  /** Lowercase text to look for; empty for none. */
  readonly q: string;
  readonly kind: TraceKind;
  /** Keep only what overlaps the real stretch [r0, r1]. */
  readonly inview: boolean;
  readonly r0: number;
  readonly r1: number;
  readonly sort: TraceSort;
}

/** A row of the trace: `t` sorts it by time, `ms` by duration. */
export type TraceRow =
  | { readonly kind: 'span'; readonly i: number; readonly s: LaneSpan; readonly t: number; readonly ms: number }
  | { readonly kind: 'turn'; readonly i: number; readonly t: number; readonly ms: number }
  | { readonly kind: 'idle'; readonly i: number; readonly t: number; readonly ms: number; readonly b: Bucket };

/** Whether a span passes the filters. */
export function keepSpan(s: LaneSpan, f: Pick<TraceFilter, 'q' | 'kind' | 'inview' | 'r0' | 'r1'>): boolean {
  const { kind } = f;
  if (kind === 'model' && s.t !== 'm') return false;
  if (kind === 'tools' && s.t !== 't') return false;
  if (kind === 'shell' && !(s.t === 't' && s.cat === 'shell')) return false;
  if (kind === 'other' && !(s.t === 't' && s.cat !== 'shell')) return false;
  if (kind === 'failed' && !failed(s)) return false;
  if (kind === 'slow' && !(s.ms != null && s.ms >= 10e3)) return false;
  if (f.inview && (s.e < f.r0 || s.s > f.r1)) return false;
  if (f.q) {
    const hay = s.t === 'm' ? `model ${s.sum} ${s.text}` : `${s.name} ${s.desc} ${s.pv} ${s.in}`;
    if (!hay.toLowerCase().includes(f.q)) return false;
  }
  return true;
}

/** The trace's rows for a lane, sorted. */
export function traceRows(l: Lane, f: TraceFilter): TraceRow[] {
  const rows: TraceRow[] = [];
  l.spans.forEach((s, i) => {
    if (keepSpan(s, f)) rows.push({ kind: 'span', i, s, t: s.s, ms: s.ms ?? 0 });
  });
  if (f.sort.by === 'time' && f.kind === 'all' && !f.q) {
    l.turns.forEach((t, i) => {
      if (!f.inview || (t.end >= f.r0 && t.ts <= f.r1)) rows.push({ kind: 'turn', i, t: t.ts - 0.5, ms: t.active });
    });
    l.seg.forEach(([s, e, b], i) => {
      if (isIdle(b) && e - s >= 60e3 && (!f.inview || (e >= f.r0 && s <= f.r1)))
        rows.push({ kind: 'idle', i, t: s, ms: e - s, b });
    });
  }
  const { dir } = f.sort;
  rows.sort(f.sort.by === 'time' ? (a, b) => (a.t - b.t) * dir : (a, b) => (a.ms - b.ms) * dir || a.t - b.t);
  return rows;
}

/** The sort after a click on a column's header: the other direction of the same column, else the column's own first. */
export function nextSort(sort: TraceSort, by: TraceSort['by']): TraceSort {
  return sort.by === by ? { by, dir: sort.dir === 1 ? -1 : 1 } : { by, dir: by === 'dur' ? -1 : 1 };
}
