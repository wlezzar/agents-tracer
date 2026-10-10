import { describe, expect, it } from 'vitest';

import { fmt, kTok, pct, two } from './format.js';

// Expected strings are the prototype's (session-trace/trace.mjs) for the same inputs.

describe('fmt', () => {
  it.each([
    [null, '-'],
    [undefined, '-'],
    [Number.NaN, '-'],
    [0, '0.0s'],
    [49, '0.0s'],
    [950, '0.9s'],
    [9949, '9.9s'],
    [9950, '10s'],
    [12345, '12s'],
    [59499, '59s'],
    [59500, '1m00s'],
    [60000, '1m00s'],
    [187000, '3m07s'],
    [3599499, '59m59s'],
    [3599500, '1h00m'],
    [3600000, '1h00m'],
    [3900000, '1h05m'],
    [5430000, '1h31m'],
    [86400000, '24h00m'],
    [-500, '-0.5s'],
  ])('%s ms is %j', (ms, text) => {
    expect(fmt(ms)).toBe(text);
  });
});

describe('kTok', () => {
  it.each([
    [0, '0'],
    [7, '7'],
    [999, '999'],
    [1000, '1.0k'],
    [12345, '12.3k'],
    [999999, '1000.0k'],
    [1000000, '1.0M'],
    [1234567, '1.2M'],
    [999949999, '999.9M'],
  ])('%s tokens is %j', (n, text) => {
    expect(kTok(n)).toBe(text);
  });
});

describe('pct', () => {
  it.each([
    [1, 3, '33%'],
    [2, 3, '67%'],
    [0, 0, '-'],
    [5, -1, '-'],
    [1, 200, '1%'],
    [1, 201, '0%'],
    [250, 100, '250%'],
  ])('%s of %s is %j', (part, whole, text) => {
    expect(pct(part, whole)).toBe(text);
  });
});

describe('two', () => {
  it.each([
    [0, '00'],
    [5, '05'],
    [12, '12'],
    [123, '123'],
  ])('%s is %j', (n, text) => {
    expect(two(n)).toBe(text);
  });
});
