import { describe, expect, it } from 'vitest';

import { createMemoryAdapter, session, toolCall, transcript } from './memory-adapter.js';

const t0 = Date.UTC(2026, 0, 5, 9, 0);

const first = session(
  transcript(
    'aaa111',
    [
      { kind: 'prompt', ts: t0, text: 'Add a cart badge' },
      {
        kind: 'response',
        ts: t0 + 2000,
        messageId: 'm1',
        model: 'model-a',
        synthetic: false,
        stop: 'tool_use',
        blocks: ['tool_use'],
        text: '',
        toolCalls: [toolCall('c1', 'Shell', 'shell', { shellCommand: 'pnpm test' })],
      },
    ],
    { title: 'Cart badge', cwd: '/home/dev/shop' },
  ),
  { shellToolName: 'Shell' },
);
const second = session(transcript('aab222', [{ kind: 'prompt', ts: t0 - 60_000, text: 'Earlier' }]));
const empty = session(transcript('ccc333', []));
const adapter = createMemoryAdapter([first, second, empty]);

describe('the memory adapter', () => {
  it('lists sessions with events, oldest first', () => {
    expect(adapter.listSessions('memory:').map((s) => [s.id, s.start, s.end, s.title, s.firstPrompt])).toEqual([
      ['aab222', t0 - 60_000, t0 - 60_000, undefined, 'Earlier'],
      ['aaa111', t0, t0 + 2000, 'Cart badge', 'Add a cart badge'],
    ]);
  });

  it('holds the sessions with events in one store at its root, newest first', () => {
    expect(adapter.defaultRoot('/home/dev')).toBe('memory:');
    expect(adapter.listStores(adapter.defaultRoot('/home/dev'))).toEqual([
      {
        id: 'memory',
        path: 'memory:',
        sessions: [
          { id: 'aaa111', size: 0, modified: t0 + 2000 },
          { id: 'aab222', size: 0, modified: t0 - 60_000 },
        ],
      },
    ]);
  });

  it('resolves unique prefixes and loads the session', () => {
    expect(adapter.load(adapter.resolve('memory:', 'aaa'))).toBe(first);
    expect(() => adapter.resolve('memory:', 'aa')).toThrow('"aa" matches 2 sessions; give more of the id');
    expect(() => adapter.resolve('memory:', 'zzz')).toThrow('no session matches "zzz" in memory');
  });

  it('builds tool calls with the category given', () => {
    expect(toolCall('c1', 'Shell', 'shell', { shellCommand: 'ls' })).toEqual({
      id: 'c1',
      name: 'Shell',
      input: {},
      desc: { category: 'shell', preview: '', inputText: '', shellCommand: 'ls' },
    });
  });
});
