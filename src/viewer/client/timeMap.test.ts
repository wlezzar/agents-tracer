import { describe, expect, it } from 'vitest';

import { modelSpan, toolSpan, turn, viewLane } from '../../../test/support/view-data.js';
import {
  buildPieces,
  clampView,
  fitView,
  GAP_MIN,
  panView,
  revealView,
  Scale,
  TimeMap,
  zoomToRealView,
  zoomView,
} from './timeMap.js';

const MIN = 60_000;

describe('buildPieces', () => {
  const lane = viewLane('main', {
    seg: [
      [0, 10_000, 'model'],
      [10_000, 30 * MIN, 'idle: waiting on you'],
      [30 * MIN, 31 * MIN, 'tool:sh'],
    ],
    spans: [modelSpan(0, 10_000), toolSpan(30 * MIN, 31 * MIN)],
    turns: [turn(1, 0, 10_000), turn(2, 30 * MIN, 31 * MIN)],
  });

  it('is one piece at real length without compression', () => {
    expect(buildPieces([lane], 0, 31 * MIN, false)).toEqual([{ r0: 0, r1: 31 * MIN, d0: 0, d1: 31 * MIN, gap: false }]);
  });

  it('collapses an idle stretch of at least GAP_MIN to a short gap, and keeps the active ones', () => {
    const show = 20_000; // max(20 s, 0.6% of the 70 s active)
    expect(buildPieces([lane], 0, 31 * MIN, true)).toEqual([
      { r0: 0, r1: 10_000, d0: 0, d1: 10_000, gap: false },
      { r0: 10_000, r1: 30 * MIN, d0: 10_000, d1: 10_000 + show, gap: true },
      { r0: 30 * MIN, r1: 31 * MIN, d0: 10_000 + show, d1: 10_000 + show + MIN, gap: false },
    ]);
  });

  it('keeps an idle stretch shorter than GAP_MIN at its length', () => {
    const short = viewLane('main', { spans: [modelSpan(0, 1000), modelSpan(GAP_MIN - 1, GAP_MIN)] });
    expect(buildPieces([short], 0, GAP_MIN, true)).toEqual([{ r0: 0, r1: GAP_MIN, d0: 0, d1: GAP_MIN, gap: false }]);
  });

  it('is one piece past the end when nothing is active', () => {
    expect(buildPieces([viewLane('main')], 5, 5, true)).toEqual([{ r0: 5, r1: 6, d0: 0, d1: 1, gap: false }]);
  });
});

describe('TimeMap', () => {
  const map = new TimeMap([
    { r0: 0, r1: 10, d0: 0, d1: 10, gap: false },
    { r0: 10, r1: 1010, d0: 10, d1: 20, gap: true },
    { r0: 1010, r1: 1020, d0: 20, d1: 30, gap: false },
  ]);

  it('maps real time to display time and back, linearly within each piece', () => {
    expect([0, 5, 10, 510, 1010, 1015, 1020].map((t) => map.toDisp(t))).toEqual([0, 5, 10, 15, 20, 25, 30]);
    expect([0, 5, 10, 15, 20, 25, 30].map((d) => map.toReal(d))).toEqual([0, 5, 10, 510, 1010, 1015, 1020]);
    expect(map.total).toBe(30);
  });

  it('maps times outside the pieces at real length', () => {
    expect([map.toDisp(-5), map.toDisp(1025), map.toReal(-5), map.toReal(35)]).toEqual([-5, 35, -5, 1025]);
  });

  it('needs a piece', () => {
    expect(() => new TimeMap([])).toThrow('a time map needs a piece');
  });
});

describe('the viewport', () => {
  const total = 100_000;

  it('fits the whole with 1% to spare, and keeps the window within 2% slack', () => {
    expect(fitView(total)).toEqual({ v0: -1000, v1: 101_000 });
    expect(clampView({ v0: -50_000, v1: 10_000 }, total)).toEqual({ v0: -2000, v1: 58_000 });
    expect(clampView({ v0: 90_000, v1: 150_000 }, total)).toEqual({ v0: 42_000, v1: 102_000 });
    expect(clampView({ v0: -1e9, v1: 1e9 }, total)).toEqual({ v0: -2000, v1: 102_000 });
    expect(clampView({ v0: 5000, v1: 5100 }, total)).toEqual({ v0: 5000, v1: 5200 });
  });

  it('zooms about a point, and pans', () => {
    expect(zoomView({ v0: 0, v1: 100_000 }, 50_000, 0.5, total)).toEqual({ v0: 25_000, v1: 75_000 });
    expect(panView({ v0: 0, v1: 50_000 }, 10_000, total)).toEqual({ v0: 10_000, v1: 60_000 });
    expect(panView({ v0: 0, v1: 50_000 }, 90_000, total)).toEqual({ v0: 52_000, v1: 102_000 });
  });

  const map = new TimeMap([{ r0: 0, r1: total, d0: 0, d1: total, gap: false }]);

  it('zooms to a real stretch with 12% padding, at least 1.5 s', () => {
    expect(zoomToRealView(map, 10_000, 30_000)).toEqual({ v0: 7600, v1: 32_400 });
    expect(zoomToRealView(map, 10_000, 20_000)).toEqual({ v0: 8500, v1: 21_500 });
    expect(zoomToRealView(map, 10_000, 10_000)).toEqual({ v0: 8500, v1: 11_501 });
  });

  it('reveals a stretch: zooming when it does not fit or is too thin, panning when it is near an edge', () => {
    const view = { v0: 0, v1: 50_000 };
    // wider than 90% of the window
    expect(revealView(view, map, 10_000, 60_000, 1000)).toEqual(zoomToRealView(map, 10_000, 60_000));
    // under 6 px at 1000 px for 50 s: about ten times its length around it, at least 30 s each side
    expect(revealView(view, map, 20_000, 20_100, 1000)).toEqual({ v0: -2000, v1: 58_000 });
    expect(revealView({ v0: 0, v1: 100_000 }, map, 50_000, 50_100, 1000)).toEqual({ v0: 20_050, v1: 80_050 });
    // past the right edge: centered
    expect(revealView(view, map, 48_000, 52_000, 1000)).toEqual({ v0: 25_000, v1: 75_000 });
    // well inside: as it is
    expect(revealView(view, map, 20_000, 30_000, 1000)).toBe(view);
  });
});

describe('Scale', () => {
  it('maps display time to x in the plot and back', () => {
    const map = new TimeMap([{ r0: 1000, r1: 2000, d0: 0, d1: 1000, gap: false }]);
    const scale = new Scale(map, { v0: 0, v1: 1000 }, 250, 500);
    expect([scale.x(0), scale.x(500), scale.x(1000), scale.xt(1500)]).toEqual([250, 500, 750, 500]);
    expect(scale.d(500)).toBe(500);
  });
});
