import { describe, expect, it } from 'vitest';

import { clock, day, spansDays } from './time.js';

// The tests run in Europe/Paris (vitest.config.ts), so these are local times, not UTC. Expected
// strings are the prototype's (session-trace/trace.mjs) for the same instants in that zone.

describe('the test time zone', () => {
  it('is Europe/Paris, an hour ahead of UTC in winter', () => {
    expect(new Date(0).getTimezoneOffset()).toBe(-60);
  });
});

describe('clock', () => {
  it.each([
    [0, '01:00:00', '01-01 01:00:00'],
    [1760000000000, '10:53:20', '10-09 10:53:20'],
    [1760054399999, '01:59:59', '10-10 01:59:59'],
    [1767225599000, '00:59:59', '01-01 00:59:59'],
  ])('%s is %j, or %j with the date', (ts, time, withDate) => {
    expect(clock(ts)).toBe(time);
    expect(clock(ts, true)).toBe(withDate);
  });
});

describe('day', () => {
  it.each([
    [0, '1970-01-01 01:00'],
    [1760000000000, '2025-10-09 10:53'],
    [1767225599000, '2026-01-01 00:59'],
  ])('%s is %j', (ts, text) => {
    expect(day(ts)).toBe(text);
  });
});

describe('spansDays', () => {
  it('compares local days', () => {
    // 22:30 and 23:30 UTC, on one UTC day, are 23:30 and 00:30 in Paris, on two days.
    expect(spansDays(Date.UTC(2026, 0, 5, 22, 30), Date.UTC(2026, 0, 5, 23, 30))).toBe(true);
    expect(spansDays(Date.UTC(2026, 0, 5, 0, 30), Date.UTC(2026, 0, 5, 22, 0))).toBe(false);
  });
});
