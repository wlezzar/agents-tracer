import { describe, expect, it } from 'vitest';

import type { ResponseEvent, ToolCall, ToolResultEvent, TraceEvent } from '../model/index.js';
import { toolCall, transcript } from '../../test/support/memory-adapter.js';
import { analyzeTranscript } from './analyze.js';
import type { TimelineItem, TranscriptAnalysis } from './types.js';

// The timing state machine over neutral events. Times are seconds after t0.

const t0 = Date.UTC(2026, 2, 14, 9, 0);
const at = (s: number): number => t0 + s * 1000;

const prompt = (s: number, text = 'go'): TraceEvent => ({ kind: 'prompt', ts: at(s), text });
const response = (s: number, messageId: string, extra: Partial<Omit<ResponseEvent, 'kind' | 'ts'>> = {}) =>
  ({
    kind: 'response',
    ts: at(s),
    messageId,
    model: 'model-a',
    synthetic: false,
    stop: 'end_turn',
    blocks: ['text'],
    text: '',
    toolCalls: [],
    ...extra,
  }) satisfies ResponseEvent;
const asks = (s: number, messageId: string, ...toolCalls: ToolCall[]) =>
  response(s, messageId, { stop: 'tool_use', blocks: toolCalls.map(() => 'tool_use'), toolCalls });
const result = (s: number, toolCallId: string, extra: Partial<Omit<ToolResultEvent, 'kind' | 'ts'>> = {}) =>
  ({
    kind: 'tool_result',
    ts: at(s),
    toolCallId,
    isError: false,
    interrupted: false,
    output: '',
    async: false,
    backgroundIds: [],
    launches: {},
    ...extra,
  }) satisfies ToolResultEvent;
const done = (s: number, toolCallId: string): TraceEvent => ({ kind: 'background_done', ts: at(s), toolCallId });

const read = (id: string) => toolCall(id, 'Read', 'file');
const shell = (id: string, extra: { runsInBackground?: true } = {}) =>
  toolCall(id, 'Shell', 'shell', { shellCommand: 'pnpm test', ...extra });
const ask = (id: string) => toolCall(id, 'Ask', 'question');

const analyze = (events: readonly TraceEvent[], minIdle?: number): TranscriptAnalysis =>
  analyzeTranscript(transcript('t', events), minIdle === undefined ? {} : { minIdle });
const buckets = (a: TranscriptAnalysis) => Object.fromEntries(a.buckets);
const seconds = (a: TranscriptAnalysis) => a.segments.map(([s, e, b]) => [(s - t0) / 1000, (e - t0) / 1000, b]);
const items = (a: TranscriptAnalysis) =>
  a.timeline.map((i: TimelineItem) => {
    switch (i.kind) {
      case 'turn':
        return `turn ${i.turn.n}`;
      case 'call':
        return `call ${i.call.messageId}`;
      case 'tool':
        return `tool ${i.tool.id}`;
      case 'idle':
        return `idle ${i.gap / 1000}s ${i.bucket}`;
      case 'interrupt':
        return 'interrupt';
    }
  });

describe('analyzeTranscript: a turn', () => {
  const a = analyze([
    prompt(0, 'Add a badge'),
    asks(2, 'm1', read('r1')),
    result(3, 'r1', { output: 'file' }),
    response(5, 'm2', { text: 'Done.' }),
    prompt(65, 'Thanks'),
  ]);

  it('charges each gap to what was pending', () => {
    expect(buckets(a)).toEqual({ model: 4000, 'tool:Read': 1000, 'idle: waiting on you': 60000 });
    expect(seconds(a)).toEqual([
      [0, 2, 'model'],
      [2, 3, 'tool:Read'],
      [3, 5, 'model'],
      [5, 65, 'idle: waiting on you'],
    ]);
    expect([a.start, a.end]).toEqual([at(0), at(65)]);
    expect(a.models).toEqual(['model-a']);
  });

  it('times model calls from the event before them, and tool calls from the record that asked', () => {
    expect(a.calls.map((c) => [c.messageId, c.ts, c.start, c.end, c.ms, c.stop, c.text, c.turn?.n])).toEqual([
      ['m1', at(2), at(0), at(2), 2000, 'tool_use', '', 1],
      ['m2', at(5), at(3), at(5), 2000, 'end_turn', 'Done.', 1],
    ]);
    expect(a.tools.map((t) => [t.id, t.start, t.end, t.ms, t.output, t.isError, t.async, t.turn?.n])).toEqual([
      ['r1', at(2), at(3), 1000, 'file', false, false, 1],
    ]);
  });

  it('counts turns and their active time', () => {
    expect(
      a.turns.map((t) => [t.n, t.ts, t.kind, t.text, Object.fromEntries(t.buckets), t.calls, t.tools, t.end]),
    ).toEqual([
      [1, at(0), 'you', 'Add a badge', { model: 4000, 'tool:Read': 1000 }, 2, 1, at(5)],
      [2, at(65), 'you', 'Thanks', {}, 0, 0, at(65)],
    ]);
  });

  it('lists the timeline in walk order, the idle gap before the turn it ends', () => {
    expect(items(a)).toEqual(['turn 1', 'call m1', 'tool r1', 'call m2', 'idle 60s idle: waiting on you', 'turn 2']);
  });
});

