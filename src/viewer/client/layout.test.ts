import { describe, expect, it } from 'vitest';

import { modelSpan, toolSpan, turn, viewLane } from '../../../test/support/view-data.js';
import type { ViewGroup } from '../../view/types.js';
import { GROUP_H, hitTest, isSelection, laneHeight, laneOf, packRows, relayout, sameHit, type Hit } from './layout.js';
import { Scale, TimeMap } from './timeMap.js';

describe('packRows', () => {
  it('puts model calls on row 0 and each tool call on the first row free at its start', () => {
    const spans = [modelSpan(0, 10), toolSpan(0, 5), toolSpan(2, 8), toolSpan(5, 6), modelSpan(10, 20), toolSpan(8, 9)];
    expect(packRows(spans)).toEqual({ rows: [0, 1, 2, 1, 0, 1], byRow: [[0, 4], [1, 3, 5], [2]] });
  });

  it('counts a zero-length tool call as 1 ms long', () => {
    expect(packRows([toolSpan(5, 5), toolSpan(5, 9)]).rows).toEqual([1, 2]);
    expect(packRows([toolSpan(5, 5), toolSpan(6, 9)]).rows).toEqual([1, 1]);
  });
});

describe('laneOf', () => {
  it('gives a lane at least two rows, and each turn its active time', () => {
    const l = laneOf(
      viewLane('main', {
        spans: [modelSpan(0, 10)],
        turns: [
          turn(1, 0, 10, {
            b: [
              ['model', 7],
              ['tool:sh', 2],
              ['idle: waiting on you', 50],
            ],
          }),
        ],
      }),
    );
    expect([l.rows, l.byRow]).toEqual([2, [[0], []]]);
    expect(l.spans.map((s) => s.row)).toEqual([0]);
    expect(l.turns.map((t) => t.active)).toEqual([9]);
    expect(laneHeight(l)).toBe(15 + 8 + 4 + 2 * 16 + 7);
  });
});

const groups: ViewGroup[] = [
  { id: 'main', label: 'Session' },
  { id: 'agents', label: 'Agents', start: 5 },
  { id: 'run-1', label: 'Batch nightly', kind: 'Batch', start: 9 },
];

describe('relayout', () => {
  it('stacks the lanes by group, a header above each group but the session’s, none below a collapsed one', () => {
    const lanes = [
      laneOf(viewLane('main')),
      laneOf(viewLane('a1', { group: 'agents' })),
      laneOf(viewLane('w1', { group: 'run-1' })),
      laneOf(viewLane('w2', { group: 'run-1' })),
    ];
    const h = laneHeight({ rows: 2 });
    const { layout, contentH } = relayout(groups, lanes, new Set(['run-1']));
    expect(layout.map((it) => [it.type, it.type === 'lane' ? it.l.id : it.g.id, it.y, it.h])).toEqual([
      ['lane', 'main', 0, h],
      ['group', 'agents', h, GROUP_H],
      ['lane', 'a1', h + GROUP_H, h],
      ['group', 'run-1', 2 * h + GROUP_H, GROUP_H],
    ]);
    expect(contentH).toBe(2 * h + 2 * GROUP_H);
    expect(lanes.map((l) => l.y)).toEqual([0, h + GROUP_H, null, null]);
    expect(relayout(groups, lanes, new Set()).contentH).toBe(4 * h + 2 * GROUP_H);
  });
});

describe('hitTest', () => {
  // 1 ms of real time is 1 px, from x 250.
  const scale = new Scale(
    new TimeMap([{ r0: 0, r1: 1000, d0: 0, d1: 1000, gap: false }]),
    { v0: 0, v1: 1000 },
    250,
    1000,
  );
  const main = laneOf(
    viewLane('main', {
      seg: [
        [0, 100, 'model'],
        [100, 300, 'tool:sh'],
      ],
      spans: [modelSpan(0, 100), toolSpan(100, 300), toolSpan(150, 160), modelSpan(150, 400), modelSpan(160, 170)],
      turns: [turn(1, 0, 300), turn(2, 500, 600)],
    }),
  );
  const agent = laneOf(viewLane('a1', { group: 'agents' }));
  const { layout } = relayout(groups, [main, agent], new Set());
  const at = (px: number, py: number): Hit | null => hitTest(layout, scale, px, py);
  const lane0 = 15 + 8 + 4; // the top of row 0

  it('finds a group’s header and a lane’s label', () => {
    expect(at(300, laneHeight(main) + 3)).toEqual({ type: 'group', g: groups[1] });
    expect(at(100, 30)).toEqual({ type: 'label', l: main });
    expect(at(300, 10_000)).toBeNull();
  });

  it('finds the nearest turn marker within 6 px above the state track', () => {
    expect(at(250 + 503, 5)).toEqual({ type: 'turn', l: main, i: 1 });
    expect(at(250 + 520, 5)).toEqual({ type: 'lane', l: main });
  });

  it('finds the stretch of the state track at the point', () => {
    expect(at(250 + 150, 18)).toEqual({ type: 'seg', l: main, i: 1 });
    expect(at(250 + 50, 14)).toEqual({ type: 'seg', l: main, i: 0 });
  });

  it('finds the nearest span of the row within 5 px, the shortest when several cover the point', () => {
    expect(at(250 + 50, lane0 + 4)).toEqual({ type: 'span', l: main, i: 0 });
    expect(at(250 + 103, lane0 + 4)).toEqual({ type: 'span', l: main, i: 0 });
    expect(at(250 + 155, lane0 + 4)).toEqual({ type: 'span', l: main, i: 3 });
    expect(at(250 + 165, lane0 + 4)).toEqual({ type: 'span', l: main, i: 4 });
    expect(at(250 + 155, lane0 + 16 + 4)).toEqual({ type: 'span', l: main, i: 1 });
    expect(at(250 + 155, lane0 + 32 + 4)).toEqual({ type: 'span', l: main, i: 2 });
    expect(at(250 + 166, lane0 + 32 + 4)).toEqual({ type: 'lane', l: main });
  });

  it('tells hits apart', () => {
    expect(sameHit({ type: 'span', l: main, i: 1 }, { type: 'span', l: main, i: 1 })).toBe(true);
    expect(sameHit({ type: 'span', l: main, i: 1 }, { type: 'span', l: main, i: 2 })).toBe(false);
    expect(sameHit({ type: 'label', l: main }, { type: 'lane', l: main })).toBe(false);
    expect(sameHit({ type: 'group', g: groups[1] ?? groups[0] ?? { id: '', label: '' } }, null)).toBe(false);
    expect([at(250 + 503, 5), at(100, 30)].map(isSelection)).toEqual([true, false]);
  });
});
