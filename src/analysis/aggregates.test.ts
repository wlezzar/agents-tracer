import { describe, expect, it } from 'vitest';

import { toolCall } from '../../test/support/memory-adapter.js';
import {
  activeOf,
  bucketOf,
  callSummary,
  isIdle,
  shellBreakdown,
  sumTools,
  topTools,
  usageKnown,
  usageTotals,
  wallOf,
  youOf,
} from './aggregates.js';
import type { Bucket, ModelCall, ToolRun } from './types.js';

// Expected strings are the prototype's (session-trace/trace.mjs topTools, bashTable, and
// callSummary) for the same inputs.

const buckets = new Map<Bucket, number>([
  ['idle: waiting on you', 60000],
  ['model', 30000],
  ['tool:Read', 4000],
  ['you: answering questions', 12000],
  ['tool:Shell', 9000],
  ['compaction', 5000],
  ['idle: waiting on you, background tasks running', 7000],
  ['idle: waiting on a background task', 3000],
  ['tool:Grep', 4000],
]);

const run = (id: string, extra: Partial<ToolRun> = {}): ToolRun => ({
  ...toolCall(id, 'Read', 'file', { preview: `src/${id}.ts` }),
  start: 0,
  isError: false,
  interrupted: false,
  async: false,
  output: '',
  launches: {},
  backgroundIds: [],
  ...extra,
});
const shellRun = (id: string, command: string, ms: number | undefined, extra: Partial<ToolRun> = {}): ToolRun =>
  run(id, {
    ...toolCall(id, 'Shell', 'shell', { shellCommand: command }),
    ...(ms !== undefined && { end: ms, ms }),
    ...extra,
  });
const call = (extra: Partial<ModelCall> = {}): ModelCall => ({
  messageId: 'm',
  ts: 0,
  start: 0,
  end: 0,
  ms: 0,
  synthetic: false,
  stop: 'end_turn',
  blocks: [],
  text: '',
  tools: [],
  ...extra,
});

describe('buckets', () => {
  it('tells idle buckets apart', () => {
    expect([...buckets.keys()].filter(isIdle)).toEqual([
      'idle: waiting on you',
      'idle: waiting on you, background tasks running',
      'idle: waiting on a background task',
    ]);
  });

  it("charges a question's wait to the person and any other call to its tool", () => {
    expect(bucketOf(toolCall('q', 'Ask', 'question'))).toBe('you: answering questions');
    expect(bucketOf(toolCall('s', 'Shell', 'shell'))).toBe('tool:Shell');
    expect(bucketOf(undefined)).toBe('tool:?');
  });

  it('sums active time, tool time, and the time that was the person’s', () => {
    expect(activeOf(buckets)).toBe(64000);
    expect(sumTools(buckets)).toBe(17000);
    expect(youOf(buckets)).toBe(79000);
  });

  it('lists the largest tool buckets and the person’s answers, ties in first-charged order', () => {
    expect(topTools(buckets)).toBe('you: answering questions 12s, Shell 9.0s, Read 4.0s');
    expect(topTools(buckets, 5)).toBe('you: answering questions 12s, Shell 9.0s, Read 4.0s, Grep 4.0s');
    expect(topTools(new Map())).toBe('');
  });
});

describe('wallOf', () => {
  it('is the time from the first event to the last, NaN without events', () => {
    expect(wallOf({ start: 1000, end: 61000 })).toBe(60000);
    expect(wallOf({ start: undefined, end: undefined })).toBeNaN();
  });
});

describe('usage', () => {
  const stopped = (n: number, of: number) =>
    Array.from({ length: of }, (_, i) => call({ stop: i < n ? 'end_turn' : null }));

  it('is known when at least 90% of the calls have a stop reason', () => {
    expect(usageKnown(stopped(9, 10))).toBe(true);
    expect(usageKnown(stopped(8, 10))).toBe(false);
    expect(usageKnown(stopped(1, 1))).toBe(true);
    expect(usageKnown([])).toBe(false);
  });

  it('sums the calls’ token counts, a call without usage counting 0', () => {
    expect(
      usageTotals([
        call({ usage: { output: 10, cacheRead: 100, cacheWrite: 20, input: 3 } }),
        call(),
        call({ usage: { output: 5, cacheRead: 50, cacheWrite: 0, input: 1 } }),
      ]),
    ).toEqual({ output: 15, cacheRead: 150, cacheWrite: 20, input: 4 });
  });
});

describe('shellBreakdown', () => {
  it('groups the shell calls with a result by command key, the longest sum first', () => {
    const rows = shellBreakdown([
      shellRun('a', 'cd /home/dev/shop && pnpm test', 30000, { isError: true }),
      shellRun('b', 'pnpm test -- Header', 45000),
      shellRun('c', 'pnpm dev', 1000, {
        desc: { category: 'shell', preview: '', inputText: '', shellCommand: 'pnpm dev', runsInBackground: true },
      }),
      shellRun('d', 'git -C /home/dev/shop status', 2000),
      shellRun('e', 'pnpm lint', undefined),
      run('f', { end: 9000, ms: 9000 }),
    ]);
    expect(rows).toEqual([
      { key: 'pnpm test', ms: 75000, calls: 2, max: 45000, failed: 1 },
      { key: 'git status', ms: 2000, calls: 1, max: 2000, failed: 0 },
      { key: 'pnpm dev [bg]', ms: 1000, calls: 1, max: 1000, failed: 0 },
    ]);
  });
});

describe('callSummary', () => {
  it('says what a call did: thinking, its tools by name, and its text', () => {
    expect(
      callSummary(
        call({
          blocks: ['thinking', 'text', 'tool_use', 'tool_use', 'tool_use'],
          tools: [
            run('a'),
            run('b'),
            run('c', { ...toolCall('c', 'Shell', 'shell', { preview: 'Run the tests · pnpm test' }) }),
          ],
          text: 'Reading   both\nfiles.',
        }),
      ),
    ).toBe('thinking · Read ×2 · Shell Run the tests · pnpm test · “Reading both files.”');
    expect(callSummary(call({ blocks: ['redacted_thinking'] }))).toBe('thinking');
    expect(
      callSummary(call({ tools: [run('x', { desc: { category: 'file', preview: 'p'.repeat(60), inputText: '' } })] })),
    ).toBe(`Read ${'p'.repeat(49)}…`);
  });

  it('marks a synthetic call first', () => {
    expect(callSummary(call({ synthetic: true, text: 'API Error: 529 Overloaded' }))).toBe(
      '[synthetic] · “API Error: 529 Overloaded”',
    );
    expect(callSummary(call())).toBe('');
  });
});