describe('analyzeTranscript: model calls', () => {
  it('makes one call of the records that share a message id, at its last record', () => {
    const a = analyze([
      prompt(0),
      response(1, 'm1', {
        stop: 'tool_use',
        blocks: ['thinking'],
        usage: { output: 5, cacheRead: 1, cacheWrite: 0, input: 2 },
      }),
      response(2, 'm1', {
        stop: 'tool_use',
        text: 'Looking.',
        usage: { output: 9, cacheRead: 1, cacheWrite: 0, input: 2 },
      }),
      asks(3, 'm1', read('a')),
      asks(3.5, 'm1', read('b')),
      result(4, 'b'),
      result(6, 'a'),
      response(7, 'm2', { text: 'Both read.' }),
    ]);
    const [call] = a.calls;
    expect(a.calls).toHaveLength(2);
    expect(call).toMatchObject({
      messageId: 'm1',
      ts: at(1),
      start: at(0),
      end: at(3.5),
      ms: 3500,
      blocks: ['thinking', 'text', 'tool_use', 'tool_use'],
      text: 'Looking.',
      usage: { output: 9, cacheRead: 1, cacheWrite: 0, input: 2 },
    });
    expect(call?.tools.map((t) => t.id)).toEqual(['a', 'b']);
    expect(items(a)).toEqual(['turn 1', 'call m1', 'tool b', 'tool a', 'call m2']);
    expect(a.turns[0]?.out).toBe(9);
  });

  it('charges parallel tool calls to the call each result answers, so tool time never exceeds the wall', () => {
    const a = analyze([
      prompt(0),
      asks(1, 'm1', read('a'), read('b')),
      result(2, 'b'),
      result(5, 'a'),
      response(6, 'm2'),
    ]);
    expect(buckets(a)).toEqual({ model: 2000, 'tool:Read': 4000 });
    expect(a.tools.map((t) => t.ms)).toEqual([4000, 1000]);
  });

  it('starts a call at its first record when the gap before it was not model time', () => {
    const a = analyze([
      response(1, 'm1'),
      { kind: 'command', ts: at(2), name: '/compact', compaction: true },
      response(5, 'm2'),
    ]);
    expect(a.calls.map((c) => [c.start, c.ms, c.turn?.n])).toEqual([
      [at(1), 0, undefined],
      [at(5), 0, 1],
    ]);
    expect(buckets(a)).toEqual({ 'idle: waiting on you': 1000, compaction: 3000 });
  });

  it('goes idle after a call that stops without asking for tools, even without a stop reason', () => {
    const a = analyze([prompt(0), response(2, 'm1', { stop: null }), prompt(10)]);
    expect(buckets(a)).toEqual({ model: 2000, 'idle: waiting on you': 8000 });
  });

  it('keeps generating after a call that stops for tools it did not ask for', () => {
    const a = analyze([prompt(0), response(2, 'm1', { stop: 'tool_use' }), prompt(10)]);
    expect(buckets(a)).toEqual({ model: 10000 });
  });

  it('lists the models of the non-synthetic calls in order of first use', () => {
    const a = analyze([
      prompt(0),
      response(1, 'm1', { model: 'model-b' }),
      prompt(2),
      response(3, 'm2', { model: '<synthetic>', synthetic: true }),
      prompt(4),
      response(5, 'm3', { model: 'model-a' }),
      prompt(6),
      response(7, 'm4', { model: 'model-b' }),
    ]);
    expect(a.models).toEqual(['model-b', 'model-a']);
  });
});

