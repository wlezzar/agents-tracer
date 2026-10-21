import { describe, expect, it } from 'vitest';

import { conversationTurn, modelItem } from '../../../test/support/view-data.js';
import type { CompactionItem } from '../../view/types.js';
import { ChartScale, contextSeries } from './contextChart.js';

const compaction: CompactionItem = {
  type: 'compaction',
  ts: 0,
  trigger: 'auto',
  preTokens: 30,
  postTokens: 5,
  summary: '',
};

describe('the chart of the context', () => {
  it('takes the calls that recorded their context, and where compactions fell between them', () => {
    const { points, compactions } = contextSeries([
      conversationTurn(1, [modelItem('a', [], { context: 10 }), modelItem('b', [], { context: null })]),
      conversationTurn(2, [modelItem('c', [], { context: 30 }), compaction, modelItem('d', [], { context: 5 })]),
    ]);
    expect(points.map((p) => [p.model.id, p.context, p.turn])).toEqual([
      ['a', 10, 1],
      ['c', 30, 2],
      ['d', 5, 2],
    ]);
    expect(compactions).toEqual([2]);
  });

  it('places the points in its box and finds the one nearest the pointer', () => {
    const scale = new ChartScale(210, 70, 5, 3, 30);
    expect([scale.x(0), scale.x(1), scale.x(2)]).toEqual([5, 105, 205]);
    expect([scale.y(0), scale.y(30), scale.y(15)]).toEqual([65, 5, 35]);
    expect([scale.nearest(0), scale.nearest(60), scale.nearest(150), scale.nearest(400)]).toEqual([0, 1, 1, 2]);
    expect(new ChartScale(100, 70, 5, 1, 0).x(0)).toBe(50);
  });
});
