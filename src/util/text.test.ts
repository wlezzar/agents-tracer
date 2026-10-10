import { describe, expect, it } from 'vitest';

import { indent, oneLine, printable, table } from './text.js';

// Expected strings are the prototype's (session-trace/trace.mjs) for the same inputs.

describe('oneLine', () => {
  it('collapses whitespace and trims', () => {
    expect(oneLine('  a\n\tb  ')).toBe('a b');
  });

  it('makes a missing value empty', () => {
    expect(oneLine(null)).toBe('');
    expect(oneLine(undefined)).toBe('');
  });

  it('cuts to 80 characters by default, ending in an ellipsis', () => {
    expect(oneLine('x'.repeat(100))).toBe(`${'x'.repeat(79)}…`);
  });

  it('keeps a text of exactly the limit and cuts a longer one', () => {
    expect(oneLine('hello world foo', 10)).toBe('hello wor…');
    expect(oneLine('exactly10!', 10)).toBe('exactly10!');
    expect(oneLine('eleven chr!', 10)).toBe('eleven ch…');
  });
});

describe('table', () => {
  it('is empty for no rows', () => {
    expect(table([])).toBe('');
  });

  it('pads every column but the last, aligned as asked, and trims each line', () => {
    const rows = [
      ['', 'time', 'count'],
      ['model', '1m02s', 12],
      ['tool:Read', '4.0s', ''],
    ];
    expect(table(rows, ['l', 'r', 'r'])).toBe('            time  count\nmodel      1m02s  12\ntool:Read   4.0s');
  });

  it('sizes columns by the first row, and leaves cells beyond it unpadded', () => {
    expect(table([['a', 'bb'], ['ccc']])).toBe('a    bb\nccc');
    expect(table([['a'], ['b', 'extra', 'more']])).toBe('a\nb  extra  more');
  });

  it('prints missing cells as nothing', () => {
    const rows = [
      ['x', 'y', 'z'],
      ['longer', '', ''],
      ['', null, 3],
    ];
    expect(table(rows, ['r', 'l'])).toBe('     x  y  z\nlonger\n           3');
  });
});

describe('indent', () => {
  it('indents every non-empty line', () => {
    expect(indent('a\nb')).toBe('  a\n  b');
    expect(indent('a\n\nb', 4)).toBe('    a\n\n    b');
    expect(indent('')).toBe('');
    expect(indent('x\n')).toBe('  x\n');
  });
});

describe('printable', () => {
  it('shows control characters as stand-ins of the same length, keeping newlines and tabs', () => {
    expect(printable('\u001b]0;title\u0007 \u001b[2J')).toBe('\u241b]0;title\u2407 \u241b[2J');
    expect(printable('a\r\u0000b\u007f\u009bc\u0085')).toBe('a\u240d\u2400b\u2421\ufffdc\ufffd');
    expect(printable('line one\n\tline two · “ok” ✗ é')).toBe('line one\n\tline two · “ok” ✗ é');
  });
});
