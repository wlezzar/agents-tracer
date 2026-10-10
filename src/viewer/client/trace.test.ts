import { describe, expect, it } from 'vitest';

import { modelSpan, toolSpan, turn, viewLane } from '../../../test/support/view-data.js';
import { laneOf } from './layout.js';
import { isTraceKind, keepSpan, nextSort, traceRows, type TraceFilter } from './trace.js';

const MIN = 60_000;
const lane = laneOf(
  viewLane('main', {
    spans: [
      modelSpan(0, 2000, { sum: 'thinking · sh make', text: 'Building' }),
      toolSpan(2000, 20_000, { name: 'sh', cat: 'shell', pv: 'make test', in: 'make test', err: true }),
      toolSpan(2000, 2500, { name: 'read', pv: 'src/a.ts' }),
      toolSpan(5 * MIN, 5 * MIN, { name: 'sh', cat: 'shell', pv: 'make lint', ms: null }),
    ],
    turns: [turn(1, 0, 20_000), turn(2, 5 * MIN, 5 * MIN)],
    seg: [
      [0, 20_000, 'model'],
      [20_000, 5 * MIN, 'idle: waiting on you'],
      [5 * MIN, 5 * MIN + 30_000, 'idle: waiting on a background task'],
    ],
  }),
);
const all: TraceFilter = { q: '', kind: 'all', inview: false, r0: 0, r1: 0, sort: { by: 'time', dir: 1 } };

describe('traceRows', () => {
  it('lists the spans, and in time order without a filter the turns and the idle stretches of a minute or more', () => {
    expect(traceRows(lane, all).map((r) => [r.kind, r.i])).toEqual([
      ['turn', 0],
      ['span', 0],
      ['span', 1],
      ['span', 2],
      ['idle', 1],
      ['turn', 1],
      ['span', 3],
    ]);
  });

  it('sorts by duration, longest first by default, ties by time', () => {
    const rows = traceRows(lane, { ...all, sort: { by: 'dur', dir: -1 } });
    expect(rows.map((r) => [r.kind, r.i])).toEqual([
      ['span', 1],
      ['span', 0],
      ['span', 2],
      ['span', 3],
    ]);
  });

  it('filters by kind, text, and the visible range', () => {
    const kinds = (kind: TraceFilter['kind']) =>
      traceRows(lane, { ...all, kind })
        .filter((r) => r.kind === 'span')
        .map((r) => r.i);
    expect(kinds('model')).toEqual([0]);
    expect(kinds('tools')).toEqual([1, 2, 3]);
    expect(kinds('shell')).toEqual([1, 3]);
    expect(kinds('other')).toEqual([2]);
    expect(kinds('failed')).toEqual([1]);
    expect(kinds('slow')).toEqual([1]);
    expect(traceRows(lane, { ...all, q: 'lint' }).map((r) => r.i)).toEqual([3]);
    expect(traceRows(lane, { ...all, q: 'building' }).map((r) => r.i)).toEqual([0]);
    expect(traceRows(lane, { ...all, inview: true, r0: 3 * MIN, r1: 6 * MIN }).map((r) => [r.kind, r.i])).toEqual([
      ['idle', 1],
      ['turn', 1],
      ['span', 3],
    ]);
  });

  it('keeps a span by kind', () => {
    const [m] = lane.spans;
    expect(m && keepSpan(m, { ...all, kind: 'tools' })).toBe(false);
  });
});

describe('the trace’s sort and kinds', () => {
  it('turns a column’s direction, or starts a column at its own first direction', () => {
    expect(nextSort({ by: 'time', dir: 1 }, 'time')).toEqual({ by: 'time', dir: -1 });
    expect(nextSort({ by: 'time', dir: 1 }, 'dur')).toEqual({ by: 'dur', dir: -1 });
    expect(nextSort({ by: 'dur', dir: -1 }, 'time')).toEqual({ by: 'time', dir: 1 });
  });

  it('knows the select’s values', () => {
    expect(['all', 'shell', 'slow', 'bash', ''].map(isTraceKind)).toEqual([true, true, true, false, false]);
  });
});