describe('analyzeTranscript: tools', () => {
  it("charges a question's wait to the person, as active time", () => {
    const a = analyze([prompt(0), asks(1, 'm1', ask('q')), result(61, 'q'), response(62, 'm2')]);
    expect(buckets(a)).toEqual({ model: 2000, 'you: answering questions': 60000 });
  });

  it('charges a result for no outstanding call to tool:?', () => {
    const a = analyze([prompt(0), asks(1, 'm1', read('r')), { kind: 'interrupt', ts: at(2) }, result(3, 'r')]);
    expect(seconds(a)).toEqual([
      [0, 1, 'model'],
      [1, 2, 'tool:Read'],
      [2, 3, 'tool:?'],
    ]);
    expect(a.tools[0]?.ms).toBe(2000);
    expect(items(a)).toEqual(['turn 1', 'call m1', 'interrupt', 'tool r']);
  });

  it('marks failed results, and a result after an interrupted one as failed too', () => {
    const a = analyze([
      prompt(0),
      asks(1, 'm1', shell('s1'), shell('s2')),
      result(2, 's1', { isError: true }),
      result(3, 's2', { interrupted: true }),
      result(4, 's2'),
    ]);
    expect(a.tools.map((t) => [t.id, t.isError, t.interrupted, t.end])).toEqual([
      ['s1', true, false, at(2)],
      ['s2', true, false, at(4)],
    ]);
  });
});

describe('analyzeTranscript: background tasks', () => {
  const launch = [
    prompt(0),
    asks(1, 'm1', shell('bg', { runsInBackground: true })),
    result(2, 'bg', { async: true, backgroundIds: ['t1'] }),
    response(3, 'm2'),
  ];

  it('charges idle time while a task runs to the person, with tasks running', () => {
    const a = analyze([...launch, prompt(20)]);
    expect(buckets(a)['idle: waiting on you, background tasks running']).toBe(17000);
    expect(a.tools[0]).toMatchObject({ async: true, backgroundIds: ['t1'] });
  });

  it('splits an idle gap at the task finishing, as a wait on the task when it reports back next', () => {
    const a = analyze([
      ...launch,
      done(10, 'bg'),
      done(10.5, 'other'),
      { kind: 'notification', ts: at(11), text: 'Built', toolCallId: 'bg' },
    ]);
    expect(seconds(a).slice(-1)).toEqual([[3, 11, 'idle: waiting on a background task']]);
    expect(a.tools[0]?.bgEnd).toBe(at(10));
    expect(a.turns.map((t) => [t.kind, t.text])).toEqual([
      ['you', 'go'],
      ['task', 'Built'],
    ]);
    // The part before the signal makes no timeline item; only the rest of the gap could.
    expect(items(a).filter((i) => i.startsWith('idle'))).toEqual([]);
  });

  it('splits an idle gap at the task finishing, as a wait on the person when they speak next', () => {
    const a = analyze([...launch, done(10, 'bg'), prompt(20)]);
    expect(seconds(a).slice(-2)).toEqual([
      [3, 10, 'idle: waiting on you, background tasks running'],
      [10, 20, 'idle: waiting on you'],
    ]);
    expect(items(a).filter((i) => i.startsWith('idle'))).toEqual(['idle 10s idle: waiting on you']);
    expect(a.end).toBe(at(20));
  });

  it('ends a task mid-turn without charging anything', () => {
    const a = analyze([
      prompt(0),
      asks(1, 'm1', shell('bg', { runsInBackground: true })),
      result(2, 'bg', { async: true, backgroundIds: ['t1'] }),
      asks(3, 'm2', read('r')),
      done(4, 'bg'),
      result(6, 'r'),
      response(7, 'm3'),
      prompt(20),
    ]);
    expect(buckets(a)).toEqual({ model: 3000, 'tool:Shell': 1000, 'tool:Read': 3000, 'idle: waiting on you': 13000 });
    expect(a.tools[0]?.bgEnd).toBe(at(4));
  });

  it('keeps the first end of a task that is signaled twice', () => {
    const a = analyze([
      ...launch,
      done(10, 'bg'),
      done(12, 'bg'),
      { kind: 'notification', ts: at(15), text: 'x', toolCallId: 'bg' },
    ]);
    expect(a.tools[0]?.bgEnd).toBe(at(10));
  });

  it('stops the tasks whose ids a task-control call names', () => {
    const stop = (id: string, ids: string[]) => toolCall(id, 'Kill', 'task-control', { stops: ids });
    const stopped = analyze([
      ...launch,
      prompt(5),
      asks(6, 'm3', stop('k', ['t1'])),
      result(7, 'k'),
      response(8, 'm4'),
      prompt(20),
    ]);
    expect(seconds(stopped).slice(-1)).toEqual([[8, 20, 'idle: waiting on you']]);
    const other = analyze([
      ...launch,
      prompt(5),
      asks(6, 'm3', stop('k', ['t2'])),
      result(7, 'k'),
      response(8, 'm4'),
      prompt(20),
    ]);
    expect(seconds(other).slice(-1)).toEqual([[8, 20, 'idle: waiting on you, background tasks running']]);
  });
});

