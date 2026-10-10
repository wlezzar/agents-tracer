import { describe, expect, it } from 'vitest';

import { dayStr } from './format.js';
import { fitText, ticks } from './ticks.js';
import { Scale, TimeMap } from './timeMap.js';

// Tests run in Europe/Paris (vitest.config.ts): ticks fall on local round times.

const H = 3_600_000;
const T = Date.UTC(2026, 2, 14, 22, 0); // 23:00 in Paris

describe('ticks', () => {
  it('steps so ticks are at least 80 px apart, on local round times, a midnight as its date', () => {
    const map = new TimeMap([{ r0: T, r1: T + 2 * H, d0: 0, d1: 2 * H, gap: false }]);
    const tk = ticks(new Scale(map, { v0: 0, v1: 2 * H }, 250, 1000), true);
    expect(tk.map((t) => t.label)).toEqual([
      '23:00',
      '23:10',
      '23:20',
      '23:30',
      '23:40',
      '23:50',
      dayStr(T + H),
      '00:10',
      '00:20',
      '00:30',
      '00:40',
      '00:50',
      '01:00',
    ]);
    expect(tk[1]?.x).toBeCloseTo(250 + 1000 / 12);
    // Within one day, midnight is a time like any other.
    expect(ticks(new Scale(map, { v0: 0, v1: 2 * H }, 250, 1000), false)[6]?.label).toBe('00:00');
  });

  it('shows seconds when the step is under a minute', () => {
    const map = new TimeMap([{ r0: T, r1: T + 60_000, d0: 0, d1: 60_000, gap: false }]);
    expect(ticks(new Scale(map, { v0: 0, v1: 60_000 }, 0, 600), false).map((t) => t.label)).toEqual([
      '23:00:00',
      '23:00:10',
      '23:00:20',
      '23:00:30',
      '23:00:40',
      '23:00:50',
      '23:01:00',
    ]);
  });

  it('puts no tick in a collapsed gap, or outside the plot', () => {
    const map = new TimeMap([
      { r0: T, r1: T + 600_000, d0: 0, d1: 600_000, gap: false },
      { r0: T + 600_000, r1: T + 2 * H, d0: 600_000, d1: 620_000, gap: true },
      { r0: T + 2 * H, r1: T + 2 * H + 600_000, d0: 620_000, d1: 1_220_000, gap: false },
    ]);
    const tk = ticks(new Scale(map, { v0: 0, v1: 1_220_000 }, 0, 1220), false);
    expect(tk.map((t) => t.label)).toEqual([
      '23:00',
      '23:02',
      '23:04',
      '23:06',
      '23:08',
      '23:10',
      '01:02',
      '01:04',
      '01:06',
      '01:08',
      '01:10',
    ]);
    const zoomed = ticks(new Scale(map, { v0: 100_000, v1: 300_000 }, 0, 200), false);
    expect(zoomed.every((t) => t.x >= 0 && t.x <= 200)).toBe(true);
  });
});

describe('fitText', () => {
  const measure = (t: string) => t.length * 10;

  it('keeps a text that fits, else the longest head that fits with an ellipsis, else nothing', () => {
    expect(fitText(measure, 'hello', 50)).toBe('hello');
    expect(fitText(measure, 'hello world', 50)).toBe('hell…');
    expect(fitText(measure, 'hello', 15)).toBe('');
    expect(fitText(measure, 'hello', 0)).toBe('');
  });
});
