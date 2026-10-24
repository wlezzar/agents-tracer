import { describe, expect, it } from 'vitest';

import { bytes, cap, clock, dayStr, fmt, kTok, oneLine, pct, spansDays, stamp } from './format.js';

// Tests run in Europe/Paris (vitest.config.ts).

describe('the viewer’s formatting', () => {
  it('writes sizes in kilobytes, and from a megabyte in megabytes', () => {
    expect([0, 512, 2048, 1023 * 1024, 1024 * 1024 - 1, 3.4 * 1024 * 1024].map(bytes)).toEqual([
      '0K',
      '1K',
      '2K',
      '1023K',
      '1.0M',
      '3.4M',
    ]);
  });

  it('writes durations, an en dash for a missing one', () => {
    expect([0, 950, 9949, 9950, 59_499, 60_000, 3_599_000, 3_600_000, 5_430_000].map(fmt)).toEqual([
      '0.0s',
      '0.9s',
      '9.9s',
      '10s',
      '59s',
      '1m00s',
      '59m59s',
      '1h00m',
      '1h31m',
    ]);
    expect([null, undefined, NaN].map(fmt)).toEqual(['–', '–', '–']);
  });

  it('writes token counts', () => {
    expect([0, 999, 1000, 48_210, 1_250_000, null, undefined].map(kTok)).toEqual([
      '0',
      '999',
      '1.0k',
      '48.2k',
      '1.3M',
      '–',
      '–',
    ]);
  });

  it('writes local times, with the date when a session spans days', () => {
    const t = Date.UTC(2026, 2, 14, 23, 5, 9); // 00:05:09 on Mar 15 in Paris
    expect(clock(t)).toBe('00:05:09');
    expect(clock(t, false)).toBe('00:05');
    expect(stamp(t, false)).toBe('00:05:09');
    expect(stamp(t, true)).toBe(`${dayStr(t)} 00:05:09`);
    expect(dayStr(t)).toBe(new Date(2026, 2, 15).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
    expect(stamp(null, true)).toBe('–');
    expect(spansDays(Date.UTC(2026, 2, 14, 22, 0), t)).toBe(true);
    expect(spansDays(Date.UTC(2026, 2, 14, 23, 0), t)).toBe(false);
  });

  it('writes shares, an en dash without a whole', () => {
    expect([pct(1, 3), pct(2, 3), pct(1, 0), pct(1, null)]).toEqual(['33%', '67%', '–', '–']);
  });

  it('puts a text on one line, cut with an ellipsis', () => {
    expect(oneLine('  a\n\n b\tc ')).toBe('a b c');
    expect(oneLine('abcdef', 4)).toBe('abc…');
    expect(oneLine(null)).toBe('');
    expect(oneLine('x'.repeat(141))).toHaveLength(140);
    expect(cap('waiting on you')).toBe('Waiting on you');
  });
});