describe('analyzeTranscript: commands, compaction, and interrupts', () => {
  it('charges a compaction from its command to its summary, sorting records written out of order', () => {
    const a = analyze([
      prompt(0),
      response(5, 'm1'),
      { kind: 'compaction_done', ts: at(100) },
      { kind: 'command', ts: at(10), name: '/compact', compaction: true },
      prompt(130),
    ]);
    expect(seconds(a)).toEqual([
      [0, 5, 'model'],
      [5, 10, 'idle: waiting on you'],
      [10, 100, 'compaction'],
      [100, 130, 'idle: waiting on you'],
    ]);
    expect(a.turns.map((t) => [t.kind, t.text, Object.fromEntries(t.buckets), t.end])).toEqual([
      ['you', 'go', { model: 5000 }, at(5)],
      ['command', '/compact', { compaction: 90000 }, at(100)],
      ['you', 'go', {}, at(130)],
    ]);
  });

  it('goes idle after another command', () => {
    const a = analyze([{ kind: 'command', ts: at(0), name: '/clear', compaction: false }, prompt(30)]);
    expect(buckets(a)).toEqual({ 'idle: waiting on you': 30000 });
  });

  it('drops the outstanding calls at an interrupt and waits on the person', () => {
    const a = analyze([prompt(0), asks(1, 'm1', read('r')), { kind: 'interrupt', ts: at(4) }, prompt(10)]);
    expect(seconds(a)).toEqual([
      [0, 1, 'model'],
      [1, 4, 'tool:Read'],
      [4, 10, 'idle: waiting on you'],
    ]);
    expect(a.tools[0]?.end).toBeUndefined();
    expect(a.tools[0]?.ms).toBeUndefined();
    expect(a.turns[0]?.end).toBe(at(4));
  });
});

describe('analyzeTranscript: idle timeline items', () => {
  const events = [prompt(0), response(1, 'm1'), prompt(1.5), response(2, 'm2'), prompt(3)];

  it('lists idle gaps of at least the minimum, 1 second by default', () => {
    expect(items(analyze(events)).filter((i) => i.startsWith('idle'))).toEqual(['idle 1s idle: waiting on you']);
    expect(items(analyze(events, 0)).filter((i) => i.startsWith('idle'))).toEqual([
      'idle 0.5s idle: waiting on you',
      'idle 1s idle: waiting on you',
    ]);
    expect(items(analyze(events, 5)).filter((i) => i.startsWith('idle'))).toEqual([]);
  });
});

describe('analyzeTranscript: edge cases', () => {
  it('is empty for a transcript without events', () => {
    const a = analyze([]);
    expect([a.start, a.end, a.segments, a.calls, a.tools, a.turns, a.timeline, a.models]).toEqual([
      undefined,
      undefined,
      [],
      [],
      [],
      [],
      [],
      [],
    ]);
  });

  it('charges nothing before the first event, or for a background signal that opens the transcript', () => {
    const a = analyze([done(0, 'x'), prompt(5), response(6, 'm1')]);
    expect(seconds(a)).toEqual([[5, 6, 'model']]);
    expect(a.start).toBe(at(0));
  });
});
